// The extensions with a renderer entry, in activation order. Add `{ manifest, activate }` of extensions/<id>/renderer.ts here.
import type { TetherUi } from '../app/renderer/ext-api.ts'
import type { ExtensionEntry } from './types.ts'
import * as note from './note/renderer.ts'
import * as framePads from './frame-pads/renderer.ts'
import * as quickOpen from './quick-open/renderer.ts'
import * as explorer from './explorer/renderer.ts'
import * as keybindingsScreen from './keybindings-screen/renderer.ts'

export const extensions: readonly ExtensionEntry<TetherUi>[] = [
  { manifest: note.manifest, activate: note.activate },
  { manifest: quickOpen.manifest, activate: quickOpen.activate },
  { manifest: framePads.manifest, activate: framePads.activate },
  { manifest: explorer.manifest, activate: explorer.activate },
  { manifest: keybindingsScreen.manifest, activate: keybindingsScreen.activate },
]
