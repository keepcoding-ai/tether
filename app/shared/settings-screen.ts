// The "Configurações" screen's identity in layout.json (settings plan, slice 3): component, tab and id prefix. Never
// renamed once released. The screen itself is the settings-screen extension (extensions/settings-screen/).
export const SETTINGS_COMPONENT = 'settings'
export const SETTINGS_TAB = 'settings-tab'
export const SETTINGS_PANEL_PREFIX = 'settings:'
export const SETTINGS_TITLE = 'Configurações'

export function isSettingsPanelId(id: string): boolean {
  return id.startsWith(SETTINGS_PANEL_PREFIX)
}

export function newSettingsPanelId(now: number = Date.now()): string {
  return `${SETTINGS_PANEL_PREFIX}${now.toString(36)}`
}
