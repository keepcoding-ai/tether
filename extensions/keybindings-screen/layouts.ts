// The keybindings screen's pane type as layout.json knows it (moved from app/renderer/core-pane-layouts.ts, F9 slice 3).
// Pure: the manifest declares it, so a saved screen keeps its place (as a placeholder) with the extension off.
import { KEYBINDINGS_COMPONENT, KEYBINDINGS_PANEL_PREFIX, KEYBINDINGS_TAB, KEYBINDINGS_TITLE } from '../../app/shared/keybindings.ts'
import type { PaneTypeContribution } from '../types.ts'

export const KEYBINDINGS_SCREEN_LAYOUT: PaneTypeContribution = {
  id: 'keybindings', affinity: 'desk', idPrefix: KEYBINDINGS_PANEL_PREFIX, component: KEYBINDINGS_COMPONENT, tabComponent: KEYBINDINGS_TAB,
  optionsOf: p => ({ id: p.id, component: KEYBINDINGS_COMPONENT, tabComponent: KEYBINDINGS_TAB, title: KEYBINDINGS_TITLE, params: {} }),
}
