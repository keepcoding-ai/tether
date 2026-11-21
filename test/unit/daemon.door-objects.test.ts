// The agent door's per-object data (slice D3) in a real tetherd on a test home and test pipe: set/get/entries per extension
// (isolated), kept in <home>/objects/<ext>.json and read back after a restart, a forgotten slot drops its pane data and tells
// onDidDrop, a desk-map without a desk (or a non-slot pane) drops its data, and `object-set` through the pipe emits `object`.
// The real user's home, pipe and tetherd are never touched.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'
import { DisposableStore } from '../../app/shared/vscode-lifecycle.ts'
import { DaemonError } from '../../src/daemon/client.ts'
import { DoorHost } from '../../src/daemon/door/host.ts'
import { objectsPath } from '../../src/daemon/door/objects.ts'
import type { SlotPort } from '../../src/daemon/door/port.ts'
import type { DeskMap, ObjectKind } from '../../src/daemon/protocol.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { Recorder, removeHome, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

const mapOf = (desks: string[], panes: Record<string, string[]> = {}): DeskMap => ({
  desks: desks.map((id) => ({ id, name: id, kind: 'queue' as const, panes: (panes[id] ?? []).map((p) => ({ id: p, type: p.startsWith('note:') ? 'note' : 'terminal' })) })),
  drawer: [],
})

describe('agent door objects (D3)', () => {
  let home: string
  let pipe: string
  let daemon: Daemon
  let door: DoorHost
  let rec: Recorder
  const logs: string[] = []
  const own = new DisposableStore()

  const boot = async (): Promise<void> => {
    door = new DoorHost({ log: (m) => logs.push(m) })
    daemon = await startDaemon({ home, pipe, memoryIntervalMs: 0, door, log: (m) => logs.push(m) })
    rec = await Recorder.connect(daemon.pipe)
    await door.objects.ready
  }
  const port = (): SlotPort => door.port as SlotPort

  before(async () => {
    home = tempHome()
    pipe = uniquePipe(home)
    await boot()
  })
  after(async () => {
    own.dispose()
    rec?.close()
    await daemon?.close()
    await removeHome(home)
  })

  test('set, get and entries per extension; an extension never sees the other one', async () => {
    const a = door.apiFor('ext-a', own).objects
    const b = door.apiFor('ext-b', own).objects
    await a.set('desk', 'd1', 'color', { hue: 200 })
    await a.set('pane', 'p1', 'color', 'red')
    await a.set('pane', 'p2', 'color', 'blue')
    await a.set('pane', 'p2', 'other', 1)
    await b.set('pane', 'p1', 'color', 'green')
    assert.deepEqual(a.get('desk', 'd1', 'color'), { hue: 200 })
    assert.equal(a.get('pane', 'p1', 'color'), 'red')
    assert.equal(b.get('pane', 'p1', 'color'), 'green')
    assert.equal(b.get('desk', 'd1', 'color'), undefined)
    assert.deepEqual(a.entries<string>('pane', 'color').sort(), [['p1', 'red'], ['p2', 'blue']])
    assert.deepEqual(a.entries('pane', 'other'), [['p2', 1]])
    assert.deepEqual(b.entries('pane', 'color'), [['p1', 'green']])
    // `undefined` deletes the key.
    await a.set('pane', 'p2', 'other', undefined)
    assert.deepEqual(a.entries('pane', 'other'), [])
    // A value that is not JSON is refused.
    await assert.rejects(a.set('pane', 'p1', 'bad', () => 1), /JSON/)
  })

  test('the data is on disk per extension and survives a daemon restart', async () => {
    await door.objects.flush()
    const onDisk = JSON.parse(readFileSync(objectsPath(home, 'ext-a'), 'utf8')) as { pane: Record<string, Record<string, unknown>> }
    assert.deepEqual(onDisk.pane.p1, { color: 'red' })
    assert.equal(JSON.parse(readFileSync(objectsPath(home, 'ext-b'), 'utf8')).pane.p1.color, 'green')

    rec.close()
    await daemon.close()
    await boot()
    const a = door.apiFor('ext-a', own).objects
    assert.deepEqual(a.get('desk', 'd1', 'color'), { hue: 200 })
    assert.equal(a.get('pane', 'p1', 'color'), 'red')
    assert.equal(door.apiFor('ext-b', own).objects.get('pane', 'p1', 'color'), 'green')
    assert.equal(door.apiFor('ext-c', own).objects.get('pane', 'p1', 'color'), undefined)
  })

  test('forget of a slot drops its pane data in every extension and tells onDidDrop', async () => {
    const state = await port().create({ kind: 'shell', cwd: home, start: false })
    const a = door.apiFor('ext-a', own).objects
    const b = door.apiFor('ext-b', own).objects
    await a.set('pane', state.slotId, 'owner', 'agent-x')
    await a.set('pane', state.slotId, 'tag', 7)
    await b.set('pane', state.slotId, 'mine', true)
    const dropsA: { kind: ObjectKind; id: string; data: Record<string, unknown> }[] = []
    const dropsB: typeof dropsA = []
    a.onDidDrop((e) => dropsA.push(e))
    b.onDidDrop((e) => dropsB.push(e))
    const removed: { key: string; value?: unknown }[] = []
    rec.client.on('object', (e) => { if (e.objectId === state.slotId && e.ext === 'ext-a') removed.push({ key: e.key, value: e.value }) })

    await port().forget(state.slotId)
    assert.equal(a.get('pane', state.slotId, 'owner'), undefined)
    assert.deepEqual(a.entries('pane', 'tag'), [])
    assert.deepEqual(dropsA, [{ kind: 'pane', id: state.slotId, data: { owner: 'agent-x', tag: 7 } }])
    assert.deepEqual(dropsB, [{ kind: 'pane', id: state.slotId, data: { mine: true } }])
    await waitUntil(() => removed.length === 2, 5000, 'object events of the drop')
    assert.ok(removed.every((r) => r.value === undefined))
    await door.objects.flush()
    const onDisk = JSON.parse(readFileSync(objectsPath(home, 'ext-a'), 'utf8')) as { pane: Record<string, unknown> }
    assert.equal(state.slotId in onDisk.pane, false)
  })

  test('a desk-map without the desk drops its data; a non-slot pane too; a slot pane stays', async () => {
    const a = door.apiFor('ext-a', own).objects
    const slot = await port().create({ kind: 'shell', cwd: home, start: false })
    await a.set('desk', 'gone', 'k', 1)
    await a.set('desk', 'kept', 'k', 2)
    await a.set('pane', 'note:gone', 'k', 3)
    await a.set('pane', 'note:kept', 'k', 4)
    await a.set('pane', slot.slotId, 'k', 5)
    const drops: { kind: ObjectKind; id: string; data: Record<string, unknown> }[] = []
    a.onDidDrop((e) => drops.push(e))

    await rec.client.request({ t: 'desk-map', map: mapOf(['kept', 'd1'], { kept: ['note:kept', 'p1', 'p2'] }) })
    await waitUntil(() => drops.length === 2, 5000, 'drops by desk-map')
    assert.deepEqual(drops.map((d) => `${d.kind}:${d.id}`).sort(), ['desk:gone', 'pane:note:gone'])
    assert.equal(a.get('desk', 'gone', 'k'), undefined)
    assert.equal(a.get('desk', 'kept', 'k'), 2)
    assert.equal(a.get('pane', 'note:gone', 'k'), undefined)
    assert.equal(a.get('pane', 'note:kept', 'k'), 4)
    assert.equal(a.get('pane', slot.slotId, 'k'), 5)
    await port().forget(slot.slotId)
  })

  test('object-set through the pipe emits object (and changes the data); object-get answers the extension', async () => {
    const a = door.apiFor('ext-a', own).objects
    const seen: unknown[] = []
    a.onDidChange((e) => seen.push(e))
    const events: { ext: string; kind: ObjectKind; objectId: string; key: string; value?: unknown }[] = []
    rec.client.on('object', (e) => events.push(e))

    await rec.client.request({ t: 'object-set', ext: 'ext-a', kind: 'desk', objectId: 'kept', key: 'label', value: { n: 1 } })
    await waitUntil(() => events.length === 1, 5000, 'object event')
    assert.deepEqual(events[0], { ext: 'ext-a', kind: 'desk', objectId: 'kept', key: 'label', value: { n: 1 } })
    assert.deepEqual(seen, [{ kind: 'desk', id: 'kept', key: 'label', value: { n: 1 } }])
    assert.deepEqual(a.get('desk', 'kept', 'label'), { n: 1 })

    const reply = await rec.client.request({ t: 'object-get', ext: 'ext-a' })
    assert.deepEqual(reply.objects?.desk.kept, { k: 2, label: { n: 1 } })
    assert.deepEqual(reply.objects?.pane['note:kept'], { k: 4 })
    assert.deepEqual((await rec.client.request({ t: 'object-get', ext: 'nobody' })).objects, { desk: {}, pane: {} })

    // Without a value the key is deleted, and the event carries no value.
    await rec.client.request({ t: 'object-set', ext: 'ext-a', kind: 'desk', objectId: 'kept', key: 'label' })
    await waitUntil(() => events.length === 2, 5000, 'delete event')
    assert.equal('value' in events[1]!, false)
    assert.equal(a.get('desk', 'kept', 'label'), undefined)

    await assert.rejects(rec.client.request({ t: 'object-set', ext: 'ext-a', kind: 'tab', objectId: 'x', key: 'k', value: 1 } as never), (e: unknown) => e instanceof DaemonError && e.code === 'bad-request')
  })
})
