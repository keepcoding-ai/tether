// The Regency: a system desk with one pane, `regency:main`, in three columns (who waits for the person and the conversations;
// the chosen channel; the members and the tree of desks and panes). It reads the desk tree of the core, the owner board of
// for-agents and the channel feed of channels; with channels off it is not there (it requires it). Ids (desk, pane, pane
// type) are saved in layout.json and never change.
import type { ExtensionManifest, PaneTypeContribution } from '../types.ts'

export const EXT_ID = 'regency'
export const DESK_ID = 'regency.main'
export const REGENCY_PREFIX = 'regency:'
export const REGENCY_PANE_ID = 'regency:main'
export const REGENCY_COMPONENT = 'regency-pane'
export const REGENCY_TAB = 'regency-pane-tab'
export const REGENCY_TITLE = 'Regência'

/** The pane type as layout.json knows it (declared, so a saved Regency keeps its place with the extension off). */
export const REGENCY_LAYOUT: PaneTypeContribution = {
  id: 'regency', affinity: 'desk', idPrefix: REGENCY_PREFIX, component: REGENCY_COMPONENT, tabComponent: REGENCY_TAB,
  optionsOf: p => ({ id: p.id, component: REGENCY_COMPONENT, tabComponent: REGENCY_TAB, title: REGENCY_TITLE, params: p.params ?? {} }),
}

export const manifest: ExtensionManifest = {
  id: EXT_ID,
  version: '0.1.0',
  displayName: 'Regência',
  description: 'Uma mesa para reger o trabalho: quem espera você, as conversas, o canal escolhido e todas as mesas com as guias.',
  hosts: ['renderer'],
  optional: true,
  requires: ['channels'],
  contributes: {
    paneTypes: [REGENCY_LAYOUT],
    systemDesks: [{ id: DESK_ID, title: REGENCY_TITLE, icon: 'columns', color: 'purple' }],
  },
}
