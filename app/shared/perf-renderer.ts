// Always-on renderer ruler (E4.0), pure rules (no DOM, no Electron): the window stats the renderer collects each second,
// the summary it sends the main every 5 s (only when something happened), the incident rules, the key->first-data echo
// aggregation (shell vs agent), the main<->renderer heartbeat and the bounded rings the main keeps. The DOM side lives in
// app/renderer/perf-collector.ts; the main side in app/main/perf-main.ts.

/** A frame (or task, or timer turn) longer than this is an incident. */
export const LONG_FRAME_INCIDENT_MS = 200
/** No rAF for this long, with the window visible, is an incident. */
export const RAF_STALL_INCIDENT_MS = 1000
/** A summary goes out when the window saw a rAF gap or a timer lag of at least this. */
export const NOTABLE_GAP_MS = 100
/** Summary cadence and how many the main keeps. */
export const SUMMARY_EVERY_MS = 5000
export const SUMMARY_RING_CAP = 60
export const INCIDENT_RING_CAP = 50
export const PRIORITY_RING_CAP = 60
/** A key that got no data within this never claims a later, unrelated output. */
export const ECHO_TTL_MS = 3000
/** Echo latency buckets (upper bounds, ms); the last bucket is open. */
export const ECHO_BUCKETS_MS = [8, 16, 32, 64, 128, 256] as const
/** Slots kept in the per-slot echo table. */
export const ECHO_SLOT_CAP = 64
/** Heartbeat: a ping unanswered this long is a stall. */
export const HEARTBEAT_STALL_MS = 1000

export type PaneKind = 'shell' | 'agent'

export interface TermSample {
  slotId: string
  kind: PaneKind
  /** 'webgl' | 'dom' */
  renderer: string
  /** Max bytes waiting in xterm's write buffer during the window. */
  pendingMax: number
  /** Max time since this terminal's last render (visible terminals only). */
  sinceRenderMax: number
  webglLost: boolean
}

export interface EchoStat { count: number; sumMs: number; maxMs: number; buckets: number[] }
export interface EchoSlotStat { kind: PaneKind; count: number; sumMs: number; maxMs: number }
export interface EchoSummary { byKind: Record<PaneKind, EchoStat>; bySlot: Record<string, EchoSlotStat> }

export interface RendererSummary {
  /** Wall-clock ms of the flush. */
  at: number
  windowMs: number
  visible: boolean
  longFrames: { count: number; maxMs: number }
  rafGapMaxMs: number
  timerLagMaxMs: number
  /** Key event -> next painted frame. */
  input: { count: number; maxMs: number; sumMs: number }
  terms: TermSample[]
  /** Key -> first data event at the renderer (cumulative since the renderer started). */
  echo: EchoSummary
}

export type IncidentKind = 'long-frame' | 'long-task' | 'timer-lag' | 'raf-stalled' | 'webgl-lost' | 'heartbeat-stall'
export interface RendererIncident { at: number; kind: IncidentKind; ms: number; detail?: string }

export type RendererReport = { t: 'summary'; summary: RendererSummary } | { t: 'incident'; incident: RendererIncident }

const KINDS: readonly string[] = ['long-frame', 'long-task', 'timer-lag', 'raf-stalled', 'webgl-lost', 'heartbeat-stall']
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Validates the untrusted report from the renderer (shape only; the sizes are bounded). */
export function isRendererReport(v: unknown): v is RendererReport {
  if (!v || typeof v !== 'object') return false
  const r = v as { t?: unknown; summary?: unknown; incident?: unknown }
  if (r.t === 'incident') {
    const i = r.incident as Partial<RendererIncident> | undefined
    return !!i && fin(i.at) && fin(i.ms) && typeof i.kind === 'string' && KINDS.includes(i.kind) && (i.detail === undefined || (typeof i.detail === 'string' && i.detail.length <= 200))
  }
  if (r.t === 'summary') {
    const s = r.summary as Partial<RendererSummary> | undefined
    return !!s && fin(s.at) && fin(s.windowMs) && typeof s.visible === 'boolean' && fin(s.rafGapMaxMs) && fin(s.timerLagMaxMs)
      && !!s.longFrames && fin(s.longFrames.count) && fin(s.longFrames.maxMs)
      && !!s.input && fin(s.input.count) && fin(s.input.maxMs) && fin(s.input.sumMs)
      && Array.isArray(s.terms) && s.terms.length <= 64 && !!s.echo && typeof s.echo === 'object' && !!s.echo.byKind
  }
  return false
}

/** Bounded ring: never holds more than `cap`, oldest dropped first. */
export class Ring<T> {
  private items: T[] = []
  private readonly cap: number
  constructor(cap: number) { this.cap = cap }
  push(v: T): void { this.items.push(v); if (this.items.length > this.cap) this.items.splice(0, this.items.length - this.cap) }
  toArray(): T[] { return this.items.slice() }
  get size(): number { return this.items.length }
}

/** Key -> first data aggregation, by pane kind and by slot (bounded). One instance in the renderer, one in the main. */
export class EchoTracker {
  private readonly waiting = new Map<string, { at: number; kind: PaneKind }>()
  private readonly kinds: Record<PaneKind, EchoStat> = { shell: emptyStat(), agent: emptyStat() }
  private readonly slots = new Map<string, EchoSlotStat>()
  /** Total samples ever recorded (cheap "did anything change" for the summary rule). */
  samples = 0

  /** A key went in. Only the first key of a burst waits for the echo (the following ones belong to the same echo). */
  key(slotId: string, kind: PaneKind, now: number): void {
    const w = this.waiting.get(slotId)
    if (w && now - w.at <= ECHO_TTL_MS) return
    if (!w && this.waiting.size >= ECHO_SLOT_CAP * 2) this.waiting.delete(this.waiting.keys().next().value as string)
    this.waiting.set(slotId, { at: now, kind })
  }

  /** The first data of that slot after a key: the latency, or undefined when no key was waiting. */
  data(slotId: string, now: number): number | undefined {
    const w = this.waiting.get(slotId)
    if (!w) return undefined
    this.waiting.delete(slotId)
    const ms = now - w.at
    if (ms < 0 || ms > ECHO_TTL_MS) return undefined
    const s = this.kinds[w.kind]
    s.count++; s.sumMs += ms; if (ms > s.maxMs) s.maxMs = ms
    s.buckets[bucketOf(ms)]!++
    let slot = this.slots.get(slotId)
    if (!slot) {
      if (this.slots.size >= ECHO_SLOT_CAP) this.slots.delete(this.slots.keys().next().value as string)
      slot = { kind: w.kind, count: 0, sumMs: 0, maxMs: 0 }
      this.slots.set(slotId, slot)
    }
    slot.count++; slot.sumMs += ms; if (ms > slot.maxMs) slot.maxMs = ms
    this.samples++
    return ms
  }

  summary(): EchoSummary {
    const r = (n: number): number => Math.round(n * 10) / 10
    const stat = (s: EchoStat): EchoStat => ({ count: s.count, sumMs: r(s.sumMs), maxMs: r(s.maxMs), buckets: s.buckets.slice() })
    return {
      byKind: { shell: stat(this.kinds.shell), agent: stat(this.kinds.agent) },
      bySlot: Object.fromEntries([...this.slots].map(([k, s]) => [k, { ...s, sumMs: r(s.sumMs), maxMs: r(s.maxMs) }])),
    }
  }
}

function emptyStat(): EchoStat { return { count: 0, sumMs: 0, maxMs: 0, buckets: new Array(ECHO_BUCKETS_MS.length + 1).fill(0) as number[] } }
function bucketOf(ms: number): number {
  for (let i = 0; i < ECHO_BUCKETS_MS.length; i++) if (ms < ECHO_BUCKETS_MS[i]!) return i
  return ECHO_BUCKETS_MS.length
}

/** What one flush window collects. The DOM side feeds it; `flush` closes the window. */
export class WindowStats {
  private longFrames = 0
  private longFrameMax = 0
  private rafGapMax = 0
  private timerLagMax = 0
  private inputCount = 0
  private inputMax = 0
  private inputSum = 0
  private terms = new Map<string, TermSample>()
  private startedAt: number
  private lastEchoSamples = 0
  /** Incidents decided while feeding (the caller drains and sends them at once). */
  readonly incidents: RendererIncident[] = []

  private readonly wall: () => number
  constructor(now: number, wall: () => number = Date.now) { this.startedAt = now; this.wall = wall }

  /** The gap between two consecutive painted frames (only while the window is visible). */
  frameGap(ms: number): void {
    if (ms > this.rafGapMax) this.rafGapMax = ms
    if (ms > LONG_FRAME_INCIDENT_MS) { this.longFrames++; if (ms > this.longFrameMax) this.longFrameMax = ms; this.incidents.push({ at: this.wall(), kind: 'long-frame', ms: round(ms) }) }
  }
  /** A task / animation frame the engine itself called long (PerformanceObserver). */
  longTask(ms: number, kind: 'long-task' | 'long-frame' = 'long-task'): void {
    if (ms > this.longFrameMax) this.longFrameMax = ms
    if (ms > LONG_FRAME_INCIDENT_MS) { this.longFrames++; this.incidents.push({ at: this.wall(), kind, ms: round(ms) }) }
  }
  /** A timer that fired `ms` later than asked. */
  timerLag(ms: number): void {
    if (ms > this.timerLagMax) this.timerLagMax = ms
    if (ms > LONG_FRAME_INCIDENT_MS) this.incidents.push({ at: this.wall(), kind: 'timer-lag', ms: round(ms) })
  }
  /** rAF has not run for `ms` while visible (decided by the timer; the caller reports each stall once). */
  rafStalled(ms: number): void { this.incidents.push({ at: this.wall(), kind: 'raf-stalled', ms: round(ms) }) }
  webglLost(slotId: string): void { this.incidents.push({ at: this.wall(), kind: 'webgl-lost', ms: 0, detail: slotId }) }
  /** A key event was painted `ms` after it happened. */
  keyPainted(ms: number): void { this.inputCount++; this.inputSum += ms; if (ms > this.inputMax) this.inputMax = ms }
  /** One look at a terminal: keeps the worst of the window. */
  term(t: TermSample): void {
    const cur = this.terms.get(t.slotId)
    if (!cur) { this.terms.set(t.slotId, { ...t }); return }
    cur.pendingMax = Math.max(cur.pendingMax, t.pendingMax)
    cur.sinceRenderMax = Math.max(cur.sinceRenderMax, t.sinceRenderMax)
    cur.webglLost = cur.webglLost || t.webglLost
    cur.renderer = t.renderer
    cur.kind = t.kind
  }

  /** Closes the window: the summary, or undefined when nothing worth sending happened. Resets the counters. */
  flush(now: number, visible: boolean, echo: EchoTracker): RendererSummary | undefined {
    const terms = [...this.terms.values()].filter(t => t.pendingMax > 0 || t.webglLost || t.sinceRenderMax > RAF_STALL_INCIDENT_MS)
    const echoMoved = echo.samples !== this.lastEchoSamples
    const summary: RendererSummary = {
      at: this.wall(), windowMs: round(now - this.startedAt), visible,
      longFrames: { count: this.longFrames, maxMs: round(this.longFrameMax) },
      rafGapMaxMs: round(this.rafGapMax), timerLagMaxMs: round(this.timerLagMax),
      input: { count: this.inputCount, maxMs: round(this.inputMax), sumMs: round(this.inputSum) },
      terms, echo: echo.summary(),
    }
    const notable = this.longFrames > 0 || this.rafGapMax >= NOTABLE_GAP_MS || this.timerLagMax >= NOTABLE_GAP_MS
      || this.inputCount > 0 || echoMoved || terms.length > 0
    this.longFrames = 0; this.longFrameMax = 0; this.rafGapMax = 0; this.timerLagMax = 0
    this.inputCount = 0; this.inputMax = 0; this.inputSum = 0
    this.terms = new Map(); this.startedAt = now; this.lastEchoSamples = echo.samples
    return notable ? summary : undefined
  }
}

function round(n: number): number { return Math.round(n * 10) / 10 }

/** Main -> renderer -> main round trip, measured by the main. */
export class Heartbeat {
  private seq = 0
  private readonly out = new Map<number, number>()
  count = 0; lastMs: number | null = null; maxMs = 0; sumMs = 0; missed = 0; lastAt: number | null = null
  private flagged = false

  /** Sends a ping: its seq. A ping still open from before counts as missed. */
  ping(now: number): number {
    for (const open of [...this.out.keys()]) { this.out.delete(open); this.missed++ }
    const s = ++this.seq
    this.out.set(s, now)
    this.flagged = false
    return s
  }
  pong(seq: number, now: number): number | undefined {
    const t0 = this.out.get(seq)
    if (t0 === undefined) return undefined
    this.out.delete(seq)
    const ms = Math.max(0, now - t0)
    this.count++; this.lastMs = round(ms); this.sumMs += ms; if (ms > this.maxMs) this.maxMs = round(ms); this.lastAt = Date.now()
    return ms
  }
  /** Called between pings: the age of an open ping beyond the stall limit, once per ping. */
  check(now: number): number | undefined {
    if (this.flagged) return undefined
    for (const t0 of this.out.values()) if (now - t0 > HEARTBEAT_STALL_MS) { this.flagged = true; return now - t0 }
    return undefined
  }
  view(): HeartbeatView {
    return { count: this.count, lastMs: this.lastMs, maxMs: this.maxMs, avgMs: this.count ? round(this.sumMs / this.count) : null, missed: this.missed, lastAt: this.lastAt }
  }
}
export interface HeartbeatView { count: number; lastMs: number | null; maxMs: number; avgMs: number | null; missed: number; lastAt: number | null }

export interface PrioritySample { at: number; priority: number | null; name: string }

/** Names `os.getPriority` values (Windows classes map to these numbers). */
export function priorityName(p: number | null): string {
  if (p === null) return 'unknown'
  if (p <= -20) return 'REALTIME/HIGHEST'
  if (p <= -14) return 'HIGH'
  if (p <= -7) return 'ABOVE_NORMAL'
  if (p === 0) return 'NORMAL'
  if (p <= 10) return 'BELOW_NORMAL'
  return 'IDLE'
}

/** The `renderer` field of `perf:get`. */
export interface RendererPerf {
  pid: number | null
  /** Priority at this very read. */
  priority: PrioritySample | null
  /** One per heartbeat (2 s), newest last: proves whether the renderer is demoted. */
  priorities: PrioritySample[]
  /** How many samples were not ABOVE_NORMAL, of all taken. */
  prioritySamples: number
  priorityBelowRaised: number
  heartbeat: HeartbeatView
  summaries: RendererSummary[]
  incidents: RendererIncident[]
  /** Echo seen by the renderer (key -> first data event) and by the main (input notice -> first data it forwards = host time). */
  echo: { renderer: EchoSummary | null; main: EchoSummary }
}

/** The main's bounded store behind `renderer`. */
export class RendererPerfStore {
  readonly summaries = new Ring<RendererSummary>(SUMMARY_RING_CAP)
  readonly incidents = new Ring<RendererIncident>(INCIDENT_RING_CAP)
  readonly priorities = new Ring<PrioritySample>(PRIORITY_RING_CAP)
  readonly heartbeat = new Heartbeat()
  readonly mainEcho = new EchoTracker()
  private prioritySamples = 0
  private belowRaised = 0
  private latestEcho: EchoSummary | null = null

  report(r: RendererReport): void {
    if (r.t === 'summary') { this.summaries.push(r.summary); this.latestEcho = r.summary.echo } else this.incidents.push(r.incident)
  }
  incident(i: RendererIncident): void { this.incidents.push(i) }
  samplePriority(at: number, priority: number | null): PrioritySample {
    const s = { at, priority, name: priorityName(priority) }
    this.priorities.push(s)
    this.prioritySamples++
    if (priority !== null && priority > -7) this.belowRaised++
    return s
  }
  view(pid: number | null, current: number | null, at: number): RendererPerf {
    const last = this.priorities.toArray().at(-1)
    return {
      pid, priority: current === null && !last ? null : { at, priority: current, name: priorityName(current) },
      priorities: this.priorities.toArray(), prioritySamples: this.prioritySamples, priorityBelowRaised: this.belowRaised,
      heartbeat: this.heartbeat.view(), summaries: this.summaries.toArray(), incidents: this.incidents.toArray(),
      echo: { renderer: this.latestEcho, main: this.mainEcho.summary() },
    }
  }
}
