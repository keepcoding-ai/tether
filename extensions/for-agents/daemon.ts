// The for-agents extension in tetherd. Skeleton: nothing registered yet, so turned on and unused it changes no state.
// The ownership (daemon/ownership.ts, reconcile.ts, guard.ts) and the verbs come in their own slices.
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import type { TetherDaemon } from '../../src/daemon/ext-api.ts'

export { manifest } from './manifest.ts'
/** The same pure rules the renderer draws from. */
export { effective } from './rules.ts'

export function activate(_api: TetherDaemon): IDisposable[] {
  return []
}
