// The codex conductor in tetherd. Skeleton: it registers nothing yet; its slice registers the conductor in
// conductorRegistry (../for-agents/conductor-api.ts) and returns that disposable.
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import type { TetherDaemon } from '../../src/daemon/ext-api.ts'

export { manifest } from './manifest.ts'

export function activate(_api: TetherDaemon): IDisposable[] {
  return []
}
