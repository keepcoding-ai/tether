// Performance ruler, main-process side: the `perf:get` answer pairs the main process's own snapshot with the
// daemon's (one `perf` request, timed). The assembly is pure so it is testable without Electron or a daemon.
import type { IpcMain } from 'electron'
import type { Reply } from '../../src/daemon/protocol.ts'
import { perf, type PerfSnapshot } from '../../src/core/perf.ts'
import type { PerfGet, RequestBody } from '../shared/api.ts'
import { probeResult, ProbeRing, type ProbeResultNotice } from '../shared/probe-app.ts'

/** Totals of the key->echo probe (only fed when the probe is on). */
export const probeRing = new ProbeRing()

/** Records a finished probe: ring entry, and a `key-echo-app` incident in the ruler when it was slow. */
export function recordProbe(n: ProbeResultNotice): void {
  const r = probeResult(n.slotId, n.probe)
  probeRing.push(r.total, r.incident)
  if (r.incident) perf.incident('key-echo-app', { slotId: r.slotId, seq: r.seq, t: n.probe.t, labels: r.labels, hops: r.hops })
}

/** How long the daemon gets to answer before the report goes without it. */
export const PERF_DAEMON_TIMEOUT_MS = 2000

/**
 * Builds the `perf:get` answer. The daemon side is null when it is absent, too old (`bad-request`), throws or does
 * not answer within `timeoutMs`; the round trip is measured only on a good answer.
 */
export async function buildPerfGet(
  main: PerfSnapshot,
  request: (body: RequestBody) => Promise<Reply>,
  since?: number,
  timeoutMs: number = PERF_DAEMON_TIMEOUT_MS,
  now: () => number = performance.now.bind(performance),
): Promise<PerfGet> {
  const none: PerfGet = { main, daemon: null, daemonRttMs: null }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const t0 = now()
    const timeout = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), timeoutMs) })
    const reply = await Promise.race([request(since === undefined ? { t: 'perf' } : { t: 'perf', since }), timeout])
    if (!reply || reply.t !== 'ok' || !reply.perf) return none
    return { main, daemon: reply.perf, daemonRttMs: Math.max(0, now() - t0) }
  } catch {
    return none
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Starts the main process's ruler and answers `perf:get`; `request` is the main's daemon client. */
export function registerPerf(ipc: IpcMain, request: (body: RequestBody) => Promise<Reply>, probe = false): void {
  perf.start()
  ipc.handle('perf:get', async (_e, since?: unknown): Promise<PerfGet> => {
    const got = await buildPerfGet(perf.snapshot(typeof since === 'number' && Number.isFinite(since) ? since : undefined), request, typeof since === 'number' ? since : undefined)
    return probe ? { ...got, probe: probeRing.summary() } : got
  })
}

/** Stops the main process's ruler (app quit). */
export function stopPerf(): void { perf.stop() }
