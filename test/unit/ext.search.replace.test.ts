// The search pad's replace rules (extensions/search/renderer/replace-rules.ts): the guard over an open editor's text, the
// line ending of the new text, editor against disk, what leaves the results, and the texts of the summary and confirmation.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  baseName, guardModel, inOrder, isQuietSingle, NOTHING_REPLACED, overlaps, replaceAllConfirmation, replaceAllTitle, replacedLine,
  replaceSummary, sameText, splitByEditor, toEol, toRemove, UNDO_NOTE, type GuardModel, type ReplaceOutcome, type ReplaceRange,
} from '../../extensions/search/renderer/replace-rules.ts'

/** A text model as Monaco's: lines split on \r\n or \n, getValueInRange joined with the model's EOL. */
function model(text: string): GuardModel {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  return {
    getLineCount: () => lines.length,
    getLineMaxColumn: l => (lines[l - 1] ?? '').length + 1,
    getEOL: () => eol,
    getValueInRange: r => {
      if (r.startLineNumber === r.endLineNumber) return (lines[r.startLineNumber - 1] ?? '').slice(r.startColumn - 1, r.endColumn - 1)
      const out = [(lines[r.startLineNumber - 1] ?? '').slice(r.startColumn - 1)]
      for (let l = r.startLineNumber + 1; l < r.endLineNumber; l++) out.push(lines[l - 1] ?? '')
      out.push((lines[r.endLineNumber - 1] ?? '').slice(0, r.endColumn - 1))
      return out.join(eol)
    },
  }
}
const R = (sl: number, sc: number, el: number, ec: number): ReplaceRange => ({ startLineNumber: sl, startColumn: sc, endLineNumber: el, endColumn: ec })

describe('the guard over an open editor', () => {
  test('every range holds the found text: the edits come back', () => {
    const m = model('foo bar\nbaz foo\n')
    assert.deepEqual(guardModel(m, [{ range: R(1, 1, 1, 4), expected: 'foo', text: 'X' }, { range: R(2, 5, 2, 8), expected: 'foo', text: 'Y' }]),
      [{ range: R(1, 1, 1, 4), text: 'X' }, { range: R(2, 5, 2, 8), text: 'Y' }])
  })
  test('one range no longer holds it: nothing is edited', () => {
    const m = model('fox bar\nbaz foo\n')
    assert.equal(guardModel(m, [{ range: R(1, 1, 1, 4), expected: 'foo', text: 'X' }, { range: R(2, 5, 2, 8), expected: 'foo', text: 'Y' }]), undefined)
  })
  test('a range outside the text, reversed, or overlapping another: nothing is edited', () => {
    const m = model('abc\n')
    assert.equal(guardModel(m, [{ range: R(3, 1, 3, 2), expected: 'a', text: '' }]), undefined)
    assert.equal(guardModel(m, [{ range: R(1, 1, 1, 9), expected: 'abc', text: '' }]), undefined)
    assert.equal(guardModel(m, [{ range: R(1, 3, 1, 1), expected: '', text: '' }]), undefined)
    assert.equal(guardModel(m, [{ range: R(1, 1, 1, 3), expected: 'ab', text: '' }, { range: R(1, 2, 1, 4), expected: 'bc', text: '' }]), undefined)
    assert.equal(guardModel(m, []), undefined)
  })
  test('a multi-line match in a \\r\\n model: the found text (joined with \\n) still counts, the new text takes \\r\\n', () => {
    const m = model('one\r\ntwo\r\nthree')
    assert.deepEqual(guardModel(m, [{ range: R(1, 2, 2, 3), expected: 'ne\ntw', text: 'A\nB' }]), [{ range: R(1, 2, 2, 3), text: 'A\r\nB' }])
  })
  test('columns count UTF-16 units: accents and emoji before the match', () => {
    const m = model('ação 😀 foo')
    assert.ok(guardModel(m, [{ range: R(1, 9, 1, 12), expected: 'foo', text: 'bar' }]))
  })
  test('sameText, toEol, overlaps', () => {
    assert.equal(sameText('a\r\nb', 'a\nb'), true)
    assert.equal(sameText('a\nb', 'a b'), false)
    assert.equal(toEol('a\nb\r\nc', '\r\n'), 'a\r\nb\r\nc')
    assert.equal(toEol('a\r\nb', '\n'), 'a\nb')
    assert.equal(overlaps([R(1, 1, 1, 3), R(1, 3, 1, 5)]), false, 'touching ends do not overlap')
    assert.equal(overlaps([R(2, 1, 3, 2), R(1, 1, 2, 4)]), true)
  })
})

describe('editor against disk; outcomes', () => {
  test('the files open in an editor are split from the rest, in order', () => {
    const files = [{ path: 'a' }, { path: 'b' }, { path: 'c' }]
    assert.deepEqual(splitByEditor(files, p => p === 'b'), { open: [{ path: 'b' }], disk: [{ path: 'a' }, { path: 'c' }] })
  })
  test('outcomes in the order of the files; a file without one is failed', () => {
    const out = inOrder([{ path: 'a' }, { path: 'b' }], [{ path: 'b', status: 'changed' }])
    assert.equal(out[0]?.status, 'failed')
    assert.deepEqual(out[1], { path: 'b', status: 'changed' })
  })
  test('only the targets whose file was replaced leave the results', () => {
    const outcomes: ReplaceOutcome[] = [
      { path: 'a', status: 'replaced', count: 2 }, { path: 'b', status: 'changed' }, { path: 'c', status: 'failed', message: 'x' },
      { path: 'd', status: 'missing' }, { path: 'e', status: 'refused' },
    ]
    assert.deepEqual(toRemove(['a', 'b', 'c', 'd', 'e'].map(p => ({ path: p, element: p.toUpperCase() })), outcomes), ['A'])
  })
  test('a single match replaced keeps the count line; anything else gets the summary', () => {
    assert.equal(isQuietSingle('match', [{ path: 'a', status: 'replaced', count: 1 }]), true)
    assert.equal(isQuietSingle('match', [{ path: 'a', status: 'changed' }]), false)
    assert.equal(isQuietSingle('many', [{ path: 'a', status: 'replaced', count: 1 }]), false)
  })
})

describe('the summary', () => {
  test('counts, singular and plural, pt-BR numbers', () => {
    assert.equal(replacedLine(1, 1), '1 ocorrência substituída em 1 arquivo.')
    assert.equal(replacedLine(2, 1), '2 ocorrências substituídas em 1 arquivo.')
    assert.equal(replacedLine(1, 2), '1 ocorrência substituída em 2 arquivos.')
    assert.equal(replacedLine(5000, 1000), '5.000 ocorrências substituídas em 1.000 arquivos.')
  })
  test('everything replaced: one line', () => {
    assert.deepEqual(replaceSummary([{ path: 'C:\\p\\a.ts', status: 'replaced', count: 3 }, { path: '/p/b.ts', status: 'replaced', count: 1 }]),
      [{ text: '4 ocorrências substituídas em 2 arquivos.', tone: 'info' }])
  })
  test('one file changed after the search', () => {
    assert.deepEqual(replaceSummary([{ path: 'a.ts', status: 'replaced', count: 1 }, { path: 'C:\\p\\b.ts', status: 'changed' }]), [
      { text: '1 ocorrência substituída em 1 arquivo.', tone: 'info' },
      { text: '1 arquivo mudou depois da pesquisa e foi pulado: b.ts. Pesquise de novo para atualizar.', tone: 'warning' },
    ])
  })
  test('many changed: five names, then "e mais X"', () => {
    const changed: ReplaceOutcome[] = Array.from({ length: 8 }, (_, i) => ({ path: `/p/f${i}.ts`, status: 'changed' }))
    const lines = replaceSummary(changed)
    assert.equal(lines[0]?.text, NOTHING_REPLACED)
    assert.equal(lines[1]?.text, '8 arquivos mudaram depois da pesquisa e foram pulados: f0.ts, f1.ts, f2.ts, f3.ts, f4.ts e mais 3. Pesquise de novo para atualizar.')
  })
  test('missing, refused and failed, each with its line', () => {
    const lines = replaceSummary([
      { path: '/p/a.ts', status: 'missing' }, { path: '/p/b.ts', status: 'missing' }, { path: '/q/c.ts', status: 'refused' },
      { path: '/p/d.ts', status: 'failed', message: 'Sem permissão para gravar neste arquivo.' },
    ]).map(l => l.text)
    assert.deepEqual(lines, [
      NOTHING_REPLACED, 'Não encontrados: a.ts, b.ts.', 'Fora das pastas pesquisadas, não alterado: c.ts.',
      'Não foi possível gravar d.ts: Sem permissão para gravar neste arquivo.',
    ])
    assert.equal(replaceSummary([{ path: '/p/a.ts', status: 'missing' }])[1]?.text, 'Não encontrado: a.ts.')
  })
  test('more than five failures: five lines and a count of the rest', () => {
    const lines = replaceSummary(Array.from({ length: 7 }, (_, i) => ({ path: `/p/f${i}`, status: 'failed', message: 'm' }) as ReplaceOutcome))
    assert.equal(lines.length, 1 + 5 + 1)
    assert.equal(lines[6]?.text, 'Mais 2 arquivos não puderam ser gravados.')
    assert.equal(replaceSummary(Array.from({ length: 6 }, (_, i) => ({ path: `/p/f${i}`, status: 'failed', message: 'm' }) as ReplaceOutcome))[6]?.text,
      'Mais 1 arquivo não pôde ser gravado.')
  })
  test('baseName takes both separators', () => {
    assert.equal(baseName('C:\\a\\b\\c.ts'), 'c.ts')
    assert.equal(baseName('/a/b/'), 'b')
  })
})

describe('the confirmation of "Substituir tudo"', () => {
  test('title with the counts, singular and plural', () => {
    assert.equal(replaceAllTitle(1, 1), 'Substituir 1 ocorrência em 1 arquivo?')
    assert.equal(replaceAllTitle(3, 1), 'Substituir 3 ocorrências em 1 arquivo?')
    assert.equal(replaceAllTitle(1234, 12), 'Substituir 1.234 ocorrências em 12 arquivos?')
  })
  test('the new text, or that the found text is erased; the undo note; Cancelar is Enter and Esc', () => {
    const spec = replaceAllConfirmation(3, 2, 'bar')
    assert.equal(spec.message, `Cada ocorrência será trocada por 'bar'. ${UNDO_NOTE}`)
    assert.equal(replaceAllConfirmation(1, 1, 'bar').message, `A ocorrência será trocada por 'bar'. ${UNDO_NOTE}`)
    assert.equal(replaceAllConfirmation(3, 2, '').message, `O texto encontrado será apagado. ${UNDO_NOTE}`)
    assert.deepEqual(spec.choices.map(c => [c.id, c.label]), [['cancel', 'Cancelar'], ['replace', 'Substituir']])
    assert.equal(spec.defaultChoice, 'cancel')
    assert.equal(spec.escChoice, 'cancel')
    assert.equal(spec.situation, 'search.replace-all')
  })
  test('a long replace value shows at most 10 lines', () => {
    const v = Array.from({ length: 12 }, (_, i) => `l${i}`).join('\n')
    assert.match(replaceAllConfirmation(1, 1, v).message ?? '', /l9\n…'/)
  })
})
