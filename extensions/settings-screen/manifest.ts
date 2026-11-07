// The settings-screen extension (settings plan, slice 3): the "Configurações" page (Ctrl+,), VS Code's settings editor
// in miniature. Only the PAGE is the extension's; the registry, settings.json and its single writer stay in the core
// (TetherUi.configuration), so every setting keeps working with the page off. Ids (command, pane component, prefix)
// end up in people's files and never change.
import type { ExtensionManifest } from '../types.ts'
import { SETTINGS_SCREEN_LAYOUT } from './layouts.ts'

export const manifest: ExtensionManifest = {
  id: 'settings-screen',
  version: '1.0.0',
  displayName: 'Configurações',
  description: 'A página com todas as configurações do tether e das extensões, com busca, onde cada uma se liga, troca ou volta ao padrão (Ctrl+,).',
  hosts: ['renderer'],
  optional: true,
  contributes: {
    paneTypes: [SETTINGS_SCREEN_LAYOUT],
    commands: [
      { command: 'settings.show', title: 'Configurações', category: 'App', icon: 'gear-six' },
    ],
    keybindings: [
      { key: 'ctrl+,', command: 'settings.show' },                                         // VS Code's "open settings"
    ],
    menus: {
      app: [
        // order 15: in the 'app' group after the core's "Extensões" (10).
        { command: 'settings.show', group: 'app', order: 15, icon: 'gear-six', label: 'Configurações…' },
      ],
    },
  },
}
