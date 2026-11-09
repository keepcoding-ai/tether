// The capsule's drag rules (app/renderer/desk-drag-rules.ts): threshold, live target, mapping to the full queue.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DRAG_THRESHOLD_PX, clampDragX, dragTargetIndex, fullIndexAfterDrop, orderAfterDrop, passedThreshold } from '../../app/renderer/desk-drag-rules.ts'

test('threshold is 4 px on either axis', () => {
  assert.equal(DRAG_THRESHOLD_PX, 4)
  assert.equal(passedThreshold(3, 3), false)
  assert.equal(passedThreshold(-4, 0), true)
  assert.equal(passedThreshold(0, 4), true)
})

const centers = [50, 150, 250, 350]

test('target: stays until the centre crosses a neighbour centre', () => {
  assert.equal(dragTargetIndex(centers, 1, 150), 1)
  assert.equal(dragTargetIndex(centers, 1, 250), 1)
  assert.equal(dragTargetIndex(centers, 1, 251), 2)
  assert.equal(dragTargetIndex(centers, 1, 49), 0)
  assert.equal(dragTargetIndex(centers, 1, 50), 1)
})

test('target: crosses several and is clamped to the row', () => {
  assert.equal(dragTargetIndex(centers, 0, 400), 3)
  assert.equal(dragTargetIndex(centers, 3, -100), 0)
  assert.equal(dragTargetIndex(centers, 0, 260), 2)
  assert.equal(dragTargetIndex([], 0, 10), 0)
})

test('clampDragX bounds the value', () => {
  assert.equal(clampDragX(5, 10, 20), 10)
  assert.equal(clampDragX(25, 10, 20), 20)
  assert.equal(clampDragX(15, 10, 20), 15)
})

const order = ['a', 'b', 'h1', 'c', 'h2', 'd', 'h3']
const visible = ['a', 'b', 'c', 'd']

test('full index: lands right after the visible left neighbour, hidden ones not crossed', () => {
  assert.deepEqual(orderAfterDrop(order, visible, 'd', 2), ['a', 'b', 'd', 'h1', 'c', 'h2', 'h3'])
  assert.deepEqual(orderAfterDrop(order, visible, 'a', 1), ['b', 'a', 'h1', 'c', 'h2', 'd', 'h3'])
  assert.deepEqual(orderAfterDrop(order, visible, 'a', 3), ['b', 'h1', 'c', 'h2', 'd', 'a', 'h3'])
})

test('full index: before every visible desk is 0', () => {
  assert.equal(fullIndexAfterDrop(order, visible, 'c', 0), 0)
  assert.deepEqual(orderAfterDrop(order, visible, 'c', 0), ['c', 'a', 'b', 'h1', 'h2', 'd', 'h3'])
})

test('full index: a desk right after its left neighbour keeps the queue', () => {
  assert.deepEqual(orderAfterDrop(order, visible, 'a', 0), order)
  assert.deepEqual(orderAfterDrop(order, visible, 'b', 1), order)
})
