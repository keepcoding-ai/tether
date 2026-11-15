// The search pad's buffer search (extensions/search/renderer/buffer-search.ts): an open model searched as getLocalResults
// does, which models take part, the merge of the disk's batches with what was searched in memory, and a file's
// recomputed results put back into the results model.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyFileResults, bufferInQuery, bufferResults, bufferSearch, DEFAULT_WORD_SEPARATORS, matchCount, mergeDiskBatch, resourceOf,
  type BufferModel,
} from '../../extensions/search/renderer/buffer-search.ts'
import { SearchModel, type FindMatchLike } from '../../app/shared/vscode-search-model.ts'
import { QueryType, resultIsMatch, type IFileMatch, type ITextQuery, type ITextSearchMatch, type ITextSearchResult } from '../../app/shared/vscode-search.ts'

type FindCall = { search: string; isRegex: boolean; matchCase: boolean; separators: string | null; limit: number | undefined }

/** A model whose findMatches behaves as Monaco's for the cases tested (JavaScript regex, word bounds by separators). */
function fakeModel(text: string, path = '/p/a.txt', scheme = 'file'): BufferModel & { calls: FindCall[] } {
  const lines = text.split(/\r?\n/)
  const calls: FindCall[] = []
  const full = lines.join('\n')
  const posOf = (offset: number): { line: number; col: number } => {
    let line = 1
    let start = 0
    for (let i = 0; i < offset; i++) if (full[i] === '\n') { line++; start = i + 1 }
    return { line, col: offset - start + 1 }
  }
  return {
    calls,
    uri: { scheme, fsPath: path },
    getLineContent: l => lines[l - 1] ?? '',
    getLineCount: () => lines.length,
    findMatches(search, _editable, isRegex, matchCase, separators, _capture, limit) {
      calls.push({ search, isRegex, matchCase, separators, limit })
      const source = isRegex ? search : search.replace(/[\\{}*+?|^$.[\]()]/g, '\\$&')
      const re = new RegExp(source, `gmu${matchCase ? '' : 'i'}`)
      const out: FindMatchLike[] = []
      for (const m of full.matchAll(re)) {
        if (m[0] === '') continue
        const s = m.index
        const e = s + m[0].length
        if (separators !== null) {
          const isSep = (ch: string | undefined): boolean => ch === undefined || ch === '\n' || ch === ' ' || separators.includes(ch)
          if (!isSep(full[s - 1]) || !isSep(full[e])) continue
        }
        const a = posOf(s)
        const b = posOf(e)
        out.push({ range: { startLineNumber: a.line, startColumn: a.col, endLineNumber: b.line, endColumn: b.col }, matches: null })
        if (limit !== undefined && out.length >= limit) break
      }
      return out
    },
  }
}

function query(pattern: string, opts: Partial<ITextQuery['contentPattern']> & { maxResults?: number; surroundingContext?: number } = {}): ITextQuery {
  const { maxResults, surroundingContext, ...cp } = opts
  return {
    type: QueryType.Text, folderQueries: [{ folder: '/p' }], contentPattern: { pattern, ...cp },
    previewOptions: { matchLines: 1, charsPerLine: 1000 },
    ...(maxResults !== undefined ? { maxResults } : {}),
    ...(surroundingContext !== undefined ? { surroundingContext } : {}),
  }
}

const matches = (rs: ITextSearchResult[]): ITextSearchMatch[] => rs.filter(resultIsMatch)
/** Each range as "line:startCol-endCol" (one-based, as the tree shows them). */
const ranges = (rs: ITextSearchResult[]): string[] =>
  matches(rs).flatMap(m => m.rangeLocations.map(r => `${r.source.startLineNumber + 1}:${r.source.startColumn + 1}-${r.source.endLineNumber + 1}:${r.source.endColumn + 1}`))

describe('bufferResults', () => {
  test('a literal: the model is asked as getLocalResults asks it', () => {
    const m = fakeModel('foo.bar\nno\nfoo.bar\n')
    const rs = bufferResults(m, query('foo.bar', { maxResults: 10 }))
    assert.deepEqual(ranges(rs), ['1:1-1:8', '3:1-3:8'])
    assert.deepEqual(m.calls, [{ search: 'foo.bar', isRegex: false, matchCase: false, separators: null, limit: 11 }])
    assert.equal(matches(rs)[0]!.previewText, 'foo.bar', 'the preview options trim the line')
  })
  test('a regex', () => {
    const rs = bufferResults(fakeModel('a1 b22 c\n'), query('[a-z]\\d+', { isRegExp: true }))
    assert.deepEqual(ranges(rs), ['1:1-1:3', '1:4-1:7'])
  })
  test('case: off finds both, on only the exact one', () => {
    const m = fakeModel('Foo foo\n')
    assert.deepEqual(ranges(bufferResults(m, query('foo'))), ['1:1-1:4', '1:5-1:8'])
    assert.deepEqual(ranges(bufferResults(m, query('foo', { isCaseSensitive: true }))), ['1:5-1:8'])
  })
  test('whole word: Monaco default separators unless the query names some', () => {
    const m = fakeModel('foo foobar (foo)\n')
    assert.deepEqual(ranges(bufferResults(m, query('foo', { isWordMatch: true }))), ['1:1-1:4', '1:13-1:16'])
    assert.equal(m.calls.at(-1)?.separators, DEFAULT_WORD_SEPARATORS)
    bufferResults(m, query('foo', { isWordMatch: true, wordSeparators: '()' }))
    assert.equal(m.calls.at(-1)?.separators, '()')
  })
  test('several on a line are one result with several ranges', () => {
    const rs = bufferResults(fakeModel('x x x\ny\n'), query('x'))
    assert.equal(matches(rs).length, 1)
    assert.deepEqual(ranges(rs), ['1:1-1:2', '1:3-1:4', '1:5-1:6'])
  })
  test('a multiline match spans its lines', () => {
    const rs = bufferResults(fakeModel('ab\ncd\n'), query('b\\nc', { isRegExp: true }))
    assert.deepEqual(ranges(rs), ['1:2-2:2'])
    assert.equal(matches(rs)[0]!.previewText, 'ab\ncd\n')
  })
  test('the limit: at most maxResults, and the hit is told', () => {
    const m = fakeModel('x\nx\nx\nx\n')
    const r = bufferSearch(m, query('x', { maxResults: 2 }))
    assert.equal(matchCount(r.results), 2)
    assert.equal(r.limitHit, true)
    assert.equal(bufferSearch(m, query('x', { maxResults: 4 })).limitHit, false)
  })
  test('context lines around the matches', () => {
    const rs = bufferResults(fakeModel('a\nb\nX\nc\nd\n'), query('X', { surroundingContext: 1 }))
    assert.deepEqual(rs.map(r => resultIsMatch(r) ? 'match' : `ctx ${(r as { lineNumber: number }).lineNumber}`), ['ctx 2', 'match', 'ctx 4'])
  })
  test('a pattern the model refuses gives nothing, without an error', () => {
    const m = fakeModel('abc\n')
    m.findMatches = () => { throw new SyntaxError('bad') }
    assert.deepEqual(bufferResults(m, query('(?<x', { isRegExp: true })), [])
  })
})

describe('which models take part', () => {
  test('a file the query includes', () => {
    assert.equal(bufferInQuery(fakeModel('', '/p/a.txt'), () => true), true)
    assert.equal(bufferInQuery(fakeModel('', '/p/a.txt'), () => false), false)
  })
  test('not a file (in-memory, diff): out', () => {
    assert.equal(bufferInQuery(fakeModel('', '/x', 'inmemory'), () => true), false)
  })
  test('the path in the searched folder spelling (the drive letter)', () => {
    assert.equal(resourceOf('d:\\w\\p\\a.txt', ['D:\\w\\p'], true), 'D:\\w\\p\\a.txt')
    assert.equal(resourceOf('/w/p/a.txt', ['/w/p/'], false), '/w/p/a.txt')
    assert.equal(resourceOf('/w/P/a.txt', ['/w/p'], false), '/w/P/a.txt', 'case counts where paths are case sensitive')
    assert.equal(resourceOf('/w/pq/a.txt', ['/w/p'], false), '/w/pq/a.txt', 'a folder name prefix is not the folder')
  })
})

const fm = (resource: string, ...lines: number[][]): IFileMatch => ({
  resource,
  results: lines.map(cols => ({
    previewText: 'x\n',
    rangeLocations: cols.map(c => ({ source: { startLineNumber: 0, startColumn: c, endLineNumber: 0, endColumn: c + 1 }, preview: { startLineNumber: 0, startColumn: c, endLineNumber: 0, endColumn: c + 1 } })),
  })),
})

describe('mergeDiskBatch', () => {
  const key = (p: string): string => p.toLowerCase()
  test('the files searched in memory leave the disk batch', () => {
    const r = mergeDiskBatch([fm('/p/A.txt', [0]), fm('/p/b.txt', [0, 2])], new Set(['/p/a.txt']), key, 100)
    assert.deepEqual(r.files.map(f => f.resource), ['/p/b.txt'])
    assert.equal(r.count, 2)
    assert.equal(r.trimmed, false)
  })
  test('the total stays within the limit: the last file is trimmed, the rest dropped', () => {
    const r = mergeDiskBatch([fm('/p/a.txt', [0]), fm('/p/b.txt', [0, 2], [1]), fm('/p/c.txt', [0])], new Set(), key, 2)
    assert.deepEqual(r.files.map(f => [f.resource, matchCount(f.results)]), [['/p/a.txt', 1], ['/p/b.txt', 1]])
    assert.equal(r.count, 2)
    assert.equal(r.trimmed, true)
  })
  test('no room: nothing passes', () => {
    const r = mergeDiskBatch([fm('/p/a.txt', [0])], new Set(), key, 0)
    assert.deepEqual(r.files, [])
    assert.equal(r.trimmed, true)
  })
})

describe('applyFileResults', () => {
  const ROOT = '/r'
  function setup(): SearchModel {
    const model = new SearchModel({ caseInsensitive: false })
    model.query = { type: QueryType.Text, folderQueries: [{ folder: ROOT }], contentPattern: { pattern: 'x' } }
    model.searchResult.add([fm('/r/sub/a.txt', [0], [1]), fm('/r/b.txt', [0])])
    return model
  }
  const fileOf = (m: SearchModel, p: string) => m.searchResult.matches().find(f => f.resource === p)
  test('a file in the tree gets the new matches at once', () => {
    const m = setup()
    applyFileResults(m.searchResult, '/r/sub/a.txt', fm('/r/sub/a.txt', [3, 5]).results!)
    assert.equal(fileOf(m, '/r/sub/a.txt')?.count(), 2)
    assert.equal(m.searchResult.count(), 3)
  })
  test('no match left: the file leaves the tree (its folder too); matches again: it comes back', () => {
    const m = setup()
    applyFileResults(m.searchResult, '/r/sub/a.txt', [])
    assert.equal(fileOf(m, '/r/sub/a.txt'), undefined)
    assert.equal(m.searchResult.fileCount(), 1)
    applyFileResults(m.searchResult, '/r/sub/a.txt', fm('/r/sub/a.txt', [0]).results!)
    assert.equal(fileOf(m, '/r/sub/a.txt')?.count(), 1)
    assert.equal(m.searchResult.fileCount(), 2)
  })
  test('a file that had no match is added', () => {
    const m = setup()
    applyFileResults(m.searchResult, '/r/new.txt', fm('/r/new.txt', [0]).results!)
    assert.equal(fileOf(m, '/r/new.txt')?.count(), 1)
  })
  test('a file with no match and not in the tree: nothing happens', () => {
    const m = setup()
    applyFileResults(m.searchResult, '/r/none.txt', [])
    assert.equal(m.searchResult.fileCount(), 2)
  })
})
