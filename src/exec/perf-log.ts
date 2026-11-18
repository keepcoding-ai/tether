// Persisted ruler: every `everyMs` (60 s) one JSON line with the samples and incidents newer than the previous line, plus
// the label totals that changed, appended through an AppendBatch to <home>/perf/tetherd.jsonl. When the file passes
// `maxBytes` it becomes tetherd.jsonl.1 (the older .1 is replaced): two files of 5 MB cover well over 8 h of a calm daemon.
// Free of node:fs: all disk work goes through the executor.
import { join } from 'node:path'
import type { Perf, PerfLabelStat } from '../core/perf.ts'
import { AppendBatch } from './append-batch.ts'
import type { Executor } from './executor.ts'

export function perfLogPath(home: string): string {
  return join(home, 'perf', 'tetherd.jsonl')
}

export interface PerfLogOptions {
  everyMs?: number
  maxBytes?: number
  onError?: (e: Error) => void
  emergency?: (path: string, text: string) => void
}

export class PerfLog {
  readonly batch: AppendBatch
  private readonly ex: Executor
  private readonly perf: Perf
  private readonly path: string
  private readonly everyMs: number
  private readonly maxBytes: number
  private timer: NodeJS.Timeout | undefined
  private since = 0
  private bytes = 0
  private readonly lastLabels = new Map<string, string>()
  private ready: Promise<void> | undefined
  private busy: Promise<void> = Promise.resolve()

  constructor(ex: Executor, perf: Perf, home: string, opts: PerfLogOptions = {}) {
    this.ex = ex
    this.perf = perf
    this.path = perfLogPath(home)
    this.everyMs = opts.everyMs ?? 60_000
    this.maxBytes = opts.maxBytes ?? 5 * 1024 * 1024
    this.batch = new AppendBatch(ex, this.path, { onError: opts.onError, emergency: opts.emergency })
  }

  start(): void {
    if (this.timer) return
    this.since = Date.now()
    this.timer = setInterval(() => { void this.tick() }, this.everyMs)
    this.timer.unref()
  }

  private prepare(): Promise<void> {
    this.ready ??= (async () => {
      await this.ex.run('mkdirp', [join(this.path, '..')])
      try { this.bytes = (await this.ex.run('stat', [this.path])).size } catch { this.bytes = 0 }
    })()
    return this.ready
  }

  /** Writes the line for everything since the previous one. Serialized: two ticks never interleave a rotation. */
  tick(): Promise<void> {
    this.busy = this.busy.then(() => this.write()).catch(() => {})
    return this.busy
  }

  private async write(): Promise<void> {
    const snap = this.perf.snapshot(this.since)
    this.since = snap.now
    const labels: Record<string, PerfLabelStat> = {}
    for (const [k, v] of Object.entries(snap.labels ?? {})) {
      const sig = `${v.n}/${v.totalMs}`
      if (this.lastLabels.get(k) !== sig) { labels[k] = v; this.lastLabels.set(k, sig) }
    }
    if (!snap.samples.length && !snap.incidents.length && !Object.keys(labels).length) return
    const line = JSON.stringify({ t: snap.now, samples: snap.samples, incidents: snap.incidents, dropped: snap.dropped, labels }) + '\n'
    await this.prepare()
    if (this.bytes > 0 && this.bytes + line.length > this.maxBytes) {
      await this.batch.flush()
      try { await this.ex.run('rename', [this.path, `${this.path}.1`]) } catch { /* keep appending to the big file */ }
      this.bytes = 0
    }
    this.bytes += line.length
    this.batch.write(line)
  }

  /** Last line, then the batch is flushed. Idempotent. */
  async stop(): Promise<void> {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined }
    await this.tick()
    await this.batch.close()
  }
}
