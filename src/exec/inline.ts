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
        void loadTable(this.tableUrl).then((table) => {
          const t0 = performance.now()
          let reply: ExecReply
          try {
            const fn = (table as unknown as Record<string, ((...a: unknown[]) => unknown) | undefined>)[req.op]
            if (!fn) throw new Error(`unknown operation: ${req.op}`)
            reply = { id: req.id, ok: true, value: fn(...req.args), ms: 0 }
          } catch (e) {
            reply = { id: req.id, ok: false, error: serializeError(e), ms: 0 }
          }
          reply.ms = Math.round((performance.now() - t0) * 10) / 10
          resolve(reply)
        })
      })
    })
  }

  async close(): Promise<void> {}
}
