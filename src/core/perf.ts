// Performance ruler (core, pure): an event-loop delay sampler plus a bounded incident ring.
// One sampler timer (unref'd) reads the loop-delay histogram once a second into a fixed ring of
// numbers (pre-allocated, never grows); incidents are rate-limited per kind. Pull only: `snapshot()`.
import { monitorEventLoopDelay } from 'node:perf_hooks'

export interface PerfSample { t: number; maxMs: number; p99Ms: number }
export interface PerfIncident { t: number; kind: string; data?: object }
export interface PerfSnapshot {
  /** Wall-clock ms of the snapshot. */
  now: number
  intervalMs: number
  samples: PerfSample[]
  incidents: PerfIncident[]
  /** Incidents dropped by the per-kind rate limit since start, by kind. */
  dropped: Record<string, number>
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
  private readonly lastIncident = new Map<string, number>()
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
    const t = this.now()
    let k = kind
    if (!this.lastIncident.has(k) && this.lastIncident.size >= MAX_TRACKED_KINDS) k = OVERFLOW_KIND
    const last = this.lastIncident.get(k)
    if (last !== undefined && t - last < this.minGapMs) {
      this.droppedBy.set(k, (this.droppedBy.get(k) ?? 0) + 1)
      return
    }
    this.lastIncident.set(k, t)
    this.incidents[this.iCount % this.incCap] = data === undefined ? { t, kind } : { t, kind, data }
    this.iCount++
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
    return { now: this.now(), intervalMs: this.intervalMs, samples, incidents, dropped: Object.fromEntries(this.droppedBy) }
  }
}

/** The process-wide ruler: the daemon starts it at boot; any module records incidents through it. */
export const perf = new Perf()
