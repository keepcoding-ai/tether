// What the app's code (layout, commands, menus, the file watcher) needs from a preview pane of either kind: the markdown
// preview (preview-panel.ts: a script-less frame the app draws into) and the HTML preview (html-preview-panel.ts: the
// author's page, running in an isolated webview). Both are panes tied to one file and share the id prefix, the tab and the
// "preview" slot-less rules; the pane's params say which kind it is (`preview.kind`).
import type { NotePanel } from './note-panel.ts'

export interface PreviewPane {
  readonly kind: 'md' | 'html'
  readonly id: string
  /** The file the pane was opened on. */
  readonly path: string
  focus(): void
  /** The scheme or the terminal font changed (the markdown preview paints with the app's tokens; a page is its author's). */
  restyle(): void
  /** Whether a change of `path` on disk concerns this pane (the file itself, or for a page any file it loaded). */
  watches(path: string): boolean
  /** A watched file changed on disk. */
  diskChanged(): void
  /** The open editor of the file changed its text. */
  sourceChanged(): void
  /** The open editor of the file scrolled. */
  editorScrolled(editor: NotePanel): void
  /** The file was renamed or saved under another name. */
  setPath(path: string): void
  /** The source line at the top (markdown); 0 for a page. */
  topLine(): number
}
