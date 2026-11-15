// The explorer's disk watchers (F8 slice 3), Electron-main side: one recursive `fs.watch` per project root where the system
// supports it (Windows ReadDirectoryChangesW, macOS FSEvents: a single handle per root), one non-recursive watcher per
// expanded folder elsewhere (Linux: Node's recursive mode there is an inotify per folder, too dear for a big tree).
// A broad root (a file system root, or the user's home folder) never gets a recursive handle on any system: on Windows the
// delivery of a recursive watch's events costs CPU on a native thread of the main process whatever the listener drops, and
// a whole disk or home is always busy (builds, git, package managers). It is watched like Linux, one handle per expanded
// folder inside it. A root nested in another recursively watched root shares the outer handle; each event belongs to the
// innermost root that contains its path.
// Events are filtered at the door (`watcherExclude`, names the tree never lists, folders that are not expanded), typed with
// one `lstat`, gathered over a short window (trailing 200 ms, at most 1 s from the first event: VS Code's nodejs watcher
// aggregates and throttles the same way), coalesced (watch-rules.ts) and reduced to the expanded folders they touched.
// Only those folder names go to the renderer; it re-reads them. A burst past MAX_BUFFERED events is not kept one by one: the
// window degrades to "every expanded folder of the project changed", still one message.
// Handles are held only while some view of the explorer is visible (`setActive`): a recursive handle on Windows costs CPU on
// every disk event of the project whatever the tree does with it, so a hidden explorer holds none. Shown again, the handles
// reopen and every expanded folder is reported changed once, so what moved meanwhile is read again.
// The shape follows VS Code's NodeJSFileWatcherLibrary (src/vs/platform/files/node/watcher/nodejs/nodejsWatcherLib.ts @7faf984):
// delay + RunOnceWorker aggregation, ThrottledWorker bound, an 'error' that fails the watcher, a watched path that is gone.
import { watch as fsWatch, type FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { lstat } from 'node:fs/promises'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import { isInsideAny, joinPath, parentPath } from './tree-rules.ts'
import { affectedDirs, coalesceEvents, isIgnoredChange, pathKey, type FileChange } from './watch-rules.ts'

/** The slice of a watcher the registry needs (fs.FSWatcher). */
export interface WatchHandle {
  close(): void
  on(event: 'error', listener: (err: Error) => void): unknown
}

export type WatchFn = (path: string, options: { recursive: boolean; persistent: boolean }, listener: (type: string, filename: string | Buffer | null) => void) => WatchHandle

/** What the registry tells the window. */
export interface WatchSink {
  /** These expanded folders may list differently now. */
  changed(dirs: string[]): void
  /** A project root vanished from the disk or came back. */
  rootMissing(root: string, missing: boolean): void
  /** A watcher could not start or died: the tree no longer follows this root by itself. */
  failed(root: string, message: string): void
}

export interface WatchOptions {
  watch?: WatchFn
  /** Whether the entry exists (lstat); injected for the unit test. */
  exists?: (path: string) => Promise<boolean>
  /** Recursive watching (win32/darwin); Linux watches each expanded folder. */
  recursive?: boolean
  caseInsensitive?: boolean
  /** The user's home folder (a broad root); injected for the unit test. */
  home?: string
  /** Whether a view of the explorer is visible at start (default false: no handle until `setActive(true)`). */
  active?: boolean
  /** Quiet time that closes a window, and the longest a window stays open. */
  delay?: number
  maxWait?: number
  maxBuffered?: number
}

export const WATCH_DELAY = 200
export const WATCH_MAX_WAIT = 1000
/** VS Code's ThrottledWorker bound (maxBufferedWork): events past it in one window are not kept one by one. */
export const MAX_BUFFERED = 10_000
const MAX_ROOTS = 200

export interface WatchStats {
  recursive: boolean
  roots: number
  /** Roots watched per expanded folder because they are too broad for a recursive handle. */
  broadRoots: number
  /** Whether a view of the explorer is visible: handles are held only then. */
  active: boolean
  handles: number
  expanded: number
  windows: number
  events: number
  sent: number
}

interface Live { handle: WatchHandle; root: string; dir: string; recursive: boolean }

/** A file system root: `X:\`, `X:/`, `/`, or a UNC share root `\\server\share\`. */
const isFsRoot = (p: string): boolean => /^[a-z]:[\\/]*$/i.test(p) || /^[\\/]+$/.test(p) || /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+[\\/]*$/.test(p)

const defaultExists = async (path: string): Promise<boolean> => { try { await lstat(path); return true } catch { return false } }

const describe = (err: unknown): string => {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ENOSPC') return 'O limite de arquivos vigiados do sistema foi atingido.'
  if (code === 'EPERM' || code === 'EACCES') return 'Sem permissão para vigiar esta pasta.'
  return `Não foi possível vigiar a pasta: ${(err as Error | undefined)?.message ?? String(err)}`
}

export class ExplorerWatchers implements IDisposable {
  private readonly sink: WatchSink
  private readonly watchFn: WatchFn
  private readonly exists: (path: string) => Promise<boolean>
  private readonly recursive: boolean
  private readonly ci: boolean
  private readonly homeKey: string
  private readonly delay: number
  private readonly maxWait: number
  private readonly maxBuffered: number
  private roots: string[] = []
  /** Roots by key: a recursive handle of its own, a share of an outer recursive one, or one handle per expanded folder. */
  private modes = new Map<string, 'recursive' | 'covered' | 'folders'>()
  /** The expanded folders the window announced, by key → its own spelling. */
  private expanded = new Map<string, string>()
  private announced: readonly string[] = []
  /** Stats not answered yet: a window never closes over them. */
  private inflight = 0
  /** Open handles: by root key (recursive) or by folder key (one per expanded folder). */
  private readonly live = new Map<string, Live>()
  /** Roots that failed or vanished: not retried until `rewatch`. */
  private readonly dead = new Set<string>()
  private readonly missing = new Set<string>()
  /** Roots being asked about (or asked about a moment ago). */
  private readonly checking = new Set<string>()
  private pending: { root: string; change: FileChange }[] = []
  private overflow = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private firstAt = 0
  private disposed = false
  private active: boolean
  private windows = 0
  private events = 0
  private sent = 0

  constructor(sink: WatchSink, options: WatchOptions = {}) {
    this.sink = sink
    this.watchFn = options.watch ?? ((path, opts, listener) => fsWatch(path, opts, listener) as FSWatcher)
    this.exists = options.exists ?? defaultExists
    this.recursive = options.recursive ?? (process.platform === 'win32' || process.platform === 'darwin')
    this.ci = options.caseInsensitive ?? (process.platform === 'win32' || process.platform === 'darwin')
    this.homeKey = pathKey(options.home ?? homedir(), this.ci)
    this.delay = options.delay ?? WATCH_DELAY
    this.maxWait = options.maxWait ?? WATCH_MAX_WAIT
    this.maxBuffered = options.maxBuffered ?? MAX_BUFFERED
    this.active = options.active ?? false
  }

  /**
   * Whether some view of the explorer is visible. Inactive: every handle is closed and a window being gathered is dropped.
   * Active again: the handles reopen and every expanded folder is reported changed (the disk was not followed meanwhile).
   */
  setActive(active: boolean): void {
    if (this.disposed || active === this.active) return
    this.active = active
    if (!active) {
      if (this.timer) clearTimeout(this.timer)
      this.timer = undefined
      this.pending = []
      this.overflow = new Set()
      for (const l of this.live.values()) this.close(l)
      this.live.clear()
      return
    }
    this.sync()
    if (this.expanded.size === 0) return
    this.sent += this.expanded.size
    this.sink.changed([...this.expanded.values()])
  }

  // ---------- what to watch ----------

  /** The window's project roots now: watchers start for the new ones and stop for the ones that left. */
  setRoots(list: readonly string[]): void {
    if (this.disposed) return
    const seen = new Set<string>()
    this.roots = list.filter(r => { const k = pathKey(r, this.ci); if (!r || seen.has(k)) return false; seen.add(k); return true }).slice(0, MAX_ROOTS)
    for (const k of [...this.dead, ...this.missing]) if (!seen.has(k)) { this.dead.delete(k); this.missing.delete(k) }
    this.applyExpanded()
    this.sync()
  }

  /** The folders the tree shows expanded: events elsewhere are dropped, and (Linux) these are the folders watched. */
  setExpanded(dirs: readonly string[]): void {
    if (this.disposed) return
    this.announced = dirs
    this.applyExpanded()
    this.sync()
  }

  private applyExpanded(): void {
    this.expanded = new Map()
    for (const d of this.announced) if (typeof d === 'string' && d !== '' && isInsideAny(this.roots, d, this.ci)) this.expanded.set(pathKey(d, this.ci), d)
  }

  /** "Atualizar": watchers that failed or whose root was gone get another try. */
  rewatch(): void {
    if (this.disposed) return
    this.dead.clear()
    this.missing.clear()
    this.sync()
  }

  stats(): WatchStats {
    let broadRoots = 0
    for (const r of this.roots) if (this.isBroad(r)) broadRoots++
    return { recursive: this.recursive, active: this.active, roots: this.roots.length, broadRoots, handles: this.live.size, expanded: this.expanded.size, windows: this.windows, events: this.events, sent: this.sent }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.pending = []
    for (const l of this.live.values()) this.close(l)
    this.live.clear()
  }

  private isBroad(root: string): boolean { return isFsRoot(root) || pathKey(root, this.ci) === this.homeKey }

  /** The innermost root that contains the path. */
  private rootOf(path: string): string | undefined {
    let best: string | undefined
    for (const r of this.roots) if (isInsideAny([r], path, this.ci) && (best === undefined || pathKey(r, this.ci).length > pathKey(best, this.ci).length)) best = r
    return best
  }

  /** Broad roots (and every root where recursive watching is off) go per folder; a root inside a recursive one shares its handle. */
  private computeModes(): void {
    this.modes = new Map()
    const recursive = this.recursive ? this.roots.filter(r => !this.isBroad(r)) : []
    for (const r of this.roots) {
      const k = pathKey(r, this.ci)
      if (!recursive.includes(r)) this.modes.set(k, 'folders')
      else this.modes.set(k, recursive.some(o => pathKey(o, this.ci) !== k && isInsideAny([o], r, this.ci)) ? 'covered' : 'recursive')
    }
  }

  /** Brings the open handles to what is wanted: one per recursive root, one per expanded folder of a per-folder root. */
  private sync(): void {
    this.computeModes()
    if (!this.active) return
    const wanted = new Map<string, { root: string; dir: string; recursive: boolean }>()
    for (const r of this.roots) { const k = pathKey(r, this.ci); if (this.modes.get(k) === 'recursive') wanted.set('r:' + k, { root: r, dir: r, recursive: true }) }
    for (const [k, dir] of this.expanded) {
      const root = this.rootOf(dir)
      if (root && this.modes.get(pathKey(root, this.ci)) === 'folders') wanted.set('d:' + k, { root, dir, recursive: false })
    }
    for (const [k, l] of this.live) if (!wanted.has(k)) { this.close(l); this.live.delete(k) }
    for (const [k, w] of wanted) {
      const rootKey = pathKey(w.root, this.ci)
      if (this.live.has(k) || this.dead.has(rootKey) || this.missing.has(rootKey)) continue
      this.start(k, w.root, w.dir, w.recursive)
    }
  }

  private close(l: Live): void { try { l.handle.close() } catch { /* already closed */ } }

  private start(key: string, root: string, dir: string, recursive: boolean): void {
    let handle: WatchHandle
    try {
      handle = this.watchFn(dir, { recursive, persistent: false }, (type, filename) => this.onEvent(root, dir, type, filename))
    } catch (err) {
      this.fail(root, dir, recursive, err)
      return
    }
    const live: Live = { handle, root, dir, recursive }
    this.live.set(key, live)
    handle.on('error', err => {
      if (this.live.get(key) === live) { this.close(live); this.live.delete(key) }
      this.fail(root, dir, recursive, err)
    })
  }

  /** A watcher that could not start or died: a root that is gone is "missing"; anything else is a failure the person is told of. */
  private fail(root: string, dir: string, recursive: boolean, err: unknown): void {
    if (this.disposed) return
    const rootKey = pathKey(root, this.ci)
    const code = (err as NodeJS.ErrnoException | undefined)?.code
    // A folder under the root that vanished (per-folder handles) is not a failure: its parent reports it.
    if (!recursive && dir !== root && code === 'ENOENT') return
    // Not retried while the answer is awaited (every announcement of the folders would start it again).
    this.dead.add(rootKey)
    void this.exists(root).then(there => {
      if (this.disposed) return
      if (!there) {
        this.dead.delete(rootKey)
        this.missing.add(rootKey)
        for (const [k, l] of this.live) if (pathKey(l.root, this.ci) === rootKey) { this.close(l); this.live.delete(k) }
        this.sink.rootMissing(root, true)
      } else {
        this.sink.failed(root, describe(err))
      }
    })
  }

  // ---------- events ----------

  private onEvent(handleRoot: string, base: string, type: string, filename: string | Buffer | null): void {
    if (this.disposed || !this.active) return
    const name = filename === null || filename === undefined ? '' : String(filename)
    // No name, or a name that is the whole (extended) path: the watched folder itself changed. On Windows a watched folder that
    // is deleted makes the handle repeat `rename` with the extended path (\?\ + the folder) without end until it is closed, so this must be cheap.
    if (name === '' || /^[\\/]{2}[?.][\\/]/.test(name)) { void this.checkRoot(handleRoot); return }
    // An entry shows up or goes away as a 'rename'; a plain 'change' only touches content or times, which the tree does not draw.
    if (type !== 'rename') return
    const path = joinPath(base, name)
    // A shared recursive handle reports for the roots nested in its own: the event belongs to the innermost one.
    const root = this.rootOf(path) ?? handleRoot
    const rootKey = pathKey(root, this.ci)
    if (pathKey(path, this.ci) === rootKey) { void this.checkRoot(root); return }
    this.events++
    if (isIgnoredChange(root, path, this.ci)) return
    if (!this.expanded.has(pathKey(parentPath(path), this.ci))) return
    if (this.overflow.has(rootKey)) return this.arm()
    if (this.pending.length + this.inflight >= this.maxBuffered) {
      // Too many to keep one by one: the whole project is dirty for this window.
      this.overflow.add(rootKey)
      this.pending = this.pending.filter(p => pathKey(p.root, this.ci) !== rootKey)
      return this.arm()
    }
    this.arm()
    this.inflight++
    void this.exists(path).then(there => {
      this.inflight--
      if (this.disposed || !this.active || this.overflow.has(rootKey)) return
      this.pending.push({ root, change: { type: there ? 'added' : 'deleted', path } })
      this.arm()
    })
  }

  /** Opens the window at the first event; every later one pushes its end out, up to `maxWait` from the first. */
  private arm(): void {
    if (this.disposed) return
    const now = Date.now()
    if (!this.timer) this.firstAt = now
    else clearTimeout(this.timer)
    const wait = Math.max(0, Math.min(this.delay, this.firstAt + this.maxWait - now))
    this.timer = setTimeout(() => { this.timer = undefined; if (this.inflight > 0) this.arm(); else this.flush() }, wait)
  }

  private flush(): void {
    if (this.disposed) return
    const batch = this.pending
    const overflowed = this.overflow
    this.pending = []
    this.overflow = new Set()
    this.windows++
    const dirs = new Map<string, string>()
    if (batch.length) {
      for (const dir of affectedDirs(coalesceEvents(batch.map(b => b.change), this.ci), this.ci)) {
        const own = this.expanded.get(pathKey(dir, this.ci))
        if (own !== undefined) dirs.set(pathKey(own, this.ci), own)
      }
    }
    for (const rootKey of overflowed) {
      for (const [k, d] of this.expanded) if (k === rootKey || k.startsWith(rootKey + '/')) dirs.set(k, d)
    }
    if (dirs.size === 0) return
    this.sent += dirs.size
    this.sink.changed([...dirs.values()])
  }

  /** The watched folder reported itself: when it is gone, the project is "missing" and its watcher is let go. */
  private async checkRoot(root: string): Promise<void> {
    const rootKey = pathKey(root, this.ci)
    if (this.missing.has(rootKey) || this.checking.has(rootKey)) return
    this.checking.add(rootKey)
    const there = await this.exists(root)
    // A folder that is still there is not asked about again for a moment (a storm of events must not become a storm of stats).
    if (there) setTimeout(() => this.checking.delete(rootKey), 500).unref?.()
    else this.checking.delete(rootKey)
    if (there || this.disposed) return
    this.missing.add(rootKey)
    for (const [k, l] of this.live) if (pathKey(l.root, this.ci) === rootKey) { this.close(l); this.live.delete(k) }
    this.sink.rootMissing(root, true)
  }
}
