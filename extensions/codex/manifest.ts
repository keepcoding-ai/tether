// The OpenAI Codex CLI agent as a built-in extension: the daemon side registers the agent (adapter, attention, default
// profiles, reserved args, TETHER_CODEX_ARGS, MCP, skills) and its doctor checks; the renderer side registers how the app
// names and draws it (AgentUi). Turned off, its slots stay listed as "Agente indisponível" until it is back on.
import type { ExtensionManifest } from '../types.ts'

export const manifest: ExtensionManifest = {
  id: 'codex',
  version: '1.0.0',
  displayName: 'Codex',
  description: 'Painéis do Codex CLI (OpenAI) que retomam a própria sessão.',
  hosts: ['renderer', 'daemon'],
  optional: true,
}
