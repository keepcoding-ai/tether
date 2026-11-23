// What the Codex CLI's screen says (tether for agents, the codex conductor): a pure reading of the lines the headless terminal gives
// (`ScreenText.screen`). Every marker below is from the sonda of 21/11 (Codex 0.169.0, `sonda-digitar-codex`) and from the dialog probe
// of C3 (`onda-2/c3/probe-dialogs-screens-2.txt`):
//   - a card ends the screen with a footer and has numbered options above it, the selected one marked `›`:
//       the approval request: `Would you like to run the following command?` ... `› 1. Yes, proceed (y)`, `2. Yes, and don't ask
//       again for commands that start with ... (p)`, `3. No, and tell Codex what to do differently (esc)`, footer
//       `Press enter to confirm or esc to cancel`;
//       the update dialog: `Update available · 0.169.0 → 0.171.0`, `1. Update now`, `2. Skip`, `3. Skip until next version`, footer
//       `enter continue · esc skip` (Enter there RUNS `npm install -g`: only Esc skips);
//       the new-conversation dialog (`/new` in a git repository): footer `enter select · esc back`;
//   - `esc to interrupt` in the last rows ("Working (3s • esc to interrupt)", "Compacting context (...)", the queued-messages notice) = a
//     turn is running (the line is not always on the screen while the text streams: the conductor also reads the slot's `turn`);
//   - `■ Conversation interrupted` just above the composer = the agent was stopped;
//   - the composer is a row that starts with `›` (`› Ask Codex to do anything`) among the last rows, with no card.
// A text outside those markers is `unknown`: the conductor never guesses. No state, no I/O.
import type { DetectedCard } from '../for-agents/conductor-api.ts'

export type Role = 'yes' | 'session' | 'always' | 'no'

export interface ParsedOption {
  n: number
  label: string
  /** The key the screen names for the option: `(y)`, `(p)`, `(esc)`. */
  key: string | undefined
  /** What a permission option means for `answer yes|always|no`. */
  role: Role | undefined
}

export type Seen =
  | { kind: 'permission' | 'dialog'; card: DetectedCard; options: ParsedOption[]; list?: { selected: number } }
  | { kind: 'busy' | 'idle' | 'interrupted' | 'unknown' }

// The MCP tool card (`Field 1/1`, `Allow the <server> MCP server to run tool "<tool>"?`) is a list with no key per option: the
// selected row is marked `›` and the footer is `enter to submit | esc to cancel`; options are chosen by moving the selection.
const FOOTER = /press enter to confirm or esc to cancel|enter (?:select|continue)\s*·\s*esc (?:back|skip)|enter to submit\s*\|\s*esc to cancel/i
const LIST_FOOTER = /enter to submit\s*\|\s*esc to cancel/i
const OPTION = /^\s*(?:›\s*)?(\d+)\.\s+(\S.*)$/
const KEY_SUFFIX = /\s\((y|p|esc)\)\s*$/
const BUSY = /esc to interrupt/i
const INTERRUPTED = /^\s*■\s*Conversation interrupted/i
const COMPOSER = /^\s*›(?!\s*\d+\.)/
const TITLE = /^\s*(?:Would you like to\b|Allow the .+ MCP server to run tool\b)/i
const TAIL_ROWS = 10

const isBlank = (l: string): boolean => l.trim() === ''

function roleOf(full: string, key: string | undefined): Role | undefined {
  // The MCP card puts a description after the label, two or more spaces apart.
  const label = full.split(/\s{2,}/)[0]!
  if (/^Allow$/i.test(label)) return 'yes'
  if (/^Allow for this session$/i.test(label)) return 'session'
  if (/^Always allow$/i.test(label)) return 'always'
  if (/^Cancel$/i.test(label)) return 'no'
  if (key === 'y') return 'yes'
  if (key === 'p') return 'always'
  if (key === 'esc' && /^No\b/i.test(label)) return 'no'
  if (/^Yes, and (?:don.t ask again|always)/i.test(label)) return 'always'
  if (/^Yes\b/i.test(label)) return 'yes'
  if (/^No\b/i.test(label)) return 'no'
  return undefined
}

/** The numbered options of a card: from the last `1.` to the footer; wrapped lines join the option they continue. */
function numbered(rows: readonly string[], footer: number): { first: number; options: ParsedOption[]; selected: number } | undefined {
  let first = -1
  for (let i = footer - 1; i >= 0; i--) {
    const m = OPTION.exec(rows[i]!)
    if (m && Number(m[1]) === 1) { first = i; break }
  }
  if (first < 0) return undefined
  const labels: { n: number; label: string }[] = []
  let selected = 1
  for (let i = first; i < footer; i++) {
    const row = rows[i]!
    const m = OPTION.exec(row)
    if (m && /^\s*›/.test(row)) selected = Number(m[1])
    if (m) labels.push({ n: Number(m[1]), label: m[2]!.trim() })
    else if (!isBlank(row) && labels.length > 0) labels[labels.length - 1]!.label += ` ${row.trim()}`
  }
  // A list of one is not a menu; and the numbers must run 1, 2, 3...
  if (labels.length < 2 || labels.some((o, i) => o.n !== i + 1)) return undefined
  const options = labels.map((o): ParsedOption => {
    const key = KEY_SUFFIX.exec(o.label)?.[1]
    return { n: o.n, label: o.label, key, role: roleOf(o.label, key) }
  })
  return { first, options, selected }
}

function cardOf(rows: readonly string[], footer: number): Seen | undefined {
  const menu = numbered(rows, footer)
  if (!menu) return undefined
  // The card starts at its title (`Would you like to ...`) when there is one within reach, else at the block of text above the options.
  let top = -1
  for (let i = menu.first - 1; i >= Math.max(0, menu.first - 14); i--) if (TITLE.test(rows[i]!)) { top = i; break }
  if (top < 0) {
    top = menu.first
    while (top > 0 && !isBlank(rows[top - 1]!) && menu.first - top < 8) top--
  }
  const lines = rows.slice(top, footer)
  while (lines.length > 0 && isBlank(lines[lines.length - 1]!)) lines.pop()
  const title = rows[top]!.trim() === '' ? (lines.find((l) => !isBlank(l))?.trim() ?? '') : rows[top]!.trim()
  const permission = TITLE.test(rows[top]!) && menu.options.some((o) => o.role === 'yes')
  const shown = permission
    ? menu.options.filter((o) => o.role !== undefined).map((o) => ({ id: o.role!, label: o.label }))
    : menu.options.map((o) => ({ id: String(o.n), label: o.label }))
  const list = LIST_FOOTER.test(rows[footer]!) ? { list: { selected: menu.selected } } : {}
  return { kind: permission ? 'permission' : 'dialog', card: { title, text: lines.join('\n'), options: shown }, options: menu.options, ...list }
}

/** What the screen shows now. `screen` is `ScreenText.screen`: the rows of the terminal as the person sees it. */
export function readCodexScreen(screen: readonly string[]): Seen {
  const rows = screen.map((l) => l.replace(/\s+$/, ''))
  let last = rows.length - 1
  while (last >= 0 && isBlank(rows[last]!)) last--
  if (last < 0) return { kind: 'unknown' }

  // A card has its footer on the last line of the screen.
  if (FOOTER.test(rows[last]!)) {
    const card = cardOf(rows, last)
    if (card) return card
  }

  // The last non-blank rows, from the bottom.
  const tail: number[] = []
  for (let i = last; i >= 0 && tail.length < TAIL_ROWS; i--) if (!isBlank(rows[i]!)) tail.push(i)
  const composer = tail.find((i) => COMPOSER.test(rows[i]!))
  if (tail.some((i) => BUSY.test(rows[i]!))) return { kind: 'busy' }
  if (composer === undefined) return { kind: 'unknown' }
  let above = composer - 1
  while (above >= 0 && isBlank(rows[above]!)) above--
  if (above >= 0 && INTERRUPTED.test(rows[above]!)) return { kind: 'interrupted' }
  return { kind: 'idle' }
}

const PLACEHOLDER = /^Ask Codex to do anything$/i

/**
 * What sits in the composer, unsent: the first row after `›` of the composer (the last `›` row among the last rows), or undefined for
 * the placeholder, no composer, or a card. A text typed and not submitted stays there (C3: a long line's Enter, 300 ms after the text,
 * was not taken; a second Enter was).
 */
export function composerDraft(screen: readonly string[]): string | undefined {
  const rows = screen.map((l) => l.replace(/\s+$/, ''))
  let last = rows.length - 1
  while (last >= 0 && isBlank(rows[last]!)) last--
  if (last < 0 || FOOTER.test(rows[last]!)) return undefined
  let seen = 0
  for (let i = last; i >= 0 && seen < TAIL_ROWS; i--) {
    if (isBlank(rows[i]!)) continue
    seen++
    if (!COMPOSER.test(rows[i]!)) continue
    const text = rows[i]!.replace(/^\s*›\s*/, '').trim()
    return text === '' || PLACEHOLDER.test(text) ? undefined : text
  }
  return undefined
}

/** Letters and digits only: the screen may show a typed separator (the envelope's `·`) as blank, so matches skip punctuation and spacing. */
export const alnum = (s: string): string => s.replace(/[^\p{L}\p{N}]+/gu, '')

/**
 * Whether `head` (already `alnum`) shows in the transcript ABOVE the composer: the rows of the history and of the screen up to
 * the composer row (the bottom `›` row among the last rows), glued so a wrapped message still matches. A message Codex took is
 * echoed there; the draft in the composer itself never counts.
 */
export function echoedAbove(screen: readonly string[], history: readonly string[], head: string): boolean {
  const rows = screen.map((l) => l.replace(/\s+$/, ''))
  let last = rows.length - 1
  while (last >= 0 && isBlank(rows[last]!)) last--
  let cut = last + 1
  let seen = 0
  for (let i = last; i >= 0 && seen < TAIL_ROWS; i--) {
    if (isBlank(rows[i]!)) continue
    seen++
    if (COMPOSER.test(rows[i]!)) { cut = i; break }
  }
  return alnum([...history, ...rows.slice(0, cut)].join('')).includes(head)
}

/** Whether every fragment is on the screen, compared without whitespace (the rule of the core's channel confirmation). */
export function hasAll(screen: readonly string[], fragments: readonly string[]): boolean {
  const flat = screen.join('').replace(/\s+/g, '')
  return fragments.every((f) => flat.includes(f.replace(/\s+/g, '')))
}

/** The update dialog of a Codex that has a newer version (the launch flag `check_for_update_on_startup=false` avoids it). */
export const UPDATE_DIALOG: readonly string[] = ['Update available', 'Skip until next version', 'esc skip']
/** The dialog `/new` raises inside a git repository: option 1 (the current worktree) is the selected one. */
export const NEW_CONVERSATION_DIALOG: readonly string[] = ['Where should the new conversation run?', 'Use current Git worktree']
