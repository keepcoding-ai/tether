// The background processes (tether proc) as the renderer knows them: the live list (proc-list, then the `proc` and
// `proc-removed` events; asked again on every connection, so a restarted tetherd is followed), the acts as requests,
// and the read-only output (proc-attach / proc-data / proc-detach), one daemon attachment per name shared by every
// watcher. The core keeps the data; the processes extension draws it (TetherUi.procs). Requests from the app carry no
// `by`: tetherd records the author as the person in the app.
import type { Event as DaemonEvent, Reply } from '../../src/daemon/protocol.ts'
import type { ProcEvent, ProcRecipe, ProcState } from '../../src/daemon/procs.ts'
import type { RequestBody } from '../shared/api.ts'
import { toDisposable, type IDisposable } from '../shared/vscode-lifecycle.ts'

/** What changed: these names (absent: the whole list was read again); `reconnected`: a new connection to tetherd (watchers attach again). */
export interface ProcsChange {
  names?: string[]
  reconnected?: boolean
}

/** A stop, restart or forget: wait for the others' uses to end (at most 5 min), or go ahead with a reason. */
export interface ProcActOptions {
  waitMs?: number
  force?: string
  reason?: string
}

/** A watch of a process' output. `scrollback` is absent when the host holds no run of it in memory; `error` when tetherd refused. */
export interface ProcAttachment {
  scrollback?: string
  error?: string
  dispose(): void
}

type Request = (body: RequestBody) => Promise<Reply>

export class ProcsStore {
  private readonly procs = new Map<string, ProcState>()
  private readonly listeners = new Set<(e: ProcsChange) => void>()
  private readonly watchers = new Map<string, Set<(data: string) => void>>()
  /** proc-attach requests in flight per name: a detach must not overtake them. */
  private readonly pending = new Map<string, number>()
  private readonly request: Request

  constructor(request: Request) {
    this.request = request
  }

  list(): ProcState[] {
    return [...this.procs.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  get(name: string): ProcState | undefined {
    return this.procs.get(name)
  }

  /** Processes that keep running in the host (the quit dialogs say they stay). */
  liveCount(): number {
    return this.list().filter(p => p.status === 'running' || p.status === 'stopping').length
  }

  onDidChange(listener: (e: ProcsChange) => void): IDisposable {
    this.listeners.add(listener)
    return toDisposable(() => { this.listeners.delete(listener) })
  }

  /** Reads the list again (every connection to tetherd: the first one and each reconnection). */
  async refresh(reconnected: boolean): Promise<void> {
    const r = await this.request({ t: 'proc-list' })
    if (r.t !== 'ok') return
    this.procs.clear()
    for (const p of r.procs ?? []) this.procs.set(p.name, namesOnly(p))
    this.fire({ ...(reconnected ? { reconnected } : {}) })
  }

  onEvent(ev: DaemonEvent): void {
    if (ev.t === 'proc') { this.procs.set(ev.proc.name, namesOnly(ev.proc)); this.fire({ names: [ev.proc.name] }) }
    else if (ev.t === 'proc-removed') { if (this.procs.delete(ev.name)) this.fire({ names: [ev.name] }) }
    else if (ev.t === 'proc-data') for (const fn of this.watchers.get(ev.name) ?? []) fn(ev.data)
  }

  // Every act answers with tetherd's reply; a refusal is data (its message is the Portuguese text to show).
  start(name: string): Promise<Reply> { return this.request({ t: 'proc-start', name }) }
  /**
   * Registers and starts a new process with its recipe: the same `proc-start` as `tether proc start <nome> … -- <comando…>`.
   * The recipe (its env values among it) goes in this request and nowhere else; the reply comes back with names only.
   */
  async create(name: string, recipe: ProcRecipe): Promise<Reply> {
    const r = await this.request({ t: 'proc-start', name, recipe })
    return r.t === 'ok' && r.proc ? { ...r, proc: namesOnly(r.proc) } : r
  }
  stop(name: string, opts: ProcActOptions = {}): Promise<Reply> { return this.request({ t: 'proc-stop', name, ...guard(opts) }) }
  restart(name: string, opts: ProcActOptions = {}): Promise<Reply> { return this.request({ t: 'proc-restart', name, ...guard(opts) }) }
  forget(name: string, opts: ProcActOptions = {}): Promise<Reply> {
    const { reason: _reason, ...g } = guard(opts)
    return this.request({ t: 'proc-forget', name, ...g })
  }
  use(name: string, duration: string, purpose: string): Promise<Reply> { return this.request({ t: 'proc-use', name, duration, purpose }) }
  release(name: string): Promise<Reply> { return this.request({ t: 'proc-release', name }) }
  seen(name: string): Promise<Reply> { return this.request({ t: 'proc-seen', name }) }
  async info(name: string): Promise<Reply> {
    const r = await this.request({ t: 'proc-info', name })
    return r.t === 'ok' ? { ...r, ...(r.proc ? { proc: namesOnly(r.proc) } : {}), ...(r.events ? { events: r.events.map(eventNamesOnly) } : {}) } : r
  }
  ports(): Promise<Reply> { return this.request({ t: 'proc-ports' }) }

  /**
   * Watches the output of the process' current run: the scrollback now, then `onData` for what follows. Output that
   * arrives before the reply is already in the scrollback, so the listener starts with the reply. Read only.
   */
  async attach(name: string, onData: (data: string) => void): Promise<ProcAttachment> {
    this.pending.set(name, (this.pending.get(name) ?? 0) + 1)
    let r: Reply
    try {
      r = await this.request({ t: 'proc-attach', name })
    } finally {
      this.pending.set(name, (this.pending.get(name) ?? 1) - 1)
    }
    if (r.t === 'error') { this.detachIfUnwatched(name); return { error: r.message, dispose: () => {} } }
    let set = this.watchers.get(name)
    if (!set) this.watchers.set(name, set = new Set())
    const fn = (data: string): void => onData(data)
    set.add(fn)
    let disposed = false
    return {
      ...(r.scrollback !== undefined ? { scrollback: r.scrollback } : {}),
      dispose: () => {
        if (disposed) return
        disposed = true
        this.watchers.get(name)?.delete(fn)
        this.detachIfUnwatched(name)
      },
    }
  }

  private detachIfUnwatched(name: string): void {
    // Deferred: a watcher that re-attaches (a new run) disposes its old watch right after asking for the new one.
    setTimeout(() => {
      if (this.watchers.get(name)?.size || this.pending.get(name)) return
      this.watchers.delete(name)
      void this.request({ t: 'proc-detach', name })
    }, 0)
  }

  private fire(e: ProcsChange): void {
    for (const l of [...this.listeners]) {
      try { l(e) } catch (err) { console.error('procs.onDidChange', err) }
    }
  }
}

/** What stands for an env value here: the renderer never holds one (direct replies of tetherd mask by name only). */
const VALUE_HIDDEN = '•••'

function hideValues(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of Object.keys(env)) out[k] = VALUE_HIDDEN
  return out
}

/** The process with the names of its variables only (the broadcast's rule, applied to the direct replies too). */
function namesOnly(p: ProcState): ProcState {
  return p.card?.env ? { ...p, card: { ...p.card, env: hideValues(p.card.env) } } : p
}

/** A recipe-changed event of the history with the names of the variables only. */
function eventNamesOnly(e: ProcEvent): ProcEvent {
  if (!e.before?.env && !e.after?.env) return e
  const out: ProcEvent = { ...e }
  if (e.before?.env) out.before = { ...e.before, env: hideValues(e.before.env) }
  if (e.after?.env) out.after = { ...e.after, env: hideValues(e.after.env) }
  return out
}

function guard(opts: ProcActOptions): { waitMs?: number; force?: string; reason?: string } {
  return {
    ...(opts.waitMs !== undefined ? { waitMs: opts.waitMs } : {}),
    ...(opts.force !== undefined ? { force: opts.force } : {}),
    ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
  }
}
