// The Faults screen's data in the renderer: the registry's rows as main last read them, shared by the screen and the top
// bar's status icon, refreshed when main reports a change on disk. Refreshes never overlap: one in flight, and one more
// queued when the registry changed meanwhile. No DOM.
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import { toDisposable } from '../../app/shared/vscode-lifecycle.ts'
import type { FaultsList } from './ipc.ts'

export interface FaultsSource {
  list(): Promise<FaultsList | { ok: false; message: string }>
}

export class FaultsStore {
  /** The last good read; undefined until the first one arrives. */
  info: FaultsList | undefined
  /** The last failed read (main could not list at all). */
  error: string | undefined
  loaded = false
  private readonly listeners = new Set<() => void>()
  private inflight: Promise<void> | undefined
  private again = false

  private readonly source: FaultsSource

  constructor(source: FaultsSource) { this.source = source }

  get rows(): FaultsList['rows'] { return this.info?.rows ?? [] }

  onDidChange(listener: () => void): IDisposable {
    this.listeners.add(listener)
    return toDisposable(() => { this.listeners.delete(listener) })
  }

  refresh(): Promise<void> {
    if (this.inflight) { this.again = true; return this.inflight }
    this.inflight = (async () => {
      try {
        do {
          this.again = false
          try {
            const r = await this.source.list()
            if (r.ok) { this.info = r; this.error = undefined } else this.error = r.message
          } catch (e) { this.error = e instanceof Error ? e.message : String(e) }
          this.loaded = true
          for (const l of [...this.listeners]) { try { l() } catch (err) { console.error('faults listener', err) } }
        } while (this.again)
      } finally { this.inflight = undefined }
    })()
    return this.inflight
  }
}
