// The extensions with a renderer entry, in activation order. Add `{ manifest, activate }` of extensions/<id>/renderer.ts here.
import type { TetherUi } from '../app/renderer/ext-api.ts'
import type { ExtensionEntry } from './types.ts'
import * as note from './note/renderer.ts'

export const extensions: readonly ExtensionEntry<TetherUi>[] = [
  { manifest: note.manifest, activate: note.activate },
]
