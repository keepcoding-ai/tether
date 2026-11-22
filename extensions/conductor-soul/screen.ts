// What the Soul's screen says (tether for agents, the soul conductor): a pure reading of the lines the headless terminal gives
// (`ScreenText.screen`). Every marker below is from the sonda of 21/11 (soul 0.1.188, `sonda-digitar-soul`); no state, no I/O.
//   - the bottom of the screen is the composer: a box (`╭─…╮`, `│ ❯ …│`, `╰─…╯`) with one footer line under it;
//   - `Esc stops │ Enter queues after this turn` in that footer = a turn is running;
//   - `? for shortcuts` in that footer (with the box) = idle; an interrupted turn leaves `Interrupted · What should Soul do
//     instead?` in the transcript and the same idle footer;
//   - a permission card puts `? waiting for your answer` between the card and the composer (whose line then says
//     `❯ answer the card above`); the card is the block under the last full-width rule `────`, its question says `Do you want …`,
//     its options are `1. Yes` and `2. No` (there is no "always"), its own footer `Esc to cancel · Tab to amend · …`;
//   - the first-open dialogs: the trust one (`Quick safety check …`, `❯ Yes, I trust this folder`, `Enter to confirm`) and the
//     profile one (`Soul — how do you want to enter?`, `❯ 1  Ana Teste`, `8  Create a new profile`).
// A text outside those markers is `unknown`: the conductor never guesses. A card with the waiting marker whose options are not
// Yes/No is a `question`: no probe has seen the Soul ask one, so that branch follows the same shape and is `proven: false` upstream.
import type { DetectedCard } from '../for-agents/conductor-api.ts'

export type Role = 'yes' | 'no'

export interface ParsedOption {
  n: number | undefined
  label: string
  /** What a permission option means for `answer yes|no`. */
  role: Role | undefined
}

export type Seen =
  | { kind: 'permission' | 'question'; card: DetectedCard; options: ParsedOption[] }
  | { kind: 'dialog'; dialog: 'trust' | 'profile'; card: DetectedCard; options: ParsedOption[]; /** The profile dialog: the highlighted row is a named profile (1 to 6). */ onProfile: boolean }
  | { kind: 'busy' | 'idle' | 'unknown' }

const RULE = /^\s*─{10,}\s*$/
const OPTION = /^\s*(?:❯\s*)?(\d+)\.\s+(\S.*)$/
const WAITING = /^\s*\?\s*waiting for your answer/i
const CARD_FOOTER = /esc to cancel/i
const BUSY = /esc stops\s*│\s*enter queues/i
const IDLE_FOOTER = /\?\s*for shortcuts/i
const SLASH_MENU = /tab completes\s*│\s*enter runs/i
const COMPOSER_TOP = /^\s*╭─{10,}╮\s*$/
const COMPOSER_LINE = /^\s*│\s*❯/
const COMPOSER_BOTTOM = /^\s*╰─{10,}╯\s*$/
/** How many non-blank rows at the bottom are the composer's and the card's footers (a card's marker sits above a 3-row box and a status row). */
const TAIL = 9

export const TRUST_DIALOG: readonly string[] = ['Quick safety check', 'Yes, I trust this folder', 'Enter to confirm']
export const PROFILE_DIALOG: readonly string[] = ['how do you want to enter?', 'Create a new profile']

const isBlank = (l: string): boolean => l.trim() === ''

/** Whether every fragment is on the screen, compared without whitespace (the rule of the core's channel confirmation). */
export function hasAll(screen: readonly string[], fragments: readonly string[]): boolean {
  const flat = screen.join('').replace(/\s+/g, '')
  return fragments.every((f) => flat.includes(f.replace(/\s+/g, '')))
}

function roleOf(label: string): Role | undefined {
  if (/^Yes\b/i.test(label)) return 'yes'
  if (/^No\b/i.test(label)) return 'no'
  return undefined
}

/** The numbered options just above `footer`: from the last `1.` down to it; the numbers must run 1, 2, 3... */
function numbered(rows: readonly string[], footer: number): { first: number; options: ParsedOption[] } | undefined {
  let first = -1
  for (let i = footer - 1; i >= 0; i--) {
    const m = OPTION.exec(rows[i]!)
    if (m && Number(m[1]) === 1) { first = i; break }
  }
  if (first < 0) return undefined
  const options: ParsedOption[] = []
  for (let i = first; i < footer; i++) {
    const m = OPTION.exec(rows[i]!)
    if (m) options.push({ n: Number(m[1]), label: m[2]!.trim(), role: undefined })
    else if (!isBlank(rows[i]!) && options.length > 0) options[options.length - 1]!.label += ` ${rows[i]!.trim()}`
  }
  if (options.length < 2 || options.some((o, i) => o.n !== i + 1)) return undefined
  return { first, options }
}

function cardOf(rows: readonly string[], waiting: number): Seen | undefined {
  let footer = waiting - 1
  while (footer >= 0 && isBlank(rows[footer]!)) footer--
  if (footer < 0 || !CARD_FOOTER.test(rows[footer]!)) return undefined
  const menu = numbered(rows, footer)
  if (!menu) return undefined
  let top = 0
  for (let i = menu.first - 1; i >= 0; i--) if (RULE.test(rows[i]!)) { top = i + 1; break }
  if (top === 0) top = Math.max(0, menu.first - 8)
  const lines = rows.slice(top, footer)
  while (lines.length > 0 && isBlank(lines[0]!)) lines.shift()
  while (lines.length > 0 && isBlank(lines[lines.length - 1]!)) lines.pop()
  const title = lines.find((l) => !isBlank(l))?.trim() ?? ''
  const options = menu.options.map((o) => ({ ...o, role: roleOf(o.label) }))
  const permission = options[0]!.role === 'yes' && options.some((o) => o.role === 'no')
  const shown = options.map((o) => ({ id: permission && o.role ? o.role : String(o.n), label: o.label }))
  return { kind: permission ? 'permission' : 'question', card: { title, text: lines.join('\n'), options: shown }, options }
}

/** The first-open dialogs: told by their fragments (they own the whole screen), not by a footer. */
function dialogOf(screen: readonly string[]): Seen | undefined {
  const rows = screen.map((l) => l.replace(/\s+$/, ''))
  if (hasAll(rows, TRUST_DIALOG)) {
    const text = rows.filter((l) => !isBlank(l)).map((l) => l.replace(/^[\s│]+|[\s│]+$/g, '')).filter((l) => l !== '' && !/^[╭╰─╮╯]+$/.test(l)).join('\n')
    const options = ['Yes, I trust this folder', 'No, exit'].map((label): ParsedOption => ({ n: undefined, label, role: undefined }))
    return { kind: 'dialog', dialog: 'trust', card: { title: 'Quick safety check', text, options: options.map((o, i) => ({ id: String(i + 1), label: o.label })) }, options, onProfile: false }
  }
  if (hasAll(rows, PROFILE_DIALOG)) {
    const lit = rows.find((l) => /^\s*❯\s*\d+\s/.test(l))
    const n = lit ? Number(/^\s*❯\s*(\d+)/.exec(lit)![1]) : undefined
    const text = rows.filter((l) => !isBlank(l) && !RULE.test(l)).map((l) => l.trim()).join('\n')
    return { kind: 'dialog', dialog: 'profile', card: { title: 'Soul — how do you want to enter?', text, options: [] }, options: [], onProfile: n !== undefined && n >= 1 && n <= 6 }
  }
  return undefined
}

/** What the screen shows now. `screen` is `ScreenText.screen`: the rows of the terminal as the person sees them. */
export function readSoulScreen(screen: readonly string[]): Seen {
  const rows = screen.map((l) => l.replace(/\s+$/, ''))
  let last = rows.length - 1
  while (last >= 0 && isBlank(rows[last]!)) last--
  if (last < 0) return { kind: 'unknown' }

  const dialog = dialogOf(rows)
  if (dialog) return dialog

  // Only the bottom counts: a card or a footer left in the scrollback above is history.
  const from = Math.max(0, last - TAIL + 1)
  const tail = rows.slice(from, last + 1)

  const waiting = tail.findIndex((l) => WAITING.test(l))
  if (waiting >= 0) return cardOf(rows, from + waiting) ?? { kind: 'unknown' }

  if (tail.some((l) => BUSY.test(l))) return { kind: 'busy' }
  if (tail.some((l) => SLASH_MENU.test(l))) return { kind: 'unknown' }

  // The composer: its three rows near the bottom, and no turn marker: ready for input.
  const top = tail.findIndex((l) => COMPOSER_TOP.test(l))
  const composer = top >= 0 && COMPOSER_LINE.test(tail[top + 1] ?? '') && COMPOSER_BOTTOM.test(tail[top + 2] ?? '')
  if (composer && (tail.slice(top + 3).some((l) => IDLE_FOOTER.test(l)) || tail.length > top + 3)) return { kind: 'idle' }
  return { kind: 'unknown' }
}
