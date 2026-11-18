// The app's own priorities (E2.7, E4.1): when the machine is saturated by the agents, typing and scrolling must not wait for them.
// The main process, the GPU process and the main window's renderer go ABOVE_NORMAL. Chromium puts a renderer back to Normal on
// its own minutes later, so the keeper checks every PRIORITY_CHECK_MS (one getPriority syscall per pid) and sets only what
// fell, counting the falls. The renderer pid comes straight from the window, never from the metrics list (which may lack it);
// only the GPU pids come from `getAppMetrics`, refreshed every PRIORITY_REFRESH_MS. Not the embedded browser's views nor network utilities.
import { getPriority as osGetPriority } from 'node:os'
import { makePrioritySetter, PRIORITY_ABOVE_NORMAL, type SetPriority } from '../../src/procd/priority.ts'

export const PRIORITY_CHECK_MS = 250
export const PRIORITY_REFRESH_MS = 2_000

/** How many times a raised pid was found below ABOVE_NORMAL and put back (since boot). Read by `perf:get`. */
export const priorityStats = { drops: 0 }

export interface MetricLike { pid: number; type: string }

/** The pids to raise: this process, every GPU process and every renderer pid. */
export function pidsToRaise(metrics: readonly MetricLike[], selfPid: number, rendererPids: ReadonlySet<number>): number[] {
  const out = new Set<number>([selfPid, ...rendererPids])
  for (const m of metrics) if (m.type === 'GPU') out.add(m.pid)
  return [...out]
}

export interface PriorityKeeperOptions {
  enabled: boolean
  getMetrics: () => readonly MetricLike[]
  /** Pids of the renderers of the main window (not the embedded browser's views). */
  rendererPids: () => ReadonlySet<number>
  selfPid?: number
  set?: SetPriority
  /** Current priority of a pid (throws when it is gone). */
  get?: (pid: number) => number
  now?: () => number
  log?: (msg: string) => void
}

/** One pass: sets what is not ABOVE_NORMAL, counts pids that had been raised and fell. Exposed for tests. */
export function createPriorityPass(opts: PriorityKeeperOptions): () => void {
  const set = makePrioritySetter({ enabled: opts.enabled, set: opts.set, log: opts.log })
  const get = opts.get ?? osGetPriority
  const now = opts.now ?? Date.now
  const selfPid = opts.selfPid ?? process.pid
  const raised = new Set<number>()
  let gpu: MetricLike[] = []
  let metricsAt = -Infinity
  return () => {
    if (!opts.enabled) return
    const t = now()
    if (t - metricsAt >= PRIORITY_REFRESH_MS) {
      try { gpu = opts.getMetrics().filter(m => m.type === 'GPU'); metricsAt = t } catch { /* keep the last list */ }
    }
    let pids: number[]
    try { pids = pidsToRaise(gpu, selfPid, opts.rendererPids()) } catch { return }
    for (const p of pids) {
      let cur: number
      try { cur = get(p) } catch { raised.delete(p); continue }
      if (cur === PRIORITY_ABOVE_NORMAL) { raised.add(p); continue }
      if (raised.has(p)) priorityStats.drops++
      set(p, PRIORITY_ABOVE_NORMAL)
      raised.add(p)
    }
  }
}

/** Runs a pass now and every PRIORITY_CHECK_MS; returns { pass, stop }. Disabled: does nothing at all. */
export function startPriorityKeeper(opts: PriorityKeeperOptions): { pass: () => void; stop: () => void } {
  if (!opts.enabled) return { pass: () => {}, stop: () => {} }
  const pass = createPriorityPass(opts)
  pass()
  const timer = setInterval(pass, PRIORITY_CHECK_MS)
  timer.unref()
  return { pass, stop: () => clearInterval(timer) }
}
