// The browser extension's Electron-main side (E1, skeleton): activates and deactivates cleanly. The registry of tabs,
// the gatekeeper and the surfaces come in later slices.
import type { TetherMain } from '../../app/main/ext-api.ts'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'

export { manifest } from './manifest.ts'

export function activate(_main: TetherMain): IDisposable[] {
  return []
}
