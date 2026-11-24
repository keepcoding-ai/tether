// The channels extension in the app. The channel's pane (reading) is here (U1a); the speaking box comes in its own slice (U1b);
// the commands, the picker and the menus are U2 (renderer/commands.ts, renderer/menus.ts); the marks (unread, "to you") and the
// top bar icon are U3 (renderer/marks.ts, renderer/status.ts).
import type { Disposable, TetherUi } from '../../app/renderer/ext-api.ts'
import { createChannelPanes } from './renderer/channel-pane.ts'
import { createCommands, createDirectory } from './renderer/commands.ts'
import { holds } from './renderer/holds.ts'
import { createMarks } from './renderer/marks.ts'
import { createMenus } from './renderer/menus.ts'
import { createStatus } from './renderer/status.ts'

export { manifest } from './manifest.ts'

export function activate(ui: TetherUi): Disposable[] {
  const directory = createDirectory(ui)
  // The marks hear the daemon's `line` before the panes do: a line seen the moment it comes never counts as unread.
  const marks = createMarks(ui, directory)
  const panes = createChannelPanes(ui, marks)
  return [
    ...directory.disposables, ...marks.disposables, ...panes.disposables,
    ...createStatus(ui, marks, directory.list),
    ...createCommands(ui, { open: panes.open, directory }),
    ...createMenus(ui, directory, panes.open),
    ...holds(ui, directory.memberIds),
  ]
}
