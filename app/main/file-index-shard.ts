// Parallel scoring for Quick Open: the session's list is dealt round-robin into slices, one per shard worker
// (app/main/file-index-shard-worker.ts). Each shard keeps its own search cache for its slice (a query that extends
// an earlier one is filtered from that row) and answers a search with its best `max` paths in VS Code's order.
// The coordinator (FileIndex.searchAsync) merges the shards' tops with the same comparator (SearchCache.sortResults →
// compareItemsByFuzzyScore): the best `max` of the union of the slices' best `max` is the best `max` of the whole list.
import { Worker } from 'node:worker_threads'
import { type FileEntry, fileEntry, relAccessor } from './file-entry.ts'
import { SearchCache } from './vscode-raw-search.ts'

/** One slice of the list with its session cache. Pure and synchronous: the unit tests drive it without threads. */
export class Shard {
  private readonly entries: FileEntry[]
  private readonly cache = new SearchCache<FileEntry>()

  constructor(rels: readonly string[]) {
    this.entries = rels.map(fileEntry)
  }

  /** The slice's best `max` paths for the query, best first, and how many candidates it had. */
  top(query: string, max: number): { rels: string[]; matched: number } {
    const matched = this.cache.getResultsFromCache(query, this.entries)
    this.cache.put(query, matched)
    return { rels: this.cache.sortResults(matched, query, max, relAccessor).map(e => e.rel), matched: matched.length }
  }
}

/** `n` slices of `list`, dealt round-robin: matches cluster in folders, so contiguous cuts would leave one shard with most of the work. */
export function slices<T>(list: readonly T[], n: number): T[][] {
  const out: T[][] = Array.from({ length: Math.min(n, list.length) }, () => [])
  for (let i = 0; i < list.length; i++) out[i % out.length]!.push(list[i]!)
  return out
}

export type ShardRequest =
  | { op: 'load'; sid: number; rels: string[] }
  | { op: 'drop'; sid: number }
  | { op: 'search'; job: number; sid: number; query: string; max: number; seq: number }
export type ShardReply = { job: number; rels?: string[]; stale?: true }

export const STALE = Symbol('stale')

/** The shard workers. `latest` is shared memory holding the newest search's sequence number: a shard skips a job older than it. */
export class ShardPool {
  broken = false
  private workers: Worker[] = []
  private readonly latest = new Int32Array(new SharedArrayBuffer(4))
  private nextJob = 1
  private readonly waiting = new Map<number, (r: ShardReply) => void>()
  private readonly path: string
  private readonly size: number

  constructor(path: string, size: number) {
    this.path = path
    this.size = size
  }

  /** Starts the workers (the box opening warms them up before the first search needs them). */
  warm(): void {
    if (this.workers.length || this.broken) return
    for (let i = 0; i < this.size; i++) {
      const w = new Worker(this.path, { workerData: { latest: this.latest.buffer } })
      w.on('message', (r: ShardReply) => { const f = this.waiting.get(r.job); this.waiting.delete(r.job); f?.(r) })
      w.on('error', () => this.fail())
      w.on('exit', () => this.fail())
      w.unref()
      this.workers.push(w)
    }
  }

  private fail(): void {
    this.broken = true
    for (const f of this.waiting.values()) f({ job: 0, stale: true })
    this.waiting.clear()
    const ws = this.workers
    this.workers = []
    for (const w of ws) void w.terminate()
  }

  /** The newest search's sequence number (jobs with a smaller one are skipped). */
  setLatest(seq: number): void { Atomics.store(this.latest, 0, seq) }

  load(sid: number, rels: readonly string[]): void {
    this.warm()
    slices(rels, this.workers.length).forEach((chunk, i) => this.workers[i]?.postMessage({ op: 'load', sid, rels: chunk } satisfies ShardRequest))
  }

  drop(sid: number): void {
    for (const w of this.workers) w.postMessage({ op: 'drop', sid } satisfies ShardRequest)
  }

  /** Every shard's top, concatenated; STALE when a newer search arrived (or a shard went away) before they all answered. */
  async search(sid: number, query: string, max: number, seq: number): Promise<string[] | typeof STALE> {
    const replies = await Promise.all(this.workers.map(w => new Promise<ShardReply>(resolve => {
      const job = this.nextJob++
      this.waiting.set(job, resolve)
      w.postMessage({ op: 'search', job, sid, query, max, seq } satisfies ShardRequest)
    })))
    const out: string[] = []
    for (const r of replies) { if (r.stale || !r.rels) return STALE; out.push(...r.rels) }
    return out
  }

  dispose(): void {
    this.broken = true
    this.fail()
  }
}
