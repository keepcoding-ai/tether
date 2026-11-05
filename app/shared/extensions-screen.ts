// The "Extensões" screen's identity in layout.json (F9): component, tab and id prefix. Never renamed once released.
export const EXTENSIONS_COMPONENT = 'extensions'
export const EXTENSIONS_TAB = 'extensions-tab'
export const EXTENSIONS_PANEL_PREFIX = 'extensions:'
export const EXTENSIONS_TITLE = 'Extensões'

export function newExtensionsPanelId(now: number = Date.now()): string {
  return `${EXTENSIONS_PANEL_PREFIX}${now.toString(36)}`
}
