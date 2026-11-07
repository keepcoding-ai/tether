// tetherd's extension host (F9 slice 0c): activates extensions/index.daemon.ts before the daemon loads its slots, so
// the agents an extension registers are known when slot metas are read. Each extension gets a TetherDaemon whose
// registrations land in its own DisposableStore (the lifecycle the renderer and main hosts use, ported from VS Code).
// tetherd runs .ts with Node directly, so the static index is just imported. Order follows `requires`; a failing or
// unsatisfiable extension is logged and skipped, never taking tetherd down.
import { DisposableStore, toDisposable, type IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import { extensions as daemonExtensions } from '../../extensions/index.daemon.ts'
import type { DaemonCheck, SlotEventKind, TetherDaemon } from './ext-api.ts'
import type { ExtensionEntry } from '../../extensions/types.ts'
import { agentRegistry, type AgentRegistry } from '../agents/registry.ts'
import type { LaunchPlan } from '../agents/types.ts'
import type { SlotMeta } from '../core/event.ts'
import { readUserSettings } from '../core/user-settings.ts'
import type { SlotState } from './protocol.ts'
import { BRAND } from '../../app/shared/brand.ts'

type Middleware = (plan: LaunchPlan, slot: SlotMeta) => LaunchPlan
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
}

export class DaemonExtensionHost implements IDisposable {
  private readonly store = new DisposableStore()
  private readonly middlewares: Middleware[] = []
  private readonly slotListeners = new Set<SlotListener>()
  private readonly startListeners = new Set<() => void>()
  private started = false
  readonly checks: Array<() => Promise<DaemonCheck>> = []
  readonly activated: string[] = []
  readonly failed: { id: string; error: string }[] = []
  private readonly opts: DaemonHostOptions

  constructor(opts: DaemonHostOptions) {
    this.opts = opts
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

  /** The launch middlewares, applied in order (DaemonOptions.transformPlan). */
  readonly transformPlan = (plan: LaunchPlan, meta: SlotMeta): LaunchPlan => {
    let out = plan
    for (const mw of this.middlewares) {
      try { out = mw(out, meta) } catch (e) { this.opts.log(`launch middleware failed for slot ${meta.slotId}: ${(e as Error).message}`) }
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

  private apiFor(id: string, own: DisposableStore): TetherDaemon {
    const { home, log } = this.opts
    const agents = this.opts.agents ?? agentRegistry
    const removing = <T>(list: T[], item: T): IDisposable => toDisposable(() => {
      const i = list.indexOf(item)
      if (i >= 0) list.splice(i, 1)
    })
    return {
      id,
      brand: BRAND,
      home,
      agents: { register: (agent) => own.add(agents.register(agent)), get: (name) => agents.get(name) },
      onStarted: (l) => {
        if (this.started) { l(); return toDisposable(() => {}) }
        this.startListeners.add(l)
        return own.add(toDisposable(() => { this.startListeners.delete(l) }))
      },
      launch: { use: (mw) => { this.middlewares.push(mw); return own.add(removing(this.middlewares, mw)) } },
      doctor: { register: (check) => { this.checks.push(check); return own.add(removing(this.checks, check)) } },
      settings: { get: <T>(key: string): T | undefined => readSetting<T>(home, key) },
      log: (msg) => log(`[${id}] ${msg}`),
      onSlot: (l) => {
        this.slotListeners.add(l)
        return own.add(toDisposable(() => { this.slotListeners.delete(l) }))
      },
    }
  }
}

function readSetting<T>(home: string, key: string): T | undefined {
  return readUserSettings(home)[key] as T | undefined
}
