// The text search manager port (app/main/vscode-text-search-manager.ts): the batched collector with a mocked clock,
// the limit and glob filtering with a fake provider, and the whole query against the real rg over two roots.
import { after, before, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findRipgrep } from '../../app/main/file-index.ts'
import { RipgrepTextSearchEngine, type TextSearchProviderOptions, type TextSearchQuery2 } from '../../app/main/vscode-ripgrep-text-search.ts'
import { BatchedCollector, type ITextSearchProvider, TextSearchManager, toCanonicalName } from '../../app/main/vscode-text-search-manager.ts'
import {
  deserializeSearchError, type IFileMatch, type ITextQuery, type ITextSearchMatch, type ITextSearchResult, OneLineRange,
  QueryType, SearchErrorCode,
} from '../../app/shared/vscode-search.ts'

describe('BatchedCollector', () => {
  test('one by one until 50, then batches of maxBatchSize, or on the 4 s timeout', () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      const batches: number[][] = []
      const c = new BatchedCollector<number>(512, items => batches.push(items))
      for (let i = 1; i <= 50; i++) c.addItem(i, 1) // items are truthy: addItem drops a falsy one
      assert.equal(batches.length, 50, 'every item flushed while fewer than 50 were completed')

      for (let i = 1; i <= 511; i++) c.addItem(i, 1)
      assert.equal(batches.length, 50, 'batching now')
      c.addItem(511, 1)
      assert.equal(batches.length, 51)
      assert.equal(batches[50]!.length, 512, 'a full batch of 512')

      c.addItem(1, 10)
      mock.timers.tick(3999)
      assert.equal(batches.length, 51)
      mock.timers.tick(1)
      assert.equal(batches.length, 52, 'timeout flush')
      assert.deepEqual(batches[51], [1])

      c.addItem(2, 1)
      c.flush()
      assert.equal(batches.length, 53)
      mock.timers.tick(5000)
      assert.equal(batches.length, 53, 'flush cleared the timer')
    } finally {
      mock.timers.reset()
    }
  })

  test('sizes count, not items', () => {
    const batches: string[][] = []
    const c = new BatchedCollector<string>(512, items => batches.push(items))
    c.addItem('big', 49)
    c.addItem('next', 1)
    assert.equal(batches.length, 2)
    c.addItem('batched', 1) // 50 completed: now waits
    assert.equal(batches.length, 2)
    c.flush()
    assert.equal(batches.length, 3)
  })
})

test('toCanonicalName', () => {
  assert.equal(toCanonicalName('utf16le'), 'utf-16le')
  assert.equal(toCanonicalName('windows1252'), 'windows-1252')
  assert.equal(toCanonicalName('utf8bom'), 'utf8')
  assert.equal(toCanonicalName('latin1'), 'latin1')
})

describe('TextSearchManager with a fake provider', () => {
  const root = join(tmpdir(), 'fake-root')
  const match = (rel: string, n: number): ITextSearchMatch => ({
    uri: join(root, rel),
    previewText: 'x'.repeat(n * 2),
    rangeLocations: Array.from({ length: n }, (_, i) => ({ source: new OneLineRange(0, i * 2, i * 2 + 1), preview: new OneLineRange(0, i * 2, i * 2 + 1) })),
  })

  function fake(results: ITextSearchResult[]) {
    const calls: { query: TextSearchQuery2; options: TextSearchProviderOptions; signal?: AbortSignal }[] = []
    const provider: ITextSearchProvider = {
      async provideTextSearchResults(query, options, onResult, signal) {
        calls.push({ query, options, signal })
        for (const r of results) onResult(r)
        return { limitHit: false }
      },
    }
    return { provider, calls }
  }

  const query = (extra: Partial<ITextQuery> = {}): ITextQuery => ({
    type: QueryType.Text,
    contentPattern: { pattern: 'x' },
    folderQueries: [{ folder: root }],
    ...extra,
  })

  test('the limit trims the match that crosses it and aborts the provider', async () => {
    const { provider, calls } = fake([match('a.txt', 2), match('b.txt', 5), match('c.txt', 1)])
    const files: IFileMatch[] = []
    const complete = await new TextSearchManager(query({ maxResults: 4 }), provider).search(m => files.push(...m))
    assert.equal(complete.limitHit, true)
    assert.deepEqual(files.map(f => [f.resource, f.results!.length]), [[join(root, 'a.txt'), 1], [join(root, 'b.txt'), 1]])
    assert.equal((files[1]!.results![0] as ITextSearchMatch).rangeLocations.length, 2)
    assert.equal(calls[0]!.signal!.aborted, true)
    assert.equal(calls[0]!.options.maxResults, 4)
  })

  test('results are filtered by the query globs; consecutive results of a file are grouped', async () => {
    const { provider, calls } = fake([
      match('src/a.ts', 1), { uri: join(root, 'src/a.ts'), text: 'ctx', lineNumber: 2 }, match('src/a.ts', 1),
      match('src/b.js', 1), match('out/c.ts', 1),
    ])
    const files: IFileMatch[] = []
    await new TextSearchManager(query({
      includePattern: { '**/*.ts': true, '**/*.md': false },
      excludePattern: { 'out/**': true, '!keep': true, 'sib': { when: '$(basename).ts' } },
    }), provider).search(m => files.push(...m))
    assert.deepEqual(files.map(f => [f.resource, f.results!.length]), [[join(root, 'src/a.ts'), 3]])
    assert.deepEqual(files[0]!.results![1], { text: 'ctx', lineNumber: 2 })
    const fo = calls[0]!.options.folderOptions[0]!
    assert.deepEqual(fo.includes, ['**/*.ts'])
    assert.deepEqual(fo.excludes, ['out/**'], 'exceptions and sibling clauses are not passed to rg')
  })

  test('folder options from the folder query', async () => {
    const { provider, calls } = fake([])
    await new TextSearchManager(query({
      folderQueries: [{
        folder: root, disregardIgnoreFiles: true, disregardParentIgnoreFiles: true, ignoreSymlinks: true,
        fileEncoding: 'shiftjis', excludePattern: [{ pattern: { 'a/**': true } }, { pattern: { 'b': true } }],
        includePattern: { [join(root, 'inside', '**')]: true },
      }],
      excludePattern: { g: true },
    }), provider).search(() => {})
    const fo = calls[0]!.options.folderOptions[0]!
    assert.deepEqual(fo.useIgnoreFiles, { local: false, parent: false, global: true })
    assert.equal(fo.followSymlinks, false)
    assert.equal(fo.encoding, 'shift-jis')
    assert.deepEqual(fo.excludes, ['g', 'a/**', 'g', 'b'])
    assert.deepEqual(fo.includes, ['inside/**'], 'an absolute glob inside the folder becomes relative')
  })
})

describe('TextSearchManager with the real rg', () => {
  const rg = findRipgrep()
  let base = ''
  let rootA = ''
  let rootB = ''

  before(() => {
    base = mkdtempSync(join(tmpdir(), 'tether-rg-manager-'))
    rootA = join(base, 'a')
    rootB = join(base, 'b')
    const write = (p: string, content: string) => {
      mkdirSync(join(p, '..'), { recursive: true })
      writeFileSync(p, content)
    }
    write(join(rootA, 'one.txt'), 'needle\nnothing\nneedle needle\n')
    write(join(rootA, 'skip', 'x.txt'), 'needle\n')
    write(join(rootB, 'two.md'), 'a needle here\n')
    write(join(rootB, 'many.txt'), 'needle\n'.repeat(30))
  })

  after(() => {
    rmSync(base, { recursive: true, force: true, maxRetries: 10 })
  })

  const textQuery = (extra: Partial<ITextQuery> = {}): ITextQuery => ({
    type: QueryType.Text,
    contentPattern: { pattern: 'needle' },
    folderQueries: [{ folder: rootA }, { folder: rootB }],
    ...extra,
  })

  const count = (files: IFileMatch[]) => files.reduce((n, f) => n + f.results!.reduce((m, r) => m + ('rangeLocations' in r ? r.rangeLocations.length : 0), 0), 0)

  test('two roots in one query', async () => {
    const files: IFileMatch[] = []
    const complete = await new TextSearchManager(textQuery({ excludePattern: { skip: true } }), new RipgrepTextSearchEngine(rg!)).search(m => files.push(...m))
    assert.equal(complete.limitHit, false)
    assert.deepEqual(complete.stats, { type: 'searchProcess' })
    const byFile = Object.fromEntries(files.map(f => [f.resource, f.results!.length]))
    assert.deepEqual(byFile, { [join(rootA, 'one.txt')]: 2, [join(rootB, 'two.md')]: 1, [join(rootB, 'many.txt')]: 30 })
    assert.equal(count(files), 34)
  })

  test('limit across roots', async () => {
    const files: IFileMatch[] = []
    const complete = await new TextSearchManager(textQuery({ maxResults: 5 }), new RipgrepTextSearchEngine(rg!)).search(m => files.push(...m))
    assert.equal(complete.limitHit, true)
    assert.ok(count(files) <= 5, `${count(files)} results`)
  })

  test('cancel by AbortSignal resolves', async () => {
    const controller = new AbortController()
    controller.abort()
    const files: IFileMatch[] = []
    const complete = await new TextSearchManager(textQuery(), new RipgrepTextSearchEngine(rg!)).search(m => files.push(...m), controller.signal)
    assert.equal(files.length, 0)
    assert.ok(!complete.limitHit)
  })

  test('an rg error reaches the caller readable', async () => {
    await assert.rejects(new TextSearchManager(textQuery({ contentPattern: { pattern: '[', isRegExp: true } }), new RipgrepTextSearchEngine(rg!)).search(() => {}), (err: Error) => {
      const e = deserializeSearchError(err)
      assert.equal(e.code, SearchErrorCode.regexParseError)
      assert.match(e.message, /^Regex parse error/)
      return true
    })
  })
})
