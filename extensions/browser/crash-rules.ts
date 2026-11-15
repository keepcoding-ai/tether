// What the app decides when the browser process stops (pure; unit-tested). A tab that was on screen or loading when the process
// went down is a suspect; a tab suspect in two crashes in a row, the second within CRASH_REPEAT_MS of the first, is the likely
// cause and comes back paused (not loaded) instead of being reopened with the others.

export const CRASH_REPEAT_MS = 5 * 60_000

export interface BrowserCrash {
  at: number
  /** The tabs on screen or loading when it happened. */
  suspects: readonly string[]
}

/** The tabs that come back paused after `now`, given the crash before it. */
export function pausedAfter(previous: BrowserCrash | undefined, now: BrowserCrash): Set<string> {
  if (!previous || now.at - previous.at > CRASH_REPEAT_MS || now.at < previous.at) return new Set()
  const before = new Set(previous.suspects)
  return new Set(now.suspects.filter(t => before.has(t)))
}

/** How long a relaunched browser process gets before its line must be up. */
export const CHILD_START_MS = 20_000
/** The browser process answers a ping every HEARTBEAT_MS; HEARTBEAT_MISSES unanswered in a row and it is taken as hung (killed). */
export const HEARTBEAT_MS = 2_000
export const HEARTBEAT_MISSES = 4
