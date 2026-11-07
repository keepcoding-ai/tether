// The faults extension in tetherd: it contributes nothing but the feature `faults` (extensions/faults/share: the skills the
// agents of the panes receive). The declaration is what the daemon needs to compose the share folder, so the entry exists
// only to make the manifest known to the daemon's extension host; the screen is the renderer's and main's.
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import type { TetherDaemon } from '../../src/daemon/ext-api.ts'
export { manifest } from './manifest.ts'

export function activate(_api: TetherDaemon): IDisposable[] {
  return []
}
