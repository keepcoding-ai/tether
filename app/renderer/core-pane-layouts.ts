// The layout side (PaneLayout, app/renderer/pane-registry.ts) of the pane kinds that exist today. main.ts adds the
// live side to each and registers them. Names, prefixes and params are the ones already in people's layout.json.
import type { AddPanelOptions } from 'dockview-core'
import { EMPTY_COMPONENT, EMPTY_PANEL_PREFIX, EMPTY_TAB, EMPTY_TITLE, withEmpty } from '../shared/empty.ts'
import { KEYBINDINGS_COMPONENT, KEYBINDINGS_PANEL_PREFIX, KEYBINDINGS_TAB, KEYBINDINGS_TITLE } from '../shared/keybindings.ts'
import { NOTE_COMPONENT, NOTE_PANEL_PREFIX, NOTE_TAB } from '../shared/notes.ts'
import { HTML_PREVIEW_COMPONENT, PREVIEW_COMPONENT, PREVIEW_PANEL_PREFIX, PREVIEW_TAB, previewKindOf, previewParams, previewTitle, withPreview } from '../shared/preview.ts'
import type { PaneLayout, SavedPane } from './pane-registry.ts'

export const TERMINAL_COMPONENT = 'terminal'
export const TERMINAL_TAB = 'slot-tab'

/** The dockview options of a preview pane (markdown drawn by the app; HTML in an always-rendered webview). */
export function previewPaneOptions(id: string, path: string, kind: 'md' | 'html', params: Record<string, unknown> | undefined, title?: string): AddPanelOptions {
  const common = { id, tabComponent: PREVIEW_TAB, title: title ?? previewTitle(path), params: params ?? withPreview(undefined, { path, ...(kind === 'html' ? { kind: 'html' as const } : {}) }) }
  return kind === 'html' ? { ...common, component: HTML_PREVIEW_COMPONENT, renderer: 'always' } : { ...common, component: PREVIEW_COMPONENT }
}

const previewOptionsOf = (p: SavedPane): AddPanelOptions => previewPaneOptions(p.id, previewParams(p.params)?.path ?? '', previewKindOf(p.params), p.params, p.title ?? undefined)

export const terminalLayout: PaneLayout = {
  id: 'terminal', idPrefix: '', component: TERMINAL_COMPONENT, tabComponent: TERMINAL_TAB, hasSlot: true,
  optionsOf: p => ({ id: p.id, component: TERMINAL_COMPONENT, tabComponent: TERMINAL_TAB, title: p.title ?? p.id, params: p.params ?? { slotId: p.id } }),
}

export const noteLayout: PaneLayout = {
  id: 'note', idPrefix: NOTE_PANEL_PREFIX, component: NOTE_COMPONENT, tabComponent: NOTE_TAB, hasSlot: false,
  optionsOf: p => ({ id: p.id, component: NOTE_COMPONENT, tabComponent: NOTE_TAB, title: p.title ?? p.id, params: p.params ?? {} }),
}

export const mdPreviewLayout: PaneLayout = {
  id: 'md-preview', idPrefix: PREVIEW_PANEL_PREFIX, component: PREVIEW_COMPONENT, tabComponent: PREVIEW_TAB, hasSlot: false,
  owns: p => previewKindOf(p.params) === 'md', optionsOf: previewOptionsOf,
}

export const htmlPreviewLayout: PaneLayout = {
  id: 'html-preview', idPrefix: PREVIEW_PANEL_PREFIX, component: HTML_PREVIEW_COMPONENT, tabComponent: PREVIEW_TAB, hasSlot: false,
  owns: p => previewKindOf(p.params) === 'html', optionsOf: previewOptionsOf,
}

export const emptyLayout: PaneLayout = {
  id: 'empty', idPrefix: EMPTY_PANEL_PREFIX, component: EMPTY_COMPONENT, tabComponent: EMPTY_TAB, hasSlot: false,
  optionsOf: p => ({ id: p.id, component: EMPTY_COMPONENT, tabComponent: EMPTY_TAB, title: EMPTY_TITLE, params: p.params ?? withEmpty(undefined) }),
}

export const keybindingsLayout: PaneLayout = {
  id: 'keybindings', idPrefix: KEYBINDINGS_PANEL_PREFIX, component: KEYBINDINGS_COMPONENT, tabComponent: KEYBINDINGS_TAB, hasSlot: false,
  optionsOf: p => ({ id: p.id, component: KEYBINDINGS_COMPONENT, tabComponent: KEYBINDINGS_TAB, title: KEYBINDINGS_TITLE, params: {} }),
}

/** In registration order: the fallback (terminal) last only by convention; lookup does not depend on order. */
export const CORE_PANE_LAYOUTS: readonly PaneLayout[] = [emptyLayout, keybindingsLayout, htmlPreviewLayout, mdPreviewLayout, noteLayout, terminalLayout]
