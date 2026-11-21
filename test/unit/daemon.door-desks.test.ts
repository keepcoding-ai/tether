// The agent door's desk map (slice D2) in a real tetherd on a test home and test pipe: `desk-map` is kept in <home>/desks.json and
// read back after a restart; a slot asked into a desk keeps `paneRequest` until a map shows it; a hibernated desk starts the
// process at once (only the pane sleeps); an unknown desk is refused once a map is known. The real user's home, pipe and tetherd
// are never touched.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'
import { DisposableStore } from '../../app/shared/vscode-lifecycle.ts'
import { DaemonError } from '../../src/daemon/client.ts'
import { desksPath } from '../../src/daemon/door/desks.ts'
import { DoorHost } from '../../src/daemon/door/host.ts'
import { DoorError, type SlotPort } from '../../src/daemon/door/port.ts'
import type { DeskMap } from '../../src/daemon/protocol.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { Recorder, removeHome, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

const mapOf = (shown: Record<string, string[]> = {}, asleep: string[] = []): DeskMap => ({
  desks: [
    { id: 'd1', name: 'Mesa 1', kind: 'queue', panes: (shown.d1 ?? []).map((id) => ({ id, type: 'terminal' })) },
    { id: 'd2', name: 'Mesa 2', kind: 'queue', ...(asleep.includes('d2') ? { asleep: true as const } : {}), panes: (shown.d2 ?? []).map((id) => ({ id, type: 'terminal' })) },
    { id: 'sys', name: 'Sistema', kind: 'system', panes: [{ id: 'n1', type: 'note' }] },
  ],
  drawer: [],
})

describe('agent door desks (D2)', () => {
  let home: string
  let pipe: string
  let daemon: Daemon
  let door: DoorHost
  let rec: Recorder
  const logs: string[] = []

  const boot = async (): Promise<void> => {
    door = new DoorHost({ log: (m) => logs.push(m) })
    daemon = await startDaemon({ home, pipe, memoryIntervalMs: 0, door, log: (m) => logs.push(m) })
    rec = await Recorder.connect(daemon.pipe)
  }
  const port = (): SlotPort => door.port as SlotPort
  /** A shell slot born the way the slots service will: `paneRequest` from the desk service, written before the reply. */
  const born = (deskId: string, start = false) =>
    port().create({ kind: 'shell', cwd: home, start, meta: { paneRequest: door.desks.paneRequestFor(deskId) } })

  before(async () => {
    home = tempHome()
    pipe = uniquePipe(home)
    await boot()
  })
  after(async () => {
    rec?.close()
    await daemon?.close()
    await removeHome(home)
  })

  test('before any map: no map, a desk request is kept as asked, the pipe validates the map', async () => {
    assert.equal(door.desks.map(), undefined)
    assert.deepEqual(door.desks.paneRequestFor('qualquer'), { deskId: 'qualquer' })
    await assert.rejects(rec.client.request({ t: 'desk-map', map: { desks: 'x' } } as never), (e: unknown) => e instanceof DaemonError && e.code === 'bad-request')
  })

  test('a map is stored, announced, answered by the api, and read back from desks.json after a restart', async () => {
    const own = new DisposableStore()
    const seen: DeskMap[] = []
    const api = door.apiFor('probe', own)
    api.desks.onDidChange((m) => seen.push(m))
    const events: DeskMap[] = []
    rec.client.on('desks', (m) => events.push(m))
    const map = mapOf({ d1: ['slot-a'] }, ['d2'])
    await rec.client.request({ t: 'desk-map', map })
    await waitUntil(() => events.length === 1, 5000, 'desks event')
    assert.deepEqual(events[0], map)
    assert.deepEqual(seen, [map])
    assert.deepEqual(api.desks.map(), map)
    assert.equal(api.desks.deskOf('slot-a')?.id, 'd1')
    assert.equal(api.desks.deskOf('n1')?.id, 'sys')
    assert.equal(api.desks.deskOf('nada'), undefined)
    // The same map again is no change: no event, no listener call.
    await rec.client.request({ t: 'desk-map', map })
    assert.equal(events.length, 1)
    await door.desks.flush()
    assert.deepEqual(JSON.parse(readFileSync(desksPath(home), 'utf8')), map)
    own.dispose()

    rec.close()
    await daemon.close()
    await boot()
    await door.desks.ready
    assert.deepEqual(door.desks.map(), map)
    assert.equal(door.desks.deskOf('slot-a')?.id, 'd1')
  })

  test('create with a desk writes paneRequest before the reply; a map that shows the slot clears it and emits state', async () => {
    const state = await born('d1')
    assert.deepEqual(state.paneRequest, { deskId: 'd1' })
    assert.deepEqual(port().meta(state.slotId)?.paneRequest, { deskId: 'd1' })
    rec.states.length = 0
    await rec.client.request({ t: 'desk-map', map: mapOf({ d1: [state.slotId] }) })
    const cleared = await rec.state(state.slotId, (s) => s.paneRequest === undefined)
    assert.equal(cleared.paneRequest, undefined)
    assert.equal(port().meta(state.slotId)?.paneRequest, undefined)
    await port().forget(state.slotId)
  })

  test('a slot shown in another desk loses the request without moving; requestPane asks an existing slot', async () => {
    const state = await born('d1')
    await rec.client.request({ t: 'desk-map', map: mapOf({ d2: [state.slotId] }) })
    await rec.state(state.slotId, (s) => s.paneRequest === undefined)
    // Already shown: requestPane leaves it where it is.
    await door.desks.requestPane(state.slotId, 'd1')
    assert.equal(port().meta(state.slotId)?.paneRequest, undefined)
    await port().forget(state.slotId)

    const free = await port().create({ kind: 'shell', cwd: home, start: false })
    await door.desks.requestPane(free.slotId, 'd2')
    assert.deepEqual(port().stateOf(free.slotId)?.paneRequest, { deskId: 'd2' })
    await assert.rejects(door.desks.requestPane('nope', 'd2'), (e: unknown) => e instanceof DoorError && e.code === 'unknown-slot')
    await assert.rejects(door.desks.requestPane(free.slotId, 'fantasma'), (e: unknown) => e instanceof DoorError && e.code === 'bad-request')
    await port().forget(free.slotId)
  })

  test('an unknown desk is refused while a map is known', () => {
    assert.throws(() => door.desks.paneRequestFor('fantasma'), (e: unknown) => e instanceof DoorError && e.code === 'bad-request')
  })

  test('hibernated desk (B3): the process starts now, the request stays {deskId} only, the map clears it', async () => {
    await rec.client.request({ t: 'desk-map', map: mapOf({}, ['d2']) })
    assert.equal(door.desks.map()?.desks.find((d) => d.id === 'd2')?.asleep, true)
    const state = await born('d2', true)
    assert.deepEqual(state.paneRequest, { deskId: 'd2' })
    await waitUntil(() => port().isAlive(state.slotId), 15_000, 'process of the slot in the hibernated desk')
    assert.deepEqual(port().stateOf(state.slotId)?.paneRequest, { deskId: 'd2' })
    await rec.client.request({ t: 'desk-map', map: mapOf({ d2: [state.slotId] }, ['d2']) })
    await rec.state(state.slotId, (s) => s.paneRequest === undefined)
    assert.equal(port().isAlive(state.slotId), true)
    await port().forget(state.slotId)
  })

  test('a request for a desk the new map no longer has is dropped with a log line; the slot stays', async () => {
    const state = await born('d2')
    const without: DeskMap = { desks: mapOf().desks.filter((d) => d.id !== 'd2'), drawer: [] }
    await rec.client.request({ t: 'desk-map', map: without })
    await rec.state(state.slotId, (s) => s.paneRequest === undefined)
    assert.ok(logs.some((l) => l.includes('a mesa d2 não existe')))
    assert.ok(port().stateOf(state.slotId))
    await port().forget(state.slotId)
  })

  test('inert (satellite): reads empty, requestPane rejects door-unavailable', async () => {
    const api = new DoorHost({ log: () => {} }).apiFor('probe', new DisposableStore())
    assert.equal(api.desks.map(), undefined)
    await assert.rejects(api.desks.requestPane('s', 'd1'), (e: unknown) => e instanceof DoorError && e.code === 'door-unavailable')
  })
})
