// The search extension's main side under plain Node: the real worker (.ts, run directly), the real rg, temp folders.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { Worker } from 'node:worker_threads'
import { allowedIn, fileQuery, MAX_READ_BYTES, readText, sanitizeQuery, sanitizeReplace, saveSearchEditor, searchFile, SearchOnce } from '../../extensions/search/main.ts'
import { MAX_SEARCH_EDITOR_BYTES, SUPERSEDED_MESSAGE } from '../../extensions/search/renderer/search-editor-rules.ts'
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

describe('readText (the replace preview reads a file)', () => {
  it('decodes as the disk replace does: BOM out of the text, UTF-16, CRLF kept', async () => {
    const dir = join(root, 'read')
    await mkdir(dir)
    await writeFile(join(dir, 'plain.txt'), 'ação\r\nnext\n')
    await writeFile(join(dir, 'bom.txt'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('with bom\n', 'utf8')]))
    await writeFile(join(dir, 'u16.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('wide\n', 'utf16le')]))
    assert.deepEqual(await readText([dir], join(dir, 'plain.txt')), { ok: true, text: 'ação\r\nnext\n' })
    assert.deepEqual(await readText([dir], join(dir, 'bom.txt')), { ok: true, text: 'with bom\n' })
    assert.deepEqual(await readText([dir], join(dir, 'u16.txt')), { ok: true, text: 'wide\n' })
  })

  it('refuses outside the folders, invalid UTF-8, a missing file and a file over the limit', async () => {
    const dir = join(root, 'read2')
    await mkdir(dir)
    await writeFile(join(dir, 'bad.bin'), Buffer.from([0x61, 0xff, 0xfe, 0x00, 0xc3]))
    await writeFile(join(dir, 'big.txt'), Buffer.alloc(MAX_READ_BYTES + 1, 0x61))
    assert.deepEqual(await readText([dir], join(dir, 'bad.bin')), { ok: false, message: 'A codificação deste arquivo não é suportada.' })
    assert.deepEqual(await readText([dir], join(dir, 'gone.txt')), { ok: false, message: 'O arquivo não foi encontrado.' })
    assert.equal((await readText([dir], join(dir, 'big.txt'))).ok, false)
    assert.deepEqual(await readText([dir], join(root, 'small', 'a.txt')), { ok: false, message: 'Arquivo fora das pastas pesquisadas.' })
    assert.deepEqual(await readText([dir], 'relative.txt'), { ok: false, message: 'Arquivo fora das pastas pesquisadas.' })
    assert.deepEqual(await readText([], join(dir, 'big.txt')), { ok: false, message: 'Arquivo fora das pastas pesquisadas.' })
    assert.equal((await readText([dir], 42)).ok, false)
  })
})

describe('SearchOnce (the search editor: one whole search on its own worker)', () => {
  it('answers every match in one reply; maxResults sets limitHit', async () => {
    const once = new SearchOnce(new SearchService(WORKER, REPO))
    const r = await once.run(query(join(root, 'small'), 'needle'))
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.limitHit, false)
    assert.deepEqual(r.matches.map(m => m.resource.split(/[\\/]/).pop()).sort(), ['a.txt', 'b.txt'])
    const limited = await once.run({ ...query(join(root, 'small'), 'needle'), maxResults: 1 })
    assert.ok(limited.ok && limited.limitHit && limited.matches.flatMap(m => m.results ?? []).length === 1, JSON.stringify(limited))
    await once.dispose()
  })

  it('context lines come with surroundingContext', async () => {
    const once = new SearchOnce(new SearchService(WORKER, REPO))
    const r = await once.run({ ...query(join(root, 'small'), 'needle'), surroundingContext: 1 })
    assert.ok(r.ok)
    if (!r.ok) return
    const a = r.matches.find(m => m.resource.endsWith('a.txt'))
    assert.ok(a?.results?.some(x => !('rangeLocations' in x) && (x as { text: string }).text.startsWith('second line')), JSON.stringify(a))
    await once.dispose()
  })

  it('a newer call replaces the running one: it answers "substituída"', async () => {
    const once = new SearchOnce(new SearchService(WORKER, REPO))
    const p1 = once.run(query(big, 'haystack'))
    const p2 = once.run(query(join(root, 'small'), 'needle'))
    assert.deepEqual(await p1, { ok: false, message: SUPERSEDED_MESSAGE })
    assert.equal((await p2).ok, true)
    await once.dispose()
  })

  it('an invalid regex answers the engine message; an invalid query is refused', async () => {
    const once = new SearchOnce(new SearchService(WORKER, REPO))
    const r = await once.run(query(join(root, 'small'), '(unclosed', { isRegExp: true }))
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.ok(r.message.length > 0)
    assert.equal(r.code, 'regexParseError', JSON.stringify(r))
    assert.deepEqual(await once.run({ nope: true }), { ok: false, message: 'Consulta de pesquisa inválida.' })
    await once.dispose()
  })

  it("does not cancel the pad's live search (two services, two workers)", async () => {
    const pad = new SearchService(WORKER, REPO)
    const once = new SearchOnce(new SearchService(WORKER, REPO))
    let liveBatches = 0
    let running = true
    const live = pad.search(1, { ...query(big, 'haystack'), maxResults: 60_000 }, () => { liveBatches++ }).finally(() => { running = false })
    const r = await once.run(query(join(root, 'small'), 'needle'))
    assert.equal(r.ok, true)
    assert.ok(running, 'the live search was still running when the editor search answered')
    const d = await live
    assert.equal(d.kind, 'done', 'the live search ran to its end')
    assert.ok(liveBatches > 0)
    await pad.dispose()
    await once.dispose()
  })
})

describe('saveSearchEditor (the documents of the search editor)', () => {
  it('names by date, adds -2, -3 when taken, creates the folder', async () => {
    const dir = join(root, 'editors-a', 'search-editors')
    const now = new Date(2026, 10, 15, 17, 5, 9)
    const a = await saveSearchEditor(dir, '# Query: x\n', now)
    const b = await saveSearchEditor(dir, '# Query: y\n', now)
    const c = await saveSearchEditor(dir, '# Query: z\n', now)
    assert.ok(a.ok && b.ok && c.ok)
    if (!a.ok || !b.ok || !c.ok) return
    assert.equal(a.path, join(dir, 'Pesquisa-20261115-170509.code-search'))
    assert.equal(b.path, join(dir, 'Pesquisa-20261115-170509-2.code-search'))
    assert.equal(c.path, join(dir, 'Pesquisa-20261115-170509-3.code-search'))
    assert.equal(await readFile(b.path, 'utf8'), '# Query: y\n')
  })

  it('keeps only the most recent documents (other files stay)', async () => {
    const dir = join(root, 'editors-b')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'keep.txt'), 'not a search')
    const paths: string[] = []
    for (let i = 0; i < 5; i++) {
      const r = await saveSearchEditor(dir, `# Query: ${i}\n`, new Date(2026, 0, 1, 0, 0, i), 3)
      assert.ok(r.ok)
      if (r.ok) paths.push(r.path)
      await utimes(paths[paths.length - 1]!, new Date(2026, 0, 1, 0, 0, i), new Date(2026, 0, 1, 0, 0, i))
    }
    const left = (await readdir(dir)).sort()
    assert.deepEqual(left, ['Pesquisa-20260101-000002.code-search', 'Pesquisa-20260101-000003.code-search', 'Pesquisa-20260101-000004.code-search', 'keep.txt'])
  })

  it('refuses what is not text and what is over 50 MB', async () => {
    const dir = join(root, 'editors-c')
    assert.deepEqual(await saveSearchEditor(dir, 42), { ok: false, message: 'Documento de pesquisa inválido.' })
    const huge = await saveSearchEditor(dir, 'x'.repeat(MAX_SEARCH_EDITOR_BYTES + 1))
    assert.equal(huge.ok, false)
  })
})
