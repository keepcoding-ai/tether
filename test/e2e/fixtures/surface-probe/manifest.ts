// E2E-only extension (built in only with TETHER_TEST_EXTENSIONS=1): its main side hands the extension API's surfaces to the
// E2E (`globalThis.__surfaceProbe`) and creates the surface of its test panel; its renderer side is that panel.
import type { ExtensionManifest } from '../../../../extensions/types.ts'

export const PANEL_PREFIX = 'surfprobe:'
export const PANEL_COMPONENT = 'surface-probe-panel'
export const PANEL_TAB = 'surface-probe-tab'

export const manifest: ExtensionManifest = {
  id: 'surface-probe',
  version: '0.0.1',
  displayName: 'Prova de superfícies',
  description: 'Só para os testes: cria superfícies nativas e um painel que as hospeda.',
  hosts: ['main', 'renderer'],
  optional: true,
  contributes: {
    paneTypes: [{
      id: 'surface-probe', idPrefix: PANEL_PREFIX, component: PANEL_COMPONENT, tabComponent: PANEL_TAB,
      optionsOf: p => ({ id: p.id, component: PANEL_COMPONENT, tabComponent: PANEL_TAB, title: p.title ?? 'Superfície', params: p.params ?? {} }),
    }],
  },
}
