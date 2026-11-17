// The row of desks ("mesas") as data, pure and unit-tested: order, names, colours, creation before/after the
// current one, reordering, closing, and which desk a switch goes to. The DOM side is desk-set.ts.
//
// Switching (Ctrl+Tab / Ctrl+Shift+Tab) is SEQUENTIAL with wrap-around, not most-recently-used: the desks sit
// in a visible row like Linux virtual desktops and Ctrl+1…9 address them by position, so the next/previous
// desk is the one the strip shows next to the current one. Closing a desk goes to the desk used before it
// (the MRU list), else to its neighbour.

import { HUE_NAMES, type HueName } from '../shared/palette.ts'

/** `asleep`: the desk is hibernated — its agents were stopped, it leaves the capsule and waits in the moon menu. */
export interface DeskInfo { id: string; name: string; color: DeskHue; asleep?: boolean }

/** Puts desk `id` to sleep (or wakes it). */
export function setDeskAsleep(desks: readonly DeskInfo[], id: string, asleep: boolean): DeskInfo[] {
  return desks.map(d => {
    if (d.id !== id) return d
    const { asleep: _, ...rest } = d
    return asleep ? { ...rest, asleep: true } : rest
  })
}

export type DeskHue = HueName

/** The picker's hues, in order, with the Portuguese label shown as the swatch tooltip. */
export const DESK_HUES: readonly { hue: DeskHue; label: string }[] = [
  { hue: 'red', label: 'Vermelho' },
  { hue: 'orange', label: 'Laranja' },
  { hue: 'yellow', label: 'Amarelo' },
  { hue: 'lime', label: 'Lima' },
  { hue: 'green', label: 'Verde' },
  { hue: 'teal', label: 'Verde-água' },
  { hue: 'cyan', label: 'Ciano' },
  { hue: 'sky', label: 'Céu' },
  { hue: 'blue', label: 'Azul' },
  { hue: 'purple', label: 'Roxo' },
  { hue: 'magenta', label: 'Magenta' },
  { hue: 'pink', label: 'Rosa' },
]

export const DEFAULT_DESK_HUE: DeskHue = 'blue'

/**
 * The order new desks draw their colour in: the first eight are the old palette's order (Azul, Verde, Âmbar,
 * Vermelho, Roxo, Ciano, Rosa, Cinza), so a fresh app still starts blue; the other four follow.
 */
const SPREAD: readonly DeskHue[] = ['blue', 'green', 'orange', 'red', 'purple', 'cyan', 'pink', 'sky', 'yellow', 'lime', 'teal', 'magenta']

/**
 * The OLD 8-colour palette (index → hue), the only meaning a NUMBER has in layout.json. Each old colour maps to
 * its nearest hue; Cinza had no equivalent and becomes sky, the closest to a neutral cool tone. An index never
 * means a position in the 12 (3 is red, not lime).
 */
export const OLD_PALETTE_HUES: readonly DeskHue[] = ['blue', 'green', 'orange', 'red', 'purple', 'cyan', 'pink', 'sky']

/** Reads a stored desk colour: a hue name stays; a number is an index of the old palette (wrapping, as it did); anything else is blue. */
export function readDeskColor(raw: unknown): DeskHue {
  if (typeof raw === 'string') return (HUE_NAMES as readonly string[]).includes(raw) ? raw as DeskHue : DEFAULT_DESK_HUE
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const n = OLD_PALETTE_HUES.length
    return OLD_PALETTE_HUES[((Math.trunc(raw) % n) + n) % n]!
  }
  return DEFAULT_DESK_HUE
}

export const MAX_DESK_NAME = 40

/**
 * How a desk paints in the capsule and the desk line: `fill` (active segment, desk line), `foreground` (text on
 * the fill) and `text` (an inactive segment's name, on the toolbar). Every consumer reads these three CSS values
 * only (as --seg-fill / --seg-fg / --seg-text and --desk-line-color); they are the generated palette's custom
 * properties (app/shared/palette.ts → app/dist/palette.css).
 */
export interface DeskTokens { fill: string; foreground: string; text: string }

export function deskTokens(color: DeskHue): DeskTokens {
  const hue = readDeskColor(color)
  return { fill: `var(--x-${hue})`, foreground: `var(--x-${hue}-foreground)`, text: `var(--x-${hue}-text)` }
}

/** `desk-N` with the smallest N not in use. */
export function nextDeskId(desks: readonly DeskInfo[]): string {
  const used = new Set(desks.map(d => d.id))
  for (let i = 1; ; i++) if (!used.has(`desk-${i}`)) return `desk-${i}`
}

/** "Mesa N" with the smallest N not in use as a name. */
export function nextDeskName(desks: readonly DeskInfo[]): string {
  const used = new Set(desks.map(d => d.name))
  for (let i = 1; ; i++) if (!used.has(`Mesa ${i}`)) return `Mesa ${i}`
}

/** The least used hue (first in the spread order on a tie): new desks spread over the 12. */
export function nextDeskColor(desks: readonly DeskInfo[]): DeskHue {
  const count = new Map<DeskHue, number>(SPREAD.map(h => [h, 0]))
  for (const d of desks) count.set(d.color, (count.get(d.color) ?? 0) + 1)
  let best = SPREAD[0]!
  for (const h of SPREAD) if (count.get(h)! < count.get(best)!) best = h
  return best
}

/** A new desk (id, name, colour) inserted before or after `relativeTo` (at the end when it is unknown). */
export function insertDesk(desks: readonly DeskInfo[], relativeTo: string | undefined, side: 'before' | 'after'): { desks: DeskInfo[]; desk: DeskInfo } {
  const desk: DeskInfo = { id: nextDeskId(desks), name: nextDeskName(desks), color: nextDeskColor(desks) }
  const i = desks.findIndex(d => d.id === relativeTo)
  const at = i < 0 ? desks.length : side === 'before' ? i : i + 1
  return { desks: [...desks.slice(0, at), desk, ...desks.slice(at)], desk }
}

/** A trimmed, length-limited name; undefined when nothing is left (the rename is refused). */
export function cleanDeskName(name: string): string | undefined {
  const s = name.replace(/\s+/g, ' ').trim().slice(0, MAX_DESK_NAME)
  return s || undefined
}

export function renameDesk(desks: readonly DeskInfo[], id: string, name: string): DeskInfo[] {
  const clean = cleanDeskName(name)
  return clean ? desks.map(d => d.id === id ? { ...d, name: clean } : d) : [...desks]
}

export function recolorDesk(desks: readonly DeskInfo[], id: string, color: unknown): DeskInfo[] {
  const c = readDeskColor(color)
  return desks.map(d => d.id === id ? { ...d, color: c } : d)
}

/** Moves desk `id` to position `to` (clamped), the others keep their relative order. */
export function moveDesk(desks: readonly DeskInfo[], id: string, to: number): DeskInfo[] {
  const from = desks.findIndex(d => d.id === id)
  if (from < 0) return [...desks]
  const rest = desks.filter(d => d.id !== id)
  const at = Math.max(0, Math.min(rest.length, to))
  return [...rest.slice(0, at), desks[from]!, ...rest.slice(at)]
}

/** The desk `step` places away from `active`, wrapping around (Ctrl+Tab = +1, Ctrl+Shift+Tab = -1). */
export function cycleDesk(desks: readonly DeskInfo[], active: string, step: number): string {
  const i = desks.findIndex(d => d.id === active)
  if (i < 0 || desks.length === 0) return desks[0]?.id ?? active
  const n = desks.length
  return desks[(((i + step) % n) + n) % n]!.id
}

/** The desk at 1-based position `n` (Ctrl+n); undefined when there is none there. */
export function deskAt(desks: readonly DeskInfo[], n: number): string | undefined {
  return desks[n - 1]?.id
}

/** The MRU list with `id` in front (switching to it). */
export function touchMru(mru: readonly string[], id: string): string[] {
  return [id, ...mru.filter(x => x !== id)]
}

/**
 * Closes desk `id`. The last desk is never closed (null). The new active desk is the active one when another
 * desk closes; when the active one closes, the most recently used remaining desk, else its right neighbour,
 * else its left one.
 */
export function closeDesk(desks: readonly DeskInfo[], id: string, active: string, mru: readonly string[]): { desks: DeskInfo[]; active: string; mru: string[] } | null {
  const i = desks.findIndex(d => d.id === id)
  if (i < 0 || desks.length <= 1) return null
  const rest = desks.filter(d => d.id !== id)
  const restMru = mru.filter(x => x !== id && rest.some(d => d.id === x))
  let next = active
  if (active === id || !rest.some(d => d.id === active)) next = restMru[0] ?? (rest[i] ?? rest[i - 1])!.id
  return { desks: rest, active: next, mru: touchMru(restMru, next) }
}

/** The neighbour a closing desk's panes go to by default: the right one, else the left one. */
export function neighbourDesk(desks: readonly DeskInfo[], id: string): string | undefined {
  const i = desks.findIndex(d => d.id === id)
  if (i < 0) return undefined
  return (desks[i + 1] ?? desks[i - 1])?.id
}
