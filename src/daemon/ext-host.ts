// tetherd's extension host (F9 slice 0c): activates extensions/index.daemon.ts before the daemon loads its slots, so
// the agents an extension registers are known when slot metas are read. Each extension gets a TetherDaemon whose
// registrations land in its own DisposableStore (the lifecycle the renderer and main hosts use, ported from VS Code).
// tetherd runs .ts with Node directly, so the static index is just imported. Order follows `requires`; a failing or
// unsatisfiable extension is logged and skipped, never taking tetherd down.
//
// Features (extensions/types.ts FeatureContribution): the active extensions' `contributes.features` are known here. At
// every launch of an AI agent the host resolves which are on for the slot (its profile's Profile.features > settings.json
// `agents.features.<id>` > the extension's default), runs the middlewares with that set, composes the enabled features'
// content into <home>/share/<signature>/ (src/daemon/share.ts) and hands that folder to the agent's contribution
// (AgentContribution.share). A feature's content is the folder its daemon entry provides at run time
// (TetherDaemon.features.provide), else its static `share` folder inside extensions/<id>/; a feature with neither is
// skipped. The composed folders of a previous run are removed when tetherd starts (cleanStaleShares, before any launch).
import { DisposableStore, toDisposable, type IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import { extensions as daemonExtensions } from '../../extensions/index.daemon.ts'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { DaemonCheck, LaunchContext, LaunchMiddleware, SlotEventKind, TetherDaemon } from './ext-api.ts'
import type { ExtensionEntry } from '../../extensions/types.ts'
import { declaredFeatures, enabledFeatures, type FeatureDecl } from '../core/features.ts'
import { cleanShares, composeShare, type FeatureSource } from './share.ts'
import { applyMigrations } from '../../app/shared/ext-migrations.ts'
import { agentRegistry, type AgentRegistry } from '../agents/registry.ts'
import type { LaunchPlan } from '../agents/types.ts'
import type { SlotMeta } from '../core/event.ts'
import { readUserSettings } from '../core/user-settings.ts'
import type { SlotState } from './protocol.ts'
import { BRAND } from '../../app/shared/brand.ts'

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
  /** Where extensions/<id>/ folders are (a feature's static `share` is resolved there). Defaults to the repo's extensions/. */
  extensionsDir?: string
}

/** What the server knows of a launch besides the plan and the meta (DaemonOptions.transformPlan). */
export interface LaunchInfo {
  /** The slot's profile's explicit feature switches (Profile.features), when it has a profile that says any. */
  profileFeatures?: Readonly<Record<string, boolean>>
}

/** extensions/ next to src/: read on use (Electron main bundles this module as CommonJS, where import.meta.dirname is undefined). */
function defaultExtensionsDir(): string {
  return resolve(import.meta.dirname ?? '.', '..', '..', 'extensions')
}

export class DaemonExtensionHost implements IDisposable {
  private readonly store = new DisposableStore()
  private readonly middlewares: LaunchMiddleware[] = []
  /** The active extensions' features, in activation order. */
  readonly features: FeatureDecl[] = []
  private readonly providers = new Map<string, () => string | undefined>()
  private readonly warned = new Set<string>()
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
    // Declared before activation, so an entry's `features.provide` finds its own feature; dropped again if it fails.
    const declared = declaredFeatures(list.filter(e => !disabled.has(e.manifest.id)).map(e => e.manifest))
    for (const p of declared.problems) this.opts.log(p)
    this.features.push(...declared.features)
    for (const e of list) visit(e)
    const active = new Set(this.activated)
    this.features.splice(0, this.features.length, ...this.features.filter(f => active.has(f.ext)))
  }

  /** The features enabled for a launch of `meta` (none for a shell). */
  enabledFor(meta: Pick<SlotMeta, 'agent'>, info: LaunchInfo = {}): string[] {
    if (meta.agent === 'shell' || this.features.length === 0) return []
    // The manifests' migrations applied in memory: a switch still under its old key (main moves it at the app's next
    // start) already counts for a tetherd started by the CLI.
    const manifests = (this.opts.extensions ?? daemonExtensions).map(e => e.manifest)
    return enabledFeatures(this.features, applyMigrations(readUserSettings(this.opts.home), manifests).file, info.profileFeatures)
  }

  /** The folder a feature's content is in now, or undefined (logged once until it comes back). */
  private sourceOf(f: FeatureDecl): string | undefined {
    const provided = this.providers.get(f.id)
    let dir: string | undefined
    try { dir = provided ? provided() : f.share ? resolve(this.opts.extensionsDir ?? defaultExtensionsDir(), f.ext, f.share) : undefined } catch (e) {
      this.opts.log(`feature ${f.id}: a pasta não pôde ser resolvida (${(e as Error).message})`)
    }
    if (dir && existsSync(dir)) { this.warned.delete(f.id); return dir }
    if (!this.warned.has(f.id)) { this.warned.add(f.id); this.opts.log(`feature ${f.id}: sem conteúdo agora${dir ? ` (${dir} ausente)` : ''}; agentes lançados sem ela`) }
    return undefined
  }

  /** The middlewares, applied in order, then the composed share folder handed to the agent (DaemonOptions.transformPlan). */
  readonly transformPlan = (plan: LaunchPlan, meta: SlotMeta, info: LaunchInfo = {}): LaunchPlan => {
    const enabled = new Set(this.enabledFor(meta, info))
    // What this launch really gets: the enabled features that have content now, for an agent that takes them.
    const agent = enabled.size ? (this.opts.agents ?? agentRegistry).get(meta.agent) : undefined
    const sources: FeatureSource[] = []
    if (agent?.share) {
      for (const f of this.features) {
        if (!enabled.has(f.id)) continue
        const dir = this.sourceOf(f)
        if (dir) sources.push({ id: f.id, dir })
      }
    }
    const ctx: LaunchContext = { features: new Set(sources.map(s => s.id)) }
    let out = plan
    for (const mw of this.middlewares) {
      try { out = mw(out, meta, ctx) } catch (e) { this.opts.log(`launch middleware failed for slot ${meta.slotId}: ${(e as Error).message}`) }
    }
    if (!agent?.share || sources.length === 0) { out.features = []; return out }
    try {
      const composed = composeShare(this.opts.home, sources)
      for (const p of composed.problems) this.opts.log(`slot ${meta.slotId}: ${p}`)
      const injected = agent.share.inject(out, composed.dir)
      injected.features = sources.map(s => s.id)
      return injected
    } catch (e) {
      this.opts.log(`slot ${meta.slotId}: pasta das features (${sources.map(s => s.id).join('+')}) não montada: ${(e as Error).message}; lançado sem elas`)
      out.features = []
      return out
    }
  }

  /** tetherd's start, before any slot launches: the composed folders of the previous run go (they are rebuilt on use). */
  cleanStaleShares(): void {
    try {
      const removed = cleanShares(this.opts.home)
      if (removed.length) this.opts.log(`share: ${removed.length} pasta(s) de features da execução anterior removida(s) (${removed.join(', ')})`)
    } catch (e) { this.opts.log(`share: limpeza falhou: ${(e as Error).message}`) }
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
      features: {
        provide: (featureId, shareDir) => {
          if (!this.features.some(f => f.id === featureId && f.ext === id)) throw new Error(`a feature ${featureId} não é declarada pela extensão ${id}`)
          this.providers.set(featureId, shareDir)
          return own.add(toDisposable(() => { if (this.providers.get(featureId) === shareDir) this.providers.delete(featureId) }))
        },
      },
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
