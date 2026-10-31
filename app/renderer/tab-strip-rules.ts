// Which tabs a pane's tab strip shows, pure and unit-tested (the DOM side is tab-strip.ts).
//
// Tabs shrink down to a minimum width; when even that does not fit, the strip keeps a subset and one fixed
// "+N" at the right lists the rest. The active tab never leaves. Who leaves first is the tab used longest
// ago, and picking a tab in the "+N" puts it in place of the visible tab used longest ago; the others stay.
// Fitting is asked of an oracle (the DOM measures the real strip), so shrinking and titles need no model here.

/** Use stamps per panel id (bigger = more recent). A tab never used counts by its place: earlier wins. */
export type TabUse = ReadonlyMap<string, number>

function stamp(used: TabUse, order: readonly string[], id: string): number {
  // Never used: below every real stamp (>= 1), earlier tabs above later ones.
  return used.get(id) ?? -order.indexOf(id)
}

/** The visible tab used longest ago (never the active one); undefined when only the active one is visible. */
export function leastRecent(order: readonly string[], visible: readonly string[], active: string | undefined, used: TabUse): string | undefined {
  return visible.filter(id => id !== active).sort((a, b) => stamp(used, order, a) - stamp(used, order, b))[0]
}

/**
 * The visible tabs, in the strip's order: every tab while `fits` says so; otherwise the tab used longest ago
 * leaves, one at a time, until it fits or only the active one is left.
 */
export function fitTabs(order: readonly string[], active: string | undefined, used: TabUse, fits: (visible: readonly string[]) => boolean): string[] {
  let vis = [...order]
  while (vis.length > 1 && !fits(vis)) {
    const out = leastRecent(order, vis, active, used)
    if (out === undefined) break
    vis = vis.filter(id => id !== out)
  }
  return vis
}

/** The tabs the "+N" lists: every tab not visible, in the strip's order. */
export function hiddenTabs(order: readonly string[], visible: readonly string[]): string[] {
  const v = new Set(visible)
  return order.filter(id => !v.has(id))
}

/**
 * Picking `picked` in the "+N": the index it moves to, the place of the visible tab used longest ago, so it
 * shows where that one was. Undefined when it is already visible or nothing can be replaced.
 */
export function pickIndex(order: readonly string[], visible: readonly string[], picked: string, active: string | undefined, used: TabUse): number | undefined {
  if (visible.includes(picked)) return undefined
  const out = leastRecent(order, visible, active, used)
  if (out === undefined) return undefined
  return order.indexOf(out)
}

/** A new stamp for `id`, more recent than every other. */
export function touchTab(used: Map<string, number>, id: string): void {
  used.set(id, Math.max(0, ...used.values()) + 1)
}
