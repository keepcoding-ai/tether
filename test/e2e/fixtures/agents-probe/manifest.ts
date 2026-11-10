// E2E-only extension (built in only with TETHER_TEST_EXTENSIONS=1): follows the agents on both hosts. Its main side keeps
// what TetherMain.agents tells in `globalThis.__agentsProbe`; its renderer side exposes TetherUi.agents as test hooks. Never shipped.
import type { ExtensionManifest } from '../../../../extensions/types.ts'

export const manifest: ExtensionManifest = {
  id: 'agents-probe',
  version: '0.0.1',
  displayName: 'Prova de agentes',
  description: 'Só para os testes: acompanha os painéis de agente nos dois lados.',
  hosts: ['main', 'renderer'],
  optional: true,
}
