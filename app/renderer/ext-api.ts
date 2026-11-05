// `TetherUi`: what the renderer offers an extension's `activate` (F9). It grows per slice (study §3.2): slice 0a has the
// pane-type registry; 0b adds the IPC bus to the extension's main side and its settings. Every
// registration returns a disposable (app/shared/vscode-lifecycle.ts).
import type { ChannelMap, UiIpc } from '../shared/ext-ipc.ts'
import type { SettingValue } from '../shared/vscode-configuration-registry.ts'
import type { IDisposable } from '../shared/vscode-lifecycle.ts'
import type { PaneType } from './pane-registry.ts'

export type { IDisposable as Disposable } from '../shared/vscode-lifecycle.ts'
export type { PaneType } from './pane-registry.ts'

export interface TetherUi {
  /** The extension's id. */
  readonly id: string
  panes: {
    register(type: PaneType): IDisposable
  }
  /** The extension's channels to its main side (`ext:<id>:<channel>`), typed by its channel map. */
  ipc<C extends ChannelMap>(): UiIpc<C>
  /** The extension's settings (`extensions.<id>.<key>` of settings.json), normalized by its manifest's schema. */
  settings: {
    get<T extends SettingValue>(key: string): T | undefined
    set(key: string, value: SettingValue): void
    onChange(key: string, listener: (value: SettingValue) => void): IDisposable
  }
}
