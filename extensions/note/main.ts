// The note extension's Electron-main side (F9 slice 1): the files of the note tabs and the HTML preview's isolation,
// on the bus `ext:note:*` (extensions/note/ipc.ts) instead of the core's bespoke `note:*` / `htmlpreview:*` channels.
// The renderer owns the editor and the debounce; this side owns the disk (atomic writes, the folder watcher, the two
// OS file dialogs, the repositories whose ".gitignore" question was declined) and the webview guard of the previews.
// The implementations stay in app/main/note-files.ts and app/main/html-preview-main.ts (the keybindings screen
// shares the watcher class until it becomes an extension, F9 slice 3).
import { dialog } from 'electron'
import { join } from 'node:path'
import type { TetherMain } from '../../app/main/ext-api.ts'
import { mainExecutor } from '../../app/main/main-executor.ts'
import { addTetherToGitignore, isDestinationId, NoteWatchers, notesDirFor, personalNotesDir, prepareNote, readNote, renameNote, writeNote, type NoteDestinationId } from '../../app/main/note-files.ts'
import { guardHtmlPreviews, openHtmlInBrowser } from '../../app/main/html-preview-main.ts'
import { NOTE_EXTENSION } from '../../app/shared/notes.ts'
import { isImagePath } from '../../app/shared/preview.ts'
import { readImage } from '../../app/main/image-files.ts'
import { canonicalDir } from '../../src/core/paths-sync.ts'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import type { NoteChannels } from './ipc.ts'

export { manifest } from './manifest.ts'

const isPath = (p: unknown): p is string => typeof p === 'string' && p.trim() !== ''

export function activate(main: TetherMain): IDisposable[] {
  const ipc = main.ipc<NoteChannels>()
  const watchers = new NoteWatchers(path => ipc.send('changed', path))
  const declined = (): string[] => {
    const list = main.state.get<unknown>('gitignoreDeclined')
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []
  }
  const personal = (): string => personalNotesDir(main.settings.get<string>('personalFolder'))
  /** The destination the chooser starts on: the last one used; a remembered "Outro" folder that is gone falls back to the project's, with a warning. */
  const lastDestination = async (): Promise<{ id: NoteDestinationId; folder?: string; warning?: string }> => {
    const last = main.state.get<{ id?: unknown; folder?: unknown }>('lastDestination')
    const id = isDestinationId(last?.id) ? last.id : 'project'
    if (id !== 'other') return { id }
    const folder = typeof last?.folder === 'string' ? last.folder : ''
    let exists = false
    try { exists = !!folder && (await mainExecutor().run('stat', [folder])).isDirectory } catch { /* missing folder or unreachable drive */ }
    return exists ? { id, folder } : { id: 'project', warning: 'A pasta usada da última vez não foi encontrada.' }
  }
  return [
    // A new note's file. With a destination (the chooser, "Nova nota" of the menu), the destination is remembered once
    // the file exists: the chooser offers it next time.
    ipc.handle('prepare', async (paneCwd, destination) => {
      const cwd = isPath(paneCwd) ? canonicalDir(paneCwd) : undefined
      if (!isDestinationId(destination)) return await prepareNote(cwd, { declined: declined() })
      const prepared = destination === 'home' ? await prepareNote(undefined, { dir: personal() })
        : destination === 'other' ? await prepareNote(undefined, { dir: cwd ?? personal() })
        : await prepareNote(cwd, { declined: declined() })
      main.state.update('lastDestination', destination === 'other' && cwd ? { id: destination, folder: cwd } : { id: destination })
      return prepared
    }),
    ipc.handle('destination', () => lastDestination()),
    ipc.handle('personalFolder', () => personal()),
    ipc.handle('read', path => isPath(path) ? readNote(path) : { ok: false, missing: false, message: 'Caminho inválido.' }),
    ipc.handle('readImage', path => isPath(path) && isImagePath(path) ? readImage(path) : { ok: false, missing: false, message: 'Só abro arquivos de imagem.' }),
    ipc.handle('write', (path, text) => isPath(path) && typeof text === 'string' ? writeNote(path, text) : { ok: false, message: 'Caminho inválido.' }),
    ipc.on('flush', (path, text) => { if (isPath(path) && typeof text === 'string') void writeNote(path, text) }),
    // The watches follow in the renderer (the note's `setPath`, a preview's retarget): each holder moves its own.
    ipc.handle('rename', (from, to) => isPath(from) && isPath(to) ? renameNote(from, to) : { ok: false, message: 'Caminho inválido.' }),
    ipc.on('watch', path => { if (isPath(path)) watchers.watch(path) }),
    ipc.on('unwatch', path => { if (isPath(path)) watchers.unwatch(path) }),
    ipc.handle('pickOpen', async initialDir => {
      const win = main.window.current()
      if (!win) return null
      const r = await dialog.showOpenDialog(win, {
        title: 'Abrir nota',
        properties: ['openFile'],
        filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }, { name: 'Todos os arquivos', extensions: ['*'] }],
        ...(isPath(initialDir) ? { defaultPath: initialDir } : {}),
      })
      const picked = r.filePaths[0]
      return r.canceled || !picked ? null : picked
    }),
    ipc.handle('pickSaveAs', async currentPath => {
      const win = main.window.current()
      if (!win) return null
      const r = await dialog.showSaveDialog(win, {
        title: 'Salvar nota como',
        filters: [{ name: 'Markdown', extensions: ['md'] }, { name: 'Todos os arquivos', extensions: ['*'] }],
        defaultPath: isPath(currentPath) ? currentPath : join(notesDirFor(undefined), `nota${NOTE_EXTENSION}`),
      })
      return r.canceled || !r.filePath ? null : r.filePath
    }),
    ipc.handle('gitignore', async (repoRoot, add) => {
      if (!isPath(repoRoot)) return
      if (add === true) { await addTetherToGitignore(repoRoot); return }
      const list = declined()
      if (!list.includes(repoRoot)) main.state.update('gitignoreDeclined', [...list, repoRoot])
    }),
    ipc.handle('openInBrowser', path => openHtmlInBrowser(path)),
    // Every app window's webviews become isolated previews (nothing else may be a webview).
    main.webviews.guard(host => guardHtmlPreviews(host, {
      report: r => ipc.send('htmlReport', r),
      key: k => ipc.send('htmlKey', k),
    })),
    { dispose: () => watchers.close() },
  ]
}
