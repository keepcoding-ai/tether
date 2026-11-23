// The channels extension in the app. The channel's pane (reading) is here (U1a); the speaking box comes in its own slice (U1b),
// the commands and the picker in the next (U2).
import type { Disposable, TetherUi } from '../../app/renderer/ext-api.ts'
import { createChannelPanes } from './renderer/channel-pane.ts'

export { manifest } from './manifest.ts'

export function activate(ui: TetherUi): Disposable[] {
  return createChannelPanes(ui).disposables
}
