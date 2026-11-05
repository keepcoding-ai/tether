// The markdown preview tab (F5): a pane that shows a note's file rendered (app/renderer/preview-panel.ts). Like a
// note it has no slot in tetherd: the pane id carries a prefix the layout code recognizes (a restore never prunes
// it as a slot the daemon does not know) and its state for the next launch lives in the pane's params, tied to the
// file: the path, and where the preview was scrolled (a fraction of the document, used until the sync says better).
import { noteTitle } from './notes.ts'

export const PREVIEW_COMPONENT = 'md-preview'
export const PREVIEW_TAB = 'md-preview-tab'
export const PREVIEW_PANEL_PREFIX = 'preview:'

export function isPreviewPanelId(id: string): boolean {
  return id.startsWith(PREVIEW_PANEL_PREFIX)
}

/** A fresh pane id: time-ordered plus a random tail. */
export function newPreviewPanelId(now: number = Date.now(), random: number = Math.random()): string {
  return `${PREVIEW_PANEL_PREFIX}${now.toString(36).padStart(9, '0')}-${Math.floor(random * 36 ** 4).toString(36).padStart(4, '0')}`
}

export interface PreviewParams {
  preview: {
    /** Absolute path of the markdown file. */
    path: string
    /** The source line (0-based, fractional) at the top of the preview when last persisted. */
    line?: number
  }
}

/** The preview part of a pane's params, when the pane is a preview with a path. */
export function previewParams(params: unknown): PreviewParams['preview'] | undefined {
  if (!params || typeof params !== 'object') return undefined
  const preview = (params as { preview?: unknown }).preview
  if (!preview || typeof preview !== 'object') return undefined
  const { path, line } = preview as { path?: unknown; line?: unknown }
  if (typeof path !== 'string' || path === '') return undefined
  return { path, ...(typeof line === 'number' && Number.isFinite(line) && line >= 0 ? { line } : {}) }
}

export function withPreview(params: Record<string, unknown> | undefined, preview: PreviewParams['preview']): Record<string, unknown> {
  return { ...(params ?? {}), preview: { path: preview.path, ...(preview.line !== undefined ? { line: preview.line } : {}) } }
}

/** What the tab shows: "Prévia: nome.md". */
export function previewTitle(path: string): string {
  return `Prévia: ${noteTitle(path)}`
}

const MARKDOWN_EXTENSION = /\.(md|markdown|mdown|mkd|mdx)$/i

/** Whether a file is one the preview can render (VS Code shows its preview button for markdown files). */
export function isMarkdownPath(path: string): boolean {
  return MARKDOWN_EXTENSION.test(path)
}
