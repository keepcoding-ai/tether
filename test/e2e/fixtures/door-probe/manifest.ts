// E2E-only extension (built in only with TETHER_TEST_EXTENSIONS=1): the one probe of the agent door's renderer side. Each
// subject of the door has a file of its own in this folder (menus.ts, ...) and one call in renderer.ts. Never shipped.
import type { ExtensionManifest } from '../../../../extensions/types.ts'

export const manifest: ExtensionManifest = {
  id: 'door-probe',
  version: '0.0.1',
  displayName: 'Prova da porta',
  description: 'Só para os testes: usa a porta do agente como uma extensão de verdade usaria.',
  hosts: ['renderer'],
  optional: true,
}
