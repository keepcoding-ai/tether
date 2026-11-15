// The search pad's glue rules (extensions/search/renderer/view-rules.ts): when to search, the message texts, the regex
// check, the engine's errors, the exclude setting, the saved state and the seed from a selection.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ALWAYS_EXCLUDED, CANCELLED_MESSAGE, completionMessage, countLine, engineErrorText, EXCLUDES_OFF_NOTE, excludeExpression,
  LIMIT_HIT_MESSAGE, noResultsMessage, readViewState, regexError, resultCountMessage, seedFromSelection, triggerOf,
} from '../../extensions/search/renderer/view-rules.ts'

describe('when an edit searches', () => {
  test('typing debounces with search on type, else waits for Enter; toggles and Enter search at once', () => {
    assert.equal(triggerOf('typed', true), 'debounce')
    assert.equal(triggerOf('typed', false), 'none')
    assert.equal(triggerOf('toggle', false), 'now')
    assert.equal(triggerOf('submit', true), 'now')
  })
})

describe('messages', () => {
  test('result counts, singular and plural', () => {
    assert.equal(resultCountMessage(1, 1), '1 resultado em 1 arquivo')
    assert.equal(resultCountMessage(1, 2), '1 resultado em 2 arquivos')
    assert.equal(resultCountMessage(5, 1), '5 resultados em 1 arquivo')
    assert.equal(resultCountMessage(20000, 312), '20.000 resultados em 312 arquivos')
  })

  test('the count line notes when exclusions are off', () => {
    assert.equal(countLine(3, 2, true), '3 resultados em 2 arquivos')
    assert.equal(countLine(3, 2, false), `3 resultados em 2 arquivos — ${EXCLUDES_OFF_NOTE}`)
  })

  test('no results: where it looked and the exclusions hint', () => {
    assert.equal(noResultsMessage({ include: '', exclude: '', useExcludes: false }), 'Nenhum resultado encontrado.')
    assert.equal(noResultsMessage({ include: ' *.md ', exclude: '', useExcludes: false }), "Nenhum resultado encontrado em '*.md'.")
    assert.equal(noResultsMessage({ include: '', exclude: 'docs', useExcludes: false }), "Nenhum resultado encontrado excluindo 'docs'.")
    assert.equal(noResultsMessage({ include: 'src', exclude: '*.ts', useExcludes: true }),
      "Nenhum resultado encontrado em 'src' excluindo '*.ts'. As exclusões das configurações e os arquivos ignore estão valendo.")
  })

  test('completion: counts, limit hit, engine messages; cancelled keeps the counts and says so only when the person cancelled', () => {
    const base = { results: 4, files: 2, include: '', exclude: '', useExcludes: true }
    assert.deepEqual(completionMessage({ kind: 'done', ...base, limitHit: true, messages: [{ text: 'aviso', type: 2 }] }), [
      { text: '4 resultados em 2 arquivos', tone: 'info' },
      { text: LIMIT_HIT_MESSAGE, tone: 'warning' },
      { text: 'aviso', tone: 'warning' },
    ])
    assert.deepEqual(completionMessage({ kind: 'done', ...base, results: 0, files: 0 }).map(l => l.text), [noResultsMessage(base)])
    assert.deepEqual(completionMessage({ kind: 'cancelled', ...base, byUser: true }).map(l => l.text), ['4 resultados em 2 arquivos', CANCELLED_MESSAGE])
    assert.deepEqual(completionMessage({ kind: 'cancelled', ...base, results: 0, files: 0, byUser: true }).map(l => l.text), [CANCELLED_MESSAGE])
    assert.deepEqual(completionMessage({ kind: 'cancelled', ...base, results: 0, files: 0 }), [])
  })
})

describe('regular expressions and engine errors', () => {
  test('a valid pattern passes; an invalid one gives a Portuguese message with the detail', () => {
    assert.equal(regexError(''), undefined)
    assert.equal(regexError('fo+(o)'), undefined)
    const msg = regexError('foo(')
    assert.ok(msg?.startsWith('Expressão regular inválida: '), msg)
    assert.ok(!/Invalid regular expression/.test(msg!), 'the browser prefix is dropped')
  })

  test('known engine codes are translated, others keep the engine text', () => {
    assert.equal(engineErrorText({ message: 'unclosed group', code: 'regexParseError' }), 'Expressão regular inválida: unclosed group')
    assert.equal(engineErrorText({ message: 'bad glob', code: 'globParseError' }), 'Padrão de arquivos inválido: bad glob')
    assert.equal(engineErrorText({ message: 'A pesquisa parou (código 1).' }), 'A pesquisa parou (código 1).')
    assert.equal(engineErrorText({ message: '  ' }), 'A pesquisa falhou.')
  })
})

describe('exclude setting', () => {
  test('comma-separated globs plus the folders that are always out', () => {
    const e = excludeExpression('**/node_modules, **/dist ,, {a,b}/c')
    for (const g of ALWAYS_EXCLUDED) assert.equal(e[g], true)
    assert.equal(e['**/node_modules'], true)
    assert.equal(e['**/dist'], true)
    assert.equal(e['{a,b}/c'], true, 'a comma inside braces does not split')
    assert.equal(Object.keys(e).length, ALWAYS_EXCLUDED.length + 3)
    assert.deepEqual(Object.keys(excludeExpression(undefined)), [...ALWAYS_EXCLUDED])
  })
})

describe('saved state', () => {
  test('missing or ill-typed values fall back to the defaults', () => {
    const s = readViewState({ widget: { search: 'x', regex: 'yes', detailsShown: true }, history: { search: ['a', 3, 'b'] }, viewMode: 'grid' })
    assert.equal(s.widget.search, 'x')
    assert.equal(s.widget.regex, false)
    assert.equal(s.widget.detailsShown, true)
    assert.equal(s.widget.useExcludesAndIgnoreFiles, true)
    assert.deepEqual(s.history.search, ['a', 'b'])
    assert.equal(s.viewMode, undefined)
    assert.equal(readViewState({ viewMode: 'tree' }).viewMode, 'tree')
    assert.equal(readViewState(null).widget.search, '')
  })
})

describe('seed from a selection', () => {
  test('one line becomes the term (escaped under regex); several lines or nothing do not', () => {
    assert.equal(seedFromSelection('a.b', false), 'a.b')
    assert.equal(seedFromSelection('a.b(c)', true), 'a\\.b\\(c\\)')
    assert.equal(seedFromSelection('', false), undefined)
    assert.equal(seedFromSelection('a\nb', false), undefined)
  })
})
