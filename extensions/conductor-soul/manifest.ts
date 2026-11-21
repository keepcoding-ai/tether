// The soul conductor (tether for agents, conductor-api.ts): an extension of its own, daemon only, on top of for-agents.
// Turned off, the panes it would conduct fall to the next conductor of the chain (the terminal's, for an agent CLI).
import type { ExtensionManifest } from '../types.ts'

export const manifest: ExtensionManifest = {
  id: 'conductor-soul',
  version: '0.1.0',
  displayName: 'Condutor do Soul',
  description: 'Ensina o Tether for agents a comandar uma guia do Soul: enviar, interromper, responder permissão, rodar comandos e ler a última resposta.',
  hosts: ['daemon'],
  optional: true,
  requires: ['for-agents'],
}
