// Quick Open's file list and search, main-process side (no Electron here: the unit tests run it under plain Node).
//
// Listing, the way VS Code's file search does it: ripgrep (`@vscode/ripgrep`, the rg VS Code ships) with
// `--files --hidden`, the ignore files respected (.gitignore, .ignore, .rgignore, also outside a git repository),
// and VS Code's default `files.exclude` + `search.exclude` globs. Without rg: `git ls-files -co --exclude-standard`
// inside a repository, else an own walk with the same excludes. The list is capped (MAX_FILES): beyond it the
// search runs over what was read and says so.
//
// The model is VS Code's search session (app/main/vscode-raw-search.ts): the list is read when the box opens
// (`refresh`), every keystroke is answered from it, and it is dropped when the box closes (`close`). Nothing
// watches the folder and nothing re-lists while the box is open: a file created meanwhile shows up the next time
// the box opens. `pending` is true only while the first listing of the session runs.
//
// Search: VS Code's scorer (app/shared/vscode-fuzzy-scorer.ts) over the relative paths, with VS Code's file
// accessor (label = file name, description = folder relative to the root, path = relative path) and its
// comparator; a query that extends an earlier one of the session is filtered from that one's candidates, and only
// the best MAX_RESULTS are selected and sorted (rawSearchService's cache and top-N).
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { type FuzzyScorerCache, type IItemAccessor, type IMatch, prepareQuery, scoreItemFuzzy } from '../shared/vscode-fuzzy-scorer.ts'
import { SearchCache } from './vscode-raw-search.ts'
import { type FileEntry, fileEntry, relAccessor } from './file-entry.ts'
import { ShardPool, STALE } from './file-index-shard.ts'
import type { ListSource, QuickOpenItem, QuickOpenResult } from '../shared/quick-open.ts'

export type { ListSource, QuickOpenItem, QuickOpenResult }

/** Safety cap on the files kept per root. */
export const MAX_FILES = 200_000
/** Results shown per search (VS Code's Quick Open asks its file search for 512). */
export const MAX_RESULTS = 512
/** How many roots keep a list; the least recently searched goes first (a closed session already dropped its list). */
const MAX_ROOTS = 6

/** VS Code's defaults: `files.exclude` (version control folders, OS litter) plus `search.exclude`. */
export const DEFAULT_EXCLUDES = ['**/.git', '**/.svn', '**/.hg', '**/CVS', '**/.DS_Store', '**/Thumbs.db', '**/node_modules', '**/bower_components', '**/*.code-search']
const EXCLUDED_NAMES = new Set(['.git', '.svn', '.hg', 'CVS', '.DS_Store', 'Thumbs.db', 'node_modules', 'bower_components'])

export interface FileList {
  /** Relative paths with the platform separator. */
  files: string[]
  source: ListSource
  /** True when MAX_FILES cut the list. */
  truncated: boolean
  ms: number
}

/**
 * This module's folder: app/dist in the bundled worker (CommonJS `__dirname`), app/main under plain Node (tests).
 * The rg package resolves from here, up to the repo's node_modules: never from the process's working directory,
 * which is C:\Windows\System32 (or anything else) when the app is started by a shortcut or the shell.
 */
const moduleDir: string = typeof __dirname === 'string' ? __dirname : import.meta.dirname

/** The rg binary of `@vscode/ripgrep` for this platform, or undefined when the package is not installed. */
export function findRipgrep(from: string = moduleDir): string | undefined {
  const req = createRequire(join(from, 'noop.js'))
  const name = process.platform === 'win32' ? 'rg.exe' : 'rg'
  try {
    const p = req.resolve(`@vscode/ripgrep-${process.platform}-${process.arch}/bin/${name}`)
    return existsSync(p) ? p : undefined
  } catch { return undefined }
}

/** rg's arguments for listing (VS Code's ripgrepFileSearch, without `--follow`: a junction loop must not explode the list). */
export function rgArgs(excludes: readonly string[] = DEFAULT_EXCLUDES): string[] {
  const args = ['--files', '--hidden', '--case-sensitive', '--no-require-git', '--no-config', '--no-ignore-global', '--no-ignore-parent', '--null', '--no-messages']
  for (const g of excludes) args.push('-g', `!${g}`)
  return args
}

/** A path from a tool's output in the platform's separator, without a leading `./`. */
function normalizeRel(p: string): string {
  const parts = p.split(/[\\/]+/).filter(s => s !== '' && s !== '.')
  return parts.join(sep)
}

/** Runs a lister that prints NUL-separated paths; stops it at `max`. Rejects when it cannot start or fails with nothing listed. */
function runLister(cmd: string, args: string[], cwd: string, max: number, onBatch?: (files: string[]) => void, signal?: AbortSignal): Promise<{ files: string[]; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try { child = spawn(cmd, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }) } catch (err) { reject(err); return }
    const files: string[] = []
    let rest = ''
    let truncated = false
    if (signal) { if (signal.aborted) child.kill(); else signal.addEventListener('abort', () => child.kill(), { once: true }) }
    child.stdout!.setEncoding('utf8')
    child.stdout!.on('data', (chunk: string) => {
      if (truncated) return
      const parts = (rest + chunk).split('\0')
      rest = parts.pop() ?? ''
      const batch: string[] = []
      for (const p of parts) {
        if (p === '') continue
        if (files.length >= max) { truncated = true; child.kill(); break }
        const rel = normalizeRel(p)
        files.push(rel); batch.push(rel)
      }
      if (batch.length) onBatch?.(batch)
    })
    child.on('error', reject)
    child.on('close', code => {
      if (!truncated && rest !== '' && files.length < max) { const rel = normalizeRel(rest); files.push(rel); onBatch?.([rel]) }
      // rg exits 1 for "nothing found" and 2 for partial errors (unreadable folders): what was listed counts.
      if (code !== 0 && code !== 1 && code !== 2 && !truncated && files.length === 0) { reject(new Error(`${cmd} saiu com ${code}`)); return }
      resolve({ files, truncated })
    })
  })
}

/** The own walk (no rg, no git): breadth-first, VS Code's excluded names skipped, symlinks not followed, capped. */
export function walkFiles(root: string, max: number = MAX_FILES): { files: string[]; truncated: boolean } {
  const files: string[] = []
  const queue: string[] = ['']
  while (queue.length) {
    const rel = queue.shift()!
    let entries
    try { entries = readdirSync(join(root, rel), { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (EXCLUDED_NAMES.has(e.name) || e.name.endsWith('.code-search')) continue
      const child = rel ? `${rel}${sep}${e.name}` : e.name
      if (e.isDirectory()) queue.push(child)
      else if (e.isFile()) {
        if (files.length >= max) return { files, truncated: true }
        files.push(child)
      }
    }
  }
  return { files, truncated: false }
}

function insideGit(root: string): boolean {
  let current = root
  for (;;) {
    if (existsSync(join(current, '.git'))) return true
    const parent = dirname(current)
    if (parent === current) return false
    current = parent
  }
}

export interface ListOptions {
  /** The rg binary; null = do not use rg (tests of the fallbacks). Default: findRipgrep(). */
  rg?: string | null
  /** Use git when rg is missing (default true). */
  git?: boolean
  max?: number
  /** Called with each batch of paths while the lister runs (the search can answer before it ends). */
  onBatch?: (files: string[]) => void
  /** Aborting kills the lister (the session ended); the promise still settles with what was read. */
  signal?: AbortSignal
}

/** Lists the files under `root`: rg, else git inside a repository, else the own walk. */
export async function listFiles(root: string, opts: ListOptions = {}): Promise<FileList> {
  const t0 = performance.now()
  const max = opts.max ?? MAX_FILES
  const rg = opts.rg === undefined ? findRipgrep() : opts.rg
  if (rg) {
    try {
      const r = await runLister(rg, rgArgs(), root, max, opts.onBatch, opts.signal)
      return { ...r, source: 'rg', ms: performance.now() - t0 }
    } catch { /* fall through */ }
  }
  if (opts.git !== false && insideGit(root)) {
    try {
      const r = await runLister('git', ['ls-files', '-co', '--exclude-standard', '-z'], root, max, opts.onBatch, opts.signal)
      // git lists the files of the excluded folders when they are tracked (a committed node_modules): VS Code's excludes still apply.
      const files = r.files.filter(f => !f.split(sep).some(seg => EXCLUDED_NAMES.has(seg)))
      return { files, truncated: r.truncated, source: 'git', ms: performance.now() - t0 }
    } catch { /* fall through */ }
  }
  const r = walkFiles(root, max)
  opts.onBatch?.(r.files)
  return { ...r, source: 'walk', ms: performance.now() - t0 }
}

// ---------- search ----------

export { type FileEntry, fileEntry }

/** True when `abs` is `root` or under it (case-insensitive on Windows and macOS). */
export function isInside(root: string, abs: string): boolean {
  const rel = relative(root, abs)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

function toItem(root: string, f: FileEntry, score: { labelMatch?: IMatch[]; descriptionMatch?: IMatch[] } | undefined): QuickOpenItem {
  const d = f.description
  return {
    path: join(root, f.rel),
    label: f.label,
    description: d === '.' ? '' : d,
    labelMatch: score?.labelMatch ?? [],
    // The scorer's description for a file at the root is "."; shown as nothing, so its highlight goes too.
    descriptionMatch: d === '.' ? [] : score?.descriptionMatch ?? [],
  }
}

/**
 * Ranks `entries` for the query: the candidates (the path contains each word as a subsequence; `candidates` when the
 * caller already filtered them from a cached row) and the best `max` of them in VS Code's order (top-N with the
 * scorer's comparator), the ones that do not score dropped.
 */
export function rankFiles(entries: readonly FileEntry[], query: string, max: number = MAX_RESULTS, cache: SearchCache<FileEntry> = new SearchCache<FileEntry>(), candidates?: FileEntry[]): { matches: FileEntry[]; best: { entry: FileEntry; labelMatch?: IMatch[]; descriptionMatch?: IMatch[] }[] } {
  const prepared = prepareQuery(query)
  const matched = candidates ?? cache.getResultsFromCache(query, entries)
  const scorerCache: FuzzyScorerCache = cache.scorerCache
  const best: { entry: FileEntry; labelMatch?: IMatch[]; descriptionMatch?: IMatch[] }[] = []
  for (const m of cache.sortResults(matched, query, max, relAccessor)) {
    const s = scoreItemFuzzy(m, prepared, true, relAccessor, scorerCache)
    if (s.score <= 0) continue
    best.push({ entry: m, ...(s.labelMatch ? { labelMatch: s.labelMatch } : {}), ...(s.descriptionMatch ? { descriptionMatch: s.descriptionMatch } : {}) })
  }
  return { matches: matched, best }
}

interface Entry {
  root: string
  files: FileEntry[]
  source: ListSource | undefined
  truncated: boolean
  listMs: number | undefined
  /** 0 until the session's listing completes (`files` may be partial before); the session cache is valid after. */
  version: number
  building: Promise<void> | undefined
  /** Bumped when a session ends: the listing of an earlier session discards its result. */
  generation: number
  abort: AbortController | undefined
  cache: SearchCache<FileEntry>
  usedAt: number
  /** The id the shard workers know this session's list by; 0 while they hold none. */
  sid: number
  /** Why the last listing failed (cleared by the next one that succeeds). */
  error: string | undefined
}

/** A list shorter than this is scored in the one worker: cutting it up would cost more than it saves. */
export const PARALLEL_MIN_FILES = 5000

export interface FileIndexOptions extends Omit<ListOptions, 'onBatch' | 'signal'> {
  /** Scoring shards (app/main/file-index-shard.ts); without it every search is scored in this thread. */
  shards?: { path: string; size: number }
  /** Lists shorter than this are scored in this thread (default PARALLEL_MIN_FILES). */
  parallelMin?: number
}

/** The per-root lists (one search session each) and their searches. */
export class FileIndex {
  private readonly entries = new Map<string, Entry>()
  private readonly opts: FileIndexOptions
  private readonly pool: ShardPool | undefined
  private nextSid = 1

  constructor(opts: FileIndexOptions = {}) {
    this.opts = opts
    this.pool = opts.shards && opts.shards.size >= 2 ? new ShardPool(opts.shards.path, opts.shards.size) : undefined
  }

  private dropShards(e: Entry): void {
    if (e.sid) this.pool?.drop(e.sid)
    e.sid = 0
  }

  private key(root: string): string {
    return process.platform === 'linux' ? root : root.toLowerCase()
  }

  private entry(root: string): Entry {
    const key = this.key(root)
    let e = this.entries.get(key)
    if (!e) {
      e = { root, files: [], source: undefined, truncated: false, listMs: undefined, version: 0, building: undefined, generation: 0, abort: undefined, cache: new SearchCache<FileEntry>(), usedAt: 0, sid: 0, error: undefined }
      this.entries.set(key, e)
      this.evict()
    }
    e.usedAt = Date.now()
    return e
  }

  private evict(): void {
    if (this.entries.size <= MAX_ROOTS) return
    const oldest = [...this.entries.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt)[0]
    if (!oldest) return
    this.reset(oldest[1])
    this.entries.delete(oldest[0])
  }

  /** The session's list and cache are dropped (rawSearchService.clearCache); a listing still running is killed. */
  private reset(e: Entry): void {
    this.dropShards(e)
    e.generation++
    e.abort?.abort()
    e.abort = undefined
    e.building = undefined
    e.files = []
    e.source = undefined
    e.truncated = false
    e.listMs = undefined
    e.version = 0
    e.cache = new SearchCache<FileEntry>()
    e.error = undefined
  }

  /** Reads the root's list; while it runs, `files` fills as rg prints (the search can answer from the part read). */
  private build(e: Entry): Promise<void> {
    if (e.building) return e.building
    const generation = e.generation
    const partial: FileEntry[] = []
    e.files = partial
    const ac = new AbortController()
    e.abort = ac
    e.building = listFiles(e.root, { ...this.opts, signal: ac.signal, onBatch: (b: string[]) => { if (e.generation === generation) for (const f of b) partial.push(fileEntry(f)) } }).then(list => {
      if (e.generation !== generation) return
      e.files = list.files.map(fileEntry)
      e.source = list.source
      e.truncated = list.truncated
      e.listMs = list.ms
      this.dropShards(e)
      e.version++
      e.cache = new SearchCache<FileEntry>()
      e.error = undefined
    }, err => {
      if (e.generation !== generation) return
      e.error = err instanceof Error ? err.message : String(err)
      console.error(`quick open: não foi possível listar ${e.root}:`, err)
    }).finally(() => { if (e.generation === generation) { e.building = undefined; e.abort = undefined } })
    return e.building
  }

  /** The box opened: a new search session. The root is read again, whatever a previous session left. */
  refresh(root: string): void {
    const e = this.entry(root)
    this.pool?.warm()
    if (e.building && e.version === 0) return // the listing of this session is already running
    this.reset(e)
    void this.build(e)
  }

  /** The box closed: the session's list and cache go (VS Code's clearCache). */
  close(root: string): void {
    const e = this.entries.get(this.key(root))
    if (e) this.reset(e)
  }

  /** The list for a root, reading it when there is none (tests and measurements). */
  async list(root: string): Promise<FileList> {
    const e = this.entry(root)
    if (e.version === 0) await this.build(e)
    return { files: e.files.map(f => f.rel), source: e.source ?? 'walk', truncated: e.truncated, ms: e.listMs ?? 0 }
  }

  /** Search state shared by the two paths: the session, the history and what the listing is doing. */
  private begin(root: string, query: string, recentPaths: readonly string[]) {
    const t0 = performance.now()
    const e = this.entry(root)
    // A search without a session (no refresh before it) reads the list itself; a failed listing is retried by the next keystroke.
    if (e.version === 0 && !e.building) void this.build(e)
    // No list because the listing failed: the box says why instead of waiting.
    const failed = e.version === 0 ? e.error : undefined
    // Only the session's first listing is pending; the box asks again until it is done, never afterwards.
    const pending = failed === undefined && e.version === 0

    // History: the files opened lately under this root, still there.
    const recentRels: string[] = []
    const seen = new Set<string>()
    for (const p of recentPaths) {
      if (!isInside(root, p)) continue
      const key = process.platform === 'linux' ? p : p.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      recentRels.push(relative(root, p))
    }
    return { t0, e, failed, pending, recentRels, q: query.trim() }
  }

  private finish(root: string, b: ReturnType<FileIndex['begin']>, recent: QuickOpenItem[], files: QuickOpenItem[]): QuickOpenResult {
    const { e, failed, pending, t0 } = b
    return { root, recent, files, total: e.files.length, source: e.source, truncated: e.truncated, pending, listMs: e.listMs, searchMs: performance.now() - t0, ...(failed !== undefined ? { error: failed } : {}) }
  }

  /** The files of the result: the ranked ones, the history's repeats dropped, at most `max`. */
  private filesOf(root: string, max: number, recent: QuickOpenItem[], best: ReturnType<typeof rankFiles>['best']): QuickOpenItem[] {
    const files: QuickOpenItem[] = []
    const recentSet = new Set(recent.map(r => (process.platform === 'linux' ? r.path : r.path.toLowerCase())))
    for (const m of best) {
      if (files.length >= max) break
      const item = toItem(root, m.entry, m)
      if (recentSet.has(process.platform === 'linux' ? item.path : item.path.toLowerCase())) continue
      files.push(item)
    }
    return files
  }

  search(root: string, query: string, recentPaths: readonly string[] = [], max: number = MAX_RESULTS): QuickOpenResult {
    const b = this.begin(root, query, recentPaths)
    const { e, pending, recentRels, q } = b
    if (q === '') return this.finish(root, b, recentRels.filter(rel => existsSync(join(root, rel))).map(rel => toItem(root, fileEntry(rel), undefined)), [])
    const recent = rankFiles(recentRels.map(fileEntry), q, max).best.map(m => toItem(root, m.entry, m))
    const ranked = rankFiles(e.files, q, max + recent.length, e.cache)
    // The partial list of a listing still running is not cached: it grows between keystrokes.
    if (!pending) e.cache.put(q, ranked.matches)
    return this.finish(root, b, recent, this.filesOf(root, max, recent, ranked.best))
  }

  /** Tells the shards which search is the newest, so they skip the ones it replaced. Call it as the request arrives. */
  noteLatest(seq: number): void { this.pool?.setLatest(seq) }

  /**
   * search(), scoring on the shard workers when the list is complete and long enough. Resolves null when a newer
   * search (`seq`) or the end of the session made this one moot. The answer is the same as search()'s.
   */
  async searchAsync(root: string, query: string, recentPaths: readonly string[], max: number, seq: number): Promise<QuickOpenResult | null> {
    const b = this.begin(root, query, recentPaths)
    const { e, pending, failed, recentRels, q } = b
    const pool = this.pool
    if (!pool || pool.broken || q === '' || pending || failed !== undefined || e.files.length < (this.opts.parallelMin ?? PARALLEL_MIN_FILES)) return this.search(root, query, recentPaths, max)
    const generation = e.generation
    const recent = rankFiles(recentRels.map(fileEntry), q, max).best.map(m => toItem(root, m.entry, m))
    if (!e.sid) { e.sid = this.nextSid++; pool.load(e.sid, e.files.map(f => f.rel)) }
    const n = max + recent.length
    let rels: string[] | typeof STALE
    try { rels = await pool.search(e.sid, q, n, seq) } catch { rels = STALE }
    if (pool.broken) return this.search(root, query, recentPaths, max) // a shard died: the one thread answers
    if (rels === STALE || e.generation !== generation) return null
    // The merge: the same comparator and the same scoring as the serial path, over the shards' tops.
    const ranked = rankFiles([], q, n, e.cache, rels.map(fileEntry))
    return this.finish(root, b, recent, this.filesOf(root, max, recent, ranked.best))
  }

  dispose(): void {
    for (const e of this.entries.values()) this.reset(e)
    this.entries.clear()
    this.pool?.dispose()
  }
}

// What opening a path means lives in the core (app/main/file-inspect.ts); re-exported for the index's tests.
export { inspectFile, MAX_EDITOR_BYTES } from './file-inspect.ts'
