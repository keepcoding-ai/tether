// The Claude Code agent as a built-in extension (F9 slice 4): the daemon side registers the agent (adapter, attention,
// default profiles, reserved args, TETHER_CLAUDE_ARGS) and its doctor checks; the renderer side registers how the app
// names and draws it (AgentUi). Turned off, its slots stay listed as "Agente indisponível" until it is back on.
import type { ExtensionManifest } from '../types.ts'

export const manifest: ExtensionManifest = {
  id: 'claude',
  version: '1.0.0',
  displayName: 'Claude',
  description: 'Painéis de Claude Code que retomam a própria sessão.',
  hosts: ['daemon'],
  optional: true,
}
