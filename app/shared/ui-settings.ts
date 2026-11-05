// App chrome preferences kept in settings.json under `ui` (main owns the file; the renderer applies them).
// Anything malformed reads as the defaults.

export interface UiSettings {
  /** The 2 px line in the active desk's colour along the top of the desk. */
  deskLine: boolean
  /** Note editors wrap long lines (VS Code's `editor.wordWrap` on/off); one preference for every editor. */
  wordWrap: boolean
}

export const DEFAULT_UI: UiSettings = { deskLine: true, wordWrap: true }

export function normalizeUi(raw: unknown): UiSettings {
  const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  return {
    deskLine: typeof o.deskLine === 'boolean' ? o.deskLine : DEFAULT_UI.deskLine,
    wordWrap: typeof o.wordWrap === 'boolean' ? o.wordWrap : DEFAULT_UI.wordWrap,
  }
}
