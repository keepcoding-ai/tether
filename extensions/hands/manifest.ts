// The hands as a built-in extension: the soul-cli's client build for the end customers (`bun run build:hands`, bin/hands),
// beside the soul (the operator's build, for devops). The daemon side registers the agent (adapter, attention, default
// profile, reserved args, TETHER_HANDS_ARGS) and its doctor check; the renderer side how the app names and draws it.
// Turned off, its slots stay listed as "Agente indisponível" until it is back on.
import type { ExtensionManifest } from '../types.ts'

export const manifest: ExtensionManifest = {
  id: 'hands',
  version: '1.0.0',
  displayName: 'hands',
  description: 'Painéis do hands (o cliente do soul-cli para quem usa os agentes) que retomam a própria sessão.',
  hosts: ['renderer', 'daemon'],
  optional: true,
}
