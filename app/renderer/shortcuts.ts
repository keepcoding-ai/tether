// The keyboard table: every chord of the app in one place, keyed by COMMAND ID (the registry's ids, the same the
// palette, the CLI and ~/keybindings.json name), so a key is changed in exactly one place and the hints (menus,
// tooltips, the palette) follow. A binding is a SEQUENCE of one or two keys (`keys: Chord[]`; "Ctrl+K Ctrl+S" is two,
// VS Code's chords) and says WHERE it is the app's (`where`): in the window (no terminal, no editor in focus), inside
// a terminal, inside a note's editor. The scheme is VS Code's for Windows, translated: editor tab = pane, editor
// group = frame, window = desk, terminal panel = drawer (docs/keybindings-preview.html, section A).
//
// Who keeps a key, by default (`defaultWhere`): a plain Ctrl+letter (no Shift, no Alt) is the terminal's (^A…^Z are
// line editing, ^C interrupts, TUIs such as Claude Code bind them), so it is the app's only in the window and in
// the note, except the letters in TERMINAL_CAPTURE (key-capture.ts: P, N, K, VS Code's "commands to skip shell" in
// miniature). Every other chord (Ctrl+Shift+…, Alt+…, F-keys, arrows with modifiers, Ctrl+symbol) is the app's
// everywhere: xterm sends the same control byte as the plain chord, or nothing, for those.
//
// Platform: the defaults are written with `ctrl`; on macOS it means Cmd (VS Code does the same) unless the entry
// is `literal` (Ctrl+Tab and Ctrl+` keep a literal Ctrl: Cmd+Tab and Cmd+` are the OS's). A chord never includes
// Meta (Win) off the Mac: the OS owns most Win chords. Ctrl+Alt+letter is avoided on purpose: on an ABNT2
// keyboard it is AltGr. `\` matches both Backslash (US) and IntlBackslash (ABNT2).
//
// The user's file (~/keybindings.json, app/renderer/keybindings-rules.ts) adds and removes bindings over these
// defaults; `setKeyTable` swaps the active table and everything that asks `keyTable()` / `shortcutHint` follows.
//
// Pane chords (PANE_SHORTCUTS) live inside the terminal and never reach the document: Ctrl+C copies the selection
// when there is one (without one it stays the terminal's ^C), Ctrl+Shift+C always copies, Ctrl+V / Ctrl+Shift+V
// paste. Terminal input chords (TERMINAL_INPUTS) turn a key into bytes for the prompt (Shift+Enter = ESC CR, Claude
// Code's "new line without submitting"; on macOS the line-editing keys of a Mac text field).
import type { KeybindingContribution } from '../../extensions/types.ts'
export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(
  (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform,
)

/** Where a new pane is born relative to the focus: beside the pane, at the frame's edge, or in a new frame at the desk's edge. */
export type Level = 'pane' | 'frame' | 'desk'
export const LEVELS: readonly Level[] = ['pane', 'frame', 'desk']

/** Where a binding is the app's: the window (nothing special in focus), inside a terminal, inside a note's editor. */
export type Where = 'window' | 'terminal' | 'note'
export const WHERE_ALL: readonly Where[] = ['window', 'terminal', 'note']
export const WHERE_LABEL: Record<Where, string> = { window: 'Janela', terminal: 'Terminal', note: 'Nota' }

/** The subset of KeyboardEvent the mapping needs (tests build it by hand). */
export interface KeyLike { ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean; code: string }

/**
 * One key as modifiers + `KeyboardEvent.code` (layout-independent: KeyT is the physical T). `mod` is the platform's
 * app modifier (Ctrl / Cmd), resolved by `concrete`; `ctrl` and `meta` are literal (Ctrl on the Mac too; Cmd or Win).
 */
export interface Chord { mod?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean; code: string }

/** The pseudo-command of the row "Ctrl+K (prefix)": its `where` says in which scopes the two-key chords open at all. */
export const PREFIX_COMMAND = 'chord.prefix'

/** Plain Ctrl+letter chords the app takes from a terminal by default (key-capture.ts documents each). */
export const TERMINAL_CAPTURE_CODES: readonly string[] = ['KeyP', 'KeyN', 'KeyK']

/** A chord that is Ctrl + a letter and nothing else (the terminal's territory). */
export function isPlainCtrlLetterChord(c: Chord): boolean {
  return !!c.ctrl && !c.shift && !c.alt && !c.meta && /^Key[A-Z]$/.test(c.code)
}

/** Where a binding is the app's when nobody said: a plain Ctrl+letter outside the capture list spares the terminal; everything else is everywhere. */
export function defaultWhere(first: Chord): Where[] {
  return isPlainCtrlLetterChord(first) && !TERMINAL_CAPTURE_CODES.includes(first.code) ? ['window', 'note'] : [...WHERE_ALL]
}

// ---------- key strings: "ctrl+shift+t", "ctrl+k ctrl+s", "ctrl+\" ----------

const NAME_TO_CODE: Record<string, string> = {
  left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown',
  pageup: 'PageUp', pgup: 'PageUp', pagedown: 'PageDown', pgdn: 'PageDown',
  tab: 'Tab', enter: 'Enter', space: 'Space', escape: 'Escape', esc: 'Escape', backspace: 'Backspace', delete: 'Delete', del: 'Delete',
  home: 'Home', end: 'End', insert: 'Insert',
  '`': 'Backquote', '\\': 'Backslash', intlbackslash: 'Backslash', '=': 'Equal', '-': 'Minus', ',': 'Comma', '.': 'Period', '/': 'Slash',
  ';': 'Semicolon', '\'': 'Quote', '[': 'BracketLeft', ']': 'BracketRight',
  numpad_add: 'NumpadAdd', 'numpad+': 'NumpadAdd', numpadadd: 'NumpadAdd',
  numpad_subtract: 'NumpadSubtract', 'numpad-': 'NumpadSubtract', numpadsubtract: 'NumpadSubtract',
  numpad_multiply: 'NumpadMultiply', numpad_divide: 'NumpadDivide', numpad_decimal: 'NumpadDecimal',
}
const CODE_TO_NAME: Record<string, string> = {
  ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', PageUp: 'pgup', PageDown: 'pgdn',
  Tab: 'tab', Enter: 'enter', Space: 'space', Escape: 'escape', Backspace: 'backspace', Delete: 'delete', Home: 'home', End: 'end', Insert: 'insert',
  Backquote: '`', Backslash: '\\', IntlBackslash: '\\', Equal: '=', Minus: '-', Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: '\'', BracketLeft: '[', BracketRight: ']',
  NumpadAdd: 'numpad_add', NumpadSubtract: 'numpad_subtract', NumpadMultiply: 'numpad_multiply', NumpadDivide: 'numpad_divide', NumpadDecimal: 'numpad_decimal',
}

/** The code for a key name of the file format ("t", "7", "f2", "pgdn", "\\"), or undefined when it has none. */
export function codeOfKeyName(name: string): string | undefined {
  const n = name.toLowerCase()
  if (/^[a-z]$/.test(n)) return `Key${n.toUpperCase()}`
  if (/^[0-9]$/.test(n)) return `Digit${n}`
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(n)) return n.toUpperCase()
  if (/^numpad[0-9]$/.test(n)) return `Numpad${n.slice(6)}`
  return NAME_TO_CODE[n]
}

/** The file-format name of a code ("KeyT" → "t", "ArrowDown" → "down"), or undefined for a code the format has no name for. */
export function keyNameOfCode(code: string): string | undefined {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase()
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code.toLowerCase()
  if (/^Numpad[0-9]$/.test(code)) return `numpad${code.slice(6)}`
  return CODE_TO_NAME[code]
}

/** One key of the format ("ctrl+shift+t"): modifiers in any order, the key last. Undefined when unreadable. */
export function parseKey(text: string): Chord | undefined {
  const parts = text.trim().toLowerCase().split('+')
  // A trailing "+" means the key itself was "+": not a key of this format (Equal is "=").
  const name = parts.pop()
  if (name === undefined || name === '') return undefined
  const chord: Chord = { code: '' }
  for (const p of parts) {
    if (p === 'ctrl' || p === 'control') chord.ctrl = true
    else if (p === 'shift') chord.shift = true
    else if (p === 'alt' || p === 'option') chord.alt = true
    else if (p === 'cmd' || p === 'meta' || p === 'win' || p === 'super') chord.meta = true
    else if (p === 'mod') chord.mod = true
    else return undefined
  }
  const code = codeOfKeyName(name)
  if (!code) return undefined
  chord.code = code
  return chord
}

/** A key sequence of the format ("ctrl+k ctrl+s"): one or two keys separated by spaces. Undefined when any key is unreadable. */
export function parseKeys(text: string): Chord[] | undefined {
  const parts = text.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0 || parts.length > 2) return undefined
  const out: Chord[] = []
  for (const p of parts) { const c = parseKey(p); if (!c) return undefined; out.push(c) }
  return out
}

/** The format's text for a key ("ctrl+shift+t"); `mod` is written as such. */
export function formatKey(c: Chord): string {
  const parts: string[] = []
  if (c.mod) parts.push('mod')
  if (c.ctrl) parts.push('ctrl')
  if (c.shift) parts.push('shift')
  if (c.alt) parts.push('alt')
  if (c.meta) parts.push('cmd')
  parts.push(keyNameOfCode(c.code) ?? c.code.toLowerCase())
  return parts.join('+')
}

export function formatKeys(keys: readonly Chord[]): string {
  return keys.map(formatKey).join(' ')
}

// ---------- the concrete chord of a platform ----------

/** The chord with `mod` resolved to the platform's modifier (Ctrl, or Cmd on the Mac). */
export function concrete(c: Chord, mac = IS_MAC): Chord {
  const { mod, ...rest } = c
  if (!mod) return rest
  return mac ? { ...rest, meta: true } : { ...rest, ctrl: true }
}

/** `\` is one key to the person: the US Backslash and the ABNT2 IntlBackslash are read as the same code. */
function normCode(code: string): string {
  return code === 'IntlBackslash' ? 'Backslash' : code
}

/** The chord `c` (concrete) is the key pressed. */
export function matches(c: Chord, ev: KeyLike): boolean {
  return normCode(ev.code) === normCode(c.code) && ev.ctrlKey === !!c.ctrl && ev.altKey === !!c.alt
    && ev.shiftKey === !!c.shift && ev.metaKey === !!c.meta
}

/** Two concrete chords are the same key. */
export function sameChord(a: Chord, b: Chord): boolean {
  return normCode(a.code) === normCode(b.code) && !!a.ctrl === !!b.ctrl && !!a.alt === !!b.alt && !!a.shift === !!b.shift && !!a.meta === !!b.meta
}

export function sameKeys(a: readonly Chord[], b: readonly Chord[]): boolean {
  return a.length === b.length && a.every((c, i) => sameChord(c, b[i]!))
}

/** A keydown as a concrete chord. */
export function chordOfEvent(ev: KeyLike): Chord {
  const c: Chord = { code: normCode(ev.code) }
  if (ev.ctrlKey) c.ctrl = true
  if (ev.altKey) c.alt = true
  if (ev.shiftKey) c.shift = true
  if (ev.metaKey) c.meta = true
  return c
}

/** A keydown that is only a modifier going down (Control, Shift…): never a key of a chord. */
export function isModifierOnly(code: string): boolean {
  return /^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/.test(code) || code === ''
}

// ---------- the table ----------

export interface Keybinding {
  /** Concrete keys (no `mod`), one or two. */
  keys: Chord[]
  /** The command id, or PREFIX_COMMAND for the prefix row. */
  command: string
  where: Where[]
  source: 'default' | 'user'
}

/** A default entry: the key text of the format (`ctrl` = the app modifier), the command, an explicit `where`, and `literal` for a Ctrl that stays Ctrl on the Mac. */
export interface DefaultEntry { key: string; command: string; where?: Where[]; literal?: boolean }

// The Windows scheme of VS Code, translated (docs/keybindings-preview.html, the RECOMMENDED option of every
// decision). Order matters only for hints: the first binding of a command is the one shown.
export const DEFAULT_KEYBINDINGS: readonly DefaultEntry[] = [
  // ----- panes (tabs) -----
  { key: 'ctrl+n', command: 'pane.new-tab' },                       // VS Code "new untitled file" (the chooser inside; captured in the terminal: the shell's ^N is ↓)
  { key: 'ctrl+k ctrl+o', command: 'pane.new' },                    // "open folder"
  { key: 'ctrl+shift+t', command: 'pane.reopen-closed' },           // "reopen closed editor": the slot resumes
  { key: 'ctrl+alt+right', command: 'pane.duplicate.pane.right' },
  { key: 'ctrl+\\', command: 'pane.duplicate.pane.right' },         // "split editor" (SIGQUIT in a terminal, which nobody types on purpose)
  { key: 'ctrl+alt+left', command: 'pane.duplicate.pane.left' },
  { key: 'ctrl+alt+up', command: 'pane.duplicate.pane.above' },
  { key: 'ctrl+alt+down', command: 'pane.duplicate.pane.below' },
  { key: 'ctrl+k ctrl+\\', command: 'pane.duplicate.pane.below' },  // "split editor down"
  { key: 'ctrl+shift+alt+right', command: 'pane.duplicate.frame.right' },
  { key: 'ctrl+shift+alt+left', command: 'pane.duplicate.frame.left' },
  { key: 'ctrl+shift+alt+up', command: 'pane.duplicate.frame.above' },
  { key: 'ctrl+shift+alt+down', command: 'pane.duplicate.frame.below' },
  { key: 'shift+alt+right', command: 'pane.duplicate.desk.right' },
  { key: 'shift+alt+left', command: 'pane.duplicate.desk.left' },
  { key: 'shift+alt+up', command: 'pane.duplicate.desk.above' },
  { key: 'shift+alt+down', command: 'pane.duplicate.desk.below' },
  { key: 'ctrl+shift+right', command: 'pane.split-empty.pane.right' },
  { key: 'ctrl+shift+left', command: 'pane.split-empty.pane.left' },
  { key: 'ctrl+shift+up', command: 'pane.split-empty.pane.above' },
  { key: 'ctrl+shift+down', command: 'pane.split-empty.pane.below' },
  { key: 'ctrl+pgdn', command: 'pane.next-tab' },                   // "next editor in group"
  { key: 'ctrl+pgup', command: 'pane.previous-tab' },
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n): DefaultEntry => ({ key: `alt+${n}`, command: `pane.go.${n}` })), // "open editor N" (top row; the numpad is Windows' Alt+code)
  { key: 'alt+0', command: 'pane.last' },
  { key: 'f2', command: 'pane.rename' },                            // "rename" (everywhere: PSReadLine's F2 is the rarely used prediction view toggle)
  { key: 'ctrl+shift+h', command: 'pane.details' },
  { key: 'ctrl+k p', command: 'pane.copy-folder' },                 // "copy path of active file"
  { key: 'ctrl+k r', command: 'pane.open-folder' },                 // "reveal in explorer"
  { key: 'ctrl+f4', command: 'pane.close' },                        // "close editor", everywhere
  { key: 'ctrl+w', command: 'pane.close', where: ['window', 'note'] }, // in a terminal Ctrl+W erases the previous word (bash, PSReadLine, Claude Code): it passes
  // ----- frames (groups) -----
  { key: 'ctrl+k ctrl+right', command: 'frame.focus.right' },       // "focus group right/left/above/below": the neighbouring pane
  { key: 'ctrl+k ctrl+left', command: 'frame.focus.left' },
  { key: 'ctrl+k ctrl+up', command: 'frame.focus.above' },
  { key: 'ctrl+k ctrl+down', command: 'frame.focus.below' },
  { key: 'ctrl+k w', command: 'frame.close-tabs' },                 // "close all editors in group"
  // ----- desks (windows) -----
  { key: 'ctrl+shift+n', command: 'desk.new' },                     // "new window"
  { key: 'ctrl+tab', command: 'desk.next', literal: true },         // the desk strip is the app's first-level tab bar (browsers, Windows Terminal)
  { key: 'ctrl+shift+tab', command: 'desk.previous', literal: true },
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n): DefaultEntry => ({ key: `ctrl+${n}`, command: `desk.go.${n}` })),
  { key: 'ctrl+k f', command: 'desk.close' },                       // "close folder/workspace"
  { key: 'ctrl+k shift+left', command: 'desk.move-left' },          // move the active desk in the queue (ctrl+k ctrl+arrows is pane focus, shift+alt+arrows is duplicate)
  { key: 'ctrl+k shift+right', command: 'desk.move-right' },
  { key: 'ctrl+k m', command: 'desk.builder' },                     // "Montar a mesa": the builder mode (no VS Code twin; M of montar)
  // ----- drawer (the terminal panel) -----
  { key: 'ctrl+`', command: 'drawer.toggle', literal: true },       // "toggle terminal"
  { key: 'ctrl+shift+g', command: 'drawer.toggle' },                // alias for keyboards where ` is a dead key (ABNT2)
  { key: 'ctrl+shift+`', command: 'drawer.quick-terminal' },        // "new terminal"
  // side bars (F10): VS Code's "toggle primary / secondary side bar". Ctrl+B is a plain Ctrl+letter, so it spares the
  // terminal (^B: Claude Code's "run in background", readline's back-char); Ctrl+K Ctrl+B is its terminal-safe twin.
  // Ctrl+Alt+B goes against the "no Ctrl+Alt+letter" rule above on purpose: it is VS Code's key, and AltGr+B types
  // nothing on ABNT2 or US-International.
  { key: 'ctrl+b', command: 'sidebar.left.toggle' },
  { key: 'ctrl+k ctrl+b', command: 'sidebar.left.toggle' },
  { key: 'ctrl+alt+b', command: 'sidebar.right.toggle' },
  // (the notes' defaults come from the note extension's manifest: extensions/note/manifest.ts)
  // ----- look -----
  { key: 'ctrl+k ctrl+t', command: 'theme.pick' },                  // "color theme": the palette filtered on "Tema"
  { key: 'ctrl+=', command: 'font.increase' },                      // "zoom in" (VS Code and Windows Terminal take Ctrl+= / Ctrl+- from the shell too)
  { key: 'ctrl+numpad_add', command: 'font.increase' },
  { key: 'ctrl+shift+=', command: 'font.increase' },
  { key: 'ctrl+shift+numpad_add', command: 'font.increase' },
  { key: 'ctrl+-', command: 'font.decrease' },
  { key: 'ctrl+numpad_subtract', command: 'font.decrease' },
  { key: 'ctrl+shift+-', command: 'font.decrease' },
  { key: 'ctrl+shift+numpad_subtract', command: 'font.decrease' },
  { key: 'ctrl+0', command: 'font.reset' },
  { key: 'ctrl+numpad0', command: 'font.reset' },
  { key: 'ctrl+shift+0', command: 'font.reset' },
  { key: 'ctrl+shift+numpad0', command: 'font.reset' },
  // ----- app -----
  { key: 'ctrl+shift+p', command: 'palette.show' },
  { key: 'ctrl+k', command: PREFIX_COMMAND },                       // the prefix itself: its `where` says where two-key chords open (Terminal off = ^K passes)
  { key: 'ctrl+shift+q', command: 'app.quit-all' },
]

/**
 * The defaults extensions contribute (their manifest's `contributes.keybindings`, VS Code's KeybindingsRegistry fed by
 * package.json): after the core's, in activation order. Contributing happens at startup, before the person's file is
 * merged (mergeKeybindings reads resolvedDefaults), so the table in force is rebuilt from the defaults here.
 */
const contributedKeybindings: (readonly DefaultEntry[])[] = []

/** A manifest's `contributes.keybindings` as entries of the table. */
export function keybindingEntries(list: readonly KeybindingContribution[]): DefaultEntry[] {
  return list.map(k => ({ key: k.key, command: k.command, ...(k.where ? { where: [...k.where] } : {}), ...(k.literal ? { literal: true } : {}) }))
}
export function contributeKeybindings(entries: readonly DefaultEntry[]): () => void {
  contributedKeybindings.push(entries)
  active = new KeyTable(resolvedDefaults())
  return () => {
    const i = contributedKeybindings.indexOf(entries)
    if (i !== -1) contributedKeybindings.splice(i, 1)
    active = new KeyTable(resolvedDefaults())
  }
}

/** The defaults as concrete bindings of a platform. */
export function resolvedDefaults(mac = IS_MAC): Keybinding[] {
  return [...DEFAULT_KEYBINDINGS, ...contributedKeybindings.flat()].map(e => {
    const parsed = parseKeys(e.key)
    if (!parsed) throw new Error(`default keybinding unreadable: ${e.key}`)
    const keys = parsed.map(c => {
      if (mac && c.ctrl && !e.literal) { const { ctrl: _c, ...rest } = c; return { ...rest, meta: true } }
      return concrete(c, mac)
    })
    return { keys, command: e.command, where: e.where ? [...e.where] : defaultWhere(keys[0]!), source: 'default' as const }
  })
}

export type Resolution =
  | { kind: 'command'; command: string; binding: Keybinding }
  | { kind: 'prefix'; next: Keybinding[] }
  | { kind: 'none' }

/** The keys pressed so far are the start of (or exactly) the binding's keys. */
function startsWith(keys: readonly Chord[], pressed: readonly KeyLike[]): boolean {
  if (pressed.length > keys.length) return false
  return pressed.every((ev, i) => matches(keys[i]!, ev))
}

export class KeyTable {
  readonly bindings: readonly Keybinding[]

  constructor(bindings: readonly Keybinding[]) {
    this.bindings = bindings
  }

  /**
   * What the keys pressed so far mean in a scope: a command (the LAST matching binding wins, as in VS Code, so the
   * user's file overrides the defaults), the prefix of longer chords, or nothing (the target keeps the key). A key
   * that is both a command and a prefix in the scope is the prefix (the single binding is shadowed; the screen warns).
   */
  resolve(pressed: readonly KeyLike[], where: Where): Resolution {
    const n = pressed.length
    let exact: Keybinding | undefined
    const next: Keybinding[] = []
    for (const b of this.bindings) {
      if (b.command === PREFIX_COMMAND || !b.where.includes(where) || !startsWith(b.keys, pressed)) continue
      if (b.keys.length === n) exact = b
      else next.push(b)
    }
    if (n === 1 && next.length && this.prefixAllowed(pressed[0]!, where)) return { kind: 'prefix', next }
    if (exact) return { kind: 'command', command: exact.command, binding: exact }
    return { kind: 'none' }
  }

  /** The prefix row for this first key (PREFIX_COMMAND) allows chords in the scope; a key without a row allows them. */
  prefixAllowed(first: KeyLike, where: Where): boolean {
    let row: Keybinding | undefined
    for (const b of this.bindings) if (b.command === PREFIX_COMMAND && b.keys.length === 1 && matches(b.keys[0]!, first)) row = b
    return row ? row.where.includes(where) : true
  }

  /** The bindings that start with this key in the scope (what the pill lists while waiting). */
  continuations(first: KeyLike, where: Where): Keybinding[] {
    return this.bindings.filter(b => b.command !== PREFIX_COMMAND && b.keys.length === 2 && b.where.includes(where) && matches(b.keys[0]!, first))
  }

  bindingsOf(command: string): Keybinding[] {
    return this.bindings.filter(b => b.command === command)
  }

  /** The bindings on exactly these keys whose scope overlaps `where`, other than `except`'s. */
  usersOf(keys: readonly Chord[], where: readonly Where[], except?: string): Keybinding[] {
    return this.bindings.filter(b => b.command !== except && b.command !== PREFIX_COMMAND && sameKeys(b.keys, keys) && b.where.some(w => where.includes(w)))
  }

  /** The hint shown next to a command: its first binding's label ("Ctrl+Shift+T", "Ctrl+K Ctrl+S"), '' when it has none. */
  hint(command: string, mac = IS_MAC): string {
    const b = this.bindings.find(x => x.command === command)
    return b ? keysLabel(b.keys, mac) : ''
  }
}

let active = new KeyTable(resolvedDefaults())

/** The table in force (defaults plus the user's file). */
export function keyTable(): KeyTable {
  return active
}

export function setKeyTable(table: KeyTable): void {
  active = table
}

/** The hint for a command (its first binding on the platform), or '' when it has none. */
export function shortcutHint(command: string, mac = IS_MAC): string {
  return (mac === IS_MAC ? active : new KeyTable(resolvedDefaults(mac))).hint(command, mac)
}

/** The command a single key means in the window (no prefix in progress), or undefined when it is not one of ours. */
export function shortcutOf(ev: KeyLike, mac = IS_MAC, where: Where = 'window'): string | undefined {
  const r = (mac === IS_MAC ? active : new KeyTable(resolvedDefaults(mac))).resolve([ev], where)
  return r.kind === 'command' ? r.command : undefined
}

// ---------- pane chords and terminal inputs (unchanged by the table) ----------

/** An entry's chord off the Mac (`chord`) and its Mac override (`mac`; undefined = the same chord). */
export interface Platformed { chord: Chord | null; mac?: Chord | null }

/** The concrete chord of an entry on a platform (`mod` resolved to ctrl or meta), or null when it has none there. */
export function chordOn(entry: Platformed, mac = IS_MAC): Chord | null {
  const c = mac && entry.mac !== undefined ? entry.mac : entry.chord
  return c ? concrete(c, mac) : null
}

function find<T extends Platformed>(table: readonly T[], ev: KeyLike, mac: boolean): T | undefined {
  return table.find(e => { const c = chordOn(e, mac); return c !== null && matches(c, ev) })
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

// ---------- labels ----------

const CODE_GLYPH: Record<string, string> = {
  ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Backquote: '`', Equal: '=', Minus: '-', Backslash: '\\', IntlBackslash: '\\',
  Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: '\'', BracketLeft: '[', BracketRight: ']',
  NumpadAdd: 'Num+', NumpadSubtract: 'Num-', NumpadMultiply: 'Num*', NumpadDivide: 'Num/', NumpadDecimal: 'Num.',
  Backspace: '⌫', PageUp: 'PgUp', PageDown: 'PgDn', Escape: 'Esc', Space: 'Espaço',
}

/** What the user reads for a key: "Ctrl+Alt+Shift+→", "Ctrl+Shift+T"; on the Mac "⌃⌥⇧⌘T". */
export function chordLabel(chord: Chord, mac = IS_MAC): string {
  const c = concrete(chord, mac)
  const key = CODE_GLYPH[c.code] ?? (/^Numpad[0-9]$/.test(c.code) ? `Num${c.code.slice(6)}` : c.code.replace(/^Key|^Digit/, ''))
  if (mac) return `${c.ctrl ? '⌃' : ''}${c.alt ? '⌥' : ''}${c.shift ? '⇧' : ''}${c.meta ? '⌘' : ''}${key}`
  const parts: string[] = []
  if (c.ctrl) parts.push('Ctrl')
  if (c.alt) parts.push('Alt')
  if (c.shift) parts.push('Shift')
  if (c.meta) parts.push('Win')
  parts.push(key)
  return parts.join('+')
}

/** A sequence as the user reads it: "Ctrl+K Ctrl+S". */
export function keysLabel(keys: readonly Chord[], mac = IS_MAC): string {
  return keys.map(k => chordLabel(k, mac)).join(' ')
}
