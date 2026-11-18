// Test-only event-loop blocker behind the `debug-block` request (gated by TETHER_TEST_BLOCK=1).
export const DEBUG_BLOCK_MAX_MS = 30_000

/** Spins the thread for `ms` milliseconds. `now` is injectable for tests. */
export function busyWait(ms: number, now: () => number = Date.now): void {
  const end = now() + ms
  while (now() < end) { /* busy */ }
}
