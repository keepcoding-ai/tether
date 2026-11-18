// The web-bridge extension in tetherd (F7 C2 + C3): at every start, with no action of the person, the tether's installation
// of the bridge is made whole (home, config, keys, brand, pinned extension id, capabilities), the agents' --mcp-config file
// is written and the bridge daemon warmed up (bridge-home.ts). The side effects wait for `onStarted`: only the tetherd
// that owns the pipe runs them (the loser of a pipe race, and the CLI/Electron main, which activate this entry through
// src/agents/load.ts for the doctor checks, never get there). C3 (agents.ts): the launch middleware hands that file and
// the slot's identity to every AI agent (off with `extensions.web-bridge.serveToAgents`), and an agent slot that exits
// releases its tabs at the bridge daemon.
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { normalizeSetting, readExtensionsSettings } from '../../app/shared/vscode-configuration-registry.ts'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import type { DaemonCheck, TetherDaemon } from '../../src/daemon/ext-api.ts'
import { bridgeTraceSource } from './trace-source.ts'
import { bridgeDebugStatusCheck, bridgeInFlightCheck } from './status-poll.ts'
import { McpHttpHost, type McpBackend, type McpTransport } from '../../src/daemon/mcp-http.ts'
import { type BridgeBackendInput, BridgeIdentities, clientIdOf, createLaunchMiddleware, releaseClient, releaseHttp } from './agents.ts'
import { dropGrants, type GrantStore, grantStoreOf } from './grant-store.ts'
import { auditVendor, VENDOR_BUNDLE } from './vendor-rules.ts'
import { createBridgeHost } from './bridge-home.ts'
import { manifest } from './manifest.ts'
import { bridgeHomeOf, bridgePortOf, httpMcpConfigPathOf, MCP_SERVER_NAME, mcpConfigPathOf, warmupAllowed } from './paths.ts'
import { findNodeAsync } from './warmup.ts'

export { manifest } from './manifest.ts'

/** `extensions.web-bridge.serveToAgents` as the app stores it (settings.json `extensions` object), normalized by the manifest's schema. */
export function serveToAgents(api: Pick<TetherDaemon, 'settings'>): boolean {
  const schema = manifest.contributes!.settings!.serveToAgents!
  const values = readExtensionsSettings(api.settings.get<unknown>('extensions')).values[manifest.id]
  return normalizeSetting(schema, values?.serveToAgents) === true
}

/** The doctor's line of the debug mode: what the bridge daemon reports (it is turned on in the extension's options page). */
export const bridgeDebugCheck = bridgeDebugStatusCheck

/** What the daemon uses of the vendored bundle as a module (chrome-extensions/bridge daemon/src/mcp-lib.ts). */
interface BridgeMcpBundle {
  createBridgeMcp(opts: {
    env: Record<string, string | undefined>; daemonEntry: string; node?: string; serverName?: string; grantStore?: GrantStore; stderr?: boolean
  }): { connect(transport: McpTransport): Promise<void>; warmup(): void; close(): Promise<void> }
}

/**
 * The slots' bridge shells inside the daemon: the vendored bundle is checked against its manifest and imported ONCE, at the
 * first agent that initializes; each slot then gets its own shell object, with its own env (home, port, identity) and its
 * own store of upload authorizations. A bundle that is not whole is never loaded into the daemon.
 */
export function createBridgeBackends(o: {
  vendorDir: string
  grants(slotId: string): GrantStore | Promise<GrantStore>
  importBundle?(path: string): Promise<unknown>
}): (input: BridgeBackendInput) => Promise<McpBackend> {
  const bundlePath = join(o.vendorDir, VENDOR_BUNDLE)
  let bundle: Promise<BridgeMcpBundle> | undefined
  const load = async (): Promise<BridgeMcpBundle> => {
    const problems = await auditVendor(o.vendorDir)
    if (problems.length) throw new Error(`bundle do bridge não confere com o manifesto (${problems[0]}${problems.length > 1 ? `, +${problems.length - 1}` : ''})`)
    const m = await (o.importBundle ?? (p => import(pathToFileURL(p).href)))(bundlePath) as Partial<BridgeMcpBundle>
    if (typeof m.createBridgeMcp !== 'function') throw new Error('o bundle vendorizado do bridge não tem a entrada de biblioteca (createBridgeMcp): revendorize')
    return m as BridgeMcpBundle
  }
  return async input => {
    bundle ??= load()
    bundle.catch(() => { bundle = undefined })
    const lib = await bundle
    // The shell's own log is <bridge home>/mcp.log, as in the stdio shell; nothing goes to the daemon's stderr.
    const mcp = lib.createBridgeMcp({ env: input.env, daemonEntry: bundlePath, node: input.node, grantStore: await o.grants(input.slotId), stderr: false })
    // As the stdio shell does at its start: the bridge daemon comes up in the background when nobody listens.
    mcp.warmup()
    return mcp
  }
}

export function activate(api: TetherDaemon): IDisposable[] {
  const port = bridgePortOf()
  // The system node is looked up through the executor once (the answer holds for the process; a miss is asked again).
  let nodeFound: Promise<string | undefined> | undefined
  const nodeOf = (): Promise<string | undefined> => {
    nodeFound ??= findNodeAsync(api.io).then(n => { if (!n) nodeFound = undefined; return n }, () => { nodeFound = undefined; return undefined })
    return nodeFound
  }
  // Read on use: Electron main bundles this module as CommonJS (import.meta.dirname is undefined there), and never runs it.
  const host = createBridgeHost({
    home: api.home,
    vendorDir: resolve(import.meta.dirname ?? '.', 'vendor'),
    port,
    brand: { name: api.brand.name, color: api.brand.accent, hostId: api.brand.appId },
    nodeExe: nodeOf,
    io: api.io,
    log: msg => api.log(msg),
    warm: warmupAllowed(),
  })
  // The bridge over HTTP for agents with `mcp.http` (agents.ts); it listens only in the tetherd that owns the pipe (onStarted).
  const http = new McpHttpHost({ name: MCP_SERVER_NAME, log: msg => api.log(msg) })
  const backend = createBridgeBackends({ vendorDir: resolve(import.meta.dirname ?? '.', 'vendor'), grants: slotId => grantStoreOf(api.home, slotId, msg => api.log(msg), api.io) })
  const httpDeps = { http, httpConfigFile: (slotId: string) => httpMcpConfigPathOf(api.home, slotId), io: api.io }
  // The agents' names at the bridge: given at launch, followed when the pane's tab changes, freed when the agent ends.
  const identities = new BridgeIdentities()
  const middleware = createLaunchMiddleware({
    identities,
    agent: name => api.agents.get(name),
    serve: () => serveToAgents(api),
    configFile: mcpConfigPathOf(api.home),
    exists: p => api.io.exists(p),
    log: msg => api.log(msg),
    ...httpDeps,
    backend,
    node: nodeOf,
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
      // The pane was closed for good: the upload authorizations kept with it go.
      if (ev.kind === 'removed') { identities.drop(ev.slot.slotId); void dropGrants(api.home, ev.slot.slotId, api.io); return }
      if (ev.slot.kind === 'shell') return
      // A renamed tab (or a new session's title): the agent served over HTTP is renamed at the bridge at its next call.
      if (ev.kind === 'changed' || ev.kind === 'bound' || ev.kind === 'spawned') { identities.follow(ev.slot); return }
      if (ev.kind !== 'exited') return
      identities.drop(ev.slot.slotId)
      void releaseHttp(httpDeps, ev.slot.slotId)
      void releaseClient({ port, bridgeHome: bridgeHomeOf(api.home), io: api.io, log: msg => api.log(msg) }, clientIdOf(ev.slot.slotId))
    }),
    ...host.checks().map(check => api.doctor.register(check)),
    api.doctor.register(() => bridgeInFlightCheck({ port, bridgeHome: bridgeHomeOf(api.home), io: api.io })),
    api.doctor.register(() => bridgeDebugStatusCheck({ port, bridgeHome: bridgeHomeOf(api.home), io: api.io, displayName: manifest.displayName, dumpDir: join(bridgeHomeOf(api.home), 'debug') })),
    api.traces.register(bridgeTraceSource(api.home)),
  ]
}
