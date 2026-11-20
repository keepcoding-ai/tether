// The note extension's pane types as layout.json knows them (moved from app/renderer/core-pane-layouts.ts, F9 slice 1):
// the note editor, the markdown preview and the HTML preview. Names, prefixes and params are the ones already in
// people's layout.json and never change. Pure (no DOM, no dockview at run time): the manifest declares them, so the core
// can keep a saved pane of these types in place even with the extension off.
import { NOTE_COMPONENT, NOTE_PANEL_PREFIX, NOTE_TAB } from '../../app/shared/notes.ts'
import { HTML_PREVIEW_COMPONENT, IMAGE_PREVIEW_COMPONENT, PREVIEW_COMPONENT, PREVIEW_PANEL_PREFIX, PREVIEW_TAB, previewKindOf, previewParams, previewTitle, withPreview } from '../../app/shared/preview.ts'
import type { PaneOptionsShape, PaneTypeContribution, SavedPaneShape } from '../types.ts'

/** The dockview options of a preview pane (markdown drawn by the app; HTML in an always-rendered webview: a running page must not restart when its pane is activated or moved). */
export function previewPaneOptions(id: string, path: string, kind: 'md' | 'html' | 'image', params: Record<string, unknown> | undefined, title?: string): PaneOptionsShape {
  const common = { id, tabComponent: PREVIEW_TAB, title: title ?? previewTitle(path), params: params ?? withPreview(undefined, { path, ...(kind === 'html' || kind === 'image' ? { kind } : {}) }) }
  if (kind === 'image') return { ...common, component: IMAGE_PREVIEW_COMPONENT }
  return kind === 'html' ? { ...common, component: HTML_PREVIEW_COMPONENT, renderer: 'always' } : { ...common, component: PREVIEW_COMPONENT }
}

const previewOptionsOf = (p: SavedPaneShape): PaneOptionsShape => previewPaneOptions(p.id, previewParams(p.params)?.path ?? '', previewKindOf(p.params), p.params, p.title ?? undefined)

export const noteLayout: PaneTypeContribution = {
  id: 'note', idPrefix: NOTE_PANEL_PREFIX, component: NOTE_COMPONENT, tabComponent: NOTE_TAB,
  optionsOf: p => ({ id: p.id, component: NOTE_COMPONENT, tabComponent: NOTE_TAB, title: p.title ?? p.id, params: p.params ?? {} }),
}

export const mdPreviewLayout: PaneTypeContribution = {
  id: 'md-preview', idPrefix: PREVIEW_PANEL_PREFIX, component: PREVIEW_COMPONENT, tabComponent: PREVIEW_TAB,
  owns: p => previewKindOf(p.params) === 'md', optionsOf: previewOptionsOf,
}

export const htmlPreviewLayout: PaneTypeContribution = {
  id: 'html-preview', idPrefix: PREVIEW_PANEL_PREFIX, component: HTML_PREVIEW_COMPONENT, tabComponent: PREVIEW_TAB,
  owns: p => previewKindOf(p.params) === 'html', optionsOf: previewOptionsOf,
}

export const imagePreviewLayout: PaneTypeContribution = {
  id: 'image-preview', idPrefix: PREVIEW_PANEL_PREFIX, component: IMAGE_PREVIEW_COMPONENT, tabComponent: PREVIEW_TAB,
  owns: p => previewKindOf(p.params) === 'image', optionsOf: previewOptionsOf,
}

/** In registration order (the html and image previews before the markdown one: the markdown layout owns whatever has no other kind). */
export const NOTE_PANE_LAYOUTS: readonly PaneTypeContribution[] = [htmlPreviewLayout, imagePreviewLayout, mdPreviewLayout, noteLayout]
