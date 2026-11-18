// Performance ruler, main-process side: the `perf:get` answer pairs the main process's own snapshot with the
// daemon's (one `perf` request, timed). The assembly is pure so it is testable without Electron or a daemon.
import { getPriority } from 'node:os'
import type { IpcMain, WebContents } from 'electron'
import type { Reply } from '../../src/daemon/protocol.ts'
import { perf, type PerfSnapshot } from '../../src/core/perf.ts'
import type { PerfGet, RequestBody } from '../shared/api.ts'
import { isRendererReport, RendererPerfStore, type PaneKind, type RendererPerf } from '../shared/perf-renderer.ts'
import { priorityStats } from './priority.ts'
import { probeResult, ProbeRing, type ProbeResultNotice } from '../shared/probe-app.ts'

/** Totals of the key->echo probe (only fed when the probe is on). */
export const probeRing = new ProbeRing()

/** The renderer's ruler as the main sees it (E4.0): the renderer's reports, the heartbeat, the priority samples, the main-side echo. */
export const rendererPerf = new RendererPerfStore()

/**
 * Main-side echo (always on, one Map lookup per key / data event): the time from an input notice entering the main to the
 * first data of that slot leaving it. For a hosted pane (tether-ptyd) the main talks to the host directly, so this is
 * "write to the PTY -> first byte back" plus two local pipe hops: the TIME OF THE PROGRAM (shell or agent), which the
 * renderer's own key -> data time contains. Terminal/window share = renderer echo - main echo.
 */
export function perfEchoKey(slotId: string, kind: PaneKind): void { rendererPerf.mainEcho.key(slotId, kind, performance.now()) }
export function perfEchoData(slotId: string): void { rendererPerf.mainEcho.data(slotId, performance.now()) }

export const HEARTBEAT_TICK_MS = 500
export const HEARTBEAT_EVERY_TICKS = 4

/** Records a finished probe: ring entry, and a `key-echo-app` incident in the ruler when it was slow. */
export function recordProbe(n: ProbeResultNotice): void {
  const r = probeResult(n.slotId, n.probe)
  probeRing.push(r.total, r.incident)
  if (r.incident) perf.incident('key-echo-app', { slotId: r.slotId, seq: r.seq, t: n.probe.t, labels: r.labels, hops: r.hops })
}

let beat: ReturnType<typeof setInterval> | undefined

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
export function registerPerf(ipc: IpcMain, request: (body: RequestBody) => Promise<Reply>, probe = false, window?: () => WebContents | undefined): void {
  perf.start()
  ipc.on('perf:renderer', (_e, r: unknown) => { if (isRendererReport(r)) rendererPerf.report(r) })
  ipc.on('perf:pong', (_e, seq: unknown) => { if (typeof seq === 'number') rendererPerf.heartbeat.pong(seq, performance.now()) })
  const pidOf = (): number | null => { const wc = window?.(); const pid = wc && !wc.isDestroyed() ? wc.getOSProcessId() : 0; return pid > 0 ? pid : null }
  const priorityOf = (pid: number | null): number | null => { if (pid === null) return null; try { return getPriority(pid) } catch { return null } }
  let tick = 0
  beat = setInterval(() => {
    const now = performance.now()
    const stalled = rendererPerf.heartbeat.check(now)
    if (stalled !== undefined) rendererPerf.incident({ at: Date.now(), kind: 'heartbeat-stall', ms: Math.round(stalled) })
    if (++tick % HEARTBEAT_EVERY_TICKS !== 0) return
    const wc = window?.()
    if (!wc || wc.isDestroyed()) return
    rendererPerf.samplePriority(Date.now(), priorityOf(pidOf()))
    try { wc.send('perf:ping', rendererPerf.heartbeat.ping(now)) } catch { /* window going away */ }
  }, HEARTBEAT_TICK_MS)
  beat.unref()
  ipc.handle('perf:get', async (_e, since?: unknown): Promise<PerfGet> => {
    const got = await buildPerfGet(perf.snapshot(typeof since === 'number' && Number.isFinite(since) ? since : undefined), request, typeof since === 'number' ? since : undefined)
    const pid = pidOf()
    const withRenderer: PerfGet = { ...got, renderer: { ...rendererPerf.view(pid, priorityOf(pid), Date.now()), priorityDrops: priorityStats.drops } satisfies RendererPerf }
    return probe ? { ...withRenderer, probe: probeRing.summary() } : withRenderer
  })
}

/** Stops the main process's ruler (app quit). */
export function stopPerf(): void { perf.stop(); if (beat) clearInterval(beat) }
