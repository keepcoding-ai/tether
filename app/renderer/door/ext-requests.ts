// Extension requests and events (N1, renderer half): `ui.daemon.request(name, args)` sends `ext-request` with the extension's
// own id (the core sets `ext`, never the extension), and `ui.daemon.onEvent(name, listener)` hears the daemon's `ext-event` of
// that extension and name. The listeners live here, not on a connection: a reconnection changes nothing for them. Pure (no DOM).
import type { IDisposable } from '../../shared/vscode-lifecycle.ts'
import { toDisposable } from '../../shared/vscode-lifecycle.ts'
import type { DaemonAsk } from './objects.ts'

/** The daemon's `ext-event` body (without the `t`). */
export interface ExtEventBody { ext: string; name: string; payload?: unknown }

/** A request the daemon refused: `code` is the pipe's error code (`unknown-request`, `bad-request`, or the handler's own). */
export class ExtRequestError extends Error {
  readonly code: string
  constructor(code: string, message: string) { super(message); this.code = code; this.name = 'ExtRequestError' }
}

/** One extension's way to its daemon half (the `daemon` block of the TetherUi). */
export interface ExtDaemon {
  /** Asks the handler the extension's daemon half registered under `name`; resolves with its result (undefined when none). */
  request<T = unknown>(name: string, args?: unknown): Promise<T>
  /** Hears every `events.emit(name, payload)` of the extension's daemon half, across reconnections. */
  onEvent<T = unknown>(name: string, listener: (payload: T) => void): IDisposable
}

export class ExtRequests {
  /** ext → name → listeners. Grows with what the extensions listen to, not with events. */
  private readonly listeners = new Map<string, Map<string, Set<(payload: unknown) => void>>>()
  private readonly ask: DaemonAsk

  constructor(ask: DaemonAsk) { this.ask = ask }

  apiFor(ext: string): ExtDaemon {
    return {
      request: async <T>(name: string, args?: unknown): Promise<T> => {
        const reply = await this.ask({ t: 'ext-request', ext, name, ...(args === undefined ? {} : { args }) })
        if (reply.t === 'error') throw new ExtRequestError(reply.code, reply.message)
        return (reply as { result?: unknown }).result as T
      },
      onEvent: <T>(name: string, listener: (payload: T) => void): IDisposable => {
        let byName = this.listeners.get(ext)
        if (!byName) { byName = new Map(); this.listeners.set(ext, byName) }
        let set = byName.get(name)
        if (!set) { set = new Set(); byName.set(name, set) }
        const fn = listener as (payload: unknown) => void
        set.add(fn)
        return toDisposable(() => {
          const now = this.listeners.get(ext)?.get(name)
          if (!now) return
          now.delete(fn)
          if (now.size === 0) this.listeners.get(ext)!.delete(name)
          if (this.listeners.get(ext)!.size === 0) this.listeners.delete(ext)
        })
      },
    }
  }

  /** The daemon's `ext-event`. One listener that throws does not stop the others. */
  apply(e: ExtEventBody): void {
    const set = this.listeners.get(e.ext)?.get(e.name)
    if (!set) return
    for (const fn of [...set]) {
      try { fn(e.payload) } catch (err) { console.error(`ext-event ${e.ext}/${e.name}:`, err) }
    }
  }
}
