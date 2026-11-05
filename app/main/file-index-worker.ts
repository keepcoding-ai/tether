// Quick Open's file index in a worker thread (built into app/dist/file-index-worker.cjs): listing a big root and
// scoring tens of thousands of paths per keystroke must never block Electron's main process (window, IPC, tray).
// Protocol (app/main/quick-open-main.ts is the other side): { id, op: 'search', root, query, recent, max } →
// { id, result } (or { id, stale: true } when a newer search replaced it); { op: 'refresh', root } (the box opened) and { op: 'close', root } (it closed) have no reply. `workerData.repo` is where `@vscode/ripgrep` resolves from.
import { availableParallelism } from 'node:os'
import { join } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import { FileIndex, findRipgrep, MAX_RESULTS } from './file-index.ts'

export type WorkerRequest =
  | { id: number; op: 'search'; root: string; query: string; recent: string[]; max?: number }
  | { op: 'refresh'; root: string }
  | { op: 'close'; root: string }

const repo = (workerData as { repo?: string } | undefined)?.repo
// The repo main passes first; else the worker's own folder (app/dist, up to the repo's node_modules), never the cwd.
// Scoring shards next to this file (app/dist in the bundle): up to 4, leaving a core for the rest; one core scores here.
const shardCount = Math.max(1, Math.min(4, availableParallelism() - 1))
const dir: string = typeof __dirname === 'string' ? __dirname : import.meta.dirname
const index = new FileIndex({
  rg: findRipgrep(repo) ?? findRipgrep() ?? null,
  ...(shardCount >= 2 ? { shards: { path: join(dir, 'file-index-shard-worker.cjs'), size: shardCount } } : {}),
})
let latest = 0

parentPort?.on('message', (msg: WorkerRequest) => {
  if (msg.op === 'refresh') { index.refresh(msg.root); return }
  if (msg.op === 'close') { index.close(msg.root); return }
  // Deferred a tick: requests already queued behind this one are read first, and only the newest runs.
  latest = msg.id
  index.noteLatest(msg.id)
  setImmediate(() => void answer(msg))
})

async function answer(msg: Extract<WorkerRequest, { op: 'search' }>): Promise<void> {
  if (msg.id !== latest) { parentPort!.postMessage({ id: msg.id, stale: true }); return }
  try {
    const result = await index.searchAsync(msg.root, msg.query, msg.recent, msg.max ?? MAX_RESULTS, msg.id)
    parentPort!.postMessage(result ? { id: msg.id, result } : { id: msg.id, stale: true })
  } catch (err) {
    parentPort!.postMessage({ id: msg.id, error: (err as Error).message })
  }
}
