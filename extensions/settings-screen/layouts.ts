// The settings screen's pane type as layout.json knows it. Pure: the manifest declares it, so a saved screen keeps its
// place (as a placeholder) with the extension off.
import { SETTINGS_COMPONENT, SETTINGS_PANEL_PREFIX, SETTINGS_TAB, SETTINGS_TITLE } from '../../app/shared/settings-screen.ts'
import type { PaneTypeContribution } from '../types.ts'

export const SETTINGS_SCREEN_LAYOUT: PaneTypeContribution = {
  id: 'settings', idPrefix: SETTINGS_PANEL_PREFIX, component: SETTINGS_COMPONENT, tabComponent: SETTINGS_TAB,
  optionsOf: p => ({ id: p.id, component: SETTINGS_COMPONENT, tabComponent: SETTINGS_TAB, title: SETTINGS_TITLE, params: {} }),
}
