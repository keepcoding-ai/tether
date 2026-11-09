// E2E-only extension (built into the renderer only with TETHER_TEST_EXTENSIONS=1, see extensions/index.renderer.ts):
// declares one system desk and one pad, the way a real owner would. Never shipped.
import type { ExtensionManifest } from '../../../../extensions/types.ts'

export const DESK_ID = 'system-desk-probe.main'
export const PAD_ID = 'system-desk-probe.pad'

export const manifest: ExtensionManifest = {
  id: 'system-desk-probe',
  version: '0.0.1',
  displayName: 'Prova de mesa de sistema',
  description: 'Só para os testes: declara uma mesa de sistema e uma prancheta.',
  hosts: ['renderer'],
  optional: true,
  contributes: {
    systemDesks: [{ id: DESK_ID, title: 'Prova', icon: 'terminal-window', color: 'green' }],
    pads: [{ id: PAD_ID, title: 'Prova de selo', icon: 'bell', defaultSide: 'right', scope: 'global', order: 900 }],
  },
}
