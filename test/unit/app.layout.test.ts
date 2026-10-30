// pruneLayout drops the panels the daemon no longer knows and collapses the grid, but dockview only restores a
// layout whose root is a branch: a single surviving panel (one panel saved, or one of two forgotten) must stay
// wrapped in the root branch, or the whole layout is thrown away on restore.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { SerializedDockview } from 'dockview-core'
import { pruneLayout } from '../../app/renderer/layout.ts'

type Node = SerializedDockview['grid']['root']
const leaf = (id: string, views: string[], size = 100): Node => ({ type: 'leaf', data: { views, activeView: views[0]!, id }, size })
const branch = (data: Node[], size = 100): Node => ({ type: 'branch', data, size })
const panel = (id: string) => ({ id, contentComponent: 'terminal', tabComponent: 'slot-tab', params: { slotId: id }, title: id })

function layout(root: Node, ids: string[]): SerializedDockview {
  return { grid: { root, width: 1400, height: 800, orientation: 'HORIZONTAL' as never }, panels: Object.fromEntries(ids.map(id => [id, panel(id)])), activeGroup: '1' }
}

describe('pruneLayout', () => {
  test('one panel saved: the root stays a branch around its single leaf', () => {
    const out = pruneLayout(layout(branch([leaf('1', ['a'], 1400)], 800), ['a']), new Set(['a']))!
    assert.equal(out.grid.root.type, 'branch')
    assert.deepEqual((out.grid.root.data as Node[]).map(n => n.type), ['leaf'])
    assert.deepEqual(Object.keys(out.panels), ['a'])
    assert.equal(out.activeGroup, '1')
  })

  test('two panels side by side, one forgotten: the root keeps the other one as a branch with one leaf', () => {
    const out = pruneLayout(layout(branch([leaf('1', ['a'], 700), leaf('2', ['b'], 700)], 800), ['a', 'b']), new Set(['b']))!
    assert.equal(out.grid.root.type, 'branch')
    const [only] = out.grid.root.data as Node[]
    assert.deepEqual(only, leaf('2', ['b'], 700))
    assert.deepEqual(Object.keys(out.panels), ['b'])
    assert.equal(out.activeGroup, undefined, 'the active group was the pruned one')
  })

  test('nested branch with one survivor collapses into its parent, keeping the branch size', () => {
    const inner = branch([leaf('2', ['b'], 300), leaf('3', ['c'], 300)], 700)
    const out = pruneLayout(layout(branch([leaf('1', ['a'], 700), inner], 800), ['a', 'b', 'c']), new Set(['a', 'c']))!
    assert.deepEqual(out.grid.root, branch([leaf('1', ['a'], 700), leaf('3', ['c'], 700)], 800))
  })

  test('nothing survives: null', () => {
    assert.equal(pruneLayout(layout(branch([leaf('1', ['a'])]), ['a']), new Set()), null)
  })
})

// Restore policy: a slot the daemon does not list is hidden from the display, never written back; an empty
// (or failed) list is not trusted and leaves the layout exactly as saved.
import { orphanedPanels, planRestore } from '../../app/renderer/layout.ts'

describe('planRestore', () => {
  const two = () => layout(branch([leaf('1', ['a'], 700), leaf('2', ['b'], 700)], 800), ['a', 'b'])

  test('daemon knows no slot at all: the saved layout is shown untouched, nothing is orphaned', () => {
    const saved = two()
    const plan = planRestore(saved, new Set())
    assert.deepEqual(plan.layout, saved)
    assert.deepEqual(plan.orphaned, [])
  })

  test('every panel known: the layout is the saved one (same object, no rewrite)', () => {
    const saved = two()
    const plan = planRestore(saved, new Set(['a', 'b']))
    assert.equal(plan.layout, saved)
    assert.deepEqual(plan.orphaned, [])
  })

  test('one slot missing: hidden from the display and reported, the saved object itself is not touched', () => {
    const saved = two()
    const before = JSON.stringify(saved)
    const plan = planRestore(saved, new Set(['b']))
    assert.deepEqual(Object.keys(plan.layout!.panels), ['b'])
    assert.deepEqual(plan.orphaned, ['a'])
    assert.equal(JSON.stringify(saved), before)
  })

  test('not a layout (null, garbage): nothing to show, nothing orphaned', () => {
    assert.deepEqual(planRestore(null, new Set(['a'])), { layout: null, orphaned: [] })
    assert.deepEqual(planRestore({ grid: 1 }, new Set(['a'])), { layout: null, orphaned: [] })
  })
})

describe('orphanedPanels', () => {
  test('empty known list hides nothing', () => {
    assert.deepEqual(orphanedPanels(['a', 'b'], new Set()), [])
  })
  test('only the unknown ones', () => {
    assert.deepEqual(orphanedPanels(['a', 'b', 'c'], new Set(['b'])), ['a', 'c'])
  })
})
