// RR5 step 5.2: the management acts from afar, direct on tetherd (slots, ronda, processes). Proved here:
// - manageArgs (src/remote/manage.ts) checks every field before the pipe and rebuilds the ONE message of the op: the target
//   by its id, text folded and capped, never `by`, a recipe, a wait, nor a `why` other than `end`;
// - pipeActs (src/remoted/acts.ts) sends only what tetherd's own rule (reach.ts remoteMayAct) takes, under its own
//   ceilings, and answers the device by the deadline while the act's real outcome still comes;
// - a real House (remoted.house-bench.ts) serves the lines: answers by the allow list (no env, no args, no folder), the
//   refusals of tetherd as stable codes (an id that names nothing is 0x06), "in use by another" with who / until when / what
//   for and the force as a second act, the gate (scope, lock, credential) before the pipe, a proof per act for what
//   destroys, the door conferred again at dispatch (B-4), and the idempotence (a restart resent never restarts twice). Every
//   act leaves an audit line with the device, the op, the target id and the result, never the text.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, test } from 'node:test'
import { DaemonError } from '../../src/daemon/client.ts'
import { OP_CODES, RES_STATUS, toHex, type Bytes } from '../../src/remote/index.ts'
import { ERROR_CODES } from '../../src/remote/projection.ts'
import { ACT_REFUSALS, manageArgs, PROC_REASON_MAX, RONDA_TEXT_MAX, SLOT_NAME_MAX } from '../../src/remote/manage.ts'
import { ActError, pipeActs, type PipeActs } from '../../src/remoted/acts.ts'
import { act, actId, ORIGIN, present, registerAndUnlock, type SoftAuthenticator } from './remoted.authenticator.ts'
import { startHouseBench, type HouseBench } from './remoted.house-bench.ts'
import { until, type DeviceSession } from './remoted.helpers.ts'

const MARKER = `canary${randomBytes(12).toString('hex')}`
const has = (v: unknown): boolean => JSON.stringify(v).includes(MARKER)
const ISO = '2026-11-28T10:00:00.000Z'
const LATER = new Date(Date.now() + 10 * 60_000).toISOString()
const OP = OP_CODES

// ---- manageArgs ---------------------------------------------------------------------------------------------------

describe('manageArgs: the strict bodies, checked before the pipe', () => {
  test('each op builds the one message of its line, the target by its id', () => {
    assert.deepEqual(manageArgs('agents.stop', { slotId: 's_1' }), { msg: { t: 'stop', slotId: 's_1', why: 'end' }, target: 's_1' })
    assert.deepEqual(manageArgs('agents.start', { slotId: 's_1', choice: 'new' }), { msg: { t: 'start', slotId: 's_1', choice: 'new' }, target: 's_1' })
    assert.deepEqual(manageArgs('agents.rename', { slotId: 's_1', name: ' Revisor\u202E\u200B  da ata ' }), { msg: { t: 'rename-slot', slotId: 's_1', name: 'Revisor da ata' }, target: 's_1' })
    assert.deepEqual(manageArgs('ronda.set', { slotId: 's_1', interval: ' 10M ', nudge: 'olha\no build', criterion: '' }), {
      msg: { t: 'ronda-set', slotId: 's_1', interval: '10m', nudge: 'olha o build', criterion: '' }, target: 's_1',
    })
    assert.deepEqual(manageArgs('ronda.off', { slotId: 's_1' }), { msg: { t: 'ronda-off', slotId: 's_1', force: true }, target: 's_1' })
    assert.deepEqual(manageArgs('procs.start', { name: 'web' }), { msg: { t: 'proc-start', name: 'web' }, target: 'web' })
    assert.deepEqual(manageArgs('procs.stop', { name: 'web' }), { msg: { t: 'proc-stop', name: 'web' }, target: 'web' })
    assert.deepEqual(manageArgs('procs.stop-force', { name: 'web', reason: 'preciso\tagora' }), { msg: { t: 'proc-stop', name: 'web', force: 'preciso agora' }, target: 'web' })
    assert.deepEqual(manageArgs('procs.use', { name: 'web', purpose: 'testar', duration: '15m' }), { msg: { t: 'proc-use', name: 'web', duration: '15m', purpose: 'testar' }, target: 'web' })
    assert.deepEqual(manageArgs('procs.forget-force', { name: 'web', reason: 'velho' }), { msg: { t: 'proc-forget', name: 'web', force: 'velho' }, target: 'web' })
    assert.deepEqual(manageArgs('procs.list', {}), { msg: { t: 'proc-list' }, target: '' })
  })

  test('ids, choices, texts and their ceilings: refused before the pipe', () => {
    for (const slotId of ['', '../s', 's 1', 's'.repeat(65), 7, undefined, 's\u202E']) assert.equal(manageArgs('agents.stop', { slotId }), 'bad-request', String(slotId))
    for (const name of ['Web', '-web', 'we b', 'w'.repeat(65), 7]) assert.equal(manageArgs('procs.stop', { name }), 'bad-request', String(name))
    assert.equal(manageArgs('agents.start', { slotId: 's', choice: 'fresh' }), 'bad-request')
    assert.equal(manageArgs('agents.rename', { slotId: 's', name: 'n'.repeat(SLOT_NAME_MAX + 1) }), 'too-long')
    assert.equal(manageArgs('agents.rename', { slotId: 's', name: '\u200B ' }), 'bad-request', 'an empty name once folded')
    assert.equal(manageArgs('ronda.set', { slotId: 's', criterion: 'c'.repeat(RONDA_TEXT_MAX + 1) }), 'too-long')
    assert.equal(manageArgs('ronda.set', { slotId: 's', interval: '10m; rm' }), 'bad-request')
    assert.equal(manageArgs('procs.stop-force', { name: 'web' }), 'bad-request', 'forcing asks a reason')
    assert.equal(manageArgs('procs.stop-force', { name: 'web', reason: ' ' }), 'bad-request')
    assert.equal(manageArgs('procs.stop', { name: 'web', reason: 'r'.repeat(PROC_REASON_MAX + 1) }), 'too-long')
    assert.equal(manageArgs('procs.use', { name: 'web' }), 'bad-request', 'a use says what for')
  })

  test('every refusal of tetherd maps to a status that is no success and a code a body may carry; a stale id is 0x06', () => {
    for (const [code, status] of Object.entries(ACT_REFUSALS)) {
      assert.notEqual(status as number, RES_STATUS.ok as number, code)
      assert.ok((ERROR_CODES as readonly string[]).includes(code), code)
    }
    assert.equal(ACT_REFUSALS['unknown-slot'], RES_STATUS.notFound)
    assert.equal(ACT_REFUSALS['unknown-proc'], RES_STATUS.notFound)
  })
})

// ---- pipeActs ---------------------------------------------------------------------------------------------------------

describe('pipeActs: the act path of the portal', () => {
  test('a message outside the rule never leaves; one inside is sent as built', async () => {
    const sent: unknown[] = []
    const acts = pipeActs(async (m) => { sent.push(m); return { ok: true } })
    assert.deepEqual(await acts.act({ t: 'stop', slotId: 's', why: 'end' }).answer, { ok: true })
    for (const m of [{ t: 'stop', slotId: 's', why: 'hibernate' }, { t: 'proc-stop', name: 'w', by: { slotId: 'x' } }, { t: 'create' }]) {
      await assert.rejects(acts.act(m as never).answer, (e: unknown) => e instanceof ActError && e.code === 'outside-reach')
      await assert.rejects(acts.read(m as never), (e: unknown) => e instanceof ActError && e.code === 'outside-reach')
    }
    assert.deepEqual(sent, [{ t: 'stop', slotId: 's', why: 'end' }])
  })

  test('the deadline answers the device and frees the slot; the late act is counted until tetherd answers, its outcome still comes', async () => {
    const hold: ((v: Record<string, unknown>) => void)[] = []
    const logs: string[] = []
    const acts = pipeActs(() => new Promise((res) => { hold.push(res) }), { max: 1, timeoutMs: 40, lateMax: 1, log: (m) => logs.push(m) })
    const a = acts.act({ t: 'restart', slotId: 's' })
    await assert.rejects(acts.act({ t: 'restart', slotId: 't' }).answer, (e: unknown) => e instanceof ActError && e.why === 'limit')
    await assert.rejects(a.answer, (e: unknown) => e instanceof ActError && e.why === 'timeout')
    assert.deepEqual([acts.inflight, acts.late], [0, 1])
    await assert.rejects(acts.act({ t: 'restart', slotId: 't' }).answer, (e: unknown) => e instanceof ActError && e.why === 'limit', 'one late is the ceiling')
    hold.shift()!({ slot: { slotId: 's' } })
    assert.deepEqual(await a.settled, { ok: true, reply: { slot: { slotId: 's' } } })
    await until(() => acts.late === 0 || undefined, 1_000, 'no longer late')
    assert.equal(logs.length, 3, logs.join('\n'))
    assert.equal(logs.some((l) => /slotId|restart/.test(l)), false, 'the log carries no argument')
  })

  test("tetherd's refusal keeps its code; any other failure is `failed`", async () => {
    const r = pipeActs(async () => { throw new DaemonError('unknown-slot', `slot desconhecido: ${MARKER}`) }).act({ t: 'stop', slotId: 's', why: 'end' })
    await assert.rejects(r.answer, (e: unknown) => e instanceof ActError && e.why === 'refused' && e.code === 'unknown-slot')
    await assert.rejects(pipeActs(async () => { throw new Error('caiu') }).read({ t: 'proc-list' }), (e: unknown) => e instanceof ActError && e.why === 'failed')
  })
})

// ---- through a real House ---------------------------------------------------------------------------------------------

const author = { kind: 'agent', slotId: 'a1', name: 'conferente', agent: 'claude', sessionId: MARKER, user: MARKER }
const proc = (o: Record<string, unknown> = {}) => ({
  name: 'web', status: 'running', run: 3, pid: 4321, startedAt: ISO, startedBy: author,
  card: { command: 'node', args: [`--token=${MARKER}`], cwd: 'C:/obra', env: { API_KEY: MARKER }, ports: [5173], createdAt: ISO, registeredBy: author, info: { x: MARKER } },
  uses: [{ key: 'slot:a1', by: author, until: LATER, purpose: 'rodando os testes', declaredAt: ISO }],
  extra: MARKER, ...o,
})
const slot = (o: Record<string, unknown> = {}) => ({
  slotId: 's_1', kind: 'claude', name: 'conferente', cwd: 'C:/obra', folder: MARKER, status: 'exited', want: 'ended', binding: { sessionId: MARKER },
  args: [MARKER], ronda: { v: 1, intervalMs: 600_000, nextAt: ISO, nudge: `olha ${MARKER}\u202E`, createdAt: ISO }, ...o,
})

interface Sent { t: string; [k: string]: unknown }

function actBench() {
  const sent: Sent[] = []
  let answer: (m: Sent) => Promise<Record<string, unknown>> = async () => ({})
  const held: (() => void)[] = []
  let hold = false
  return {
    sent, held,
    answer: (f: typeof answer) => { answer = f },
    hold: (on: boolean) => { hold = on },
    request: (m: Sent): Promise<Record<string, unknown>> => {
      sent.push(m)
      if (!hold) return answer(m)
      return new Promise((res, rej) => { held.push(() => { answer(m).then(res, rej) }) })
    },
  }
}

describe('the management acts through a real House', () => {
  let bench: HouseBench
  let s: DeviceSession
  let auth: SoftAuthenticator
  let acts: PipeActs
  const b = actBench()
  const deviceId = (): string => toHex(bench.device.result!.deviceId)
  const allScopes: string[] = []
  const scopes = (list: readonly string[]): void => {
    const d = bench.registry.get(deviceId())!
    d.scopes = [...list]
    bench.house.upsertDevice(structuredClone(d))
  }
  const send = (op: number, body: Record<string, unknown>, id: Bytes = actId(), on: DeviceSession = s) => on.request(op, body, { actId: id })
  const fine = async (m: Sent): Promise<Record<string, unknown>> => {
    switch (m.t) {
      case 'stop': case 'start': case 'restart': case 'rename-slot': return { slot: slot({ status: m.t === 'start' ? 'running' : 'exited' }) }
      case 'forget': return {}
      case 'ronda-get': case 'ronda-set': return { ronda: slot().ronda, rondaOutcome: 'created' }
      case 'ronda-off': return { ronda: null, rondaOutcome: 'off' }
      case 'proc-list': return { procs: [proc(), proc({ name: 'api' })] }
      case 'proc-info': return { proc: proc(), events: [{ kind: 'recipe-changed', ts: ISO, by: author, before: { env: { API_KEY: MARKER } }, after: { env: { API_KEY: MARKER } } }, { kind: 'use-declared', ts: ISO, by: author, until: LATER, purpose: 'testes' }] }
      case 'proc-release': return { proc: proc(), released: true }
      default: return { proc: proc() }
    }
  }

  before(async () => {
    acts = pipeActs((m) => b.request(m as Sent), { timeoutMs: 300 })
    bench = await startHouseBench({ origin: ORIGIN, acts, actTimeoutMs: 300, limits: { reqPerDevicePerMin: 10_000, gesturesPerDevicePerMin: 10_000, hsPerTicketPerMin: 1_000 } })
    allScopes.push(...bench.registry.get(deviceId())!.scopes)
    auth = await registerAndUnlock(bench.fresh, bench.device.kD.pub)
    s = bench.fresh
  })
  after(async () => { await bench?.stop() })

  test('each line answers by its allow list and audits the target id; the canary of env, args, folder and session reaches no reply', async () => {
    b.answer(fine)
    b.sent.length = 0
    const from = bench.audits().length
    const stopped = await send(OP['agents.stop'], { slotId: 's_1' })
    assert.deepEqual(stopped, { status: RES_STATUS.ok, body: { slot: { slotId: 's_1', kind: 'claude', status: 'exited', name: 'conferente', want: 'ended', ronda: { intervalMs: 600_000, nextAt: ISO, nudge: `olha ${MARKER}` } } } })
    const got = [
      await send(OP['agents.start'], { slotId: 's_1' }), await send(OP['agents.rename'], { slotId: 's_1', name: 'novo' }),
      await send(OP['ronda.set'], { slotId: 's_1', interval: '10m' }), await send(OP['ronda.off'], { slotId: 's_1' }),
      await send(OP['ronda.get'], { slotId: 's_1' }), await send(OP['procs.list'], {}), await send(OP['procs.info'], { name: 'web' }),
      await send(OP['procs.start'], { name: 'web' }), await send(OP['procs.use'], { name: 'web', purpose: 'olhar' }), await send(OP['procs.release'], { name: 'web' }),
    ]
    assert.ok(got.every((r) => r.status === RES_STATUS.ok), JSON.stringify(got.map((r) => r.status)))
    const list = got[5]!.body as { procs: Record<string, unknown>[]; more: number }
    assert.deepEqual(list.procs.map((p) => p.name), ['web', 'api'])
    assert.deepEqual(list.procs[0]!.envNames, ['API_KEY'])
    assert.deepEqual(list.procs[0]!.uses, [{ by: { kind: 'agent', name: 'conferente', agent: 'claude' }, until: LATER, purpose: 'rodando os testes' }])
    const info = got[6]!.body as { events: Record<string, unknown>[] }
    assert.deepEqual(info.events.map((e) => e.kind), ['recipe-changed', 'use-declared'])
    // The nudge is an agent's text and goes (cleaned); nothing else of the canary does: no env value, arg, folder, session, user.
    const strip = (v: unknown) => JSON.stringify(v).replaceAll(`olha ${MARKER}`, '')
    assert.equal(strip([stopped, ...got]).includes(MARKER), false, strip([stopped, ...got]))
    assert.deepEqual(b.sent.map((m) => m.t), ['stop', 'start', 'rename-slot', 'ronda-set', 'ronda-off', 'ronda-get', 'proc-list', 'proc-info', 'proc-start', 'proc-use', 'proc-release'])
    const lines = bench.audits().slice(from)
    assert.deepEqual(lines.map((l) => [l.act, l.result, l.target]), [
      ['agents.stop', 'ok', 's_1'], ['agents.start', 'ok', 's_1'], ['agents.rename', 'ok', 's_1'], ['ronda.set', 'ok', 's_1'], ['ronda.off', 'ok', 's_1'],
      ['procs.start', 'ok', 'web'], ['procs.use', 'ok', 'web'], ['procs.release', 'ok', 'web'],
    ], 'the reads leave no line; every act does, with its target id')
    assert.ok(lines.every((l) => l.deviceId === deviceId()))
    assert.equal(has(lines) || JSON.stringify(lines).includes('olhar') || JSON.stringify(lines).includes('novo'), false, 'never text')
  })

  test('an id that names nothing is 0x06; the other refusals of tetherd come back by their code, never its message', async () => {
    b.sent.length = 0
    b.answer(async (m) => { throw new DaemonError(m.t === 'stop' ? 'unknown-slot' : m.t === 'proc-start' ? 'port-busy' : m.t === 'proc-stop' ? 'unknown-proc' : 'unconfirmed', `nada ${MARKER}`) })
    assert.deepEqual(await send(OP['agents.stop'], { slotId: 'nao_ha' }), { status: RES_STATUS.notFound, body: { error: 'unknown-slot' } })
    assert.deepEqual(await send(OP['procs.stop'], { name: 'nao-ha' }), { status: RES_STATUS.notFound, body: { error: 'unknown-proc' } })
    assert.deepEqual(await send(OP['procs.start'], { name: 'web' }), { status: RES_STATUS.failed, body: { error: 'port-busy' } })
    assert.deepEqual(await send(OP['agents.restart'], { slotId: 's_1' }), { status: RES_STATUS.failed, body: { error: 'unconfirmed' } })
    b.answer(async () => { throw new DaemonError('door-denied', MARKER) })
    assert.deepEqual(await send(OP['agents.restart'], { slotId: 's_1' }), { status: RES_STATUS.failed, body: { error: 'failed' } })
    assert.equal(bench.audits().some((l) => has(l)), false)
    assert.ok(bench.audits().some((l) => l.act === 'agents.stop' && l.result === 'refused:unknown-slot' && l.target === 'nao_ha'))
  })

  test('"in use by another": who, until when, what for (not the person\'s own use); "anyway" is a second act with its reason', async () => {
    b.sent.length = 0
    const mine = { key: 'app', by: { kind: 'app', user: MARKER }, until: LATER, purpose: 'meu' }
    b.answer(async (m) => {
      if (m.t === 'proc-stop' && m.force === undefined) throw new DaemonError('proc-in-use', `web está em uso ${MARKER}`)
      if (m.t === 'proc-info') return { proc: proc({ uses: [...proc().uses, mine, { key: 'slot:a2', by: author, until: '2020-01-01T00:00:00.000Z', purpose: 'venceu' }] }) }
      return { proc: proc({ status: 'stopped' }) }
    })
    const refused = await send(OP['procs.stop'], { name: 'web', reason: 'trocar a porta' })
    assert.deepEqual(refused, { status: RES_STATUS.failed, body: { error: 'proc-in-use', uses: [{ by: { kind: 'agent', name: 'conferente', agent: 'claude' }, until: LATER, purpose: 'rodando os testes' }] } })
    const forced = await send(OP['procs.stop-force'], { name: 'web', reason: 'preciso da porta' })
    assert.equal(forced.status, RES_STATUS.ok)
    assert.deepEqual(b.sent, [{ t: 'proc-stop', name: 'web', reason: 'trocar a porta' }, { t: 'proc-info', name: 'web' }, { t: 'proc-stop', name: 'web', force: 'preciso da porta' }])
    assert.deepEqual(bench.audits().slice(-2).map((l) => [l.act, l.result, l.target]), [['procs.stop', 'refused:proc-in-use', 'web'], ['procs.stop-force', 'ok', 'web']])
  })

  test('without the scope, locked, or without a presence credential: refused before the pipe', async () => {
    b.answer(fine)
    b.sent.length = 0
    scopes(allScopes.filter((x) => x !== 'manage:procs' && x !== 'manage:agents'))
    for (const [op, body] of [[OP['procs.stop'], { name: 'web' }], [OP['procs.list'], {}], [OP['agents.stop'], { slotId: 's_1' }], [OP['ronda.set'], { slotId: 's_1' }]] as const)
      assert.equal((await send(op, body)).status, RES_STATUS.noScope)
    scopes(allScopes.filter((x) => x !== 'manage:destructive'))
    assert.equal((await act(s, auth, OP['agents.forget'], { slotId: 's_1' })).status, RES_STATUS.noScope, 'forgetting needs manage:destructive')
    scopes(allScopes)
    await until(() => bench.house.status().sessions < 3 || undefined, 5_000, 'room')
    const other = await bench.connect()
    assert.equal((await other.request(OP['session.lock'], {}, { actId: actId() })).status, RES_STATUS.ok, 'session.lock')
    assert.equal((await other.request(OP['agents.stop'], { slotId: 's_1' }, { actId: actId() })).status, RES_STATUS.locked, 'locked')
    other.leg.close()
    assert.equal((await present(s, auth)).status, RES_STATUS.ok, 'the lock reached every session: unlock again')
    const tv = await bench.pair('TV da sala')
    await until(() => bench.house.status().sessions < 6 || undefined, 5_000, 'room')
    const plain = await bench.connect(tv.device)
    assert.equal((await plain.request(OP['agents.stop'], { slotId: 's_1' }, { actId: actId() })).status, RES_STATUS.presenceRequired, 'E-8')
    plain.leg.close(); tv.fresh.leg.close()
    assert.equal((await send(OP['agents.stop'], { slotId: 's_1', by: { slotId: 'a1' } })).status, RES_STATUS.badRequest, 'no field outside the line')
    assert.deepEqual(b.sent, [], 'nothing reached the pipe')
  })

  test('what destroys needs a proof of this very act: none or a stale one is refused before the pipe, a good one goes', async () => {
    b.answer(fine)
    b.sent.length = 0
    for (const [op, body] of [[OP['agents.forget'], { slotId: 's_1' }], [OP['procs.forget'], { name: 'web' }], [OP['procs.forget-force'], { name: 'web', reason: 'velho' }]] as const) {
      assert.equal((await send(op, body)).status, RES_STATUS.presenceRequired, `${op}: no proof`)
      assert.equal((await act(s, auth, op, body, { proof: false })).status, RES_STATUS.presenceRequired)
    }
    assert.deepEqual(b.sent, [])
    assert.deepEqual(await act(s, auth, OP['agents.forget'], { slotId: 's_1' }), { status: RES_STATUS.ok, body: {} })
    assert.deepEqual(await act(s, auth, OP['procs.forget'], { name: 'web' }), { status: RES_STATUS.ok, body: {} })
    assert.deepEqual(b.sent, [{ t: 'forget', slotId: 's_1' }, { t: 'proc-forget', name: 'web' }])
    assert.deepEqual(bench.audits().slice(-2).map((l) => [l.act, l.result, l.target]), [['agents.forget', 'ok', 's_1'], ['procs.forget', 'ok', 'web']])
  })

  test('idempotence: a restart resent (done, in flight, after a timeout) never restarts twice; another op on the same actId is malformed', async () => {
    b.answer(fine)
    b.sent.length = 0
    const id = actId()
    const first = await send(OP['agents.restart'], { slotId: 's_1' }, id)
    assert.deepEqual(await send(OP['agents.restart'], { slotId: 's_1' }, id), first)
    assert.equal((await send(OP['agents.stop'], { slotId: 's_1' }, id)).status, RES_STATUS.badRequest)
    assert.equal(b.sent.length, 1)
    // In flight, then past the deadline: the repeat waits, then answers timeout without sending; the real outcome is kept.
    b.sent.length = 0
    b.hold(true)
    const id2 = actId()
    const a = send(OP['agents.restart'], { slotId: 's_1' }, id2)
    await until(() => b.held.length === 1 || undefined, 2_000, 'held')
    const again = send(OP['agents.restart'], { slotId: 's_1' }, id2)
    assert.deepEqual((await a).body, { error: 'timeout' })
    assert.deepEqual((await again).body, { error: 'timeout' })
    b.hold(false)
    b.held.shift()!()
    await until(() => bench.audits().some((l) => l.act === 'agents.restart' && l.result === 'late:ok') || undefined, 2_000, 'late:ok')
    assert.equal((await send(OP['agents.restart'], { slotId: 's_1' }, id2)).status, RES_STATUS.ok, 'the real outcome, for the same actId')
    assert.equal(b.sent.length, 1, 'tetherd saw one restart')
  })

  test('a revocation that begins while an act waits sends nothing (B-4)', async () => {
    b.answer(fine)
    b.sent.length = 0
    const other = await bench.pair('Outro telefone')
    const a2 = await registerAndUnlock(other.fresh, other.device.kD.pub)
    void a2
    const id = toHex(other.device.result!.deviceId)
    const pending = other.fresh.request(OP['agents.stop'], { slotId: 's_1' }, { actId: actId() }).catch(() => undefined)
    await bench.house.revoke(id, [])
    await pending
    assert.deepEqual(b.sent, [], 'tetherd never got it')
  })
})
