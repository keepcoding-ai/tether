// The renderer's side of the fault registry: window errors and unhandled rejections go to Electron main over
// `faults:record` (the preload's reportFault), which stamps version/commit/window and files them. An extension's
// failure while activating is reported with its id, so the registry attributes it (`ext:<id>`). Nothing here may
// throw: a reporter that fails is silent.
type Context = Record<string, string | number | boolean>

/**
 * What a thrown value is reported as. Never its content: a rejection reason can be any object (a response, a config, a
 * credentials bag) and serializing it would copy whatever it holds into the registry. Errors and strings are the
 * message itself; anything else is described by its type, and a plain object by its key names only.
 */
export function describeReason(e: unknown): { message: string; stack: string } {
  if (e instanceof Error) return { message: e.message, stack: e.stack ?? '' }
  if (typeof e === 'string') return { message: e, stack: '' }
  if (e === null || e === undefined || typeof e === 'number' || typeof e === 'boolean') return { message: String(e), stack: '' }
  if (typeof e !== 'object') return { message: `valor não-Error (${typeof e})`, stack: '' }
  try {
    if (Array.isArray(e)) return { message: `valor não-Error (Array de ${e.length})`, stack: '' }
    const proto = Object.getPrototypeOf(e) as { constructor?: { name?: unknown } } | null
    const name = proto === null ? 'Object' : typeof proto.constructor?.name === 'string' && proto.constructor.name ? proto.constructor.name.slice(0, 60) : 'Object'
    const keys = Object.keys(e).slice(0, 20).map(k => k.slice(0, 40))
    return { message: `valor não-Error (${name}${keys.length ? `, chaves: ${keys.join(', ')}` : ''})`, stack: '' }
  } catch { return { message: 'valor não-Error (objeto ilegível)', stack: '' } }
}

export function reportFault(f: { kind: 'uncaught' | 'rejection'; error: unknown; ext?: string; context?: Context }): void {
  try {
    const { message, stack } = describeReason(f.error)
    window.tether.reportFault({ kind: f.kind, message, stack, ...(f.ext ? { ext: f.ext } : {}), ...(f.context ? { context: f.context } : {}) })
  } catch { /* see above */ }
}

export function installFaultReporting(): void {
  window.addEventListener('error', ev => {
    reportFault({ kind: 'uncaught', error: ev.error ?? ev.message, context: ev.filename ? { source: ev.filename.slice(-120), line: ev.lineno, column: ev.colno } : undefined })
  })
  window.addEventListener('unhandledrejection', ev => reportFault({ kind: 'rejection', error: ev.reason }))
}
