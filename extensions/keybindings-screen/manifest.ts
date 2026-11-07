// The keybindings-screen extension (F9 slice 3): the "Atalhos de teclado" screen (Ctrl+K Ctrl+S). Only the SCREEN is the
// extension's; the key table, the dispatcher and the reading of <TETHER_HOME>/keybindings.json stay in the core, so the
// person's overrides are honoured with the screen off. The screen lists every command of the registry (so every
// extension's contributions), edits through TetherUi.keybindings and writes the file on the bus ext:keybindings-screen:*.
// Ids (commands, pane component, prefix) are already in people's files and never change.
import type { ExtensionManifest } from '../types.ts'
import { KEYBINDINGS_SCREEN_LAYOUT } from './layouts.ts'

export const manifest: ExtensionManifest = {
  id: 'keybindings-screen',
  version: '1.0.0',
  displayName: 'Atalhos de teclado',
  description: 'A tela com todos os comandos e as teclas deles, onde cada atalho se grava, troca ou restaura (Ctrl+K Ctrl+S).',
  hosts: ['renderer', 'main'],
  optional: true,
  contributes: {
    paneTypes: [KEYBINDINGS_SCREEN_LAYOUT],
    commands: [
      { command: 'keybindings.show', title: 'Atalhos de teclado', category: 'App', icon: 'keyboard' },
      { command: 'keybindings.record', title: 'Atalhos de teclado: gravar o atalho da linha selecionada', category: 'App', icon: 'keyboard', when: 'keybindings.screen' },
    ],
    keybindings: [
      { key: 'ctrl+k ctrl+s', command: 'keybindings.show' },                               // "keyboard shortcuts"
      { key: 'ctrl+k ctrl+k', command: 'keybindings.record', where: ['window'] },          // in the screen: record the selected row (in a terminal Ctrl+K twice sends ^K)
    ],
    menus: {
      app: [
        // Ferramentas submenu: after "Perfis de lançamento…" (10), before the core's "Extensões" (30).
        { command: 'keybindings.show', group: 'tools', order: 20, icon: 'keyboard', label: 'Atalhos de teclado' },
      ],
    },
  },
}
