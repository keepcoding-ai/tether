// The explorer extension (F8): the file explorer of the left side bar, over the window's projects (the core's workspace
// service, app/renderer/workspace.ts: folders inferred from the AI agents' panes plus the pinned ones). Slice 1a: the pad
// and the list of project roots (pin, close, move, copy path) with the empty state; the tree is slice 1b. The pad id and
// the command ids are in people's layout.json and keybindings.json and never change. Its shape mirrors VS Code's
// files.contribution (@7faf984): a view container on the left, "Open Folder" on the empty view, `explorer.focus`.
import type { ExtensionManifest } from '../types.ts'

const EXPLORER = 'Explorador'

export const manifest: ExtensionManifest = {
  id: 'explorer',
  version: '1.0.0',
  displayName: 'Explorador',
  description: 'Os projetos da janela (pastas dos agentes e pastas fixadas) na barra lateral esquerda.',
  hosts: ['renderer'],
  optional: true,
  contributes: {
    pads: [
      { id: 'explorer.files', title: 'Explorador', icon: 'files', defaultSide: 'left', scope: 'global', order: 10 },
    ],
    commands: [
      { command: 'explorer.focus', title: 'Explorador: abrir', category: EXPLORER, icon: 'files' },
      { command: 'explorer.open-folder', title: 'Explorador: abrir pasta…', category: EXPLORER, icon: 'folder-open' },
    ],
    keybindings: [
      { key: 'ctrl+k e', command: 'explorer.focus' },                   // VS Code's "focus the explorer" is Ctrl+Shift+E (taken here: duplicate below)
    ],
    menus: {
      app: [
        { command: 'explorer.open-folder', group: 'pane', order: 90, icon: 'folder-open', label: 'Abrir pasta…' },
      ],
    },
  },
}
