// The extensions with an Electron-main entry (extensions/<id>/main.ts), in activation order; activated by
// app/main/ext-host.ts at startup. Add `{ manifest, activate }` of extensions/<id>/main.ts here.
import type { TetherMain } from '../app/main/ext-api.ts'
import type { ExtensionEntry } from './types.ts'
import * as note from './note/main.ts'
import * as quickOpen from './quick-open/main.ts'
import * as explorer from './explorer/main.ts'
import * as keybindingsScreen from './keybindings-screen/main.ts'

export const extensions: readonly ExtensionEntry<TetherMain>[] = [
  { manifest: note.manifest, activate: note.activate },
  { manifest: quickOpen.manifest, activate: quickOpen.activate },
  { manifest: explorer.manifest, activate: explorer.activate },
  { manifest: keybindingsScreen.manifest, activate: keybindingsScreen.activate },
]
