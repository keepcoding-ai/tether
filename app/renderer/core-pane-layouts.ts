// The layout side (PaneLayout, app/renderer/pane-registry.ts) of the core's pane kinds (the note's live in
// extensions/note/layouts.ts, the shortcuts screen's in extensions/keybindings-screen/layouts.ts). main.ts adds the
// live side to each and registers them. Names, prefixes and params are the ones already in people's layout.json.
import { EMPTY_COMPONENT, EMPTY_PANEL_PREFIX, EMPTY_TAB, EMPTY_TITLE, withEmpty } from '../shared/empty.ts'
import { EXTENSIONS_COMPONENT, EXTENSIONS_PANEL_PREFIX, EXTENSIONS_TAB, EXTENSIONS_TITLE } from '../shared/extensions-screen.ts'
import type { PaneLayout } from './pane-registry.ts'

export const TERMINAL_COMPONENT = 'terminal'
export const TERMINAL_TAB = 'slot-tab'

export const terminalLayout: PaneLayout = {
  id: 'terminal', idPrefix: '', component: TERMINAL_COMPONENT, tabComponent: TERMINAL_TAB, hasSlot: true,
  optionsOf: p => ({ id: p.id, component: TERMINAL_COMPONENT, tabComponent: TERMINAL_TAB, title: p.title ?? p.id, params: p.params ?? { slotId: p.id } }),
}

export const emptyLayout: PaneLayout = {
  id: 'empty', idPrefix: EMPTY_PANEL_PREFIX, component: EMPTY_COMPONENT, tabComponent: EMPTY_TAB, hasSlot: false,
  optionsOf: p => ({ id: p.id, component: EMPTY_COMPONENT, tabComponent: EMPTY_TAB, title: EMPTY_TITLE, params: p.params ?? withEmpty(undefined) }),
}

export const extensionsLayout: PaneLayout = {
  id: 'extensions', idPrefix: EXTENSIONS_PANEL_PREFIX, component: EXTENSIONS_COMPONENT, tabComponent: EXTENSIONS_TAB, hasSlot: false, affinity: 'desk',
  optionsOf: p => ({ id: p.id, component: EXTENSIONS_COMPONENT, tabComponent: EXTENSIONS_TAB, title: EXTENSIONS_TITLE, params: {} }),
}

/** In registration order: the fallback (terminal) last only by convention; lookup does not depend on order. */
export const CORE_PANE_LAYOUTS: readonly PaneLayout[] = [emptyLayout, extensionsLayout, terminalLayout]
