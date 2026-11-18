// Process priorities: what the person types into comes before what the agents run. Interactive processes (the app's main,
// GPU and window renderer, tether-ptyd) go ABOVE_NORMAL; what the hosts launch goes BELOW_NORMAL, and on Windows the
// children of a BELOW_NORMAL process inherit that class, so the npm / grep / builds an agent starts stay below too.
// One switch turns it all off: settings.json `performance.priorities: false` (the app) or TETHER_PRIORITIES=0 (ptyd, procd).
import { constants, setPriority as osSetPriority } from 'node:os'

export const PRIORITY_ABOVE_NORMAL = constants.priority.PRIORITY_ABOVE_NORMAL
export const PRIORITY_BELOW_NORMAL = constants.priority.PRIORITY_BELOW_NORMAL

export type SetPriority = (pid: number, priority: number) => void

/** True unless TETHER_PRIORITIES is `0`/`false`/`off`. */
export function prioritiesEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = env.TETHER_PRIORITIES?.trim().toLowerCase()
  return !(v === '0' || v === 'false' || v === 'off')
}

/**
 * A setter that never throws: the first failure is reported once through `log`, later ones are ignored.
 * `enabled: false` gives a no-op.
 */
export function makePrioritySetter(opts: { enabled?: boolean; set?: SetPriority; log?: (msg: string) => void } = {}): SetPriority {
  if (opts.enabled === false) return () => {}
  const set = opts.set ?? osSetPriority
  let reported = false
  return (pid, priority) => {
    try {
      set(pid, priority)
    } catch (e) {
      if (reported) return
      reported = true
      opts.log?.(`priority: setPriority(${pid}, ${priority}) failed (further failures are not reported): ${(e as Error).message}`)
    }
  }
}
