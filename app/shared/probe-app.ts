// Key->echo probe, app side (pure, no Electron): names the stamps of a full app round trip, decides incidents and
// keeps a bounded ring of totals. Off by default; enabled with TETHER_PROBE=1 in the app's environment.
import { hops, totalMs, type Hop, type Probe } from '../../src/core/perf-probe.ts'

/** Stamp names in the order the hops happen: renderer -> main -> tetherd (3 stamps) -> main -> renderer. */
export const APP_LABELS = ['renderer-send', 'main-in', 'daemon-arrive', 'daemon-write', 'daemon-out', 'main-out', 'renderer-recv'] as const
/** Total (ms) above which a key->echo round trip is a `key-echo-app` incident. */
export const APP_ECHO_INCIDENT_MS = 50
/** How many recent totals the ring keeps. */
export const PROBE_RING_CAP = 200

/** Whether the environment asks for the probe (only the exact value `1`). */
export function probeEnabled(env: Record<string, string | undefined>): boolean { return env.TETHER_PROBE === '1' }

/** What the renderer sends the main when a probe comes back (a notice-shaped message on `tether:notice`). */
export interface ProbeResultNotice { t: 'probe-result'; slotId: string; probe: Probe }

/** Names for `count` stamps: the full set when complete, else the leading names (a partial probe is still readable). */
export function appLabels(count: number): (string | undefined)[] {
  return Array.from({ length: count }, (_, i) => APP_LABELS[i])
}

export interface ProbeResult { slotId: string; seq: number; total: number; labels: string[]; hops: Hop[]; incident: boolean
  /** The program's time: tetherd's daemon-write to daemon-out stamps (write to the PTY, first byte back). Undefined when the probe did not cross tetherd. */
  agentMs: number | undefined }

/** Totals, labels and the incident decision for a finished probe (strictly above the threshold is an incident). */
export function probeResult(slotId: string, probe: Probe, thresholdMs: number = APP_ECHO_INCIDENT_MS): ProbeResult {
  const labels = appLabels(probe.t.length)
  const total = totalMs(probe)
  return {
    slotId, seq: probe.seq, total,
    labels: labels.map((l, i) => l ?? `t${i}`),
    hops: hops(probe, labels),
    incident: total > thresholdMs,
    agentMs: probe.t.length >= 5 ? Math.max(0, probe.t[4]! - probe.t[3]!) : undefined,
  }
}

/** Validates the untrusted `probe-result` notice from the renderer. */
export function isProbeResultNotice(v: unknown): v is ProbeResultNotice {
  if (!v || typeof v !== 'object') return false
  const n = v as { t?: unknown; slotId?: unknown; probe?: unknown }
  if (n.t !== 'probe-result' || typeof n.slotId !== 'string') return false
  const p = n.probe as { seq?: unknown; t?: unknown } | undefined
  return !!p && typeof p.seq === 'number' && Array.isArray(p.t) && p.t.length <= 16 && p.t.every(x => typeof x === 'number' && Number.isFinite(x))
}

export interface ProbeSummary { count: number; slow: number; last: number[] }

/** Fixed-size ring of the latest totals; never grows past `cap`. */
export class ProbeRing {
  private readonly buf: number[] = []
  private head = 0
  private count = 0
  private slow = 0
  private readonly cap: number
  constructor(cap: number = PROBE_RING_CAP) { this.cap = cap }

  push(total: number, incident = false): void {
    if (this.buf.length < this.cap) this.buf.push(total)
    else { this.buf[this.head] = total; this.head = (this.head + 1) % this.cap }
    this.count++
    if (incident) this.slow++
  }

  /** Counters since start and the kept totals, oldest first. */
  summary(): ProbeSummary {
    const last = this.buf.length < this.cap ? this.buf.slice() : [...this.buf.slice(this.head), ...this.buf.slice(0, this.head)]
    return { count: this.count, slow: this.slow, last }
  }
}
