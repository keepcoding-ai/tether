// The soul-cli agent as a built-in extension (F9 slice 4): the daemon side registers the agent (adapter, attention,
// default profile, reserved args, TETHER_SOUL_ARGS) and its doctor check; the renderer side registers how the app names
// and draws it (AgentUi). Turned off, its slots stay listed as "Agente indisponível" until it is back on.
import type { ExtensionManifest } from '../types.ts'

export const manifest: ExtensionManifest = {
  id: 'soul',
  version: '1.0.0',
  displayName: 'soul',
  description: 'Painéis do soul-cli que retomam a própria sessão.',
  hosts: ['renderer', 'daemon'],
  optional: true,
}
