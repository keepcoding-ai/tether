// Tests for app/shared/vscode-search-editor-serialization.ts. VS Code's source commit
// (9cc2376778e119f759ff710c1238fdc58d402d7a) has no searchEditorSerialization test, so the cases are written from
// the behavior of the serializer.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  contentPatternToSearchConfiguration,
  defaultSearchConfig,
  extractSearchQueryFromLines,
  flattenSearchResultSerializations,
  parseSerializedSearchEditor,
  serializeSearchConfiguration,
  serializeSearchResultForEditor,
} from '../../app/shared/vscode-search-editor-serialization.ts'
import { SearchModel, SearchResult, SearchSortOrder } from '../../app/shared/vscode-search-model.ts'
import { QueryType, SearchRange, TextSearchMatch, type IFileMatch, type ITextQuery, type ITextSearchContext, type ITextSearchMatch } from '../../app/shared/vscode-search.ts'

const ROOT = '/r'
const label = (path: string): string => path.slice(ROOT.length + 1)

function build(raws: IFileMatch[], contentPattern: Partial<ITextQuery['contentPattern']> = {}): SearchResult {
  const model = new SearchModel({ caseInsensitive: false })
  model.query = { type: QueryType.Text, contentPattern: { pattern: 'foo', ...contentPattern }, folderQueries: [{ folder: ROOT }] }
  model.searchResult.add(raws)
  return model.searchResult
}

const file = (name: string, ...results: (ITextSearchMatch | ITextSearchContext)[]): IFileMatch => ({ resource: `${ROOT}/${name}`, results })
// Zero-based line and columns, as the search engine reports them.
const hit = (text: string, line: number, from: number, to: number): TextSearchMatch => new TextSearchMatch(text, new SearchRange(line, from, line, to))
const ctx = (lineNumber: number, text: string): ITextSearchContext => ({ lineNumber, text })

const serialize = (result: SearchResult, ...rest: [limitHit?: boolean]) =>
  serializeSearchResultForEditor(result, '', '', 0, label, SearchSortOrder.Default, ...rest)

describe('serializeSearchResultForEditor', () => {
  test('one match', () => {
    const out = serialize(build([file('a.ts', hit('let foo = 1', 4, 4, 7))]))
    assert.equal(out.text, ['1 resultado - 1 arquivo', '', 'a.ts:', '  5: let foo = 1', ''].join('\n'))
    // Line 4 of the document, columns shifted by the "  5: " prefix (5 chars), base 1.
    assert.deepEqual(out.matchRanges, [{ startLineNumber: 4, startColumn: 10, endLineNumber: 4, endColumn: 13 }])
  })

  test('no results', () => {
    const out = serialize(build([]))
    assert.equal(out.text, 'Nenhum resultado\n')
    assert.deepEqual(out.matchRanges, [])
  })

  test('limit hit adds a warning line', () => {
    const out = serialize(build([file('a.ts', hit('foo', 0, 0, 3))]), true)
    const lines = out.text.split('\n')
    assert.equal(lines[0], '1 resultado - 1 arquivo')
    assert.match(lines[1]!, /parte das ocorrências/)
    assert.equal(lines[2], '')
  })

  test('several matches on the same line: one text line, several ranges', () => {
    const out = serialize(build([file('a.ts', new TextSearchMatch('foo bar foo', [new SearchRange(0, 0, 0, 3), new SearchRange(0, 8, 0, 11)]))]))
    assert.equal(out.text, ['2 resultados - 1 arquivo', '', 'a.ts:', '  1: foo bar foo', ''].join('\n'))
    assert.deepEqual(out.matchRanges, [
      { startLineNumber: 4, startColumn: 6, endLineNumber: 4, endColumn: 9 },
      { startLineNumber: 4, startColumn: 14, endLineNumber: 4, endColumn: 17 },
    ])
  })

  test('multiline match: one range per line', () => {
    const match = new TextSearchMatch('ab\ncd\nef', new SearchRange(0, 1, 2, 1))
    const out = serialize(build([file('a.ts', match)]))
    assert.deepEqual(out.text.split('\n').slice(3, 6), ['  1: ab', '  2: cd', '  3: ef'])
    assert.deepEqual(out.matchRanges, [
      { startLineNumber: 4, startColumn: 7, endLineNumber: 4, endColumn: 8 },
      { startLineNumber: 5, startColumn: 6, endLineNumber: 5, endColumn: 8 },
      { startLineNumber: 6, startColumn: 6, endLineNumber: 6, endColumn: 7 },
    ])
  })

  test('context lines before and after, aligned by the longest line number', () => {
    const out = serialize(build([file('a.ts', ctx(9, 'before'), hit('foo', 9, 0, 3), ctx(11, 'after'))]))
    assert.deepEqual(out.text.split('\n').slice(2), [
      'a.ts:',
      '   9  before',
      '  10: foo',
      '  11  after',
      '',
    ])
    assert.deepEqual(out.matchRanges, [{ startLineNumber: 5, startColumn: 7, endLineNumber: 5, endColumn: 10 }])
  })

  test('a gap between context blocks inserts an empty line', () => {
    const out = serialize(build([file('a.ts', ctx(1, 'one'), hit('foo', 1, 0, 3), ctx(8, 'gap'), hit('foo', 9, 0, 3))]))
    assert.deepEqual(out.text.split('\n').slice(3, 8), ['   1  one', '   2: foo', '', '   8  gap', '  10: foo'])
  })

  test('two files in order, ranges offset per file', () => {
    const out = serialize(build([file('b.ts', hit('foo', 0, 0, 3)), file('a.ts', hit('foo', 2, 0, 3))]))
    assert.equal(out.text, ['2 resultados - 2 arquivos', '', 'a.ts:', '  3: foo', '', 'b.ts:', '  1: foo', ''].join('\n'))
    assert.deepEqual(out.matchRanges.map(r => r.startLineNumber), [4, 7])
  })

  test('config comes from the query', () => {
    const result = build([], { isRegExp: true, isCaseSensitive: true, isWordMatch: true })
    const out = serializeSearchResultForEditor(result, 'src', 'dist', 2, label, SearchSortOrder.Default)
    assert.deepEqual(out.config, {
      query: 'foo', isRegexp: true, isCaseSensitive: true, matchWholeWord: true, filesToInclude: 'src', filesToExclude: 'dist',
      showIncludesExcludes: true, useExcludeSettingsAndIgnoreFiles: true, contextLines: 2, onlyOpenEditors: false,
    })
  })
})

describe('flattenSearchResultSerializations', () => {
  test('appends an empty line after each and offsets ranges', () => {
    const range = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 }
    const out = flattenSearchResultSerializations([{ text: ['a', 'b'], matchRanges: [range] }, { text: ['c'], matchRanges: [range] }])
    assert.deepEqual(out.text, ['a', 'b', '', 'c', ''])
    assert.deepEqual(out.matchRanges.map(r => r.startLineNumber), [1, 4])
  })
})

describe('serializeSearchConfiguration', () => {
  test('only the query when nothing else is set', () => {
    assert.equal(serializeSearchConfiguration({ query: 'x' }), '# Query: x\n')
  })

  test('each flag', () => {
    assert.equal(serializeSearchConfiguration({ query: 'x', isCaseSensitive: true }), '# Query: x\n# Flags: CaseSensitive\n')
    assert.equal(serializeSearchConfiguration({ query: 'x', matchWholeWord: true }), '# Query: x\n# Flags: WordMatch\n')
    assert.equal(serializeSearchConfiguration({ query: 'x', isRegexp: true }), '# Query: x\n# Flags: RegExp\n')
    assert.equal(serializeSearchConfiguration({ query: 'x', isRegexp: true, onlyOpenEditors: true }), '# Query: x\n# Flags: RegExp OpenEditors\n')
    assert.equal(serializeSearchConfiguration({ query: 'x', useExcludeSettingsAndIgnoreFiles: false }), '# Query: x\n# Flags: IgnoreExcludeSettings\n')
  })

  test('includes, excludes and context lines', () => {
    assert.equal(
      serializeSearchConfiguration({ query: 'x', filesToInclude: 'src', filesToExclude: 'dist', contextLines: 3 }),
      '# Query: x\n# Including: src\n# Excluding: dist\n# ContextLines: 3\n',
    )
  })

  test('round trip with every field', () => {
    const config = {
      ...defaultSearchConfig(), query: 'a.*b', isRegexp: true, isCaseSensitive: true, matchWholeWord: true, onlyOpenEditors: true,
      useExcludeSettingsAndIgnoreFiles: false, filesToInclude: 'src', filesToExclude: 'dist', contextLines: 2, showIncludesExcludes: true,
    }
    assert.deepEqual(extractSearchQueryFromLines(serializeSearchConfiguration(config).split('\n')), config)
  })

  test('newline and backslash escapes round trip', () => {
    const query = 'line1\nline2\\n C:\\dir'
    const text = serializeSearchConfiguration({ query })
    assert.equal(text, '# Query: line1\\nline2\\\\n C:\\\\dir\n')
    assert.equal(extractSearchQueryFromLines(text.split('\n')).query, query)
  })

  test('an unescaped backslash is rejected', () => {
    assert.throws(() => extractSearchQueryFromLines(['# Query: a\\b']), /barras invertidas/)
  })
})

describe('contentPatternToSearchConfiguration', () => {
  test('defaults', () => {
    const query: ITextQuery = { type: QueryType.Text, contentPattern: { pattern: 'p' }, folderQueries: [] }
    assert.deepEqual(contentPatternToSearchConfiguration(query, '', '', 0), {
      query: 'p', isRegexp: false, isCaseSensitive: false, matchWholeWord: false, filesToInclude: '', filesToExclude: '',
      showIncludesExcludes: false, useExcludeSettingsAndIgnoreFiles: true, contextLines: 0, onlyOpenEditors: false,
    })
  })

  test('userDisabledExcludesAndIgnoreFiles shows the includes/excludes and drops the exclude settings', () => {
    const query: ITextQuery = { type: QueryType.Text, contentPattern: { pattern: 'p' }, folderQueries: [] }
    const config = contentPatternToSearchConfiguration(query, '', '', 0, true, true)
    assert.equal(config.showIncludesExcludes, true)
    assert.equal(config.useExcludeSettingsAndIgnoreFiles, false)
    assert.equal(config.onlyOpenEditors, true)
  })
})

describe('parseSerializedSearchEditor', () => {
  test('splits header and body at the first empty line (CRLF accepted)', () => {
    const text = ['# Query: foo', '# Flags: RegExp', '# ContextLines: 1', '', '1 resultado - 1 arquivo', '', 'a.ts:', '  1: foo'].join('\r\n')
    const parsed = parseSerializedSearchEditor(text)
    assert.equal(parsed.config.query, 'foo')
    assert.equal(parsed.config.isRegexp, true)
    assert.equal(parsed.config.contextLines, 1)
    assert.equal(parsed.text, ['1 resultado - 1 arquivo', '', 'a.ts:', '  1: foo'].join('\n'))
  })

  test('a header followed by results written by serializeSearchResultForEditor', () => {
    const out = serialize(build([file('a.ts', hit('foo', 0, 0, 3))]))
    const doc = serializeSearchConfiguration(out.config) + '\n' + out.text
    const parsed = parseSerializedSearchEditor(doc)
    assert.equal(parsed.config.query, 'foo')
    assert.equal(parsed.text, out.text)
  })
})
