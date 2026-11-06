// Quick Open (Ctrl+P), main-process side: the search over the index worker (app/main/file-index-worker.ts), served on the
// bus `ext:quick-open:*` (extensions/quick-open/main.ts). Searches are coalesced: a request replaces the one in flight,
// which resolves with null at once (the box already shows a newer query); the worker drops the replaced work. A root
// without a pane is the person's notes folder. Every failure (the worker that does not load or dies, an error in it)
// answers the search with the reason, which the box shows: never a reply that silently stays away. Opening files is the
// core's (app/main/file-open-main.ts).
import { statSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import { failedResult, type QuickOpenResult } from '../../app/shared/quick-open.ts'
import { MAX_RESULTS } from '../../app/main/file-index.ts'
import type { WorkerRequest } from '../../app/main/file-index-worker.ts'
import { userNotesDir } from '../../app/main/note-files.ts'

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory() } catch { return false }
}

type Pending = { req: Omit<Extract<WorkerRequest, { op: 'search' }>, 'id'>; resolve: (r: QuickOpenResult | null) => void }

export class QuickOpenService {
  private worker: Worker | undefined
  private readonly workerPath: string
  private readonly repo: string
  private nextId = 1
  private inFlight: { id: number; root: string; resolve: (r: QuickOpenResult | null) => void } | undefined
  /** The root the open box reads (its search session); null while the box is closed. */
  private sessionRoot: string | undefined

  constructor(workerPath: string, repo: string) {
    this.workerPath = workerPath
    this.repo = repo
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    const w = new Worker(this.workerPath, { workerData: { repo: this.repo } })
    w.on('message', (msg: { id: number; result?: QuickOpenResult; error?: string; stale?: true }) => {
      if (!this.inFlight || msg.id !== this.inFlight.id) return
      const done = this.inFlight
      this.inFlight = undefined
      if (msg.stale) { done.resolve(null); return }
      if (msg.error) console.error(`quick open: ${msg.error}`)
      done.resolve(msg.result ?? failedResult(done.root, msg.error ?? 'o índice não respondeu'))
    })
    w.on('error', err => {
      console.error('quick open: o índice parou', err)
      if (this.worker === w) this.reset(`o índice de arquivos parou: ${err.message}`)
    })
    w.on('exit', code => { if (this.worker === w) this.reset(`o índice de arquivos saiu (código ${code})`) })
    w.unref()
    this.worker = w
    return w
  }

  /** The worker is gone: the search it was running answers with why; the next one starts a new worker. */
  private reset(why: string): void {
    this.worker = undefined
    const done = this.inFlight
    this.inFlight = undefined
    done?.resolve(failedResult(done.root, why))
  }

  /** Sends the request at once; the search it replaces (still in flight) resolves with null. */
  private send(next: Pending): void {
    this.inFlight?.resolve(null)
    const id = this.nextId++
    this.inFlight = { id, root: next.req.root, resolve: next.resolve }
    try {
      this.ensureWorker().postMessage({ id, ...next.req } satisfies WorkerRequest)
    } catch (err) {
      console.error('quick open: o índice não abriu', err)
      this.inFlight = undefined
      next.resolve(failedResult(next.req.root, `o índice de arquivos não abriu: ${(err as Error).message}`))
    }
  }

  /** The root a search runs in: the pane's opening folder when it is a folder, else the person's notes folder. */
  rootFor(paneCwd: unknown): string {
    return typeof paneCwd === 'string' && paneCwd.trim() !== '' && isDir(paneCwd) ? paneCwd : userNotesDir()
  }

  search(paneCwd: unknown, query: string, recent: string[]): Promise<QuickOpenResult | null> {
    const root = this.rootFor(paneCwd)
    return new Promise(resolve => {
      this.send({ req: { op: 'search', root, query, recent, max: MAX_RESULTS }, resolve })
    })
  }

  /** The box opened: a new search session, the root is listed now (VS Code lists when its Quick Open opens). */
  refresh(paneCwd: unknown): void {
    const root = this.rootFor(paneCwd)
    this.sessionRoot = root
    // A worker that cannot start is reported by the search that follows.
    try { this.ensureWorker().postMessage({ op: 'refresh', root } satisfies WorkerRequest) } catch { /* see search */ }
  }

  /** The box closed: the session's list and cache are dropped (VS Code's clearCache); a search still waiting is moot. */
  end(): void {
    const root = this.sessionRoot
    this.sessionRoot = undefined
    this.inFlight?.resolve(null)
    this.inFlight = undefined
    if (root === undefined || !this.worker) return
    try { this.worker.postMessage({ op: 'close', root } satisfies WorkerRequest) } catch { /* the worker is gone: so is its list */ }
  }

  dispose(): void {
    const w = this.worker
    this.worker = undefined
    void w?.terminate()
  }
}
