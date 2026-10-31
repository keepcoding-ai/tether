// The capsule's pure rules (app/renderer/desk-switch-rules.ts): what fits, the active desk never hidden,
// the "+N" count, MRU replacement on pick, use stamps.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fitDesks, overflowDesks, pickFromOverflow, touchUsed, type FitInput } from '../../app/renderer/desk-switch-rules.ts'

const order = ['a', 'b', 'c', 'd', 'e']
const widths = { a: 100, b: 100, c: 100, d: 100, e: 100 }
const base: FitInput = { order, active: 'a', visible: [], widths, avail: 1000, plusWidth: 40, gap: 0, lastUsed: {} }

test('every desk shows while they all fit', () => {
  assert.deepEqual(fitDesks(base), order)
  assert.deepEqual(fitDesks({ ...base, avail: 500 }), order)
})

test('too narrow: room for the "+N", the desks used longest ago leave, the active stays', () => {
  const lastUsed = { a: 1, b: 5, c: 2, d: 4, e: 3 }
  const vis = fitDesks({ ...base, avail: 340, active: 'a', lastUsed })
  assert.deepEqual(vis, ['a', 'b', 'd'], 'a (active) + the two most recent')
  assert.deepEqual(overflowDesks(order, vis), ['c', 'e'])
})

test('the active desk is never hidden, even when it alone does not fit', () => {
  const vis = fitDesks({ ...base, avail: 50, active: 'e', lastUsed: { a: 9 } })
  assert.deepEqual(vis, ['e'])
})

test('the previous subset is kept stable when nothing changes', () => {
  const vis = fitDesks({ ...base, avail: 340, active: 'c', visible: ['a', 'c', 'e'], lastUsed: {} })
  assert.deepEqual(vis, ['a', 'c', 'e'])
})

test('growing brings hidden desks back, most recent first', () => {
  const vis = fitDesks({ ...base, avail: 340, active: 'a', visible: ['a', 'b'], lastUsed: { e: 3, d: 1 } })
  assert.deepEqual(vis, ['a', 'b', 'e'])
})

test('picking in the "+N" replaces the visible desk used longest ago; the others stay', () => {
  const lastUsed = { a: 4, b: 1, d: 3 }
  assert.deepEqual(pickFromOverflow(order, ['a', 'b', 'd'], 'e', 'a', lastUsed), ['a', 'd', 'e'])
  // the active one is never the one replaced, even if its stamp is old
  assert.deepEqual(pickFromOverflow(order, ['a', 'b', 'd'], 'e', 'b', lastUsed), ['a', 'b', 'e'])
  // already visible: nothing moves
  assert.deepEqual(pickFromOverflow(order, ['a', 'b', 'd'], 'b', 'a', lastUsed), ['a', 'b', 'd'])
})

test('touchUsed stamps the desk as the most recent', () => {
  const u = touchUsed({ a: 2, b: 7 }, 'a')
  assert.deepEqual(u, { a: 8, b: 7 })
  assert.deepEqual(touchUsed({}, 'x'), { x: 1 })
})
