// Which desks the capsule shows, pure and unit-tested (the DOM side is desk-switch.ts).
//
// Whole names while they fit; when they do not, the capsule keeps a subset and one fixed "+N" lists the rest.
// The active desk is never hidden. Who leaves first is the desk used longest ago (`lastUsed`), and picking a
// desk in the "+N" puts it in place of the visible desk used longest ago; the others stay. The visible desks
// are always shown in the row's order (Ctrl+1…9 address positions in that row).

/** Use stamps per desk id (bigger = more recent); a desk never used counts as 0. */
export type LastUsed = Readonly<Record<string, number>>

export interface FitInput {
  /** Every desk, in the row's order. */
  order: readonly string[]
  active: string
  /** What was visible before (keeps the subset stable across repaints); empty = no preference. */
  visible: readonly string[]
  /** Natural width of each desk's segment, px. */
  widths: Readonly<Record<string, number>>
  /** Room for the segments (and the "+N" when it shows), px. */
  avail: number
  /** Width of the "+N" button, px. */
  plusWidth: number
  /** Space between two items, px. */
  gap: number
  lastUsed: LastUsed
}

function width(ids: readonly string[], w: Readonly<Record<string, number>>, gap: number): number {
  return ids.reduce((s, id) => s + (w[id] ?? 0), 0) + gap * Math.max(0, ids.length - 1)
}

/** The visible desks, in the row's order. Every desk when they all fit; otherwise a subset that leaves room for the "+N". */
export function fitDesks(i: FitInput): string[] {
  const { order, active, widths, gap, lastUsed } = i
  if (width(order, widths, gap) <= i.avail) return [...order]
  const budget = i.avail - i.plusWidth - gap
  const prev = new Set(i.visible.length > 0 ? i.visible : order)
  let vis = order.filter(id => prev.has(id) || id === active)
  // Too wide: the desk used longest ago leaves (never the active one).
  while (vis.length > 1 && width(vis, widths, gap) > budget) {
    const out = vis.filter(id => id !== active).sort((a, b) => (lastUsed[a] ?? 0) - (lastUsed[b] ?? 0))[0]
    if (out === undefined) break
    vis = vis.filter(id => id !== out)
  }
  // Room left: hidden desks come back, most recently used first, while they fit.
  const hidden = order.filter(id => !vis.includes(id)).sort((a, b) => (lastUsed[b] ?? 0) - (lastUsed[a] ?? 0))
  for (const id of hidden) {
    const next = order.filter(x => vis.includes(x) || x === id)
    if (width(next, widths, gap) <= budget) vis = next
  }
  return vis
}

/** The desks the "+N" lists: every desk not visible, in the row's order. */
export function overflowDesks(order: readonly string[], visible: readonly string[]): string[] {
  const v = new Set(visible)
  return order.filter(id => !v.has(id))
}

/**
 * Picking `picked` in the "+N": it takes the place of the visible desk used longest ago (the `active` one is
 * never replaced); the other visible desks stay. Returned in the row's order.
 */
export function pickFromOverflow(order: readonly string[], visible: readonly string[], picked: string, active: string, lastUsed: LastUsed): string[] {
  if (visible.includes(picked)) return order.filter(id => visible.includes(id))
  const out = visible.filter(id => id !== active).sort((a, b) => (lastUsed[a] ?? 0) - (lastUsed[b] ?? 0))[0]
  const next = new Set(visible.filter(id => id !== out))
  next.add(picked)
  return order.filter(id => next.has(id))
}

/** A new stamp for `id`: more recent than every other. */
export function touchUsed(lastUsed: LastUsed, id: string): Record<string, number> {
  const top = Math.max(0, ...Object.values(lastUsed))
  return { ...lastUsed, [id]: top + 1 }
}
