// The web-bridge extension (F7): the Tether Bridge, the browser extension + local daemon that let the AI agents in the
// panes drive the person's own Chrome (Edge, Brave). Slice C1: the vendored bridge (vendor/), the settings and the one
// manual moment of the experience, "Instalar Tether Bridge…" (design §1.2): pick a browser, the extension is copied to
// a fixed folder with its pairing seeded, the folder path lands in the clipboard, the browser opens at its extensions
// page, and a three-step guide waits for the browser to connect and closes by itself. Slice C2: the daemon side
// (daemon.ts) keeps the installation whole, writes the agents' --mcp-config and warms the daemon up at every tetherd
// start. C3 hands the MCP to the agents; C4 is the status icon on the top bar (`contributes.status`: the brand's
// monogram, grey/normal/busy/amber/red per design §5, the popover with the browsers, the agents and the controls).
// Ids never change.
import type { ExtensionManifest } from '../types.ts'
import { BRAND } from '../../app/shared/brand.ts'

/** The extension's name in the browser, as brand/brand.json states it ("Tether Bridge"). */
export const BRIDGE_NAME = BRAND.product

/** The status icon's id (`contributes.status`), never renamed. */
export const STATUS_ID = 'web-bridge.status'

export const manifest: ExtensionManifest = {
  id: 'web-bridge',
  version: '0.1.0',
  displayName: BRIDGE_NAME,
  description: `A extensão do navegador e o serviço local que deixam os agentes dos painéis usarem o seu Chrome, Edge ou Brave (${BRIDGE_NAME}).`,
  hosts: ['renderer', 'main', 'daemon'],
  optional: true,
  contributes: {
    settings: {
      serveToAgents: { type: 'boolean', default: true, title: `Oferecer o ${BRIDGE_NAME} aos agentes dos painéis`, description: 'Os agentes dos painéis recebem as ferramentas do navegador.' },
      agentWindows: { type: 'boolean', default: true, title: 'Abas dos agentes em uma janela própria por agente', description: 'Cada agente abre suas abas numa janela do navegador só dele.' },
      evaluate: { type: 'string', default: 'own-tabs', enum: ['own-tabs', 'all', 'off'], enumLabels: ['Só nas abas do agente', 'Em qualquer aba', 'Em nenhuma'], title: 'Onde um agente pode rodar código na página (evaluate)', description: 'Só nas abas do próprio agente, em qualquer aba, ou em nenhuma.' },
    },
    commands: [
      { command: 'web-bridge.install', title: `Instalar ${BRIDGE_NAME}…`, category: BRIDGE_NAME, icon: 'globe-simple' },
    ],
    menus: {
      app: [
        // Ferramentas submenu: last, after the core's "Extensões" (30).
        { command: 'web-bridge.install', group: 'tools', order: 40, icon: 'globe-simple', label: `Instalar ${BRIDGE_NAME}…` },
      ],
    },
    status: [
      // The brand's monogram (app/renderer/icons.ts 'brand'); order 50 leaves room on both sides.
      { id: STATUS_ID, icon: 'brand', order: 50 },
    ],
  },
}
