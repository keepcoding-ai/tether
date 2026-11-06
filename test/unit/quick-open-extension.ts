// The quick-open extension's declared contributions as the renderer's extension host feeds them to the core (keys,
// commands): unit tests that exercise Ctrl+P through the core's table and registry use these.
import { commandFromContribution, type Command } from '../../app/renderer/commands.ts'
import { contributeKeybindings, keybindingEntries } from '../../app/renderer/shortcuts.ts'
import { manifest } from '../../extensions/quick-open/manifest.ts'

let contributed = false
/** Ctrl+P joins the key table (once per test process, as at the app's startup). */
export function withQuickOpenKeybindings(): void {
  if (contributed) return
  contributeKeybindings(keybindingEntries(manifest.contributes?.keybindings ?? []))
  contributed = true
}

/** The extension's declared commands, each running `run(id)`. */
export function quickOpenCommands(run: (id: string) => void): Command[] {
  return (manifest.contributes?.commands ?? []).map(c => commandFromContribution(c, () => run(c.command)))
}
