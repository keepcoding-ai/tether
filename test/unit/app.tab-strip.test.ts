// The pane tab strip's overflow rules (app/renderer/tab-strip-rules.ts): fit, active stays, MRU pick.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { fitTabs, hiddenTabs, leastRecent, pickIndex, touchTab } from '../../app/renderer/tab-strip-rules.ts'

const order = ['a', 'b', 'c', 'd', 'e', 'f']
/** An oracle that fits up to `n` tabs. */
const upTo = (n: number) => (v: readonly string[]) => v.length <= n

describe('tab strip overflow', () => {
  test('everything fits: every tab, no "+N"', () => {
    const vis = fitTabs(order, 'a', new Map(), upTo(9))
    assert.deepEqual(vis, order)
    assert.deepEqual(hiddenTabs(order, vis), [])
  })

  test('does not fit: never-used tabs leave from the end, the active one stays', () => {
    assert.deepEqual(fitTabs(order, 'f', new Map([['f', 1]]), upTo(3)), ['a', 'b', 'f'])
    assert.deepEqual(hiddenTabs(order, ['a', 'b', 'f']), ['c', 'd', 'e'])
  })

  test('only the active tab when nothing else fits', () => {
    assert.deepEqual(fitTabs(order, 'd', new Map(), upTo(0)), ['d'])
  })

  test('the tab used longest ago leaves first', () => {
    const used = new Map([['a', 3], ['b', 1], ['c', 2]])
    assert.equal(leastRecent(order, ['a', 'b', 'c'], 'a', used), 'b')
    assert.deepEqual(fitTabs(['a', 'b', 'c'], 'a', used, upTo(2)), ['a', 'c'])
  })

  test('MRU pick: takes the place of the visible tab used longest ago; the others stay', () => {
    const used = new Map<string, number>([['a', 1], ['b', 2], ['c', 3]])
    const vis = fitTabs(order, 'c', used, upTo(3))
    assert.deepEqual(vis, ['a', 'b', 'c'])
    const idx = pickIndex(order, vis, 'e', 'c', used)
    assert.equal(idx, 0, 'goes where "a" was')
    // The host moves "e" there and activates it.
    const next = ['e', ...order.filter(id => id !== 'e')]
    touchTab(used, 'e')
    assert.deepEqual(fitTabs(next, 'e', used, upTo(3)), ['e', 'b', 'c'])
  })

  test('picking a visible tab moves nothing', () => {
    assert.equal(pickIndex(order, ['a', 'b'], 'a', 'b', new Map()), undefined)
  })

  test('touchTab stamps above every other', () => {
    const used = new Map([['a', 5]])
    touchTab(used, 'b')
    assert.equal(used.get('b'), 6)
  })
})
