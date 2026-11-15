// The RangeMap port (app/shared/vscode-range-map.ts): index <-> pixel position over run-length groups of equal size,
// the cases of VS Code's own rangeMap.test.ts plus mixed 26/28 px rows, as the explorer's rows are.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { RangeMap, Range, consolidate, groupIntersect, shift, type IItem } from '../../app/shared/vscode-range-map.ts'

const items = (size: number, count: number): IItem[] => Array.from({ length: count }, () => ({ size }))

describe('Range', () => {
  test('intersect', () => {
    assert.deepEqual(Range.intersect({ start: 0, end: 0 }, { start: 0, end: 0 }), { start: 0, end: 0 })
    assert.deepEqual(Range.intersect({ start: 0, end: 10 }, { start: 5, end: 15 }), { start: 5, end: 10 })
    assert.deepEqual(Range.intersect({ start: 0, end: 5 }, { start: 5, end: 10 }), { start: 0, end: 0 })
    assert.deepEqual(Range.intersect({ start: 2, end: 8 }, { start: 0, end: 10 }), { start: 2, end: 8 })
  })

  test('relativeComplement', () => {
    assert.deepEqual(Range.relativeComplement({ start: 0, end: 10 }, { start: 3, end: 6 }), [{ start: 0, end: 3 }, { start: 6, end: 10 }])
    assert.deepEqual(Range.relativeComplement({ start: 0, end: 10 }, { start: 0, end: 4 }), [{ start: 4, end: 10 }])
    assert.deepEqual(Range.relativeComplement({ start: 0, end: 10 }, { start: 0, end: 10 }), [])
    assert.deepEqual(Range.relativeComplement({ start: 0, end: 5 }, { start: 8, end: 12 }), [{ start: 0, end: 5 }])
  })
})

describe('range map helpers', () => {
  test('groupIntersect', () => {
    const groups = [{ range: { start: 0, end: 5 }, size: 1 }, { range: { start: 5, end: 10 }, size: 2 }]
    assert.deepEqual(groupIntersect({ start: 0, end: 0 }, groups), [])
    assert.deepEqual(groupIntersect({ start: 3, end: 7 }, groups), [{ range: { start: 3, end: 5 }, size: 1 }, { range: { start: 5, end: 7 }, size: 2 }])
    assert.deepEqual(groupIntersect({ start: 10, end: 20 }, groups), [])
  })

  test('shift', () => {
    assert.deepEqual(shift({ start: 2, end: 4 }, 3), { start: 5, end: 7 })
    assert.deepEqual(shift({ start: 2, end: 4 }, -2), { start: 0, end: 2 })
  })

  test('consolidate merges consecutive groups of equal size', () => {
    assert.deepEqual(consolidate([]), [])
    assert.deepEqual(consolidate([
      { range: { start: 0, end: 5 }, size: 1 },
      { range: { start: 5, end: 10 }, size: 1 },
      { range: { start: 10, end: 20 }, size: 2 },
    ]), [{ range: { start: 0, end: 10 }, size: 1 }, { range: { start: 10, end: 20 }, size: 2 }])
  })
})

describe('RangeMap', () => {
  test('empty', () => {
    const map = new RangeMap()
    assert.equal(map.size, 0)
    assert.equal(map.count, 0)
    assert.equal(map.indexAt(0), 0)
    assert.equal(map.indexAt(10), 0)
    assert.equal(map.indexAt(-1), -1)
    assert.equal(map.positionAt(0), -1)
    assert.equal(map.positionAt(-1), -1)
    assert.equal(map.indexAfter(0), 0)
  })

  test('uniform 26 px rows', () => {
    const map = new RangeMap()
    map.splice(0, 0, items(26, 10))
    assert.equal(map.count, 10)
    assert.equal(map.size, 260)
    assert.equal(map.indexAt(0), 0)
    assert.equal(map.indexAt(25), 0)
    assert.equal(map.indexAt(26), 1)
    assert.equal(map.indexAt(259), 9)
    assert.equal(map.indexAt(260), 10)
    assert.equal(map.indexAfter(25), 1)
    assert.equal(map.indexAfter(259), 10)
    assert.equal(map.positionAt(0), 0)
    assert.equal(map.positionAt(9), 234)
    assert.equal(map.positionAt(10), -1)
  })

  test('mixed 26 and 28 px rows', () => {
    const map = new RangeMap()
    // rows 0-2: 26, rows 3-4: 28, rows 5-6: 26
    map.splice(0, 0, [...items(26, 3), ...items(28, 2), ...items(26, 2)])
    assert.equal(map.count, 7)
    assert.equal(map.size, 3 * 26 + 2 * 28 + 2 * 26)
    assert.equal(map.positionAt(3), 78)
    assert.equal(map.positionAt(4), 106)
    assert.equal(map.positionAt(5), 134)
    assert.equal(map.positionAt(6), 160)
    assert.equal(map.indexAt(77), 2)
    assert.equal(map.indexAt(78), 3)
    assert.equal(map.indexAt(105), 3)
    assert.equal(map.indexAt(106), 4)
    assert.equal(map.indexAt(134), 5)
    assert.equal(map.indexAt(185), 6)
    assert.equal(map.indexAt(186), 7)
  })

  test('splice inserts, deletes and replaces in the middle', () => {
    const map = new RangeMap()
    map.splice(0, 0, items(26, 5))
    map.splice(2, 0, items(28, 2)) // 26 26 28 28 26 26 26
    assert.equal(map.count, 7)
    assert.equal(map.size, 5 * 26 + 2 * 28)
    assert.equal(map.positionAt(2), 52)
    assert.equal(map.positionAt(4), 108)
    assert.equal(map.indexAt(108), 4)

    map.splice(2, 2) // back to five 26 px rows
    assert.equal(map.count, 5)
    assert.equal(map.size, 130)
    assert.equal(map.positionAt(4), 104)

    map.splice(1, 3, items(28, 1)) // 26 28 26
    assert.equal(map.count, 3)
    assert.equal(map.size, 80)
    assert.equal(map.positionAt(2), 54)
    assert.equal(map.indexAt(53), 1)
    assert.equal(map.indexAt(54), 2)

    map.splice(0, 3)
    assert.equal(map.count, 0)
    assert.equal(map.size, 0)
  })

  test('paddingTop shifts every position', () => {
    const map = new RangeMap(10)
    assert.equal(map.size, 10)
    map.splice(0, 0, items(26, 2))
    assert.equal(map.size, 62)
    assert.equal(map.indexAt(5), 0)
    assert.equal(map.indexAt(36), 1)
    assert.equal(map.positionAt(1), 36)
    map.paddingTop = 0
    assert.equal(map.size, 52)
    assert.equal(map.positionAt(1), 26)
  })
})
