// The agent door's seams in tetherd (slice D0): the request registry behind the server's `default`, the SlotPort, the hooks,
// and the inert services. Nothing new is switched on, so a slot reads exactly as before. Test home and test pipe only.
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { DisposableStore } from '../../app/shared/vscode-lifecycle.ts'
import { DaemonClient, DaemonError } from '../../src/daemon/client.ts'
import { DoorHost } from '../../src/daemon/door/host.ts'
import { DoorError, type InputOrigin, type SlotPort } from '../../src/daemon/door/port.ts'
import { DaemonExtensionHost } from '../../src/daemon/ext-host.ts'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { removeHome, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

/** A door that records what the server's hooks tell it. */
class RecordingDoor extends DoorHost {
  readonly states: SlotState[] = []
  readonly inputs: { slotId: string; data: string; origin: InputOrigin }[] = []
  decorated = 0
  override decorate(): void { this.decorated++ }
  override stateChanged(state: SlotState): void { this.states.push(state) }
  override input(slotId: string, data: string, origin: InputOrigin): void { this.inputs.push({ slotId, data, origin }) }
}

describe('agent door seams (D0)', () => {
  let home: string
  let daemon: Daemon
  let client: DaemonClient
  const door = new RecordingDoor({ log: () => {} })

  before(async () => {
    home = tempHome()
    daemon = await startDaemon({ home, pipe: uniquePipe(home), memoryIntervalMs: 0, door })
    client = await DaemonClient.open(daemon.pipe, 'test')
  })
  after(async () => {
    client?.close()
    await daemon?.close()
    await removeHome(home)
  })

  test('an unknown request is still bad-request, with the same message', async () => {
    await assert.rejects(client.request({ t: 'nothing-like-this' } as never), (e: unknown) => {
      assert.ok(e instanceof DaemonError)
      assert.equal(e.code, 'bad-request')
      assert.equal(e.message, 'mensagem desconhecida: nothing-like-this')
      return true
    })
  })

  test('a registered request reaches its handler, with the client kind; a DoorError keeps its code', async () => {
    const seen: { t: string; payload: unknown; client: string | undefined }[] = []
    const reg = door.requests.register('door-probe', (req, ctx) => {
      seen.push({ t: req.t, payload: req.payload, client: ctx.client })
      return { note: 'ok da porta' }
    })
    const fail = door.requests.register('door-fail', () => { throw new DoorError('door-unavailable', 'fora do ar') })
    const r = await client.request({ t: 'door-probe', payload: 42 } as never)
    assert.equal(r.note, 'ok da porta')
    assert.deepEqual(seen, [{ t: 'door-probe', payload: 42, client: 'test' }])
    await assert.rejects(client.request({ t: 'door-fail' } as never), (e: unknown) => e instanceof DaemonError && e.code === 'door-unavailable')
    assert.throws(() => door.requests.register('door-probe', () => ({})), /já tem quem responda/)
    reg.dispose(); fail.dispose()
    await assert.rejects(client.request({ t: 'door-probe' } as never), (e: unknown) => e instanceof DaemonError && e.code === 'bad-request')
    // The core's own types never reach the registry: the switch answers them first.
    const list = door.requests.register('list', () => { throw new Error('never') })
    assert.ok(Array.isArray((await client.request({ t: 'list' })).slots))
    list.dispose()
  })

  test('the SlotState of a slot with nothing new is field for field what it was; the hooks hear it', async () => {
    const before = door.states.length
    const decorated = door.decorated
    const { slot } = await client.request({ t: 'create', kind: 'shell', cwd: home, name: 'plain' })
    assert.ok(slot)
    assert.deepEqual(Object.keys(slot).sort(), ['cwd', 'folder', 'kind', 'name', 'slotId', 'status'])
    assert.deepEqual(slot, { slotId: slot.slotId, kind: 'shell', cwd: slot.cwd, folder: slot.cwd, status: slot.status, name: 'plain' })
    assert.ok(['exited', 'unconfirmed'].includes(slot.status))
    assert.deepEqual(daemon.slots().find((s) => s.slotId === slot.slotId), slot)
    assert.ok(door.decorated > decorated, 'stateOf calls decorate')
    assert.ok(door.states.slice(before).some((s) => s.slotId === slot.slotId), 'broadcastState calls stateChanged')
    // Input through the pipe is the user's.
    client.input(slot.slotId, 'x')
    client.typed(slot.slotId, 'y')
    await waitUntil(() => door.inputs.length >= 2, 5_000, 'input hooks')
    assert.deepEqual(door.inputs.slice(-2), [
      { slotId: slot.slotId, data: 'x', origin: 'user' },
      { slotId: slot.slotId, data: 'y', origin: 'user' },
    ])
    // rename and forget run the same body as before.
    const renamed = await client.request({ t: 'rename-slot', slotId: slot.slotId, name: '' })
    assert.equal(renamed.slot?.name, undefined)
    await client.request({ t: 'forget', slotId: slot.slotId })
    assert.equal(daemon.slots().some((s) => s.slotId === slot.slotId), false)
  })

  test('the SlotPort: create with door meta mirrors it in the state; reads; write refuses a slot with no process', async () => {
    const port = door.port as SlotPort
    assert.ok(door.live)
    const state = await port.create({ kind: 'shell', cwd: home, meta: { createdBy: { ext: 'probe', slotId: 'abc' }, paneRequest: { deskId: 'd1' } } })
    assert.deepEqual(state.createdBy, { ext: 'probe', slotId: 'abc' })
    assert.deepEqual(state.paneRequest, { deskId: 'd1' })
    assert.equal(state.held, undefined)
    assert.equal(port.meta(state.slotId)?.paneRequest?.deskId, 'd1')
    assert.equal(port.isAlive(state.slotId), false)
    const screen = port.readScreen(state.slotId)
    assert.deepEqual(screen, { data: '', cols: screen.cols, rows: screen.rows, start: 0, end: 0, reset: false })
    assert.throws(() => port.write(state.slotId, 'x', 'agent'), (e: unknown) => e instanceof DoorError && e.code === 'door-no-pty')
    assert.throws(() => port.stateOf('nope') ?? port.readScreen('nope'), /slot desconhecido/)
    await port.forget(state.slotId)
    assert.equal(port.stateOf(state.slotId), undefined)
    // The door's meta fields come only through the port: a pipe `create` carrying them gets none.
    const piped = await client.request({ t: 'create', kind: 'shell', cwd: home, meta: { held: { ext: 'x', by: 'y' } } } as never)
    assert.equal(piped.slot?.held, undefined)
    assert.equal(port.meta(piped.slot!.slotId)?.held, undefined)
    await port.forget(piped.slot!.slotId)
  })
})

describe('agent door services while inert (satellites, and tetherd before the slices)', () => {
  test('registering works and goes with the extension; acting rejects door-unavailable; reads answer empty', async () => {
    const own = new DisposableStore()
    const api = new DoorHost({ log: () => {} }).apiFor('probe', own)
    const regs = [api.slots.onState(() => {}), api.verbs.register({ ns: 'p', name: 'x', description: '', help: '', input: {}, run: () => ({ text: '' }) }), api.delivery.enable(), api.objects.onDidDrop(() => {})]
    assert.equal(regs.length, 4)
    const unavailable = (e: unknown): boolean => e instanceof DoorError && e.code === 'door-unavailable'
    await assert.rejects(api.slots.create({ kind: 'shell', cwd: '.' }), unavailable)
    await assert.rejects(api.slots.write('s', 'x'), unavailable)
    await assert.rejects(api.delivery.deliver('s', { kind: 'message', from: { name: 'a', id: 'a', role: 'member' }, body: 'oi' }), unavailable)
    await assert.rejects(api.attention.route('a', 'b'), unavailable)
    await assert.rejects(api.objects.set('pane', 's', 'k', 1), unavailable)
    await assert.rejects(api.desks.requestPane('s', 'd'), unavailable)
    assert.throws(() => api.slots.readScreen('s'), unavailable)
    assert.deepEqual(api.slots.list(), [])
    assert.equal(api.desks.map(), undefined)
    assert.equal(api.delivery.pathOf('s'), 'wait')
    own.dispose()
  })

  test('the extension host hands every extension the door services (an inert door by default)', () => {
    let got: Record<string, unknown> | undefined
    const host = new DaemonExtensionHost({
      home: '.', log: () => {}, agents: undefined,
      extensions: [{ manifest: { id: 'probe' } as never, activate: (api) => { got = api as unknown as Record<string, unknown>; return [] } }],
    })
    host.activate()
    assert.ok(got)
    for (const k of ['slots', 'desks', 'verbs', 'delivery', 'attention', 'objects']) assert.ok(got[k], k)
    assert.equal(host.door.live, false)
    host.dispose()
  })
})
