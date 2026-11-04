// Who owns a key pressed inside a terminal: the app or the program running in it.
//
// The rule, in one place: every app chord (shortcuts.ts) is the app's, except plain Ctrl+letter (no Shift, no
// Alt), which belongs to the terminal (^A…^Z are line editing, ^C interrupts, TUIs such as Claude Code bind
// them) unless the letter is in TERMINAL_CAPTURE. That list is the explicit set of Ctrl+letter chords the app
// takes anyway, VS Code's "commands to skip shell" in miniature, and the one thing a setting will edit later.
//
// Ctrl+Shift+letter chords (Ctrl+Shift+T, Ctrl+Shift+P…) are the app's by the convention of shortcuts.ts: xterm
// would send the same control byte as the plain chord, which nobody types with Shift on purpose. The clipboard
// chords (Ctrl+C with a selection, Ctrl+V) are decided before this, by PANE_SHORTCUTS in the panel itself.
import { IS_MAC, shortcutOf, type AppShortcut, type KeyLike } from './shortcuts.ts'

export interface TerminalCapture {
  /** The physical key (`KeyboardEvent.code`), with a plain Ctrl. */
  code: string
  /** Why the app takes it from the terminal. */
  why: string
}

/** Plain Ctrl+letter chords the app takes from a terminal. Everything else in Ctrl+letter reaches the program. */
export const TERMINAL_CAPTURE: readonly TerminalCapture[] = [
  { code: 'KeyP', why: 'Ctrl+P is quick open (and > the palette), as in VS Code; a shell has ↑ for the previous command' },
]

/** A chord that is Ctrl + a letter and nothing else (the terminal's territory). */
export function isPlainCtrlLetter(ev: KeyLike): boolean {
  return ev.ctrlKey && !ev.shiftKey && !ev.altKey && !ev.metaKey && /^Key[A-Z]$/.test(ev.code)
}

export type KeyOwner = { owner: 'terminal' } | { owner: 'app'; shortcut: AppShortcut }

/** Decides a keydown that happened inside a terminal. `terminal` = xterm handles it as usual; `app` = the app runs the shortcut. */
export function terminalKeyOwner(ev: KeyLike, mac = IS_MAC): KeyOwner {
  const shortcut = shortcutOf(ev, mac)
  if (!shortcut) return { owner: 'terminal' }
  if (isPlainCtrlLetter(ev) && !TERMINAL_CAPTURE.some(c => c.code === ev.code)) return { owner: 'terminal' }
  return { owner: 'app', shortcut }
}
