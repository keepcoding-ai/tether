// The web-bridge extension in tetherd (F7 C2 + C3): at every start, with no action of the person, the tether's installation
// of the bridge is made whole (home, config, keys, brand, pinned extension id, capabilities), the agents' MCP is written
// into the folder of the feature `bridge` and the bridge daemon warmed up (bridge-home.ts). The side effects wait for
// `onStarted`: only the tetherd that owns the pipe runs them (the loser of a pipe race, and the CLI/Electron main, which
// activate this entry through src/agents/load.ts for the doctor checks, never get there). C3 (agents.ts): the feature's
// folder is provided to the host (which composes it into every launch that has the feature on), the launch middleware
// adds the slot's identity for the bridge, and an agent slot that exits releases its tabs at the bridge daemon.
import { resolve } from 'node:path'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import type { TetherDaemon } from '../../src/daemon/ext-api.ts'
import { clientIdOf, createLaunchMiddleware, releaseClient } from './agents.ts'
import { bridgeShareDir, createBridgeHost } from './bridge-home.ts'
import { BRIDGE_FEATURE } from './manifest.ts'
import { bridgeHomeOf, bridgePortOf, warmupAllowed } from './paths.ts'
import { findNode } from './warmup.ts'

export { manifest } from './manifest.ts'

export function activate(api: TetherDaemon): IDisposable[] {
  const port = bridgePortOf()
  // Read on use: Electron main bundles this module as CommonJS (import.meta.dirname is undefined there), and never runs it.
  const host = createBridgeHost({
    home: api.home,
    vendorDir: resolve(import.meta.dirname ?? '.', 'vendor'),
    port,
    brand: { name: api.brand.name, color: api.brand.accent, hostId: api.brand.appId },
    nodeExe: () => findNode(),
    log: msg => api.log(msg),
    warm: warmupAllowed(),
  })
  const middleware = createLaunchMiddleware({ agent: name => api.agents.get(name), log: msg => api.log(msg) })
  return [
    api.features.provide(BRIDGE_FEATURE, () => bridgeShareDir(api.home)),
    api.onStarted(() => { void host.setup().catch(e => api.log(`preparação do bridge falhou: ${e instanceof Error ? e.message : String(e)}`)) }),
    api.launch.use(middleware),
    api.onSlot(ev => {
      if (ev.kind !== 'exited' || ev.slot.kind === 'shell') return
      void releaseClient({ port, bridgeHome: bridgeHomeOf(api.home), log: msg => api.log(msg) }, clientIdOf(ev.slot.slotId))
    }),
    ...host.checks().map(check => api.doctor.register(check)),
  ]
}
