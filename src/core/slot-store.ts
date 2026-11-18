// Slot store, coordinator side: memory is the truth for what the daemon writes by itself; the disk follows through the
// executor (io lane, FIFO). Free of node:fs: it only hands text to `Executor.run`.
//   Snapshot  `put(path, text)`   last text wins while a write of that path is still queued; `writeTextAtomic` on disk.
//   Append    `append(path, text)` one AppendBatch per file (<= 50 ms or 64 KB per `appendText`).
//   Removal   `remove(path)`      goes behind the writes of the same path and cancels a queued `put`.
//   Barrier   `flush(path?)`      resolves when what was handed so far is on disk (or failed). Never rejects.
//   Echo      `isEcho(path, text)` the watcher drops a read that is just our own last write.
//   Failure   log + `store-fail` incident; a snapshot is retried once after `retryMs` unless something newer replaced it.
//             Memory is never rolled back.
// One path has at most one operation in flight; different paths run side by side (the lane keeps the global FIFO).
import { dirname } from 'node:path'
import { AppendBatch } from '../exec/append-batch.ts'
import type { Executor } from '../exec/executor.ts'
import { perf as globalPerf, type Perf } from './perf.ts'

export interface SlotStoreOptions {
  perf?: Perf
  log?: (msg: string) => void
  /** Wait before the single retry of a failed snapshot. Default 1000. */
  retryMs?: number
  /** Passed to every AppendBatch (delayMs, maxBytes). */
  append?: { delayMs?: number; maxBytes?: number }
}

/** `gen` is the newest generation this entry covers (puts merged into it, removals it superseded). */
type Entry = { kind: 'put'; text: string; retry: boolean; gen: number } | { kind: 'rm'; gen: number }

interface PathState {
  queue: Entry[]
  running: boolean
  /** Bumped by every put/remove: a retry only runs if nothing newer happened since the failure. */
  gen: number
  /** Highest generation already on disk (or failed, or superseded by a settled one). */
  settled: number
  /** Barrier waiters: resolve once `settled >= gen`. */
  waiters: Array<{ gen: number; resolve: () => void }>
  /** True while the newest request is a removal: the state may be released once idle. */
  removed: boolean
  retryTimer: NodeJS.Timeout | undefined
  retryText: string | undefined
}

export class SlotStore {
  private readonly ex: Executor
  private readonly perf: Perf
  private readonly log: (msg: string) => void
  private readonly retryMs: number
  private readonly appendOpts: { delayMs?: number; maxBytes?: number }
  private readonly paths = new Map<string, PathState>()
  private readonly batches = new Map<string, AppendBatch>()
  private readonly echo = new Map<string, string>()
  private readonly dirs = new Set<string>()
  /** puts: calls; writes: writeTextAtomic issued; removes: rm issued; failed: operations that failed (retries included). */
  readonly stats = {
    puts: 0, writes: 0, removes: 0, failed: 0,
    /** Paths currently holding state (queue, echo, generation). */
    paths: 0,
  }

  constructor(ex: Executor, opts: SlotStoreOptions = {}) {
    this.ex = ex
    this.perf = opts.perf ?? globalPerf
    this.log = opts.log ?? (() => {})
    this.retryMs = opts.retryMs ?? 1000
    this.appendOpts = opts.append ?? {}
  }

  // ---- snapshot ----------------------------------------------------------

  put(path: string, text: string): void {
    this.stats.puts++
    const st = this.state(path)
    st.gen++
    this.cancelRetry(st)
    st.removed = false
    const last = st.queue[st.queue.length - 1]
    if (last && last.kind === 'put') { last.text = text; last.retry = false; last.gen = st.gen } else st.queue.push({ kind: 'put', text, retry: false, gen: st.gen })
    this.kick(path, st)
  }

  // ---- append ------------------------------------------------------------

  append(path: string, text: string): void {
    let b = this.batches.get(path)
    if (!b) {
      this.ensureDir(path)
      b = new AppendBatch(this.ex, path, { ...this.appendOpts, onError: (e) => this.fail(path, e) })
      this.batches.set(path, b)
    }
    b.write(text)
  }

  // ---- removal -----------------------------------------------------------

  remove(path: string): void {
    const st = this.state(path)
    st.gen++
    this.cancelRetry(st)
    // Cancels everything still queued (puts and older removals); the operation running (already issued) cannot be taken back and stays ahead.
    st.queue = []
    st.queue.push({ kind: 'rm', gen: st.gen })
    st.removed = true
    // Lines already accumulated for the file go out first, so the removal lands behind them.
    void this.batches.get(path)?.flush()
    this.echo.delete(path)
    this.kick(path, st)
  }

  // ---- barrier / echo / drain -------------------------------------------

  /** Resolves when the writes requested up to this call (of `path`, or of every path) are on disk or have failed.
   *  Later puts do not extend the wait. A queued retry is not awaited. */
  async flush(path?: string): Promise<void> {
    if (path !== undefined) {
      await Promise.all([this.batches.get(path)?.flush(), this.settle(path)])
      return
    }
    const targets = [...this.paths.keys()].map((p) => this.settle(p)) // generations captured now
    await Promise.all([...[...this.batches.values()].map((b) => b.flush()), ...targets])
  }

  /** True when `text` is what this store last wrote (or is about to write) to `path`: the watcher's own echo. */
  isEcho(path: string, text: string): boolean {
    const q = this.paths.get(path)?.queue
    const pending = q && q.length ? q[q.length - 1] : undefined
    if (pending && pending.kind === 'put') return pending.text === text
    return this.echo.get(path) === text
  }

  /** Teardown: flushes everything, runs any waiting retry now (once) and waits for it. */
  async drain(): Promise<void> {
    await this.flush()
    for (const [path, st] of this.paths) {
      if (st.retryTimer === undefined) continue
      clearTimeout(st.retryTimer)
      st.retryTimer = undefined
      this.retryNow(path, st)
    }
    await this.flush()
  }


  private state(path: string): PathState {
    let st = this.paths.get(path)
    if (!st) {
      st = { queue: [], running: false, gen: 0, settled: 0, waiters: [], removed: false, retryTimer: undefined, retryText: undefined }
      this.paths.set(path, st)
      this.stats.paths = this.paths.size
    }
    return st
  }

  private settle(path: string): Promise<void> {
    const st = this.paths.get(path)
    if (!st || st.settled >= st.gen) return Promise.resolve()
    const gen = st.gen
    return new Promise((resolve) => st.waiters.push({ gen, resolve }))
  }

  private kick(path: string, st: PathState): void {
    if (st.running) return
    st.running = true
    // Microtask: puts of the same tick collapse into one write.
    queueMicrotask(() => void this.pump(path, st))
  }

  private async pump(path: string, st: PathState): Promise<void> {
    for (let e = st.queue.shift(); e; e = st.queue.shift()) {
      if (e.kind === 'put') await this.write(path, st, e)
      else await this.erase(path)
      if (e.gen > st.settled) st.settled = e.gen
      this.wake(st)
    }
    st.running = false
    st.settled = st.gen
    this.wake(st)
    // Idle after a completed removal: nothing left to remember (a later put starts fresh state).
    if (st.removed && st.waiters.length === 0 && st.retryTimer === undefined && this.paths.get(path) === st) {
      this.paths.delete(path)
      this.echo.delete(path)
      this.stats.paths = this.paths.size
    }
  }

  private wake(st: PathState): void {
    if (st.waiters.length === 0) return
    const keep: PathState['waiters'] = []
    for (const w of st.waiters) { if (w.gen <= st.settled) w.resolve(); else keep.push(w) }
    st.waiters = keep
  }

  private async write(path: string, st: PathState, e: { text: string; retry: boolean }): Promise<void> {
    const prev = this.echo.get(path)
    this.echo.set(path, e.text)
    this.ensureDir(path)
    this.stats.writes++
    const gen = st.gen
    try {
      await this.ex.run('writeTextAtomic', [path, e.text])
    } catch (err) {
      if (this.echo.get(path) === e.text) { if (prev === undefined) this.echo.delete(path); else this.echo.set(path, prev) }
      this.fail(path, err)
      if (!e.retry && st.gen === gen && st.queue.length === 0) this.scheduleRetry(path, st, e.text, gen)
    }
  }

  private async erase(path: string): Promise<void> {
    this.stats.removes++
    try {
      await this.ex.run('rm', [path])
    } catch (err) {
      this.fail(path, err)
    }
  }

  private scheduleRetry(path: string, st: PathState, text: string, gen: number): void {
    st.retryText = text
    st.retryTimer = setTimeout(() => {
      st.retryTimer = undefined
      if (st.gen === gen) this.retryNow(path, st)
    }, this.retryMs)
    st.retryTimer.unref()
  }

  private retryNow(path: string, st: PathState): void {
    const text = st.retryText
    st.retryText = undefined
    if (text === undefined) return
    st.queue.push({ kind: 'put', text, retry: true, gen: ++st.gen })
    this.kick(path, st)
  }

  private cancelRetry(st: PathState): void {
    if (st.retryTimer) { clearTimeout(st.retryTimer); st.retryTimer = undefined }
    st.retryText = undefined
  }

  private ensureDir(path: string): void {
    const dir = dirname(path)
    if (this.dirs.has(dir)) return
    this.dirs.add(dir)
    // Same FIFO lane as the write that follows, so the directory exists by then; a failure shows up in that write.
    this.ex.run('mkdirp', [dir]).catch(() => { this.dirs.delete(dir) })
  }

  private fail(path: string, err: unknown): void {
    this.stats.failed++
    const e = err as { code?: string; name?: string; message?: string }
    const code = e.code ?? e.name ?? 'unknown'
    this.log(`store: write failed for ${path}: ${code} ${e.message ?? ''}`)
    try { this.perf.incident('store-fail', { path, code }) } catch { /* the ruler must not break the store */ }
  }
}
