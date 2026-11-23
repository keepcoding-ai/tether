// The channels extension in the app. The channel's pane (reading) is here (U1a); the speaking box comes in its own slice (U1b);
// the commands, the picker and the menus are U2 (renderer/commands.ts, renderer/menus.ts).
import type { Disposable, TetherUi } from '../../app/renderer/ext-api.ts'
import { createChannelPanes } from './renderer/channel-pane.ts'
import { createCommands, createDirectory } from './renderer/commands.ts'
import { createMenus } from './renderer/menus.ts'

export { manifest } from './manifest.ts'

export function activate(ui: TetherUi): Disposable[] {
  const panes = createChannelPanes(ui)
  const directory = createDirectory(ui)
  return [
    ...panes.disposables, ...directory.disposables,
    ...createCommands(ui, { open: panes.open, directory }),
    ...createMenus(ui, directory, panes.open),
  ]
}
