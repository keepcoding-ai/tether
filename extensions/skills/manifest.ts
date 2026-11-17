// The skills extension: the tether's own skills (library/<name>/SKILL.md, written once, agent-agnostic) reach every AI
// agent a pane launches, each in its agent's format (src/agents/skills.ts). Ids never change.
import type { ExtensionManifest } from '../types.ts'

export const manifest: ExtensionManifest = {
  id: 'skills',
  version: '1.0.0',
  displayName: 'Skills do tether',
  description: 'Entrega as skills do tether (como use-todo) a todo agente aberto num painel, no formato de cada agente.',
  hosts: ['daemon'],
  optional: true,
}
