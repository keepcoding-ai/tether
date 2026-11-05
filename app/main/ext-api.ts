// `TetherMain`: what Electron main offers an extension's `activate` (F9 §3.3). It grows per slice; slice 0b has the
// identity, the folders, the IPC bus (ext:<id>:<channel>), the extension's settings, the window and the log. Every
// registration returns a disposable (app/shared/vscode-lifecycle.ts).
import type { BrowserWindow } from 'electron'
import type { ChannelMap, MainIpc } from '../shared/ext-ipc.ts'
import type { SettingValue } from '../shared/vscode-configuration-registry.ts'
import type { IDisposable } from '../shared/vscode-lifecycle.ts'

export type { IDisposable as Disposable } from '../shared/vscode-lifecycle.ts'

/** One extension's settings (`extensions.<id>.<key>` of settings.json), normalized by its manifest's schema. */
export interface ExtSettings {
  get<T extends SettingValue>(key: string): T | undefined
  set(key: string, value: SettingValue): void
  onChange(key: string, listener: (value: SettingValue) => void): IDisposable
}

export interface TetherMain {
  readonly id: string
  /** TETHER_HOME. */
  readonly home: string
  /** app/dist (workers, assets). */
  readonly dist: string
  /** The extension's channels, typed by its channel map. */
  ipc<C extends ChannelMap>(): MainIpc<C>
  settings: ExtSettings
  window: { current(): BrowserWindow | undefined }
  /** A line in tether-app.log, prefixed with the extension's id. */
  log(msg: string): void
}
