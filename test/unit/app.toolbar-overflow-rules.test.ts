// The toolbar's overflow plan (app/renderer/toolbar-overflow-rules.ts) and the narrow side bars (sidebar-rules.ts):
// what leaves the bar, what never does, the capsule never colliding with a side, and one drawer at a time.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { MIN_CENTER, planToolbar, SIDE_MARGIN, type ToolbarMeasure, type ToolbarPlan } from '../../app/renderer/toolbar-overflow-rules.ts'
import { emptySideBars, isNarrowWorkbench, keepOneOpen, NARROW_BELOW } from '../../app/renderer/sidebar-rules.ts'

const GAP = 2
const item = (pinned = false, width = 30) => ({ width, pinned })
/** The real toolbar: six left actions; right = bell (pinned), status, connection, theme, ☰ (pinned); the search apart. */
const real = (inner: number, over: Partial<ToolbarMeasure> = {}): ToolbarMeasure => ({
  inner, gap: GAP, searchFull: 188, searchIcon: 32,
  left: Array.from({ length: 6 }, () => item()),
  right: [item(true), item(), item(), item(), item(true)],
  ...over,
})

/** What each side takes on the bar for a plan, and the room the capsule is left. */
function room(m: ToolbarMeasure, p: ToolbarPlan): number {
  const w = (items: ToolbarMeasure['left'], gone: number[]): number => items.filter((_, i) => !gone.includes(i)).reduce((n, it) => n + it.width + m.gap, 0)
  const l = w(m.left, p.collapsedLeft)
  const r = w(m.right, p.collapsedRight) + (p.hideSearch ? 0 : p.compactSearch ? m.searchIcon : m.searchFull)
  return m.inner - 2 * (Math.max(l, r) + SIDE_MARGIN)
}

describe('toolbar overflow plan', () => {
  test('1400: everything stays', () => {
    assert.deepEqual(planToolbar(real(1400)), { collapsedLeft: [], collapsedRight: [], compactSearch: false, hideSearch: false })
  })
  test('940: the search is the magnifier, the icons stay, the capsule has its room', () => {
    const m = real(940 - 16), p = planToolbar(m)
    assert.equal(p.compactSearch, true)
    assert.equal(p.hideSearch, false)
    assert.deepEqual(p.collapsedRight, [])
    assert.ok(room(m, p) >= MIN_CENTER)
  })
  test('700: only ☰ and the bell are left, the capsule has its room', () => {
    const m = real(700 - 16), p = planToolbar(m)
    assert.deepEqual(p.collapsedLeft, [0, 1, 2, 3, 4, 5])
    assert.deepEqual(p.collapsedRight, [1, 2, 3])
    assert.equal(p.hideSearch, true)
    assert.ok(room(m, p) >= MIN_CENTER)
  })
  test('never a collision: from 560 to 1500 px the room is kept whenever the sides can give it', () => {
    for (let inner = 560; inner <= 1500; inner += 10) {
      const m = real(inner), p = planToolbar(m)
      assert.ok(room(m, p) >= MIN_CENTER, `inner ${inner}`)
    }
  })
  test('pinned icons (alert, state) never collapse, even at 700', () => {
    const m = real(684, { left: [item(), item(), item(true), item(), item(), item()], right: [item(true), item(), item(true), item(), item(true)] })
    const p = planToolbar(m)
    assert.ok(!p.collapsedLeft.includes(2))
    assert.ok(!p.collapsedRight.includes(2))
    assert.ok(!p.collapsedRight.includes(0) && !p.collapsedRight.includes(4))
  })
  test('gradual before all-at-once: left actions go last to first when the left is the wider side', () => {
    const m = real(1000, { left: Array.from({ length: 6 }, () => item(false, 60)), searchFull: 40, searchIcon: 32, right: [item(true), item(true)] })
    const p = planToolbar(m)
    assert.ok(p.collapsedLeft.length > 0 && p.collapsedLeft.length < 6)
    assert.equal(p.collapsedLeft[p.collapsedLeft.length - 1], 5)
  })
  test('nothing collapsible: stops without looping', () => {
    const p = planToolbar(real(300, { left: Array.from({ length: 6 }, () => item(true)), right: [item(true)] }))
    assert.deepEqual(p.collapsedLeft, [])
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
