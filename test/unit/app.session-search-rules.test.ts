// The toolbar's session search (app/renderer/session-search-rules.ts), pure: matching, ranking, selection.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { moveSelection, searchSessions, type SearchSession } from '../../app/renderer/session-search-rules.ts'

const S: SearchSession[] = [
  { slotId: 'a1b2c3', title: 'budget-management' },
  { slotId: 'd4e5f6', title: 'kai-aware' },
  { slotId: '9z8y7x', title: '' },
  { slotId: 'bb0000', title: 'Próxima entrega' },
]

describe('searchSessions', () => {
  test('empty query lists nothing', () => {
    assert.deepEqual(searchSessions('  ', S), [])
  })
  test('fuzzy match on the title, with positions', () => {
    const r = searchSessions('kaw', S)
    assert.equal(r.length, 1)
    assert.equal(r[0]!.slotId, 'd4e5f6')
    assert.deepEqual(r[0]!.positions, [0, 4, 5])
  })
  test('accents do not matter', () => {
    assert.equal(searchSessions('proxima', S)[0]!.slotId, 'bb0000')
  })
  test('no title falls back to the slot id as label', () => {
    const r = searchSessions('9z8', S)
    assert.equal(r[0]!.label, '9z8y7x')
    assert.deepEqual(r[0]!.positions, [0, 1, 2])
  })
  test('slot id prefix matches even when the title does not, and ranks first', () => {
    const r = searchSessions('a1b', S)
    assert.equal(r[0]!.slotId, 'a1b2c3')
    assert.deepEqual(r[0]!.positions, [])
    const b = searchSessions('b', S)
    assert.equal(b[0]!.slotId, 'bb0000')
    assert.ok(b.some(h => h.slotId === 'a1b2c3'))
  })
  test('no match is excluded; limit applies', () => {
    assert.deepEqual(searchSessions('qqq', S), [])
    assert.equal(searchSessions('e', S, 2).length, 2)
  })
})

describe('moveSelection', () => {
  test('wraps and starts at the ends', () => {
    assert.equal(moveSelection(-1, 1, 3), 0)
    assert.equal(moveSelection(-1, -1, 3), 2)
    assert.equal(moveSelection(2, 1, 3), 0)
    assert.equal(moveSelection(0, -1, 3), 2)
    assert.equal(moveSelection(0, 1, 0), -1)
  })
})
