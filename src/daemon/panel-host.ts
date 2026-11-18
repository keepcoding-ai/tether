// tetherd's remote terminal panes (E1.5): the PTYs live in tether-ptyd; this module is the client side. One connection
// to the host (opened on demand, launched when asked, reopened after a drop) and one `PtyHandle` per pane that talks
// through it. A handle receives the pane's output by `attach` and recovers a `lag` by re-attaching from its last offset,
// so nothing is lost and nothing arrives twice. Killing stays here: the host only releases the console.
import type { HostClient, LaunchHostOptions } from '../procd/client.ts'
import { HostClient as Client } from '../procd/client.ts'
import type { HostRun, ProcPlan } from '../procd/protocol.ts'
import { PTYD_TARGET } from '../ptyd/paths.ts'
import { killTree, type PtyExit, type PtyHandle } from './pty.ts'

/** How the connection to the host is made; replaceable in tests. */
export interface PanelConnector {
  /** Connects when a host already answers; undefined otherwise. Never launches. */
  tryOpen(): Promise<HostClient | undefined>
  /** Connects, launching the host first when nothing answers. Rejects when it never does. */
  ensure(): Promise<HostClient>
}

export interface PanelHostOptions {
  /** The real connection (tether-ptyd on `launch.pipe`); ignored when `connector` is given. */
  launch?: LaunchHostOptions
  connector?: PanelConnector
  log?: (msg: string) => void
  /** How long `ensure` waits for a launched host (default 20 s). */
  ensureTimeoutMs?: number
}

/** What a pane's owner hears. Same shape as spawnPty's options, plus `onReset`. */
export interface PanelCallbacks {
  /** Output of the pane, in order, each piece exactly once. The first call after `spawn` carries what the host already read. */
  onData(data: string): void
  /** The process ended. `-1` when the connection to the host dropped (the host's processes die with it) or the exit was never reported. */
  onExit(exit: PtyExit): void
  /**
   * The ring no longer covers what this owner already has (a lag that outran it, or another run): `scrollback` is the
   * whole ring. The owner clears its own scrollback and restarts from it. Without this callback the ring goes to
   * `onData` instead (the owner may then see some text twice).
   */
  onReset?(scrollback: string): void
}

export interface PanelSpawnOptions extends PanelCallbacks {
  cols: number
  rows: number
}

/** What `adopt` found: a live run, its ring at attach time and the identity of the run. */
export interface AdoptedPanel {
  handle: PtyHandle
  /** The host's ring right now; the owner starts its own scrollback from it. `onData` continues after it. */
  scrollback: string
  /** Output offset of the end of `scrollback`. */
  off: number
  epoch: string
  spawnedAt: string
  startedAt: string
}

const RESIZE_MIN = 1

/** One pane's subscription on the shared connection. */
class Sub {
  readonly exited: Promise<PtyExit>
  exit: PtyExit | undefined
  /** Offset after the last output delivered to the owner. */
  lastOff = 0
  epoch = ''
  /** An attach is in flight (adopt or re-attach): data events of this name are superseded by its reply, an `exit` waits for it. */
  resyncing = false
  pendingExit: PtyExit | undefined
  private resolveExit!: (e: PtyExit) => void

  readonly name: string
  readonly run: number
  readonly pid: number
  readonly cb: PanelCallbacks

  constructor(name: string, run: number, pid: number, cb: PanelCallbacks) {
    this.name = name
    this.run = run
    this.pid = pid
    this.cb = cb
    this.exited = new Promise((r) => { this.resolveExit = r })
  }

  /** Ends the pane once. */
  finish(exit: PtyExit): boolean {
    if (this.exit) return false
    this.exit = exit
    try { this.cb.onExit(exit) } finally { this.resolveExit(exit) }
    return true
  }
}

export class PanelHost {
  private readonly connector: PanelConnector
  private readonly log: (msg: string) => void
  private conn: HostClient | undefined
  private connecting: Promise<HostClient | undefined> | undefined
  private closedByOwner = false
  private readonly subs = new Map<string, Sub>()
  private readonly runs = new Map<string, number>()

  constructor(opts: PanelHostOptions) {
    this.log = opts.log ?? (() => {})
    if (opts.connector) this.connector = opts.connector
    else if (opts.launch) {
      const launch = opts.launch
      this.connector = {
        tryOpen: () => Client.tryOpen(launch.pipe),
        ensure: () => Client.ensure(launch, opts.ensureTimeoutMs ?? 20_000, PTYD_TARGET),
      }
    } else throw new Error('PanelHost precisa de `launch` ou `connector`')
  }

  /** Whether a connection to the host is up right now. */
  get connected(): boolean {
    return !!this.conn && !this.conn.isClosed
  }

  /** The runs still alive in the host; undefined when no host answers (nothing is launched for this). */
  async list(): Promise<HostRun[] | undefined> {
    const conn = await this.connection(false)
    if (!conn) return undefined
    const r = await conn.request({ t: 'list' })
    return (r.runs ?? []).filter((x) => !x.exit)
  }

  /** Starts a pane in the host (launching it when needed) and returns its remote handle. */
  async spawn(name: string, plan: ProcPlan, opts: PanelSpawnOptions): Promise<PtyHandle> {
    const conn = await this.connection(true)
    if (!conn) throw new Error('o anfitrião de terminais não respondeu')
    const run = (this.runs.get(name) ?? 0) + 1
    this.runs.set(name, run)
    const reply = await conn.request({ t: 'spawn', name, run, plan, cols: opts.cols, rows: opts.rows, home: '' })
    const sub = this.register(new Sub(name, run, reply.pid ?? -1, opts))
    try {
      const a = await conn.request({ t: 'attach', name })
      sub.epoch = a.epoch ?? ''
      sub.lastOff = a.off ?? 0
      if (a.scrollback && !sub.exit) opts.onData(a.scrollback)
    } catch (e) {
      // Attached to nothing: end the pane rather than leave a process nobody hears.
      this.drop(sub)
      void killTree(sub.pid)
      throw e
    }
    return this.handle(sub)
  }

  /** A pane already alive in the host (after tetherd restarted). undefined when it is not there or has ended. */
  async adopt(name: string, opts: PanelCallbacks): Promise<AdoptedPanel | undefined> {
    const conn = await this.connection(false)
    if (!conn) return undefined
    const live = (await conn.request({ t: 'list' })).runs?.find((r) => r.name === name && !r.exit)
    if (!live) return undefined
    this.runs.set(name, Math.max(this.runs.get(name) ?? 0, live.run))
    const old = this.subs.get(name)
    if (old) this.drop(old)
    const sub = this.register(new Sub(name, live.run, live.pid, opts))
    // The connection may already be attached to this name (a re-adopt, or another owner of the same host): data events
    // that overtake the reply carry bytes the reply's ring already holds, so they are superseded by it, as in a resync.
    sub.resyncing = true
    let a
    try {
      a = await conn.request({ t: 'attach', name })
    } catch {
      this.drop(sub)
      return undefined // ended between list and attach
    }
    sub.epoch = a.epoch ?? live.spawnedAt
    sub.lastOff = a.off ?? 0
    sub.resyncing = false
    if (sub.pendingExit) { const e = sub.pendingExit; sub.pendingExit = undefined; this.end(sub, e) }
    return { handle: this.handle(sub), scrollback: a.scrollback ?? '', off: sub.lastOff, epoch: sub.epoch, spawnedAt: live.spawnedAt, startedAt: live.startedAt }
  }

  /**
   * Leaves the host alone: closes the connection WITHOUT touching the panes (they keep running there) and without
   * calling `onExit` on the handles. Use on tetherd shutdown.
   */
  close(): void {
    this.closedByOwner = true
    this.subs.clear()
    const c = this.conn
    this.conn = undefined
    c?.close()
  }

  // ---- connection ----------------------------------------------------------------------------

  private async connection(launch: boolean): Promise<HostClient | undefined> {
    if (this.closedByOwner) return undefined
    if (this.conn && !this.conn.isClosed) return this.conn
    this.connecting ??= this.open(false)
    let c = await this.connecting
    if (!c && launch) {
      this.connecting = this.open(true)
      c = await this.connecting
    }
    this.connecting = undefined
    return c
  }

  private async open(launch: boolean): Promise<HostClient | undefined> {
    const c = launch ? await this.connector.ensure() : await this.connector.tryOpen()
    if (!c) return undefined
    if (this.conn && !this.conn.isClosed) { c.close(); return this.conn }
    this.conn = c
    c.on('data', (name, data, off) => this.onData(name, data, off))
    c.on('lag', (name) => void this.resync(c, name))
    c.on('exit', (name, run, exit) => this.onExit(name, run, exit.code))
    c.on('close', () => this.onClose(c))
    return c
  }

  private onClose(c: HostClient): void {
    if (this.conn === c) this.conn = undefined
    if (this.closedByOwner) return
    this.log('conexão com o anfitrião de terminais caiu')
    for (const sub of [...this.subs.values()]) { this.drop(sub); sub.finish({ exitCode: -1 }) }
  }

  // ---- events --------------------------------------------------------------------------------

  private register(sub: Sub): Sub {
    this.subs.set(sub.name, sub)
    return sub
  }

  private drop(sub: Sub): void {
    if (this.subs.get(sub.name) === sub) this.subs.delete(sub.name)
  }

  private onData(name: string, data: string, off: number | undefined): void {
    const sub = this.subs.get(name)
    if (!sub || sub.exit || sub.resyncing) return
    if (off === undefined) { sub.cb.onData(data); return }
    // `off` is the offset after this chunk: skip what was already delivered, trim an overlap.
    if (off <= sub.lastOff) return
    const prev = sub.lastOff
    const from = off - data.length
    sub.lastOff = off
    sub.cb.onData(from < prev ? data.slice(prev - from) : data)
  }

  private onExit(name: string, run: number, code: number): void {
    const sub = this.subs.get(name)
    if (!sub || sub.run !== run) return
    if (sub.resyncing) { sub.pendingExit = { exitCode: code }; return } // the output the lag cost comes first
    this.end(sub, { exitCode: code })
  }

  private end(sub: Sub, exit: PtyExit): void {
    this.drop(sub)
    if (sub.finish(exit)) this.conn?.request({ t: 'forget', name: sub.name }).catch(() => {}) // free the ring in the host
  }

  /** Lag: ask for what is missing after the last offset; the whole ring (a reset) when that is no longer there. */
  private async resync(conn: HostClient, name: string): Promise<void> {
    const sub = this.subs.get(name)
    if (!sub || sub.exit || sub.resyncing) return
    sub.resyncing = true
    try {
      const from = sub.lastOff
      const a = await conn.request({ t: 'attach', name, from, epoch: sub.epoch })
      if (this.subs.get(name) !== sub || sub.exit) return
      const text = a.scrollback ?? ''
      const off = a.off ?? from
      // Only the missing part has exactly off - from characters; anything else is the whole ring.
      const reset = a.epoch !== sub.epoch || text.length !== off - from
      sub.epoch = a.epoch ?? sub.epoch
      sub.lastOff = off
      if (reset && sub.cb.onReset) sub.cb.onReset(text)
      else if (text) sub.cb.onData(text)
    } catch {
      return // the connection closed: onClose ends the pane
    } finally {
      sub.resyncing = false
    }
    if (sub.pendingExit) { const e = sub.pendingExit; sub.pendingExit = undefined; this.end(sub, e) }
  }

  // ---- the handle ----------------------------------------------------------------------------

  private handle(sub: Sub): PtyHandle {
    const conn = (): HostClient | undefined => (this.conn && !this.conn.isClosed ? this.conn : undefined)
    const release = (): void => {
      if (sub.exit) return
      conn()?.request({ t: 'release', name: sub.name }).catch(() => {})
    }
    return {
      pid: sub.pid,
      exited: sub.exited,
      get exit() { return sub.exit },
      write(data) { if (!sub.exit) conn()?.write(sub.name, data) },
      resize(cols, rows) {
        if (sub.exit || cols < RESIZE_MIN || rows < RESIZE_MIN) return
        conn()?.request({ t: 'resize', name: sub.name, cols, rows }).catch(() => {})
      },
      release,
      /** The socket buffer of the host client is not exposed, and the host caps the pty input itself (it drops above its ceiling): always 0. */
      pendingInput() { return 0 },
      kill: async (timeoutMs = 10_000) => {
        if (!sub.exit) await killTree(sub.pid)
        release()
        let timer: NodeJS.Timeout | undefined
        await Promise.race([sub.exited, new Promise<void>((r) => { timer = setTimeout(r, timeoutMs) })])
        clearTimeout(timer)
        if (!sub.exit) this.end(sub, { exitCode: -1 })
      },
    }
  }
}
