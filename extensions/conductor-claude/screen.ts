// What Claude Code's screen says (tether for agents, the claude conductor): a pure reading of the lines the headless terminal
// gives (`ScreenText.screen`). Every marker below is from the sonda of 21/11 (Claude Code 2.1.330, `sonda-digitar-claude`):
//   - a card (permission, a question of the agent, a dialog) ends the screen with a footer: `Esc to cancel · Tab to amend`
//     (permission), `Enter to select · ↑/↓ to navigate · Esc to cancel` (AskUserQuestion), `Enter to confirm · Esc to cancel`
//     (the trust folder and the channels dialogs); above it the numbered options, above them a full-width rule `────`;
//   - `esc to interrupt` in the footer of the prompt box = a turn is running;
//   - `Interrupted · What should Claude do instead?` just above the prompt box = the agent was stopped;
//   - a prompt box (`❯` between two full-width rules) with none of those = idle.
// A text outside those markers is `unknown`: the conductor never guesses. No state, no I/O.
import type { DetectedCard } from '../for-agents/conductor-api.ts'

export type Role = 'yes' | 'always' | 'no'

export interface ParsedOption {
  /** The number on the screen; undefined for an option with none (the trust dialog). */
  n: number | undefined
  label: string
  /** What a permission option means for `answer yes|always|no` (only on a permission card). */
  role: Role | undefined
}

export type Seen =
  | { kind: 'permission' | 'question' | 'dialog'; card: DetectedCard; options: ParsedOption[] }
  | { kind: 'busy' | 'idle' | 'interrupted' | 'unknown' }

const RULE = /^\s*─{10,}\s*$/
const OPTION = /^\s*(?:❯\s*)?(\d+)\.\s+(\S.*)$/
const FOOTER = /esc to cancel|enter to (?:select|confirm)/i
const BUSY = /esc to interrupt/i
const INTERRUPTED = /^\s*(?:⎿\s*)?Interrupted\s*·/

const isBlank = (l: string): boolean => l.trim() === ''

function roleOf(label: string): Role | undefined {
  if (/auto[ -]mode/i.test(label)) return undefined
  if (/^Yes, and (?:don.t ask again|always allow|allow)/i.test(label)) return 'always'
  if (/^Yes\b/i.test(label)) return 'yes'
  if (/^No\b/i.test(label)) return 'no'
  return undefined
}

/** The numbered options of a card: from the last `1.` to the footer; wrapped lines join the option they continue. */
function numbered(rows: readonly string[], footer: number): { first: number; options: ParsedOption[] } | undefined {
  let first = -1
  for (let i = footer - 1; i >= 0; i--) {
    const m = OPTION.exec(rows[i]!)
    if (m && Number(m[1]) === 1) { first = i; break }
  }
  if (first < 0) return undefined
  const options: ParsedOption[] = []
  for (let i = first; i < footer; i++) {
    const row = rows[i]!
    const m = OPTION.exec(row)
    if (m) {
      options.push({ n: Number(m[1]), label: m[2]!.trim(), role: undefined })
    } else if (!isBlank(row) && !RULE.test(row) && options.length > 0) {
      const last = options[options.length - 1]!
      last.label = `${last.label} ${row.trim()}`
    }
  }
  // A list of one is not a menu; and the numbers must run 1, 2, 3...
  if (options.length < 2 || options.some((o, i) => o.n !== i + 1)) return undefined
  return { first, options }
}

/** The unnumbered options of a dialog: the block of lines right above the footer (`❯ No, exit` / `Yes, I trust this folder`). */
function plain(rows: readonly string[], footer: number): { first: number; options: ParsedOption[] } | undefined {
  let end = footer - 1
  while (end >= 0 && isBlank(rows[end]!)) end--
  let start = end
  while (start > 0 && !isBlank(rows[start - 1]!) && !RULE.test(rows[start - 1]!)) start--
  if (end < 0 || start === end) return undefined
  const options = rows.slice(start, end + 1).map((r): ParsedOption => ({ n: undefined, label: r.replace(/^\s*❯\s*/, '').trim(), role: undefined }))
  return { first: start, options }
}

function cardOf(rows: readonly string[], footer: number): Seen | undefined {
  const text = rows[footer]!
  const menu = numbered(rows, footer) ?? (/enter to confirm/i.test(text) ? plain(rows, footer) : undefined)
  if (!menu) return undefined
  let top = 0
  for (let i = menu.first - 1; i >= 0; i--) if (RULE.test(rows[i]!)) { top = i + 1; break }
  if (top === 0) top = Math.max(0, menu.first - 6)
  const lines = rows.slice(top, footer)
  while (lines.length > 0 && isBlank(lines[0]!)) lines.shift()
  while (lines.length > 0 && isBlank(lines[lines.length - 1]!)) lines.pop()
  const title = lines.find((l) => !isBlank(l))?.trim().replace(/^☐\s*/, '') ?? ''
  const options = menu.options.map((o) => ({ ...o, role: roleOf(o.label) }))
  const numberedMenu = options.every((o) => o.n !== undefined)
  const kind: 'permission' | 'question' | 'dialog' =
    /enter to select/i.test(text) && numberedMenu ? 'question'
      : /enter to confirm/i.test(text) ? 'dialog'
        : numberedMenu && options[0]!.role === 'yes' ? 'permission'
          : 'dialog'
  const shown = kind === 'permission'
    ? options.filter((o) => o.role !== undefined).map((o) => ({ id: o.role!, label: o.label }))
    : options.map((o, i) => ({ id: String(o.n ?? i + 1), label: o.label }))
  return { kind, card: { title, text: lines.join('\n'), options: shown }, options }
}

/** What the screen shows now. `screen` is `ScreenText.screen`: the rows of the terminal as the person sees them. */
export function readClaudeScreen(screen: readonly string[]): Seen {
  const rows = screen.map((l) => l.replace(/\s+$/, ''))
  let last = rows.length - 1
  while (last >= 0 && isBlank(rows[last]!)) last--
  if (last < 0) return { kind: 'unknown' }

  // A card has its footer on the last line of the screen.
  if (FOOTER.test(rows[last]!)) {
    const card = cardOf(rows, last)
    if (card) return card
  }

  const tail = rows.slice(Math.max(0, last - 5), last + 1)
  if (tail.some((l) => BUSY.test(l))) return { kind: 'busy' }

  // The prompt box: a `❯` line between two full-width rules, near the bottom.
  let box = -1
  for (let i = last; i >= Math.max(0, last - 8); i--) {
    if (RULE.test(rows[i]!) && i + 2 <= last && RULE.test(rows[i + 2]!) && rows[i + 1]!.trimStart().startsWith('❯')) { box = i; break }
  }
  if (box < 0) return { kind: 'unknown' }
  let above = box - 1
  while (above >= 0 && isBlank(rows[above]!)) above--
  if (above >= 0 && INTERRUPTED.test(rows[above]!)) return { kind: 'interrupted' }
  return { kind: 'idle' }
}

/** Whether every fragment is on the screen, compared without whitespace (the rule of the core's channel confirmation). */
export function hasAll(screen: readonly string[], fragments: readonly string[]): boolean {
  const flat = screen.join('').replace(/\s+/g, '')
  return fragments.every((f) => flat.includes(f.replace(/\s+/g, '')))
}

/** The trust-folder dialog of a folder Claude has not met. */
export const TRUST_DIALOG: readonly string[] = ['Quick safety check', 'Yes, I trust this folder', 'Enter to confirm']
