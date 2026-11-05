// Electron main's extension host (F9 §3.3, slice 0b): activates extensions/index.main.ts at startup (minus the ones
// settings.json `extensions.disabled` lists) with a TetherMain each, and serves the core side of the extensions'
// settings and listing to the renderer:
//   extsettings:get-sync  (sendSync) the `extensions` object of settings.json, read before the renderer activates
//   extsettings:set       one value `<id>.<key>`; normalized by the schema when main knows it; broadcast as tether:ext-setting
//   extensions:list       the main-side manifests and the disabled list, for the "Extensões" screen
// The extensions' own traffic goes on the bus (app/shared/ext-ipc.ts). No Electron import at runtime: main.ts passes
// ipcMain and the window in, so this is unit-tested with fakes.
import type { BrowserWindow } from 'electron'
import type { ExtensionEntry, ExtensionManifest } from '../../extensions/types.ts'
import { activateExtensions, type ActivationResult } from '../shared/ext-activation.ts'
import { mainIpc, type MainIpcTransport } from '../shared/ext-ipc.ts'
import { ConfigurationRegistry, withSetting, type ExtensionsSettings, type SettingValue } from '../shared/vscode-configuration-registry.ts'
import { DisposableStore, toDisposable } from '../shared/vscode-lifecycle.ts'
import type { TetherMain } from './ext-api.ts'

import type { ExtSettingChange, MainExtensionsList } from '../shared/api.ts'
export type { ExtSettingChange, MainExtensionsList }

export interface MainHostDeps {
  home: string
  dist: string
  ipc: MainIpcTransport & { on(channel: string, fn: (event: { returnValue?: unknown }, ...args: never[]) => void): void }
  /** main → renderer (the window's webContents.send, when there is a window). */
  broadcast(channel: string, ...args: unknown[]): void
  window(): BrowserWindow | undefined
  readSettings(): ExtensionsSettings
  writeSettings(s: ExtensionsSettings): void
  log(msg: string): void
}

const KEY = /^[a-zA-Z0-9][a-zA-Z0-9.-]*$/
const ID = /^[a-z0-9][a-z0-9-]*$/
const isValue = (v: unknown): v is SettingValue => typeof v === 'boolean' || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))

export class MainExtensionHost {
  readonly store = new DisposableStore()
  readonly configuration = new ConfigurationRegistry()
  private readonly listeners = new Map<string, Set<(value: SettingValue) => void>>()
  private result: ActivationResult = { active: [], disabled: [], failed: [] }
  private readonly deps: MainHostDeps
  private readonly list: readonly ExtensionEntry<TetherMain>[]

  constructor(list: readonly ExtensionEntry<TetherMain>[], deps: MainHostDeps) {
    this.list = list
    this.deps = deps
    deps.ipc.on('extsettings:get-sync', (e: { returnValue?: unknown }) => { e.returnValue = deps.readSettings() })
    deps.ipc.on('extsettings:set', (_e, id: unknown, key: unknown, value: unknown) => { if (typeof id === 'string' && typeof key === 'string') this.setSetting(id, key, value) })
    deps.ipc.handle('extensions:list', (): MainExtensionsList => ({ manifests: this.list.map(e => e.manifest), disabled: deps.readSettings().disabled, failed: this.result.failed }))
  }

  /** Activates the index (called once, when the app is ready). */
  activate(): ActivationResult {
    const disabled = this.deps.readSettings().disabled
    for (const e of this.list) {
      const settings = e.manifest.contributes?.settings
      if (settings && !disabled.includes(e.manifest.id)) this.store.add(this.configuration.registerConfiguration({ id: e.manifest.id, properties: settings }))
    }
    this.result = activateExtensions(this.list, id => this.apiFor(id), this.store, disabled)
    if (this.result.active.length || this.result.failed.length) this.deps.log(`extensões (main): ativas ${this.result.active.join(', ') || '—'}; falharam ${this.result.failed.map(f => `${f.id} (${f.error})`).join(', ') || '—'}`)
    return this.result
  }

  /** Writes one setting and tells both sides. A value main has a schema for is normalized; an unknown key is kept as given (the renderer normalized it). */
  setSetting(id: string, key: string, value: unknown): void {
    if (!ID.test(id) || !KEY.test(key) || !isValue(value)) return
    const schema = this.configuration.schemaOf(id, key)
    const v = schema ? this.configuration.read({ disabled: [], values: { [id]: { [key]: value } } }, id, key)! : value
    this.deps.writeSettings(withSetting(this.deps.readSettings(), id, key, v))
    const change: ExtSettingChange = { id, key, value: v }
    this.deps.broadcast('tether:ext-setting', change)
    for (const l of this.listeners.get(`${id}.${key}`) ?? []) l(v)
  }

  private apiFor(id: string): TetherMain {
    const deps = this.deps
    return {
      id,
      home: deps.home,
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
      window: { current: () => deps.window() },
      log: msg => deps.log(`[${id}] ${msg}`),
    }
  }
}
