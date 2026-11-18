// What the toolbar keeps on screen when its two sides outgrow their room (app/renderer/toolbar-overflow.ts measures, this
// decides): pure, no DOM. The capsule sits on the window's true centre (1fr auto 1fr), so it can only be as wide as the
// toolbar minus twice the WIDER side: shrinking the narrower side gains nothing.
//   Stage 1 (gradual): the wider side gives first. Left: the unpinned action icons, last to first. Right: the session
//   search becomes a magnifier icon.
//   Stage 2 (all at once, the robust one): when stage 1 still leaves the capsule too little, every unpinned icon of both
//   sides goes, the search included. What is always left: ☰, the bell, and any icon showing an alert.
// Every icon that can go has an item in the ☰ menu (app-menu.ts), and the search keeps its chord.

/** Room the capsule is given at least (the Gaveta pill, a desk, the "+N", the add button, its chrome): deliberately generous. */
export const MIN_CENTER = 380
/** The gap each side keeps from the capsule (desk-switch.ts SIDE_MARGIN is 12; the extra is slack for what the measure misses). */
export const SIDE_MARGIN = 16

export interface ToolbarItem {
  width: number
  /** Never collapses: ☰, the bell, an alert (connection down, a status icon in warn/error), a pressed toggle, a counter. */
  pinned: boolean
}

export interface ToolbarMeasure {
  /** The toolbar's inner width (its padding excluded). */
  inner: number
  left: readonly ToolbarItem[]
  /** The right side's items except the search, in order. */
  right: readonly ToolbarItem[]
  /** The gap between items in a side. */
  gap: number
  /** The search as a box and as an icon, margins and gap included. */
  searchFull: number
  searchIcon: number
}

export interface ToolbarPlan {
  collapsedLeft: number[]
  collapsedRight: number[]
  /** The search is only a magnifier icon, expanding on click. */
  compactSearch: boolean
  /** The search is not on the bar at all (the chord and the ☰ item still open it over the capsule). */
  hideSearch: boolean
}

const sideWidth = (items: readonly ToolbarItem[], gone: ReadonlySet<number>, gap: number, extra: number): number => {
  const shown = items.filter((it, i) => !gone.has(i) && it.width > 0)
  return shown.reduce((n, it) => n + it.width, 0) + shown.length * gap + extra
}

export function planToolbar(m: ToolbarMeasure): ToolbarPlan {
  const left = new Set<number>(), right = new Set<number>()
  let compactSearch = false
  let hideSearch = false
  const searchW = (): number => (hideSearch ? 0 : compactSearch ? m.searchIcon : m.searchFull)
  const l = (): number => sideWidth(m.left, left, m.gap, 0)
  const r = (): number => sideWidth(m.right, right, m.gap, searchW())
  const fits = (): boolean => 2 * (Math.max(l(), r()) + SIDE_MARGIN) + MIN_CENTER <= m.inner
  const nextLeft = (): number => {
    for (let i = m.left.length - 1; i >= 0; i--) if (!left.has(i) && !m.left[i]!.pinned && m.left[i]!.width > 0) return i
    return -1
  }
  while (!fits()) {
    const i = nextLeft()
    if (l() >= r() && i >= 0) left.add(i)
    else if (r() > l() && !compactSearch) compactSearch = true
    else break
  }
  if (!fits()) {
    m.left.forEach((it, i) => { if (!it.pinned) left.add(i) })
    m.right.forEach((it, i) => { if (!it.pinned) right.add(i) })
    compactSearch = true
    hideSearch = true
  }
  return { collapsedLeft: [...left].sort((a, b) => a - b), collapsedRight: [...right].sort((a, b) => a - b), compactSearch, hideSearch }
}
