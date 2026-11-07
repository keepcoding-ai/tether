// Electron main's extension host (F9 §3.3, slice 0b): activates extensions/index.main.ts at startup (minus the ones
// settings.json `extensions.disabled` lists) with a TetherMain each, and serves the core side of the extensions'
// settings and listing to the renderer:
//   extsettings:get-sync  (sendSync) the `extensions` object of settings.json, read before the renderer activates
//   extsettings:set       one value `<id>.<key>`; normalized by the schema when main knows it; broadcast as tether:ext-setting
//   extensions:list       the main-side manifests and the disabled list, for the "Extensões" screen
//   extensions:set-enabled  the screen's toggle: `extensions.disabled` gains or loses an id (takes effect at the next
//                           start, decision 3); answers the new list
//   features:list         the features the enabled extensions offer the agents (src/core/features.ts) with the general
//                         switch in force, for the profile editor; the switches themselves are registered as the
//                         settings node `agents.features` (the settings page lists them like any setting)
// The extensions' own traffic goes on the bus (app/shared/ext-ipc.ts). No Electron import at runtime: main.ts passes
// ipcMain and the window in, so this is unit-tested with fakes.
import type { BrowserWindow, WebContents } from 'electron'
import { summaryOf, type ExtensionEntry } from '../../extensions/types.ts'
import { extensions as daemonExtensions } from '../../extensions/index.daemon.ts'
import { activateExtensions, type ActivationResult } from '../shared/ext-activation.ts'
import { applyMigrations, stateOf, withState } from '../shared/ext-migrations.ts'
import { mainIpc, type MainIpcTransport } from '../shared/ext-ipc.ts'
import { ConfigurationRegistry, withSetting, type ExtensionsSettings, type SettingValue } from '../shared/vscode-configuration-registry.ts'
import { DisposableStore, toDisposable } from '../shared/vscode-lifecycle.ts'
import type { TetherMain } from './ext-api.ts'
import { BRAND } from '../shared/brand.ts'
import { declaredFeatures, featureInfos, featuresConfigurationNode, type FeatureDecl, type FeatureInfo } from '../../src/core/features.ts'

import type { ExtSettingChange, MainExtensionsList } from '../shared/api.ts'
export type { ExtSettingChange, MainExtensionsList }

export interface MainHostDeps {
  home: string
  userDir: string
  dist: string
  ipc: MainIpcTransport & { on(channel: string, fn: (event: { returnValue?: unknown }, ...args: never[]) => void): void }
  /** main → renderer (the window's webContents.send, when there is a window). */
  broadcast(channel: string, ...args: unknown[]): void
  window(): BrowserWindow | undefined
  readSettings(): ExtensionsSettings
  writeSettings(s: ExtensionsSettings): void
  /** The whole settings.json object (migrations, remembered state). */
  readFile(): Record<string, unknown>
  writeFile(file: Record<string, unknown>): void
  log(msg: string): void
  /** Moves a path to the system's trash (shell.trashItem); absent in the unit tests. */
  trash?(path: string): Promise<void>
}

const KEY = /^[a-zA-Z0-9][a-zA-Z0-9.-]*$/
const ID = /^[a-z0-9][a-z0-9-]*$/
const isValue = (v: unknown): v is SettingValue => typeof v === 'boolean' || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))

export class MainExtensionHost {
  readonly store = new DisposableStore()
  readonly configuration = new ConfigurationRegistry()
  private readonly listeners = new Map<string, Set<(value: SettingValue) => void>>()
  private result: ActivationResult = { active: [], disabled: [], failed: [] }
  private readonly webviewGuards = new Set<(host: WebContents) => void>()
  private readonly deps: MainHostDeps
  private readonly list: readonly ExtensionEntry<TetherMain>[]
  /** The enabled extensions' features (main's and the daemon's indexes: an agent-only extension may declare one). */
  features: FeatureDecl[] = []

  constructor(list: readonly ExtensionEntry<TetherMain>[], deps: MainHostDeps) {
    this.list = list
    this.deps = deps
    deps.ipc.on('extsettings:get-sync', (e: { returnValue?: unknown }) => { e.returnValue = deps.readSettings() })
    deps.ipc.on('extsettings:set', (_e, id: unknown, key: unknown, value: unknown) => { if (typeof id === 'string' && typeof key === 'string') this.setSetting(id, key, value) })
    deps.ipc.handle('extensions:list', (): MainExtensionsList => ({ manifests: this.list.map(e => summaryOf(e.manifest)), disabled: deps.readSettings().disabled, failed: this.result.failed }))
    deps.ipc.handle('extensions:set-enabled', (_e, id: unknown, on: unknown): string[] => (typeof id === 'string' && typeof on === 'boolean' ? this.setEnabled(id, on) : deps.readSettings().disabled))
    deps.ipc.handle('features:list', (): FeatureInfo[] => featureInfos(this.features, deps.readFile()))
  }

  /** Activates the index (called once, when the app is ready). */
  activate(): ActivationResult {
    this.migrate()
    const disabled = this.deps.readSettings().disabled
    for (const e of this.list) {
      const settings = e.manifest.contributes?.settings
      if (settings && !disabled.includes(e.manifest.id)) this.store.add(this.configuration.registerConfiguration({ id: e.manifest.id, title: e.manifest.displayName, properties: settings }))
    }
    const manifests = new Map([...this.list, ...daemonExtensions].map(e => [e.manifest.id, e.manifest] as const))
    const declared = declaredFeatures([...manifests.values()].filter(m => !disabled.includes(m.id)))
    for (const p of declared.problems) this.deps.log(`extensões: ${p}`)
    this.features = declared.features
    if (this.features.length) this.store.add(this.configuration.registerConfiguration(featuresConfigurationNode(this.features)))
    this.result = activateExtensions(this.list, id => this.apiFor(id), this.store, disabled)
    if (this.result.active.length || this.result.failed.length) this.deps.log(`extensões (main): ativas ${this.result.active.join(', ') || '—'}; falharam ${this.result.failed.map(f => `${f.id} (${f.error})`).join(', ') || '—'}`)
    return this.result
  }

  /** The manifests' one-time moves of values the core kept (every extension of the index, enabled or not). */
  private migrate(): void {
    const { file, moved } = applyMigrations(this.deps.readFile(), this.list.map(e => e.manifest))
    if (!moved.length) return
    this.deps.writeFile(file)
    this.deps.log(`extensões: configurações migradas: ${moved.join('; ')}`)
  }

  /** A new app window: the extensions' webview guards install on it; with none, every webview is refused. */
  guardWebviews(host: WebContents, refuseAll: () => void): void {
    if (this.webviewGuards.size === 0) { refuseAll(); return }
    for (const install of this.webviewGuards) install(host)
  }

  /**
   * Turns an extension on or off for the next start (an id no index knows, or one that is not optional, is refused). The
   * daemon index counts too: an agent extension (claude, soul) has no main entry, and tetherd and the CLI read the same list.
   */
  setEnabled(id: string, on: boolean): string[] {
    const s = this.deps.readSettings()
    const optional = [...this.list, ...daemonExtensions].find(e => e.manifest.id === id)?.manifest.optional === true
    if (!ID.test(id) || (!on && !optional)) return s.disabled
    const disabled = on ? s.disabled.filter(x => x !== id) : [...new Set([...s.disabled, id])]
    this.deps.writeSettings({ ...s, disabled })
    this.deps.log(`extensões: ${id} ${on ? 'ligada' : 'desligada'} (vale no próximo início)`)
    return disabled
  }

  /** Writes one setting and tells both sides. A value main has a schema for is normalized; an unknown key is kept as given (the renderer normalized it). */
  setSetting(id: string, key: string, value: unknown): void {
    if (!ID.test(id) || !KEY.test(key) || !isValue(value)) return
    const schema = this.configuration.schemaOf(id, key)
    const v = schema ? this.configuration.read({ disabled: [], values: { [id]: { [key]: value } } }, id, key)! : value
    this.deps.writeSettings(withSetting(this.deps.readSettings(), id, key, v))
    this.announce(id, key, v)
  }

  private announce(id: string, key: string, v: SettingValue): void {
    const change: ExtSettingChange = { id, key, value: v }
    this.deps.broadcast('tether:ext-setting', change)
    for (const l of this.listeners.get(`${id}.${key}`) ?? []) l(v)
  }

  /** settings.json was edited outside the app: tells both sides of each changed `extensions.<id>.<key>` (`disabled` waits for the next start). */
  settingsChangedOnDisk(keys: readonly string[]): void {
    for (const full of keys) {
      const [root, id, ...rest] = full.split('.')
      const key = rest.join('.')
      if (root !== 'extensions' || !id || !key || !ID.test(id) || !KEY.test(key)) continue
      const raw = this.deps.readSettings().values[id]?.[key]
      const schema = this.configuration.schemaOf(id, key)
      const v = schema ? this.configuration.read(this.deps.readSettings(), id, key)! : raw
      if (isValue(v)) this.announce(id, key, v)
    }
  }

  private apiFor(id: string): TetherMain {
    const deps = this.deps
    return {
      id,
      brand: BRAND,
      home: deps.home,
      userDir: deps.userDir,
      dist: deps.dist,
      ipc: () => mainIpc(id, deps.ipc, deps.broadcast),
      settings: {
        get: <T extends SettingValue>(key: string) => this.configuration.read(deps.readSettings(), id, key) as T | undefined,
        set: (key, value) => this.setSetting(id, key, value),
        onChange: (key, listener) => {
          const full = `${id}.${key}`
          let set = this.listeners.get(full)
          if (!set) { set = new Set(); this.listeners.set(full, set) }
          set.add(listener)
          return toDisposable(() => { set.delete(listener) })
        },
      },
      state: {
        get: <T>(key: string) => stateOf(deps.readFile(), id)[key] as T | undefined,
        update: (key, value) => deps.writeFile(withState(deps.readFile(), id, key, value)),
      },
      webviews: {
        guard: install => {
          this.webviewGuards.add(install)
          return toDisposable(() => { this.webviewGuards.delete(install) })
        },
      },
      window: { current: () => deps.window() },
      shell: { trash: path => (deps.trash ? deps.trash(path) : Promise.reject(new Error('lixeira indisponível'))) },
      log: msg => deps.log(`[${id}] ${msg}`),
    }
  }
}
