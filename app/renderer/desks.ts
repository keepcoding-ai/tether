// The row of desks ("mesas") as data, pure and unit-tested: order, names, colours, creation before/after the
// current one, reordering, closing, and which desk a switch goes to. The DOM side is desk-set.ts.
//
// Switching (Ctrl+Tab / Ctrl+Shift+Tab) is SEQUENTIAL with wrap-around, not most-recently-used: the desks sit
// in a visible row like Linux virtual desktops and Ctrl+1…9 address them by position, so the next/previous
// desk is the one the strip shows next to the current one. Closing a desk goes to the desk used before it
// (the MRU list), else to its neighbour.

export interface DeskInfo { id: string; name: string; color: number }

/** The desk palette: index → CSS colour (readable on both themes; the strip paints a bar and a dot with it). */
export const DESK_COLORS: readonly { name: string; css: string }[] = [
  { name: 'Azul', css: '#4f8fe8' },
  { name: 'Verde', css: '#3fae66' },
  { name: 'Âmbar', css: '#d99a2b' },
  { name: 'Vermelho', css: '#e05a5a' },
  { name: 'Roxo', css: '#9a6ee0' },
  { name: 'Ciano', css: '#2fa9b8' },
  { name: 'Rosa', css: '#d9609f' },
  { name: 'Cinza', css: '#8a8f99' },
]

export const MAX_DESK_NAME = 40

/**
 * How a desk paints in the capsule and the desk line: `fill` (active segment, desk line), `foreground` (text on
 * the fill) and `text` (an inactive segment's name, on the toolbar). Every consumer reads these three CSS values
 * only (as --seg-fill / --seg-fg / --seg-text and --desk-line-color), so moving to the --x-{hue} palette is a
 * change here alone. Until then they derive from the 8 colours above.
 */
export interface DeskTokens { fill: string; foreground: string; text: string }

export function deskTokens(color: number): DeskTokens {
  const css = colorOf(color)
  const [r, g, b] = [1, 3, 5].map(i => {
    const v = parseInt(css.slice(i, i + 2), 16) / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b
  // White or near-black, whichever contrasts more with the fill.
  const foreground = (1.05) / (y + 0.05) >= (y + 0.05) / 0.0565 ? '#ffffff' : '#10131a'
  return { fill: css, foreground, text: `color-mix(in oklab, ${css} 72%, var(--fg))` }
}

export function colorOf(color: number): string {
  return DESK_COLORS[((color % DESK_COLORS.length) + DESK_COLORS.length) % DESK_COLORS.length]!.css
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

/** The least used colour (lowest index on a tie): new desks spread over the palette. */
export function nextDeskColor(desks: readonly DeskInfo[]): number {
  const count = DESK_COLORS.map(() => 0)
  for (const d of desks) count[((d.color % count.length) + count.length) % count.length]!++
  let best = 0
  for (let i = 1; i < count.length; i++) if (count[i]! < count[best]!) best = i
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

export function recolorDesk(desks: readonly DeskInfo[], id: string, color: number): DeskInfo[] {
  const c = ((Math.trunc(color) % DESK_COLORS.length) + DESK_COLORS.length) % DESK_COLORS.length
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
