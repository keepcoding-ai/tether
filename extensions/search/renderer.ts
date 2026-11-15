// The search extension's renderer entry: the pad (SearchView), its commands, the replace preview's pane type and the
// search editor (the `.code-search` language and its commands, search-editor.ts).
import type { TetherUi } from '../../app/renderer/ext-api.ts'
import { monaco } from '../../app/renderer/monaco.ts'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import { onFindInFolder } from './api.ts'
import { manifest } from './manifest.ts'
import { ReplacePreview } from './renderer/preview-panel.ts'
import { SearchEditors } from './renderer/search-editor.ts'
import { SearchView } from './renderer/view.ts'

export { manifest }

const PAD = 'search.view'

/** The text selected in the editor that has the keyboard (VS Code seeds the search with it), or undefined. */
function editorSelection(): string | undefined {
  const editor = monaco.editor.getEditors().find(e => e.hasTextFocus())
  const model = editor?.getModel()
  const sel = editor?.getSelection()
  if (!editor || !model || !sel || sel.isEmpty()) return undefined
  return model.getValueInRange(sel)
}

export function activate(ui: TetherUi): IDisposable[] {
  let view: SearchView | undefined
  const preview = new ReplacePreview(ui)
  const editors = new SearchEditors(ui)
  ui.test.expose('searchEditors', () => editors.snapshot())
  ui.test.expose('searchEditorLinks', (path: string) => editors.linksFor(path))
  ui.test.expose('searchEditorPoint', (path: string, line: number, column: number) => editors.pointOf(path, line, column))
  ui.test.expose('searchEditorRerun', (path: string) => editors.rerunPath(path))
  ui.test.expose('searchPreview', () => preview.snapshot())
  // The URIs of every Monaco model: the preview's two go with its pane.
  ui.test.expose('monacoModels', () => monaco.editor.getModels().map(m => m.uri.toString()))
  ui.test.expose('search', () => view?.snapshot())
  // The cheap part of the snapshot (no rows): for polling while a big result set is in.
  ui.test.expose('searchStatus', () => view?.status())
  /** Opens the pad and runs `fn` on its view. */
  const onView = (fn: (v: SearchView) => void) => () => { ui.pads.open(PAD); if (view) fn(view) }
  return [
    ...editors.activate(),
    ui.panes.register(preview.paneType()),
    // The explorer's "Pesquisar na pasta…" (api.ts): the pad opens with the folder in the include field.
    onFindInFolder(path => { ui.pads.open(PAD); view?.findInFolder(path) }),
    ui.pads.register({ id: PAD, create: host => (view = new SearchView(ui, host, preview, editors)) }),
    ui.commands.registerCommand('search.focus', () => {
      // Read before the pad takes the keyboard from the editor.
      const selected = editorSelection()
      ui.pads.open(PAD)
      view?.focusSearch(selected)
    }),
    ui.commands.registerCommand('search.refresh', onView(v => v.refresh())),
    ui.commands.registerCommand('search.clear', onView(v => v.clear())),
    ui.commands.registerCommand('search.cancel', () => view?.cancel()),
    ui.commands.registerCommand('search.collapse-all', onView(v => v.collapseAll())),
    ui.commands.registerCommand('search.expand-all', onView(v => v.expandAll())),
    ui.commands.registerCommand('search.view-as-tree', onView(v => v.setViewMode('tree'))),
    ui.commands.registerCommand('search.view-as-list', onView(v => v.setViewMode('list'))),
    ui.commands.registerCommand('search.toggle-details', onView(v => v.toggleDetails())),
    // F4 walks the results wherever the keyboard is, as VS Code does; the pad need not be open.
    ui.commands.registerCommand('search.next-match', () => view?.step(false)),
    ui.commands.registerCommand('search.previous-match', () => view?.step(true)),
    ui.commands.registerCommand('search.clear-history', () => view?.clearHistory()),
    ui.commands.registerCommand('search.toggle-replace', onView(v => v.focusReplace())),
    // Both do nothing while the replace field is closed (the view checks).
    ui.commands.registerCommand('search.replace-all', () => view?.replace('all')),
    ui.commands.registerCommand('search.replace', () => view?.replaceFocused()),
    ui.commands.registerCommand('search.open-editor', onView(v => v.openEditor())),
    // Both act on the active pane when it is a `.code-search` document; elsewhere they do nothing.
    ui.commands.registerCommand('search.editor.rerun', () => editors.rerunActive()),
    ui.commands.registerCommand('search.editor.go-to-file', () => editors.goToActive()),
    { dispose: () => preview.dispose() },
  ]
}
