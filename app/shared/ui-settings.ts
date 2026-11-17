// App chrome preferences kept in settings.json under `ui` (main owns the file; the renderer applies them).
// Anything malformed reads as the defaults. The editors' word wrap moved to the note extension (`extensions.note.wordWrap`).

export interface UiSettings {
  /** The 2 px line in the active desk's colour along the top of the desk. */
  deskLine: boolean
  /** The focused pane gets a folder-shaped outline in the desk colour (active tab + content), the drawer's colour in the drawer. */
  tabBorder: boolean
  /** Frames without focus are dimmed toward the desk background. */
  dimUnfocused: boolean
  /** How strong the veil of the dim is; only matters while `dimUnfocused` is on. */
  dimLevel: DimLevel
  /** How the fixed desks (the Gaveta and the system desks' pills) show in the capsule: icon only, or icon and name. */
  fixedDeskLabel: FixedDeskLabel
  /** The × on the panes' tabs; off, a tab closes only through its context menu / commands. */
  tabClose: boolean
  /** Scoped side-bar pads ('panel', 'desk') open only for the panel / desk they were opened on (app/renderer/sidebar-rules.ts). */
  padsFollowFocus: boolean
}

export const FIXED_DESK_LABELS = ['icon', 'iconName'] as const
export type FixedDeskLabel = typeof FIXED_DESK_LABELS[number]

export const DIM_LEVELS = ['weak', 'medium', 'strong'] as const
export type DimLevel = typeof DIM_LEVELS[number]

export const DEFAULT_UI: UiSettings = { deskLine: true, tabBorder: false, dimUnfocused: false, dimLevel: 'medium', fixedDeskLabel: 'iconName', tabClose: true, padsFollowFocus: false }

export function normalizeUi(raw: unknown): UiSettings {
  const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  return {
    deskLine: typeof o.deskLine === 'boolean' ? o.deskLine : DEFAULT_UI.deskLine,
    tabBorder: typeof o.tabBorder === 'boolean' ? o.tabBorder : DEFAULT_UI.tabBorder,
    dimUnfocused: typeof o.dimUnfocused === 'boolean' ? o.dimUnfocused : DEFAULT_UI.dimUnfocused,
    // A settings file from before the levels has no dimLevel: a dim that was on reads as the medium level.
    dimLevel: DIM_LEVELS.find(l => l === o.dimLevel) ?? DEFAULT_UI.dimLevel,
    fixedDeskLabel: FIXED_DESK_LABELS.find(l => l === o.fixedDeskLabel) ?? DEFAULT_UI.fixedDeskLabel,
    tabClose: typeof o.tabClose === 'boolean' ? o.tabClose : DEFAULT_UI.tabClose,
    padsFollowFocus: typeof o.padsFollowFocus === 'boolean' ? o.padsFollowFocus : DEFAULT_UI.padsFollowFocus,
  }
}
