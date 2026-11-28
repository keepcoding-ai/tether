// RR5 (fio-spec 18): the person manages a channel from afar. Proved here:
// - talkArgs (src/remote/talk.ts) checks each managing body before the pipe: a channel and an agent by id (never `user`, a
//   name or a position), a poll by its seq, a new channel's name folded as the app's card folds it and refused unless it is
//   a room name;
// - a real House (remoted.house-bench.ts) sends each op as the ONE pair of EXT_WRITES (`channels/<request>`), answers by the
//   allow list (a canary in every other field of tetherd's answer reaches no reply), maps tetherd's refusals to stable codes,
//   needs a proof of this very act to close a channel (before the pipe), and audits the device, the op and the channel id.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, test } from 'node:test'
import { DaemonError } from '../../src/daemon/client.ts'
import { OP_CODES, RES_STATUS, toHex, type Bytes } from '../../src/remote/index.ts'
import { ERROR_CODES } from '../../src/remote/projection.ts'
import { CHANNEL_MANAGE_OPS, ROOM_NAME_MAX, talkArgs, TALK_REFUSALS } from '../../src/remote/talk.ts'
import { EXT_WRITES } from '../../src/remoted/reach.ts'
import { pipeWrites } from '../../src/remoted/writes.ts'
import type { ExtRequestFn } from '../../src/remoted/reads.ts'
import { act, actId, ORIGIN, registerAndUnlock, type SoftAuthenticator } from './remoted.authenticator.ts'
import { startHouseBench, type HouseBench } from './remoted.house-bench.ts'
import type { DeviceSession } from './remoted.helpers.ts'

const MARKER = `canary${randomBytes(10).toString('hex')}`
const has = (v: unknown): boolean => JSON.stringify(v).includes(MARKER)
const ISO = '2026-11-28T10:00:00.000Z'
const OP = OP_CODES

describe('talkArgs: the managing bodies, checked before the pipe', () => {
  test('a new channel: the name folded as the card folds it, a room name or refused, within its ceiling', () => {
    assert.deepEqual(talkArgs('channels.create', { name: '  #Obra-Nova ' }), { channel: '', args: { name: 'obra-nova' } })
    for (const name of ['obra nova', '-obra', 'obra-', 'óbra', '', '#', 'a‮b c', 7, undefined]) assert.equal(talkArgs('channels.create', { name }), 'bad-request', String(name))
    assert.equal(talkArgs('channels.create', { name: 'a'.repeat(ROOM_NAME_MAX + 1) }), 'too-long')
    assert.equal(talkArgs('channels.create', { name: `${'a'.repeat(ROOM_NAME_MAX)}${' '.repeat(10)}` }), 'too-long', 'the raw text has its own ceiling')
  })

  test('an agent by its id, never the person nor a name with spaces; a poll by its seq; the channel by id', () => {
    for (const op of ['channels.join', 'channels.remove', 'channels.mute', 'channels.unmute'] as const) {
      assert.deepEqual(talkArgs(op, { channel: 'c_1', agent: 'a1b2c3d4' }), { channel: 'c_1', args: { channel: 'c_1', agent: 'a1b2c3d4' } }, op)
      for (const agent of ['user', 'o conferente', '', 3, undefined, '../x']) assert.equal(talkArgs(op, { channel: 'c_1', agent }), 'bad-request', `${op} ${String(agent)}`)
    }
    assert.deepEqual(talkArgs('channels.close', { channel: 'c_1' }), { channel: 'c_1', args: { channel: 'c_1' } })
    assert.deepEqual(talkArgs('channels.reopen', { channel: 'c_1' }), { channel: 'c_1', args: { channel: 'c_1' } })
    assert.deepEqual(talkArgs('channels.poll-close', { channel: 'c_1', poll: 4 }), { channel: 'c_1', args: { channel: 'c_1', poll: 4 } })
    for (const poll of [0, -1, 1.5, '4', undefined]) assert.equal(talkArgs('channels.poll-close', { channel: 'c_1', poll }), 'bad-request', String(poll))
    assert.equal(talkArgs('channels.close', { channel: 'c 1' }), 'bad-request')
  })

  test('every managing op is a pair of the channels, and every refusal a code a body may carry', () => {
    for (const op of CHANNEL_MANAGE_OPS) assert.equal(EXT_WRITES[op].ext, 'channels', op)
    for (const [code, status] of Object.entries(TALK_REFUSALS)) {
      assert.notEqual(status as number, RES_STATUS.ok as number, code)
      assert.ok((ERROR_CODES as readonly string[]).includes(code), code)
    }
    assert.equal(TALK_REFUSALS['unknown-agent'], RES_STATUS.notFound)
    assert.equal(TALK_REFUSALS['not-member'], RES_STATUS.failed)
  })
})

const summary = { id: 'c_9', name: 'obra', title: MARKER, owner: { kind: 'user' }, members: 3, seenByUser: 0, createdAt: ISO, desk: MARKER }
const ANSWERS: Record<string, (args: Record<string, unknown>) => unknown> = {
  create: () => ({ channel: summary, line: MARKER }),
  join: () => ({ channel: summary, already: false, extra: MARKER }),
  remove: () => ({ channel: summary }),
  mute: () => ({ channel: summary, already: true }),
  unmute: () => ({ channel: summary, already: false }),
  close: () => ({ channel: summary }),
  reopen: () => ({ channel: summary }),
  'poll-close': () => ({ result: { poll: 4, by: 'author', closer: { id: 'user', name: 'usuário' }, tally: [{ option: 1, text: 'ok', voters: [] }], missing: [], note: MARKER }, closedAt: ISO }),
}

describe('managing a channel through a real House', () => {
  let bench: HouseBench
  let s: DeviceSession
  let auth: SoftAuthenticator
  const calls: { name: string; args: Record<string, unknown> }[] = []
  let refuse: string | undefined
  const request: ExtRequestFn = async (b) => {
    calls.push({ name: b.name, args: b.args })
    if (refuse) throw new DaemonError(refuse as never, `recusado: ${refuse} ${MARKER}`)
    return { result: ANSWERS[b.name]!(b.args) }
  }
  const send = (op: number, body: Record<string, unknown>, id: Bytes = actId()) => s.request(op, body, { actId: id })
  const deviceId = (): string => toHex(bench.device.result!.deviceId)

  before(async () => {
    bench = await startHouseBench({ origin: ORIGIN, writes: pipeWrites(request, { timeoutMs: 1_000 }), limits: { reqPerDevicePerMin: 10_000, gesturesPerDevicePerMin: 10_000 } })
    auth = await registerAndUnlock(bench.fresh, bench.device.kD.pub)
    s = bench.fresh
  })
  after(async () => { await bench?.stop() })

  test('each op sends its one pair with the rebuilt arguments and answers by the allow list; the audit says the channel', async () => {
    const from = bench.audits().length
    assert.deepEqual(await send(OP['channels.create'], { name: '#Obra' }), { status: RES_STATUS.ok, body: { channel: 'c_9', name: 'obra' } })
    assert.deepEqual(await send(OP['channels.join'], { channel: 'c_9', agent: 'a1' }), { status: RES_STATUS.ok, body: { already: false } })
    assert.deepEqual(await send(OP['channels.mute'], { channel: 'c_9', agent: 'a1' }), { status: RES_STATUS.ok, body: { already: true } })
    assert.deepEqual(await send(OP['channels.unmute'], { channel: 'c_9', agent: 'a1' }), { status: RES_STATUS.ok, body: { already: false } })
    assert.deepEqual(await send(OP['channels.remove'], { channel: 'c_9', agent: 'a1' }), { status: RES_STATUS.ok, body: {} })
    assert.deepEqual(await send(OP['channels.poll-close'], { channel: 'c_9', poll: 4 }), {
      status: RES_STATUS.ok,
      body: { state: { seq: 4, result: { poll: 4, by: 'author', closer: { id: 'user', name: 'usuário' }, tally: [{ option: 1, text: 'ok', voters: [] }], missing: [] }, closedAt: ISO } },
    })
    assert.deepEqual(await send(OP['channels.reopen'], { channel: 'c_9' }), { status: RES_STATUS.ok, body: {} })
    assert.deepEqual(calls.map((c) => [c.name, c.args]), [
      ['create', { name: 'obra' }], ['join', { channel: 'c_9', agent: 'a1' }], ['mute', { channel: 'c_9', agent: 'a1' }],
      ['unmute', { channel: 'c_9', agent: 'a1' }], ['remove', { channel: 'c_9', agent: 'a1' }], ['poll-close', { channel: 'c_9', poll: 4 }],
      ['reopen', { channel: 'c_9' }],
    ])
    const lines = bench.audits().slice(from)
    assert.deepEqual(lines.map((l) => [l.act, l.result, l.target, l.deviceId]), [
      ['channels.create', 'ok', undefined, deviceId()], ['channels.join', 'ok', 'c_9', deviceId()], ['channels.mute', 'ok', 'c_9', deviceId()],
      ['channels.unmute', 'ok', 'c_9', deviceId()], ['channels.remove', 'ok', 'c_9', deviceId()], ['channels.poll-close', 'ok', 'c_9', deviceId()],
      ['channels.reopen', 'ok', 'c_9', deviceId()],
    ])
    assert.equal(JSON.stringify(lines).includes('obra'), false, 'the audit never carries the new name')
  })

  test('closing a channel needs a proof of this very act, before the pipe', async () => {
    calls.length = 0
    assert.equal((await send(OP['channels.close'], { channel: 'c_9' })).status, RES_STATUS.presenceRequired)
    assert.equal((await act(s, auth, OP['channels.close'], { channel: 'c_9' }, { proof: false })).status, RES_STATUS.presenceRequired)
    assert.deepEqual(calls, [], 'nothing reached tetherd')
    assert.deepEqual(await act(s, auth, OP['channels.close'], { channel: 'c_9' }), { status: RES_STATUS.ok, body: {} })
    assert.deepEqual(calls, [{ name: 'close', args: { channel: 'c_9' } }])
  })

  test("tetherd's refusals come back as stable codes, never its message", async () => {
    const cases: [string, number][] = [
      ['unknown-agent', RES_STATUS.notFound], ['unknown-channel', RES_STATUS.notFound], ['not-member', RES_STATUS.failed],
      ['name-taken', RES_STATUS.failed], ['closed', RES_STATUS.failed], ['desk', RES_STATUS.failed], ['not-closed', RES_STATUS.failed],
      ['poll-closed', RES_STATUS.failed], ['not-owner', RES_STATUS.failed],
    ]
    for (const [code, status] of cases) {
      refuse = code
      const r = await send(OP['channels.join'], { channel: 'c_9', agent: 'a1' })
      assert.equal(r.status, status, code)
      assert.deepEqual(r.body, { error: code === 'not-owner' ? 'failed' : code }, code)
      assert.equal(has(r), false)
    }
    refuse = undefined
    assert.equal(bench.audits().some((l) => has(l)), false)
  })

  test('the canary of every field beyond the allowed ones reaches no reply', async () => {
    const replies = [
      await send(OP['channels.create'], { name: 'obra' }), await send(OP['channels.join'], { channel: 'c_9', agent: 'a1' }),
      await send(OP['channels.poll-close'], { channel: 'c_9', poll: 4 }),
    ]
    for (const r of replies) assert.equal(r.status, RES_STATUS.ok)
    assert.equal(has(replies), false)
  })
})
