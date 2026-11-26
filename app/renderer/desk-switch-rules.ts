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

export interface CapsuleFitInput extends FitInput {
  /** Room for the segments when the fixed pills (Gaveta, system desks) are icon-only, px. Never below `avail`. */
  availCompact: number
}

/**
 * The fixed pills keep their names while every common desk fits beside them. When some desk would fall into the "+N",
 * the pills shrink to their icons (the active one keeps its name, which the caller measures into `availCompact`) and
 * the room they give back goes to the desks. Never fewer desks visible than with the names.
 */
export function fitCapsule(i: CapsuleFitInput): { visible: string[]; compactPills: boolean } {
  const labeled = fitDesks(i)
  if (labeled.length === i.order.length) return { visible: labeled, compactPills: false }
  const compact = fitDesks({ ...i, avail: Math.max(i.avail, i.availCompact) })
  if (compact.length < labeled.length) return { visible: labeled, compactPills: false }
  return { visible: compact, compactPills: true }
}

/** The desks the "+N" lists: every desk not visible, in the row's order. */
export function overflowDesks(order: readonly string[], visible: readonly string[]): string[] {
  const v = new Set(visible)
  return order.filter(id => !v.has(id))
}

/** A seal as a "+N" row draws it beside the desk's name: the pill's glyph, label, hue, variant and tooltip; never a click of its own (the row picks the desk). */
export interface OverflowSeal { icon: string; hue?: number; label?: string; tooltip: string; variant?: 'solid' | 'struck' }

export interface OverflowRow { id: string; name: string; attention: number; seals: OverflowSeal[] }

/**
 * The rows of the "+N" menu, in the row's order: each hidden desk's name, its attention count, and the seals its pill wears
 * (the owner's among them), drawn the same so a desk keeps its owner's mark when it leaves the strip.
 */
export function overflowRows(
  hidden: readonly string[],
  nameOf: (id: string) => string,
  attentionOf: (id: string) => number,
  sealsOf: (id: string) => readonly { icon: string; hue?: number | undefined; label?: string | undefined; tooltip: string; variant?: 'solid' | 'struck' | undefined }[],
): OverflowRow[] {
  return hidden.map(id => ({
    id,
    name: nameOf(id),
    attention: attentionOf(id),
    seals: sealsOf(id).map(s => ({
      icon: s.icon,
      tooltip: s.tooltip,
      ...(s.hue !== undefined ? { hue: s.hue } : {}),
      ...(s.label ? { label: s.label } : {}),
      ...(s.variant === 'struck' ? { variant: 'struck' as const } : {}),
    })),
  }))
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

// ---------- skip-if-unchanged keys ----------
//
// A daemon `state` event repaints the capsule (its marks may have changed), and most of them change nothing the capsule
// shows. Measuring the row forces the browser to lay out the whole window synchronously, several times per pass, so the
// capsule compares these keys first: the same structure and the same widths keep the fit (no reads at all), and the same
// paint key writes nothing.

/** What one desk's segment shows: the desk and its mark, read once per pass. */
export interface SegView {
  id: string
  name: string
  color: string
  active: boolean
  done: number
  waiting: number
  /** A pane of the desk is mid-turn (the quiet green dot, shown only without attention). */
  busy: boolean
  /** The hue of the first agent owner a pane of the desk waits for (the diamond, no number); undefined when none. */
  routedHue?: number
  /** The seals' lines, listed in the tooltip. */
  lines: readonly string[]
}

/** The row's structure: desks (order, names, colours, sleep) and the active one. A change re-fits right away. */
export function structureKey(desks: readonly { id: string; name: string; color: string; asleep?: boolean }[], active: string): string {
  return JSON.stringify([active, desks.map(d => [d.id, d.name, d.color, d.asleep === true])])
}

/** What changes a segment's natural width or the fit: names, the active desk, the badge's text, the busy dot. */
export function measureKey(views: readonly SegView[]): string {
  return JSON.stringify(views.map(v => {
    const total = v.done + v.waiting
    return [v.id, v.name, v.active, total > 0 ? String(total) : v.busy ? '•' : '', v.routedHue !== undefined]
  }))
}

/**
 * Everything the visible segments paint, in order: text, colours, badge tone, tooltip lines and the shortcut hint of
 * each position (`hints[i]` for the i-th desk of `views`). Equal keys mean the row on screen is already right.
 */
export function paintKey(visible: readonly string[], views: readonly SegView[], hints: readonly string[]): string {
  const shown = new Set(visible)
  return JSON.stringify(views.flatMap((v, i) => shown.has(v.id)
    ? [[v.id, v.name, v.color, v.active, v.done, v.waiting, v.busy, v.routedHue ?? null, v.lines, hints[i] ?? '']]
    : []))
}
