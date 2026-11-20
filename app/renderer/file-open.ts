// Opening a file (core, F9 slice 2): Ctrl+P (the quick-open extension), a Ctrl+click on a path in a terminal and the
// extensions' "open the source file" all end here. Main inspects the path (app/main/file-open-main.ts): a text file goes
// to the openers extensions register (the note's: an .html as its preview, an image in the viewer, any other text file as a note); a binary or
// a file above 5 MB goes to the system's program (main refuses anything that would run); what cannot be opened is said.
import type { DialogSpec } from '../shared/dialog.ts'
import type { LineColumn } from '../shared/file-open.ts'
import { isImagePath } from '../shared/preview.ts'

/** Where and how a file opens (shared by Ctrl+P and a Ctrl+click on a path in a terminal). */
export interface OpenFileOptions {
  side: boolean
  position?: LineColumn
  /** The folder the file was reached from: the note remembers it as the root of its next Ctrl+P. */
  root: string
  /** The pane whose tab group receives the tab (default: the focused pane). */
  reference?: string
  /** A web page opens as its source in the editor instead of its preview ("Ver código"). */
  source?: boolean
}

export interface FileOpenHost {
  /** Hands a text file to the opener that takes it (an extension's). */
  openText(path: string, opts: OpenFileOptions): void
  /** Something to say to the person (a file that could not be opened). */
  notify(message: string): void
  /** A file was opened (text, or by the system's program): the extensions that keep a history learn it. */
  opened(path: string): void
}

/**
 * Opens a file: text in the editor an extension offers (a tab already showing it is focused and positioned), binary or
 * above 5 MB with the system's program, never one that would run (main refuses it).
 */
export async function openFile(host: FileOpenHost, path: string, opts: OpenFileOptions): Promise<void> {
  const target = await window.tether.inspectFile(path)
  // An image has its viewer, binary or not (an SVG asked as source goes on to the editor like any text).
  if (isImagePath(path) && !opts.source && target.kind !== 'missing' && target.kind !== 'folder') { host.opened(path); host.openText(path, opts); return }
  if (target.kind === 'text') { host.opened(path); host.openText(path, opts); return }
  if (target.kind === 'missing') { host.notify(`O arquivo não existe mais: ${path}`); return }
  if (target.kind === 'folder') { host.notify(`É uma pasta: ${path}`); return }
  const r = await window.tether.openFileExternal(path)
  if (r.ok) { host.opened(path); return }
  const why = target.kind === 'large' ? `Arquivo grande demais para o editor (${(target.size / 1024 / 1024).toFixed(1)} MB). ` : ''
  host.notify(`${why}${r.message}`)
}

/** A file that could not be opened (gone, a folder, too large or binary and refused by the system). */
export function fileOpenFailedSituation(message: string): DialogSpec {
  return {
    situation: 'file-open-failed',
    tone: 'danger',
    icon: 'x-circle',
    title: 'Não foi possível abrir o arquivo',
    message,
    choices: [{ id: 'ok', icon: 'check', label: 'Entendi', consequence: 'Nada foi aberto.', tone: 'neutral' }],
    escChoice: 'ok',
  }
}
