// Electron main's side of the fault registry (src/core/faults.ts): the process handlers (uncaughtException,
// unhandledRejection), Electron's `child-process-gone` / `render-process-gone`, the `faults:record` channel the
// renderer reports through, the worker error reporter, and the test-only injected throws (TETHER_TEST_THROW).
// Capture is always on. Installing an `uncaughtException` listener removes Electron's default native box, so the
// handler records first and then shows `dialog.showErrorBox` itself (at most once a minute, never in hidden E2E mode
// where a native box would block the process): the app has no in-app dialog for main-process crashes yet.
import { app, dialog, ipcMain } from 'electron'
import type { WebContents } from 'electron'
import { faultsDir, reconcileState, record, type FaultInput, type FaultProc } from '../../src/core/faults.ts'

const BOX_EVERY_MS = 60_000
const MAX_MESSAGE = 2_000
const MAX_STACK = 20_000

/** Records from this process (version/commit come from the bundle's defines or package.json next to the dist). Never throws. */
export function recordFault(input: FaultInput): void {
  record(input, { fromDir: __dirname })
}

const describe = (e: unknown): { message: string; stack: string } =>
  e instanceof Error ? { message: e.message, stack: e.stack ?? '' } : { message: String(e), stack: '' }

export function installMainFaults(opts: { log: (line: string) => void; hidden: boolean }): void {
  let lastBox = 0
  process.on('uncaughtException', (e, origin) => {
    const { message, stack } = describe(e)
    recordFault({ proc: 'main', kind: origin === 'unhandledRejection' ? 'rejection' : 'uncaught', message, stack, context: { origin } })
    opts.log(`uncaught exception: ${stack || message}`)
    if (opts.hidden || Date.now() - lastBox < BOX_EVERY_MS) return
    lastBox = Date.now()
    try { dialog.showErrorBox('tether: erro inesperado', `${message}\n\nO erro foi registrado em Falhas.`) } catch { /* before ready: the record is enough */ }
  })
  process.on('unhandledRejection', reason => {
    const { message, stack } = describe(reason)
    recordFault({ proc: 'main', kind: 'rejection', message, stack })
    opts.log(`unhandled rejection: ${stack || message}`)
  })
  app.on('child-process-gone', (_e, d) => {
    recordFault({ proc: 'main', kind: 'gone', message: `child-process-gone: ${d.type} ${d.reason}`, context: { type: d.type, reason: d.reason, exitCode: d.exitCode, serviceName: d.serviceName, name: d.name } })
  })
  app.on('web-contents-created', (_e, wc) => watchRenderer(wc))
  // Lines the launcher wrote while the app could not load (it cannot update the state itself).
  reconcileState(faultsDir())
}

/** `render-process-gone` of any web contents (the main window, the standalone dialog, a webview). */
function watchRenderer(wc: WebContents): void {
  wc.on('render-process-gone', (_e, d) => {
    recordFault({ proc: 'renderer', kind: 'gone', message: `render-process-gone: ${d.reason}`, context: { reason: d.reason, exitCode: d.exitCode, windowId: wc.id } })
  })
}

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i
const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')

/** `faults:record`: what the renderer reports (window.onerror / unhandledrejection). The payload is validated: it comes from a page. */
export function registerFaultsIpc(): void {
  ipcMain.on('faults:record', (e, p: unknown) => {
    if (!p || typeof p !== 'object') return
    const r = p as Record<string, unknown>
    const ext = typeof r.ext === 'string' && ID_RE.test(r.ext) ? r.ext : undefined
    const context: Record<string, unknown> = { windowId: e.sender.id }
    if (r.context && typeof r.context === 'object') {
      for (const [k, v] of Object.entries(r.context as Record<string, unknown>).slice(0, 10)) {
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') context[k] = typeof v === 'string' ? v.slice(0, 200) : v
      }
    }
    const proc: FaultProc = ext ? `ext:${ext}` : 'renderer'
    recordFault({ proc, kind: r.kind === 'rejection' ? 'rejection' : 'uncaught', message: text(r.message, MAX_MESSAGE), stack: text(r.stack, MAX_STACK), context })
  })
}


/** E2E only (TETHER_TEST_THROW, a comma list of main|main-rejection|renderer|renderer-rejection): the throws go through the real handlers. */
export function injectTestThrow(wc?: WebContents): void {
  for (const mode of (process.env.TETHER_TEST_THROW ?? '').split(',').map(s => s.trim()).filter(Boolean)) injectOne(mode, wc)
}

function injectOne(mode: string, wc?: WebContents): void {
  if (mode === 'main') setTimeout(() => { throw new Error('tether test throw (main)') }, 300)
  else if (mode === 'main-rejection') setTimeout(() => { void Promise.reject(new Error('tether test rejection (main)')) }, 300)
  else if (wc && mode === 'renderer') void wc.executeJavaScript("setTimeout(() => { throw new Error('tether test throw (renderer)') }, 0)")
  else if (wc && mode === 'renderer-rejection') void wc.executeJavaScript("setTimeout(() => { Promise.reject(new Error('tether test rejection (renderer)')) }, 0)")
}
