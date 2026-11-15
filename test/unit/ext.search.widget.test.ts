// The search pad's field rules (extensions/search/renderer/widget-rules.ts): history, arrows, initial state, shortcuts, height.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  arrowAction, defaultState, fieldHeight, FieldHistory, HISTORY_LIMIT, lineCount, MAX_FIELD_LINES, normalizeHistory, normalizeState, toggleForKey,
} from '../../extensions/search/renderer/widget-rules.ts'

describe('field history', () => {
  test('add skips empty values and consecutive repeats, newest last', () => {
    const h = new FieldHistory()
    h.add(''); h.add('a'); h.add('a'); h.add('b'); h.add('a')
    assert.deepEqual(h.entries(), ['a', 'b', 'a'])
  })

  test('keeps only the newest 100', () => {
    const h = new FieldHistory()
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) h.add(`v${i}`)
    const e = h.entries()
    assert.equal(e.length, HISTORY_LIMIT)
    assert.equal(e[0], 'v5')
    assert.equal(e[e.length - 1], `v${HISTORY_LIMIT + 4}`)
  })

  test('previous walks back and stops at the oldest; next walks forward and returns the draft past the end', () => {
    const h = new FieldHistory(['a', 'b', 'c'])
    assert.equal(h.editing, true)
    assert.equal(h.next(), undefined, 'nothing after the text being typed')
    assert.equal(h.previous('draft'), 'c')
    assert.equal(h.editing, false)
    assert.equal(h.previous('c'), 'b')
    assert.equal(h.previous('b'), 'a')
    assert.equal(h.previous('a'), undefined)
    assert.equal(h.next(), 'b')
    assert.equal(h.next(), 'c')
    assert.equal(h.next(), 'draft')
    assert.equal(h.editing, true)
    assert.equal(h.next(), undefined)
  })

  test('typing (reset) and add put the position back on "editing"', () => {
    const h = new FieldHistory(['a', 'b'])
    h.previous('x')
    h.reset()
    assert.equal(h.editing, true)
    assert.equal(h.previous('y'), 'b')
    h.add('z')
    assert.equal(h.editing, true)
    assert.equal(h.previous(''), 'z')
  })

  test('an empty history has nothing to walk; clear empties it', () => {
    const h = new FieldHistory()
    assert.equal(h.previous('x'), undefined)
    const g = new FieldHistory(['a'])
    g.clear()
    assert.deepEqual(g.entries(), [])
  })

  test('a saved list is cleaned: strings only, no empties, no consecutive repeats', () => {
    const n = normalizeHistory({ search: ['a', 'a', '', 5 as unknown as string, 'b'], replace: 'x' as unknown as string[] })
    assert.deepEqual(n, { search: ['a', 'b'], replace: [], include: [], exclude: [] })
  })
})

describe('arrow keys', () => {
  test('up walks the history only on the first line', () => {
    assert.equal(arrowAction('up', 'abc', 2, 2), 'history')
    assert.equal(arrowAction('up', 'ab\ncd', 4, 4), 'caret')
    assert.equal(arrowAction('up', 'ab\ncd', 1, 1), 'history')
    assert.equal(arrowAction('up', '\nab', 0, 0), 'history')
    assert.equal(arrowAction('up', '', 0, 0), 'history')
  })

  test('down walks the history only on the last line', () => {
    assert.equal(arrowAction('down', 'abc', 1, 1), 'history')
    assert.equal(arrowAction('down', 'ab\ncd', 1, 1), 'caret')
    assert.equal(arrowAction('down', 'ab\ncd', 4, 4), 'history')
    assert.equal(arrowAction('down', 'ab\n', 3, 3), 'history')
    assert.equal(arrowAction('down', 'ab\n', 1, 1), 'caret')
  })
})

describe('initial state', () => {
  test('nothing given: everything off and empty, but the excludes and ignore files are on', () => {
    const s = normalizeState()
    assert.deepEqual(s, defaultState())
    assert.equal(s.useExcludesAndIgnoreFiles, true)
    assert.equal(s.search, '')
    assert.equal(s.regex, false)
    assert.equal(s.detailsShown, false)
  })

  test('given values are kept, absent and ill-typed ones fall back', () => {
    const s = normalizeState({ search: 'x', regex: true, useExcludesAndIgnoreFiles: false, include: 3 as unknown as string, wholeWord: 'yes' as unknown as boolean })
    assert.equal(s.search, 'x')
    assert.equal(s.regex, true)
    assert.equal(s.useExcludesAndIgnoreFiles, false)
    assert.equal(s.include, '')
    assert.equal(s.wholeWord, false)
    assert.deepEqual(normalizeState(null), defaultState())
  })
})

describe('shortcuts', () => {
  const key = (code: string, mods: Partial<Record<'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey', boolean>> = { altKey: true }) =>
    toggleForKey({ code, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...mods })

  test('Alt+C, W, R, P flip the four toggles', () => {
    assert.equal(key('KeyC'), 'caseSensitive')
    assert.equal(key('KeyW'), 'wholeWord')
    assert.equal(key('KeyR'), 'regex')
    assert.equal(key('KeyP'), 'preserveCase')
  })

  test('other keys and other modifiers (AltGr is Ctrl+Alt) do nothing', () => {
    assert.equal(key('KeyX'), undefined)
    assert.equal(key('KeyC', {}), undefined)
    assert.equal(key('KeyC', { altKey: true, ctrlKey: true }), undefined)
    assert.equal(key('KeyC', { altKey: true, shiftKey: true }), undefined)
    assert.equal(key('KeyC', { altKey: true, metaKey: true }), undefined)
  })
})

describe('field height', () => {
  test('counts lines', () => {
    assert.equal(lineCount(''), 1)
    assert.equal(lineCount('a'), 1)
    assert.equal(lineCount('a\nb'), 2)
    assert.equal(lineCount('a\n'), 2)
  })

  test('grows with the lines and scrolls past the limit', () => {
    assert.deepEqual(fieldHeight(1, 18, 6), { height: 24, scrolls: false })
    assert.deepEqual(fieldHeight(3, 18, 6), { height: 60, scrolls: false })
    assert.deepEqual(fieldHeight(MAX_FIELD_LINES, 18, 6), { height: 114, scrolls: false })
    assert.deepEqual(fieldHeight(MAX_FIELD_LINES + 4, 18, 6), { height: 114, scrolls: true })
    assert.deepEqual(fieldHeight(0, 18, 6), { height: 24, scrolls: false })
  })
})
