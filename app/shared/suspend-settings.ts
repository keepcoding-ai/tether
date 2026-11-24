// The settings of the panes suspended to save resources (app/renderer/suspend.ts): keys, defaults and the reader, shared by
// the core's settings node (core-settings.ts) and the renderer, so the page and the sweep cannot drift. Pure.

/** settings.json keys (core settings, section "Desempenho"). */
export const SUSPEND_ENABLED_KEY = 'performance.suspend.enabled'
export const SUSPEND_IDLE_KEY = 'performance.suspend.idleMinutes'

export interface SuspendSettings {
  enabled: boolean
  /** Minutes of idleness (no turn, no use by the person) before a pane is suspended. */
  idleMinutes: number
}

export const DEFAULT_SUSPEND: SuspendSettings = { enabled: true, idleMinutes: 60 }
export const SUSPEND_IDLE_MIN = 5
export const SUSPEND_IDLE_MAX = 24 * 60

/** The settings from settings.json's values; anything missing or out of range falls back to the default (or the bound). */
export function normalizeSuspend(get: (key: string) => unknown): SuspendSettings {
  const enabled = get(SUSPEND_ENABLED_KEY)
  const idle = get(SUSPEND_IDLE_KEY)
  return {
    enabled: typeof enabled === 'boolean' ? enabled : DEFAULT_SUSPEND.enabled,
    idleMinutes: typeof idle === 'number' && Number.isFinite(idle) ? Math.min(SUSPEND_IDLE_MAX, Math.max(SUSPEND_IDLE_MIN, idle)) : DEFAULT_SUSPEND.idleMinutes,
  }
}
