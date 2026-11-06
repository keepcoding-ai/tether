// The web-bridge extension (F7): the Tether Bridge, the browser extension + local daemon that let the AI agents in the
// panes drive the person's own Chrome (Edge, Brave). Slice C1: the vendored bridge (vendor/), the settings and the one
// manual moment of the experience, "Instalar Tether Bridge…" (design §1.2): pick a browser, the extension is copied to
// a fixed folder with its pairing seeded, the folder path lands in the clipboard, the browser opens at its extensions
// page, and a three-step guide waits for the browser to connect and closes by itself. Slice C2: the daemon side
// (daemon.ts) keeps the installation whole, writes the agents' --mcp-config and warms the daemon up at every tetherd
// start. The MCP injection into the agents (C3) and the status icon (C4) come in their own slices. Ids never change.
import type { ExtensionManifest } from '../types.ts'
import { BRAND } from '../../app/shared/brand.ts'

export const BRIDGE_NAME = `${BRAND.name} Bridge`

export const manifest: ExtensionManifest = {
  id: 'web-bridge',
  version: '0.1.0',
  displayName: BRIDGE_NAME,
  description: `A extensão do navegador e o serviço local que deixam os agentes dos painéis usarem o seu Chrome, Edge ou Brave (${BRIDGE_NAME}).`,
  hosts: ['renderer', 'main', 'daemon'],
  optional: true,
  contributes: {
    settings: {
      serveToAgents: { type: 'boolean', default: true, title: `Oferecer o ${BRIDGE_NAME} aos agentes dos painéis` },
      agentWindows: { type: 'boolean', default: true, title: 'Abas dos agentes em uma janela própria por agente' },
      evaluate: { type: 'string', default: 'own-tabs', enum: ['own-tabs', 'all', 'off'], title: 'Onde um agente pode rodar código na página (evaluate)' },
    },
    commands: [
      { command: 'web-bridge.install', title: `Instalar ${BRIDGE_NAME}…`, category: BRIDGE_NAME, icon: 'globe-simple' },
    ],
    menus: {
      app: [
        // order 7: in the 'app' group after "Atalhos de teclado" (5) and before the core's "Extensões" (10).
        { command: 'web-bridge.install', group: 'app', order: 7, icon: 'globe-simple', label: `Instalar ${BRIDGE_NAME}…` },
      ],
    },
  },
}
