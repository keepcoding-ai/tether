// The app's own priorities (E2.7): when the machine is saturated by the agents, typing and scrolling must not wait for them.
// The main process, the GPU process and the main window's renderer go ABOVE_NORMAL, at boot and again every few seconds
// (renderers and the GPU process come and go with reloads and crashes, and Chromium puts a renderer back to Normal on its own
// when the window changes visibility or focus, so the pass reapplies to every pid each time and the caller also runs it on those events). Not the embedded browser's views nor network utilities.
import { makePrioritySetter, PRIORITY_ABOVE_NORMAL, type SetPriority } from '../../src/procd/priority.ts'

export const PRIORITY_REFRESH_MS = 2_000

export interface MetricLike { pid: number; type: string }

/** The pids to raise: this process, every GPU process and the renderers whose pid is in `rendererPids`. */
export function pidsToRaise(metrics: readonly MetricLike[], selfPid: number, rendererPids: ReadonlySet<number>): number[] {
  const out = new Set<number>([selfPid])
  for (const m of metrics) {
    if (m.type === 'GPU' || (m.type === 'Tab' && rendererPids.has(m.pid))) out.add(m.pid)
  }
  return [...out]
}

export interface PriorityKeeperOptions {
  enabled: boolean
  getMetrics: () => readonly MetricLike[]
  /** Pids of the renderers of the main window (not the embedded browser's views). */
  rendererPids: () => ReadonlySet<number>
  selfPid?: number
  set?: SetPriority
  log?: (msg: string) => void
}

/** One pass: raises what is not yet raised. Exposed for tests; `startPriorityKeeper` runs it on a timer. */
export function createPriorityPass(opts: PriorityKeeperOptions): () => void {
  const set = makePrioritySetter({ enabled: opts.enabled, set: opts.set, log: opts.log })
  const selfPid = opts.selfPid ?? process.pid
  return () => {
    if (!opts.enabled) return
    let pids: number[]
    try { pids = pidsToRaise(opts.getMetrics(), selfPid, opts.rendererPids()) } catch { return }
    for (const p of pids) set(p, PRIORITY_ABOVE_NORMAL)
  }
}

/** Runs a pass now and every PRIORITY_REFRESH_MS; returns { pass, stop }. Disabled: does nothing at all. */
export function startPriorityKeeper(opts: PriorityKeeperOptions): { pass: () => void; stop: () => void } {
  if (!opts.enabled) return { pass: () => {}, stop: () => {} }
  const pass = createPriorityPass(opts)
  pass()
  const timer = setInterval(pass, PRIORITY_REFRESH_MS)
  timer.unref()
  return { pass, stop: () => clearInterval(timer) }
}
