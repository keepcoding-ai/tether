// The web-bridge extension in tetherd (F7 C2 + C3): at every start, with no action of the person, the tether's installation
// of the bridge is made whole (home, config, keys, brand, pinned extension id, capabilities), the agents' --mcp-config file
// is written and the bridge daemon warmed up (bridge-home.ts). The side effects wait for `onStarted`: only the tetherd
// that owns the pipe runs them (the loser of a pipe race, and the CLI/Electron main, which activate this entry through
// src/agents/load.ts for the doctor checks, never get there). C3 (agents.ts): the launch middleware hands that file and
// the slot's identity to every AI agent (off with `extensions.web-bridge.serveToAgents`), and an agent slot that exits
// releases its tabs at the bridge daemon.
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { normalizeSetting, readExtensionsSettings } from '../../app/shared/vscode-configuration-registry.ts'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import type { TetherDaemon } from '../../src/daemon/ext-api.ts'
import { McpHttpHost } from '../../src/daemon/mcp-http.ts'
import { BRIDGE_RESTART_NOTICE, clientIdOf, createLaunchMiddleware, releaseClient, releaseHttp } from './agents.ts'
import { createBridgeHost } from './bridge-home.ts'
import { manifest } from './manifest.ts'
import { bridgeHomeOf, bridgePortOf, httpMcpConfigPathOf, MCP_SERVER_NAME, mcpConfigPathOf, warmupAllowed } from './paths.ts'
import { findNode } from './warmup.ts'

export { manifest } from './manifest.ts'

/** `extensions.web-bridge.serveToAgents` as the app stores it (settings.json `extensions` object), normalized by the manifest's schema. */
export function serveToAgents(api: Pick<TetherDaemon, 'settings'>): boolean {
  const schema = manifest.contributes!.settings!.serveToAgents!
  const values = readExtensionsSettings(api.settings.get<unknown>('extensions')).values[manifest.id]
  return normalizeSetting(schema, values?.serveToAgents) === true
}

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
  // The bridge over HTTP for agents with `mcp.http` (agents.ts); it listens only in the tetherd that owns the pipe (onStarted).
  const http = new McpHttpHost({ name: MCP_SERVER_NAME, log: msg => api.log(msg), restartNotice: BRIDGE_RESTART_NOTICE })
  const httpDeps = { http, httpConfigFile: (slotId: string) => httpMcpConfigPathOf(api.home, slotId) }
  const middleware = createLaunchMiddleware({
    agent: name => api.agents.get(name),
    serve: () => serveToAgents(api),
    configFile: mcpConfigPathOf(api.home),
    exists: existsSync,
    log: msg => api.log(msg),
    ...httpDeps,
    node: () => findNode(),
  })
  return [
    api.onStarted(() => {
      void host.setup().catch(e => api.log(`preparação do bridge falhou: ${e instanceof Error ? e.message : String(e)}`))
      http.listen().then(
        p => api.log(`bridge servido aos agentes por HTTP em 127.0.0.1:${p}`),
        e => api.log(`servidor HTTP do bridge não subiu (${e instanceof Error ? e.message : String(e)}); agentes recebem o bridge por stdio`),
      )
    }),
    api.launch.use(middleware),
    { dispose: () => { void http.close() } },
    api.onSlot(ev => {
      if (ev.kind !== 'exited' || ev.slot.kind === 'shell') return
      releaseHttp(httpDeps, ev.slot.slotId)
      void releaseClient({ port, bridgeHome: bridgeHomeOf(api.home), log: msg => api.log(msg) }, clientIdOf(ev.slot.slotId))
    }),
    ...host.checks().map(check => api.doctor.register(check)),
  ]
}
