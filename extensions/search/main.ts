// The search extension's Electron-main side. Skeleton: the search service enters in the next step; for now it only
// declares the manifest.
import type { TetherMain } from '../../app/main/ext-api.ts'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'

export { manifest } from './manifest.ts'

export function activate(_main: TetherMain): IDisposable[] {
  return []
}
