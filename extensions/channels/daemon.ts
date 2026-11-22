// The channels extension in tetherd. The store, the verbs and the delivery come in their own slices.
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import type { TetherDaemon } from '../../src/daemon/ext-api.ts'

export { manifest } from './manifest.ts'

export function activate(_api: TetherDaemon): IDisposable[] {
  return []
}
