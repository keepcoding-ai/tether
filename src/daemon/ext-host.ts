// tetherd's extension host (F9 slice 0c): activates extensions/index.daemon.ts before the daemon loads its slots, so
// the agents an extension registers are known when slot metas are read. Each extension gets a TetherDaemon whose
// registrations land in its own DisposableStore (the lifecycle the renderer and main hosts use, ported from VS Code).
// tetherd runs .ts with Node directly, so the static index is just imported. Order follows `requires`; a failing or
// unsatisfiable extension is logged and skipped, never taking tetherd down.
import { DisposableStore, toDisposable, type IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import { extensions as daemonExtensions } from '../../extensions/index.daemon.ts'
import type { DaemonCheck, SlotEventKind, TetherDaemon, TraceSource } from './ext-api.ts'
import type { ExtensionEntry } from '../../extensions/types.ts'
import { agentRegistry, type AgentRegistry } from '../agents/registry.ts'
import type { LaunchPlan } from '../agents/types.ts'
import type { SlotMeta } from '../core/event.ts'
import { perf } from '../core/perf.ts'
import { defaultProfileFor, type Profile } from '../core/profile.ts'
import { treeValueAt } from '../../app/shared/settings-file.ts'
import type { SlotState } from './protocol.ts'
import { BRAND } from '../../app/shared/brand.ts'
import type { Executor } from '../exec/executor.ts'
import { createExecutorIo, fsIo } from './ext-io.ts'
import { DoorHost } from './door/host.ts'

type Middleware = (plan: LaunchPlan, slot: SlotMeta, state?: SlotState) => LaunchPlan | Promise<LaunchPlan>
/** A middleware with the extension that registered it (for the ceiling's log). */
interface LaunchStep { id: string; mw: Middleware }

/** How long one extension's launch middleware may take before the launch goes on without it. */
export const PLAN_MIDDLEWARE_TIMEOUT_MS = 10_000
const TIMED_OUT: unique symbol = Symbol('timed-out')
/** What the extensions see when the host was given no snapshots (a bare unit test): nothing. */
const NO_PROFILES = { profiles: (): Profile[] => [] }
const NO_SETTINGS = { get: (): Record<string, unknown> => ({}) }
type SlotListener = (ev: { kind: SlotEventKind; slot: SlotState }) => void

export interface DaemonHostOptions {
  home: string
  log: (msg: string) => void
  /** Defaults to the process-wide registry. */
  agents?: AgentRegistry
  /** Defaults to extensions/index.daemon.ts. */
  extensions?: readonly ExtensionEntry<TetherDaemon>[]
  /** Extension ids the person turned off. */
  disabled?: readonly string[]
  /** tetherd's snapshots (memory, reloaded by the executor), shared with the daemon. Default: read from disk when asked (the CLI and Electron main). */
  profileStore?: { profiles(): Profile[] }
  settings?: { get(): Record<string, unknown> }
  /** tetherd's executor: `api.io` runs on it. Default: node's async file API (the CLI and Electron main, which never run the io-using code in earnest). */
  executor?: Executor
  /** Ceiling per launch middleware (ms). Default PLAN_MIDDLEWARE_TIMEOUT_MS. */
  planTimeoutMs?: number
  /** The agent door the extensions get (tetherd shares its own with the daemon). Default: an inert one (satellites, bare tests). */
  door?: DoorHost
}

export class DaemonExtensionHost implements IDisposable {
  private readonly store = new DisposableStore()
  private readonly middlewares: LaunchStep[] = []
  private readonly slotListeners = new Set<SlotListener>()
  private readonly startListeners = new Set<() => void>()
  private started = false
  readonly checks: Array<() => Promise<DaemonCheck>> = []
  readonly traceSources: TraceSource[] = []
  readonly activated: string[] = []
  readonly failed: { id: string; error: string }[] = []
  private readonly opts: DaemonHostOptions
  /** The agent door behind each extension's door services; inert unless tetherd's daemon attached its port. */
  readonly door: DoorHost

  constructor(opts: DaemonHostOptions) {
    this.opts = opts
    this.door = opts.door ?? new DoorHost({ log: opts.log })
  }

  activate(): void {
    // tetherd's own host fills the process registry: the lazy loader of the other processes (src/agents/load.ts) stays off.
    if (!this.opts.extensions && !this.opts.agents) agentRegistry.markLoaded()
    const list = this.opts.extensions ?? daemonExtensions
    const disabled = new Set(this.opts.disabled ?? [])
    const byId = new Map(list.map((e) => [e.manifest.id, e]))
    const state = new Map<string, 'visiting' | 'ok' | 'failed'>()
    const fail = (id: string, error: string): false => {
      state.set(id, 'failed')
      this.failed.push({ id, error })
      this.opts.log(`extension ${id}: ${error}`)
      return false
    }
    const visit = (e: ExtensionEntry<TetherDaemon>): boolean => {
      const id = e.manifest.id
      const s = state.get(id)
      if (s === 'ok') return true
      if (s === 'failed') return false
      if (s === 'visiting') return fail(id, 'dependência circular')
      if (disabled.has(id)) { state.set(id, 'failed'); return false }
      state.set(id, 'visiting')
      for (const req of e.manifest.requires ?? []) {
        const dep = byId.get(req)
        if (!dep || !visit(dep)) return fail(id, `requer ${req}, que não está ativa`)
      }
      const own = new DisposableStore()
      try {
        for (const d of e.activate(this.apiFor(id, own)) ?? []) own.add(d)
        if (e.deactivate) { const deactivate = e.deactivate; own.add(toDisposable(() => deactivate())) }
      } catch (err) {
        own.dispose()
        return fail(id, `falhou ao ativar: ${(err as Error).message}`)
      }
      this.store.add(own)
      state.set(id, 'ok')
      this.activated.push(id)
      return true
    }
    for (const e of list) visit(e)
  }

  /**
   * The launch middlewares, applied in order, each awaited before the next (DaemonOptions.transformPlan). One that throws,
   * rejects or outlasts the ceiling is logged and skipped: the next one gets the plan it was given. A late answer is dropped.
   */
  readonly transformPlan = async (plan: LaunchPlan, meta: SlotMeta, state?: SlotState): Promise<LaunchPlan> => {
    let out = plan
    const ceiling = this.opts.planTimeoutMs ?? PLAN_MIDDLEWARE_TIMEOUT_MS
    for (const { id, mw } of [...this.middlewares]) {
      try {
        const r = mw(out, meta, state)
        if (!(r instanceof Promise)) { out = r; continue }
        let timer: NodeJS.Timeout | undefined
        const late = new Promise<typeof TIMED_OUT>((resolve) => { timer = setTimeout(resolve, ceiling, TIMED_OUT); timer.unref() })
        r.catch(() => { /* reported below when it loses no race; a rejection after the ceiling is moot */ })
        const next = await Promise.race([r, late]).finally(() => clearTimeout(timer))
        if (next === TIMED_OUT) this.opts.log(`launch middleware of ${id} took over ${ceiling} ms for slot ${meta.slotId}: skipped`)
        else out = next
      } catch (e) {
        this.opts.log(`launch middleware of ${id} failed for slot ${meta.slotId}: ${(e as Error).message}`)
      }
    }
    return out
  }

  /** tetherd owns its pipe and pid file (src/daemon/main.ts): the extensions' `onStarted` listeners run, once. Never called by the satellites. */
  readonly emitStarted = (): void => {
    if (this.started) return
    this.started = true
    for (const l of [...this.startListeners]) {
      try { l() } catch (e) { this.opts.log(`onStarted listener failed: ${(e as Error).message}`) }
    }
  }

  /** Slot lifecycle fan-out (DaemonOptions.onSlot). */
  readonly emitSlot = (kind: SlotEventKind, slot: SlotState): void => {
    for (const l of [...this.slotListeners]) {
      try { l({ kind, slot }) } catch (e) { this.opts.log(`onSlot listener failed: ${(e as Error).message}`) }
    }
  }

  dispose(): void {
    this.store.dispose()
  }

  private get profileStore(): { profiles(): Profile[] } { return this.opts.profileStore ?? NO_PROFILES }
  private get userSettings(): { get(): Record<string, unknown> } { return this.opts.settings ?? NO_SETTINGS }

  private apiFor(id: string, own: DisposableStore): TetherDaemon {
    const { home, log } = this.opts
    const io = this.opts.executor ? createExecutorIo(this.opts.executor) : fsIo
    const agents = this.opts.agents ?? agentRegistry
    const removing = <T>(list: T[], item: T): IDisposable => toDisposable(() => {
      const i = list.indexOf(item)
      if (i >= 0) list.splice(i, 1)
    })
    return {
      ...this.door.apiFor(id, own),
      id,
      brand: BRAND,
      home,
      agents: { register: (agent) => own.add(agents.register(agent)), get: (name) => agents.get(name) },
      onStarted: (l) => {
        if (this.started) { l(); return toDisposable(() => {}) }
        this.startListeners.add(l)
        return own.add(toDisposable(() => { this.startListeners.delete(l) }))
      },
      // perf.wrap times the synchronous part, the one that holds the loop; a promise's wait is the ceiling's business.
      launch: { use: (mw) => { const step: LaunchStep = { id, mw: perf.wrap(`ext:${id}:plan`, mw) }; this.middlewares.push(step); return own.add(removing(this.middlewares, step)) } },
      doctor: { register: (check) => { this.checks.push(check); return own.add(removing(this.checks, check)) } },
      traces: { register: (source) => { this.traceSources.push(source); return own.add(removing(this.traceSources, source)) } },
      settings: { get: <T>(key: string): T | undefined => treeValueAt(this.userSettings.get(), key) as T | undefined },
      profiles: {
        get: (pid) => this.profileStore.profiles().find((p) => p.id === pid),
        defaultFor: (agent) => defaultProfileFor(this.profileStore.profiles(), agent),
      },
      io,
      log: (msg) => log(`[${id}] ${msg}`),
      onSlot: (l) => {
        const timed: SlotListener = perf.wrap(`ext:${id}:slot`, l)
        this.slotListeners.add(timed)
        return own.add(toDisposable(() => { this.slotListeners.delete(timed) }))
      },
    }
  }
}
