// The context extension: the pad "Contexto" on the right bar inspects the AI agent (Claude Code) of the focused panel:
// how full its window is, what weighs in it, and how it grew. Ids (pad, command) are saved in layout.json and
// keybindings.json and never change.
import type { ExtensionManifest } from '../types.ts'

export const PAD_ID = 'context.inspector'
export const OPEN_COMMAND = 'context.open'

export const manifest: ExtensionManifest = {
  id: 'context',
  version: '0.1.0',
  displayName: 'Contexto',
  description: 'Mostra o uso da janela de contexto do agente em foco, o peso fixo (skills, agentes, MCP, memória) e a curva por turno.',
  hosts: ['renderer', 'main'],
  optional: true,
  contributes: {
    commands: [{ command: OPEN_COMMAND, title: 'Contexto: abrir a prancheta', category: 'Contexto', icon: 'gauge' }],
    // 'global': one view for the window; it follows the focused panel itself (TetherUi.panes.onDidChangeActive).
    pads: [{ id: PAD_ID, title: 'Contexto', icon: 'gauge', defaultSide: 'right', scope: 'global', order: 40 }],
  },
}
