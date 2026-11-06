// The web-bridge extension in tetherd (F7 C2): at every start, with no action of the person, the tether's installation of
// the bridge is made whole (home, config, keys, brand, pinned extension id, capabilities), the agents' --mcp-config file
// is written and the bridge daemon warmed up (bridge-home.ts). The side effects wait for `onStarted`: only the tetherd
// that owns the pipe runs them (the loser of a pipe race, and the CLI/Electron main, which activate this entry through
// src/agents/load.ts for the doctor checks, never get there). The MCP injection into the agents' launch plans is C3.
import { resolve } from 'node:path'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import type { TetherDaemon } from '../../src/daemon/ext-api.ts'
import { createBridgeHost } from './bridge-home.ts'
import { bridgePortOf, warmupAllowed } from './paths.ts'
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
    warm: warmupAllowed(),
  })
  return [
    api.onStarted(() => { void host.setup().catch(e => api.log(`preparação do bridge falhou: ${e instanceof Error ? e.message : String(e)}`)) }),
    ...host.checks().map(check => api.doctor.register(check)),
  ]
}
