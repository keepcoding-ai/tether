// The search editor's pure rules (extensions/search/renderer/search-editor-rules.ts).
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  classifyLine, classifyLines, composeDocument, editorsToPrune, emptyDocument, headerLines, labelCandidates, labelFor, ownerOf, searchEditorName, targetColumn,
} from '../../extensions/search/renderer/search-editor-rules.ts'
import { extractSearchQueryFromLines } from '../../app/shared/vscode-search-editor-serialization.ts'

const DOC = [
  '# Query: foo',
  '# Flags: CaseSensitive',
  '# ContextLines: 1',
  '',
  '3 resultados - 2 arquivos',
  '',
  'src/a.ts:',
  '  4  before',
  '  5: let foo = 1',
  '  6  after',
  '',
  ' 12  far',
  '',
  'proj two/b.txt:',
  '  1: foo:',
  'loose text',
  '',
]

describe('classifyLines', () => {
  test('each kind of line', () => {
    const c = classifyLines(DOC)
    assert.deepEqual(c.map(x => x.kind), [
      'header', 'header', 'header', 'empty', 'count', 'empty', 'file', 'context', 'result', 'context', 'empty', 'context', 'empty', 'file', 'result', 'text', 'empty',
    ])
    assert.deepEqual(c[6], { kind: 'file', label: 'src/a.ts' })
    assert.deepEqual(c[8], { kind: 'result', lineNumber: 5, prefix: 5 })
    assert.deepEqual(c[7], { kind: 'context', lineNumber: 4, prefix: 5 })
    assert.deepEqual(c[11], { kind: 'context', lineNumber: 12, prefix: 5 })
    assert.deepEqual(c[13], { kind: 'file', label: 'proj two/b.txt' })
  })

  test('a header line that ends in ":" is still the header; the count line only before the files', () => {
    assert.equal(classifyLines(['# Query: a:', '', 'x.ts:'])[0]?.kind, 'header')
    assert.equal(classifyLine('Nenhum resultado', false, true).kind, 'count')
    assert.equal(classifyLine('1 resultado - 1 arquivo', false, false).kind, 'text')
    assert.equal(classifyLine('O conjunto de resultados contém só parte das ocorrências. Refine a pesquisa.', false).kind, 'count')
    assert.equal(classifyLine('# not header', false).kind, 'text')
  })

  test('the header lines feed the serializer', () => {
    assert.deepEqual(headerLines(DOC), DOC.slice(0, 3))
    const q = extractSearchQueryFromLines(headerLines(DOC))
    assert.equal(q.query, 'foo')
    assert.equal(q.isCaseSensitive, true)
    assert.equal(q.contextLines, 1)
  })
})

describe('ownerOf', () => {
  const c = classifyLines(DOC)
  test('a result or context line belongs to the file line above it (past blank lines)', () => {
    assert.equal(ownerOf(c, 8), 'src/a.ts')
    assert.equal(ownerOf(c, 11), 'src/a.ts')
    assert.equal(ownerOf(c, 14), 'proj two/b.txt')
    assert.equal(ownerOf(c, 6), 'src/a.ts')
  })
  test('nothing above the first file', () => {
    assert.equal(ownerOf(c, 4), undefined)
    assert.equal(ownerOf(c, 0), undefined)
  })
})

describe('labels', () => {
  const one = [{ path: 'C:\\w\\proj', name: 'proj' }]
  const two = [...one, { path: 'C:\\w\\other', name: 'other' }]
  test('labelFor: relative with "/", prefixed by the project name with several, absolute outside', () => {
    assert.equal(labelFor('C:\\w\\proj\\src\\a.ts', one, 'win32'), 'src/a.ts')
    assert.equal(labelFor('C:\\w\\proj\\src\\a.ts', two, 'win32'), 'proj/src/a.ts')
    assert.equal(labelFor('C:\\w\\other\\b.txt', two, 'win32'), 'other/b.txt')
    assert.equal(labelFor('D:\\elsewhere\\c.txt', two, 'win32'), 'D:\\elsewhere\\c.txt')
    assert.equal(labelFor('/r/p/x/y.ts', [{ path: '/r/p', name: 'p' }], 'posix'), 'x/y.ts')
  })
  test('the innermost project holds the file', () => {
    const nested = [{ path: '/r', name: 'r' }, { path: '/r/inner', name: 'inner' }]
    assert.equal(labelFor('/r/inner/a.ts', nested, 'posix'), 'inner/a.ts')
    assert.equal(labelFor('/r/b.ts', nested, 'posix'), 'r/b.ts')
  })
  test('labelCandidates: absolute → itself; name/rel → that project first; rel → each project', () => {
    assert.deepEqual(labelCandidates('D:\\x\\c.txt', two, 'win32'), ['D:\\x\\c.txt'])
    assert.deepEqual(labelCandidates('other/b.txt', two, 'win32'), ['C:\\w\\other\\b.txt', 'C:\\w\\proj\\other\\b.txt', 'C:\\w\\other\\other\\b.txt'])
    assert.deepEqual(labelCandidates('src/a.ts', two, 'win32'), ['C:\\w\\proj\\src\\a.ts', 'C:\\w\\other\\src\\a.ts'])
    assert.deepEqual(labelCandidates('a.ts', [{ path: '/r/p', name: 'p' }], 'posix'), ['/r/p/a.ts'])
    // The project name is compared without case on Windows.
    assert.equal(labelCandidates('OTHER/b.txt', two, 'win32')[0], 'C:\\w\\other\\b.txt')
  })
})

describe('targetColumn', () => {
  test('the first match less the prefix; column 1 without a match or on context', () => {
    const r = classifyLine('  5: let foo = 1', false)
    assert.equal(targetColumn(r, 10), 5) // "foo" starts at column 5 of the file, 10 in the document
    assert.equal(targetColumn(r), 1)
    assert.equal(targetColumn(classifyLine('  4  before', false), 8), 1)
    assert.equal(targetColumn(classifyLine('  123: x', false), 2), 1)
  })
})

describe('search editor files', () => {
  test('name: local date and time, a suffix for the next attempts', () => {
    const d = new Date(2026, 10, 5, 7, 8, 9)
    assert.equal(searchEditorName(d), 'Pesquisa-20261105-070809.code-search')
    assert.equal(searchEditorName(d, 2), 'Pesquisa-20261105-070809-2.code-search')
    assert.equal(searchEditorName(d, 3), 'Pesquisa-20261105-070809-3.code-search')
  })
  test('prune: keeps the most recent, only .code-search files, never the one just written', () => {
    const entries = [
      { name: 'a.code-search', mtimeMs: 1 }, { name: 'b.code-search', mtimeMs: 3 }, { name: 'c.code-search', mtimeMs: 2 },
      { name: 'notes.md', mtimeMs: 0 }, { name: 'new.code-search', mtimeMs: 0 },
    ]
    assert.deepEqual(editorsToPrune(entries, 2, 'new.code-search'), ['c.code-search', 'a.code-search'])
    assert.deepEqual(editorsToPrune(entries, 10), [])
    assert.deepEqual(editorsToPrune(entries, 0, 'new.code-search'), ['b.code-search', 'c.code-search', 'a.code-search'])
    const many = Array.from({ length: 53 }, (_, i) => ({ name: `${String(i).padStart(2, '0')}.code-search`, mtimeMs: i }))
    assert.deepEqual(editorsToPrune(many), ['02.code-search', '01.code-search', '00.code-search'])
  })
})

describe('composeDocument', () => {
  test('header, blank line, body; the ranges move down by the header', () => {
    const doc = composeDocument({ query: 'foo', isCaseSensitive: true }, {
      text: '1 resultado - 1 arquivo\n\na.ts:\n  5: let foo = 1\n',
      matchRanges: [{ startLineNumber: 4, startColumn: 10, endLineNumber: 4, endColumn: 13 }],
    })
    assert.equal(doc.text, '# Query: foo\n# Flags: CaseSensitive\n\n1 resultado - 1 arquivo\n\na.ts:\n  5: let foo = 1\n')
    assert.deepEqual(doc.matchRanges, [{ startLineNumber: 7, startColumn: 10, endLineNumber: 7, endColumn: 13 }])
    assert.equal(doc.text.split('\n')[6]?.slice(9, 12), 'foo')
  })
  test('no results: the header and "Nenhum resultado"', () => {
    assert.equal(emptyDocument({ query: 'x', filesToInclude: '*.ts' }).text, '# Query: x\n# Including: *.ts\n\nNenhum resultado\n')
  })
})
