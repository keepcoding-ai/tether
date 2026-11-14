// The web-bridge extension in tetherd (F7 C2 + C3): at every start, with no action of the person, the tether's installation
// of the bridge is made whole (home, config, keys, brand, pinned extension id, capabilities), the agents' --mcp-config file
// is written and the bridge daemon warmed up (bridge-home.ts). The side effects wait for `onStarted`: only the tetherd
// that owns the pipe runs them (the loser of a pipe race, and the CLI/Electron main, which activate this entry through
// src/agents/load.ts for the doctor checks, never get there). C3 (agents.ts): the launch middleware hands that file and
// the slot's identity to every AI agent (off with `extensions.web-bridge.serveToAgents`), and an agent slot that exits
// releases its tabs at the bridge daemon.
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { normalizeSetting, readExtensionsSettings, type SettingReader, settingReaderOf } from '../../app/shared/vscode-configuration-registry.ts'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import type { DaemonCheck, TetherDaemon } from '../../src/daemon/ext-api.ts'
import { bridgeDebugOn, bridgeDebugSummary } from './capabilities.ts'
import { McpHttpHost, type McpBackend, type McpTransport } from '../../src/daemon/mcp-http.ts'
import { type BridgeBackendInput, clientIdOf, createLaunchMiddleware, releaseClient, releaseHttp } from './agents.ts'
import { dropGrants, type GrantStore, grantStoreOf } from './grant-store.ts'
import { auditVendor, VENDOR_BUNDLE } from './vendor-rules.ts'
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

/** This extension's settings as settings.json holds them, read now (the daemon has no change event). */
export function bridgeSettings(api: Pick<TetherDaemon, 'settings'>): SettingReader {
  return settingReaderOf(manifest.contributes!.settings!, readExtensionsSettings(api.settings.get<unknown>('extensions')).values[manifest.id])
}

/** The doctor's line of the debug mode: OK while off, AVISO while on (it should not stay on by accident). */
export function bridgeDebugCheck(settings: SettingReader): DaemonCheck {
  const name = `depuração do ${manifest.displayName}`
  const detail = bridgeDebugSummary(settings)
  if (!bridgeDebugOn(settings)) return { level: 'OK', name, detail }
  return { level: 'AVISO', name, detail, hint: `desligue em Configurações > ${manifest.displayName} > Depuração quando terminar de investigar` }
}

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
  grants(slotId: string): GrantStore
  importBundle?(path: string): Promise<unknown>
}): (input: BridgeBackendInput) => Promise<McpBackend> {
  const bundlePath = join(o.vendorDir, VENDOR_BUNDLE)
  let bundle: Promise<BridgeMcpBundle> | undefined
  const load = async (): Promise<BridgeMcpBundle> => {
    const problems = auditVendor(o.vendorDir)
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
    const mcp = lib.createBridgeMcp({ env: input.env, daemonEntry: bundlePath, node: input.node, grantStore: o.grants(input.slotId), stderr: false })
    // As the stdio shell does at its start: the bridge daemon comes up in the background when nobody listens.
    mcp.warmup()
    return mcp
  }
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
    settings: () => bridgeSettings(api),
    warm: warmupAllowed(),
  })
  // The bridge over HTTP for agents with `mcp.http` (agents.ts); it listens only in the tetherd that owns the pipe (onStarted).
  const http = new McpHttpHost({ name: MCP_SERVER_NAME, log: msg => api.log(msg) })
  const backend = createBridgeBackends({ vendorDir: resolve(import.meta.dirname ?? '.', 'vendor'), grants: slotId => grantStoreOf(api.home, slotId, msg => api.log(msg)) })
  const httpDeps = { http, httpConfigFile: (slotId: string) => httpMcpConfigPathOf(api.home, slotId) }
  const middleware = createLaunchMiddleware({
    agent: name => api.agents.get(name),
    serve: () => serveToAgents(api),
    configFile: mcpConfigPathOf(api.home),
    exists: existsSync,
    log: msg => api.log(msg),
    ...httpDeps,
    backend,
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
      // The pane was closed for good: the upload authorizations kept with it go.
      if (ev.kind === 'removed') { dropGrants(api.home, ev.slot.slotId); return }
      if (ev.kind !== 'exited' || ev.slot.kind === 'shell') return
      releaseHttp(httpDeps, ev.slot.slotId)
      void releaseClient({ port, bridgeHome: bridgeHomeOf(api.home), log: msg => api.log(msg) }, clientIdOf(ev.slot.slotId))
    }),
    ...host.checks().map(check => api.doctor.register(check)),
    api.doctor.register(async () => bridgeDebugCheck(bridgeSettings(api))),
  ]
}
