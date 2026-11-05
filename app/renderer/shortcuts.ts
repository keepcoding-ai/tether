// The keyboard registry: every chord in one table, so a shortcut is changed in exactly one place and the hints
// (menus, tooltips, the watermark) follow, on every platform. Entries are written with a neutral `mod` (Ctrl on
// Windows/Linux, Cmd on macOS, as VS Code does); an entry may carry a `mac` override for a genuine difference
// (`mac: null` = no chord on the Mac; `chord: null` = Mac only). On macOS app chords prefer Cmd and leave Ctrl to
// the terminal (Ctrl+C = SIGINT, Ctrl+V = Claude Code's image paste); Cmd+Tab and Cmd+` belong to the OS, so the
// desk cycle and the drawer keep a literal Ctrl there. Off the Mac a chord never includes Meta (Win): the OS owns
// most Win chords. Ctrl+Alt+letter is avoided on purpose: on an ABNT2 keyboard it is AltGr.
//
// Windows/Linux chords:
//   level pane   Ctrl+Alt+Arrow         duplicate beside the focused pane (Ctrl+Shift+D / E: right / below aliases)
//   level frame  Ctrl+Alt+Shift+Arrow   duplicate at the frame's edge (full height or width of the frame)
//   level desk   Alt+Shift+Arrow        duplicate into a new frame at the desk's edge
//   split empty  Ctrl+Shift+Arrow       an empty pane (chooser inside it) beside the focused pane. "Duplicate + Shift"
//                was the wish, but the pane level's +Shift is already the frame level; Ctrl+Shift+Arrow is the free
//                arrow chord of the app's own Ctrl+Shift family (xterm has no use for it; PSReadLine's
//                Ctrl+Shift+←/→ word selection is what it costs). The frame and desk levels of the empty pane
//                have no chord: the palette, the chooser's "Vazio" and the "+" at the edges reach them.
//   desks        Ctrl+Tab / Ctrl+Shift+Tab next / previous desk (sequential, wraps) · Ctrl+1…9 desk by position
//                Ctrl+Alt+N new desk after the current one · Ctrl+Alt+Shift+N before it
//   Ctrl+Shift+T new empty tab in the active group (the chooser inside it) · Ctrl+Shift+Q quit all · Ctrl+Shift+H show/hide the active pane's header details
//   Ctrl+Shift+P command palette · Ctrl+P quick open (commands.ts / palette.ts; key-capture.ts says why the
//                terminal does not get Ctrl+P)
//   drawer       Ctrl+` toggles it (VS Code's terminal chord); Ctrl+Shift+G is the alias for keyboards where `
//                is a dead key (ABNT2 sends the grave accent from another key; its physical Backquote key is ')
//   font size    Ctrl+Shift+= / - / 0 (numpad too)
// Mac differences: Cmd+T new tab, Cmd+D / Cmd+E duplicate right / below, Cmd+= / - / 0 font size, Cmd+C / Cmd+V
// copy / paste, Ctrl+Tab and Ctrl+` kept literal; the other mod chords are Cmd ones (Cmd+Alt+Arrow, Cmd+1…9…).
//
// Ctrl+` vs the terminal: xterm maps it to NUL (the same byte as Ctrl+Space / Ctrl+2), which nobody types on purpose.
//
// Desk chords vs the terminal: xterm sends nothing for Ctrl+Tab; Ctrl+1…9 have legacy control codes in xterm
// (Ctrl+2 NUL, Ctrl+3…7 ESC…US, Ctrl+8 DEL) that nobody types on purpose (Esc, Backspace exist); on ABNT2
// AltGr+N (= Ctrl+Alt+N) produces no character, so the chord takes nothing from typing.
//
// Pane chords (PANE_SHORTCUTS) live inside the terminal and never reach the document: Ctrl+C copies the
// selection when there is one (without one it stays the terminal's ^C, which interrupts Claude, dev servers
// and shells), Ctrl+Shift+C always copies, Ctrl+V / Ctrl+Shift+V paste.
//
// Terminal input chords (TERMINAL_INPUTS) turn a key into bytes for the prompt: on macOS the line-editing keys of a
// Mac text field (Cmd/Option + arrows and Backspace, mapped explicitly instead of xterm's macOptionIsMeta so Option
// keeps composing accents); everywhere, Shift+Enter = ESC CR, Claude Code's "new line without submitting" (off the
// Mac only in agent panes: a shell such as PowerShell has no meaning for ESC CR, and xterm's plain CR stays).
import type { FontSizeCommand } from '../shared/font.ts'
import type { Direction } from './create.ts'

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(
  (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform,
)

/** Where a new pane is born relative to the focus: beside the pane, at the frame's edge, or in a new frame at the desk's edge. */
export type Level = 'pane' | 'frame' | 'desk'
export const LEVELS: readonly Level[] = ['pane', 'frame', 'desk']

export type AppShortcut =
  | { op: 'new-tab' }
  | { op: 'duplicate'; level: Level; direction: Direction }
  | { op: 'split-empty'; direction: Direction }
  | { op: 'quit-all' }
  | { op: 'desk-cycle'; step: 1 | -1 }
  | { op: 'desk-go'; position: number }
  | { op: 'desk-new'; side: 'before' | 'after' }
  | { op: 'drawer-toggle' }
  | { op: 'pane-details' }
  | { op: 'font-size'; command: FontSizeCommand }
  | { op: 'palette' }
  | { op: 'quick-open' }

/** The subset of KeyboardEvent the mapping needs (tests build it by hand). */
export interface KeyLike { ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean; code: string }

/**
 * A chord as modifiers + `KeyboardEvent.code` (layout-independent: KeyT is the physical T). `mod` is the platform's
 * app modifier (Ctrl / Cmd); `ctrl` and `meta` are literal (Ctrl on the Mac too; Cmd or Win).
 */
export interface Chord { mod?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean; code: string }

/** An entry's chord off the Mac (`chord`) and its Mac override (`mac`; undefined = the same chord). */
export interface Platformed { chord: Chord | null; mac?: Chord | null }
export interface ShortcutEntry extends Platformed { command: AppShortcut }

/** The concrete chord of an entry on a platform (`mod` resolved to ctrl or meta), or null when it has none there. */
export function chordOn(entry: Platformed, mac = IS_MAC): Chord | null {
  const c = mac && entry.mac !== undefined ? entry.mac : entry.chord
  if (!c) return null
  const { mod, ...rest } = c
  if (!mod) return rest
  return mac ? { ...rest, meta: true } : { ...rest, ctrl: true }
}

const ARROW_CODE: Record<Direction, string> = { left: 'ArrowLeft', right: 'ArrowRight', above: 'ArrowUp', below: 'ArrowDown' }
const DIRECTIONS: readonly Direction[] = ['left', 'right', 'above', 'below']

/** The four arrow chords of a level, sharing the modifiers. */
function arrows(mods: Omit<Chord, 'code'>, level: Level): ShortcutEntry[] {
  return DIRECTIONS.map(direction => ({ chord: { ...mods, code: ARROW_CODE[direction] }, command: { op: 'duplicate', level, direction } }))
}

/** Font size: Ctrl+Shift+key off the Mac (Ctrl+= / Ctrl+- are the terminal's), Cmd+key with or without Shift on the Mac. */
function fontSize(codes: string[], command: FontSizeCommand): ShortcutEntry[] {
  return codes.flatMap((code): ShortcutEntry[] => [
    { chord: { ctrl: true, shift: true, code }, mac: { meta: true, code }, command: { op: 'font-size', command } },
    { chord: null, mac: { meta: true, shift: true, code }, command: { op: 'font-size', command } },
  ])
}

/** The registry. Order matters only for `shortcutHint`: the first entry of a command on the platform is the one shown. */
export const SHORTCUTS: readonly ShortcutEntry[] = [
  { chord: { mod: true, shift: true, code: 'KeyT' }, mac: { meta: true, code: 'KeyT' }, command: { op: 'new-tab' } },
  ...arrows({ mod: true, alt: true }, 'pane'),
  { chord: { mod: true, shift: true, code: 'KeyD' }, mac: { meta: true, code: 'KeyD' }, command: { op: 'duplicate', level: 'pane', direction: 'right' } },
  { chord: { mod: true, shift: true, code: 'KeyE' }, mac: { meta: true, code: 'KeyE' }, command: { op: 'duplicate', level: 'pane', direction: 'below' } },
  ...arrows({ mod: true, alt: true, shift: true }, 'frame'),
  ...arrows({ alt: true, shift: true }, 'desk'),
  ...DIRECTIONS.map((direction): ShortcutEntry => ({ chord: { mod: true, shift: true, code: ARROW_CODE[direction] }, command: { op: 'split-empty', direction } })),
  { chord: { mod: true, shift: true, code: 'KeyQ' }, command: { op: 'quit-all' } },
  // Cmd+Tab is the Mac's app switcher: the desk cycle keeps a literal Ctrl everywhere.
  { chord: { ctrl: true, code: 'Tab' }, command: { op: 'desk-cycle', step: 1 } },
  { chord: { ctrl: true, shift: true, code: 'Tab' }, command: { op: 'desk-cycle', step: -1 } },
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((position): ShortcutEntry => ({ chord: { mod: true, code: `Digit${position}` }, command: { op: 'desk-go', position } })),
  { chord: { mod: true, alt: true, code: 'KeyN' }, command: { op: 'desk-new', side: 'after' } },
  { chord: { mod: true, alt: true, shift: true, code: 'KeyN' }, command: { op: 'desk-new', side: 'before' } },
  // Cmd+` cycles an app's windows on the Mac: the drawer keeps a literal Ctrl everywhere.
  { chord: { ctrl: true, code: 'Backquote' }, command: { op: 'drawer-toggle' } },
  { chord: { mod: true, shift: true, code: 'KeyG' }, command: { op: 'drawer-toggle' } },
  // Ctrl+Shift+I is Chromium's DevTools chord (the hidden View menu keeps it); H is for "header".
  { chord: { mod: true, shift: true, code: 'KeyH' }, command: { op: 'pane-details' } },
  // The palette and quick open, VS Code's chords. Ctrl+P is a plain Ctrl+letter, the terminal's territory: the
  // app takes it anyway, by the explicit list in key-capture.ts (TERMINAL_CAPTURE).
  { chord: { mod: true, shift: true, code: 'KeyP' }, command: { op: 'palette' } },
  { chord: { mod: true, code: 'KeyP' }, command: { op: 'quick-open' } },
  ...fontSize(['Equal', 'NumpadAdd'], 'increase'),
  ...fontSize(['Minus', 'NumpadSubtract'], 'decrease'),
  ...fontSize(['Digit0', 'Numpad0'], 'reset'),
]

function matches(chord: Chord, ev: KeyLike): boolean {
  return ev.code === chord.code && ev.ctrlKey === !!chord.ctrl && ev.altKey === !!chord.alt
    && ev.shiftKey === !!chord.shift && ev.metaKey === !!chord.meta
}

function find<T extends Platformed>(table: readonly T[], ev: KeyLike, mac: boolean): T | undefined {
  return table.find(e => { const c = chordOn(e, mac); return c !== null && matches(c, ev) })
}

/** The app command a key chord means, or undefined when it is not one of ours (the terminal keeps the key). */
export function shortcutOf(ev: KeyLike, mac = IS_MAC): AppShortcut | undefined {
  return find(SHORTCUTS, ev, mac)?.command
}

/**
 * What a clipboard chord does inside a pane:
 *   copy        copy the selection to the clipboard and clear it; nothing is sent to the process
 *   paste       paste the clipboard text (xterm's paste: bracketed paste honoured); with no text, nothing
 *   paste-or-raw paste the clipboard text; with no text, send the raw key (^V) so Claude Code reads the
 *               image from the clipboard itself (its image paste is triggered by the ^V it receives)
 */
export type PaneCommand = 'copy' | 'paste' | 'paste-or-raw'

export interface PaneShortcutEntry extends Platformed {
  command: PaneCommand
  /** Only with a selection; without one the chord is the terminal's (Ctrl+C = ^C). */
  needsSelection?: boolean
}

// On the Mac, Cmd+C / Cmd+V never collide with the terminal: Cmd+C needs no selection (it copies what there is) and
// Ctrl+V (Claude Code's image paste) reaches the terminal untouched.
export const PANE_SHORTCUTS: readonly PaneShortcutEntry[] = [
  { chord: { ctrl: true, code: 'KeyC' }, mac: null, command: 'copy', needsSelection: true },
  { chord: null, mac: { meta: true, code: 'KeyC' }, command: 'copy' },
  { chord: { mod: true, shift: true, code: 'KeyC' }, command: 'copy' },
  { chord: { ctrl: true, code: 'KeyV' }, mac: null, command: 'paste-or-raw' },
  { chord: null, mac: { meta: true, code: 'KeyV' }, command: 'paste' },
  { chord: { mod: true, shift: true, code: 'KeyV' }, command: 'paste' },
]

/**
 * The pane command a keydown means given whether the terminal has a selection, or undefined when the key is
 * the terminal's. Decided on keydown only: keypress/keyup of the same chord are never a command.
 */
export function paneShortcutOf(ev: KeyLike & { type?: string }, hasSelection: boolean, mac = IS_MAC): PaneCommand | undefined {
  if (ev.type !== undefined && ev.type !== 'keydown') return undefined
  const entry = find(PANE_SHORTCUTS, ev, mac)
  if (!entry) return undefined
  if (entry.needsSelection && !hasSelection) return undefined
  return entry.command
}

/** The hint for a pane command (its first chord on the platform), or '' when it has none. */
export function paneShortcutHint(command: PaneCommand, mac = IS_MAC): string {
  for (const e of PANE_SHORTCUTS) {
    const c = e.command === command ? chordOn(e, mac) : null
    if (c) return chordLabel(c, mac)
  }
  return ''
}

/** Bytes a key sends to the prompt instead of its usual input (see the header). */
export interface TerminalInputEntry extends Platformed {
  sequence: string
  /** Only in agent panes (Claude Code, soul), never in a shell pane. */
  agentsOnly?: boolean
}

export const TERMINAL_INPUTS: readonly TerminalInputEntry[] = [
  { chord: { shift: true, code: 'Enter' }, mac: null, sequence: '\x1b\r', agentsOnly: true },
  { chord: null, mac: { shift: true, code: 'Enter' }, sequence: '\x1b\r' },
  { chord: null, mac: { meta: true, code: 'ArrowLeft' }, sequence: '\x01' }, // Ctrl+A: start of line
  { chord: null, mac: { meta: true, code: 'ArrowRight' }, sequence: '\x05' }, // Ctrl+E: end of line
  { chord: null, mac: { meta: true, code: 'Backspace' }, sequence: '\x15' }, // Ctrl+U: delete to start of line
  { chord: null, mac: { alt: true, code: 'ArrowLeft' }, sequence: '\x1bb' }, // Meta+b: previous word
  { chord: null, mac: { alt: true, code: 'ArrowRight' }, sequence: '\x1bf' }, // Meta+f: next word
  { chord: null, mac: { alt: true, code: 'Backspace' }, sequence: '\x17' }, // Ctrl+W: delete word
]

/** The bytes for this keydown in a pane (`agent`: not a shell pane), or undefined when the key is not one of these. */
export function terminalInputOf(ev: KeyLike, agent: boolean, mac = IS_MAC): string | undefined {
  return find(TERMINAL_INPUTS.filter(e => agent || !e.agentsOnly), ev, mac)?.sequence
}

const CODE_GLYPH: Record<string, string> = {
  ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Backquote: '`', Equal: '=', Minus: '-',
  NumpadAdd: 'Num+', NumpadSubtract: 'Num-', Numpad0: 'Num0', Backspace: '⌫',
}

/** What the user reads for a chord: "Ctrl+Alt+Shift+→", "Ctrl+Shift+T"; on the Mac "⌃⌥⇧⌘T". */
export function chordLabel(chord: Chord, mac = IS_MAC): string {
  const c = chordOn({ chord }, mac)!
  const key = CODE_GLYPH[c.code] ?? c.code.replace(/^Key|^Digit/, '')
  if (mac) return `${c.ctrl ? '⌃' : ''}${c.alt ? '⌥' : ''}${c.shift ? '⇧' : ''}${c.meta ? '⌘' : ''}${key}`
  const parts: string[] = []
  if (c.ctrl) parts.push('Ctrl')
  if (c.alt) parts.push('Alt')
  if (c.shift) parts.push('Shift')
  if (c.meta) parts.push('Win')
  parts.push(key)
  return parts.join('+')
}

/** Two shortcut ops that mean the same command (payload included). */
export function sameShortcut(a: AppShortcut, b: AppShortcut): boolean {
  if (a.op !== b.op) return false
  if (a.op === 'duplicate' && b.op === 'duplicate') return a.level === b.level && a.direction === b.direction
  if (a.op === 'split-empty' && b.op === 'split-empty') return a.direction === b.direction
  if (a.op === 'desk-cycle' && b.op === 'desk-cycle') return a.step === b.step
  if (a.op === 'desk-go' && b.op === 'desk-go') return a.position === b.position
  if (a.op === 'desk-new' && b.op === 'desk-new') return a.side === b.side
  if (a.op === 'font-size' && b.op === 'font-size') return a.command === b.command
  return true
}

/** The hint for a command (its first chord in the registry on the platform), or '' when it has none. */
export function shortcutHint(command: AppShortcut, mac = IS_MAC): string {
  for (const e of SHORTCUTS) {
    const c = sameShortcut(e.command, command) ? chordOn(e, mac) : null
    if (c) return chordLabel(c, mac)
  }
  return ''
}
