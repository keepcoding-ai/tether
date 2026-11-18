// The toolbar's overflow plan (app/renderer/toolbar-overflow-rules.ts) and the narrow side bars (sidebar-rules.ts):
// what leaves the bar first, what never does, and one drawer at a time.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { planToolbar, type ToolbarMeasure } from '../../app/renderer/toolbar-overflow-rules.ts'
import { emptySideBars, isNarrowWorkbench, keepOneOpen, NARROW_BELOW } from '../../app/renderer/sidebar-rules.ts'

const base = (inner: number, pinned: number[] = []): ToolbarMeasure => ({
  inner, gap: 2, rightRest: 170, searchFull: 188, searchIcon: 32,
  left: Array.from({ length: 6 }, (_, i) => ({ width: 30, pinned: pinned.includes(i) })),
})

describe('toolbar overflow plan', () => {
  test('wide: everything stays', () => {
    assert.deepEqual(planToolbar(base(1400)), { collapsed: [], compactSearch: false })
  })
  test('the wider side gives first: the search becomes an icon before any left action goes', () => {
    const p = planToolbar(base(940))
    assert.equal(p.compactSearch, true)
    assert.deepEqual(p.collapsed, [])
  })
  test('left actions collapse last to first, pinned ones never', () => {
    const p = planToolbar({ ...base(700, [1]), rightRest: 60 })
    assert.ok(p.collapsed.length > 0)
    assert.ok(!p.collapsed.includes(1))
    assert.deepEqual(p.collapsed, [...p.collapsed].sort((a, b) => a - b))
    assert.ok(p.collapsed.includes(5))
  })
  test('nothing left to give: stops instead of looping', () => {
    const p = planToolbar(base(300, [0, 1, 2, 3, 4, 5]))
    assert.deepEqual(p.collapsed, [])
  })
})

describe('narrow side bars', () => {
  test('threshold', () => {
    assert.equal(isNarrowWorkbench(NARROW_BELOW - 1), true)
    assert.equal(isNarrowWorkbench(NARROW_BELOW), false)
    assert.equal(isNarrowWorkbench(0), false)
  })
  test('keepOneOpen closes the other side only', () => {
    const l = { ...emptySideBars(), left: { ...emptySideBars().left, open: 'a' }, right: { ...emptySideBars().right, open: 'b' } }
    const k = keepOneOpen(l, 'right')
    assert.equal(k.left.open, undefined)
    assert.equal(k.right.open, 'b')
    assert.equal(keepOneOpen(k, 'right'), k)
  })
})
