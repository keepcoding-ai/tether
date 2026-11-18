// "Search in files", main-process side: one live search at a time over the worker of app/main/text-search-worker.ts.
// A new search cancels the one running (it resolves { kind: 'cancelled' }) and progress of a search that is no longer
// the live one is dropped. Every failure (the worker that does not load, dies or errors) answers the live search with the
// reason, in Portuguese: never a reply that silently stays away. The next search starts a new worker.
import { Worker } from 'node:worker_threads'
import type { IFileMatch, ITextQuery } from '../../app/shared/vscode-search.ts'
import type { TextSearchWorkerReply, TextSearchWorkerRequest } from '../../app/main/text-search-worker.ts'
import type { SearchDone } from './ipc.ts'

type Live = {
  id: number
  resolve: (d: SearchDone) => void
  onProgress: (id: number, matches: IFileMatch[]) => void
}

const DISPOSE_WAIT_MS = 500

export class SearchService {
  private worker: Worker | undefined
  private live: Live | undefined
  private lastFolders: readonly string[] = []
  private readonly workerPath: string
  private readonly repo: string

  constructor(workerPath: string, repo: string) {
    this.workerPath = workerPath
    this.repo = repo
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    const w = new Worker(this.workerPath, { workerData: { repo: this.repo } })
    w.on('message', (msg: TextSearchWorkerReply) => {
      if (this.worker !== w) return
      if (!('id' in msg)) return // cancelledAll is read by dispose(), alive by tests
      const live = this.live
      // Replies of a cancelled or replaced search are stale.
      if (!live || live.id !== msg.id) return
      if ('progress' in msg) { live.onProgress(live.id, msg.progress); return }
      this.live = undefined
      if ('done' in msg) live.resolve({ kind: 'done', limitHit: msg.done.limitHit, messages: msg.done.messages })
      else if ('error' in msg) live.resolve({ kind: 'error', message: msg.error.message, ...(msg.error.code ? { code: msg.error.code } : {}) })
      else live.resolve({ kind: 'cancelled' })
    })
    w.on('error', err => { if (this.worker === w) this.reset(`A pesquisa parou: ${err.message}`) })
    w.on('exit', code => { if (this.worker === w) this.reset(`A pesquisa parou (código ${code}).`) })
    w.unref()
    this.worker = w
    return w
  }

  /** The worker is gone: the live search answers with why; the next search starts a new worker. */
  private reset(why: string): void {
    this.worker = undefined
    const live = this.live
    this.live = undefined
    live?.resolve({ kind: 'error', message: why })
  }

  private post(msg: TextSearchWorkerRequest): void {
    this.ensureWorker().postMessage(msg)
  }

  search(id: number, query: ITextQuery, onProgress: (id: number, matches: IFileMatch[]) => void): Promise<SearchDone> {
    const previous = this.live
    this.live = undefined
    if (previous) {
      previous.resolve({ kind: 'cancelled' })
      try { this.post({ op: 'cancel', id: previous.id }) } catch { /* the worker is gone: so is its search */ }
    }
    this.lastFolders = query.folderQueries.map(f => f.folder)
    return new Promise<SearchDone>(resolve => {
      this.live = { id, resolve, onProgress }
      try {
        this.post({ op: 'search', id, query })
      } catch (err) {
        this.live = undefined
        resolve({ kind: 'error', message: `A pesquisa não abriu: ${(err as Error).message}` })
      }
    })
  }

  cancel(id: number): void {
    const live = this.live
    if (!live || live.id !== id) return
    this.live = undefined
    live.resolve({ kind: 'cancelled' })
    try { this.post({ op: 'cancel', id }) } catch { /* the worker is gone */ }
  }

  /** The folders of the last search started (the disk-replace guard reads them). */
  folders(): readonly string[] {
    return this.lastFolders
  }

  /** Cancels what runs and waits (briefly) for the rg processes to end before the thread goes: terminating it would leave them orphaned. */
  async dispose(): Promise<void> {
    const w = this.worker
    this.worker = undefined
    const live = this.live
    this.live = undefined
    live?.resolve({ kind: 'cancelled' })
    if (!w) return
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, DISPOSE_WAIT_MS)
      const finish = () => { clearTimeout(timer); resolve() }
      const onMessage = (m: TextSearchWorkerReply) => { if ('cancelledAll' in m) finish() }
      w.on('message', onMessage)
      w.once('exit', finish)
      try { w.postMessage({ op: 'cancelAll' } satisfies TextSearchWorkerRequest) } catch { finish() }
    })
    await w.terminate().catch(() => 0)
  }
}
