// The web-bridge extension in tetherd (F7 C2): at every start, with no action of the person, the tether's installation of
// the bridge is made whole (home, config, keys, brand, pinned extension id, capabilities), the agents' --mcp-config file
// is written and the bridge daemon warmed up (bridge-home.ts). The CLI and Electron main also activate this entry
// (src/agents/load.ts) but only to collect the doctor checks: the side effects run in tetherd alone (api.process).
// The MCP injection into the agents' launch plans is C3. Comments explain the technical rule only.
import { resolve } from 'node:path'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import type { TetherDaemon } from '../../src/daemon/ext-api.ts'
import { createBridgeHost } from './bridge-home.ts'
import { bridgePortOf } from './paths.ts'
import { findNode } from './warmup.ts'

export { manifest } from './manifest.ts'

export function activate(api: TetherDaemon): IDisposable[] {
  // Read on use: Electron main bundles this module as CommonJS (import.meta.dirname is undefined there), and never runs it.
  const host = createBridgeHost({
    home: api.home,
    vendorDir: resolve(import.meta.dirname ?? '.', 'vendor'),
    port: bridgePortOf(),
    brand: { name: api.brand.name, color: api.brand.accent, hostId: api.brand.appId },
    nodeExe: () => findNode(),
    log: msg => api.log(msg),
  })
  if (api.process === 'tetherd') {
    void host.setup().catch(e => api.log(`preparação do bridge falhou: ${e instanceof Error ? e.message : String(e)}`))
  }
  return host.checks().map(check => api.doctor.register(check))
}
