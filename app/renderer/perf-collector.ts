// Always-on renderer ruler (E4.0): cheap, no CDP. One rAF loop (frame gaps, key -> painted frame), one 100 ms timer
// (timer lag, rAF stall), a long-task / long-animation-frame observer, a once-a-second look at the visible terminals
// (xterm write backlog, time since last render, lost WebGL) and the key -> first data echo per pane kind. Every 5 s the
// summary goes to the main, only when something happened; incidents go at once. The rules are in app/shared/perf-renderer.ts.
import type { Terminal } from '@xterm/xterm'
import { EchoTracker, RAF_STALL_INCIDENT_MS, SUMMARY_EVERY_MS, WindowStats, type PaneKind, type RendererReport } from '../shared/perf-renderer.ts'

/** What the collector needs of a terminal pane (TerminalPanel satisfies it). */
export interface PanelLike { readonly term: Terminal; readonly renderer: string }

export interface CollectorDeps {
  panels: () => Iterable<[string, PanelLike]>
  kindOf: (slotId: string) => PaneKind
  send: (report: RendererReport) => void
}

/** Bytes waiting in xterm's write buffer (internals: guarded, 0 when the shape is not there). */
export function termBacklog(term: Terminal): number {
  try {
    const wb = (term as unknown as { _core?: { _writeBuffer?: { _pendingData?: number } } })._core?._writeBuffer
    const n = wb?._pendingData
    return typeof n === 'number' && n > 0 ? n : 0
  } catch { return 0 }
}

const TIMER_MS = 100
const LOOK_MS = 1000

let active: { key(slotId: string): void; data(slotId: string): void } | undefined

/** A key went to a pane's terminal (called from the pane's onData). No-op until the collector is installed. */
export function perfKey(slotId: string): void { active?.key(slotId) }
/** A data event arrived for a pane (called from the daemon event handler). */
export function perfData(slotId: string): void { active?.data(slotId) }

/** Installs the collector; returns a stop function. Safe to call once per page. */
export function installPerfCollector(deps: CollectorDeps): () => void {
  const echo = new EchoTracker()
  const stats = new WindowStats(performance.now())
  const renders = new WeakMap<Terminal, number>()
  const wasWebgl = new Map<string, boolean>()
  let lastRaf = performance.now()
  let rafStalledFlagged = false
  let lastTimer = performance.now()
  const pendingKeys: number[] = []
  let stopped = false
  const visible = (): boolean => document.visibilityState === 'visible'

  const emit = (): void => {
    for (const incident of stats.incidents.splice(0)) deps.send({ t: 'incident', incident })
  }

  const channel = new MessageChannel()
  const settled: number[][] = []
  channel.port1.onmessage = () => {
    const keys = settled.shift()
    if (!keys) return
    const now = performance.now()
    for (const t of keys) stats.keyPainted(now - t)
  }

  const raf = (): void => {
    if (stopped) return
    const now = performance.now()
    if (visible()) stats.frameGap(now - lastRaf)
    lastRaf = now
    rafStalledFlagged = false
    if (pendingKeys.length) { settled.push(pendingKeys.splice(0)); channel.port2.postMessage(0) } // after this frame is handed to paint
    emit()
    requestAnimationFrame(raf)
  }
  requestAnimationFrame(raf)

  const onKey = (ev: KeyboardEvent): void => { if (pendingKeys.length < 32) pendingKeys.push(ev.timeStamp || performance.now()) }
  document.addEventListener('keydown', onKey, { capture: true, passive: true })

  const timer = setInterval(() => {
    const now = performance.now()
    stats.timerLag(Math.max(0, now - lastTimer - TIMER_MS))
    lastTimer = now
    if (visible() && !rafStalledFlagged && now - lastRaf > RAF_STALL_INCIDENT_MS) { rafStalledFlagged = true; stats.rafStalled(now - lastRaf) }
    emit()
  }, TIMER_MS)

  let observer: PerformanceObserver | undefined
  try {
    const types = PerformanceObserver.supportedEntryTypes ?? []
    const type = types.includes('long-animation-frame') ? 'long-animation-frame' : types.includes('longtask') ? 'longtask' : undefined
    if (type) {
      observer = new PerformanceObserver(list => { for (const e of list.getEntries()) stats.longTask(e.duration, type === 'longtask' ? 'long-task' : 'long-frame'); emit() })
      observer.observe({ type, buffered: false })
    }
  } catch { /* no observer: the timer and rAF still see it */ }

  const look = (): void => {
    const now = performance.now()
    const seen = new Set<string>()
    for (const [slotId, p] of deps.panels()) {
      const term = p.term
      seen.add(slotId)
      try {
        if (!renders.has(term)) { renders.set(term, now); term.onRender(() => renders.set(term, performance.now())) }
        const web = p.renderer === 'webgl'
        const lost = wasWebgl.get(slotId) === true && !web
        wasWebgl.set(slotId, web)
        if (lost) stats.webglLost(slotId)
        if (!term.element?.offsetParent) continue // not visible: nothing is owed
        stats.term({ slotId, kind: deps.kindOf(slotId), renderer: p.renderer, pendingMax: termBacklog(term), sinceRenderMax: Math.round(now - (renders.get(term) ?? now)), webglLost: lost })
      } catch { /* a terminal being disposed */ }
    }
    for (const id of wasWebgl.keys()) if (!seen.has(id)) wasWebgl.delete(id)
    emit()
  }
  const lookTimer = setInterval(look, LOOK_MS)
  const flushTimer = setInterval(() => {
    const s = stats.flush(performance.now(), visible(), echo)
    if (s) deps.send({ t: 'summary', summary: s })
  }, SUMMARY_EVERY_MS)

  active = {
    key: slotId => echo.key(slotId, deps.kindOf(slotId), performance.now()),
    data: slotId => { echo.data(slotId, performance.now()) },
  }
  return () => {
    stopped = true
    active = undefined
    clearInterval(timer); clearInterval(lookTimer); clearInterval(flushTimer)
    document.removeEventListener('keydown', onKey, { capture: true })
    observer?.disconnect()
    channel.port1.close()
  }
}
