// The explorer extension (F8): the file explorer of the left side bar, over the window's projects (the core's workspace
// service, app/renderer/workspace.ts: folders inferred from the AI agents' panes plus the pinned ones). Slice 1a: the pad
// and the list of project roots (pin, close, move, copy path) with the empty state; slice 1b: the file tree under each root
// (the main side reads one folder at a time on the bus `ext:explorer:*`) and opening a file in the editor. The pad id and
// the command ids are in people's layout.json and keybindings.json and never change. Its shape mirrors VS Code's
// files.contribution (@7faf984): a view container on the left, "Open Folder" on the empty view, `explorer.focus`.
// Slice 5: the file operations (new file/folder, rename, trash, copy path, "Novo painel aqui"), on the selected row.
import type { ExtensionManifest } from '../types.ts'

const EXPLORER = 'Explorador'

export const manifest: ExtensionManifest = {
  id: 'explorer',
  version: '1.0.0',
  displayName: 'Explorador',
  description: 'Os projetos da janela (pastas dos agentes e pastas fixadas) e seus arquivos na barra lateral esquerda.',
  hosts: ['renderer', 'main'],
  optional: true,
  contributes: {
    pads: [
      { id: 'explorer.files', title: 'Explorador', icon: 'files', defaultSide: 'left', scope: 'global', absorbsHeader: true, order: 10 },
    ],
    settings: {
      follow: { type: 'boolean', default: true, title: 'Seguir o agente ativo no explorador', description: 'O explorador mostra a pasta do painel em foco.' },
      autoReveal: { type: 'boolean', default: false, title: 'Revelar o arquivo ativo no explorador', description: 'Ao trocar de aba, o explorador abre a árvore até o arquivo aberto.' },
      confirmDelete: { type: 'boolean', default: true, title: 'Confirmar antes de mover para a lixeira', description: 'Pergunta antes de mandar um arquivo ou pasta para a lixeira.' },
    },
    commands: [
      { command: 'explorer.focus', title: 'Explorador: focar', category: EXPLORER, icon: 'files' },
      { command: 'explorer.open-folder', title: 'Explorador: abrir pasta…', category: EXPLORER, icon: 'folder-open' },
      { command: 'explorer.reveal', title: 'Revelar no explorador', category: EXPLORER, icon: 'target' },
      { command: 'explorer.refresh', title: 'Explorador: atualizar', category: EXPLORER, icon: 'arrows-clockwise' },
      { command: 'explorer.collapse-all', title: 'Explorador: recolher tudo', category: EXPLORER, icon: 'arrows-in-line-vertical' },
      { command: 'explorer.follow', title: 'Explorador: seguir o agente ativo (liga/desliga)', category: EXPLORER, icon: 'target' },
      { command: 'explorer.new-file', title: 'Explorador: novo arquivo…', category: EXPLORER, icon: 'file-plus' },
      { command: 'explorer.new-folder', title: 'Explorador: nova pasta…', category: EXPLORER, icon: 'folder-plus' },
      { command: 'explorer.rename', title: 'Explorador: renomear…', category: EXPLORER, icon: 'pencil-simple' },
      { command: 'explorer.delete', title: 'Explorador: mover para a lixeira', category: EXPLORER, icon: 'trash' },
      { command: 'explorer.copy-path', title: 'Explorador: copiar caminho', category: EXPLORER, icon: 'copy' },
      { command: 'explorer.copy-relative-path', title: 'Explorador: copiar caminho relativo', category: EXPLORER, icon: 'copy' },
      { command: 'explorer.new-pane', title: 'Explorador: novo painel aqui…', category: EXPLORER, icon: 'terminal-window' },
      { command: 'explorer.auto-reveal', title: 'Explorador: revelar o arquivo ativo (liga/desliga)', category: EXPLORER, icon: 'target' },
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
