// The keybindings-screen extension's declared contributions as the renderer's extension host feeds them to the core
// (keys): unit tests that exercise Ctrl+K Ctrl+S through the core's table use these.
import { contributeKeybindings, keybindingEntries } from '../../app/renderer/shortcuts.ts'
import { manifest } from '../../extensions/keybindings-screen/manifest.ts'

let contributed = false
/** Ctrl+K Ctrl+S and Ctrl+K Ctrl+K join the key table (once per test process, as at the app's startup). */
export function withKeybindingsScreenKeybindings(): void {
  if (contributed) return
  contributeKeybindings(keybindingEntries(manifest.contributes?.keybindings ?? []))
  contributed = true
}
