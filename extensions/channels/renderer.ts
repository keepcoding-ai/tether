// The channels extension in the app. The channel's pane and the moderator's box come in their own slices.
import type { Disposable, TetherUi } from '../../app/renderer/ext-api.ts'

export { manifest } from './manifest.ts'

export function activate(_ui: TetherUi): Disposable[] {
  return []
}
