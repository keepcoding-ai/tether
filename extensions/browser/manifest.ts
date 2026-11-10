// The browser extension (Tether Browser, slice E1): the skeleton. It declares what the core needs before activation: the
// system desk "Browser" (where the agents' tabs will live, design §5.1), the pad "Guias" on the left bar (the list and the
// controls, §5.3), the `web` pane type (the frame a tab sits in; empty for now) and the three settings of design §10.
// The vendored server (vendor/tether-browser/) and the gatekeeper, the network and the real tab come in later slices.
// Ids (desk, pad, pane type, settings) are saved in layout.json and settings.json and never change.
import type { ExtensionManifest } from '../types.ts'

export const DESK_ID = 'browser.desk'
export const PAD_ID = 'browser.tabs'
export const WEB_PANE_PREFIX = 'web:'
export const WEB_COMPONENT = 'browser-web'
export const WEB_TAB = 'browser-web-tab'

export const manifest: ExtensionManifest = {
  id: 'browser',
  version: '0.1.0',
  displayName: 'Browser',
  description: 'O navegador do tether: as guias que os agentes abrem, numa mesa própria, com a pessoa sempre podendo assistir e assumir.',
  hosts: ['renderer', 'main', 'daemon'],
  optional: true,
  contributes: {
    paneTypes: [{
      id: 'web', idPrefix: WEB_PANE_PREFIX, component: WEB_COMPONENT, tabComponent: WEB_TAB,
      optionsOf: p => ({ id: p.id, component: WEB_COMPONENT, tabComponent: WEB_TAB, title: p.title ?? 'Guia', params: p.params ?? {} }),
    }],
    settings: {
      serveToAgents: { type: 'boolean', default: false, title: 'Oferecer o navegador aos agentes dos painéis', description: 'Os agentes do tether recebem as ferramentas do navegador e podem usar todas as contas logadas nas guias.' },
      evaluate: { type: 'boolean', default: false, title: 'Permitir que o agente execute JavaScript na página', description: 'Desligado, o agente lê e age na página, mas não roda código nela.' },
      localNetwork: { type: 'string', default: 'ask', enum: ['ask', 'allow', 'deny'], enumLabels: ['Perguntar na primeira vez', 'Sempre permitir neste perfil', 'Nunca permitir'], title: 'Abrir localhost e a rede local', description: 'Se o agente pode abrir localhost e endereços da rede local nas guias.' },
    },
    systemDesks: [{ id: DESK_ID, title: 'Browser', icon: 'app-window', color: 'blue' }],
    // Below the explorer (order 10) on the left bar.
    pads: [{ id: PAD_ID, title: 'Guias', icon: 'globe-simple', defaultSide: 'left', scope: 'global', order: 20 }],
  },
}
