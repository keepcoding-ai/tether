// `TetherUi`: what the renderer offers an extension's `activate` (F9). It grows per slice (study §3.2): slice 0a has the
// pane-type registry; 0b adds the IPC bus to the extension's main side, its settings and the ≡ menu. Every
// registration returns a disposable (app/shared/vscode-lifecycle.ts).
import type { ChannelMap, UiIpc } from '../shared/ext-ipc.ts'
import type { SettingValue } from '../shared/vscode-configuration-registry.ts'
import type { MenuItem } from '../shared/vscode-menu-registry.ts'
import type { IDisposable } from '../shared/vscode-lifecycle.ts'
import type { CommandContext } from './commands.ts'
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
  menus: {
    /** An item of the ≡ menu; the core fixes the group order (app/renderer/app-menu.ts APP_MENU_GROUPS). */
    app(item: MenuItem<CommandContext>): IDisposable
  }
}
