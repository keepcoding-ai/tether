// The keyboard registry: every app chord in one table, so a shortcut is changed in exactly one place and the
// hints (menus, tooltips, the watermark) follow. A chord never includes Meta (Win): the OS owns most Win chords
// (Win+Ctrl+Arrow switches virtual desktops, Win+Arrow snaps windows). Ctrl+Alt+letter is avoided on purpose:
// on an ABNT2 keyboard it is AltGr.
//
//   level pane   Ctrl+Alt+Arrow         duplicate beside the focused pane (Ctrl+Shift+D / E: right / below aliases)
//   level frame  Ctrl+Alt+Shift+Arrow   duplicate at the frame's edge (full height or width of the frame)
//   level desk   Alt+Shift+Arrow        duplicate into a new frame at the desk's edge
//   Ctrl+Shift+T chooser · Ctrl+Shift+Q quit all
import type { Direction } from './create.ts'

/** Where a new pane is born relative to the focus: beside the pane, at the frame's edge, or in a new frame at the desk's edge. */
export type Level = 'pane' | 'frame' | 'desk'
export const LEVELS: readonly Level[] = ['pane', 'frame', 'desk']

export type AppShortcut =
  | { op: 'choose' }
  | { op: 'duplicate'; level: Level; direction: Direction }
  | { op: 'quit-all' }

/** The subset of KeyboardEvent the mapping needs (tests build it by hand). */
export interface KeyLike { ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean; code: string }

/** A chord as modifiers + `KeyboardEvent.code` (layout-independent: KeyT is the physical T). */
export interface Chord { ctrl?: boolean; alt?: boolean; shift?: boolean; code: string }

export interface ShortcutEntry { chord: Chord; command: AppShortcut }

const ARROW_CODE: Record<Direction, string> = { left: 'ArrowLeft', right: 'ArrowRight', above: 'ArrowUp', below: 'ArrowDown' }
const DIRECTIONS: readonly Direction[] = ['left', 'right', 'above', 'below']

/** The four arrow chords of a level, sharing the modifiers. */
function arrows(mods: Omit<Chord, 'code'>, level: Level): ShortcutEntry[] {
  return DIRECTIONS.map(direction => ({ chord: { ...mods, code: ARROW_CODE[direction] }, command: { op: 'duplicate', level, direction } }))
}

/** The registry. Order matters only for `shortcutHint`: the first entry of a command is the one shown. */
export const SHORTCUTS: readonly ShortcutEntry[] = [
  { chord: { ctrl: true, shift: true, code: 'KeyT' }, command: { op: 'choose' } },
  ...arrows({ ctrl: true, alt: true }, 'pane'),
  { chord: { ctrl: true, shift: true, code: 'KeyD' }, command: { op: 'duplicate', level: 'pane', direction: 'right' } },
  { chord: { ctrl: true, shift: true, code: 'KeyE' }, command: { op: 'duplicate', level: 'pane', direction: 'below' } },
  ...arrows({ ctrl: true, alt: true, shift: true }, 'frame'),
  ...arrows({ alt: true, shift: true }, 'desk'),
  { chord: { ctrl: true, shift: true, code: 'KeyQ' }, command: { op: 'quit-all' } },
]

function matches(chord: Chord, ev: KeyLike): boolean {
  return ev.code === chord.code && ev.ctrlKey === !!chord.ctrl && ev.altKey === !!chord.alt && ev.shiftKey === !!chord.shift
}

/** The app command a key chord means, or undefined when it is not one of ours (the terminal keeps the key). */
export function shortcutOf(ev: KeyLike): AppShortcut | undefined {
  if (ev.metaKey) return undefined
  return SHORTCUTS.find(s => matches(s.chord, ev))?.command
}

const CODE_GLYPH: Record<string, string> = { ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓' }

/** What the user reads for a chord: "Ctrl+Alt+Shift+→", "Ctrl+Shift+T". */
export function chordLabel(chord: Chord): string {
  const parts: string[] = []
  if (chord.ctrl) parts.push('Ctrl')
  if (chord.alt) parts.push('Alt')
  if (chord.shift) parts.push('Shift')
  parts.push(CODE_GLYPH[chord.code] ?? chord.code.replace(/^Key|^Digit/, ''))
  return parts.join('+')
}

function sameCommand(a: AppShortcut, b: AppShortcut): boolean {
  if (a.op !== b.op) return false
  if (a.op === 'duplicate' && b.op === 'duplicate') return a.level === b.level && a.direction === b.direction
  return true
}

/** The hint for a command (its first chord in the registry), or '' when it has none. */
export function shortcutHint(command: AppShortcut): string {
  const entry = SHORTCUTS.find(s => sameCommand(s.command, command))
  return entry ? chordLabel(entry.chord) : ''
}
