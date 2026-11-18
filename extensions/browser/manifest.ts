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
  description: 'O navegador do Tether: as guias que os agentes abrem, numa mesa própria, com a pessoa sempre podendo assistir e assumir.',
  hosts: ['renderer', 'main', 'daemon'],
  optional: true,
  contributes: {
    paneTypes: [{
      id: 'web', idPrefix: WEB_PANE_PREFIX, component: WEB_COMPONENT, tabComponent: WEB_TAB,
      optionsOf: p => ({ id: p.id, component: WEB_COMPONENT, tabComponent: WEB_TAB, title: p.title ?? 'Guia', params: p.params ?? {} }),
    }],
    settings: {
      serveToAgents: {
        type: 'string', default: 'perProfile', enum: ['perProfile', 'all', 'off'], fromBoolean: { true: 'all', false: 'perProfile' },
        enumLabels: ['Só nos perfis marcados', 'Todos os agentes', 'Ninguém'],
        title: 'Navegador para os agentes dos painéis',
        description: 'Os agentes do Tether recebem as ferramentas do navegador e podem usar todas as contas logadas nas guias. Em "Só nos perfis marcados", vale para os agentes lançados com um perfil que tenha a opção "Navegador para os agentes" ligada; agentes sem perfil não recebem.',
        order: 3,
      },
      evaluate: { type: 'boolean', default: false, title: 'Permitir que o agente execute JavaScript na página', description: 'Desligado, o agente lê e age na página, mas não roda código nela.', order: 1 },
      localNetwork: { type: 'string', default: 'ask', enum: ['ask', 'allow', 'deny'], enumLabels: ['Perguntar na primeira vez', 'Sempre permitir neste perfil', 'Nunca permitir'], title: 'Abrir localhost e a rede local', description: 'Se o agente pode abrir localhost e endereços da rede local nas guias.', order: 2 },
      // The history of closed tabs (closed-rules.ts): expired when read and at start, never by a timer.
      closedHistory: {
        type: 'string', default: '7d', enum: ['1d', '7d', '30d', 'never'], enumLabels: ['1 dia', '7 dias', '30 dias', 'Para sempre'], order: 4,
        title: 'Guardar as guias fechadas',
        description: 'Por quanto tempo as guias fechadas ficam em "Fechadas", no painel Guias, para reabrir. Em "Para sempre", ficam as 500 mais recentes. Endereço que levava uma credencial nunca é guardado.',
      },
      // The debug mode (debug-file.ts): written live to <home>/browser/debug.json, read by the vendored server at every call.
      // The timeouts' defaults are the server's own (ACTION_TIMEOUT_MS, SNAPSHOT_TIMEOUT_MS), shown for reference: a key
      // left unset is left out of the file, so the server keeps its own value.
      debug: {
        type: 'boolean', default: false, section: 'Depuração', order: 100,
        title: 'Modo de depuração',
        description: 'Para investigar quando o navegador do Tether falha com um agente. Ligado, o registro guarda mais detalhes de cada ação e valem os prazos abaixo; cada guia mostra a marca "Depuração". Os pedidos de permissão continuam iguais. Vale na hora, sem reabrir o agente. Deixe desligado no uso normal.',
      },
      debugActionTimeoutSec: {
        type: 'number', default: 15, min: 0, max: 86400, section: 'Depuração', order: 101,
        title: 'Prazo de cada ação, em segundos',
        description: 'Quanto o agente espera por um clique, uma digitação ou uma espera na página antes de desistir. Só vale com o modo de depuração ligado. 0 = sem prazo. "Redefinir" volta ao prazo normal.',
      },
      debugSnapshotTimeoutSec: {
        type: 'number', default: 60, min: 0, max: 86400, section: 'Depuração', order: 102,
        title: 'Prazo para ler a página, em segundos',
        description: 'Quanto o agente espera para ler o conteúdo da página antes de desistir. Só vale com o modo de depuração ligado. 0 = sem prazo. "Redefinir" volta ao prazo normal.',
      },
    },
    systemDesks: [{ id: DESK_ID, title: 'Browser', icon: 'app-window', color: 'blue' }],
    // Below the explorer (order 10) on the left bar.
    pads: [{ id: PAD_ID, title: 'Guias', icon: 'globe-simple', defaultSide: 'left', scope: 'global', order: 20 }],
  },
}
