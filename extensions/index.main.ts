// The extensions with an Electron-main entry (extensions/<id>/main.ts), in activation order; activated by
// app/main/ext-host.ts at startup. Add `{ manifest, activate }` of extensions/<id>/main.ts here.
import type { TetherMain } from '../app/main/ext-api.ts'
import type { ExtensionEntry } from './types.ts'

export const extensions: readonly ExtensionEntry<TetherMain>[] = []
