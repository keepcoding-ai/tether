// The extensions with a renderer entry, in activation order. Add `{ manifest, activate }` of extensions/<id>/renderer.ts here.
import type { TetherUi } from '../app/renderer/ext-api.ts'
import type { ExtensionEntry } from './types.ts'

export const extensions: readonly ExtensionEntry<TetherUi>[] = []
