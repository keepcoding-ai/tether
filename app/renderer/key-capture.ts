// Who owns a key pressed inside a terminal or a note's editor: the app or the program / the editor.
//
// The rule lives in the key table (shortcuts.ts): every binding says WHERE it is the app's. By default a plain
// Ctrl+letter (no Shift, no Alt) belongs to the terminal (^A…^Z are line editing, ^C interrupts, TUIs such as
// Claude Code bind them) unless the letter is in TERMINAL_CAPTURE, the explicit set of Ctrl+letter chords the app
// takes anyway, VS Code's "commands to skip shell" in miniature; the "Atalhos de teclado" screen edits the same
// thing per binding (the Terminal chip). Ctrl+Shift+letter chords (Ctrl+Shift+T, Ctrl+Shift+P…) are the app's:
// xterm would send the same control byte as the plain chord, which nobody types with Shift on purpose. The
// clipboard chords (Ctrl+C with a selection, Ctrl+V) are decided before this, by PANE_SHORTCUTS in the panel itself.
import { IS_MAC, keyTable, resolvedDefaults, KeyTable, TERMINAL_CAPTURE_CODES, type KeyLike } from './shortcuts.ts'

export interface TerminalCapture {
  /** The physical key (`KeyboardEvent.code`), with a plain Ctrl. */
  code: string
  /** Why the app takes it from the terminal. */
  why: string
}

/** Plain Ctrl+letter chords the app takes from a terminal by default. Everything else in Ctrl+letter reaches the program. */
export const TERMINAL_CAPTURE: readonly TerminalCapture[] = [
  { code: 'KeyP', why: 'Ctrl+P is quick open (and > the palette), as in VS Code; a shell has ↑ for the previous command' },
  { code: 'KeyN', why: 'Ctrl+N is the new empty tab (VS Code\'s new file); a shell has ↓ for the next command' },
  { code: 'KeyK', why: 'Ctrl+K is the prefix of the two-key chords, as VS Code\'s terminal.integrated.allowChords; Ctrl+K twice sends ^K' },
]
if (TERMINAL_CAPTURE.length !== TERMINAL_CAPTURE_CODES.length || TERMINAL_CAPTURE.some(c => !TERMINAL_CAPTURE_CODES.includes(c.code))) throw new Error('TERMINAL_CAPTURE and TERMINAL_CAPTURE_CODES disagree')

/** A chord that is Ctrl + a letter and nothing else (the terminal's territory). */
export function isPlainCtrlLetter(ev: KeyLike): boolean {
  return ev.ctrlKey && !ev.shiftKey && !ev.altKey && !ev.metaKey && /^Key[A-Z]$/.test(ev.code)
}

export type KeyOwner = { owner: 'terminal' } | { owner: 'app'; command?: string; prefix?: true }
export type EditorKeyOwner = { owner: 'editor' } | { owner: 'app'; command?: string; prefix?: true }

function tableFor(mac: boolean): KeyTable {
  return mac === IS_MAC ? keyTable() : new KeyTable(resolvedDefaults(mac))
}

/**
 * Inside the note's editor (Monaco), the chords VS Code gives the editor win over the app's: every chord on an
 * arrow key (Ctrl+Alt+↑/↓ add a cursor, Ctrl+Shift+Alt+arrows select a column, Shift+Alt+↑/↓ copy the line,
 * Shift+Alt+←/→ shrink/expand the selection, Alt+↑/↓ move the line, Ctrl+Shift+arrows select by word). Those are
 * the app's "duplicate" chords at the three levels and the "split empty" chord; with a note in focus they are
 * left to the editor, and splitting goes by the palette, the menu or the mouse. Every other app chord of the note
 * scope is the app's, as in VS Code where they belong to the workbench, not the editor.
 */
export function editorKeyOwner(ev: KeyLike, mac = IS_MAC): EditorKeyOwner {
  if (/^Arrow(Up|Down|Left|Right)$/.test(ev.code)) return { owner: 'editor' }
  const r = tableFor(mac).resolve([ev], 'note')
  if (r.kind === 'command') return { owner: 'app', command: r.command }
  if (r.kind === 'prefix') return { owner: 'app', prefix: true }
  return { owner: 'editor' }
}

/** Decides a keydown that happened inside a terminal. `terminal` = xterm handles it as usual; `app` = the app runs the shortcut (or opens a chord). */
export function terminalKeyOwner(ev: KeyLike, mac = IS_MAC): KeyOwner {
  const r = tableFor(mac).resolve([ev], 'terminal')
  if (r.kind === 'command') return { owner: 'app', command: r.command }
  if (r.kind === 'prefix') return { owner: 'app', prefix: true }
  return { owner: 'terminal' }
}
