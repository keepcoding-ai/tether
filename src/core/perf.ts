// Performance ruler (core, pure): an event-loop delay sampler plus a bounded incident ring.
// One sampler timer (unref'd) reads the loop-delay histogram once a second into a fixed ring of
// numbers (pre-allocated, never grows); incidents are rate-limited per kind. Pull only: `snapshot()`.
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'

export interface PerfSample { t: number; maxMs: number; p99Ms: number }
export interface PerfIncident { t: number; kind: string; data?: object }
/** Accumulated cost of one timed label. */
export interface PerfLabelStat { n: number; totalMs: number; maxMs: number }
export interface PerfSnapshot {
  /** Wall-clock ms of the snapshot. */
  now: number
  intervalMs: number
  samples: PerfSample[]
  incidents: PerfIncident[]
  /** Incidents dropped by the per-kind rate limit since start, by kind. */
  dropped: Record<string, number>
  /** Per-label totals of everything run through `timed`/`wrap` (bounded: labels past the cap fold into `(other)`). */
  labels?: Record<string, PerfLabelStat>
}

/** The slice of a node `IntervalHistogram` the sampler uses (values in nanoseconds). */
export interface LoopDelaySource {
  enable(): unknown
  disable(): unknown
  reset(): void
  readonly max: number
  percentile(p: number): number
}

export interface PerfOptions {
  /** Sampling period. Default 1000. */
  intervalMs?: number
  /** Sample ring capacity. Default 600 (10 min at 1 s). */
  sampleCapacity?: number
  /** Incident ring capacity. Default 200. */
  incidentCapacity?: number
  /** A real gap between reads above this (machine suspended) discards the sample. Default 3000. */
  maxGapMs?: number
  /** A sample whose max passes this raises a `loop-lag` incident. Default 100. */
  lagIncidentMs?: number
  /** Minimum spacing between two incidents of the same kind. Default 1000. */
  incidentMinGapMs?: number
  /** A timed section or callback longer than this raises a `slow` incident labelled with it. Default 100. */
  slowMs?: number
  /** High-resolution monotonic clock (ms) for `timed`/`wrap`; injectable for tests. Default `performance.now`. */
  hrNow?: () => number
  /** Injectable for tests. */
  now?: () => number
  source?: LoopDelaySource
}

const MAX_TRACKED_KINDS = 64
const OVERFLOW_KIND = '(other)'

export class Perf {
  readonly intervalMs: number
  private readonly cap: number
  private readonly sT: Float64Array
  private readonly sMax: Float64Array
  private readonly sP99: Float64Array
  private sCount = 0 // total ever written; slot = count % cap

  private readonly incCap: number
  private readonly incidents: (PerfIncident | undefined)[]
  private iCount = 0

  private readonly maxGapMs: number
  private readonly lagIncidentMs: number
  private readonly minGapMs: number
  private readonly now: () => number
  private readonly source: LoopDelaySource
  private readonly slowMs: number
  private readonly hrNow: () => number
  private readonly lastIncident = new Map<string, number>()
  private readonly lastSlow = new Map<string, number>() // rate limit per label, so one noisy culprit cannot hide another
  private readonly stats = new Map<string, PerfLabelStat>()
  private readonly droppedBy = new Map<string, number>()

  private timer: NodeJS.Timeout | null = null
  private lastRead = 0

  constructor(opts: PerfOptions = {}) {
    this.intervalMs = opts.intervalMs ?? 1000
    this.cap = Math.max(1, opts.sampleCapacity ?? 600)
    this.incCap = Math.max(1, opts.incidentCapacity ?? 200)
    this.maxGapMs = opts.maxGapMs ?? 3000
    this.lagIncidentMs = opts.lagIncidentMs ?? 100
    this.minGapMs = opts.incidentMinGapMs ?? 1000
    this.slowMs = opts.slowMs ?? 100
    this.hrNow = opts.hrNow ?? (() => performance.now())
    this.now = opts.now ?? Date.now
    this.source = opts.source ?? (monitorEventLoopDelay({ resolution: 10 }) as unknown as LoopDelaySource)
    this.sT = new Float64Array(this.cap)
    this.sMax = new Float64Array(this.cap)
    this.sP99 = new Float64Array(this.cap)
    this.incidents = new Array<PerfIncident | undefined>(this.incCap).fill(undefined)
  }

  get running(): boolean { return this.timer !== null }

  /** Idempotent. */
  start(): void {
    if (this.timer) return
    this.source.enable()
    this.source.reset()
    this.lastRead = this.now()
    this.timer = setInterval(() => this.sample(), this.intervalMs)
    this.timer.unref()
  }

  /** Idempotent. */
  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
    this.source.disable()
  }

  /** Read the histogram into the ring. Called by the timer; exposed so tests can drive it. No allocation unless it raises an incident. */
  sample(): void {
    const t = this.now()
    const gap = t - this.lastRead
    this.lastRead = t
    const maxMs = this.source.max / 1e6
    const p99Ms = this.source.percentile(99) / 1e6
    this.source.reset()
    if (gap > this.maxGapMs) return // the machine slept: the delay is not the loop's
    const i = this.sCount % this.cap
    this.sT[i] = t
    this.sMax[i] = maxMs
    this.sP99[i] = p99Ms
    this.sCount++
    if (maxMs > this.lagIncidentMs) this.incident('loop-lag', { maxMs: Math.round(maxMs), p99Ms: Math.round(p99Ms) })
  }

  /** Record an incident; at most one per second per kind (the rest only count in `dropped`). */
  incident(kind: string, data?: object): void {
    this.record(this.lastIncident, kind, kind, data)
  }

  private record(last: Map<string, number>, key: string, kind: string, data?: object): void {
    const t = this.now()
    let k = key
    if (!last.has(k) && last.size >= MAX_TRACKED_KINDS) k = OVERFLOW_KIND
    const prev = last.get(k)
    if (prev !== undefined && t - prev < this.minGapMs) {
      const dk = last === this.lastSlow ? kind : k
      this.droppedBy.set(dk, (this.droppedBy.get(dk) ?? 0) + 1)
      return
    }
    last.set(k, t)
    this.incidents[this.iCount % this.incCap] = data === undefined ? { t, kind } : { t, kind, data }
    this.iCount++
  }

  /** Runs `fn` and charges its synchronous time to `label`; above `slowMs` it raises `slow` ({label, ms}). A returned promise is not awaited. */
  timed<T>(label: string, fn: () => T): T {
    const t0 = this.hrNow()
    try {
      return fn()
    } finally {
      this.account(label, this.hrNow() - t0)
    }
  }

  /** Like `timed` for an async step (boot): charges the wall time until it settles, which includes waiting, so a slow one is flagged `wall: true`. */
  async timedAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const t0 = this.hrNow()
    try {
      return await fn()
    } finally {
      this.account(label, this.hrNow() - t0, true)
    }
  }

  /** `cb` timed under `label` on every call (for timer, watcher and event callbacks). */
  wrap<A extends unknown[], R>(label: string, cb: (...args: A) => R): (...args: A) => R {
    return (...args: A): R => {
      const t0 = this.hrNow()
      try {
        return cb(...args)
      } finally {
        this.account(label, this.hrNow() - t0)
      }
    }
  }

  private account(label: string, ms: number, wall = false): void {
    let key = label
    let st = this.stats.get(key)
    if (!st) {
      if (this.stats.size >= MAX_TRACKED_KINDS) { key = OVERFLOW_KIND; st = this.stats.get(key) }
      if (!st) { st = { n: 0, totalMs: 0, maxMs: 0 }; this.stats.set(key, st) }
    }
    st.n++
    st.totalMs += ms
    if (ms > st.maxMs) st.maxMs = ms
    if (ms > this.slowMs) this.record(this.lastSlow, label, 'slow', wall ? { label, ms: Math.round(ms), wall } : { label, ms: Math.round(ms) })
  }

  private labelStats(): Record<string, PerfLabelStat> {
    const out: Record<string, PerfLabelStat> = {}
    for (const [k, v] of this.stats) out[k] = { n: v.n, totalMs: Math.round(v.totalMs * 10) / 10, maxMs: Math.round(v.maxMs * 10) / 10 }
    return out
  }

  /** Samples and incidents newer than `since` (wall-clock ms), oldest first, at most one ring's worth each. */
  snapshot(since = 0): PerfSnapshot {
    const samples: PerfSample[] = []
    const n = Math.min(this.sCount, this.cap)
    for (let j = this.sCount - n; j < this.sCount; j++) {
      const i = j % this.cap
      if (this.sT[i]! > since) samples.push({ t: this.sT[i]!, maxMs: this.sMax[i]!, p99Ms: this.sP99[i]! })
    }
    const incidents: PerfIncident[] = []
    const m = Math.min(this.iCount, this.incCap)
    for (let j = this.iCount - m; j < this.iCount; j++) {
      const inc = this.incidents[j % this.incCap]!
      if (inc.t > since) incidents.push(inc)
    }
    return { now: this.now(), intervalMs: this.intervalMs, samples, incidents, dropped: Object.fromEntries(this.droppedBy), labels: this.labelStats() }
  }
}

/** The process-wide ruler: the daemon starts it at boot; any module records incidents through it. */
export const perf = new Perf()
