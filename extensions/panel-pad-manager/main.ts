// The panel-pad-manager extension's Electron-main side: reads a note's file for the manager's preview of a note pane
// (read only; the note extension stays the one that writes).
import type { TetherMain } from '../../app/main/ext-api.ts'
import { readNote } from '../../app/main/note-files.ts'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import type { PanelPadManagerChannels } from './ipc.ts'

export { manifest } from './manifest.ts'

export function activate(main: TetherMain): IDisposable[] {
  const ipc = main.ipc<PanelPadManagerChannels>()
  return [
    ipc.handle('read', path => typeof path === 'string' && path.trim() !== '' ? readNote(path) : { ok: false, missing: false, message: 'Caminho inválido.' }),
  ]
}
