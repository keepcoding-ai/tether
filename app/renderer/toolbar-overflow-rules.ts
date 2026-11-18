// What the toolbar keeps on screen when its two sides outgrow their room (app/renderer/toolbar-overflow.ts measures, this
// decides): pure, no DOM. The capsule sits on the window's true centre (1fr auto 1fr), so it can only be as wide as the
// toolbar minus twice the WIDER side: shrinking the narrower side gains nothing. Each step therefore takes from the wider
// side: on the left the unpinned action icons, last to first; on the right the session search, which becomes a magnifier icon.

/** Room the capsule needs at least (the Gaveta pill, one desk, the "+N"); below it the sides give way. */
export const MIN_CENTER = 320
/** The gap each side keeps from the capsule (desk-switch.ts SIDE_MARGIN). */
export const SIDE_MARGIN = 12

export interface ToolbarMeasure {
  /** The toolbar's inner width (its padding excluded). */
  inner: number
  /** The left actions' natural widths, in order; pinned ones (state, alert, pressed) are never collapsed. */
  left: readonly { width: number; pinned: boolean }[]
  /** The gap between items in a side. */
  gap: number
  /** The right side without the search. */
  rightRest: number
  /** The search as a box and as an icon, margins included. */
  searchFull: number
  searchIcon: number
}

export interface ToolbarPlan {
  /** Indexes of the left actions that leave the bar (they stay in the ☰ menu). */
  collapsed: number[]
  /** The search is only a magnifier icon, expanding on click. */
  compactSearch: boolean
}

export function planToolbar(m: ToolbarMeasure): ToolbarPlan {
  const collapsed = new Set<number>()
  let compactSearch = false
  const leftWidth = (): number => {
    const shown = m.left.filter((_, i) => !collapsed.has(i))
    return shown.reduce((n, it) => n + it.width, 0) + Math.max(0, shown.length - 1) * m.gap
  }
  const rightWidth = (): number => m.rightRest + (compactSearch ? m.searchIcon : m.searchFull)
  const fits = (): boolean => 2 * (Math.max(leftWidth(), rightWidth()) + SIDE_MARGIN) + MIN_CENTER <= m.inner
  const nextLeft = (): number => {
    for (let i = m.left.length - 1; i >= 0; i--) if (!collapsed.has(i) && !m.left[i]!.pinned && m.left[i]!.width > 0) return i
    return -1
  }
  while (!fits()) {
    const l = leftWidth(), r = rightWidth()
    const i = nextLeft()
    const leftWider = l >= r
    if (leftWider && i >= 0) collapsed.add(i)
    else if (!leftWider && !compactSearch) compactSearch = true
    else break // the wider side has nothing left to give: the capsule shrinks itself (desk-switch.ts)
  }
  return { collapsed: [...collapsed].sort((a, b) => a - b), compactSearch }
}
