// The pad-notes extension: the notes manager ("Notas"), the panel pad's second state, where the notes of every prancheta
// are seen and looked after, the loose ones included (a panel pad's note whose panel was closed). The notes themselves stay
// the core's (TetherUi.pads.notes); this extension only draws and acts. Command ids never change.
import type { ExtensionManifest } from '../types.ts'

export const manifest: ExtensionManifest = {
  id: 'pad-notes',
  version: '1.1.0',
  displayName: 'Notas das pranchetas',
  description: 'Gerenciador das notas das pranchetas, na própria prancheta do painel: vê todas, encontra as que ficaram soltas ao fechar um painel, move, fecha e limpa as vazias.',
  hosts: ['renderer', 'main'],
  optional: true,
  contributes: {
    commands: [
      { command: 'notes.manager', title: 'Abrir ou fechar o gerenciador', category: 'Notas', icon: 'clipboard-text' },
      { command: 'notes.manager.loose', title: 'Ver notas soltas', category: 'Notas', icon: 'clipboard-text' },
    ],
    keybindings: [
      { key: 'ctrl+k n', command: 'notes.manager' },
      { key: 'ctrl+shift+m', command: 'notes.manager' },                 // works in a terminal too (Ctrl+K chords pass to the shell there)
    ],
  },
}
