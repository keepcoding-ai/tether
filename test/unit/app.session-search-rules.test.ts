// The toolbar's tab search (app/renderer/session-search-rules.ts), pure: matching, ranking, selection.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { moveSelection, searchTabs, type SearchTab } from '../../app/renderer/session-search-rules.ts'

const S: SearchTab[] = [
  { id: 'a1b2c3', title: 'budget-management' },
  { id: 'd4e5f6', title: 'kai-aware' },
  { id: '9z8y7x', title: '' },
  { id: 'bb0000', title: 'Próxima entrega' },
]

describe('searchTabs', () => {
  test('empty query lists nothing', () => {
    assert.deepEqual(searchTabs('  ', S), [])
  })
  test('fuzzy match on the title, with positions', () => {
    const r = searchTabs('kaw', S)
    assert.equal(r.length, 1)
    assert.equal(r[0]!.id, 'd4e5f6')
    assert.deepEqual(r[0]!.positions, [0, 4, 5])
  })
  test('accents do not matter', () => {
    assert.equal(searchTabs('proxima', S)[0]!.id, 'bb0000')
  })
  test('no title falls back to the slot id as label', () => {
    const r = searchTabs('9z8', S)
    assert.equal(r[0]!.label, '9z8y7x')
    assert.deepEqual(r[0]!.positions, [0, 1, 2])
  })
  test('slot id prefix matches even when the title does not, and ranks first', () => {
    const r = searchTabs('a1b', S)
    assert.equal(r[0]!.id, 'a1b2c3')
    assert.deepEqual(r[0]!.positions, [])
    const b = searchTabs('b', S)
    assert.equal(b[0]!.id, 'bb0000')
    assert.ok(b.some(h => h.id === 'a1b2c3'))
  })
  test('no match is excluded; limit applies', () => {
    assert.deepEqual(searchTabs('qqq', S), [])
    assert.equal(searchTabs('e', S, 2).length, 2)
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

describe('searchTabs: any kind of tab', () => {
  const T: SearchTab[] = [
    { id: 'browser:1', title: 'Docs', extra: 'https://example.com/guide' },
    { id: 'note:abc', title: 'todo.md', extra: 'D:/work/todo.md' },
    { id: 'extensions', title: 'Extensões' },
    { id: 'empty:7', title: '' },
  ]
  test('the extra text finds a tab whose title does not match, ranked below title matches', () => {
    const r = searchTabs('example', T)
    assert.equal(r.length, 1)
    assert.equal(r[0]!.id, 'browser:1')
    assert.equal(r[0]!.label, 'Docs')
    assert.deepEqual(r[0]!.positions, [])
    const d = searchTabs('do', T)
    assert.equal(d[0]!.id, 'browser:1')
    assert.ok(d.some(h => h.id === 'note:abc'))
  })
  test('a file path in the extra text finds the note', () => {
    assert.equal(searchTabs('work/', T)[0]!.id, 'note:abc')
  })
  test('screens and empty tabs are found by title or id', () => {
    assert.equal(searchTabs('extens', T)[0]!.id, 'extensions')
    assert.equal(searchTabs('empty', T)[0]!.id, 'empty:7')
  })
})
