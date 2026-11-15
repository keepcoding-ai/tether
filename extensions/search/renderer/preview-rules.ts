// The replace preview's rules (preview-panel.ts, view.ts): its identity in layout.json, its title, when activating a match
// opens the preview instead of the file, where the activated line lands in the replaced text, and when the preview is
// rebuilt or closed. No DOM, no Monaco.
// Origin (behaviour): https://github.com/microsoft/vscode, commit 9cc2376778e1
//   src/vs/workbench/contrib/search/browser/replaceService.ts   (openReplacePreview: the label "{0} ↔ {1} (Replace Preview)",
//                                                                the line revealed in the center; updateReplacePreview)
//   src/vs/workbench/contrib/search/browser/searchView.ts       (open: the preview while replace is active and
//                                                                search.useReplacePreview is on)
// Ids, prefix, component and tab names end up in layout.json and never change.

export const PREVIEW_TYPE = 'search.replace-preview'
export const PREVIEW_PREFIX = 'search-preview:'
export const PREVIEW_COMPONENT = 'search-replace-preview'
export const PREVIEW_TAB = 'search-replace-preview-tab'
/** The title of a preview pane that has no file (restored from layout.json, closed right away). */
export const PREVIEW_FALLBACK_TITLE = 'Prévia da substituição'
/** The replaced side is rebuilt once the replace term and the results have been still for this long. */
export const PREVIEW_DELAY_MS = 100

export function newPreviewId(now: number = Date.now()): string {
  return `${PREVIEW_PREFIX}${now.toString(36)}`
}

/** The file's name (the last part of a Windows or POSIX path). */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(p => p !== '')
  return parts[parts.length - 1] ?? path
}

/** The tab's title: `<name> ↔ <name> (prévia da substituição)`. */
export function previewTitle(path: string): string {
  const name = baseName(path)
  return `${name} ↔ ${name} (prévia da substituição)`
}

/**
 * Activating a match shows the replace preview (instead of opening the file) while the replace field is open and the
 * setting is on, unless it was asked "to the side" (Ctrl+click, Ctrl+Enter): that one always opens the file.
 */
export function opensPreview(o: { replaceShown: boolean; useReplacePreview: boolean; side: boolean }): boolean {
  return o.replaceShown && o.useReplacePreview && !o.side
}

export interface PreviewRange { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }

/**
 * The line `line` of the text before the replacements becomes, in the text after them: every edit above it adds the
 * line breaks of its new text and takes away those of the range it replaces. An edit that covers the line puts it at
 * the edit's start.
 */
export function shiftedLine(line: number, edits: readonly { range: PreviewRange; text: string }[]): number {
  let delta = 0
  for (const e of edits) {
    const r = e.range
    if (r.startLineNumber >= line) continue
    const added = (e.text.match(/\n/g) ?? []).length
    if (r.endLineNumber < line) delta += added - (r.endLineNumber - r.startLineNumber)
    else return Math.max(1, r.startLineNumber + delta + added)
  }
  return Math.max(1, line + delta)
}

/** What the preview does once the results or the replace term changed. */
export type PreviewFate = 'close' | 'rebuild' | 'keep'

/**
 * The preview closes when the replace field closed or its file left the results (replaced as a whole, dismissed, the
 * results cleared, a new search without it); it is rebuilt when what it shows changed (the edits of its file, or the
 * text they apply to), and stays as it is otherwise.
 */
export function previewFate(o: { replaceShown: boolean; inResults: boolean; shown: string | undefined; next: string }): PreviewFate {
  if (!o.replaceShown || !o.inResults) return 'close'
  return o.shown === o.next ? 'keep' : 'rebuild'
}

/**
 * What the preview shows, as one string: the edits of its file and the version of the text they apply to (an open
 * editor's version id, or 'disk'). The same signature twice means nothing to rebuild.
 */
export function previewSignature(source: string, edits: readonly { range: PreviewRange; expected: string; text: string }[]): string {
  return JSON.stringify([source, edits.map(e => [e.range.startLineNumber, e.range.startColumn, e.range.endLineNumber, e.range.endColumn, e.expected, e.text])])
}
