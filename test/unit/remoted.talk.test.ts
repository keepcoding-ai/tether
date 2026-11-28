// RR4 step 4.2a: the person talks from afar (channels.say, react, vote, poll, seen). Proved here:
// - talkArgs (src/remote/talk.ts) checks every field before the pipe, with the channel rules' ceilings, and rebuilds the
//   arguments: controls, bidi and zero-width characters go as the projector drops them on the way back;
// - pipeWrites (src/remoted/writes.ts) sends only a pair of EXT_WRITES, under its own ceilings (never the reads' slots), and
//   answers the device by the deadline while the write's real outcome still comes;
// - a real House (remoted.house-bench.ts, a device with a presence credential) serves the five lines: the answers by the
//   allow list, tetherd's refusals as stable codes, the gate (scope, lock, credential, actId) before the pipe, the strict
//   body before the pipe, the speech's own ceiling, the `busy` ceiling, and the idempotence: a repeat of an actId (done, in
//   flight, after a timeout, from another session of the device) never speaks twice; the actId of one op never answers
//   another. Every act leaves an audit line with the channel and never the text; a canary in what tetherd answers beyond
//   the allowed fields reaches no reply.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, test } from 'node:test'
import { DaemonError } from '../../src/daemon/client.ts'
import { OP_CODES, RES_STATUS, toHex, type Bytes } from '../../src/remote/index.ts'
import { ERROR_CODES } from '../../src/remote/projection.ts'
import {
  NAME_MAX, POLL_OPTION_MAX, POLL_QUESTION_MAX, POLL_REASON_MAX, POLL_TIMEOUT_MAX_MS, POLL_TIMEOUT_MIN_MS, POLL_TO_MAX, REACTION_TEXT_MAX,
  SAY_TEXT_MAX, SAY_TO_MAX, talkArgs, TALK_REFUSALS,
} from '../../src/remote/talk.ts'
import { EXT_WRITES, type ExtWriteOp } from '../../src/remoted/gate.ts'
import { pipeWrites, WriteError, type PipeWrites } from '../../src/remoted/writes.ts'
import type { ExtRequestFn } from '../../src/remoted/reads.ts'
import { actId, ORIGIN, present, registerAndUnlock, type SoftAuthenticator } from './remoted.authenticator.ts'
import { startHouseBench, type HouseBench } from './remoted.house-bench.ts'
import { until, type DeviceSession } from './remoted.helpers.ts'

const MARKER = `canary${randomBytes(12).toString('hex')}`
const has = (v: unknown): boolean => JSON.stringify(v).includes(MARKER)
const ISO = '2026-11-27T10:00:00.000Z'
const OP = { say: OP_CODES['channels.say'], react: OP_CODES['channels.react'], vote: OP_CODES['channels.vote'], poll: OP_CODES['channels.poll'], seen: OP_CODES['channels.seen'], lock: 0x0007 }

// ---- talkArgs -----------------------------------------------------------------------------------------------------

describe('talkArgs: the strict bodies, checked before the pipe', () => {
  const say = (b: Record<string, unknown>) => talkArgs('channels.say', { channel: 'c_1', ...b })

  test('a speech keeps its line breaks and loses the controls, the bidi marks and the zero-width characters; `to` is folded and once each', () => {
    assert.deepEqual(say({ text: 'oi\u202Eapagar\u202C\u0007 \u200Bdois\nlinha', to: ['conferente', 'confe\u200Brente', ' conferente '] }), {
      channel: 'c_1', args: { channel: 'c_1', text: 'oiapagar dois\nlinha', to: ['conferente'] },
    })
    assert.deepEqual(say({ text: 'um 👩‍💻 dois' }), { channel: 'c_1', args: { channel: 'c_1', text: 'um 👩‍💻 dois' } }, "an emoji's joiner stays")
    assert.deepEqual(say({ text: 'x', to: [] }), { channel: 'c_1', args: { channel: 'c_1', text: 'x' } }, 'an empty to is none')
    assert.equal(say({ text: 'x'.repeat(SAY_TEXT_MAX) }) !== 'too-long', true)
    assert.equal(say({ text: 'x'.repeat(SAY_TEXT_MAX + 1) }), 'too-long')
    for (const text of ['', '   ', '\u200B\u202E', 7, null, ['x']]) assert.equal(say({ text }), 'bad-request', JSON.stringify(text))
    assert.equal(say({ text: 'x', to: Array.from({ length: SAY_TO_MAX + 1 }, (_, i) => `n${i}`) }), 'bad-request')
    assert.equal(say({ text: 'x', to: ['n'.repeat(NAME_MAX + 1)] }), 'too-long')
    assert.equal(say({ text: 'x', to: ['\u200B'] }), 'bad-request')
    assert.equal(say({ text: 'x', to: 'conferente' }), 'bad-request')
  })

  test('the channel is an id of the store, nothing else', () => {
    for (const channel of ['c_1', 'desk_a.b:c-d']) assert.notEqual(typeof talkArgs('channels.seen', { channel, seq: 1 }), 'string', channel)
    for (const channel of ['', '../x', 'a b', 'c'.repeat(65), 7, undefined, 'c\u202E1']) assert.equal(talkArgs('channels.seen', { channel, seq: 1 }), 'bad-request', String(channel))
  })

  test('react: a seq, one reaction as written (cleaned), remove only as a boolean', () => {
    assert.deepEqual(talkArgs('channels.react', { channel: 'c_1', seq: 3, reaction: ' agree ' }), { channel: 'c_1', args: { channel: 'c_1', seq: 3, reaction: 'agree' } })
    assert.deepEqual(talkArgs('channels.react', { channel: 'c_1', seq: 3, reaction: '👍', remove: true }), { channel: 'c_1', args: { channel: 'c_1', seq: 3, reaction: '👍', remove: true } })
    assert.deepEqual(talkArgs('channels.react', { channel: 'c_1', seq: 3, reaction: '👍', remove: false }), { channel: 'c_1', args: { channel: 'c_1', seq: 3, reaction: '👍' } })
    for (const seq of [0, -1, 1.5, '3', Number.MAX_SAFE_INTEGER + 1]) assert.equal(talkArgs('channels.react', { channel: 'c_1', seq, reaction: '👍' }), 'bad-request', String(seq))
    assert.equal(talkArgs('channels.react', { channel: 'c_1', seq: 3, reaction: 'x'.repeat(REACTION_TEXT_MAX + 1) }), 'too-long')
    assert.equal(talkArgs('channels.react', { channel: 'c_1', seq: 3, reaction: '👍', remove: 'yes' }), 'bad-request')
  })

  test("vote: the option's number (1 to 6), a reason of one line within its ceiling", () => {
    assert.deepEqual(talkArgs('channels.vote', { channel: 'c_1', poll: 2, vote: 1, reason: ' sem\ntempo ' }), { channel: 'c_1', args: { channel: 'c_1', poll: 2, vote: 1, reason: 'sem tempo' } })
    assert.deepEqual(talkArgs('channels.vote', { channel: 'c_1', poll: 2, vote: 6, reason: '' }), { channel: 'c_1', args: { channel: 'c_1', poll: 2, vote: 6 } })
    for (const vote of [0, 7, '1', 1.5, 'sim']) assert.equal(talkArgs('channels.vote', { channel: 'c_1', poll: 2, vote }), 'bad-request', String(vote))
    assert.equal(talkArgs('channels.vote', { channel: 'c_1', poll: 2, vote: 1, reason: 'r'.repeat(POLL_REASON_MAX + 1) }), 'too-long')
    assert.equal(talkArgs('channels.vote', { channel: 'c_1', poll: 0, vote: 1 }), 'bad-request')
  })

  test('poll: a question, none or 2 to 6 options, who is called by id, a deadline from 1 min to 24 h', () => {
    assert.deepEqual(talkArgs('channels.poll', { channel: 'c_1', question: 'Vamos?\u202E', options: ['sim', 'não'], to: ['user', 'a1b2', 'a1b2'], timeoutMs: 600_000 }), {
      channel: 'c_1', args: { channel: 'c_1', question: 'Vamos?', options: ['sim', 'não'], to: ['user', 'a1b2'], timeoutMs: 600_000 },
    })
    assert.deepEqual(talkArgs('channels.poll', { channel: 'c_1', question: 'ok?' }), { channel: 'c_1', args: { channel: 'c_1', question: 'ok?' } })
    const bad = (b: Record<string, unknown>) => talkArgs('channels.poll', { channel: 'c_1', question: 'q', ...b })
    assert.equal(bad({ options: ['só uma'] }), 'bad-request')
    assert.equal(bad({ options: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }), 'bad-request')
    assert.equal(bad({ options: ['a', 'o'.repeat(POLL_OPTION_MAX + 1)] }), 'too-long')
    assert.equal(bad({ options: ['a', ''] }), 'bad-request')
    assert.equal(bad({ question: 'q'.repeat(POLL_QUESTION_MAX + 1) }), 'too-long')
    assert.equal(bad({ to: ['../x'] }), 'bad-request')
    assert.equal(bad({ to: Array.from({ length: POLL_TO_MAX + 1 }, (_, i) => `a${i}`) }), 'bad-request')
    for (const timeoutMs of [POLL_TIMEOUT_MIN_MS - 1, POLL_TIMEOUT_MAX_MS + 1, 1.5, '600000']) assert.equal(bad({ timeoutMs }), 'bad-request', String(timeoutMs))
  })

  test('every code a refusal of tetherd maps to is a code a body may carry', () => {
    for (const [code, status] of Object.entries(TALK_REFUSALS)) assert.notEqual(status as number, RES_STATUS.ok as number, code)
    assert.deepEqual(Object.keys(TALK_REFUSALS).filter((c) => !(ERROR_CODES as readonly string[]).includes(c)), [])
  })
})

// ---- pipeWrites -----------------------------------------------------------------------------------------------------

describe('pipeWrites: the write path of the portal, apart from the reads', () => {
  test('a write sends exactly the pair of its line with the arguments given, and gives back the result', async () => {
    const sent: unknown[] = []
    const writes = pipeWrites(async (b) => { sent.push(b); return { result: { ok: b.name } } })
    for (const [op, pair] of Object.entries(EXT_WRITES)) {
      assert.deepEqual(await writes.write(op as ExtWriteOp, { channel: 'c_1' }).answer, { ok: pair.name })
      assert.deepEqual(sent.at(-1), { t: 'ext-request', ext: pair.ext, name: pair.name, args: { channel: 'c_1' } })
    }
  })

  test('a name outside the list is refused before the pipe', async () => {
    let calls = 0
    const writes = pipeWrites(async () => { calls++; return {} })
    for (const op of ['channels.marks', 'channels.create', 'say', '__proto__', 'constructor']) {
      const f = writes.write(op as ExtWriteOp, {})
      await assert.rejects(f.answer, (e: unknown) => e instanceof WriteError && e.why === 'refused')
      assert.deepEqual(await f.settled, { ok: false, error: new WriteError('refused', 'no-pair') })
    }
    assert.equal(calls, 0)
  })

  test('the deadline answers the device and frees the slot; the late write is counted until tetherd answers, and its outcome still comes', async () => {
    const hold: ((v: unknown) => void)[] = []
    const logs: string[] = []
    const request: ExtRequestFn = () => new Promise((res) => { hold.push((v) => res({ result: v })) })
    const writes = pipeWrites(request, { max: 1, timeoutMs: 40, lateMax: 1, log: (m) => logs.push(m) })
    const a = writes.write('channels.say', { channel: 'c_1', text: MARKER })
    await assert.rejects(writes.write('channels.say', {}).answer, (e: unknown) => e instanceof WriteError && e.why === 'limit', 'one in flight')
    await assert.rejects(a.answer, (e: unknown) => e instanceof WriteError && e.why === 'timeout')
    assert.deepEqual([writes.inflight, writes.late], [0, 1], 'the slot is free, the write is late')
    await assert.rejects(writes.write('channels.react', {}).answer, (e: unknown) => e instanceof WriteError && e.why === 'limit', 'one late is the ceiling')
    hold.shift()!({ seq: 9 })
    assert.deepEqual(await a.settled, { ok: true, result: { seq: 9 } }, 'the real outcome, after the deadline')
    await until(() => writes.late === 0 || undefined, 1_000, 'no longer late')
    const b = writes.write('channels.react', {})
    hold.shift()!({ changed: true })
    assert.deepEqual(await b.answer, { changed: true })
    assert.deepEqual(logs, ['pipe: a write past its deadline, 1 late at tetherd', 'pipe: a write refused, 1 late at tetherd', 'pipe: a late write answered, 0 late at tetherd'])
    assert.equal(logs.some((l) => l.includes(MARKER) || l.includes('c_1')), false, 'the log carries no argument')
  })

  test("tetherd's refusal keeps its code; any other failure is `failed`", async () => {
    const refused = pipeWrites(async () => { throw new DaemonError('closed' as never, 'canal fechado') })
    const r = refused.write('channels.say', {})
    await assert.rejects(r.answer, (e: unknown) => e instanceof WriteError && e.why === 'refused' && e.code === 'closed')
    assert.equal((await r.settled).ok, false)
    const broken = pipeWrites(async () => { throw new Error('conexão com o tetherd fechada') })
    await assert.rejects(broken.write('channels.say', {}).answer, (e: unknown) => e instanceof WriteError && e.why === 'failed')
  })
})

// ---- through a real House -----------------------------------------------------------------------------------------

/** tetherd's answers, with the canary in every field a device must not get. */
const ANSWERS: Record<string, (args: Record<string, unknown>) => unknown> = {
  say: () => ({ line: { seq: 12, at: ISO, kind: 'message', from: { id: 'user', name: MARKER, role: 'moderator' }, body: MARKER, to: [MARKER] }, receipts: { a1: MARKER }, extra: MARKER }),
  react: () => ({ changed: true, emoji: '👍', name: 'agree', line: { body: MARKER }, extra: MARKER }),
  vote: (a) => a.poll === 7
    ? { changed: true, option: 1, poll: { seq: 7, type: 'ok', question: 'Fecha?', options: ['ok', 'não ok'], to: [{ id: 'user', name: 'usuário' }], closesAt: ISO, author: { id: 'a1', name: 'conferente' }, votes: { user: { option: 1, at: ISO, name: 'usuário', secret: MARKER } }, asked: MARKER },
      result: { poll: 7, by: 'all-voted', tally: [{ option: 1, text: 'ok', voters: [{ id: 'user', name: 'usuário' }] }], missing: [], text: MARKER }, closedAt: ISO, line: MARKER }
    : { changed: true, option: 2, poll: { seq: 5, type: 'choice', question: 'Qual?', options: ['a', 'b'], to: [{ id: 'user', name: 'usuário' }, { id: 'a1', name: 'conferente' }], closesAt: ISO, author: { id: 'a1', name: 'conferente' }, votes: { user: { option: 2, at: ISO, name: 'usuário', reason: 'porque' } }, changes: { user: MARKER } } },
  poll: () => ({ seq: 20, poll: { seq: 20, type: 'ok', question: 'Vamos?', options: ['ok', 'não ok'], to: [{ id: 'a1', name: 'conferente' }], closesAt: ISO, author: { id: 'user', name: 'usuário' }, votes: {}, asked: { a1: MARKER } }, closesAt: ISO, deaf: [{ id: 'a1', name: 'conferente', why: 'stopped', note: MARKER }, { id: 'a2', name: 'x', why: MARKER }] }),
  seen: () => ({ seenByUser: 30, extra: MARKER }),
}

interface Call { name: string; args: Record<string, unknown> }

/** A House whose write path is the real pipeWrites over a request that records and answers (or holds) each call. */
function writeBench() {
  const calls: Call[] = []
  const held: (() => void)[] = []
  let hold = false
  let answer: (name: string, args: Record<string, unknown>) => Promise<unknown> = async (name, args) => ANSWERS[name]!(args)
  const request: ExtRequestFn = (b) => {
    calls.push({ name: b.name, args: b.args })
    const go = () => answer(b.name, b.args).then((result) => ({ result }))
    if (!hold) return go()
    return new Promise((res, rej) => { held.push(() => { go().then(res, rej) }) })
  }
  return {
    calls, held,
    hold: (on: boolean) => { hold = on },
    answer: (f: typeof answer) => { answer = f },
    reset: () => { answer = async (name, args) => ANSWERS[name]!(args); hold = false; calls.length = 0 },
    request,
  }
}

describe('the five writes through a real House', () => {
  let bench: HouseBench
  let s: DeviceSession
  let auth: SoftAuthenticator
  let writes: PipeWrites
  const w = writeBench()
  const deviceId = (): string => toHex(bench.device.result!.deviceId)
  const scopes = (list: readonly string[]): void => {
    const d = bench.registry.get(deviceId())!
    d.scopes = [...list]
    bench.house.upsertDevice(structuredClone(d))
  }
  const allScopes: string[] = []
  const send = (op: number, body: Record<string, unknown>, id: Bytes = actId(), on: DeviceSession = s) => on.request(op, body, { actId: id })
  /** A new unlocked session of the paired device, once the house has room for it (3 per device). */
  const unlocked = async (): Promise<DeviceSession> => {
    await until(() => bench.house.status().sessions < 3 || undefined, 5_000, 'room for one more session')
    const n = await bench.connect()
    assert.equal((await present(n, auth)).status, RES_STATUS.ok)
    return n
  }

  before(async () => {
    writes = pipeWrites(w.request, { timeoutMs: 300 })
    bench = await startHouseBench({
      origin: ORIGIN, writes, writeTimeoutMs: 300,
      limits: { reqPerDevicePerMin: 10_000, gesturesPerDevicePerMin: 10_000, hsPerTicketPerMin: 1_000 },
    })
    allScopes.push(...bench.registry.get(deviceId())!.scopes)
    auth = await registerAndUnlock(bench.fresh, bench.device.kD.pub)
    s = bench.fresh
  })
  after(async () => { await bench?.stop() })

  test('each line answers by its allow list, sends tetherd only the arguments rebuilt, and audits the channel without the text', async () => {
    w.reset()
    const from = bench.audits().length
    const said = await send(OP.say, { channel: 'c_1', text: `bom dia ${MARKER}\u202E`, to: ['conferente'] })
    assert.deepEqual(said, { status: RES_STATUS.ok, body: { seq: 12 } })
    assert.deepEqual(w.calls.at(-1), { name: 'say', args: { channel: 'c_1', text: `bom dia ${MARKER}`, to: ['conferente'] } })
    assert.deepEqual(await send(OP.react, { channel: 'c_1', seq: 12, reaction: 'agree' }), { status: RES_STATUS.ok, body: { changed: true, emoji: '👍', name: 'agree' } })
    assert.deepEqual(w.calls.at(-1), { name: 'react', args: { channel: 'c_1', seq: 12, reaction: 'agree' } })
    assert.deepEqual(await send(OP.vote, { channel: 'c_1', poll: 5, vote: 2, reason: 'porque' }), {
      status: RES_STATUS.ok,
      body: {
        changed: true, option: 2,
        state: { seq: 5, open: { type: 'choice', question: 'Qual?', options: ['a', 'b'], to: [{ id: 'user', name: 'usuário' }, { id: 'a1', name: 'conferente' }], closesAt: ISO, author: { id: 'a1', name: 'conferente' }, votes: [{ id: 'user', name: 'usuário', option: 2, reason: 'porque' }] } },
      },
    })
    assert.deepEqual(await send(OP.vote, { channel: 'c_1', poll: 7, vote: 1 }), {
      status: RES_STATUS.ok,
      body: { changed: true, option: 1, state: { seq: 7, result: { poll: 7, by: 'all-voted', tally: [{ option: 1, text: 'ok', voters: [{ id: 'user', name: 'usuário' }] }], missing: [] }, closedAt: ISO } },
    }, 'the last vote closed the poll: the card turns into its result')
    assert.deepEqual(await send(OP.poll, { channel: 'c_1', question: 'Vamos?' }), {
      status: RES_STATUS.ok,
      body: {
        seq: 20,
        state: { seq: 20, open: { type: 'ok', question: 'Vamos?', options: ['ok', 'não ok'], to: [{ id: 'a1', name: 'conferente' }], closesAt: ISO, author: { id: 'user', name: 'usuário' }, votes: [] } },
        deaf: [{ id: 'a1', name: 'conferente', why: 'stopped' }],
      },
    })
    assert.deepEqual(await send(OP.seen, { channel: 'c_1', seq: 30 }), { status: RES_STATUS.ok, body: { seenByUser: 30 } })
    assert.deepEqual(w.calls.map((c) => c.name), ['say', 'react', 'vote', 'vote', 'poll', 'seen'])
    const lines = bench.audits().slice(from)
    assert.deepEqual(lines.map((l) => [l.act, l.result, l.target, l.deviceId]), [
      ['channels.say', 'ok', 'c_1', deviceId()], ['channels.react', 'ok', 'c_1', deviceId()], ['channels.vote', 'ok', 'c_1', deviceId()],
      ['channels.vote', 'ok', 'c_1', deviceId()], ['channels.poll', 'ok', 'c_1', deviceId()], ['channels.seen', 'ok', 'c_1', deviceId()],
    ])
    assert.equal(has(lines) || JSON.stringify(lines).includes('bom dia'), false, 'the audit never carries the text')
  })

  test('the canary of every field beyond the allowed ones reaches no reply', async () => {
    w.reset()
    const got = [
      await send(OP.say, { channel: 'c_1', text: 'oi' }), await send(OP.react, { channel: 'c_1', seq: 1, reaction: '👍' }),
      await send(OP.vote, { channel: 'c_1', poll: 7, vote: 1 }), await send(OP.vote, { channel: 'c_1', poll: 5, vote: 2 }),
      await send(OP.poll, { channel: 'c_1', question: 'q' }), await send(OP.seen, { channel: 'c_1', seq: 1 }),
    ]
    assert.ok(got.every((r) => r.status === RES_STATUS.ok), JSON.stringify(got))
    assert.equal(has(got), false)
  })

  test("tetherd's refusals come back as stable codes, by status; anything else is `failed`", async () => {
    w.reset()
    const cases: [string, number, Record<string, unknown>][] = [
      ['unknown-channel', RES_STATUS.notFound, { error: 'unknown-channel' }], ['unknown-line', RES_STATUS.notFound, { error: 'unknown-line' }],
      ['unknown-poll', RES_STATUS.notFound, { error: 'unknown-poll' }], ['slow-down', RES_STATUS.limit, { error: 'slow-down' }],
      ['closed', RES_STATUS.failed, { error: 'closed' }], ['poll-closed', RES_STATUS.failed, { error: 'poll-closed' }],
      ['not-called', RES_STATUS.failed, { error: 'not-called' }], ['vote-first', RES_STATUS.failed, { error: 'vote-first' }],
      ['bad-option', RES_STATUS.badRequest, { error: 'bad-option' }], ['too-old', RES_STATUS.failed, { error: 'too-old' }],
      ['not-moderator', RES_STATUS.failed, { error: 'failed' }], [MARKER, RES_STATUS.failed, { error: 'failed' }],
    ]
    for (const [code, status, body] of cases) {
      w.answer(async () => { throw new DaemonError(code as never, `recusado ${MARKER}`) })
      assert.deepEqual(await send(OP.vote, { channel: 'c_1', poll: 5, vote: 1 }), { status, body }, code)
    }
    w.answer(async () => { throw new Error(`quebrou ${MARKER}`) })
    assert.deepEqual(await send(OP.say, { channel: 'c_1', text: 'oi' }), { status: RES_STATUS.failed, body: { error: 'failed' } })
    assert.equal(bench.audits().some((l) => has(l)), false)
    assert.equal(bench.audits().filter((l) => l.act === 'channels.vote' && l.result === 'refused:closed' && l.target === 'c_1').length >= 1, true)
  })

  test('the strict body and its fields are checked before the pipe', async () => {
    w.reset()
    const from = bench.audits().length
    assert.deepEqual(await send(OP.say, { channel: 'c_1', text: 'oi', files: [{ path: 'C:/x' }] }), { status: RES_STATUS.badRequest, body: { error: 'bad-request' } }, 'no attachment')
    assert.deepEqual(await send(OP.say, { channel: 'c_1', text: 'oi', ext: 'channels', name: 'create' }), { status: RES_STATUS.badRequest, body: { error: 'bad-request' } })
    assert.deepEqual(await send(OP.say, { channel: '../c', text: 'oi' }), { status: RES_STATUS.badRequest, body: { error: 'bad-request' } })
    assert.deepEqual(await send(OP.say, { channel: 'c_1', text: 'x'.repeat(SAY_TEXT_MAX + 1) }), { status: RES_STATUS.badRequest, body: { error: 'too-long' } })
    assert.deepEqual(await send(OP.vote, { channel: 'c_1', poll: 1, vote: 'sim' }), { status: RES_STATUS.badRequest, body: { error: 'bad-request' } })
    assert.deepEqual(await s.request(OP.say, { channel: 'c_1', text: 'sem actId' }), { status: RES_STATUS.badRequest, body: {} }, 'a write without actId')
    assert.deepEqual(w.calls, [], 'nothing reached the pipe')
    assert.equal(bench.audits().slice(from).filter((l) => l.act === 'channels.say').length, 5, 'each refused write is audited too')
  })

  test('without the channels scope, locked, or without a presence credential: refused before the pipe', async () => {
    w.reset()
    scopes(allScopes.filter((x) => x !== 'channels'))
    for (const [op, body] of [[OP.say, { channel: 'c_1', text: 'oi' }], [OP.seen, { channel: 'c_1', seq: 1 }]] as const)
      assert.equal((await send(op, body)).status, RES_STATUS.noScope)
    scopes(allScopes)
    const other = await unlocked()
    assert.equal((await other.request(OP.lock, {}, { actId: actId() })).status, RES_STATUS.ok, 'session.lock')
    for (const [op, body] of [[OP.say, { channel: 'c_1', text: 'oi' }], [OP.vote, { channel: 'c_1', poll: 1, vote: 1 }], [OP.seen, { channel: 'c_1', seq: 1 }]] as const)
      assert.equal((await send(op, body, actId(), other)).status, RES_STATUS.locked)
    other.leg.close()
    assert.equal((await present(s, auth)).status, RES_STATUS.ok, 'the lock reached every session of the device: unlock again')
    const tv = await bench.pair('TV da sala')
    await until(() => bench.house.status().sessions < 6 || undefined, 5_000, 'room')
    const plain = await bench.connect(tv.device)
    for (const [op, body] of [[OP.say, { channel: 'c_1', text: 'oi' }], [OP.react, { channel: 'c_1', seq: 1, reaction: '👍' }], [OP.seen, { channel: 'c_1', seq: 1 }]] as const)
      assert.equal((await send(op, body, actId(), plain)).status, RES_STATUS.presenceRequired, 'E-8: a device without a credential only reads')
    plain.leg.close(); tv.fresh.leg.close()
    assert.deepEqual(w.calls, [], 'nothing reached the pipe')
  })

  test('idempotence: a repeat of a done act, of one in flight, after a timeout or from another session never speaks twice', async () => {
    w.reset()
    const id = actId()
    const first = await send(OP.say, { channel: 'c_1', text: 'uma vez' }, id)
    assert.deepEqual(await send(OP.say, { channel: 'c_1', text: 'uma vez' }, id), first, 'the same answer')
    assert.equal(w.calls.length, 1)
    assert.equal(bench.audits().at(-1)!.result, 'replay')
    assert.deepEqual(await send(OP.react, { channel: 'c_1', seq: 1, reaction: '👍' }, id), { status: RES_STATUS.badRequest, body: { error: 'bad-request' } }, "an actId never answers another op's act")
    assert.equal(w.calls.length, 1)

    // In flight: the repeat waits for the first and gets its answer.
    w.hold(true)
    const id2 = actId()
    const a = send(OP.poll, { channel: 'c_1', question: 'q' }, id2)
    await until(() => w.held.length === 1 || undefined, 2_000, 'the first at tetherd')
    const b = send(OP.poll, { channel: 'c_1', question: 'q' }, id2)
    await new Promise((r) => setTimeout(r, 50))
    w.held.shift()!()
    const [ra, rb] = await Promise.all([a, b])
    assert.equal(ra.status, RES_STATUS.ok)
    assert.deepEqual(rb, ra)
    assert.equal(w.calls.length, 2, 'one poll at tetherd')

    // Past the deadline: `timeout`, and the real outcome later for the same actId, from another session of the device.
    const id3 = actId()
    const late = await send(OP.say, { channel: 'c_1', text: 'demorada' }, id3)
    assert.deepEqual(late, { status: RES_STATUS.failed, body: { error: 'timeout' } })
    const again = await send(OP.say, { channel: 'c_1', text: 'demorada' }, id3)
    assert.deepEqual(again, { status: RES_STATUS.failed, body: { error: 'timeout' } }, 'still waiting: timeout again, never a second speech')
    w.held.shift()!()
    await until(() => writes.late === 0 || undefined, 2_000, 'tetherd answered')
    w.hold(false)
    const reconnected = await unlocked()
    assert.deepEqual(await send(OP.say, { channel: 'c_1', text: 'demorada' }, id3, reconnected), { status: RES_STATUS.ok, body: { seq: 12 } }, 'after reconnecting: the real answer')
    assert.equal(w.calls.filter((c) => c.name === 'say').length, 2, 'two speeches in all: the first and the late one, each once')
    reconnected.leg.close()
  })

  test('RR4 B-3: a write whose outcome comes past the deadline audits `timeout`, then `late:<result>`, without the text', async () => {
    w.reset()
    w.hold(true)
    const from = bench.audits().length
    const talk = () => bench.audits().slice(from).filter((l) => l.act.startsWith('channels.'))
    assert.deepEqual(await send(OP.say, { channel: 'c_1', text: `atrasada ${MARKER}` }), { status: RES_STATUS.failed, body: { error: 'timeout' } })
    assert.deepEqual(talk().map((l) => [l.act, l.result, l.target]), [['channels.say', 'timeout', 'c_1']])
    w.held.shift()!()
    await until(() => bench.audits().slice(from).some((l) => l.result.startsWith('late:')) || undefined, 2_000, 'the late line')
    // A late refusal keeps its code too.
    w.answer(async () => { throw new DaemonError('closed' as never, `recusado ${MARKER}`) })
    assert.equal((await send(OP.react, { channel: 'c_1', seq: 1, reaction: '👍' })).status, RES_STATUS.failed)
    w.held.shift()!()
    await until(() => bench.audits().slice(from).filter((l) => l.result.startsWith('late:')).length === 2 || undefined, 2_000, 'the second late line')
    w.hold(false)
    const lines = talk()
    assert.deepEqual(lines.map((l) => [l.act, l.result, l.target, l.deviceId]), [
      ['channels.say', 'timeout', 'c_1', deviceId()], ['channels.say', 'late:ok', 'c_1', deviceId()],
      ['channels.react', 'timeout', 'c_1', deviceId()], ['channels.react', 'late:refused:closed', 'c_1', deviceId()],
    ])
    assert.equal(has(lines) || JSON.stringify(lines).includes('atrasada'), false, 'never the text')
    await until(() => writes.late === 0 || undefined, 2_000, 'nothing late')
  })

  test('RR4 B-2: 1 100 "seen" of the same device never push a speech out of the cache: its resend is a replay, one speech at tetherd', async () => {
    w.reset()
    const speech = actId()
    // The device never heard this answer (the route was cut): it will resend under the same actId.
    const first = await send(OP.say, { channel: 'c_1', text: 'sem resposta' }, speech)
    assert.equal(first.status, RES_STATUS.ok)
    for (let i = 0; i < 1_100; i++) assert.equal((await send(OP.seen, { channel: 'c_1', seq: i + 1 })).status, RES_STATUS.ok)
    const from = bench.audits().length
    assert.deepEqual(await send(OP.say, { channel: 'c_1', text: 'sem resposta' }, speech), first, 'the same answer')
    assert.equal(bench.audits().slice(from).at(-1)!.result, 'replay')
    assert.equal(w.calls.filter((c) => c.name === 'say').length, 1, 'one speech at tetherd')
    // A "seen" is idempotent by the state it leaves: a repeat of one goes to tetherd again, and changes nothing there.
    const seen = actId()
    await send(OP.seen, { channel: 'c_1', seq: 5 }, seen)
    assert.equal((await send(OP.seen, { channel: 'c_1', seq: 5 }, seen)).status, RES_STATUS.ok)
    assert.equal(w.calls.filter((c) => c.name === 'seen').length, 1_102)
  })

  test('busy: the writes in flight at their ceiling refuse the next one before the pipe', async () => {
    w.reset()
    w.hold(true)
    const flying = [0, 1, 2, 3].map(() => send(OP.seen, { channel: 'c_1', seq: 1 }))
    await until(() => w.held.length === 4 || undefined, 2_000, 'four at tetherd')
    assert.deepEqual(await send(OP.seen, { channel: 'c_1', seq: 1 }), { status: RES_STATUS.limit, body: { error: 'busy' } })
    assert.equal(w.calls.length, 4)
    for (const h of w.held.splice(0)) h()
    for (const r of await Promise.all(flying)) assert.equal(r.status, RES_STATUS.ok)
    w.hold(false)
    assert.equal((await send(OP.seen, { channel: 'c_1', seq: 1 })).status, RES_STATUS.ok, 'free again')
  })
})

describe('the speech has its own ceiling per device', () => {
  let bench: HouseBench
  const w = writeBench()
  after(async () => { await bench?.stop() })

  test('over speechPerDevicePerMin a speech is `slow-down` before the pipe; a reaction is not a speech; insisting closes the session', async () => {
    bench = await startHouseBench({ origin: ORIGIN, writes: pipeWrites(w.request), limits: { speechPerDevicePerMin: 2, strikesMax: 3, reqPerDevicePerMin: 10_000, gesturesPerDevicePerMin: 10_000 } })
    await registerAndUnlock(bench.fresh, bench.device.kD.pub)
    const s = bench.fresh
    const say = () => s.request(OP.say, { channel: 'c_1', text: 'oi' }, { actId: actId() })
    assert.equal((await say()).status, RES_STATUS.ok)
    assert.equal((await say()).status, RES_STATUS.ok)
    assert.deepEqual(await say(), { status: RES_STATUS.limit, body: { error: 'slow-down' } })
    assert.equal((await s.request(OP.react, { channel: 'c_1', seq: 1, reaction: '👍' }, { actId: actId() })).status, RES_STATUS.ok, 'a reaction is no speech')
    assert.equal(w.calls.filter((c) => c.name === 'say').length, 2)
    assert.equal(bench.audits().filter((l) => l.act === 'channels.say' && l.result === 'limit:speech' && l.target === 'c_1').length, 1)
    assert.deepEqual(await say(), { status: RES_STATUS.limit, body: { error: 'slow-down' } })
    await say().catch(() => undefined)
    await until(() => s.closed || undefined, 5_000, 'the session closed for insisting')
  })
})
