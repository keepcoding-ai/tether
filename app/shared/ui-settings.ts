// App chrome preferences kept in settings.json under `ui` (main owns the file; the renderer applies them).
// Anything malformed reads as the defaults.

export interface UiSettings {
  /** The 2 px line in the active desk's colour along the top of the desk. */
  deskLine: boolean
  /** The focused pane gets a folder-shaped outline in the desk colour (active tab + content), the drawer's colour in the drawer. */
  tabBorder: boolean
  /** Frames without focus are dimmed toward the desk background. */
  dimUnfocused: boolean
  /** Note editors wrap long lines (VS Code's `editor.wordWrap` on/off); one preference for every editor. */
  wordWrap: boolean
}

export const DEFAULT_UI: UiSettings = { deskLine: true, tabBorder: false, dimUnfocused: false, wordWrap: true }

export function normalizeUi(raw: unknown): UiSettings {
  const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  return {
    deskLine: typeof o.deskLine === 'boolean' ? o.deskLine : DEFAULT_UI.deskLine,
    tabBorder: typeof o.tabBorder === 'boolean' ? o.tabBorder : DEFAULT_UI.tabBorder,
    dimUnfocused: typeof o.dimUnfocused === 'boolean' ? o.dimUnfocused : DEFAULT_UI.dimUnfocused,
    wordWrap: typeof o.wordWrap === 'boolean' ? o.wordWrap : DEFAULT_UI.wordWrap,
  }
}
