// A file's parsed content kept in memory, reloaded by the executor: `get()` is synchronous (no stat, no read, no parse in
// the caller's turn), the disk is only ever touched through `io` (stat + readText, in a worker). Reloads come from three
// triggers: `fresh()` (a launch or a lookup that must see the newest value), the folder watcher, and a slow check every
// CHECK_MS for the cases a watcher misses. A reload whose stat signature did not change reads nothing.
import { watch, type FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'
import type { Executor } from '../exec/executor.ts'

export const CHECK_MS = 5000

export type SnapshotIo = Pick<Executor, 'run'>

export interface SnapshotOptions<T> {
  /** Turns the file's text (undefined: the file does not exist) into the value. May do async work (defaults written back, a backup copy). */
  decode: (text: string | undefined) => T | Promise<T>
  initial: T
  /** Awaited before each reload: our own writes still queued must land first, or the reload would read the old text. */
  before?: () => Promise<void>
  log?: (msg: string) => void
}

export class FileSnapshot<T> {
  readonly path: string
  private value: T
  private loaded = false
  private sig: string | undefined
  /** Bumped by `set`: a reload that started earlier must not overwrite the newer memory. */
  private gen = 0
  private running: Promise<T> | undefined
  private next: Promise<T> | undefined
  private watcher: FSWatcher | undefined
  private timer: NodeJS.Timeout | undefined
  private readonly io: SnapshotIo
  private readonly o: SnapshotOptions<T>

  constructor(path: string, io: SnapshotIo, o: SnapshotOptions<T>) {
    this.path = path
    this.io = io
    this.o = o
    this.value = o.initial
  }

  /** The newest value this process has seen (the initial one until the first reload ends). */
  get(): T { return this.value }

  isLoaded(): boolean { return this.loaded }

  /** Replaces the memory (a write of our own): the file is compared again at the next reload. */
  set(value: T): void {
    this.gen++
    this.value = value
    this.loaded = true
    this.sig = undefined
  }

  /** Resolves with the value after a reload that STARTED after this call (an in-flight one may have read the old file). Never rejects. */
  fresh(): Promise<T> {
    const start = (): Promise<T> => {
      this.next = undefined
      const p = this.reload().finally(() => { if (this.running === p) this.running = undefined })
      this.running = p
      return p
    }
    if (!this.running) return start()
    this.next ??= this.running.then(start, start)
    return this.next
  }

  private async reload(): Promise<T> {
    try {
      const gen = this.gen
      await this.o.before?.()
      let sig = 'missing'
      try {
        const st = await this.io.run('stat', [this.path])
        sig = `${st.size}:${st.mtimeMs}`
      } catch (e) {
        if ((e as { code?: string }).code !== 'ENOENT') throw e
      }
      if (this.loaded && sig === this.sig && gen === this.gen) return this.value
      let text: string | undefined
      if (sig !== 'missing') {
        try { text = await this.io.run('readText', [this.path]) } catch (e) {
          if ((e as { code?: string }).code !== 'ENOENT') throw e
          sig = 'missing'
        }
      }
      const value = await this.o.decode(text)
      if (gen !== this.gen) return this.value
      this.value = value
      this.sig = sig
      this.loaded = true
    } catch (e) {
      this.o.log?.(`snapshot ${this.path}: ${(e as Error).message}`)
    }
    return this.value
  }

  /** Watches the file's folder and checks every CHECK_MS. Idempotent; `stop()` undoes both. */
  start(): void {
    if (this.timer) return
    const name = basename(this.path)
    try {
      this.watcher = watch(dirname(this.path), (_ev, filename) => { if (filename === null || String(filename) === name) void this.fresh() })
      this.watcher.on('error', () => { this.watcher?.close(); this.watcher = undefined })
    } catch { /* no folder to watch yet: the periodic check still runs */ }
    this.timer = setInterval(() => void this.fresh(), CHECK_MS)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.watcher?.close()
    this.watcher = undefined
  }
}
