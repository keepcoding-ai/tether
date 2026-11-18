// Key->echo probe (core, pure): a keystroke carries a list of wall-clock stamps, each hop appends one.
// Clock: `performance.timeOrigin + performance.now()` = epoch ms WITH fraction (sub-millisecond), so stamps from
// different processes on the same machine are comparable (Date.now() would be quantized to whole ms).
// The probe travels client -> tetherd (input notice) -> PTY -> tetherd (data event) -> client; hops are the
// differences between consecutive stamps.

export interface Probe {
  /** Caller's correlation number (echoed back unchanged). */
  seq: number
  /** Accumulated stamps, epoch ms with fraction, in the order the hops happened. */
  t: number[]
}

export interface Hop { name: string; ms: number }

/** More stamps than this are not a probe (bounds a hostile or buggy sender). */
export const MAX_STAMPS = 16
/** A pending probe older than this never matches an echo (a silent key must not claim later, unrelated output). */
export const PROBE_TTL_MS = 5_000
/** Total (last - first stamp) above this is a `key-echo` incident. */
export const ECHO_INCIDENT_MS = 250
/** Names of the three stamps tetherd appends, in order. */
export const DAEMON_LABELS = ['daemon-arrive', 'daemon-write', 'daemon-out'] as const

/** Wall-clock epoch ms with sub-millisecond fraction, comparable across processes on this machine. */
export function stamp(): number {
  return performance.timeOrigin + performance.now()
}

/** A new probe, first stamp = `at` (default: now). */
export function startProbe(seq: number, at: number = stamp()): Probe {
  return { seq, t: [at] }
}

/** The probe plus one more stamp (does not mutate the input). */
export function extendProbe(p: Probe, at: number = stamp()): Probe {
  return { seq: p.seq, t: [...p.t, at] }
}

/** Validates untrusted input: a probe, or undefined. Keeps only the shape; stamps must be finite numbers. */
export function parseProbe(v: unknown): Probe | undefined {
  if (!v || typeof v !== 'object') return undefined
  const { seq, t } = v as { seq?: unknown; t?: unknown }
  if (typeof seq !== 'number' || !Number.isFinite(seq)) return undefined
  if (!Array.isArray(t) || t.length > MAX_STAMPS) return undefined
  for (const x of t) if (typeof x !== 'number' || !Number.isFinite(x)) return undefined
  return { seq, t: t.slice() as number[] }
}

/**
 * Names for the stamps of a probe that `daemonStamps` of the tail were appended by tetherd (default: all three).
 * Stamps before them are the client's and stay unnamed (`t0`, `t1`...).
 */
export function labelStamps(count: number, daemonTail: readonly string[] = DAEMON_LABELS): (string | undefined)[] {
  const labels: (string | undefined)[] = new Array(count).fill(undefined)
  const start = count - daemonTail.length
  for (let i = 0; i < daemonTail.length; i++) if (start + i >= 0) labels[start + i] = daemonTail[i]
  return labels
}

/** Differences between consecutive stamps, named `from>to` (by `labels` when given, else `t<i>`). */
export function hops(p: Probe, labels: readonly (string | undefined)[] = []): Hop[] {
  const out: Hop[] = []
  for (let i = 1; i < p.t.length; i++) {
    const from = labels[i - 1] ?? `t${i - 1}`
    const to = labels[i] ?? `t${i}`
    out.push({ name: `${from}>${to}`, ms: p.t[i]! - p.t[i - 1]! })
  }
  return out
}

/** Last stamp minus first (0 with fewer than two stamps). */
export function totalMs(p: Probe): number {
  return p.t.length < 2 ? 0 : p.t[p.t.length - 1]! - p.t[0]!
}

/** Whether the probe is slow enough to be an incident (strictly above the threshold). */
export function isSlow(p: Probe, thresholdMs: number = ECHO_INCIDENT_MS): boolean {
  return totalMs(p) > thresholdMs
}
