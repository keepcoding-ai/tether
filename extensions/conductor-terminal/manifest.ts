// The terminal conductor (tether for agents, conductor-api.ts): an extension of its own, daemon only, on top of for-agents.
// Turned off, the panes it would conduct fall to the next conductor of the chain (the terminal's, for an agent CLI).
import type { ExtensionManifest } from '../types.ts'

export const manifest: ExtensionManifest = {
  id: 'conductor-terminal',
  version: '0.1.0',
  displayName: 'Condutor do terminal',
  description: 'Ensina o Tether for agents a digitar, teclar e ler a tela de qualquer guia de terminal, inclusive de um CLI sem condutor próprio.',
  hosts: ['daemon'],
  optional: true,
  requires: ['for-agents'],
}
