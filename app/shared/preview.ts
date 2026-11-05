// The markdown preview tab (F5): a pane that shows a note's file rendered (app/renderer/preview-panel.ts). Like a
// note it has no slot in tetherd: the pane id carries a prefix the layout code recognizes (a restore never prunes
// it as a slot the daemon does not know) and its state for the next launch lives in the pane's params, tied to the
// file: the path, and where the preview was scrolled (a fraction of the document, used until the sync says better).
import { noteTitle } from './notes.ts'

export const PREVIEW_COMPONENT = 'md-preview'
export const PREVIEW_TAB = 'md-preview-tab'
/** The HTML preview's component: the page runs in an isolated webview (same pane id prefix, same tab). */
export const HTML_PREVIEW_COMPONENT = 'html-preview'
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
    /** Absolute path of the previewed file (markdown, or HTML when `kind` is html). */
    path: string
    /** The source line (0-based, fractional) at the top of the preview when last persisted (markdown). */
    line?: number
    /** 'html': the pane runs the page in an isolated webview (app/renderer/html-preview-panel.ts); absent: markdown. */
    kind?: 'html'
    /** HTML: where the page was scrolled when last persisted (px). */
    scroll?: { x: number; y: number }
  }
}

/** The preview part of a pane's params, when the pane is a preview with a path. */
export function previewParams(params: unknown): PreviewParams['preview'] | undefined {
  if (!params || typeof params !== 'object') return undefined
  const preview = (params as { preview?: unknown }).preview
  if (!preview || typeof preview !== 'object') return undefined
  const { path, line, kind, scroll } = preview as { path?: unknown; line?: unknown; kind?: unknown; scroll?: unknown }
  if (typeof path !== 'string' || path === '') return undefined
  return {
    path,
    ...(typeof line === 'number' && Number.isFinite(line) && line >= 0 ? { line } : {}),
    ...(kind === 'html' ? { kind: 'html' as const } : {}),
    ...(isScroll(scroll) ? { scroll: { x: scroll.x, y: scroll.y } } : {}),
  }
}

function isScroll(v: unknown): v is { x: number; y: number } {
  if (!v || typeof v !== 'object') return false
  const { x, y } = v as { x?: unknown; y?: unknown }
  return typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0
}

export function withPreview(params: Record<string, unknown> | undefined, preview: PreviewParams['preview']): Record<string, unknown> {
  return {
    ...(params ?? {}),
    preview: {
      path: preview.path,
      ...(preview.line !== undefined ? { line: preview.line } : {}),
      ...(preview.kind ? { kind: preview.kind } : {}),
      ...(preview.scroll ? { scroll: { x: preview.scroll.x, y: preview.scroll.y } } : {}),
    },
  }
}

/** What the tab shows: "Prévia: nome.md" / "Prévia: nome.html". */
export function previewTitle(path: string): string {
  return `Prévia: ${noteTitle(path)}`
}

const MARKDOWN_EXTENSION = /\.(md|markdown|mdown|mkd|mdx)$/i

/** Whether a file is one the preview can render (VS Code shows its preview button for markdown files). */
export function isMarkdownPath(path: string): boolean {
  return MARKDOWN_EXTENSION.test(path)
}

const HTML_EXTENSION = /\.(html?|xhtml)$/i

/** Whether a file is a web page the HTML preview runs (Ctrl+click, Ctrl+P and Ctrl+Shift+V open it rendered). */
export function isHtmlPath(path: string): boolean {
  return HTML_EXTENSION.test(path)
}

/** Whether a file has a preview of either kind. */
export function isPreviewablePath(path: string): boolean {
  return isMarkdownPath(path) || isHtmlPath(path)
}

/** The pane's kind from its params. */
export function previewKindOf(params: unknown): 'md' | 'html' {
  return previewParams(params)?.kind === 'html' ? 'html' : 'md'
}
