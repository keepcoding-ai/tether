// Quick Open (Ctrl+P), main-process side: the IPC the renderer calls, over the index worker
// (app/main/file-index-worker.ts). Searches are coalesced: while one runs in the worker, only the newest request
// waits; the ones it replaced resolve with null (the box already shows a newer query). A root without a pane is
// the person's notes folder. Every failure (the worker that does not load or dies, an error in it) answers the
// search with the reason, which the box shows: never a reply that silently stays away. Opening a binary or too large file hands it to the system's program, except what
// would run (app/main/file-index.ts inspectFile).
import type { IpcMain, Shell } from 'electron'
import { openSync, readSync, closeSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { failedResult, type QuickOpenResult, type QuickOpenTarget } from '../shared/quick-open.ts'
import { inspectFile, MAX_RESULTS } from './file-index.ts'
import type { WorkerRequest } from './file-index-worker.ts'
import { userNotesDir } from './note-files.ts'

/** How many bytes decide text vs binary (VS Code reads 512 for its NUL check; a little more costs nothing). */
const HEAD_BYTES = 4096

function readHead(path: string): Buffer {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(HEAD_BYTES)
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0)
    return buf.subarray(0, n)
  } finally { closeSync(fd) }
}

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
  private queued: Pending | undefined
  /** The root the open box reads (its search session); null while the box is closed. */
  private sessionRoot: string | undefined

  constructor(workerPath: string, repo: string) {
    this.workerPath = workerPath
    this.repo = repo
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    const w = new Worker(this.workerPath, { workerData: { repo: this.repo } })
    w.on('message', (msg: { id: number; result?: QuickOpenResult; error?: string }) => {
      if (!this.inFlight || msg.id !== this.inFlight.id) return
      const done = this.inFlight
      this.inFlight = undefined
      if (msg.error) console.error(`quick open: ${msg.error}`)
      done.resolve(msg.result ?? failedResult(done.root, msg.error ?? 'o índice não respondeu'))
      this.pump()
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
    this.pump()
  }

  private pump(): void {
    if (this.inFlight || !this.queued) return
    const next = this.queued
    this.queued = undefined
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
      this.queued?.resolve(null)
      this.queued = { req: { op: 'search', root, query, recent, max: MAX_RESULTS }, resolve }
      this.pump()
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
    this.queued?.resolve(null)
    this.queued = undefined
    if (root === undefined || !this.worker) return
    try { this.worker.postMessage({ op: 'close', root } satisfies WorkerRequest) } catch { /* the worker is gone: so is its list */ }
  }

  dispose(): void {
    const w = this.worker
    this.worker = undefined
    void w?.terminate()
  }
}

/** Wires the IPC: `quickopen:search`, `quickopen:refresh`, `quickopen:end`, `quickopen:inspect`, `quickopen:open-external`. */
export function registerQuickOpen(ipcMain: IpcMain, shell: Shell, distDir: string): QuickOpenService {
  const service = new QuickOpenService(join(distDir, 'file-index-worker.cjs'), join(distDir, '..', '..'))
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 200) : [])
  ipcMain.handle('quickopen:search', (_e, paneCwd: unknown, query: unknown, recent: unknown) =>
    service.search(paneCwd, typeof query === 'string' ? query : '', strings(recent)))
  ipcMain.on('quickopen:refresh', (_e, paneCwd: unknown) => service.refresh(paneCwd))
  ipcMain.on('quickopen:end', () => service.end())
  ipcMain.handle('quickopen:inspect', (_e, path: unknown): QuickOpenTarget =>
    typeof path === 'string' && path.trim() !== '' ? inspectFile(path, readHead) : { kind: 'missing' })
  ipcMain.handle('quickopen:open-external', async (_e, path: unknown): Promise<{ ok: true } | { ok: false; message: string }> => {
    if (typeof path !== 'string' || path.trim() === '') return { ok: false, message: 'Caminho inválido.' }
    const target = inspectFile(path, readHead)
    if (target.kind === 'missing') return { ok: false, message: 'O arquivo não existe mais.' }
    if (target.kind === 'folder') return { ok: false, message: 'O caminho é uma pasta.' }
    if (target.kind === 'text') return { ok: false, message: 'Arquivo de texto: abre no editor do tether.' }
    if (target.runnable) return { ok: false, message: 'Este tipo de arquivo é executável: o tether não o abre.' }
    const err = await shell.openPath(path)
    return err ? { ok: false, message: err } : { ok: true }
  })
  return service
}
