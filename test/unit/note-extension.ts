// The note extension's declared contributions as the renderer's extension host feeds them to the core (keys, commands):
// unit tests that exercise the note's keys and commands through the core's table and registry use these.
import { commandFromContribution, type Command } from '../../app/renderer/commands.ts'
import { contributeKeybindings, keybindingEntries } from '../../app/renderer/shortcuts.ts'
import { manifest } from '../../extensions/note/manifest.ts'

let contributed = false
/** The note's default keys join the key table (once per test process, as at the app's startup). */
export function withNoteKeybindings(): void {
  if (contributed) return
  contributeKeybindings(keybindingEntries(manifest.contributes?.keybindings ?? []))
  contributed = true
}

/** The note's declared commands, each running `run(id)`. */
export function noteCommands(run: (id: string) => void): Command[] {
  return (manifest.contributes?.commands ?? []).map(c => commandFromContribution(c, () => run(c.command)))
}
