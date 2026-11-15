// The replace preview's pane type as layout.json knows it. Pure: the manifest declares it, so a saved preview keeps its
// place (as a placeholder) with the extension off. The preview is never restored with content: a pane of this type that
// comes back from layout.json closes itself as soon as it is created (renderer/preview-panel.ts).
import type { PaneTypeContribution } from '../types.ts'
import { PREVIEW_COMPONENT, PREVIEW_FALLBACK_TITLE, PREVIEW_PREFIX, PREVIEW_TAB, PREVIEW_TYPE } from './renderer/preview-rules.ts'

export const REPLACE_PREVIEW_LAYOUT: PaneTypeContribution = {
  id: PREVIEW_TYPE, affinity: 'desk', idPrefix: PREVIEW_PREFIX, component: PREVIEW_COMPONENT, tabComponent: PREVIEW_TAB,
  optionsOf: p => ({ id: p.id, component: PREVIEW_COMPONENT, tabComponent: PREVIEW_TAB, title: p.title ?? PREVIEW_FALLBACK_TITLE, params: {} }),
}
