// The tree of desks and panes an extension reads (app/renderer/desk-tree-rules.ts) and the way the door announces a change of it.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { deskTreeOf, treePaneOf, treeSignature, type TreeDeskSource, type TreePaneFacts } from '../../app/renderer/desk-tree-rules.ts'
import { DoorHost } from '../../app/renderer/door/host.ts'

const facts: Record<string, TreePaneFacts> = {
  a1: { type: 'agent', icon: 'terminal-window', title: 'claude · obra', attention: 'waiting', lines: ['Esperando você', 'Pede login'], busy: false, asleep: false, exited: false },
  a2: { type: 'agent', icon: 'terminal-window', title: 'soul', busy: true },
  a3: { type: 'agent', icon: 'terminal-window', title: 'codex', asleep: true, exited: true },
  n1: { type: 'note', icon: 'note', title: 'todo', attention: 'done' },
  b1: { type: 'browser', icon: 'globe', title: 'docs' },
  g1: { type: 'agent', icon: 'terminal-window', title: 'shell' },
}
const src = (id: string, panes: string[], extra: Partial<TreeDeskSource> = {}): TreeDeskSource => ({ id, name: id.toUpperCase(), color: 'blue', panes, ...extra })
const input = () => ({
  queue: [src('d1', ['a1', 'a2']), src('d2', ['a3', 'n1'], { asleep: true })],
  system: [src('sys.browser', ['b1'], { icon: 'app-window' })],
  drawer: src('drawer', ['g1']),
  pane: (id: string) => facts[id],
})

describe('desk tree', () => {
  test('the order is the queue, then the system desks, then the drawer, each with its kind', () => {
    const t = deskTreeOf(input())
    assert.deepEqual(t.desks.map(d => [d.id, d.kind]), [['d1', 'queue'], ['d2', 'queue'], ['sys.browser', 'system'], ['drawer', 'drawer']])
    assert.equal(t.desks[2]!.icon, 'app-window')
    assert.equal('icon' in t.desks[0]!, false)
  })

  test('attention keeps the terminal line and the seals messages together; a seal alone shows too', () => {
    const t = deskTreeOf(input())
    const [a1] = t.desks[0]!.panes
    assert.equal(a1!.attention, 'waiting')
    assert.deepEqual(a1!.lines, ['Esperando você', 'Pede login'])
    assert.equal(t.desks[1]!.panes[1]!.attention, 'done')
  })

  test('busy, asleep and exited appear only when set', () => {
    const t = deskTreeOf(input())
    assert.deepEqual(t.desks[0]!.panes[1], { id: 'a2', type: 'agent', icon: 'terminal-window', title: 'soul', busy: true })
    assert.deepEqual(t.desks[1]!.panes[0], { id: 'a3', type: 'agent', icon: 'terminal-window', title: 'codex', asleep: true, exited: true })
    assert.deepEqual(t.desks[0]!.panes[0], { id: 'a1', type: 'agent', icon: 'terminal-window', title: 'claude · obra', attention: 'waiting', lines: ['Esperando você', 'Pede login'] })
    assert.deepEqual(treePaneOf('x', { type: 'note', icon: 'note', title: 't', lines: [] }), { id: 'x', type: 'note', icon: 'note', title: 't' })
  })

  test('a sleeping desk says so; the others do not', () => {
    const t = deskTreeOf(input())
    assert.deepEqual(t.desks.map(d => d.asleep), [false, true, false, false])
  })

  test('a pane that is gone is left out', () => {
    const i = input()
    const t = deskTreeOf({ ...i, pane: id => (id === 'a2' ? undefined : facts[id]) })
    assert.deepEqual(t.desks[0]!.panes.map(p => p.id), ['a1'])
  })

  test('the caller leaves out its own desk', () => {
    const t = deskTreeOf({ ...input(), skip: ['sys.browser'] })
    assert.deepEqual(t.desks.map(d => d.id), ['d1', 'd2', 'drawer'])
  })

  test('no drawer and no desks: an empty tree', () => {
    assert.deepEqual(deskTreeOf({ queue: [], system: [], pane: () => undefined }), { desks: [] })
  })

  test('the signature is stable for equal input and moves with any change', () => {
    const a = treeSignature(deskTreeOf(input()))
    assert.equal(treeSignature(deskTreeOf(input())), a)
    facts.a2 = { ...facts.a2!, title: 'soul 2' }
    assert.notEqual(treeSignature(deskTreeOf(input())), a)
    facts.a2 = { type: 'agent', icon: 'terminal-window', title: 'soul', busy: true }
    assert.equal(treeSignature(deskTreeOf(input())), a)
  })
})

describe('the door announces the tree on its own signature', () => {
  const view = () => ({ desks: [], activeId: 'd1' })
  test('only on an actual change, and only while someone listens', () => {
    const door = new DoorHost()
    let heard = 0
    let t = deskTreeOf(input())
    door.stripRendered(view, () => t)
    const off = door.onTreeChange(() => { heard++ })
    door.stripRendered(view, () => t)
    assert.equal(heard, 1, 'the first sight after listening')
    door.stripRendered(view, () => deskTreeOf(input()))
    assert.equal(heard, 1, 'an equal tree: silence')
    t = { desks: t.desks.map(d => (d.id === 'd1' ? { ...d, name: 'Nova' } : d)) }
    door.stripRendered(view, () => t)
    assert.equal(heard, 2)
    off.dispose()
    t = { desks: [] }
    door.stripRendered(view, () => t)
    assert.equal(heard, 2)
  })

  test('the desks signature still fires alone, with no tree given', () => {
    const door = new DoorHost()
    let desks = 0
    door.onDesksChange(() => { desks++ })
    door.stripRendered(view)
    door.stripRendered(view)
    assert.equal(desks, 1)
  })
})
