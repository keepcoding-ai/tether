// The renderer's side of the fault registry: window errors and unhandled rejections go to Electron main over
// `faults:record` (the preload's reportFault), which stamps version/commit/window and files them. An extension's
// failure while activating is reported with its id, so the registry attributes it (`ext:<id>`). Nothing here may
// throw: a reporter that fails is silent.
type Context = Record<string, string | number | boolean>

function details(e: unknown): { message: string; stack: string } {
  if (e instanceof Error) return { message: e.message, stack: e.stack ?? '' }
  return { message: typeof e === 'string' ? e : (() => { try { return JSON.stringify(e) ?? String(e) } catch { return String(e) } })(), stack: '' }
}

export function reportFault(f: { kind: 'uncaught' | 'rejection'; error: unknown; ext?: string; context?: Context }): void {
  try {
    const { message, stack } = details(f.error)
    window.tether.reportFault({ kind: f.kind, message, stack, ...(f.ext ? { ext: f.ext } : {}), ...(f.context ? { context: f.context } : {}) })
  } catch { /* see above */ }
}

export function installFaultReporting(): void {
  window.addEventListener('error', ev => {
    reportFault({ kind: 'uncaught', error: ev.error ?? ev.message, context: ev.filename ? { source: ev.filename.slice(-120), line: ev.lineno, column: ev.colno } : undefined })
  })
  window.addEventListener('unhandledrejection', ev => reportFault({ kind: 'rejection', error: ev.reason }))
}
