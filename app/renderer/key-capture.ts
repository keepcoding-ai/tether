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
export type EditorKeyOwner = { owner: 'editor' } | { owner: 'app'; shortcut: AppShortcut }

/**
 * Inside the note's editor (Monaco), the chords VS Code gives the editor win over the app's: every Alt + arrow
 * combination (Ctrl+Alt+↑/↓ add a cursor, Ctrl+Shift+Alt+arrows select a column, Shift+Alt+↑/↓ copy the line,
 * Shift+Alt+←/→ shrink/expand the selection, Alt+↑/↓ move the line). Those are the app's "duplicate" chords at
 * the three levels; with a note in focus they are left to the editor, and duplicating goes by the palette, the
 * menu or the mouse. Every other app chord (Ctrl+Shift+T, Ctrl+Tab, Ctrl+1…9, Ctrl+`, Ctrl+Shift+P, Ctrl+P, the
 * font size) is the app's, as in VS Code where they belong to the workbench, not the editor. Monaco stops the
 * propagation of the keys it binds itself, so this rule only matters for the chords it leaves alone.
 */
export function editorKeyOwner(ev: KeyLike, mac = IS_MAC): EditorKeyOwner {
  const shortcut = shortcutOf(ev, mac)
  if (!shortcut) return { owner: 'editor' }
  if (ev.altKey && /^Arrow(Up|Down|Left|Right)$/.test(ev.code)) return { owner: 'editor' }
  return { owner: 'app', shortcut }
}

/** Decides a keydown that happened inside a terminal. `terminal` = xterm handles it as usual; `app` = the app runs the shortcut. */
export function terminalKeyOwner(ev: KeyLike, mac = IS_MAC): KeyOwner {
  const shortcut = shortcutOf(ev, mac)
  if (!shortcut) return { owner: 'terminal' }
  if (isPlainCtrlLetter(ev) && !TERMINAL_CAPTURE.some(c => c.code === ev.code)) return { owner: 'terminal' }
  return { owner: 'app', shortcut }
}
