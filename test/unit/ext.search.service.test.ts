// The search extension's main side under plain Node: the real worker (.ts, run directly), the real rg, temp folders.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { Worker } from 'node:worker_threads'
import { allowedIn, fileQuery, sanitizeQuery, sanitizeReplace, searchFile } from '../../extensions/search/main.ts'
import { findRipgrep } from '../../app/main/file-index.ts'
import { RipgrepTextSearchEngine } from '../../app/main/vscode-ripgrep-text-search.ts'
import { SearchService } from '../../extensions/search/service.ts'
import type { TextSearchWorkerReply } from '../../app/main/text-search-worker.ts'
import { QueryType, type IFileMatch, type ITextQuery } from '../../app/shared/vscode-search.ts'

const WORKER = join(import.meta.dirname, '..', '..', 'app', 'main', 'text-search-worker.ts')
const REPO = join(import.meta.dirname, '..', '..')

let root = ''
let big = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'search-svc-'))
  await mkdir(join(root, 'small'))
  await writeFile(join(root, 'small', 'a.txt'), 'hello needle world\nsecond line\n')
  await writeFile(join(root, 'small', 'b.txt'), 'nothing here\nneedle again\n')
  big = join(root, 'big')
  await mkdir(big)
  // A large file keeps rg busy long enough to cancel it midway.
  await writeFile(join(big, 'huge.txt'), 'x'.repeat(60) + ' haystack line\n'.repeat(1_500_000) + 'zzz\n')
})
after(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

const query = (folder: string, pattern: string, extra: Partial<ITextQuery['contentPattern']> = {}): ITextQuery => ({
  type: QueryType.Text,
  folderQueries: [{ folder }],
  contentPattern: { pattern, ...extra },
  maxResults: 100_000_000,
})

describe('SearchService', () => {
  it('finds matches, reports progress with the right id and ends done', async () => {
    const svc = new SearchService(WORKER, REPO)
    const seen: { id: number; m: IFileMatch[] }[] = []
    const done = await svc.search(7, query(join(root, 'small'), 'needle'), (id, m) => seen.push({ id, m }))
    assert.equal(done.kind, 'done')
    assert.ok(seen.length > 0 && seen.every(s => s.id === 7))
    assert.equal(seen.flatMap(s => s.m).length, 2)
    assert.deepEqual(svc.folders(), [join(root, 'small')])
    await svc.dispose()
  })

  it('a second search cancels the first; nothing of the first arrives later', async () => {
    const svc = new SearchService(WORKER, REPO)
    const first: number[] = []
    const p1 = svc.search(1, query(big, 'haystack'), id => first.push(id))
    const p2 = svc.search(2, query(join(root, 'small'), 'needle'), () => {})
    assert.deepEqual(await p1, { kind: 'cancelled' })
    assert.equal((await p2).kind, 'done')
    const seenBefore = first.length
    await new Promise(r => setTimeout(r, 200))
    assert.equal(first.length, seenBefore)
    assert.ok(first.every(id => id === 1))
    await svc.dispose()
  })

  it('cancel(id) resolves cancelled', async () => {
    const svc = new SearchService(WORKER, REPO)
    const p = svc.search(3, query(big, 'haystack'), () => {})
    await new Promise(r => setTimeout(r, 50))
    svc.cancel(3)
    assert.deepEqual(await p, { kind: 'cancelled' })
    await svc.dispose()
  })

  it('a cancelled search leaves no live search in the worker (its rg ended)', async () => {
    const w = new Worker(WORKER, { workerData: { repo: REPO } })
    const replies: TextSearchWorkerReply[] = []
    const waitFor = (pred: (r: TextSearchWorkerReply) => boolean) => new Promise<TextSearchWorkerReply>(resolve => {
      const hit = replies.find(pred)
      if (hit) { resolve(hit); return }
      const on = (r: TextSearchWorkerReply) => { if (pred(r)) { w.off('message', on); resolve(r) } }
      w.on('message', on)
    })
    w.on('message', (r: TextSearchWorkerReply) => replies.push(r))
    try {
      w.postMessage({ op: 'search', id: 1, query: query(big, 'haystack') })
      await new Promise(r => setTimeout(r, 50))
      w.postMessage({ op: 'alive' })
      assert.equal(((await waitFor(r => 'alive' in r)) as { alive: number }).alive, 1)
      replies.length = 0
      w.postMessage({ op: 'cancel', id: 1 })
      assert.deepEqual(await waitFor(r => 'cancelled' in r), { id: 1, cancelled: true })
      w.postMessage({ op: 'alive' })
      assert.equal(((await waitFor(r => 'alive' in r)) as { alive: number }).alive, 0)
    } finally {
      await w.terminate()
    }
  })

  it('an invalid regex ends in error with the engine code', async () => {
    const svc = new SearchService(WORKER, REPO)
    const done = await svc.search(4, query(join(root, 'small'), '(unclosed', { isRegExp: true }), () => {})
    assert.equal(done.kind, 'error')
    if (done.kind === 'error') assert.equal(done.code, 'regexParseError')
    await svc.dispose()
  })

  it('a worker that does not exist answers with an error; another service still works', async () => {
    const bad = new SearchService(join(root, 'nope.cjs'), REPO)
    const done = await bad.search(5, query(join(root, 'small'), 'needle'), () => {})
    assert.equal(done.kind, 'error')
    if (done.kind === 'error') assert.ok(done.message.length > 0)
    await bad.dispose()
    const good = new SearchService(WORKER, REPO)
    assert.equal((await good.search(6, query(join(root, 'small'), 'needle'), () => {})).kind, 'done')
    await good.dispose()
  })

  it('dispose() with a search running resolves it cancelled and returns', async () => {
    const svc = new SearchService(WORKER, REPO)
    const p = svc.search(8, query(big, 'haystack'), () => {})
    await new Promise(r => setTimeout(r, 50))
    await svc.dispose()
    assert.deepEqual(await p, { kind: 'cancelled' })
  })
})

describe('sanitizeQuery', () => {
  const good = () => ({ type: 2, folderQueries: [{ folder: root }], contentPattern: { pattern: 'x', isRegExp: true } })

  it('accepts a good query and rebuilds it', () => {
    const q = sanitizeQuery({ ...good(), evil: 1, surroundingContext: 500, maxFileSize: 10 })
    assert.ok(q)
    assert.equal(q.type, QueryType.Text)
    assert.equal(q.contentPattern.isRegExp, true)
    assert.equal(q.surroundingContext, 100)
    assert.equal(q.maxResults, 20_000)
    assert.ok(!('evil' in q))
  })

  it('refuses empty pattern, relative or missing folder, empty folderQueries', () => {
    assert.equal(sanitizeQuery({ ...good(), contentPattern: { pattern: '' } }), undefined)
    assert.equal(sanitizeQuery({ ...good(), folderQueries: [{ folder: 'rel/dir' }] }), undefined)
    assert.equal(sanitizeQuery({ ...good(), folderQueries: [{ folder: join(root, 'does-not-exist') }] }), undefined)
    assert.equal(sanitizeQuery({ ...good(), folderQueries: [] }), undefined)
    assert.equal(sanitizeQuery(null), undefined)
  })

  it('clamps maxResults and drops fields of the wrong type', () => {
    assert.equal(sanitizeQuery({ ...good(), maxResults: 9e9 })?.maxResults, 200_000)
    assert.equal(sanitizeQuery({ ...good(), maxResults: -5 })?.maxResults, 1)
    const q = sanitizeQuery({ ...good(), maxResults: 'a', includePattern: { '*.ts': 'yes' }, excludePattern: { '*.js': true }, ignoreGlobCase: 'x', contentPattern: { pattern: 'x', isRegExp: 'true' } })
    assert.ok(q)
    assert.equal(q.maxResults, 20_000)
    assert.equal(q.includePattern, undefined)
    assert.deepEqual(q.excludePattern, { '*.js': true })
    assert.equal(q.ignoreGlobCase, undefined)
    assert.equal(q.contentPattern.isRegExp, undefined)
  })
})

describe('sanitizeReplace', () => {
  it('keeps a well-formed list and returns [] for a malformed one', () => {
    const range = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 }
    const f = join(root, 'a.txt')
    assert.equal(sanitizeReplace([{ path: f, edits: [{ range, expected: 'a', text: 'b' }] }]).length, 1)
    assert.deepEqual(sanitizeReplace([{ path: 'rel', edits: [] }]), [])
    assert.deepEqual(sanitizeReplace([{ path: f, edits: [{ range: { ...range, startColumn: 0 }, expected: 'a', text: 'b' }] }]), [])
  })
})

describe('replace guard (allowedIn)', () => {
  it('allows inside, refuses outside, refuses a link that leads outside', async t => {
    const proj = join(root, 'proj')
    const outside = join(root, 'outside')
    await mkdir(proj)
    await mkdir(outside)
    await writeFile(join(proj, 'in.txt'), 'x')
    await writeFile(join(outside, 'out.txt'), 'x')
    const allowed = allowedIn([proj])
    assert.equal(allowed(join(proj, 'in.txt')), true)
    assert.equal(allowed(join(proj, 'missing.txt')), true)
    assert.equal(allowed(join(outside, 'out.txt')), false)
    assert.equal(allowed('relative.txt'), false)
    try {
      await symlink(outside, join(proj, 'link'), 'junction')
    } catch {
      t.skip('cannot create a link here')
      return
    }
    assert.equal(allowed(join(proj, 'link', 'out.txt')), false)
  })
})

describe('searchFile (one file searched again, in main)', () => {
  const rg = findRipgrep(REPO) ?? findRipgrep()
  const engine = rg ? new RipgrepTextSearchEngine(rg) : undefined
  const lines = (m: IFileMatch | undefined): number[] =>
    (m?.results ?? []).flatMap(r => 'rangeLocations' in r ? r.rangeLocations.map(x => x.source.startLineNumber) : [])

  it('the file query: its folder, its escaped name, no ignore files, the pattern and previews of the search', () => {
    const q: ITextQuery = { ...query(root, 'x'), previewOptions: { matchLines: 1, charsPerLine: 100 }, surroundingContext: 2, includePattern: { '*.md': true }, excludePattern: { '**/a': true } }
    const f = fileQuery(q, join(root, 'small', 'a[1]*.txt'))
    assert.deepEqual(f.folderQueries, [{ folder: join(root, 'small'), includePattern: { 'a[[]1[]][*].txt': true }, disregardIgnoreFiles: true, disregardGlobalIgnoreFiles: true, disregardParentIgnoreFiles: true }])
    assert.deepEqual(f.contentPattern, q.contentPattern)
    assert.deepEqual(f.previewOptions, q.previewOptions)
    assert.equal(f.surroundingContext, 2)
    assert.equal(f.includePattern, undefined, 'the global include is left out')
    assert.equal(f.excludePattern, undefined, 'the global exclude is left out')
  })

  it('finds the matches of that file only, even one an ignore file hides', { skip: !engine }, async () => {
    const dir = join(root, 'one')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'f.txt'), 'pin one\nno\npin pin\n')
    await writeFile(join(dir, 'f.txt.bak'), 'pin\n')
    await writeFile(join(dir, 'other.txt'), 'pin\n')
    await writeFile(join(dir, '.gitignore'), 'f.txt\n')
    const m = await searchFile(engine, query(root, 'pin'), join(dir, 'f.txt'))
    assert.equal(m?.resource, join(dir, 'f.txt'))
    assert.deepEqual(lines(m), [0, 2, 2])
  })

  it('no match: undefined; a file that is gone: undefined', { skip: !engine }, async () => {
    assert.equal(await searchFile(engine, query(root, 'nomatchzz'), join(root, 'small', 'a.txt')), undefined)
    assert.equal(await searchFile(engine, query(root, 'needle'), join(root, 'small', 'gone.txt')), undefined)
  })

  it('refuses a bad query and a path outside the folders', async () => {
    await assert.rejects(searchFile(engine, { contentPattern: { pattern: '' } }, join(root, 'small', 'a.txt')))
    await assert.rejects(searchFile(engine, query(join(root, 'small'), 'needle'), join(root, 'big', 'huge.txt')))
    await assert.rejects(searchFile(engine, query(join(root, 'small'), 'needle'), 'relative.txt'))
  })
})
