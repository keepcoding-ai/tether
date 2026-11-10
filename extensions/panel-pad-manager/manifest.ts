// The panel-pad-manager extension: the manager of the panel pad's frames ("Quadros dos painéis"), the pad's second
// state, where the frame of every panel is seen and looked after, whatever it holds (a note, a terminal, an agent, a
// browser tab), the loose ones included (a frame whose panel was closed). The frames themselves stay the core's
// (TetherUi.pads.panelFrames); this extension only draws and acts. Command ids never change.
import type { ExtensionManifest } from '../types.ts'

export const manifest: ExtensionManifest = {
  id: 'panel-pad-manager',
  version: '2.0.0',
  displayName: 'Quadros dos painéis',
  description: 'Gestor dos quadros da prancheta do painel: vê o quadro de cada painel com o que ele guarda, encontra os que ficaram soltos ao fechar um painel, move, fecha e limpa os vazios.',
  hosts: ['renderer', 'main'],
  optional: true,
  contributes: {
    commands: [
      { command: 'panel-pad.manager', title: 'Abrir ou fechar o gestor de quadros', category: 'Prancheta do painel', icon: 'squares-four' },
      { command: 'panel-pad.manager.loose', title: 'Ver quadros soltos', category: 'Prancheta do painel', icon: 'squares-four' },
    ],
    keybindings: [
      { key: 'ctrl+k n', command: 'panel-pad.manager' },
      { key: 'ctrl+shift+m', command: 'panel-pad.manager' },                 // works in a terminal too (Ctrl+K chords pass to the shell there)
    ],
  },
}
