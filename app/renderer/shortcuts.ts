// The keyboard registry: every app chord in one table, so a shortcut is changed in exactly one place and the
// hints (menus, tooltips, the watermark) follow. A chord never includes Meta (Win): the OS owns most Win chords
// (Win+Ctrl+Arrow switches virtual desktops, Win+Arrow snaps windows). Ctrl+Alt+letter is avoided on purpose:
// on an ABNT2 keyboard it is AltGr.
//
//   level pane   Ctrl+Alt+Arrow         duplicate beside the focused pane (Ctrl+Shift+D / E: right / below aliases)
//   level frame  Ctrl+Alt+Shift+Arrow   duplicate at the frame's edge (full height or width of the frame)
//   level desk   Alt+Shift+Arrow        duplicate into a new frame at the desk's edge
//   desks        Ctrl+Tab / Ctrl+Shift+Tab next / previous desk (sequential, wraps) · Ctrl+1…9 desk by position
//                Ctrl+Alt+N new desk after the current one · Ctrl+Alt+Shift+N before it
//   Ctrl+Shift+T chooser · Ctrl+Shift+Q quit all
//
// Desk chords vs the terminal: xterm sends nothing for Ctrl+Tab; Ctrl+1…9 have legacy control codes in xterm
// (Ctrl+2 NUL, Ctrl+3…7 ESC…US, Ctrl+8 DEL) that nobody types on purpose (Esc, Backspace exist); on ABNT2
// AltGr+N (= Ctrl+Alt+N) produces no character, so the chord takes nothing from typing.
//
// Pane chords (PANE_SHORTCUTS) live inside the terminal and never reach the document: Ctrl+C copies the
// selection when there is one (without one it stays the terminal's ^C, which interrupts Claude, dev servers
// and shells), Ctrl+Shift+C always copies, Ctrl+V / Ctrl+Shift+V paste.
import type { Direction } from './create.ts'

/** Where a new pane is born relative to the focus: beside the pane, at the frame's edge, or in a new frame at the desk's edge. */
export type Level = 'pane' | 'frame' | 'desk'
export const LEVELS: readonly Level[] = ['pane', 'frame', 'desk']

export type AppShortcut =
  | { op: 'choose' }
  | { op: 'duplicate'; level: Level; direction: Direction }
  | { op: 'quit-all' }
  | { op: 'desk-cycle'; step: 1 | -1 }
  | { op: 'desk-go'; position: number }
  | { op: 'desk-new'; side: 'before' | 'after' }

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
  { chord: { ctrl: true, code: 'Tab' }, command: { op: 'desk-cycle', step: 1 } },
  { chord: { ctrl: true, shift: true, code: 'Tab' }, command: { op: 'desk-cycle', step: -1 } },
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((position): ShortcutEntry => ({ chord: { ctrl: true, code: `Digit${position}` }, command: { op: 'desk-go', position } })),
  { chord: { ctrl: true, alt: true, code: 'KeyN' }, command: { op: 'desk-new', side: 'after' } },
  { chord: { ctrl: true, alt: true, shift: true, code: 'KeyN' }, command: { op: 'desk-new', side: 'before' } },
]

function matches(chord: Chord, ev: KeyLike): boolean {
  return ev.code === chord.code && ev.ctrlKey === !!chord.ctrl && ev.altKey === !!chord.alt && ev.shiftKey === !!chord.shift
}

/** The app command a key chord means, or undefined when it is not one of ours (the terminal keeps the key). */
export function shortcutOf(ev: KeyLike): AppShortcut | undefined {
  if (ev.metaKey) return undefined
  return SHORTCUTS.find(s => matches(s.chord, ev))?.command
}

/**
 * What a clipboard chord does inside a pane:
 *   copy        copy the selection to the clipboard and clear it; nothing is sent to the process
 *   paste       paste the clipboard text (xterm's paste: bracketed paste honoured); with no text, nothing
 *   paste-or-raw paste the clipboard text; with no text, send the raw key (^V) so Claude Code reads the
 *               image from the clipboard itself (its image paste is triggered by the ^V it receives)
 */
export type PaneCommand = 'copy' | 'paste' | 'paste-or-raw'

export interface PaneShortcutEntry {
  chord: Chord
  command: PaneCommand
  /** Only with a selection; without one the chord is the terminal's (Ctrl+C = ^C). */
  needsSelection?: boolean
}

export const PANE_SHORTCUTS: readonly PaneShortcutEntry[] = [
  { chord: { ctrl: true, code: 'KeyC' }, command: 'copy', needsSelection: true },
  { chord: { ctrl: true, shift: true, code: 'KeyC' }, command: 'copy' },
  { chord: { ctrl: true, code: 'KeyV' }, command: 'paste-or-raw' },
  { chord: { ctrl: true, shift: true, code: 'KeyV' }, command: 'paste' },
]

/**
 * The pane command a keydown means given whether the terminal has a selection, or undefined when the key is
 * the terminal's. Decided on keydown only: keypress/keyup of the same chord are never a command.
 */
export function paneShortcutOf(ev: KeyLike & { type?: string }, hasSelection: boolean): PaneCommand | undefined {
  if (ev.type !== undefined && ev.type !== 'keydown') return undefined
  if (ev.metaKey || ev.altKey) return undefined
  const entry = PANE_SHORTCUTS.find(s => matches(s.chord, ev))
  if (!entry) return undefined
  if (entry.needsSelection && !hasSelection) return undefined
  return entry.command
}

/** The hint for a pane command (its first chord), or '' when it has none. */
export function paneShortcutHint(command: PaneCommand): string {
  const entry = PANE_SHORTCUTS.find(s => s.command === command)
  return entry ? chordLabel(entry.chord) : ''
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
  if (a.op === 'desk-cycle' && b.op === 'desk-cycle') return a.step === b.step
  if (a.op === 'desk-go' && b.op === 'desk-go') return a.position === b.position
  if (a.op === 'desk-new' && b.op === 'desk-new') return a.side === b.side
  return true
}

/** The hint for a command (its first chord in the registry), or '' when it has none. */
export function shortcutHint(command: AppShortcut): string {
  const entry = SHORTCUTS.find(s => sameCommand(s.command, command))
  return entry ? chordLabel(entry.chord) : ''
}
