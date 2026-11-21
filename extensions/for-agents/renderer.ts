// The for-agents extension in the app: draws what the daemon decides about ownership (renderer/marks.ts), through the same pure
// rules (rules.ts), which import nothing of either host.
import type { Disposable, TetherUi } from '../../app/renderer/ext-api.ts'
import { gestures } from './renderer/gestures.ts'
import { marks } from './renderer/marks.ts'

export { manifest } from './manifest.ts'
export { effective } from './rules.ts'

export function activate(ui: TetherUi): Disposable[] {
  return [...marks(ui), ...gestures(ui)]
}
