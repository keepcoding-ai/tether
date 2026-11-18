// The ListView port's pure part (app/renderer/vscode-list-view.ts): the visible range over mixed 28/26 px rows, the
// overscan clamped at both edges, the ranges a scroll inserts and removes, and the DOM work a splice plans (which
// rendered rows move, which fall out, which get drawn), checked case by case and by replaying random scrolls and
// splices against the set of rendered rows.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { RangeMap, type IItem, type IRange } from '../../app/shared/vscode-range-map.ts'
import { getRenderRange, getRenderRanges, getSpliceRanges, getVisibleRange } from '../../app/renderer/vscode-list-view.ts'

const items = (size: number, count: number): IItem[] => Array.from({ length: count }, () => ({ size }))

/** Rows 0..4 are 28 px (tops 0, 28, 56, 84, 112); rows 5..99 are 26 px (row i at 140 + (i - 5) * 26). */
function mixedMap(): RangeMap {
  const map = new RangeMap()
  map.splice(0, 0, [...items(28, 5), ...items(26, 95)])
  return map
}

const indices = (r: IRange): number[] => Array.from({ length: Math.max(0, r.end - r.start) }, (_, i) => r.start + i)

describe('getVisibleRange', () => {
  test('mixed heights', () => {
    const map = mixedMap()
    assert.deepEqual(getVisibleRange(map, 0, 100), { start: 0, end: 4 })
    assert.deepEqual(getVisibleRange(map, 130, 52), { start: 4, end: 7 })
    assert.deepEqual(getVisibleRange(map, 140, 26), { start: 5, end: 6 })
    assert.deepEqual(getVisibleRange(map, 1000, 100), { start: 38, end: 42 })
    assert.deepEqual(getVisibleRange(map, 2510, 100), { start: 96, end: 100 })
  })

  test('collapsed viewport and empty list never invert', () => {
    const r = getVisibleRange(mixedMap(), 130, 0)
    assert.ok(r.end >= r.start)
    assert.deepEqual(getVisibleRange(new RangeMap(), 0, 500), { start: 0, end: 0 })
  })

  test('padding top', () => {
    const map = new RangeMap(20)
    map.splice(0, 0, items(26, 10))
    assert.deepEqual(getVisibleRange(map, 0, 30), { start: 0, end: 1 })
    assert.deepEqual(getVisibleRange(map, 0, 47), { start: 0, end: 2 })
  })
})

describe('getRenderRange', () => {
  test('overscan widens both sides', () => {
    assert.deepEqual(getRenderRange(mixedMap(), 1000, 100, 10), { start: 28, end: 52 })
  })

  test('overscan is clamped at the top and at the bottom', () => {
    const map = mixedMap()
    assert.deepEqual(getRenderRange(map, 0, 100, 10), { start: 0, end: 14 })
    assert.deepEqual(getRenderRange(map, 2510, 100, 10), { start: 86, end: 100 })
    // A position past the content (a stale scrollTop after a shrink) keeps the last rows rendered.
    assert.deepEqual(getRenderRange(map, 5000, 100, 10), { start: 90, end: 100 })
  })

  test('overscan 0 is the visible range; an empty list renders nothing', () => {
    const map = mixedMap()
    assert.deepEqual(getRenderRange(map, 1000, 100, 0), getVisibleRange(map, 1000, 100))
    assert.deepEqual(getRenderRange(new RangeMap(), 0, 500, 10), { start: 0, end: 0 })
  })
})

describe('getRenderRanges (scroll)', () => {
  test('scrolling down a little inserts below and removes above', () => {
    assert.deepEqual(getRenderRanges({ start: 0, end: 14 }, { start: 3, end: 17 }), {
      rangesToInsert: [{ start: 14, end: 17 }],
      rangesToRemove: [{ start: 0, end: 3 }]
    })
  })

  test('scrolling up inserts above and removes below', () => {
    assert.deepEqual(getRenderRanges({ start: 10, end: 24 }, { start: 5, end: 19 }), {
      rangesToInsert: [{ start: 5, end: 10 }],
      rangesToRemove: [{ start: 19, end: 24 }]
    })
  })

  test('a jump replaces the whole range', () => {
    assert.deepEqual(getRenderRanges({ start: 0, end: 14 }, { start: 50, end: 64 }), {
      rangesToInsert: [{ start: 50, end: 64 }],
      rangesToRemove: [{ start: 0, end: 14 }]
    })
  })

  test('a taller viewport grows both sides, the lower range first', () => {
    assert.deepEqual(getRenderRanges({ start: 5, end: 10 }, { start: 3, end: 12 }), {
      rangesToInsert: [{ start: 10, end: 12 }, { start: 3, end: 5 }],
      rangesToRemove: []
    })
  })

  test('same range: nothing to do', () => {
    assert.deepEqual(getRenderRanges({ start: 5, end: 10 }, { start: 5, end: 10 }), { rangesToInsert: [], rangesToRemove: [] })
  })
})

describe('getSpliceRanges', () => {
  test('expanding inside the range: rows below move, the overflow falls out, the new rows are drawn', () => {
    assert.deepEqual(getSpliceRanges({ start: 0, end: 14 }, { start: 0, end: 14 }, 5, 0, 3, 100), {
      removeRange: { start: 0, end: 0 },
      updateRange: { start: 8, end: 14 },
      removeRanges: [{ start: 14, end: 17 }],
      insertRanges: [{ start: 5, end: 8 }]
    })
  })

  test('collapsing inside the range: deleted rows are reusable, rows below move up, the gap at the end is filled', () => {
    assert.deepEqual(getSpliceRanges({ start: 0, end: 14 }, { start: 0, end: 14 }, 2, 4, 0, 100), {
      removeRange: { start: 2, end: 6 },
      updateRange: { start: 2, end: 10 },
      removeRanges: [],
      insertRanges: [{ start: 10, end: 14 }]
    })
  })

  test('a change below the range touches nothing', () => {
    assert.deepEqual(getSpliceRanges({ start: 0, end: 14 }, { start: 0, end: 14 }, 50, 5, 0, 100), {
      removeRange: { start: 0, end: 0 },
      updateRange: { start: 0, end: 0 },
      removeRanges: [],
      insertRanges: []
    })
  })

  test('a change above the range keeps scrollTop: content shifts under the viewport', () => {
    assert.deepEqual(getSpliceRanges({ start: 40, end: 54 }, { start: 40, end: 54 }, 10, 0, 2, 100), {
      removeRange: { start: 0, end: 0 },
      updateRange: { start: 42, end: 54 },
      removeRanges: [{ start: 54, end: 56 }],
      insertRanges: [{ start: 40, end: 42 }]
    })
  })

  test('replacing everything reuses every rendered row and draws the new range', () => {
    assert.deepEqual(getSpliceRanges({ start: 0, end: 14 }, { start: 0, end: 14 }, 0, 100, 50, 100), {
      removeRange: { start: 0, end: 14 },
      updateRange: { start: 0, end: 0 },
      removeRanges: [],
      insertRanges: [{ start: 0, end: 14 }]
    })
  })
})

/** Deterministic PRNG (mulberry32) so a failing replay can be reproduced. */
function random(seed: number): () => number {
  return () => {
    seed |= 0
    seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('replay against the set of rendered rows', () => {
  const height = 300
  const overscan = 4

  test('random scrolls and splices always leave exactly the render range drawn, without redrawing survivors', () => {
    const rnd = random(7)
    const int = (n: number): number => Math.floor(rnd() * n)
    const size = (): number => (rnd() < 0.3 ? 28 : 26)

    const map = new RangeMap()
    let length = 200
    map.splice(0, 0, Array.from({ length }, () => ({ size: size() })))
    // Rendered rows: list index -> identity of the drawn row, so a redraw of a survivor is visible.
    let rendered = new Map<number, number>()
    let nextRowId = 0
    let top = 0
    let range = getRenderRange(map, top, height, overscan)
    for (const i of indices(range)) rendered.set(i, nextRowId++)

    for (let step = 0; step < 500; step++) {
      if (rnd() < 0.5) {
        top = Math.max(0, Math.min(map.size - height, top + int(1200) - 600))
        const next = getRenderRange(map, top, height, overscan)
        const { rangesToInsert, rangesToRemove } = getRenderRanges(range, next)
        for (const r of rangesToRemove) for (const i of indices(r)) assert.ok(rendered.delete(i), `remove ${i} not rendered`)
        for (const r of rangesToInsert) for (const i of indices(r)) {
          assert.ok(!rendered.has(i), `insert ${i} already rendered`)
          rendered.set(i, nextRowId++)
        }
        range = next
      } else {
        const start = int(length + 1)
        const deleteCount = int(Math.min(30, length - start) + 1)
        const insertCount = int(30)
        const previous = range
        map.splice(start, deleteCount, Array.from({ length: insertCount }, () => ({ size: size() })))
        const next = getRenderRange(map, top, height, overscan)
        const plan = getSpliceRanges(previous, next, start, deleteCount, insertCount, length)
        const delta = insertCount - deleteCount

        assert.deepEqual(indices(plan.removeRange), indices(previous).filter(i => i >= start && i < start + deleteCount))
        const survivors = new Map<number, number>()
        for (const [i, id] of rendered) {
          if (i < start) survivors.set(i, id)
          else if (i >= start + deleteCount) survivors.set(i + delta, id)
        }
        for (const r of plan.removeRanges) for (const i of indices(r)) assert.ok(survivors.delete(i), `remove ${i} not a survivor`)
        for (const i of indices(plan.updateRange)) assert.ok(survivors.has(i), `update ${i} not a survivor`)
        const kept = new Map(survivors)
        for (const r of plan.insertRanges) for (const i of indices(r)) {
          assert.ok(!survivors.has(i), `insert ${i} redraws a survivor`)
          survivors.set(i, nextRowId++)
        }
        rendered = survivors
        // Every survivor still inside the range kept its row.
        for (const [i, id] of kept) assert.equal(rendered.get(i), id)
        length += delta
        if (top > Math.max(0, map.size - height)) top = Math.max(0, map.size - height)
        range = next
        // A clamped scroll position renders like any other scroll.
        const clamped = getRenderRange(map, top, height, overscan)
        const { rangesToInsert, rangesToRemove } = getRenderRanges(range, clamped)
        for (const r of rangesToRemove) for (const i of indices(r)) rendered.delete(i)
        for (const r of rangesToInsert) for (const i of indices(r)) rendered.set(i, nextRowId++)
        range = clamped
      }
      assert.deepEqual([...rendered.keys()].sort((a, b) => a - b), indices(range), `step ${step}`)
    }
  })
})
