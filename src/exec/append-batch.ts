// Append batch: the "Acréscimo" class of the store (log lines, history, ruler). `write(text)` only accumulates in memory;
// one `appendText` goes through the executor at most every `delayMs` (50) or once `maxBytes` (64 KB, counted in UTF-16
// units) are pending. The io lane is FIFO, so the order of the writes is the order in the file. Free of node:fs on purpose
// (the coordinator imports it); the fatal-exit path takes its synchronous writer by injection.
import type { Executor } from './executor.ts'

export interface AppendBatchOptions {
  delayMs?: number
  maxBytes?: number
  /** A batch the worker could not write (disk full, executor down). It is dropped, never retried: a log must not pile up. */
  onError?: (e: Error) => void
  /** Synchronous append used only by `emergencySync`. Injected so this module stays fs-free. */
  emergency?: (path: string, text: string) => void
}

export class AppendBatch {
  readonly path: string
  private readonly ex: Executor
  private readonly delayMs: number
  private readonly maxBytes: number
  private readonly onError: (e: Error) => void
  private readonly emergency: ((path: string, text: string) => void) | undefined
  private chunks: string[] = []
  private size = 0
  private timer: NodeJS.Timeout | undefined
  private closed = false
  private readonly inflight = new Set<Promise<void>>()
  /** writes: write() calls; appends: appendText requests issued; failed: batches lost. */
  readonly stats = { writes: 0, appends: 0, failed: 0 }

  constructor(ex: Executor, path: string, opts: AppendBatchOptions = {}) {
    this.ex = ex
    this.path = path
    this.delayMs = opts.delayMs ?? 50
    this.maxBytes = opts.maxBytes ?? 64 * 1024
    this.onError = opts.onError ?? (() => {})
    this.emergency = opts.emergency
  }

  /** Text pending in memory (not yet handed to the executor). */
  get pending(): number { return this.size }

  write(text: string): void {
    if (!text) return
    this.stats.writes++
    this.chunks.push(text)
    this.size += text.length
    if (this.closed) return // after close nothing is scheduled: only `emergencySync` can still save it
    if (this.size >= this.maxBytes) this.send()
    else if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = undefined; this.send() }, this.delayMs)
      this.timer.unref()
    }
  }

  private send(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined }
    if (!this.chunks.length) return
    const text = this.chunks.join('')
    this.chunks = []
    this.size = 0
    this.stats.appends++
    const p: Promise<void> = this.ex.run('appendText', [this.path, text]).then(
      () => {},
      (e: Error) => { this.stats.failed++; try { this.onError(e) } catch { /* the sink must not throw */ } },
    )
    this.inflight.add(p)
    void p.then(() => { this.inflight.delete(p) })
  }

  /** Sends what is pending and resolves when everything handed so far is on disk (or failed). */
  async flush(): Promise<void> {
    this.send()
    while (this.inflight.size) await Promise.all([...this.inflight])
  }

  /** Final flush; later writes are only kept for `emergencySync`. Call before closing the executor. */
  async close(): Promise<void> {
    this.closed = true
    await this.flush()
  }

  /**
   * FATAL EXIT ONLY (`process.on('exit')`, where nothing asynchronous can run): appends what is still pending with the
   * injected synchronous writer. A batch already handed to the worker is not waited for and may be lost (at most
   * ~50 ms of lines). Blocking is bounded by one small append.
   */
  emergencySync(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined }
    if (!this.chunks.length || !this.emergency) return
    const text = this.chunks.join('')
    this.chunks = []
    this.size = 0
    try { this.emergency(this.path, text) } catch { /* nothing left to try */ }
  }
}
