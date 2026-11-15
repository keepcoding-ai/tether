// "Search in files" in a worker thread (built into app/dist/text-search-worker.cjs): ripgrep's output is parsed and
// batched here, never in Electron's main process. extensions/search/service.ts is the other side.
// Protocol: { op: 'search', id, query } → zero or more { id, progress } → exactly one of { id, done } | { id, error } |
// { id, cancelled }. { op: 'cancel', id } aborts that search. { op: 'cancelAll' } aborts every search and replies
// { cancelledAll: true } once their rg processes ended (terminating a thread does not kill the child processes it spawned).
// { op: 'alive' } replies { alive: n } with the searches still running (tests). `workerData.repo` is where `@vscode/ripgrep` resolves from.
import { parentPort, workerData } from 'node:worker_threads'
import { deserializeSearchError, type IFileMatch, type ITextQuery, type ITextSearchCompleteMessage, SearchErrorCode } from '../shared/vscode-search.ts'
import { findRipgrep } from './file-index.ts'
import { RipgrepTextSearchEngine } from './vscode-ripgrep-text-search.ts'
import { TextSearchManager } from './vscode-text-search-manager.ts'

export type TextSearchWorkerRequest =
  | { op: 'search'; id: number; query: ITextQuery }
  | { op: 'cancel'; id: number }
  | { op: 'cancelAll' }
  | { op: 'alive' }

export type TextSearchWorkerReply =
  | { id: number; progress: IFileMatch[] }
  | { id: number; done: { limitHit: boolean; messages: ITextSearchCompleteMessage[] } }
  | { id: number; error: { message: string; code?: string } }
  | { id: number; cancelled: true }
  | { cancelledAll: true }
  | { alive: number }

const NO_RG = 'O ripgrep não foi encontrado nesta instalação.'
const repo = (workerData as { repo?: string } | undefined)?.repo
const rg = findRipgrep(repo) ?? findRipgrep()
const engine = rg ? new RipgrepTextSearchEngine(rg) : undefined
// One controller per running search; an entry leaves the map only when its search has settled (rg process gone).
const running = new Map<number, { abort: AbortController; settled: Promise<void> }>()

const reply = (msg: TextSearchWorkerReply): void => parentPort!.postMessage(msg)
const codeName = (code: number | undefined): string | undefined => Object.entries(SearchErrorCode).find(([, v]) => v === code)?.[0]

async function run(id: number, query: ITextQuery, signal: AbortSignal): Promise<void> {
  if (!engine) { reply({ id, error: { message: NO_RG } }); return }
  try {
    const stats = await new TextSearchManager(query, engine).search(matches => { if (!signal.aborted) reply({ id, progress: matches }) }, signal)
    if (signal.aborted) reply({ id, cancelled: true })
    else reply({ id, done: { limitHit: stats.limitHit === true, messages: stats.messages } })
  } catch (err) {
    const e = deserializeSearchError(err instanceof Error ? err : new Error(String(err)))
    if (signal.aborted || e.code === SearchErrorCode.canceled) reply({ id, cancelled: true })
    else { const code = codeName(e.code); reply({ id, error: { message: e.message, ...(code ? { code } : {}) } }) }
  }
}

parentPort?.on('message', (msg: TextSearchWorkerRequest) => {
  if (msg.op === 'search') {
    running.get(msg.id)?.abort.abort()
    const abort = new AbortController()
    const settled = run(msg.id, msg.query, abort.signal).finally(() => { if (running.get(msg.id)?.abort === abort) running.delete(msg.id) })
    running.set(msg.id, { abort, settled })
  } else if (msg.op === 'cancel') {
    running.get(msg.id)?.abort.abort()
  } else if (msg.op === 'cancelAll') {
    const all = [...running.values()]
    for (const r of all) r.abort.abort()
    void Promise.allSettled(all.map(r => r.settled)).then(() => reply({ cancelledAll: true }))
  } else if (msg.op === 'alive') {
    reply({ alive: running.size })
  }
})
