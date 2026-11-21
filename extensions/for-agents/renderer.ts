// The for-agents extension in the app. Skeleton: nothing registered yet. It draws what the daemon decides, through the
// same pure rules (rules.ts), which import nothing of either host.
import type { Disposable, TetherUi } from '../../app/renderer/ext-api.ts'

export { manifest } from './manifest.ts'
export { effective } from './rules.ts'

export function activate(_api: TetherUi): Disposable[] {
  return []
}
