// The policy behind tetherd's `uncaughtException` / `unhandledRejection` handlers (pure; main.ts wires it to
// the process): log with the stack, keep serving while the state is consistent (server still listening, not
// closing, errors rare), otherwise say why and exit so the next client starts a fresh daemon.

/** Uncaught errors tolerated inside UNCAUGHT_WINDOW_MS while the server keeps listening; beyond that the daemon
 *  exits (a storm of errors means the state is no longer trustworthy). */
export const UNCAUGHT_LIMIT = 5
export const UNCAUGHT_WINDOW_MS = 60_000

export interface Guard {
  /** Called on every uncaught exception; returns true when the daemon must exit. */
  uncaught(e: unknown): boolean
  unhandled(reason: unknown): void
}

/** `record` (optional) also files the error in the fault registry; the log line stays either way. */
export function createGuard(opts: { log: (msg: string) => void; healthy: () => boolean; now?: () => number; record?: (kind: 'uncaught' | 'rejection', e: unknown) => void }): Guard {
  const now = opts.now ?? Date.now
  const recent: number[] = []
  const describe = (e: unknown): string => (e instanceof Error ? e.stack ?? e.message : String(e))
  return {
    uncaught(e) {
      opts.log(`uncaught exception: ${describe(e)}`)
      try { opts.record?.('uncaught', e) } catch { /* the registry never takes the daemon down */ }
      const t = now()
      recent.push(t)
      while (recent.length && recent[0]! < t - UNCAUGHT_WINDOW_MS) recent.shift()
      if (!opts.healthy()) {
        opts.log('fatal: server no longer listening after the error; exiting so the next client starts a new tetherd')
        return true
      }
      if (recent.length > UNCAUGHT_LIMIT) {
        opts.log(`fatal: ${recent.length} uncaught exceptions in ${UNCAUGHT_WINDOW_MS / 1000} s; exiting so the next client starts a new tetherd`)
        return true
      }
      opts.log(`continuing: server still listening (${recent.length}/${UNCAUGHT_LIMIT} recent errors)`)
      return false
    },
    unhandled(reason) {
      opts.log(`unhandled rejection: ${describe(reason)}`)
      try { opts.record?.('rejection', reason) } catch { /* see uncaught */ }
    },
  }
}
