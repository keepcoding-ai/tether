// Quick Open's file index in a worker thread (built into app/dist/file-index-worker.cjs): listing a big root and
// scoring tens of thousands of paths per keystroke must never block Electron's main process (window, IPC, tray).
// Protocol (app/main/quick-open-main.ts is the other side): { id, op: 'search', root, query, recent, max } →
// { id, result }; { op: 'refresh', root } has no reply. `workerData.repo` is where `@vscode/ripgrep` resolves from.
import { parentPort, workerData } from 'node:worker_threads'
import { FileIndex, findRipgrep } from './file-index.ts'

export type WorkerRequest =
  | { id: number; op: 'search'; root: string; query: string; recent: string[]; max?: number }
  | { op: 'refresh'; root: string }

const repo = (workerData as { repo?: string } | undefined)?.repo
const index = new FileIndex({ rg: findRipgrep(repo) ?? null })

parentPort?.on('message', (msg: WorkerRequest) => {
  if (msg.op === 'refresh') { index.refresh(msg.root); return }
  try {
    const result = index.search(msg.root, msg.query, msg.recent, msg.max)
    parentPort!.postMessage({ id: msg.id, result })
  } catch (err) {
    parentPort!.postMessage({ id: msg.id, error: (err as Error).message })
  }
})
