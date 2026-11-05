// Quick Open's file list and search, main-process side (no Electron here: the unit tests run it under plain Node).
//
// Listing, the way VS Code's file search does it: ripgrep (`@vscode/ripgrep`, the rg VS Code ships) with
// `--files --hidden`, the ignore files respected (.gitignore, .ignore, .rgignore, also outside a git repository),
// and VS Code's default `files.exclude` + `search.exclude` globs. Without rg: `git ls-files -co --exclude-standard`
// inside a repository, else an own walk with the same excludes. One list per root, cached; a recursive
// `fs.watch` on the root marks it stale (files created, deleted or renamed — content changes do not alter the
// list) and the next search rebuilds it in the background while the old list keeps answering. The list is
// capped (MAX_FILES): beyond it the search runs over what was read and says so.
//
// Search: VS Code's scorer (app/shared/vscode-fuzzy-scorer.ts) over the relative paths, with VS Code's file
// accessor (label = file name, description = folder relative to the root, path = relative path) and its
// comparator; only the best MAX_RESULTS are sorted and returned (VS Code's partial sort). A query that extends
// the previous one on the same list only scores the previous matches (the subsequence property of the scorer).
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, type FSWatcher, readdirSync, statSync, watch } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { compareItemsByFuzzyScore, fuzzyContains, type FuzzyScorerCache, type IItemAccessor, type IMatch, prepareQuery, scoreItemFuzzy } from '../shared/vscode-fuzzy-scorer.ts'
import type { ListSource, QuickOpenItem, QuickOpenResult, QuickOpenTarget } from '../shared/quick-open.ts'

export type { ListSource, QuickOpenItem, QuickOpenResult }

/** Safety cap on the files kept per root. */
export const MAX_FILES = 200_000
/** Results shown per search (VS Code's Quick Open asks its file search for 512). */
export const MAX_RESULTS = 512
/** A stale list (the watcher saw a file come or go) is rebuilt at most this often. */
const STALE_DEBOUNCE_MS = 1000
/** How many roots keep a list (and a watcher); the least recently searched goes first. */
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

/** The rg binary of `@vscode/ripgrep` for this platform, or undefined when the package is not installed. */
export function findRipgrep(from: string = process.cwd()): string | undefined {
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
function runLister(cmd: string, args: string[], cwd: string, max: number, onBatch?: (files: string[]) => void): Promise<{ files: string[]; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try { child = spawn(cmd, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }) } catch (err) { reject(err); return }
    const files: string[] = []
    let rest = ''
    let truncated = false
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
}

/** Lists the files under `root`: rg, else git inside a repository, else the own walk. */
export async function listFiles(root: string, opts: ListOptions = {}): Promise<FileList> {
  const t0 = performance.now()
  const max = opts.max ?? MAX_FILES
  const rg = opts.rg === undefined ? findRipgrep() : opts.rg
  if (rg) {
    try {
      const r = await runLister(rg, rgArgs(), root, max, opts.onBatch)
      return { ...r, source: 'rg', ms: performance.now() - t0 }
    } catch { /* fall through */ }
  }
  if (opts.git !== false && insideGit(root)) {
    try {
      const r = await runLister('git', ['ls-files', '-co', '--exclude-standard', '-z'], root, max, opts.onBatch)
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

/** A file of the list, its label and description computed once (the scorer asks for them on every comparison). */
export interface FileEntry { rel: string; label: string; description: string }

export function fileEntry(rel: string): FileEntry {
  return { rel, label: basename(rel), description: dirname(rel) }
}

/** VS Code's FileMatchItemAccessor (rawSearchService): scored on the path relative to the root. */
const relAccessor: IItemAccessor<FileEntry> = {
  getItemLabel: m => m.label,
  getItemDescription: m => m.description,
  getItemPath: m => m.rel,
}

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

/** Ranks `rels` for the query (VS Code's scorer and comparator); returns every match and the best `max` sorted. */
export function rankFiles(entries: readonly FileEntry[], query: string, max: number = MAX_RESULTS): { matches: FileEntry[]; best: { entry: FileEntry; labelMatch?: IMatch[]; descriptionMatch?: IMatch[] }[] } {
  const prepared = prepareQuery(query)
  const cache: FuzzyScorerCache = Object.create(null)
  const matched: FileEntry[] = []
  // VS Code's file search drops a candidate whose path does not contain the query as a subsequence before
  // scoring; here per piece of a multi-word query (the scorer accepts the pieces in any order).
  const pieces = (prepared.values ?? [prepared]).map(p => p.normalizedLowercase)
  for (const item of entries) {
    if (!pieces.every(p => fuzzyContains(item.rel, p))) continue
    if (scoreItemFuzzy(item, prepared, true, relAccessor, cache).score > 0) matched.push(item)
  }
  // The comparator orders by score whenever two scores differ (identity > label prefix > label > path), so
  // only the items scoring at least the max-th best score can be in the answer: those are sorted with VS Code's
  // full comparator (its tie-breaks included), the rest never is. Same result as sorting everything.
  let band = matched
  if (matched.length > max) {
    const scores = new Float64Array(matched.length)
    matched.forEach((m, i) => { scores[i] = scoreItemFuzzy(m, prepared, true, relAccessor, cache).score })
    const threshold = Float64Array.from(scores).sort().reverse()[max - 1]!
    band = matched.filter((_, i) => scores[i]! >= threshold)
  }
  const best = band.sort((a, b) => compareItemsByFuzzyScore(a, b, prepared, true, relAccessor, cache)).slice(0, max)
  return {
    matches: matched,
    best: best.map(m => { const s = scoreItemFuzzy(m, prepared, true, relAccessor, cache); return { entry: m, ...(s.labelMatch ? { labelMatch: s.labelMatch } : {}), ...(s.descriptionMatch ? { descriptionMatch: s.descriptionMatch } : {}) } }),
  }
}

interface Entry {
  root: string
  files: FileEntry[]
  source: ListSource | undefined
  truncated: boolean
  listMs: number | undefined
  /** Bumped on every completed build: the prefix cache is valid only within one version. */
  version: number
  building: Promise<void> | undefined
  stale: boolean
  staleAt: number
  watcher: FSWatcher | undefined
  last: { query: string; version: number; matches: FileEntry[] } | undefined
  usedAt: number
}

export interface FileIndexOptions extends Omit<ListOptions, 'onBatch'> {
  /** Watch roots for created/deleted files (default true). */
  watch?: boolean
}

/** The per-root lists and their searches. */
export class FileIndex {
  private readonly entries = new Map<string, Entry>()
  private readonly opts: FileIndexOptions

  constructor(opts: FileIndexOptions = {}) {
    this.opts = opts
  }

  private entry(root: string): Entry {
    const key = process.platform === 'linux' ? root : root.toLowerCase()
    let e = this.entries.get(key)
    if (!e) {
      e = { root, files: [], source: undefined, truncated: false, listMs: undefined, version: 0, building: undefined, stale: true, staleAt: 0, watcher: undefined, last: undefined, usedAt: 0 }
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
    oldest[1].watcher?.close()
    this.entries.delete(oldest[0])
  }

  /** Starts a build unless one runs; the first build fills `files` as rg prints them. */
  private build(e: Entry): Promise<void> {
    if (e.building) return e.building
    const first = e.version === 0
    const partial: FileEntry[] = []
    if (first) e.files = partial
    e.stale = false
    e.building = listFiles(e.root, { ...this.opts, ...(first ? { onBatch: (b: string[]) => { for (const f of b) partial.push(fileEntry(f)) } } : {}) }).then(list => {
      e.files = list.files.map(fileEntry)
      e.source = list.source
      e.truncated = list.truncated
      e.listMs = list.ms
      e.version++
      e.last = undefined
    }, err => {
      console.error(`quick open: não foi possível listar ${e.root}:`, err)
    }).finally(() => { e.building = undefined })
    if (this.opts.watch !== false && !e.watcher) this.watch(e)
    return e.building
  }

  private watch(e: Entry): void {
    try {
      e.watcher = watch(e.root, { recursive: true }, (type, name) => {
        // A content change keeps the list as it is; only a name that came or went matters.
        if (type !== 'rename') return
        const n = typeof name === 'string' ? name : ''
        if (n.split(/[\\/]/).some(seg => EXCLUDED_NAMES.has(seg))) return
        if (!e.stale) { e.stale = true; e.staleAt = Date.now() }
      })
      e.watcher.on('error', () => { e.watcher?.close(); e.watcher = undefined; e.stale = true })
    } catch { /* no recursive watch here: the list is rebuilt when the box opens again (refresh) */ }
  }

  /** The box opened: a root without a watcher is re-listed in the background (cheap re-scan on reopen). */
  refresh(root: string): void {
    const e = this.entry(root)
    if (e.version === 0 && !e.building) { void this.build(e); return }
    if (!e.watcher) e.stale = true
  }

  /** The list for a root, building it when needed (tests and measurements). */
  async list(root: string): Promise<FileList> {
    const e = this.entry(root)
    if (e.version === 0 || e.stale) await this.build(e)
    else if (e.building) await e.building
    return { files: e.files.map(f => f.rel), source: e.source ?? 'walk', truncated: e.truncated, ms: e.listMs ?? 0 }
  }

  search(root: string, query: string, recentPaths: readonly string[] = [], max: number = MAX_RESULTS): QuickOpenResult {
    const t0 = performance.now()
    const e = this.entry(root)
    if (e.version === 0) { if (!e.building) void this.build(e) }
    else if (e.stale && !e.building && Date.now() - e.staleAt >= STALE_DEBOUNCE_MS) void this.build(e)
    const pending = !!e.building || (e.stale && e.version > 0)

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

    const q = query.trim()
    let recent: QuickOpenItem[]
    let files: QuickOpenItem[] = []
    if (q === '') {
      recent = recentRels.filter(rel => existsSync(join(root, rel))).map(rel => toItem(root, fileEntry(rel), undefined))
    } else {
      recent = rankFiles(recentRels.map(fileEntry), q, max).best.map(m => toItem(root, m.entry, m))
      const fresh = e.last && e.last.version === e.version && !pending && q.startsWith(e.last.query) ? e.last.matches : e.files
      const ranked = rankFiles(fresh, q, max + recent.length)
      if (!pending) e.last = { query: q, version: e.version, matches: ranked.matches }
      const recentSet = new Set(recent.map(r => (process.platform === 'linux' ? r.path : r.path.toLowerCase())))
      for (const m of ranked.best) {
        if (files.length >= max) break
        const item = toItem(root, m.entry, m)
        if (recentSet.has(process.platform === 'linux' ? item.path : item.path.toLowerCase())) continue
        files.push(item)
      }
    }
    return { root, recent, files, total: e.files.length, source: e.source, truncated: e.truncated, pending, listMs: e.listMs, searchMs: performance.now() - t0 }
  }

  dispose(): void {
    for (const e of this.entries.values()) e.watcher?.close()
    this.entries.clear()
  }
}

// ---------- opening ----------

/** Above this a file is not opened in the editor (the person is offered the system's program). */
export const MAX_EDITOR_BYTES = 5 * 1024 * 1024

/** Extensions never handed to the system's program from here: opening them would run them. */
const EXECUTABLE = new Set(['.exe', '.com', '.bat', '.cmd', '.msi', '.msix', '.scr', '.pif', '.lnk', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.ps1', '.psm1', '.reg', '.cpl', '.hta', '.jar', '.app', '.command', '.sh'])

/** Binary by extension, before reading anything (images, archives, documents, media, compiled code). */
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.icns', '.webp', '.tif', '.tiff', '.psd', '.pdf', '.zip', '.7z', '.rar', '.gz', '.tgz', '.bz2', '.xz', '.tar', '.exe', '.dll', '.so', '.dylib', '.node', '.bin', '.dat', '.class', '.jar', '.pyc', '.wasm', '.mp3', '.mp4', '.wav', '.ogg', '.flac', '.mov', '.avi', '.mkv', '.webm', '.ttf', '.otf', '.woff', '.woff2', '.eot', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.msi', '.sqlite', '.db'])

function extOf(path: string): string {
  const name = basename(path).toLowerCase()
  const i = name.lastIndexOf('.')
  return i <= 0 ? '' : name.slice(i)
}

/** What opening `path` means: the editor for text, the system's program for binary or too large (never for what would run). */
export function inspectFile(path: string, readHead: (path: string) => Buffer): QuickOpenTarget {
  let st
  try { st = statSync(path) } catch { return { kind: 'missing' } }
  if (st.isDirectory()) return { kind: 'folder' }
  const ext = extOf(path)
  const runnable = EXECUTABLE.has(ext)
  if (BINARY_EXT.has(ext)) return { kind: 'binary', size: st.size, runnable }
  if (st.size > MAX_EDITOR_BYTES) return { kind: 'large', size: st.size, runnable }
  // VS Code's buffer check: a NUL in the first bytes means binary (UTF-16 files start with a BOM and are let through).
  let head: Buffer
  try { head = readHead(path) } catch { return { kind: 'missing' } }
  const utf16 = head.length >= 2 && ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff))
  if (!utf16 && head.includes(0)) return { kind: 'binary', size: st.size, runnable }
  return { kind: 'text', size: st.size }
}
