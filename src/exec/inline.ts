// Inline backend: the same table, run in the caller's loop through setImmediate. It is the fallback
// (TETHER_EXECUTOR=inline) and the default of the unit tests; it keeps the loop-blocking behaviour the workers remove.
// The table is loaded lazily and through a computed specifier on purpose: the coordinator's static import graph must
// never reach ops-*.ts (the sync ratchet guards it). A bundler must therefore ship src/exec/table.ts as its own entry.
import { serializeError, type ExecReply, type ExecRequest } from './protocol.ts'
import type { OpTable } from './table.ts'

let loaded: Promise<OpTable> | undefined

function loadTable(url?: string): Promise<OpTable> {
  loaded ??= import(url ?? new URL('./table.ts', import.meta.url).href).then((m) => m.table as OpTable)
  return loaded
}

/** The closed table, loaded on demand (also used at boot to keep a synchronous writer for the fatal-exit path). */
export function loadOpTable(tableUrl?: string): Promise<OpTable> { return loadTable(tableUrl) }

export class InlineTransport {
  private readonly tableUrl: string | undefined
  constructor(opts: { tableUrl?: string } = {}) { this.tableUrl = opts.tableUrl }

  call(_lane: string, req: ExecRequest): Promise<ExecReply> {
    return new Promise((resolve) => {
      setImmediate(() => {
        let tableP: Promise<OpTable>
        try { tableP = loadTable(this.tableUrl) } catch (e) { tableP = Promise.reject(e) }
        // A table that cannot load answers every call with the error: a silent never-settling promise hangs the caller forever.
        tableP.catch((e: unknown) => { loaded = undefined; resolve({ id: req.id, ok: false, error: serializeError(e), ms: 0 }) })
        void tableP.then((table) => {
          const t0 = performance.now()
          const done = (reply: ExecReply): void => {
            reply.ms = Math.round((performance.now() - t0) * 10) / 10
            resolve(reply)
          }
          try {
            const fn = (table as unknown as Record<string, ((...a: unknown[]) => unknown) | undefined>)[req.op]
            if (!fn) throw new Error(`unknown operation: ${req.op}`)
            const value = fn(...req.args)
            if (value instanceof Promise) {
              value.then((v) => done({ id: req.id, ok: true, value: v, ms: 0 }), (e) => done({ id: req.id, ok: false, error: serializeError(e), ms: 0 }))
            } else done({ id: req.id, ok: true, value, ms: 0 })
          } catch (e) {
            done({ id: req.id, ok: false, error: serializeError(e), ms: 0 })
          }
        })
      })
    })
  }

  async close(): Promise<void> {}
}
