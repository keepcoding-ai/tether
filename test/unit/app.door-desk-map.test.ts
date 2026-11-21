// The desk map the app sends the daemon: what a layout makes of it, and when it goes again.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { DeskMapSender, deskMapOf, mapSignature, shouldSendMap } from '../../app/renderer/door/desk-map.ts'
import { emptyLayout, type DeskLayout, type Layout } from '../../app/renderer/layout.ts'
import type { DeskMap } from '../../src/daemon/protocol.ts'

const typeOf = (component: string): string => (component === 'terminal' ? 'terminal' : component === 'note-pane' ? 'note' : component)

/** A desk whose frames hold `frames` (frame id -> pane id -> component). */
function desk(id: string, name: string, frames: Record<string, Record<string, string>>, asleep = false): DeskLayout {
  const views: Record<string, unknown> = {}
  for (const [frame, panes] of Object.entries(frames)) {
    views[frame] = { grid: {}, panels: Object.fromEntries(Object.entries(panes).map(([pid, contentComponent]) => [pid, { id: pid, contentComponent }])), activeGroup: 'g' }
  }
  return { id, name, color: 'blue', ...(asleep ? { asleep: true } : {}), frames: { grid: {}, views } } as unknown as DeskLayout
}

function layoutOf(desks: DeskLayout[], extra: Partial<Layout> = {}): Layout {
  return { ...emptyLayout(), desks, activeDesk: desks[0]!.id, ...extra }
}

describe('deskMapOf', () => {
  test('lists every pane of every desk, by type, in a stable order', () => {
    const layout = layoutOf([
      desk('d1', 'Mesa 1', { f1: { b: 'terminal', a: 'note-pane' }, f2: { c: 'terminal' } }),
      desk('d2', 'Mesa 2', {}),
    ])
    const map = deskMapOf(layout, typeOf)
    assert.deepEqual(map.desks.map(d => [d.id, d.name, d.kind]), [['d1', 'Mesa 1', 'queue'], ['d2', 'Mesa 2', 'queue']])
    assert.deepEqual(map.desks[0]!.panes, [{ id: 'a', type: 'note' }, { id: 'b', type: 'terminal' }, { id: 'c', type: 'terminal' }])
    assert.deepEqual(map.desks[1]!.panes, [])
    assert.deepEqual(map.drawer, [])
  })

  test('a hibernated desk says so; an awake one carries no flag', () => {
    const map = deskMapOf(layoutOf([desk('d1', 'A', {}, true), desk('d2', 'B', {})]), typeOf)
    assert.equal(map.desks[0]!.asleep, true)
    assert.equal('asleep' in map.desks[1]!, false)
  })

  test('system desks come after the queue, named by the caller or by their id; the drawer is apart', () => {
    const sys = desk('x', 'ignored', { f: { s1: 'terminal' } })
    const layout = layoutOf([desk('d1', 'A', {})], {
      systemDesks: { 'ext.agents': { frames: sys.frames } },
      drawer: { frames: desk('dr', 'dr', { f: { g1: 'terminal' } }).frames },
    })
    const named = deskMapOf(layout, typeOf, id => (id === 'ext.agents' ? 'Agentes' : undefined))
    assert.deepEqual(named.desks.map(d => [d.id, d.name, d.kind]), [['d1', 'A', 'queue'], ['ext.agents', 'Agentes', 'system']])
    assert.deepEqual(named.desks[1]!.panes, [{ id: 's1', type: 'terminal' }])
    assert.deepEqual(named.drawer, [{ id: 'g1', type: 'terminal' }])
    assert.equal(deskMapOf(layout, typeOf).desks[1]!.name, 'ext.agents')
  })

  test('a desk with no name falls back to its id; a panel with no component is a terminal', () => {
    const d = desk('d9', '', { f: { p: 'terminal' } })
    ;(d.frames.views.f as unknown as { panels: Record<string, unknown> }).panels.p = { id: 'p' }
    const map = deskMapOf(layoutOf([d]), typeOf)
    assert.equal(map.desks[0]!.name, 'd9')
    assert.deepEqual(map.desks[0]!.panes, [{ id: 'p', type: 'terminal' }])
  })
})

describe('when the map goes', () => {
  const a: DeskMap = { desks: [{ id: 'd1', name: 'A', kind: 'queue', panes: [{ id: 's1', type: 'terminal' }] }], drawer: [] }
  const b: DeskMap = { ...a, desks: [{ ...a.desks[0]!, panes: [] }] }

  test('the first map goes; the same one again does not; a changed one does', () => {
    assert.equal(shouldSendMap(undefined, a), true)
    assert.equal(shouldSendMap(mapSignature(a), structuredClone(a)), false)
    assert.equal(shouldSendMap(mapSignature(a), b), true)
  })

  test('force sends the same map again', () => {
    assert.equal(shouldSendMap(mapSignature(a), a, true), true)
  })

  test('the sender sends on change, stays quiet on a repeat, and sends again after a reconnection', () => {
    const sent: DeskMap[] = []
    const sender = new DeskMapSender(m => sent.push(m))
    assert.equal(sender.offer(a), true)
    assert.equal(sender.offer(a), false)
    assert.equal(sender.offer(b), true)
    sender.reconnected()
    assert.equal(sender.offer(b), true)
    assert.equal(sender.offer(b, true), true)
    assert.equal(sent.length, 4)
  })
})
