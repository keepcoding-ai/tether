// The search results model port (app/shared/vscode-search-model.ts): the applicable cases of VS Code's
// searchResult.test.ts, searchModel.test.ts and searchViewlet.test.ts (commit 9cc2376778e119f759ff710c1238fdc58d402d7a),
// plus preview cutting, the replace string fallbacks, edits as data, setResults, nested roots, the tree layout with
// intermediate folders, childrenOf, the sort orders and the initial collapse rule.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  childrenOf,
  editorMatchesToTextSearchResults,
  editsOf,
  FileMatch,
  FILE_MATCH_PREFIX,
  FolderMatch,
  FolderMatchNoRoot,
  FolderMatchWithResource,
  FolderMatchWorkspaceRoot,
  getTextSearchMatchWithModelContext,
  lcut,
  Match,
  MATCH_PREFIX,
  SearchModel,
  SearchResult,
  SearchSortOrder,
  searchComparer,
  searchMatchComparer,
  shouldCollapse,
  type IChangeEvent,
  type IRange,
} from '../../app/shared/vscode-search-model.ts'
import { OneLineRange, QueryType, SearchRange, TextSearchMatch, type IFileMatch, type ITextQuery, type ITextSearchMatch } from '../../app/shared/vscode-search.ts'

const ROOT = '/r'
const lineOneRange = new OneLineRange(1, 0, 1)

function textQuery(folders: string[], pattern = '', extra: Partial<ITextQuery['contentPattern']> = {}): ITextQuery {
  return { type: QueryType.Text, contentPattern: { pattern, ...extra }, folderQueries: folders.map(folder => ({ folder })) }
}

function aSearchModel(folders: string[] = [ROOT], pattern = 'x', caseInsensitive = false): SearchModel {
  const model = new SearchModel({ caseInsensitive })
  model.query = textQuery(folders, pattern)
  return model
}

function aSearchResult(folders: string[] = [ROOT]): SearchResult {
  return aSearchModel(folders).searchResult
}

function aRawMatch(resource: string, ...results: ITextSearchMatch[]): IFileMatch {
  return { resource: ROOT + resource, results }
}

/** A file match built directly under the first root (VS Code's test helper aFileMatch). */
function aFileMatch(path: string, searchResult?: SearchResult, ...lineMatches: ITextSearchMatch[]): FileMatch {
  const sr = searchResult ?? aSearchResult()
  const fileMatch = new FileMatch(sr.folderMatches()[0]!, { resource: '/' + path, results: lineMatches }, null)
  fileMatch.createMatches()
  return fileMatch
}

function eqRange(actual: IRange, s: number, sc: number, e: number, ec: number): void {
  assert.deepEqual({ ...actual }, { startLineNumber: s, startColumn: sc, endLineNumber: e, endColumn: ec })
}

function spy<T>(): { calls: T[]; fn: (e: T) => void } {
  const calls: T[] = []
  return { calls, fn: (e: T) => { calls.push(e) } }
}

function populated(): SearchResult {
  const testObject = aSearchResult([ROOT + '/voo', ROOT + '/with'])
  testObject.add([
    aRawMatch('/voo/foo.a', new TextSearchMatch('preview 1', lineOneRange), new TextSearchMatch('preview 2', lineOneRange)),
    aRawMatch('/with/path/bar.b', new TextSearchMatch('preview 3', lineOneRange)),
    aRawMatch('/with/path.c', new TextSearchMatch('preview 4', lineOneRange), new TextSearchMatch('preview 5', lineOneRange)),
  ])
  return testObject
}

/**
 * *voo/ foo.a, beep/{foo.c, boop.c}
 * *with/ path/bar.b, path.c, *test/woo.c   (with/test is its own root)
 * *eep/ bar/goo/foo/here.txt, bar/goo/ooo/there.txt, eyy.y
 */
function populatedForTree(): SearchResult {
  const testObject = aSearchResult([ROOT + '/voo', ROOT + '/with', ROOT + '/with/test', ROOT + '/eep'])
  testObject.add([
    aRawMatch('/voo/foo.a', new TextSearchMatch('preview 1', lineOneRange), new TextSearchMatch('preview 2', lineOneRange)),
    aRawMatch('/voo/beep/foo.c', new TextSearchMatch('preview 1', lineOneRange), new TextSearchMatch('preview 2', lineOneRange)),
    aRawMatch('/voo/beep/boop.c', new TextSearchMatch('preview 3', lineOneRange)),
    aRawMatch('/with/path.c', new TextSearchMatch('preview 4', lineOneRange), new TextSearchMatch('preview 5', lineOneRange)),
    aRawMatch('/with/path/bar.b', new TextSearchMatch('preview 3', lineOneRange)),
    aRawMatch('/with/test/woo.c', new TextSearchMatch('preview 3', lineOneRange)),
    aRawMatch('/eep/bar/goo/foo/here.txt', new TextSearchMatch('preview 6', lineOneRange), new TextSearchMatch('preview 7', lineOneRange)),
    aRawMatch('/eep/bar/goo/ooo/there.txt', new TextSearchMatch('preview 6', lineOneRange), new TextSearchMatch('preview 7', lineOneRange)),
    aRawMatch('/eep/eyy.y', new TextSearchMatch('preview 6', lineOneRange), new TextSearchMatch('preview 7', lineOneRange)),
  ])
  return testObject
}

const folderAt = (parent: FolderMatch, i: number): FolderMatchWithResource => [...parent.folderMatchesIterator()][i]!
const fileAt = (parent: FolderMatch, i: number): FileMatch => [...parent.fileMatchesIterator()][i]!
const names = (els: { name(): string }[]): string[] => els.map(e => e.name())

describe('SearchResult (searchResult.test.ts)', () => {
  test('Line Match', () => {
    const fileMatch = aFileMatch('folder/file.txt')
    const lineMatch = new Match(fileMatch, ['0 foo bar'], new OneLineRange(0, 2, 5), new OneLineRange(1, 0, 5))
    assert.equal(lineMatch.text(), '0 foo bar')
    assert.equal(lineMatch.range().startLineNumber, 2)
    assert.equal(lineMatch.range().endLineNumber, 2)
    assert.equal(lineMatch.range().startColumn, 1)
    assert.equal(lineMatch.range().endColumn, 6)
    assert.equal(lineMatch.id(), MATCH_PREFIX + '/folder/file.txt>[2,1 -> 2,6]foo')
    assert.equal(lineMatch.fullMatchText(), 'foo')
    assert.equal(lineMatch.fullMatchText(true), '0 foo bar')
  })

  test('Line Match - Remove', () => {
    const fileMatch = aFileMatch('folder/file.txt', aSearchResult(), new TextSearchMatch('foo bar', new OneLineRange(1, 0, 3)))
    fileMatch.remove(fileMatch.matches()[0]!)
    assert.equal(fileMatch.matches().length, 0)
  })

  test('File Match', () => {
    let fileMatch = aFileMatch('folder/file.txt')
    assert.equal(fileMatch.matches().length, 0)
    assert.equal(fileMatch.resource, '/folder/file.txt')
    assert.equal(fileMatch.name(), 'file.txt')
    fileMatch = aFileMatch('file.txt')
    assert.equal(fileMatch.resource, '/file.txt')
    assert.equal(fileMatch.name(), 'file.txt')
  })

  test('Match -> FileMatch -> SearchResult hierarchy exists', () => {
    const searchModel = aSearchModel()
    const searchResult = searchModel.searchResult
    const fileMatch = aFileMatch('far/boo', searchResult)
    const lineMatch = new Match(fileMatch, ['foo bar'], new OneLineRange(0, 0, 3), new OneLineRange(1, 0, 3))
    assert.equal(lineMatch.parent(), fileMatch)
    assert.equal(fileMatch.parent(), searchResult.folderMatches()[0])
    assert.equal(fileMatch.parent().searchModel, searchModel)
  })

  test('Adding a raw match will add a file match with line matches', () => {
    const testObject = aSearchResult()
    testObject.add([aRawMatch('/1',
      new TextSearchMatch('preview 1', new OneLineRange(1, 1, 4)),
      new TextSearchMatch('preview 1', new OneLineRange(1, 4, 11)),
      new TextSearchMatch('preview 2', lineOneRange))])
    assert.equal(testObject.count(), 3)
    const actual = testObject.matches()
    assert.equal(actual.length, 1)
    assert.equal(actual[0]!.resource, ROOT + '/1')
    const m = actual[0]!.matches()
    assert.equal(m.length, 3)
    // sorted by position: (2,1) 'preview 2', (2,2) and (2,5) 'preview 1'
    assert.equal(m[0]!.text(), 'preview 2'); eqRange(m[0]!.range(), 2, 1, 2, 2)
    assert.equal(m[1]!.text(), 'preview 1'); eqRange(m[1]!.range(), 2, 2, 2, 5)
    assert.equal(m[2]!.text(), 'preview 1'); eqRange(m[2]!.range(), 2, 5, 2, 12)
  })

  test('Adding multiple raw matches', () => {
    const testObject = aSearchResult()
    testObject.add([
      aRawMatch('/1', new TextSearchMatch('preview 1', new OneLineRange(1, 1, 4)), new TextSearchMatch('preview 1', new OneLineRange(1, 4, 11))),
      aRawMatch('/2', new TextSearchMatch('preview 2', lineOneRange))])
    assert.equal(testObject.count(), 3)
    const actual = testObject.matches()
    assert.equal(actual.length, 2)
    assert.equal(actual[0]!.resource, ROOT + '/1')
    eqRange(actual[0]!.matches()[0]!.range(), 2, 2, 2, 5)
    eqRange(actual[0]!.matches()[1]!.range(), 2, 5, 2, 12)
    assert.equal(actual[1]!.matches().length, 1)
    assert.equal(actual[1]!.matches()[0]!.text(), 'preview 2')
    eqRange(actual[1]!.matches()[0]!.range(), 2, 1, 2, 2)
  })

  test('Dispose disposes matches', () => {
    const testObject = aSearchResult()
    testObject.add([aRawMatch('/1', new TextSearchMatch('preview 1', lineOneRange)), aRawMatch('/2', new TextSearchMatch('preview 2', lineOneRange))])
    let d1 = 0, d2 = 0
    testObject.matches()[0]!.onDispose(() => d1++)
    testObject.matches()[1]!.onDispose(() => d2++)
    testObject.dispose()
    assert.ok(testObject.isEmpty())
    assert.equal(d1, 1)
    assert.equal(d2, 1)
  })

  test('remove triggers change event', () => {
    const testObject = aSearchResult()
    testObject.add([aRawMatch('/1', new TextSearchMatch('preview 1', lineOneRange))])
    const objectToRemove = testObject.matches()[0]!
    const target = spy<IChangeEvent>()
    testObject.onChange(target.fn)
    testObject.remove(objectToRemove)
    assert.deepEqual(target.calls, [{ elements: [objectToRemove], removed: true }])
  })

  test('remove array triggers change event', () => {
    const testObject = aSearchResult()
    testObject.add([aRawMatch('/1', new TextSearchMatch('preview 1', lineOneRange)), aRawMatch('/2', new TextSearchMatch('preview 2', lineOneRange))])
    const arrayToRemove = testObject.matches()
    const target = spy<IChangeEvent>()
    testObject.onChange(target.fn)
    testObject.remove(arrayToRemove)
    assert.deepEqual(target.calls, [{ elements: arrayToRemove, removed: true }])
  })

  test('Removing all line matches and adding back will add file back to result', () => {
    const testObject = aSearchResult()
    testObject.add([aRawMatch('/1', new TextSearchMatch('preview 1', lineOneRange))])
    const target = testObject.matches()[0]!
    const matchToRemove = target.matches()[0]!
    target.remove(matchToRemove)
    assert.ok(testObject.isEmpty())
    target.add(matchToRemove, true)
    assert.equal(testObject.fileCount(), 1)
    assert.equal(testObject.matches()[0], target)
  })

  test('batchRemove should trigger the onChange event correctly', () => {
    const testObject = populated()
    const folderMatch = testObject.folderMatches()[0]!
    const fileMatch = testObject.folderMatches()[1]!.allDownstreamFileMatches()[0]!
    const match = testObject.folderMatches()[1]!.allDownstreamFileMatches()[1]!.matches()[0]!
    const expected = folderMatch.allDownstreamFileMatches().concat([fileMatch, match.parent()])
    const target = spy<IChangeEvent>()
    testObject.onChange(target.fn)
    testObject.batchRemove([folderMatch, fileMatch, match])
    assert.deepEqual(target.calls, [{ elements: expected, removed: true, added: false }])
    assert.equal(testObject.fileCount(), 0)
  })

  test('batchRemove should remove FolderMatchNoRoot (Other files) correctly', () => {
    const testObject = aSearchResult([ROOT + '/workspace'])
    testObject.add([aRawMatch('/workspace/file.txt', new TextSearchMatch('preview 1', lineOneRange))])
    testObject.add([aRawMatch('/other/outside.txt', new TextSearchMatch('preview 2', lineOneRange))])
    const folderMatches = testObject.folderMatches()
    assert.equal(folderMatches.length, 2)
    const otherFilesMatch = folderMatches.find(fm => fm instanceof FolderMatchNoRoot)
    assert.ok(otherFilesMatch)
    assert.equal(otherFilesMatch.allDownstreamFileMatches().length, 1)
    const target = spy<IChangeEvent>()
    testObject.onChange(target.fn)
    testObject.batchRemove([otherFilesMatch])
    assert.equal(target.calls.length, 1)
    assert.equal(otherFilesMatch.allDownstreamFileMatches().length, 0)
  })

  test('folder matches are not retained across queries', () => {
    const testObject = aSearchResult()
    const disposed: FolderMatch[] = []
    const watch = () => testObject.folderMatches().forEach(fm => fm.onDispose(() => disposed.push(fm)))
    const first = testObject.folderMatches()
    watch()
    for (const folder of ['/second', '/third']) {
      testObject.query = textQuery([ROOT + folder])
      testObject.add([])
    }
    testObject.dispose()
    // each root of each query is disposed exactly once
    for (const fm of first) assert.equal(disposed.filter(d => d === fm).length, 1)
  })

  test('Creating a model with nested folders should create the correct structure', () => {
    const testObject = populatedForTree()
    const [root0, root1, root2, root3] = testObject.folderMatches() as FolderMatchWorkspaceRoot[]
    assert.ok(root0 && root1 && root2 && root3)

    const root0Files = root0.allDownstreamFileMatches()
    assert.deepEqual(root0Files, [...root0.fileMatchesIterator(), ...folderAt(root0, 0).fileMatchesIterator()])
    assert.deepEqual(folderAt(root0, 0).allDownstreamFileMatches(), [...folderAt(root0, 0).fileMatchesIterator()])
    assert.equal(fileAt(folderAt(root0, 0), 0).parent(), folderAt(root0, 0))
    assert.equal(folderAt(root0, 0).parent(), root0)
    assert.equal(folderAt(root0, 0).closestRoot, root0)
    root0Files.forEach(e => assert.equal(e.closestRoot, root0))

    // excludes the matches from nested root
    assert.deepEqual(root1.allDownstreamFileMatches(), [...root1.fileMatchesIterator(), ...folderAt(root1, 0).fileMatchesIterator()])
    assert.equal(fileAt(folderAt(root1, 0), 0).parent(), folderAt(root1, 0))
    root1.allDownstreamFileMatches().forEach(e => assert.equal(e.closestRoot, root1))

    assert.deepEqual(root2.allDownstreamFileMatches(), [...root2.fileMatchesIterator()])
    assert.equal(fileAt(root2, 0).parent(), root2)
    assert.equal(fileAt(root2, 0).closestRoot, root2)

    const root3Files = root3.allDownstreamFileMatches()
    const level3 = folderAt(folderAt(root3, 0), 0)
    assert.deepEqual(root3Files, [...root3.fileMatchesIterator(), ...folderAt(level3, 0).fileMatchesIterator(), ...folderAt(level3, 1).fileMatchesIterator()])
    assert.deepEqual(level3.allDownstreamFileMatches(), folderAt(root3, 0).allDownstreamFileMatches())
    assert.equal(fileAt(folderAt(level3, 1), 0).parent(), folderAt(level3, 1))
    assert.equal(folderAt(level3, 1).parent(), level3)
    assert.equal(level3.parent(), folderAt(root3, 0))
    root3Files.forEach(e => assert.equal(e.closestRoot, root3))
  })

  test('Removing an intermediate folder should call OnChange() on all downstream file matches', () => {
    const testObject = populatedForTree()
    const folderMatch = folderAt(folderAt(folderAt(testObject.folderMatches()[3]!, 0), 0), 0)
    const expected = folderMatch.allDownstreamFileMatches()
    const target = spy<IChangeEvent>()
    testObject.onChange(target.fn)
    testObject.remove(folderMatch)
    assert.deepEqual(target.calls, [{ elements: expected, removed: true, added: false, clearingAll: false }])
  })
})

describe('SearchModel (searchModel.test.ts)', () => {
  test('query replacements retain all roots until add, clear or dispose', () => {
    for (const cleanup of ['add', 'clear', 'dispose']) {
      const model = new SearchModel({ caseInsensitive: false })
      const heading = model.searchResult
      const disposals = new Map<FolderMatch, number>()
      for (let i = 0; i < 3; i++) {
        model.query = textQuery([ROOT], 'sample')
        heading.folderMatches().forEach(fm => { disposals.set(fm, 0); fm.onDispose(() => disposals.set(fm, disposals.get(fm)! + 1)) })
        if (i === 0) heading.add([aRawMatch('/sample', new TextSearchMatch('sample', lineOneRange))], true)
      }
      const before = [...disposals.values()]
      if (cleanup === 'add') { heading.add([], true); heading.add([], true) } else if (cleanup === 'clear') heading.clear(true)
      model.dispose()
      assert.deepEqual({ before, after: [...disposals.values()] }, { before: before.map(() => 0), after: before.map(() => 1) }, cleanup)
    }
  })

  test('getReplaceString returns proper replace string for regExpressions', () => {
    const results = [aRawMatch('/1', new TextSearchMatch('preview 1', new OneLineRange(1, 1, 4)), new TextSearchMatch('preview 1', new OneLineRange(1, 4, 11)))]
    const testObject = new SearchModel({ caseInsensitive: false })
    const search = (q: ITextQuery) => { testObject.query = q; testObject.searchResult.add(results) }
    // the first match in position is 'rev' (columns 1..4 of 'preview 1')
    const first = () => testObject.searchResult.matches()[0]!.matches()[0]!

    search(textQuery([ROOT], 're'))
    testObject.replaceString = 'hello'
    assert.equal(first().replaceString, 'hello')

    search(textQuery([ROOT], 're', { isRegExp: true }))
    assert.equal(first().replaceString, 'hello')

    search(textQuery([ROOT], 're(?:vi)', { isRegExp: true }))
    assert.equal(first().replaceString, 'hello')

    search(textQuery([ROOT], 'r(e)(?:vi)', { isRegExp: true }))
    assert.equal(first().replaceString, 'hello')

    search(textQuery([ROOT], 'r(e)(?:vi)', { isRegExp: true }))
    testObject.replaceString = 'hello$1'
    assert.equal(first().replaceString, 'helloe')
    assert.equal(testObject.hasParameters, true)
  })

  test('replace state', () => {
    const model = new SearchModel({ caseInsensitive: false })
    assert.equal(model.replacePattern, null)
    const pattern = (): string | undefined => model.replacePattern?.pattern
    model.replaceString = 'x' // no query yet: no pattern
    assert.equal(model.replacePattern, null)
    let fired = 0
    model.onReplaceTermChanged(() => fired++)
    model.query = textQuery([ROOT], 'a')
    assert.equal(pattern(), 'x')
    model.replaceString = 'y'
    assert.equal(pattern(), 'y')
    assert.equal(fired, 1)
    assert.equal(model.hasParameters, false)
    model.replaceActive = true
    assert.equal(model.isReplaceActive(), true)
    assert.equal(model.searchResult.query, model.query)
  })

  test('replaceString throws without a replace pattern', () => {
    const sr = new SearchResult(null, { caseInsensitive: false })
    sr.query = textQuery([ROOT])
    sr.add([aRawMatch('/1', new TextSearchMatch('foo', new OneLineRange(0, 0, 3)))])
    assert.throws(() => sr.matches()[0]!.matches()[0]!.replaceString, /replacePattern must be set/)
  })
})

describe('Viewlet (searchViewlet.test.ts)', () => {
  test('Data Source', () => {
    const result = aSearchResult()
    result.query = { type: QueryType.Text, contentPattern: { pattern: 'foo' }, folderQueries: [{ folder: ROOT }] }
    result.add([{
      resource: ROOT + '/foo',
      results: [{
        previewText: 'bar',
        rangeLocations: [{
          preview: { startLineNumber: 0, startColumn: 0, endLineNumber: 0, endColumn: 1 },
          source: { startLineNumber: 1, startColumn: 0, endLineNumber: 1, endColumn: 1 },
        }],
      }],
    }])
    const fileMatch = result.matches()[0]!
    const lineMatch = fileMatch.matches()[0]!
    assert.equal(fileMatch.id(), FILE_MATCH_PREFIX + ROOT + '/foo')
    assert.equal(lineMatch.id(), `${MATCH_PREFIX}${ROOT}/foo>[2,1 -> 2,2]b`)
  })

  test('Comparer', () => {
    const fileMatch1 = aFileMatch('/foo')
    const fileMatch2 = aFileMatch('/with/path')
    const fileMatch3 = aFileMatch('/with/path/foo')
    const lineMatch1 = new Match(fileMatch1, ['bar'], new OneLineRange(0, 1, 1), new OneLineRange(0, 1, 1))
    const lineMatch2 = new Match(fileMatch1, ['bar'], new OneLineRange(0, 1, 1), new OneLineRange(2, 1, 1))
    const lineMatch3 = new Match(fileMatch1, ['bar'], new OneLineRange(0, 1, 1), new OneLineRange(2, 1, 1))

    assert.ok(searchMatchComparer(fileMatch1, fileMatch2) < 0)
    assert.ok(searchMatchComparer(fileMatch2, fileMatch1) > 0)
    assert.ok(searchMatchComparer(fileMatch1, fileMatch1) === 0)
    assert.ok(searchMatchComparer(fileMatch2, fileMatch3) < 0)

    assert.ok(searchMatchComparer(lineMatch1, lineMatch2) < 0)
    assert.ok(searchMatchComparer(lineMatch2, lineMatch1) > 0)
    assert.ok(searchMatchComparer(lineMatch2, lineMatch3) === 0)
  })

  test('Advanced Comparer', () => {
    const fileMatch1 = aFileMatch('/with/path/foo10')
    const fileMatch2 = aFileMatch('/with/path2/foo1')
    const fileMatch3 = aFileMatch('/with/path/bar.a')
    const fileMatch4 = aFileMatch('/with/path/bar.b')
    assert.ok(searchMatchComparer(fileMatch1, fileMatch2) < 0)
    assert.ok(searchMatchComparer(fileMatch1, fileMatch2, SearchSortOrder.FileNames) > 0)
    assert.ok(searchMatchComparer(fileMatch3, fileMatch4, SearchSortOrder.Type) < 0)
  })

  test('Cross-type Comparer', () => {
    const searchResult = aSearchResult()
    const folderMatch1 = new FolderMatchWithResource(ROOT + '/voo', '/voo', 0, textQuery([ROOT]), searchResult, searchResult, null)
    const folderMatch2 = new FolderMatchWithResource(ROOT + '/with', '/with', 1, textQuery([ROOT]), searchResult, searchResult, null)
    const fm = (path: string, parent: FolderMatch) => { const f = new FileMatch(parent, { resource: ROOT + path }, null); f.createMatches(); return f }
    const fileMatch1 = fm('/voo/foo.a', folderMatch1)
    const fileMatch2 = fm('/with/path.c', folderMatch2)
    const fileMatch3 = fm('/with/path/bar.b', folderMatch2)

    const lineMatch1 = new Match(fileMatch1, ['bar'], new OneLineRange(0, 1, 1), new OneLineRange(0, 1, 1))
    const lineMatch2 = new Match(fileMatch1, ['bar'], new OneLineRange(0, 1, 1), new OneLineRange(2, 1, 1))
    const lineMatch3 = new Match(fileMatch2, ['barfoo'], new OneLineRange(0, 1, 1), new OneLineRange(0, 1, 1))
    const lineMatch4 = new Match(fileMatch2, ['fooooo'], new OneLineRange(0, 1, 1), new OneLineRange(2, 1, 1))
    const lineMatch5 = new Match(fileMatch3, ['foobar'], new OneLineRange(0, 1, 1), new OneLineRange(2, 1, 1))

    assert.ok(searchComparer(fileMatch1, fileMatch3) < 0)
    assert.ok(searchComparer(fileMatch2, fileMatch3) < 0)
    assert.ok(searchComparer(folderMatch2, fileMatch2) < 0)
    assert.ok(searchComparer(lineMatch4, lineMatch5) < 0)
    assert.ok(searchComparer(lineMatch1, lineMatch3) < 0)
    assert.ok(searchComparer(lineMatch2, folderMatch2) < 0)

    assert.ok(searchComparer(fileMatch1, fileMatch3, SearchSortOrder.FileNames) < 0)
    assert.ok(searchComparer(fileMatch3, fileMatch2, SearchSortOrder.FileNames) < 0)
    assert.ok(searchComparer(fileMatch3, lineMatch4, SearchSortOrder.FileNames) < 0)
    assert.ok(searchComparer(fileMatch3, fileMatch2, SearchSortOrder.Type) < 0)
    assert.ok(searchComparer(fileMatch3, lineMatch4, SearchSortOrder.Type) < 0)
  })
})

describe('Match preview and replace string', () => {
  test('lcut', () => {
    assert.equal(lcut('foo bar', 0), '')
    assert.equal(lcut('foo bar', 7), 'foo bar')
    assert.equal(lcut('foo bar', 3), 'bar')
    assert.equal(lcut('foo bar', 5, '…'), 'foo bar')
    assert.equal(lcut('foo bar baz', 5, '…'), '…bar baz')
    assert.equal(lcut('   foo', 10), 'foo')
  })

  test('preview of a long line cuts before at a word boundary and caps the total at 250', () => {
    const before = 'word '.repeat(20) // 100 chars
    const inside = 'needle'
    const after = 'x'.repeat(400)
    const line = before + inside + after
    const fileMatch = aFileMatch('f.txt')
    const m = new Match(fileMatch, [line], new OneLineRange(0, 100, 106), new OneLineRange(0, 100, 106))
    const p = m.preview()
    assert.equal(p.fullBefore, before)
    assert.ok(p.before.startsWith('…'))
    assert.ok(p.before.length <= 27)
    assert.ok(before.endsWith(p.before.slice(1)))
    assert.equal(p.inside, 'needle')
    assert.equal(p.before.length + p.inside.length + p.after.length, 250)
    assert.equal(m.preview(), p, 'memoized')
  })

  test('preview of a short line keeps it whole', () => {
    const m = new Match(aFileMatch('f.txt'), ['  let foo = 1'], new OneLineRange(0, 6, 9), new OneLineRange(3, 6, 9))
    assert.deepEqual(m.preview(), { before: 'let ', fullBefore: '  let ', inside: 'foo', after: ' = 1' })
  })

  test('multi-line match: rangeInPreview, fullPreviewLines, getMatchString', () => {
    const m = new Match(aFileMatch('f.txt'), ['abc foo', 'bar def', ''], new SearchRange(0, 4, 1, 3), new SearchRange(9, 4, 10, 3))
    assert.equal(m.getMatchString(), 'foo')
    assert.equal(m.fullMatchText(), 'foo\nbar')
    assert.deepEqual(m.fullPreviewLines(), ['abc foo', 'bar def'])
    assert.deepEqual({ ...m.rangeInPreview() }, { startLineNumber: 0, startColumn: 5, endLineNumber: 1, endColumn: 4 })
    eqRange(m.range(), 10, 5, 11, 4)
  })

  function oneMatchModel(pattern: string, previewText: string, preview: SearchRange, opts: { isRegExp?: boolean; isCaseSensitive?: boolean } = {}): { model: SearchModel; match: Match } {
    const model = new SearchModel({ caseInsensitive: false })
    model.query = textQuery([ROOT], pattern, opts)
    model.searchResult.add([{ resource: ROOT + '/a.txt', results: [{ previewText, rangeLocations: [{ preview, source: preview }] }] }])
    return { model, match: model.searchResult.matches()[0]!.matches()[0]! }
  }

  test('regex group', () => {
    const { model, match } = oneMatchModel('(\\w+)@(\\w+)', 'mail ana@host now', new OneLineRange(0, 5, 13), { isRegExp: true })
    model.replaceString = '$2 at $1'
    assert.equal(match.replaceString, 'host at ana')
  })

  test('preserveCase', () => {
    const { model, match } = oneMatchModel('foo', 'x Foo y', new OneLineRange(0, 2, 5))
    model.replaceString = 'bar'
    assert.equal(match.replaceString, 'bar')
    model.preserveCase = true
    assert.equal(match.replaceString, 'Bar')
  })

  test('lookahead falls back to the text with context', () => {
    const { model, match } = oneMatchModel('foo(?=bar)', 'xx foobar', new OneLineRange(0, 3, 6), { isRegExp: true })
    model.replaceString = 'baz'
    assert.equal(match.fullMatchText(), 'foo')
    assert.equal(match.replaceString, 'baz')
  })

  test('\\r\\n falls back to the text without \\r', () => {
    const { model, match } = oneMatchModel('foo\\nbar', 'foo\r\nbar\n', new SearchRange(0, 0, 1, 3), { isRegExp: true })
    model.replaceString = 'X'
    assert.equal(match.fullMatchText(), 'foo\r\nbar')
    assert.equal(match.replaceString, 'X')
  })

  test('no form matches: the raw replace pattern', () => {
    const { model, match } = oneMatchModel('zzz', 'abc', new OneLineRange(0, 0, 3))
    model.replaceString = 'R'
    assert.equal(match.replaceString, 'R')
  })
})

describe('editsOf', () => {
  function model(): SearchModel {
    const m = new SearchModel({ caseInsensitive: false })
    m.query = textQuery([ROOT + '/a', ROOT + '/b'], 'foo')
    m.replaceString = 'bar'
    m.searchResult.add([
      { resource: ROOT + '/a/x.txt', results: [new TextSearchMatch('foo foo', [new OneLineRange(2, 4, 7), new OneLineRange(2, 0, 3)])] },
      { resource: ROOT + '/a/sub/y.txt', results: [new TextSearchMatch('a foo', new OneLineRange(0, 2, 5))] },
      { resource: ROOT + '/b/z.txt', results: [new TextSearchMatch('foo', new OneLineRange(5, 0, 3))] },
    ])
    return m
  }

  test('a match', () => {
    const m = model()
    const match = m.searchResult.matches()[0]!.matches()[1]!
    assert.deepEqual(editsOf(match, m), [{ path: ROOT + '/a/x.txt', edits: [{ range: { startLineNumber: 3, startColumn: 5, endLineNumber: 3, endColumn: 8 }, expected: 'foo', text: 'bar' }] }])
  })

  test('a file, in document order', () => {
    const m = model()
    const edits = editsOf(m.searchResult.matches()[0]!, m)
    assert.equal(edits.length, 1)
    assert.deepEqual(edits[0]!.edits.map(e => e.range.startColumn), [1, 5])
  })

  test('a folder and everything', () => {
    const m = model()
    const rootA = m.searchResult.folderMatches()[0]!
    assert.deepEqual(editsOf(rootA, m).map(f => f.path), [ROOT + '/a/x.txt', ROOT + '/a/sub/y.txt'])
    assert.deepEqual(editsOf(folderAt(rootA, 0), m).map(f => f.path), [ROOT + '/a/sub/y.txt'])
    const all = editsOf(m.searchResult, m)
    assert.deepEqual(all.map(f => f.path), [ROOT + '/a/x.txt', ROOT + '/a/sub/y.txt', ROOT + '/b/z.txt'])
    assert.equal(all.reduce((n, f) => n + f.edits.length, 0), 4)
    assert.ok(all.every(f => f.edits.every(e => e.expected === 'foo' && e.text === 'bar')))
  })

  test('after applying, the caller removes what it replaced', () => {
    const m = model()
    const sr = m.searchResult
    const match = sr.matches()[0]!.matches()[0]!
    sr.remove(match)
    assert.equal(sr.count(), 3)
    sr.remove(sr.matches()[0]!)
    assert.equal(sr.fileCount(), 2)
    sr.remove(sr.folderMatches()[0]!)
    assert.equal(sr.fileCount(), 1)
    sr.remove(sr.folderMatches()[1]!)
    assert.ok(sr.isEmpty())
  })
})

describe('FileMatch.setResults and context', () => {
  test('replaces every match, keeps the removed ones removed, leaves and rejoins the folder', () => {
    const sr = aSearchResult()
    sr.add([aRawMatch('/f.txt', new TextSearchMatch('foo', new OneLineRange(0, 0, 3)), new TextSearchMatch('a foo', new OneLineRange(4, 2, 5)))])
    const file = sr.matches()[0]!
    const removed = file.matches()[1]!
    file.remove(removed)
    const events = spy<IChangeEvent>()
    sr.onChange(events.fn)

    file.setResults([
      new TextSearchMatch('foo', new OneLineRange(1, 0, 3)),
      new TextSearchMatch('a foo', new OneLineRange(4, 2, 5)), // same id as the removed one
      { text: 'ctx', lineNumber: 3 },
    ])
    assert.deepEqual(file.matches().map(m => m.range().startLineNumber), [2])
    assert.deepEqual([...file.context], [[3, 'ctx']])
    assert.deepEqual(events.calls.at(-1), { elements: [file], added: false, removed: false })

    file.setResults([])
    assert.ok(sr.isEmpty())
    assert.equal(events.calls.at(-1)?.removed, true)

    file.setResults([new TextSearchMatch('foo', new OneLineRange(7, 0, 3))])
    assert.equal(sr.matches()[0], file)
    assert.equal(events.calls.at(-1)?.added, true)
  })

  test('context from raw results, first batch and later ones', () => {
    const sr = aSearchResult()
    sr.add([{ resource: ROOT + '/f.txt', results: [{ text: 'before', lineNumber: 1 }, new TextSearchMatch('foo', new OneLineRange(1, 0, 3))] }])
    sr.add([{ resource: ROOT + '/f.txt', results: [{ text: 'later', lineNumber: 9 }, new TextSearchMatch('foo', new OneLineRange(9, 0, 3))] }])
    const file = sr.matches()[0]!
    assert.equal(file.count(), 2)
    assert.deepEqual([...file.context].sort(), [[1, 'before'], [9, 'later']])
  })
})

describe('roots and the tree layout', () => {
  test('nested roots: a file goes to the deepest root', () => {
    const sr = aSearchResult([ROOT + '/with', ROOT + '/with/test'])
    sr.add([aRawMatch('/with/test/deep/woo.c', new TextSearchMatch('a', lineOneRange)), aRawMatch('/with/x.c', new TextSearchMatch('a', lineOneRange))])
    const [outer, inner] = sr.folderMatches()
    assert.deepEqual(outer!.allDownstreamFileMatches().map(f => f.name()), ['x.c'])
    assert.deepEqual(inner!.allDownstreamFileMatches().map(f => f.name()), ['woo.c'])
    assert.equal(folderAt(inner!, 0).name(), 'deep')
  })

  test('files outside every root go to the other files folder', () => {
    const sr = aSearchResult()
    sr.add([{ resource: '/elsewhere/a/b.txt', results: [new TextSearchMatch('a', lineOneRange)] }])
    const other = sr.folderMatches()[1]!
    assert.ok(other instanceof FolderMatchNoRoot)
    assert.equal(other.name(), '')
    assert.equal(other.index(), 2)
    assert.deepEqual(names(other.matches()), ['b.txt'])
  })

  test('case-insensitive with backslashes: routing and lookups ignore case and separator', () => {
    const model = new SearchModel({ caseInsensitive: true })
    model.query = textQuery(['C:\\Work\\Repo'], 'x')
    const sr = model.searchResult
    sr.add([
      { resource: 'c:/work/repo/src/A.ts', results: [new TextSearchMatch('a', lineOneRange)] },
      { resource: 'C:\\Work\\Repo\\SRC\\a.ts', results: [new TextSearchMatch('b', new OneLineRange(4, 0, 1))] },
      { resource: 'C:\\Work\\Repo\\src\\b.ts', results: [new TextSearchMatch('c', lineOneRange)] },
    ])
    const root = sr.folderMatches()[0]!
    assert.equal(root.count(), 1, 'one intermediate folder "src"')
    assert.equal(folderAt(root, 0).fileCount(), 2, 'A.ts merged with a.ts')
    assert.equal(sr.count(), 3)
    assert.equal(folderAt(root, 0).name(), 'src')
    assert.equal(root.getDownstreamFileMatch('C:/WORK/REPO/src/b.ts')?.name(), 'b.ts')
  })

  test('case-sensitive keeps distinct paths apart', () => {
    const sr = aSearchResult([ROOT])
    sr.add([aRawMatch('/A.ts', new TextSearchMatch('a', lineOneRange)), aRawMatch('/a.ts', new TextSearchMatch('a', lineOneRange))])
    assert.equal(sr.fileCount(), 2)
  })

  test('intermediate folders are created on demand and cleaned up when emptied', () => {
    const sr = populatedForTree()
    const eep = sr.folderMatches()[3]!
    const bar = folderAt(eep, 0)
    const goo = folderAt(bar, 0)
    assert.deepEqual(names([...goo.folderMatchesIterator()]), ['foo', 'ooo'])
    assert.equal(eep.recursiveFileCount(), 3)
    // 'preview 6' and 'preview 7' on the same range share a match id (same first letter), as in VS Code
    assert.equal(eep.recursiveMatchCount(), 3)
    assert.equal(eep.count(), 2) // eyy.y + bar

    // remove here.txt match by match: its folder "foo" leaves goo
    const here = fileAt(folderAt(goo, 0), 0)
    here.remove(here.matches())
    assert.deepEqual(names([...goo.folderMatchesIterator()]), ['ooo'])

    // remove there.txt as a file: ooo, goo and bar cascade away
    sr.remove(fileAt(folderAt(goo, 0), 0))
    assert.equal(eep.folderCount(), 0)
    assert.ok(bar.isDisposed && goo.isDisposed)
    assert.deepEqual(names(eep.matches()), ['eyy.y'])

    // removing a folder through its parent removes its files and the folder
    const voo = sr.folderMatches()[0]!
    voo.remove(folderAt(voo, 0))
    assert.equal(voo.folderCount(), 0)
    assert.deepEqual(names(voo.matches()), ['foo.a'])
  })

  test('clear drops the roots; a new query brings them back', () => {
    const model = aSearchModel()
    model.searchResult.add([aRawMatch('/1', new TextSearchMatch('a', lineOneRange))])
    model.searchResult.clear()
    assert.equal(model.searchResult.folderMatches().length, 0)
    model.query = textQuery([ROOT], 'x')
    model.searchResult.add([aRawMatch('/1', new TextSearchMatch('a', lineOneRange))])
    assert.equal(model.searchResult.count(), 1)
  })

  test('isDirty after a partial removal', () => {
    const sr = populated()
    assert.equal(sr.isDirty, false)
    sr.remove(sr.matches()[0]!)
    assert.equal(sr.isDirty, true)
  })
})

describe('childrenOf', () => {
  const list = { tree: false, sortOrder: SearchSortOrder.Default }
  const tree = { tree: true, sortOrder: SearchSortOrder.Default }

  test('one root with results: the root is omitted, list shows every file below it', () => {
    const sr = aSearchResult([ROOT])
    sr.add([aRawMatch('/b/z.txt', new TextSearchMatch('a', lineOneRange)), aRawMatch('/a.txt', new TextSearchMatch('a', lineOneRange)), aRawMatch('/b/y.txt', new TextSearchMatch('a', lineOneRange))])
    const children = childrenOf(sr, list)
    assert.ok(children.every(c => c instanceof FileMatch))
    assert.deepEqual(children.map(c => (c as FileMatch).resource), [ROOT + '/a.txt', ROOT + '/b/y.txt', ROOT + '/b/z.txt'])
  })

  test('one root in tree mode: folders first, then files', () => {
    const sr = aSearchResult([ROOT])
    sr.add([aRawMatch('/b/z.txt', new TextSearchMatch('a', lineOneRange)), aRawMatch('/a.txt', new TextSearchMatch('a', lineOneRange))])
    const children = childrenOf(sr, tree)
    assert.ok(children[0] instanceof FolderMatchWithResource)
    assert.deepEqual(names(children as FileMatch[]), ['b', 'a.txt'])
    assert.deepEqual(names(childrenOf(children[0]!, tree) as FileMatch[]), ['z.txt'])
  })

  test('two roots: the roots in query order; empty roots hidden', () => {
    const sr = aSearchResult([ROOT + '/z', ROOT + '/a', ROOT + '/empty'])
    sr.add([aRawMatch('/a/1.txt', new TextSearchMatch('a', lineOneRange)), aRawMatch('/z/2.txt', new TextSearchMatch('a', lineOneRange))])
    const roots = childrenOf(sr, list)
    assert.deepEqual(names(roots as FolderMatch[]), ['z', 'a'])
    assert.deepEqual(names(childrenOf(roots[0]!, list) as FileMatch[]), ['2.txt'])
  })

  test('a file lists its matches by position; a match has no children', () => {
    const sr = aSearchResult()
    sr.add([aRawMatch('/f', new TextSearchMatch('x', new OneLineRange(9, 0, 1)), new TextSearchMatch('y', new OneLineRange(2, 0, 1)))])
    const file = sr.matches()[0]!
    const matches = childrenOf(file, list) as Match[]
    assert.deepEqual(matches.map(m => m.range().startLineNumber), [3, 10])
    assert.deepEqual(childrenOf(matches[0]!, list), [])
  })

  test('sort orders', () => {
    const sr = aSearchResult([ROOT])
    sr.add([
      aRawMatch('/b/foo10.ts', new TextSearchMatch('a', lineOneRange)),
      aRawMatch('/a/foo2.md', new TextSearchMatch('a', lineOneRange), new TextSearchMatch('b', new OneLineRange(2, 0, 1)), new TextSearchMatch('c', new OneLineRange(3, 0, 1))),
      aRawMatch('/c/foo1.js', new TextSearchMatch('a', lineOneRange), new TextSearchMatch('b', new OneLineRange(2, 0, 1))),
    ])
    const order = (sortOrder: SearchSortOrder) => names(childrenOf(sr, { tree: false, sortOrder }) as FileMatch[])
    assert.deepEqual(order(SearchSortOrder.Default), ['foo2.md', 'foo10.ts', 'foo1.js'])
    assert.deepEqual(order(SearchSortOrder.FileNames), ['foo1.js', 'foo2.md', 'foo10.ts'])
    assert.deepEqual(order(SearchSortOrder.Type), ['foo1.js', 'foo2.md', 'foo10.ts'])
    assert.deepEqual(order(SearchSortOrder.CountDescending), ['foo2.md', 'foo1.js', 'foo10.ts'])
    assert.deepEqual(order(SearchSortOrder.CountAscending), ['foo10.ts', 'foo1.js', 'foo2.md'])
    assert.deepEqual(order(SearchSortOrder.Modified), order(SearchSortOrder.Default))
    // intermediate folders (index -1) follow the order too
    const folders = (sortOrder: SearchSortOrder) => names(childrenOf(sr, { tree: true, sortOrder }) as FolderMatch[])
    assert.deepEqual(folders(SearchSortOrder.Default), ['a', 'b', 'c'])
  })
})

describe('shouldCollapse (search.collapseResults)', () => {
  test('auto collapses more than 10, the others are fixed', () => {
    const sr = aSearchResult()
    const many = Array.from({ length: 11 }, (_, i) => new TextSearchMatch('a', new OneLineRange(i, 0, 1)))
    sr.add([aRawMatch('/big', ...many), aRawMatch('/small', ...many.slice(0, 10))])
    const [big, small] = sr.matches()
    assert.equal(shouldCollapse(big!, 'auto'), true)
    assert.equal(shouldCollapse(small!, 'auto'), false)
    assert.equal(shouldCollapse(big!, 'alwaysExpand'), false)
    assert.equal(shouldCollapse(small!, 'alwaysCollapse'), true)
    assert.equal(shouldCollapse(big!.matches()[0]!, 'auto'), false)
  })
})

describe('searchHelpers', () => {
  const lines = ['zero', 'one foo', 'two', 'three foo foo', 'four', 'five', 'six foo']
  const model = { getLineContent: (n: number) => lines[n - 1]!, getLineCount: () => lines.length }
  const r = (l: number, s: number, e: number) => ({ range: { startLineNumber: l, startColumn: s, endLineNumber: l, endColumn: e } })

  test('editorMatchesToTextSearchResults groups matches on the same line', () => {
    const results = editorMatchesToTextSearchResults([r(2, 5, 8), r(4, 7, 10), r(4, 11, 14)], model)
    assert.equal(results.length, 2)
    assert.equal(results[0]!.previewText, 'one foo\n')
    assert.equal(results[1]!.rangeLocations.length, 2)
    assert.deepEqual({ ...results[1]!.rangeLocations[1]!.source }, { startLineNumber: 3, startColumn: 10, endLineNumber: 3, endColumn: 13 })
  })

  test('getTextSearchMatchWithModelContext interleaves context lines', () => {
    const matches = editorMatchesToTextSearchResults([r(2, 5, 8), r(4, 7, 10), r(7, 5, 8)], model)
    const results = getTextSearchMatchWithModelContext(matches, model, { surroundingContext: 1 })
    const shape = results.map(x => 'lineNumber' in x ? `ctx${x.lineNumber}` : 'match')
    // VS Code repeats a line that is both after-context of one match and before-context of the next
    assert.deepEqual(shape, ['ctx1', 'match', 'ctx3', 'ctx3', 'match', 'ctx5', 'ctx6', 'match'])
    assert.deepEqual(getTextSearchMatchWithModelContext(matches, model, {}).length, 3)
  })

  test('the buffer results feed setResults', () => {
    const sr = aSearchResult()
    sr.add([{ resource: ROOT + '/open.txt', results: [new TextSearchMatch('foo', new OneLineRange(0, 0, 3))] }])
    const file = sr.matches()[0]!
    const matches = editorMatchesToTextSearchResults([r(2, 5, 8), r(7, 5, 8)], model)
    file.setResults(getTextSearchMatchWithModelContext(matches, model, { surroundingContext: 1 }))
    assert.deepEqual(file.matches().map(m => m.range().startLineNumber), [2, 7])
    assert.deepEqual(file.matches().map(m => m.text()), ['one foo', 'six foo'])
    assert.equal(file.context.get(3), 'two')
  })
})
