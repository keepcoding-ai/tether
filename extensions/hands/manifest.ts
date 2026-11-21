// The hands as a built-in extension: the client the end customers run (bin/hands). The daemon side registers the agent
// (adapter, attention, default profile, reserved args, TETHER_HANDS_ARGS) and its doctor checks; the renderer side how the
// app names and draws it. Turned off, its slots stay listed as "Agente indisponível" until it is back on.
// Modeled on the soul's extension (extensions/soul) and kept apart: the two programs evolve on their own.
import type { ExtensionManifest } from '../types.ts'

export const manifest: ExtensionManifest = {
  id: 'hands',
  version: '1.0.0',
  displayName: 'hands',
  description: 'Painéis do hands, o cliente dos agentes, que retomam a própria sessão.',
  hosts: ['renderer', 'daemon'],
  optional: true,
}
