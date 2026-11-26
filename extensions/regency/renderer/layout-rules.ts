// The Regency's layout, pure: what the pane keeps in its parameters (chosen channel, mode, folded desks...) and the ruler of
// the four tiers by the pane's width. No DOM, no import.

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
}

export const DEFAULT_LAYOUT: Readonly<RegencyLayout> = {
  mode: 'manage', membersOpen: false, collapsed: [], narrowTab: 'waiting', view: 'desk',
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

export const setView = (l: RegencyLayout, view: RegencyView): RegencyLayout => ({ ...l, view })

/** The tier by the pane's width in px: mobile < 768, tablet < 1280, desktop < 2560, wide from there. */
export function tierOf(widthPx: number): Tier {
  if (!(widthPx >= 768)) return 'mobile'
  if (widthPx < 1280) return 'tablet'
  if (widthPx < 2560) return 'desktop'
  return 'wide'
}
