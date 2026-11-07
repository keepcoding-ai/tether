// The Faults screen's pane type as layout.json knows it. Pure: the manifest declares it, so a saved screen keeps its
// place (as a placeholder) with the extension off. The ids end up in people's layout files and never change.
import type { PaneTypeContribution } from '../types.ts'

export const FAULTS_COMPONENT = 'faults'
export const FAULTS_TAB = 'faults-tab'
export const FAULTS_PANEL_PREFIX = 'faults:'
/** What the tab shows. */
export const FAULTS_TITLE = 'Falhas'

/** A fresh pane id (one screen at a time is the rule, but the id stays unique for the layout). */
export const newFaultsPanelId = (now: number = Date.now()): string => `${FAULTS_PANEL_PREFIX}${now.toString(36)}`

export const FAULTS_SCREEN_LAYOUT: PaneTypeContribution = {
  id: 'faults', idPrefix: FAULTS_PANEL_PREFIX, component: FAULTS_COMPONENT, tabComponent: FAULTS_TAB,
  optionsOf: p => ({ id: p.id, component: FAULTS_COMPONENT, tabComponent: FAULTS_TAB, title: FAULTS_TITLE, params: {} }),
}
