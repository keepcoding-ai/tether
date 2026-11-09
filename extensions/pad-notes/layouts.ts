// The notes manager's pane type as layout.json knows it. Pure: the manifest declares it, so a saved manager keeps its place
// (as a placeholder) with the extension off. Component, tab and prefix end up in people's files and never change.
import type { PaneTypeContribution } from '../types.ts'

export const NOTES_MANAGER_COMPONENT = 'notes-manager'
export const NOTES_MANAGER_TAB = 'notes-manager-tab'
export const NOTES_MANAGER_PREFIX = 'notes-manager:'
export const NOTES_MANAGER_TITLE = 'Notas'

export function newNotesManagerId(now: number = Date.now()): string {
  return `${NOTES_MANAGER_PREFIX}${now.toString(36)}`
}

export const NOTES_MANAGER_LAYOUT: PaneTypeContribution = {
  id: 'notes-manager', idPrefix: NOTES_MANAGER_PREFIX, component: NOTES_MANAGER_COMPONENT, tabComponent: NOTES_MANAGER_TAB,
  optionsOf: p => ({ id: p.id, component: NOTES_MANAGER_COMPONENT, tabComponent: NOTES_MANAGER_TAB, title: NOTES_MANAGER_TITLE, params: {} }),
}
