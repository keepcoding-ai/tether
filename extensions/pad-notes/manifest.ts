// The pad-notes extension: the notes manager ("Notas"), a tab where the notes of every prancheta are seen and looked after,
// the loose ones included (a panel pad's note whose panel was closed). The notes themselves stay the core's
// (TetherUi.pads.notes); this extension only draws and acts. Ids (commands, pane component, prefix) never change.
import type { ExtensionManifest } from '../types.ts'
import { NOTES_MANAGER_LAYOUT } from './layouts.ts'

export const manifest: ExtensionManifest = {
  id: 'pad-notes',
  version: '1.0.0',
  displayName: 'Notas das pranchetas',
  description: 'Gerenciador das notas das pranchetas: vê todas, encontra as que ficaram soltas ao fechar um painel, move, fecha e limpa as vazias.',
  hosts: ['renderer', 'main'],
  optional: true,
  contributes: {
    paneTypes: [NOTES_MANAGER_LAYOUT],
    commands: [
      { command: 'notes.manager', title: 'Abrir gerenciador', category: 'Notas', icon: 'clipboard-text' },
      { command: 'notes.manager.loose', title: 'Ver notas soltas', category: 'Notas', icon: 'clipboard-text' },
    ],
    keybindings: [
      { key: 'ctrl+k n', command: 'notes.manager' },
    ],
  },
}
