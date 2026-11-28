// RR5 step 5.1, the portal's half: the gestures only the app knows, asked from afar. Proved here:
// - appActArgs / parseAppAct (src/remote/app-acts.ts): the closed list, field by field, the same for the portal (which builds
//   the act from the strict body) and for tetherd and the app (which take only an act in the form the portal builds); ids
//   only, a desk's name folded and capped, the defaults of the app's own dialogs filled;
// - a real House (remoted.house-bench.ts) sends each op as the ONE pair `regency/act` on its own write path; answers by the
//   allow list; the refusals as stable codes (`no-app` is 0x08, an id that names nothing 0x06, `busy` 0x07); the deadline
//   answers `timeout` and the real outcome becomes a `late:` line of the audit; what destroys needs a proof of this very act
//   before the pipe; giving power to an agent needs the window; a revoked device sends nothing; every act audits device,
//   op, target id and result, never a desk's name.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, test } from 'node:test'
import { DaemonError } from '../../src/daemon/client.ts'
import { OP_CODES, RES_STATUS, toHex, type Bytes } from '../../src/remote/index.ts'
import { ERROR_CODES } from '../../src/remote/projection.ts'
import { APP_ACT_FIELDS, APP_ACT_REFUSALS, appActArgs, DESK_NAME_MAX, parseAppAct, seenMatches, seenName, type AppActOp } from '../../src/remote/app-acts.ts'
import { pipeWrites } from '../../src/remoted/writes.ts'
import { act, actId, ORIGIN, present, registerAndUnlock, type SoftAuthenticator } from './remoted.authenticator.ts'
import { startHouseBench, type HouseBench } from './remoted.house-bench.ts'
import { until, type DeviceSession } from './remoted.helpers.ts'

const OP = OP_CODES
const MARKER = `canary${randomBytes(8).toString('hex')}`

describe('appActArgs and parseAppAct: one closed list for the portal, tetherd and the app', () => {
  test('each op builds its act from the strict body: ids, the folded name, the defaults of the app\'s dialogs', () => {
    assert.deepEqual(appActArgs('desks.hibernate', { deskId: 'desk-2' }), { args: { act: 'desks.hibernate', deskId: 'desk-2' }, target: 'desk-2' })
    assert.deepEqual(appActArgs('desks.create', { name: '  Obra‮​  nova\n', color: 'teal' }), { args: { act: 'desks.create', name: 'Obra nova', color: 'teal' }, target: '' })
    assert.deepEqual(appActArgs('desks.close', { deskId: 'desk-2', seen: 'Casa' }), { args: { act: 'desks.close', panes: 'move', deskId: 'desk-2', seen: 'Casa' }, target: 'desk-2' }, 'the safe answer of the dialog')
    assert.deepEqual(appActArgs('panes.close', { deskId: 'desk-1', seen: 'Obra', paneId: 's_1' }), { args: { act: 'panes.close', process: 'keep', deskId: 'desk-1', seen: 'Obra', paneId: 's_1' }, target: 's_1' })
    assert.deepEqual(appActArgs('panes.move', { deskId: 'desk-1', paneId: 's_1', to: 'desk-2' }), { args: { act: 'panes.move', deskId: 'desk-1', paneId: 's_1', to: 'desk-2' }, target: 's_1' })
    assert.deepEqual(appActArgs('closed.reopen', { slotId: 's_9', deskId: 'desk-1' }), { args: { act: 'closed.reopen', slotId: 's_9', deskId: 'desk-1' }, target: 's_9' })
    assert.deepEqual(appActArgs('owners.give', { deskId: 'desk-1', seen: 'Obra', to: 'a_1' }), { args: { act: 'owners.give', deskId: 'desk-1', seen: 'Obra', to: 'a_1' }, target: 'desk-1' }, 'a desk')
    assert.deepEqual(appActArgs('owners.take', { deskId: 'desk-1', seen: 'Obra', paneId: 's_1' }), { args: { act: 'owners.take', deskId: 'desk-1', seen: 'Obra', paneId: 's_1' }, target: 's_1' }, 'a pane of that desk')
    // The desk's name as the device saw it is folded as a name is (RR5 M-1).
    assert.deepEqual(appActArgs('desks.close', { deskId: 'desk-2', seen: ' Casa\n' }), { args: { act: 'desks.close', panes: 'move', deskId: 'desk-2', seen: 'Casa' }, target: 'desk-2' })
  })

  test('RR5 M-1: the acts that destroy or change who holds a desk or a pane carry the desk\'s name as seen; without it, refused', () => {
    for (const [op, body] of [
      ['desks.close', { deskId: 'd' }], ['panes.close', { deskId: 'd', paneId: 'p' }], ['owners.give', { deskId: 'd', to: 'a' }],
      ['owners.revoke', { deskId: 'd' }], ['owners.take', { deskId: 'd' }], ['owners.return', { deskId: 'd', paneId: 'p' }],
    ] as const) {
      assert.equal(appActArgs(op, body), 'bad-request', op)
      assert.equal(parseAppAct({ act: op, ...body, ...(op === 'desks.close' ? { panes: 'move' } : op === 'panes.close' ? { process: 'keep' } : {}) }), undefined, op)
    }
    assert.equal(parseAppAct({ act: 'desks.hibernate', deskId: 'd', seen: 'x' }), undefined, 'not on the other acts')
    assert.equal(seenName('  Ob‮ra  '), 'Obra')
    assert.equal(seenMatches({ act: 'desks.close', deskId: 'd', seen: 'Obra', panes: 'move' }, ' Obra'), true)
    assert.equal(seenMatches({ act: 'desks.close', deskId: 'd', seen: 'Obra', panes: 'move' }, 'Produção'), false)
    assert.equal(seenMatches({ act: 'desks.close', deskId: 'd', seen: 'Obra', panes: 'move' }, undefined), false)
    assert.equal(seenMatches({ act: 'desks.hibernate', deskId: 'd' }, 'qualquer'), true)
  })

  test('refused before the pipe: a missing id, a position, a title, a colour or a value outside the list, a name too long', () => {
    for (const deskId of [undefined, '', 0, 1, 'desk 1', '../x', 'd'.repeat(65), 'Mesa‮']) assert.equal(appActArgs('desks.hibernate', { deskId }), 'bad-request', String(deskId))
    assert.equal(appActArgs('desks.color', { deskId: 'd', color: '#ff0000' }), 'bad-request')
    assert.equal(appActArgs('desks.close', { deskId: 'd', seen: 'D', panes: 'forget' }), 'bad-request')
    assert.equal(appActArgs('panes.close', { deskId: 'd', seen: 'D', paneId: 'p', process: 'forget' }), 'bad-request')
    assert.equal(appActArgs('panes.move', { deskId: 'd', paneId: 'p' }), 'bad-request', 'where to')
    assert.equal(appActArgs('owners.give', { deskId: 'd', seen: 'D' }), 'bad-request', 'to whom')
    assert.equal(appActArgs('desks.create', { name: 'n'.repeat(DESK_NAME_MAX + 1) }), 'too-long')
    assert.equal(appActArgs('desks.rename', { deskId: 'd', name: '​ \n' }), 'bad-request', 'empty once folded')
    assert.equal(appActArgs('desks.rename', { deskId: 'd', name: 7 }), 'bad-request')
  })

  test('tetherd and the app take only the act as the portal builds it: no other field, no other act, no raw name', () => {
    for (const op of Object.keys(APP_ACT_FIELDS) as AppActOp[]) {
      const rule = APP_ACT_FIELDS[op] as { need: Record<string, unknown>; may?: Record<string, unknown> }
      const body = Object.fromEntries(Object.entries({ ...rule.need, ...(rule.may ?? {}) }).map(([k, f]) => [k, f === 'id' ? 'x_1' : f === 'name' ? 'Mesa' : f === 'color' ? 'red' : f === 'folder' ? '0123456789abcdef' : (f as string[])[0]]))
      const built = appActArgs(op, body)
      assert.ok(typeof built !== 'string', op)
      assert.deepEqual(parseAppAct(built.args), built.args, `${op}: what the portal builds passes`)
      assert.equal(parseAppAct({ ...built.args, by: 'a_1' }), undefined, `${op}: a field outside the rule`)
      assert.equal(parseAppAct({ ...built.args, extra: MARKER }), undefined, op)
      for (const k of Object.keys(rule.need)) {
        const { [k]: _gone, ...without } = built.args as unknown as Record<string, unknown>
        assert.equal(parseAppAct(without), undefined, `${op}: ${k} is required`)
      }
    }
    for (const v of [undefined, null, [], 'desks.hibernate', { act: 'object-set', kind: 'desk', id: 'd', key: 'owner' }, { act: 'tree.publish' }, { act: '__proto__' }, { act: 'constructor', deskId: 'd' }])
      assert.equal(parseAppAct(v), undefined, JSON.stringify(v))
    assert.equal(parseAppAct({ act: 'desks.rename', deskId: 'd', name: ' Obra ' }), undefined, 'a name not in its folded form')
    assert.equal(parseAppAct({ act: 'desks.rename', deskId: 'd', name: 'Obra‮' }), undefined)
    assert.equal(parseAppAct({ act: 'desks.rename', deskId: 'd', name: 'n'.repeat(DESK_NAME_MAX + 1) }), undefined)
  })

  test('every refusal is a status that is no success and a code a body may carry; no-app is 0x08, a stale id 0x06', () => {
    for (const [code, status] of Object.entries(APP_ACT_REFUSALS)) {
      assert.notEqual(status as number, RES_STATUS.ok as number, code)
      assert.ok((ERROR_CODES as readonly string[]).includes(code), code)
    }
    assert.equal(APP_ACT_REFUSALS['no-app'], RES_STATUS.noApp)
    for (const c of ['unknown-desk', 'unknown-pane', 'unknown-slot', 'unknown-agent'] as const) assert.equal(APP_ACT_REFUSALS[c], RES_STATUS.notFound)
    assert.equal(APP_ACT_REFUSALS.busy, RES_STATUS.limit)
  })
})

interface Sent { t: string; ext: string; name: string; args: Record<string, unknown> }

describe('the app acts through a real House', () => {
  let bench: HouseBench
  let s: DeviceSession
  let auth: SoftAuthenticator
  const sent: Sent[] = []
  let answer: (m: Sent) => Promise<Record<string, unknown>> = async () => ({ result: { state: 'done' } })
  const held: (() => void)[] = []
  let hold = false
  const request = (m: Sent): Promise<Record<string, unknown>> => {
    sent.push(m)
    if (!hold) return answer(m)
    return new Promise((res, rej) => { held.push(() => { answer(m).then(res, rej) }) })
  }
  const deviceId = (): string => toHex(bench.device.result!.deviceId)
  const send = (op: number, body: Record<string, unknown>, id: Bytes = actId(), on: DeviceSession = s) => on.request(op, body, { actId: id })

  before(async () => {
    const appActs = pipeWrites((m) => request(m as unknown as Sent), { timeoutMs: 300 })
    bench = await startHouseBench({ origin: ORIGIN, appActs, appActTimeoutMs: 300, limits: { reqPerDevicePerMin: 10_000, gesturesPerDevicePerMin: 10_000, hsPerTicketPerMin: 1_000 } })
    auth = await registerAndUnlock(bench.fresh, bench.device.kD.pub)
    s = bench.fresh
  })
  after(async () => { await bench?.stop() })

  test('each op goes as the one pair regency/act with its act; the answer by the allow list; the audit by target id, never the name', async () => {
    sent.length = 0
    answer = async (m) => ({ result: m.args.act === 'desks.create' ? { state: 'done', deskId: 'desk-9', name: MARKER, layout: MARKER } : { state: 'already', extra: MARKER } })
    const from = bench.audits().length
    const made = await send(OP['desks.create'], { name: `Obra ${MARKER}` })
    assert.deepEqual(made, { status: RES_STATUS.ok, body: { state: 'done', deskId: 'desk-9' } })
    const slept = await send(OP['desks.hibernate'], { deskId: 'desk-2' })
    assert.deepEqual(slept, { status: RES_STATUS.ok, body: { state: 'already' } })
    assert.equal((await send(OP['panes.move'], { deskId: 'desk-1', paneId: 's_1', to: 'desk-2' })).status, RES_STATUS.ok)
    assert.deepEqual(sent.map((m) => [m.t, m.ext, m.name, m.args.act]), [
      ['ext-request', 'regency', 'act', 'desks.create'], ['ext-request', 'regency', 'act', 'desks.hibernate'], ['ext-request', 'regency', 'act', 'panes.move'],
    ])
    assert.deepEqual(sent[2]!.args, { act: 'panes.move', deskId: 'desk-1', paneId: 's_1', to: 'desk-2' })
    const lines = bench.audits().slice(from)
    assert.deepEqual(lines.map((l) => [l.act, l.result, l.target]), [['desks.create', 'ok', undefined], ['desks.hibernate', 'ok', 'desk-2'], ['panes.move', 'ok', 's_1']])
    assert.ok(lines.every((l) => l.deviceId === deviceId()))
    assert.equal(JSON.stringify(lines).includes(MARKER), false, 'never the desk\'s name')
  })

  test('"+ Novo" (RR5 5.3): an agent or a terminal is the pair regency/create, a note or a tab regency/act; answers by id alone', async () => {
    sent.length = 0
    const folder = '0123456789abcdef'
    answer = async (m) => {
      if (m.name === 'create') {
        if (m.args.profile === 'nao-ha') throw new DaemonError('unknown-profile' as never, `recusado ${MARKER}`)
        return { result: { slotId: 's_new', cwd: `C:\\${MARKER}`, env: { K: MARKER } } }
      }
      return { result: { state: 'done', paneId: 'note-3', path: MARKER } }
    }
    const from = bench.audits().length
    assert.deepEqual(await send(OP['create.agent'], { engine: 'claude', deskId: 'desk-1', folder, name: 'revisor' }), { status: RES_STATUS.ok, body: { slotId: 's_new' } })
    assert.deepEqual(await send(OP['create.terminal'], { deskId: 'desk-1', folder }), { status: RES_STATUS.ok, body: { slotId: 's_new' } })
    assert.deepEqual(await send(OP['create.note'], { deskId: 'desk-1', folder }), { status: RES_STATUS.ok, body: { state: 'done', paneId: 'note-3' } })
    assert.deepEqual(await send(OP['create.browser'], { deskId: 'desk-1' }), { status: RES_STATUS.ok, body: { state: 'done', paneId: 'note-3' } })
    assert.deepEqual(await send(OP['create.agent'], { engine: 'claude', profile: 'nao-ha', deskId: 'desk-1', folder }), { status: RES_STATUS.notFound, body: { error: 'unknown-profile' } })
    assert.equal((await send(OP['create.agent'], { engine: 'claude', deskId: 'desk-1', folder: 'C:\\Windows' })).status, RES_STATUS.badRequest, 'never a path')
    assert.deepEqual(sent.map((m) => [m.name, m.args]), [
      ['create', { what: 'agent', engine: 'claude', deskId: 'desk-1', folder, name: 'revisor' }],
      ['create', { what: 'terminal', engine: 'shell', deskId: 'desk-1', folder }],
      ['act', { act: 'create.note', deskId: 'desk-1', folder }],
      ['act', { act: 'create.browser', deskId: 'desk-1' }],
      ['create', { what: 'agent', engine: 'claude', deskId: 'desk-1', folder, profile: 'nao-ha' }],
    ])
    const lines = bench.audits().slice(from)
    assert.deepEqual(lines.map((l) => [l.act, l.result, l.target]), [
      ['create.agent', 'ok', 'desk-1'], ['create.terminal', 'ok', 'desk-1'], ['create.note', 'ok', 'desk-1'], ['create.browser', 'ok', 'desk-1'],
      ['create.agent', 'refused:unknown-profile', 'desk-1'], ['create.agent', 'badRequest', undefined],
    ])
    assert.equal(JSON.stringify(lines).includes('revisor') || JSON.stringify(lines).includes(MARKER), false, 'never the name nor anything of the answer')
  })

  test("tetherd's and the app's refusals come back by their code, never the message: no-app 0x08, a stale id 0x06, busy 0x07", async () => {
    const code = { 'desks.wake': 'no-app', 'desks.rename': 'unknown-desk', 'panes.hibernate': 'with-user', 'panes.suspend': 'busy', 'closed.reopen': 'not-closed', 'desks.color': 'door-denied', 'owners.take': 'stale' } as Record<string, string>
    answer = async (m) => { throw new DaemonError(code[m.args.act as string] as never, `recusado ${MARKER}`) }
    assert.deepEqual(await send(OP['owners.take'], { deskId: 'desk-3', seen: 'Rascunhos' }), { status: RES_STATUS.notFound, body: { error: 'stale' } }, 'RR5 M-1: the desk changed')
    assert.deepEqual(await send(OP['desks.wake'], { deskId: 'desk-2' }), { status: RES_STATUS.noApp, body: { error: 'no-app' } })
    assert.deepEqual(await send(OP['desks.rename'], { deskId: 'nao-ha', name: 'x' }), { status: RES_STATUS.notFound, body: { error: 'unknown-desk' } })
    assert.deepEqual(await send(OP['panes.hibernate'], { deskId: 'desk-1', paneId: 's_1' }), { status: RES_STATUS.failed, body: { error: 'with-user' } })
    assert.deepEqual(await send(OP['panes.suspend'], { deskId: 'desk-1', paneId: 's_1' }), { status: RES_STATUS.limit, body: { error: 'busy' } })
    assert.deepEqual(await send(OP['closed.reopen'], { slotId: 's_9', deskId: 'desk-1' }), { status: RES_STATUS.failed, body: { error: 'not-closed' } })
    assert.deepEqual(await send(OP['desks.color'], { deskId: 'desk-1', color: 'red' }), { status: RES_STATUS.failed, body: { error: 'failed' } }, 'a code outside the list')
    assert.ok(bench.audits().some((l) => l.act === 'desks.wake' && l.result === 'refused:no-app' && l.target === 'desk-2'))
    assert.equal(bench.audits().some((l) => JSON.stringify(l).includes(MARKER)), false)
  })

  test('the deadline answers timeout; the real outcome comes for the same actId and is a late: line after the timeout one', async () => {
    answer = async () => ({ result: { state: 'done' } })
    sent.length = 0
    hold = true
    const id = actId()
    const first = send(OP['desks.hibernate'], { deskId: 'desk-3' }, id)
    await until(() => held.length === 1 || undefined, 2_000, 'held at tetherd')
    const again = send(OP['desks.hibernate'], { deskId: 'desk-3' }, id)
    assert.deepEqual((await first).body, { error: 'timeout' })
    assert.deepEqual((await again).body, { error: 'timeout' }, 'the repeat waits and is not sent again')
    hold = false
    held.shift()!()
    await until(() => bench.audits().some((l) => l.act === 'desks.hibernate' && l.result === 'late:ok' && l.target === 'desk-3') || undefined, 2_000, 'late:ok')
    const mine = bench.audits().filter((l) => l.act === 'desks.hibernate' && l.target === 'desk-3').map((l) => l.result)
    assert.deepEqual(mine.filter((r) => r !== 'replay'), ['timeout', 'late:ok'], 'the late line follows the timeout it corrects')
    assert.deepEqual(await send(OP['desks.hibernate'], { deskId: 'desk-3' }, id), { status: RES_STATUS.ok, body: { state: 'done' } }, 'the real outcome, for the same actId')
    assert.equal(sent.length, 1, 'tetherd saw one act')
  })

  test('what destroys needs a proof of this very act, before the pipe; giving power to an agent needs the window', async () => {
    answer = async () => ({ result: { state: 'done' } })
    sent.length = 0
    for (const [op, body] of [[OP['panes.close'], { deskId: 'desk-1', seen: 'Obra', paneId: 's_1' }], [OP['desks.close'], { deskId: 'desk-2', seen: 'Casa' }], [OP['closed.forget'], { slotId: 's_9' }]] as const) {
      assert.equal((await send(op, body)).status, RES_STATUS.presenceRequired, `${op}: no proof`)
      assert.equal((await act(s, auth, op, body, { proof: false })).status, RES_STATUS.presenceRequired)
    }
    assert.equal((await send(OP['owners.give'], { deskId: 'desk-1', seen: 'Obra', to: 'a_1' })).status, RES_STATUS.presenceRequired, 'no window')
    assert.deepEqual(sent, [], 'nothing reached the pipe')
    assert.deepEqual(await act(s, auth, OP['panes.close'], { deskId: 'desk-1', seen: 'Obra', paneId: 's_1', process: 'stop' }), { status: RES_STATUS.ok, body: { state: 'done' } })
    assert.deepEqual((sent as Sent[]).map((m) => m.args), [{ act: 'panes.close', process: 'stop', deskId: 'desk-1', seen: 'Obra', paneId: 's_1' }], 'the name seen goes inside the proven body')
    assert.equal((await present(s, auth, 'elevate')).status, RES_STATUS.ok)
    assert.equal((await send(OP['owners.give'], { deskId: 'desk-1', seen: 'Obra', paneId: 's_1', to: 'a_1' })).status, RES_STATUS.ok, 'with the window')
    assert.equal((await send(OP['owners.revoke'], { deskId: 'desk-1', seen: 'Obra', paneId: 's_1' })).status, RES_STATUS.ok)
    assert.deepEqual(bench.audits().slice(-4).filter((l) => l.act !== 'uv.assert').map((l) => [l.act, l.result, l.target]), [['panes.close', 'ok', 's_1'], ['owners.give', 'ok', 's_1'], ['owners.revoke', 'ok', 's_1']])
  })

  test('without manage:desks refused before the pipe; a body with a field outside the line is malformed', async () => {
    sent.length = 0
    const d = bench.registry.get(deviceId())!
    const all = [...d.scopes]
    d.scopes = all.filter((x) => x !== 'manage:desks')
    bench.house.upsertDevice(structuredClone(d))
    assert.equal((await send(OP['desks.hibernate'], { deskId: 'desk-1' })).status, RES_STATUS.noScope)
    d.scopes = all
    bench.house.upsertDevice(structuredClone(d))
    assert.equal((await send(OP['desks.hibernate'], { deskId: 'desk-1', position: 2 })).status, RES_STATUS.badRequest)
    assert.equal((await send(OP['desks.hibernate'], { title: 'Obra' })).status, RES_STATUS.badRequest, 'never a title')
    assert.deepEqual(sent, [])
  })

  test('a revocation that begins while an act waits sends nothing (B-4)', async () => {
    sent.length = 0
    const other = await bench.pair('Outro telefone')
    await registerAndUnlock(other.fresh, other.device.kD.pub)
    const pending = other.fresh.request(OP['desks.hibernate'], { deskId: 'desk-1' }, { actId: actId() }).catch(() => undefined)
    await bench.house.revoke(toHex(other.device.result!.deviceId), [])
    await pending
    assert.deepEqual(sent, [], 'tetherd never got it')
  })
})
