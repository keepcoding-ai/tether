// Applies the search pad's replacements: a file open in an editor is edited in its Monaco model (one undo step; the note
// saves it as it saves any edit), every other file goes to main in one `replace` call (app/main/search-replace-disk.ts).
// Both run the same guard first: each range must still hold the text the search found, else the file is left as it is.
// Origin (behaviour): https://github.com/microsoft/vscode, commit 9cc2376778e1
//   src/vs/workbench/contrib/search/browser/replaceService.ts   (replace: open models are edited, the edits of a file as one
//                                                                undo step between two stack elements)
import { monaco } from '../../../app/renderer/monaco.ts'
import type { UiIpc } from '../../../app/shared/ext-ipc.ts'
import type { SearchChannels } from '../ipc.ts'
import { guardModel, inOrder, splitByEditor, type ReplaceFile, type ReplaceOutcome } from './replace-rules.ts'

const modelOf = (path: string): monaco.editor.ITextModel | null => monaco.editor.getModel(monaco.Uri.file(path))

/** Replaces in one open model, all or nothing. */
function replaceInModel(model: monaco.editor.ITextModel, file: ReplaceFile): ReplaceOutcome {
  const edits = guardModel(model, file.edits)
  if (!edits) return { path: file.path, status: 'changed' }
  try {
    model.pushStackElement()
    model.pushEditOperations(null, edits.map(e => ({
      range: new monaco.Range(e.range.startLineNumber, e.range.startColumn, e.range.endLineNumber, e.range.endColumn),
      text: e.text,
    })), () => null)
    model.pushStackElement()
    return { path: file.path, status: 'replaced', count: edits.length }
  } catch (e) {
    return { path: file.path, status: 'failed', message: e instanceof Error ? e.message : String(e) }
  }
}

/** One outcome per file, in the order given. */
export async function applyReplace(files: readonly ReplaceFile[], ipc: UiIpc<SearchChannels>): Promise<ReplaceOutcome[]> {
  const { open, disk } = splitByEditor(files, path => modelOf(path) !== null)
  const outcomes: ReplaceOutcome[] = []
  for (const f of open) {
    const model = modelOf(f.path)
    outcomes.push(model ? replaceInModel(model, f) : { path: f.path, status: 'missing' })
  }
  if (disk.length > 0) {
    try {
      outcomes.push(...await ipc.invoke('replace', disk))
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      for (const f of disk) outcomes.push({ path: f.path, status: 'failed', message })
    }
  }
  return inOrder(files, outcomes)
}
