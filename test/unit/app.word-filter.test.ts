// The palette's command filter (app/renderer/word-filter.ts): VS Code's WORD_FILTER, accent-blind.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { clipRanges, fold, matchesWords, rangeRuns, wordFilter } from '../../app/renderer/word-filter.ts'

describe('word filter', () => {
  test('prefix, then words, then contiguous substring', () => {
    assert.deepEqual(wordFilter('nova', 'Nova mesa'), [{ start: 0, end: 4 }])
    assert.deepEqual(wordFilter('mes', 'Nova mesa'), [{ start: 5, end: 8 }])
    assert.deepEqual(wordFilter('esa', 'Nova mesa'), [{ start: 6, end: 9 }], 'inside a word: contiguous substring')
    assert.equal(wordFilter('nvmesa', 'Nova mesa'), null, 'no letters apart')
  })

  test('matchesWords: the start of each word, spaces in the query match separators', () => {
    assert.deepEqual(matchesWords('dup dir', 'Duplicar à direita'), [{ start: 0, end: 3 }, { start: 8, end: 9 }, { start: 11, end: 14 }])
    assert.deepEqual(matchesWords('ir para', 'Ir para a mesa'), [{ start: 0, end: 7 }])
    assert.equal(matchesWords('dir dup', 'Duplicar à direita'), null, 'order matters')
  })

  test('case and accents are ignored; the ranges index the original text', () => {
    assert.equal(fold('Ação À'), 'acao a')
    assert.deepEqual(wordFilter('direita', 'Duplicar à direita'), [{ start: 11, end: 18 }])
    assert.deepEqual(wordFilter('PROXIMA', 'Próxima mesa'), [{ start: 0, end: 7 }])
  })

  test('the empty query matches with no ranges', () => {
    assert.deepEqual(wordFilter('', 'Qualquer'), [])
  })

  test('runs and clipping', () => {
    assert.deepEqual(rangeRuns('Nova mesa', [{ start: 0, end: 2 }, { start: 5, end: 8 }]), [
      { text: 'No', hit: true }, { text: 'va ', hit: false }, { text: 'mes', hit: true }, { text: 'a', hit: false }])
    assert.deepEqual(rangeRuns('abc', []), [{ text: 'abc', hit: false }])
    assert.deepEqual(clipRanges([{ start: 2, end: 8 }], 4, 6), [{ start: 0, end: 2 }])
  })
})
