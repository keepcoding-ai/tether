// The extensions' object data as the app mirrors it (agent door, slice R6): the mirror follows the daemon's `object` event (an
// event without `value` is a removal and an object left empty is gone), a `set` goes to the daemon and comes back, and a new
// connection reads everything again. The daemon is a fake that answers `object-get` / `object-set` like tetherd does.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { DoorHost } from '../../app/renderer/door/host.ts'
import { ObjectMirrors, sameValue, type ObjectEventBody } from '../../app/renderer/door/objects.ts'
import type { ExtObjectChange, RequestBody } from '../../app/shared/api.ts'
import type { Reply } from '../../src/daemon/protocol.ts'

type Space = { desk: Record<string, Record<string, unknown>>; pane: Record<string, Record<string, unknown>> }

/** A daemon with one store: the answer to `object-get` and what `object-set` did (also pushing the event, as tetherd does). */
function fakeDaemon() {
  const store: Record<string, Space> = {}
  const sent: RequestBody[] = []
  let mirrors: ObjectMirrors | undefined
  let down = false
  const ask = async (body: RequestBody): Promise<Reply> => {
    sent.push(body)
    if (down) return { t: 'error', id: -1, code: 'bad-request', message: 'sem conexão com o tetherd' }
    if (body.t === 'object-get') return { t: 'ok', id: 1, objects: structuredClone(store[body.ext] ?? { desk: {}, pane: {} }) }
    if (body.t === 'object-set') {
      const space = (store[body.ext] ??= { desk: {}, pane: {} })[body.kind]
      const keys = (space[body.objectId] ??= {})
      if (body.value === undefined) { delete keys[body.key]; if (Object.keys(keys).length === 0) delete space[body.objectId] } else keys[body.key] = body.value
      const e: ObjectEventBody = { ext: body.ext, kind: body.kind, objectId: body.objectId, key: body.key, ...(body.value === undefined ? {} : { value: body.value }) }
      queueMicrotask(() => mirrors?.apply(e))
      return { t: 'ok', id: 1 }
    }
    return { t: 'error', id: -1, code: 'bad-request', message: 'x' }
  }
  return { store, sent, ask, attach: (m: ObjectMirrors) => { mirrors = m }, setDown: (v: boolean) => { down = v } }
}
const settle = (): Promise<void> => new Promise(r => setTimeout(r, 5))

describe('object mirror (R6)', () => {
  test('loads what the daemon has, and answers get / entries', async () => {
    const d = fakeDaemon()
    d.store.kai = { desk: { 'desk-1': { owner: 'claude-1' } }, pane: { 'claude-2': { owner: 'claude-1', n: 3 }, 'note:a': { n: 4 } } }
    const m = new ObjectMirrors(d.ask)
    d.attach(m)
    const o = m.apiFor('kai')
    await settle()
    assert.equal(o.get('desk', 'desk-1', 'owner'), 'claude-1')
    assert.equal(o.get('pane', 'claude-2', 'n'), 3)
    assert.equal(o.get('pane', 'claude-2', 'nope'), undefined)
    assert.deepEqual(o.entries<number>('pane', 'n').sort(), [['claude-2', 3], ['note:a', 4]])
    assert.deepEqual(o.entries('desk', 'n'), [])
  })

  test('each extension sees only its own space', async () => {
    const d = fakeDaemon()
    d.store.a = { desk: {}, pane: { p: { k: 1 } } }
    d.store.b = { desk: {}, pane: { p: { k: 2 } } }
    const m = new ObjectMirrors(d.ask)
    const a = m.apiFor('a')
    const b = m.apiFor('b')
    await settle()
    assert.equal(a.get('pane', 'p', 'k'), 1)
    assert.equal(b.get('pane', 'p', 'k'), 2)
    m.apply({ ext: 'a', kind: 'pane', objectId: 'p', key: 'k', value: 9 })
    assert.equal(a.get('pane', 'p', 'k'), 9)
    assert.equal(b.get('pane', 'p', 'k'), 2)
    m.apply({ ext: 'never-asked', kind: 'pane', objectId: 'p', key: 'k', value: 1 }) // dropped, no throw
  })

  test('an event follows: value sets, no value removes, and an object left empty is gone', async () => {
    const d = fakeDaemon()
    const m = new ObjectMirrors(d.ask)
    const o = m.apiFor('kai')
    await settle()
    const heard: ExtObjectChange[] = []
    o.onDidChange(e => heard.push(e))
    m.apply({ ext: 'kai', kind: 'pane', objectId: 'p1', key: 'a', value: { x: 1 } })
    m.apply({ ext: 'kai', kind: 'pane', objectId: 'p1', key: 'b', value: 2 })
    assert.deepEqual(o.get('pane', 'p1', 'a'), { x: 1 })
    m.apply({ ext: 'kai', kind: 'pane', objectId: 'p1', key: 'a' })
    assert.equal(o.get('pane', 'p1', 'a'), undefined)
    assert.deepEqual(o.entries('pane', 'b'), [['p1', 2]], 'the object lives while it has a key')
    m.apply({ ext: 'kai', kind: 'pane', objectId: 'p1', key: 'b' })
    assert.deepEqual(o.entries('pane', 'b'), [], 'the empty object is gone')
    assert.deepEqual(heard.map(e => [e.key, e.value]), [['a', { x: 1 }], ['b', 2], ['a', undefined], ['b', undefined]])
    // A removal of what is not there and a repeated value tell no one.
    const n = heard.length
    m.apply({ ext: 'kai', kind: 'pane', objectId: 'p1', key: 'b' })
    m.apply({ ext: 'kai', kind: 'desk', objectId: 'd', key: 'k', value: [1, { y: 2 }] })
    m.apply({ ext: 'kai', kind: 'desk', objectId: 'd', key: 'k', value: [1, { y: 2 }] })
    assert.equal(heard.length, n + 1)
  })

  test('set goes to the daemon and the value is there when it resolves, with one change heard', async () => {
    const d = fakeDaemon()
    const m = new ObjectMirrors(d.ask)
    d.attach(m)
    const o = m.apiFor('kai')
    await settle()
    const heard: ExtObjectChange[] = []
    o.onDidChange(e => heard.push(e))
    await o.set('desk', 'desk-2', 'owner', 'claude-1')
    assert.deepEqual(d.store.kai!.desk, { 'desk-2': { owner: 'claude-1' } }, 'the daemon stored it')
    assert.deepEqual(d.sent.at(-1), { t: 'object-set', ext: 'kai', kind: 'desk', objectId: 'desk-2', key: 'owner', value: 'claude-1' })
    assert.equal(o.get('desk', 'desk-2', 'owner'), 'claude-1')
    await settle() // the event comes back: the same value, nothing new
    assert.equal(heard.length, 1)
    await o.set('desk', 'desk-2', 'owner', undefined)
    assert.deepEqual(d.sent.at(-1), { t: 'object-set', ext: 'kai', kind: 'desk', objectId: 'desk-2', key: 'owner' }, 'no value: a deletion')
    assert.equal(o.get('desk', 'desk-2', 'owner'), undefined)
    assert.deepEqual(d.store.kai!.desk, {})
  })

  test('a write the daemon refuses rejects and changes nothing', async () => {
    const d = fakeDaemon()
    const m = new ObjectMirrors(d.ask)
    const o = m.apiFor('kai')
    await settle()
    d.setDown(true)
    await assert.rejects(o.set('pane', 'p', 'k', 1), /sem conexão/)
    assert.equal(o.get('pane', 'p', 'k'), undefined)
  })

  test('what a caller hands in or reads out is a copy', async () => {
    const d = fakeDaemon()
    const m = new ObjectMirrors(d.ask)
    d.attach(m)
    const o = m.apiFor('kai')
    await settle()
    const v = { list: [1] }
    await o.set('pane', 'p', 'k', v)
    v.list.push(2)
    o.get<{ list: number[] }>('pane', 'p', 'k')!.list.push(3)
    assert.deepEqual(o.get('pane', 'p', 'k'), { list: [1] })
  })

  test('a new connection reads again: differences are heard, an event that raced the read is kept', async () => {
    const d = fakeDaemon()
    d.store.kai = { desk: {}, pane: { p: { a: 1, gone: true } } }
    const m = new ObjectMirrors(d.ask)
    const o = m.apiFor('kai')
    await settle()
    const heard: ExtObjectChange[] = []
    o.onDidChange(e => heard.push(e))
    d.store.kai = { desk: { x: { k: 'new' } }, pane: { p: { a: 1 } } }
    const reload = m.reload()
    m.apply({ ext: 'kai', kind: 'pane', objectId: 'q', key: 'k', value: 'raced' }) // arrives while the snapshot is in flight
    await reload
    assert.equal(o.get('pane', 'p', 'gone'), undefined)
    assert.equal(o.get('desk', 'x', 'k'), 'new')
    assert.equal(o.get('pane', 'q', 'k'), 'raced')
    assert.deepEqual(heard.map(e => `${e.kind}/${e.id}/${e.key}`).sort(), ['desk/x/k', 'pane/p/gone', 'pane/q/k'])
  })

  test('without a connection the first read fails quietly and the next connection fills it', async () => {
    const d = fakeDaemon()
    d.store.kai = { desk: {}, pane: { p: { a: 1 } } }
    d.setDown(true)
    const m = new ObjectMirrors(d.ask)
    const o = m.apiFor('kai')
    await settle()
    assert.deepEqual(o.entries('pane', 'a'), [])
    d.setDown(false)
    await m.reload()
    assert.deepEqual(o.entries('pane', 'a'), [['p', 1]])
  })

  test('the door host serves it: objectsFor, objectEvent and a reload on the slot list', async () => {
    const d = fakeDaemon()
    d.store.kai = { desk: {}, pane: { p: { a: 1 } } }
    const door = new DoorHost(undefined, d.ask)
    const o = door.objectsFor('kai')
    await settle()
    assert.equal(o.get('pane', 'p', 'a'), 1)
    assert.equal(door.objectsFor('kai'), o, 'the same mirror on each call')
    door.objectEvent({ ext: 'kai', kind: 'pane', objectId: 'p', key: 'a', value: 2 })
    assert.equal(o.get('pane', 'p', 'a'), 2)
    d.store.kai = { desk: {}, pane: { p: { a: 5 } } }
    door.slotsListed([])
    await settle()
    assert.equal(o.get('pane', 'p', 'a'), 5)
  })

  test('sameValue compares JSON structurally', () => {
    assert.ok(sameValue({ a: [1, { b: 2 }], c: null }, { c: null, a: [1, { b: 2 }] }))
    assert.ok(!sameValue({ a: 1 }, { a: 1, b: undefined }))
    assert.ok(!sameValue([1], { 0: 1 }))
    assert.ok(!sameValue(1, '1'))
  })
})
