// The note tab's rules that need no DOM (unit-tested): how a Monaco action becomes a command of the app's
// registry (a stable id in the registry's shape, the chord Monaco shows turned into a Chord the hints know),
// and which folder a note "belongs" to when another note is born from it.
import type { Chord } from './shortcuts.ts'
import { NOTES_SUBDIR, noteDirOf } from '../shared/notes.ts'

/** The registry's group for the editor's actions. */
export const EDITOR_GROUP = 'Editor'

/**
 * A Monaco action id as a command id of the registry: lowercase dotted kebab (`editor.action.insertCursorBelow`
 * → `editor.action.insert-cursor-below`; `actions.find` → `editor.actions.find`; `cursorUndo` → `editor.cursor-undo`).
 */
export function editorCommandId(actionId: string): string {
  // An action added to one editor (`editor.addAction`) is listed as `vs.editor.ICodeEditor:<n>:<id>`: the instance is not part of the id.
  const own = actionId.replace(/^vs\.editor\.ICodeEditor:\d+:/, '')
  const kebab = own
    .split('.')
    .map(seg => seg.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase())
    .filter(seg => seg !== '')
    .join('.')
  return kebab.startsWith('editor.') ? kebab : `editor.${kebab}`
}

const KEY_CODE: Record<string, string> = {
  uparrow: 'ArrowUp', downarrow: 'ArrowDown', leftarrow: 'ArrowLeft', rightarrow: 'ArrowRight',
  '↑': 'ArrowUp', '↓': 'ArrowDown', '←': 'ArrowLeft', '→': 'ArrowRight',
  enter: 'Enter', '↩': 'Enter', escape: 'Escape', '⎋': 'Escape', tab: 'Tab', '⇥': 'Tab', backspace: 'Backspace', '⌫': 'Backspace',
  delete: 'Delete', '⌦': 'Delete', home: 'Home', '↖': 'Home', end: 'End', '↘': 'End', pageup: 'PageUp', '⇞': 'PageUp', pagedown: 'PageDown', '⇟': 'PageDown',
  space: 'Space', '␣': 'Space', '-': 'Minus', '=': 'Equal', '`': 'Backquote',
}

/**
 * The Chord for a keybinding label Monaco shows ("Ctrl+Shift+L", "Ctrl+Alt+DownArrow", "Alt+Z"; on the Mac
 * "⇧⌘L", "⌥↓"), so the registry's hint prints it in the app's own style. Undefined for a two-step chord
 * ("Ctrl+K Ctrl+C") or a key the hints have no name for.
 */
export function chordFromLabel(label: string): Chord | undefined {
  const text = label.trim()
  if (text === '' || /\s/.test(text)) return undefined
  const chord: Chord = { code: '' }
  let rest = text
  // Mac glyphs come first, without separators.
  for (;;) {
    const g = rest[0]
    if (g === '⌃') chord.ctrl = true
    else if (g === '⌥') chord.alt = true
    else if (g === '⇧') chord.shift = true
    else if (g === '⌘') chord.meta = true
    else break
    rest = rest.slice(1)
  }
  const parts = rest.split('+')
  // "Ctrl++" is not a label Monaco produces; a trailing empty part means the key was "+", which has no code here.
  const key = parts.pop() ?? ''
  for (const p of parts) {
    const m = p.toLowerCase()
    if (m === 'ctrl' || m === 'control') chord.ctrl = true
    else if (m === 'shift') chord.shift = true
    else if (m === 'alt' || m === 'option') chord.alt = true
    else if (m === 'win' || m === 'cmd' || m === 'meta' || m === 'super') chord.meta = true
    else return undefined
  }
  const code = keyCodeOf(key)
  if (!code) return undefined
  chord.code = code
  return chord
}

function keyCodeOf(key: string): string | undefined {
  if (/^[A-Za-z]$/.test(key)) return `Key${key.toUpperCase()}`
  if (/^[0-9]$/.test(key)) return `Digit${key}`
  if (/^F([1-9]|1[0-2])$/i.test(key)) return key.toUpperCase()
  return KEY_CODE[key.toLowerCase()] ?? KEY_CODE[key]
}

/**
 * The pane folder a note was born for: `<cwd>` when the note lives in `<cwd>/.tether/notes/`; undefined for a
 * note anywhere else (the person's own folder, or a file opened from the disk). A new note made while this
 * one has the focus goes to the same place.
 */
export function paneCwdOfNote(path: string): string | undefined {
  const dir = noteDirOf(path).replace(/[\\/]+$/, '')
  const tail = NOTES_SUBDIR.split('/')
  const m = new RegExp(`^(.*)[\\\\/]${tail[0]!.replace('.', '\\.')}[\\\\/]${tail[1]}$`, 'i').exec(dir)
  return m ? m[1]! : undefined
}
