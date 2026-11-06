// Quick Open (Ctrl+P): the scorer ported from VS Code (cases copied from its own fuzzyScorer.test.ts, same
// commit as the port), the `:line:col` suffix, the history, the file listing with its fallbacks (rg, git, own
// walk), the index's search (recents on top, the prefix cache, the result cap) and what opening a file means.
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'
import { compareItemsByFuzzyScore, type FuzzyScore, type IItemAccessor, prepareQuery, scoreFuzzy, scoreItemFuzzy } from '../../app/shared/vscode-fuzzy-scorer.ts'
import { failedResult, fileIcon, listFailureText, parseLineSuffix, pushHistory, readHistory } from '../../app/shared/quick-open.ts'
import { QuickOpenService } from '../../extensions/quick-open/service.ts'
import { SearchCache, top } from '../../app/main/vscode-raw-search.ts'
import { Shard, slices } from '../../app/main/file-index-shard.ts'
import { type FileEntry, FileIndex, findRipgrep, inspectFile, listFiles, MAX_EDITOR_BYTES, rankFiles, fileEntry, walkFiles } from '../../app/main/file-index.ts'

// ---------- the scorer (VS Code's own cases) ----------

/** VS Code's URI.file(p).fsPath: absolute, platform separators. */
const file = (p: string): string => (p.startsWith('/') ? p : `/${p}`).replace(/\//g, sep)
const ResourceAccessor: IItemAccessor<string> = { getItemLabel: r => basename(r), getItemDescription: r => dirname(r), getItemPath: r => r }

function _doScore(target: string, query: string, allowNonContiguousMatches?: boolean): FuzzyScore {
  const preparedQuery = prepareQuery(query)
  return scoreFuzzy(target, preparedQuery.normalized, preparedQuery.normalizedLowercase, allowNonContiguousMatches ?? !preparedQuery.expectContiguousMatch)
}
const scoreItem = (item: string, query: string) => scoreItemFuzzy(item, prepareQuery(query), true, ResourceAccessor, Object.create(null))
const compareItemsByScore = (a: string, b: string, query: string) => compareItemsByFuzzyScore(a, b, prepareQuery(query), true, ResourceAccessor, Object.create(null))

test('vscode scorer: score (fuzzy) ordering', () => {
  const target = 'HelLo-World'
  const scores: FuzzyScore[] = []
  for (const q of ['HelLo-World', 'hello-world', 'HW', 'hw', 'H', 'h', 'W', 'Ld', 'ld', 'w', 'L', 'l', '4']) scores.push(_doScore(target, q, true))
  const sortedScores = scores.concat().sort((a, b) => b[0] - a[0])
  assert.deepStrictEqual(scores, sortedScores)
})

test('vscode scorer: score (non fuzzy)', () => {
  const target = 'HelLo-World'
  assert.ok(_doScore(target, 'HelLo-World', false)[0] > 0)
  assert.strictEqual(_doScore(target, 'HelLo-World', false)[1].length, 'HelLo-World'.length)
  assert.ok(_doScore(target, 'hello-world', false)[0] > 0)
  assert.strictEqual(_doScore(target, 'HW', false)[0], 0)
  assert.ok(_doScore(target, 'h', false)[0] > 0)
  assert.ok(_doScore(target, 'ello', false)[0] > 0)
  assert.ok(_doScore(target, 'ld', false)[0] > 0)
  assert.strictEqual(_doScore(target, 'eo', false)[0], 0)
})

test('vscode scorer: scoreItem - optimize for file paths', () => {
  const pathRes = scoreItem(file('/xyz/others/spath/some/xsp/file123.txt'), 'xspfile123')
  assert.ok(pathRes.score)
  assert.deepStrictEqual(pathRes.labelMatch, [{ start: 0, end: 7 }])
  assert.deepStrictEqual(pathRes.descriptionMatch, [{ start: 23, end: 26 }])
})

test('vscode scorer: scoreItem - avoid match scattering (bug #36119) and prefers more compact matches', () => {
  const a = scoreItem(file('projects/ui/cula/ats/target.mk'), 'tcltarget.mk')
  assert.ok(a.score)
  assert.deepStrictEqual(a.labelMatch, [{ start: 0, end: 9 }])
  const b = scoreItem(file('/1a111d1/11a1d1/something.txt'), 'ad')
  assert.ok(b.score)
  assert.ok(!b.labelMatch!.length)
  assert.deepStrictEqual(b.descriptionMatch, [{ start: 11, end: 12 }, { start: 13, end: 14 }])
})

test('vscode scorer: compareFilesByScore - basename prefix', () => {
  const A = file('/some/path/fileA.txt'), B = file('/some/path/other/fileB.txt'), C = file('/unrelated/some/path/other/fileC.txt')
  for (const [query, expected] of [[basename(A), [A, B, C]], [basename(B), [B, A, C]]] as const) {
    assert.deepStrictEqual([A, B, C].sort((r1, r2) => compareItemsByScore(r1, r2, query)), expected)
    assert.deepStrictEqual([C, B, A].sort((r1, r2) => compareItemsByScore(r1, r2, query)), expected)
  }
})

test('vscode scorer: compareFilesByScore - avoid match scattering (bugs #34210, #21019, #26649)', () => {
  const m = 'node_modules1/bundle/lib/model/modules/'
  const [A, B, C, D] = ['ot1', 'un1', 'modu1', 'oddl1'].map(d => file(`${m}${d}/index.js`)) as [string, string, string, string]
  assert.strictEqual([A, B, C, D].sort((x, y) => compareItemsByScore(x, y, `modu1${sep}index.js`))[0], C)
  assert.strictEqual([C, B, A, D].sort((x, y) => compareItemsByScore(x, y, `un1${sep}index.js`))[0], B)
  const s1 = file('app/containers/Services/NetworkData/ServiceDetails/ServiceLoad/index.js')
  const s2 = file('app/containers/Services/NetworkData/ServiceDetails/ServiceDistribution/index.js')
  const s3 = file('app/containers/Services/NetworkData/ServiceDetailTabs/ServiceTabs/StatVideo/index.js')
  assert.strictEqual([s1, s2, s3].sort((x, y) => compareItemsByScore(x, y, 'StatVideoindex'))[0], s3)
  const r1 = file('src/build-helper/store/redux.ts'), r2 = file('src/repository/store/redux.ts')
  assert.strictEqual([r1, r2].sort((x, y) => compareItemsByScore(x, y, 'reproreduxts'))[0], r2)
  const p1 = file('photobook/src/components/AddPagesButton/index.js'), p2 = file('photobook/src/components/ApprovalPageHeader/index.js'), p3 = file('photobook/src/canvasComponents/BookPage/index.js')
  assert.strictEqual([p1, p2, p3].sort((x, y) => compareItemsByScore(x, y, 'bookpageIndex'))[0], p3)
})

test('vscode scorer: prepareQuery', () => {
  assert.strictEqual(prepareQuery(' f*a ').normalized, 'fa')
  assert.strictEqual(prepareQuery('main#').normalized, 'main')
  assert.strictEqual(prepareQuery('model Tester.ts').normalized, 'modelTester.ts')
  assert.strictEqual(prepareQuery('Model' + sep + 'Tester.ts').containsPathSeparator, true)
  assert.strictEqual(prepareQuery('"hello"').expectContiguousMatch, true)
  const query = prepareQuery('He*llo World')
  assert.strictEqual(query.normalized, 'HelloWorld')
  assert.strictEqual(query.values?.length, 2)
  assert.strictEqual(query.values?.[0]!.normalized, 'Hello')
})

// ---------- rules ----------

test('quick open: file:line:col suffix', () => {
  assert.deepEqual(parseLineSuffix('app.ts:42'), { query: 'app.ts', position: { line: 42 } })
  assert.deepEqual(parseLineSuffix('x.ts:3:7'), { query: 'x.ts', position: { line: 3, column: 7 } })
  assert.deepEqual(parseLineSuffix('x.ts#12'), { query: 'x.ts', position: { line: 12 } })
  assert.deepEqual(parseLineSuffix('x.ts:'), { query: 'x.ts' })
  assert.deepEqual(parseLineSuffix('x.ts:0'), { query: 'x.ts' })
  assert.deepEqual(parseLineSuffix('main.ts'), { query: 'main.ts' })
  assert.deepEqual(parseLineSuffix('C:\\repo\\main.ts:9'), { query: 'C:\\repo\\main.ts', position: { line: 9 } })
  assert.deepEqual(parseLineSuffix(':5'), { query: ':5' })
})

test('quick open: history keeps the newest on top, no duplicates, capped; malformed storage is empty', () => {
  let h: string[] = []
  h = pushHistory(h, 'C:\\a\\x.ts')
  h = pushHistory(h, 'C:\\a\\y.ts')
  h = pushHistory(h, 'c:\\A\\X.TS')
  assert.deepEqual(h, ['c:\\A\\X.TS', 'C:\\a\\y.ts'])
  assert.equal(pushHistory(Array.from({ length: 300 }, (_, i) => `f${i}`), 'new').length, 200)
  assert.deepEqual(readHistory('{bad'), [])
  assert.deepEqual(readHistory('[1,"a"]'), ['a'])
  assert.equal(fileIcon('appMain.ts'), 'file-ts')
  assert.equal(fileIcon('package.json'), 'brackets-curly')
  assert.equal(fileIcon('LICENSE'), 'file')
})

// ---------- listing and index ----------

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tether-qo-'))
  const files: Record<string, string> = {
    'src/appMain.ts': 'export const a = 1\n',
    'src/apple/map.ts': 'x\n',
    'src/other.ts': 'x\n',
    'docs/readme.md': '# hi\n',
    'ignored.log': 'nope\n',
    'node_modules/dep/index.js': 'x\n',
    '.hidden/config.json': '{}\n',
    '.gitignore': '*.log\n',
  }
  for (const [p, text] of Object.entries(files)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), text) }
  return dir
}

const sorted = (xs: string[]): string[] => [...xs].sort()
const rel = (p: string): string => p.split('/').join(sep)

test('file listing: rg (hidden files in, .gitignore and node_modules out), git fallback, own walk, cap', async () => {
  const dir = tempRepo()
  try {
    const expected = sorted(['.gitignore', '.hidden/config.json', 'docs/readme.md', 'src/appMain.ts', 'src/apple/map.ts', 'src/other.ts'].map(rel))
    if (findRipgrep()) {
      const r = await listFiles(dir)
      assert.equal(r.source, 'rg')
      assert.deepEqual(sorted(r.files), expected) // outside git too: --no-require-git
    }
    const git = spawnSync('git', ['init', '-q'], { cwd: dir })
    if (git.status === 0) {
      const g = await listFiles(dir, { rg: null })
      assert.equal(g.source, 'git')
      assert.deepEqual(sorted(g.files), expected)
    }
    rmSync(join(dir, '.git'), { recursive: true, force: true })
    const w = await listFiles(dir, { rg: null })
    assert.equal(w.source, 'walk')
    // The own walk knows no .gitignore: only VS Code's excluded names stay out.
    assert.deepEqual(sorted(w.files), sorted([...expected, 'ignored.log']))
    const capped = walkFiles(dir, 2)
    assert.equal(capped.files.length, 2)
    assert.equal(capped.truncated, true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('file index: "apma" ranks appMain.ts first; recents on top and not repeated; prefix cache narrows; empty query shows recents', async () => {
  const dir = tempRepo()
  const index = new FileIndex()
  try {
    await index.list(dir)
    const r = index.search(dir, 'apma')
    assert.equal(r.pending, false)
    assert.equal(r.files[0]?.label, 'appMain.ts')
    assert.equal(r.files[0]?.description, 'src')
    assert.deepEqual(r.files[0]?.labelMatch, [{ start: 0, end: 2 }, { start: 3, end: 5 }])
    const recentPath = join(dir, 'src', 'other.ts')
    const withRecent = index.search(dir, 'ts', [recentPath, join(tmpdir(), 'elsewhere.ts')])
    assert.deepEqual(withRecent.recent.map(i => i.path), [recentPath])
    assert.ok(!withRecent.files.some(i => i.path === recentPath))
    const empty = index.search(dir, '', [recentPath])
    assert.deepEqual(empty.recent.map(i => i.label), ['other.ts'])
    assert.deepEqual(empty.files, [])
    assert.deepEqual(index.search(dir, 'apmai').files.map(f => f.label), ['appMain.ts'])
    assert.deepEqual(index.search(dir, 'zzz').files, [])
    // Multi-word: pieces in any order.
    assert.equal(index.search(dir, 'main app').files[0]?.label, 'appMain.ts')
  } finally { index.dispose(); rmSync(dir, { recursive: true, force: true }) }
})

test('file index: the best-score band gives the same answer as sorting everything', () => {
  const entries = Array.from({ length: 3000 }, (_, i) => fileEntry(rel(`d${i % 37}/sub${i % 5}/file${i}.ts`)))
  const all = rankFiles(entries, 'fi1', entries.length).best.map(b => b.entry.rel)
  const top = rankFiles(entries, 'fi1', 50).best.map(b => b.entry.rel)
  assert.deepEqual(top, all.slice(0, 50))
})

test('search session: only the first listing is pending; the folder is not watched; the box opening again lists again', async () => {
  const dir = tempRepo()
  const index = new FileIndex()
  try {
    index.refresh(dir)
    assert.equal(index.search(dir, 'apma').pending, true) // the session's first listing is still running
    await index.list(dir)
    const first = index.search(dir, 'apma')
    assert.equal(first.pending, false)
    assert.equal(first.files[0]?.label, 'appMain.ts')
    // A file created while the box is open changes nothing: no watcher, no re-listing, no pending, no new question.
    writeFileSync(join(dir, 'src', 'apmaNew.ts'), 'x')
    await new Promise(r => setTimeout(r, 1500))
    for (const q of ['a', 'ap', 'apm', 'apma', 'apmaN']) {
      const r = index.search(dir, q)
      assert.equal(r.pending, false, q)
      assert.equal(r.listMs, first.listMs, q)
    }
    assert.ok(!index.search(dir, 'apmaNew').files.some(f => f.label === 'apmaNew.ts'))
    // The box closes (list dropped) and opens again: a new session lists the folder, the new file is in.
    index.close(dir)
    index.refresh(dir)
    assert.equal(index.search(dir, 'apmaNew').pending, true)
    await index.list(dir)
    const again = index.search(dir, 'apmaNew')
    assert.equal(again.pending, false)
    assert.equal(again.files[0]?.label, 'apmaNew.ts')
    // A refresh while the first listing of the session runs is not a second listing.
    index.close(dir)
    index.refresh(dir)
    index.refresh(dir)
    await index.list(dir)
    assert.equal(index.search(dir, 'apma').pending, false)
  } finally { index.dispose(); rmSync(dir, { recursive: true, force: true }) }
})

test('search session: a query that extends the previous one is filtered from its candidates, with the same answer as scoring everything', () => {
  const entries = Array.from({ length: 4000 }, (_, i) => fileEntry(rel(`d${i % 37}/sub${i % 5}/file${i}.ts`)))
  const cache = new SearchCache<FileEntry>()
  let previous = entries.length
  for (const q of ['f', 'fi', 'fi1', 'fi12', 'fi12 d3', 'sub2/fi1']) {
    const candidates = cache.getResultsFromCache(q, entries)
    const incremental = rankFiles(entries, q, 100, cache, candidates)
    cache.put(q, incremental.matches)
    const full = rankFiles(entries, q, 100)
    assert.deepEqual(incremental.best.map(b => b.entry.rel), full.best.map(b => b.entry.rel), q)
    assert.deepEqual(incremental.matches.map(m => m.rel), full.matches.map(m => m.rel), q)
    if (q !== 'sub2/fi1') { assert.ok(candidates.length <= previous, q); previous = candidates.length }
  }
  assert.ok(previous < entries.length) // the chain narrowed the candidates
  // A quoted query never reads a row.
  assert.deepEqual(cache.getResultsFromCache('"fi1', entries).map(m => m.rel), rankFiles(entries, '"fi1', 100).matches.map(m => m.rel))
})

test('search session: top-N selection equals sorting everything with the scorer', () => {
  const xs = Array.from({ length: 500 }, (_, i) => (i * 7919) % 503)
  const cmp = (a: number, b: number): number => a - b
  assert.deepEqual(top(xs, cmp, 20), [...xs].sort(cmp).slice(0, 20))
  assert.deepEqual(top(xs, cmp, 0), [])
  assert.deepEqual(top(xs, cmp, 900), [...xs].sort(cmp))
})

test('opening: text, binary (NUL or extension), too large, runnable, missing, folder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tether-qo-open-'))
  try {
    writeFileSync(join(dir, 'a.ts'), 'const x = 1\n')
    writeFileSync(join(dir, 'blob.dat2'), Buffer.from([1, 2, 0, 3]))
    writeFileSync(join(dir, 'pic.png'), 'not really')
    writeFileSync(join(dir, 'tool.exe'), 'MZ')
    const read = (p: string): Buffer => readFileSync(p)
    assert.equal(inspectFile(join(dir, 'a.ts'), read).kind, 'text')
    assert.equal(inspectFile(join(dir, 'blob.dat2'), read).kind, 'binary')
    assert.deepEqual(inspectFile(join(dir, 'pic.png'), read), { kind: 'binary', size: 10, runnable: false })
    assert.deepEqual(inspectFile(join(dir, 'tool.exe'), read), { kind: 'binary', size: 2, runnable: true })
    assert.deepEqual(inspectFile(join(dir, 'nope.ts'), read), { kind: 'missing' })
    assert.deepEqual(inspectFile(dir, read), { kind: 'folder' })
    const big = inspectFile(join(dir, 'a.ts'), read)
    assert.ok(big.kind === 'text' && big.size < MAX_EDITOR_BYTES)
    writeFileSync(join(dir, 'big.txt'), Buffer.alloc(MAX_EDITOR_BYTES + 1, 0x61))
    assert.equal(inspectFile(join(dir, 'big.txt'), read).kind, 'large')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('rg resolves from the app folder, not from the working directory (a Start Menu launch runs in System32)', () => {
  const fromRepo = findRipgrep()
  if (!fromRepo) return // @vscode/ripgrep not installed for this platform
  const cwd = process.cwd()
  try {
    process.chdir(tmpdir())
    assert.equal(findRipgrep(), fromRepo)
  } finally { process.chdir(cwd) }
})

test('quick open failures reach the box: a worker that does not load or dies answers with the reason; old main named', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tether-qo-worker-'))
  try {
    const missing = new QuickOpenService(join(dir, 'missing-worker.cjs'), dir)
    const r1 = await missing.search(dir, 'x', [])
    assert.ok(r1 && r1.error, 'a worker that cannot load answers with an error')
    assert.equal(r1.pending, false)
    assert.equal(r1.root, dir)
    missing.dispose()

    writeFileSync(join(dir, 'throws.cjs'), "throw new Error('quebrou ao carregar')\n")
    const throws = new QuickOpenService(join(dir, 'throws.cjs'), dir)
    const r2 = await throws.search(dir, 'x', [])
    assert.match(r2?.error ?? '', /quebrou ao carregar/)
    // The next search starts a fresh worker and fails the same way (no request stuck in flight).
    const r3 = await throws.search(dir, 'y', [])
    assert.match(r3?.error ?? '', /quebrou ao carregar/)
    throws.dispose()

    writeFileSync(join(dir, 'exits.cjs'), "require('node:worker_threads').parentPort.on('message', () => process.exit(3))\n")
    const exits = new QuickOpenService(join(dir, 'exits.cjs'), dir)
    assert.match((await exits.search(dir, 'x', []))?.error ?? '', /código 3/)
    exits.dispose()
  } finally { rmSync(dir, { recursive: true, force: true }) }

  assert.match(listFailureText("Error invoking remote method 'ext:quick-open:search': Error: No handler registered for 'ext:quick-open:search'"), /versão anterior.*Reiniciar o app/)
  assert.equal(listFailureText("Error invoking remote method 'ext:quick-open:search': Error: disco cheio"), 'disco cheio')
  assert.deepEqual({ ...failedResult('C:\\r', 'x'), searchMs: 0 }, { root: 'C:\\r', recent: [], files: [], total: 0, source: undefined, truncated: false, pending: false, listMs: undefined, searchMs: 0, error: 'x' })
})

// ---------- parallel scoring ----------

/** A big list with plenty of ties: same file names in many folders, same extensions, varied depth. */
function bigList(n: number): FileEntry[] {
  const names = ['index.ts', 'main.ts', 'README.md', 'package.json', 'claude.md', 'appMain.ts', 'Clause.tsx', 'util.test.ts']
  return Array.from({ length: n }, (_, i) => fileEntry(rel(`pkg${i % 53}/${i % 7 === 0 ? 'src/' : ''}mod${i % 211}/${names[i % names.length]}${i % 13 === 0 ? `.${i}` : ''}`)))
    .filter((e, i, a) => a.findIndex(o => o.rel === e.rel) === i)
}

const PARALLEL_QUERIES = ['C', 'CL', 'CLA', 'CLAU', 'apma', 'index', 'md', 'pkg1 main', 'mod2/index', '"main', 'claude.md', 'zzzz', 'src', 'u t']

test('parallel scoring: the merge of the shards\' tops is the serial top-N, ties included', () => {
  const entries = bigList(16000)
  assert.ok(entries.length > 5000)
  for (const shards of [2, 4]) {
    const parts = slices(entries.map(e => e.rel), shards).map(r => new Shard(r))
    const merge = new SearchCache<FileEntry>()
    for (const max of [512, 50]) {
      for (const q of PARALLEL_QUERIES) {
        const union = parts.flatMap(p => p.top(q, max).rels).map(fileEntry)
        const merged = rankFiles([], q, max, merge, union).best.map(b => b.entry.rel)
        const serial = rankFiles(entries, q, max).best.map(b => b.entry.rel)
        assert.deepEqual(merged, serial, `${shards} shards, max ${max}, "${q}"`)
      }
    }
  }
})

test('parallel scoring: the shards\' session caches narrow a chain of keystrokes with the same answer', () => {
  const entries = bigList(20000)
  const parts = slices(entries.map(e => e.rel), 4).map(r => new Shard(r))
  const merge = new SearchCache<FileEntry>()
  for (const q of ['c', 'cl', 'cla', 'clau', 'claud', 'claude', 'claude m']) {
    const union = parts.flatMap(p => p.top(q, 512).rels).map(fileEntry)
    assert.deepEqual(rankFiles([], q, 512, merge, union).best.map(b => b.entry.rel), rankFiles(entries, q, 512).best.map(b => b.entry.rel), q)
  }
})

test('parallel scoring: FileIndex with shard workers answers like the one-thread FileIndex; a newer search drops the older', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tether-qo-par-'))
  try {
    for (const e of bigList(1500)) { mkdirSync(join(dir, dirname(e.rel)), { recursive: true }); writeFileSync(join(dir, e.rel), '') }
    const workerPath = fileURLToPath(new URL('../../app/main/file-index-shard-worker.ts', import.meta.url))
    const serial = new FileIndex({ rg: null, git: false })
    const par = new FileIndex({ rg: null, git: false, shards: { path: workerPath, size: 3 }, parallelMin: 100 })
    try {
      serial.refresh(dir); par.refresh(dir)
      await serial.list(dir); await par.list(dir)
      let seq = 0
      for (const q of PARALLEL_QUERIES) {
        const a = serial.search(dir, q, [])
        par.noteLatest(++seq)
        const b = await par.searchAsync(dir, q, [], 512, seq)
        assert.ok(b, q)
        assert.deepEqual(b.files, a.files, q)
        assert.equal(b.total, a.total)
      }
      // The older search of two issued back to back is discarded.
      const first = par.searchAsync(dir, 'main', [], 512, seq + 1)
      par.noteLatest(seq + 2)
      const second = par.searchAsync(dir, 'mai', [], 512, seq + 2)
      assert.equal(await first, null)
      assert.deepEqual((await second)?.files, serial.search(dir, 'mai', []).files)
    } finally { serial.dispose(); par.dispose() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
