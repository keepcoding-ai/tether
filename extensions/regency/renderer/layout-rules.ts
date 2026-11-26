// The Regency's layout, pure: what the pane keeps in its parameters (chosen channel, mode, folded desks...) and the ruler of
// the four tiers by the pane's width. No DOM. The search text is not kept here: it lives only in the open pane.
import { TREE_FILTERS, type TreeFilter } from '../model.ts'
import { DEFAULT_SYSTEM_SECTION, isSystemSection, type SystemSection } from '../system-rules.ts'

export type RegencyMode = 'manage' | 'immersion'
export type NarrowTab = 'waiting' | 'conversation' | 'tether'
export type RegencyView = 'desk' | 'agent'
export type Tier = 'mobile' | 'tablet' | 'desktop' | 'wide'

export interface RegencyLayout {
  channelId?: string
  mode: RegencyMode
  /** "Neste canal" open (it starts folded). */
  membersOpen: boolean
  /** Ids of folded desks (or agent groups). */
  collapsed: string[]
  /** The tab shown on the narrow screen. */
  narrowTab: NarrowTab
  /** "Por mesa" or "Por agente". */
  view: RegencyView
  /** The state filter of the tree. */
  filter: TreeFilter
  /** The open section of "Sistema", remembered (absent: never opened, it opens on the first). */
  system?: SystemSection
  /** The right column shows "Sistema" instead of the tether's (absent: the tether's). */
  column?: 'system'
  /** The tablet's one side column shows "Tether" (absent: "Esperam você" and "Conversas"). */
  side?: 'tether'
}

export const DEFAULT_LAYOUT: Readonly<RegencyLayout> = {
  mode: 'manage', membersOpen: false, collapsed: [], narrowTab: 'waiting', view: 'desk', filter: 'all',
}

const NARROW_TABS: readonly NarrowTab[] = ['waiting', 'conversation', 'tether']

/** Reads the pane's parameters, whatever they hold: what is not valid falls to the default. */
export function readLayout(params: unknown): RegencyLayout {
  const p = (typeof params === 'object' && params !== null ? params : {}) as Record<string, unknown>
  const channelId = typeof p.channelId === 'string' && p.channelId !== '' ? p.channelId : undefined
  const collapsed = Array.isArray(p.collapsed)
    ? [...new Set(p.collapsed.filter((x): x is string => typeof x === 'string' && x !== ''))]
    : []
  return {
    ...(channelId !== undefined ? { channelId } : {}),
    mode: p.mode === 'immersion' ? 'immersion' : 'manage',
    membersOpen: p.membersOpen === true,
    collapsed,
    narrowTab: NARROW_TABS.find(t => t === p.narrowTab) ?? DEFAULT_LAYOUT.narrowTab,
    view: p.view === 'agent' ? 'agent' : 'desk',
    filter: TREE_FILTERS.find(f => f === p.filter) ?? 'all',
    ...(isSystemSection(p.system) ? { system: p.system } : {}),
    ...(p.column === 'system' ? { column: 'system' as const } : {}),
    ...(p.side === 'tether' ? { side: 'tether' as const } : {}),
  }
}

/** The layout as the pane's parameters (JSON, no undefined keys). */
export function layoutParams(layout: RegencyLayout): Record<string, unknown> {
  return { ...layout, collapsed: [...layout.collapsed] }
}

export const toggleMode = (l: RegencyLayout): RegencyLayout => ({ ...l, mode: l.mode === 'immersion' ? 'manage' : 'immersion' })

export const toggleMembers = (l: RegencyLayout): RegencyLayout => ({ ...l, membersOpen: !l.membersOpen })

export function toggleCollapsed(l: RegencyLayout, id: string): RegencyLayout {
  return { ...l, collapsed: l.collapsed.includes(id) ? l.collapsed.filter(x => x !== id) : [...l.collapsed, id] }
}

/** Chooses the channel in the centre (`undefined` clears it). */
export function selectChannel(l: RegencyLayout, channelId: string | undefined): RegencyLayout {
  const { channelId: _drop, ...rest } = l
  return channelId ? { ...rest, channelId } : rest
}

export const setNarrowTab = (l: RegencyLayout, narrowTab: NarrowTab): RegencyLayout => ({ ...l, narrowTab })

/**
 * The phone's tab when the pane opens: "Esperam você" when someone waits (it is what unblocks the work); otherwise the
 * conversation, unless the person had left it on "Tether" (a kept "Esperam você" with nobody waiting falls to the conversation).
 */
export function openingTab(saved: NarrowTab, waiting: number): NarrowTab {
  if (waiting > 0) return 'waiting'
  return saved === 'tether' ? 'tether' : 'conversation'
}

export const setView = (l: RegencyLayout, view: RegencyView): RegencyLayout => ({ ...l, view })

export const setFilter = (l: RegencyLayout, filter: TreeFilter): RegencyLayout => ({ ...l, filter })

/** Which column the right side shows. */
export const rightColumnOf = (l: RegencyLayout): 'tether' | 'system' => (l.column === 'system' ? 'system' : 'tether')

/** The section "Sistema" shows: the remembered one, or the first. */
export const systemSectionOf = (l: RegencyLayout): SystemSection => l.system ?? DEFAULT_SYSTEM_SECTION

/** "Sistema" takes the right column, on the given section or the remembered one. */
export const openSystem = (l: RegencyLayout, section?: SystemSection): RegencyLayout => ({ ...l, column: 'system', system: section ?? systemSectionOf(l) })

/** Changes the open section (and keeps it); it also brings the column if it was not showing. */
export const setSystemSection = (l: RegencyLayout, section: SystemSection): RegencyLayout => openSystem(l, section)

/** "‹ Tether": the tether's column comes back; the section stays remembered. */
export function backToTether(l: RegencyLayout): RegencyLayout {
  const { column: _drop, ...rest } = l
  return rest
}

/** The tier by the pane's width in px: mobile < 768, tablet < 1280, desktop < 2560, wide from there. */
export function tierOf(widthPx: number): Tier {
  if (!(widthPx >= 768)) return 'mobile'
  if (widthPx < 1280) return 'tablet'
  if (widthPx < 2560) return 'desktop'
  return 'wide'
}

// ---------------------------------------------------------------- the four designs

/** The tablet's two places for its one side column. */
export type TabletSide = 'waiting' | 'tether'

/** What the tablet's side column shows (kept in the layout). */
export const tabletSideOf = (l: RegencyLayout): TabletSide => (l.side === 'tether' ? 'tether' : 'waiting')

export const otherSide = (s: TabletSide): TabletSide => (s === 'tether' ? 'waiting' : 'tether')

/** The side column shows `side`; the other comes as the panel over the conversation, on demand. */
export function setTabletSide(l: RegencyLayout, side: TabletSide): RegencyLayout {
  const { side: _drop, ...rest } = l
  return side === 'tether' ? { ...rest, side: 'tether' } : rest
}

/** The tablet's inner step: the same design, denser from 1024 px (the side column gets wider). Only the tablet has one. */
export function tierStep(widthPx: number): 'sm' | 'lg' | undefined {
  if (tierOf(widthPx) !== 'tablet') return undefined
  return widthPx >= 1024 ? 'lg' : 'sm'
}

/** A place of the Regency: what a column (or the tablet's panel over the conversation) shows. */
export type Place = 'waiting' | 'conversation' | 'quick' | 'tether' | 'system'

/** How a tier lays the Regency out: the columns left to right, the panel on demand, where the quick view and "Sistema" go. */
export interface TierPlan {
  columns: readonly Place[]
  /** The tablet: the place not in the side column, shown as a panel over the conversation when asked. */
  sheet?: 'waiting' | 'tether'
  /** A card docked over the conversation, or a fixed column beside it (the TV). */
  quick: 'card' | 'column'
  /** "Sistema" swaps the tree's column, or has its own rail always in view (the TV). */
  system: 'swap' | 'rail'
  /** The phone's bottom bar. */
  bottomBar: boolean
}

/**
 * The design of each tier over the same layout. Phone: one place at a time. Tablet: the conversation and one side column
 * (the other on demand). Desktop: the three columns. TV: the width works (who waits, the conversation at a reading measure,
 * the quick view's column, the tree, the rail of "Sistema"). Immersion keeps only the conversation, on every tier but the phone.
 */
export function tierPlan(tier: Tier, l: RegencyLayout): TierPlan {
  const tree: Place = rightColumnOf(l) === 'system' ? 'system' : 'tether'
  if (tier === 'mobile') {
    const place: Place = l.narrowTab === 'waiting' ? 'waiting' : l.narrowTab === 'tether' ? tree : 'conversation'
    return { columns: [place], quick: 'card', system: 'swap', bottomBar: true }
  }
  if (l.mode === 'immersion') return { columns: ['conversation'], quick: 'card', system: 'swap', bottomBar: false }
  if (tier === 'tablet') {
    const side = tabletSideOf(l)
    return { columns: [side === 'tether' ? tree : 'waiting', 'conversation'], sheet: otherSide(side), quick: 'card', system: 'swap', bottomBar: false }
  }
  if (tier === 'desktop') return { columns: ['waiting', 'conversation', tree], quick: 'card', system: 'swap', bottomBar: false }
  return { columns: ['waiting', 'conversation', 'quick', 'tether', 'system'], quick: 'column', system: 'rail', bottomBar: false }
}

/** What the tree's column shows on this tier: on the TV "Sistema" has its own rail, so the tree never steps aside. */
export const treeColumnOf = (l: RegencyLayout, tier: Tier): 'tether' | 'system' => (tier === 'wide' ? 'tether' : rightColumnOf(l))

/** "Sistema" is drawn now: in its rail on the TV (outside immersion), else when it holds the tree's column. */
export const systemShownOf = (l: RegencyLayout, tier: Tier): boolean =>
  tier === 'wide' ? l.mode === 'manage' : rightColumnOf(l) === 'system'

/**
 * The person opens "Sistema" (on `section`, or the kept one). TV: its rail is always in view, so only the section changes
 * (the tree's column keeps the tree, here and when the pane narrows). Tablet: it enters by the side column, which turns to
 * "Tether". Elsewhere: it takes the tree's column.
 */
export function openSystemOn(l: RegencyLayout, tier: Tier, section?: SystemSection): RegencyLayout {
  if (tier === 'wide') return { ...l, system: section ?? systemSectionOf(l) }
  const next = openSystem(l, section)
  return tier === 'tablet' ? setTabletSide(next, 'tether') : next
}

/**
 * The pane changes tier with the keyboard in one of the side places: the place stays in view. Entering the tablet with the
 * keyboard in the place the side column does not show, the column turns to it. Leaving the TV with the keyboard in the rail
 * of "Sistema", "Sistema" takes the tree's column (on the tablet, by the side column). The phone is left as it is.
 */
export function layoutOnTier(l: RegencyLayout, to: Tier, focusIn: 'waiting' | 'tether' | 'system' | undefined): RegencyLayout {
  if (l.mode !== 'manage' || focusIn === undefined || to === 'mobile' || to === 'wide') return l
  let next = l
  if (focusIn === 'system' && rightColumnOf(next) !== 'system') next = openSystem(next)
  if (to === 'tablet') {
    const want: TabletSide = focusIn === 'waiting' ? 'waiting' : 'tether'
    if (tabletSideOf(next) !== want) next = setTabletSide(next, want)
  }
  return next
}
