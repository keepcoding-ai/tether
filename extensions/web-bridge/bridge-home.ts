// The tether's installation of the bridge, kept by the daemon host at every tetherd start (design §1.1 a, b, c, e) with
// no action of the person. Electron-free and injectable, so the unit test runs it against the REAL vendored bundle in a
// temp home. What `setup()` guarantees, idempotently:
//   a. the bridge home <TETHER_HOME>/bridge exists with config.json (port 47831, pairing token, the `default` key) and
//      api.key: the bundle's `ensureConfig(home, port)` creates them or returns the existing ones (the port only counts at
//      creation: an installation that chose another port keeps it). No extension folder is touched here: `web-bridge/current`
//      is born in the install flow (installer.ts, §1.2) and refreshed in place by C5 (§1.3);
//   b. `brand` (the host's own: name, accent, appId) and the vendored build's extension id pinned in `extensionIds`
//      (`pinExtensionId` adds, never removes: a second id the person pinned stays). When the folder exists, its seed is
//      rewritten with `host` so the extension can say who it connects to before the daemon's welcome;
//   c. `capabilities` seeded ONCE, when the config has none: from build-info.json `brand.capabilities` (the package's
//      defaults, f7-bridge-marca §1.3) or, for a build without a brand, from this extension's settings defaults. The
//      bundle's `seedCapabilities` does it under the bridge's own config lock; existing values are never touched: the
//      package brings the default, the installation decides;
//   d. <TETHER_HOME>/mcp/tether-bridge.json, the --mcp-config the agents will receive (C3): `node <vendor>/atrium-bridge.mjs
//      mcp` with ATRIUM_BRIDGE_HOME, ATRIUM_BRIDGE_PORT and ATRIUM_BRIDGE_SERVER_NAME (the package's `brand.mcp.serverName`
//      when it has a valid one, else this extension's). Rewritten only when its content changed (the ensureSettingsFile
//      pattern of src/agents/claude.ts). No secret: the shell reads api.key by the home;
//   e. the daemon warmed up (warmup.ts), so the browser finds it before any agent does;
//   f. (C5, update.ts) the extension folder, when installed, brought to the vendored build file by file, with
//      `extensionVersion` kept in config.json through the bundle's `setExtensionVersion` (the daemon carries it in its
//      welcome and the extension reloads itself once per version); and the daemon restarted when the tether's record
//      says it runs an older bundle, by its daemon.pid only after proving pid + command line + port owner.
// Secrets (pairing token, api key) stay inside the bundle's functions and the files it owns: no log line, no error and
// no file written here carries one.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { DaemonCheck } from '../../src/daemon/ext-api.ts'
import { manifest } from './manifest.ts'
import { bridgeHomeOf, extensionDirOf, MCP_SERVER_NAME, mcpConfigPathOf } from './paths.ts'
import { extensionOutdated, extensionVersionOf, readUpdateMarker, restartIfOutdated, syncExtensionVersion, updateExtensionDir, writeUpdateMarker, type RestartDeps } from './update.ts'
import { auditVendor, isBuildInfo, VENDOR_BUILD_INFO, VENDOR_BUNDLE, VENDOR_EXTENSION_DIR, type BuildInfo } from './vendor-rules.ts'
import { createWarmup, type Warmup, type WarmupDeps } from './warmup.ts'

/** What the bridge bundle exports that this host uses (chrome-extensions/bridge/daemon/src/bundle.ts). */
export interface BridgeBundle {
  /** config.json + api.key of `home`, created (at `port`) or the existing ones; installs no extension. */
  ensureConfig(home: string, port?: number): { port: number; pairingToken: string; brand?: BridgeBrand; extensionIds?: string[]; capabilities?: Record<string, unknown> }
  installExtension(opts: { home: string; dir: string; source?: string; pin?: boolean; port?: number; buildInfo?: string; seed?: boolean }): { dir: string; extensionId: string; port: number; extensionIds: string[]; files: number }
  writeSeed(dir: string, seed: { port: number; token: string; host?: string }): string
  setBrand(home: string, brand: BridgeBrand | null): void
  pinExtensionId(home: string, id: string): string[]
  /** Writes `defaults` as config.capabilities only when the config has none; returns the keys written, else []. */
  seedCapabilities(home: string, defaults: Record<string, unknown>): string[]
  /** config.extensionVersion (the installed folder's manifest version, carried in the daemon's welcome); null removes it. */
  setExtensionVersion(home: string, version: string | null): void
  localKeyPath(home: string): string
  version: string
}

export interface BridgeBrand { name: string; color?: string; hostId?: string }

export type ImportBundle = (path: string) => Promise<BridgeBundle>
export const importBundleFromDisk: ImportBundle = p => import(pathToFileURL(p).href) as Promise<BridgeBundle>

/** The vendored build's contract (undefined when vendor/ is missing or its build-info unreadable). */
export function readBuildInfo(vendorDir: string): BuildInfo | undefined {
  try {
    const info: unknown = JSON.parse(readFileSync(join(vendorDir, VENDOR_BUILD_INFO), 'utf8'))
    return isBuildInfo(info) ? info : undefined
  } catch { return undefined }
}

// ---- the pieces ----------------------------------------------------------------------------------------------------

/** The brand into the config and, when the extension folder exists, its seed rewritten with `host` (shared with installer.ts). */
export function brandAndSeed(b: BridgeBundle, bridgeHome: string, currentDir: string, port: number, brand: BridgeBrand): void {
  b.setBrand(bridgeHome, brand)
  const config = JSON.parse(readFileSync(join(bridgeHome, 'config.json'), 'utf8')) as { pairingToken?: string }
  if (typeof config.pairingToken === 'string' && existsSync(join(currentDir, 'manifest.json'))) b.writeSeed(currentDir, { port, token: config.pairingToken, host: brand.name })
}

/** The capabilities a fresh installation starts with: the package's defaults, or this extension's settings defaults. */
export function defaultCapabilities(info: BuildInfo | undefined): Record<string, unknown> {
  if (info?.brand?.capabilities) return { ...info.brand.capabilities }
  const settings = manifest.contributes?.settings ?? {}
  // serveToAgents is the tether's own switch (whether the MCP is offered at all), not a capability of the bridge.
  // The bridge's key for "a window per agent" is windowPerAgent (the extension's capability("windowPerAgent")).
  return { windowPerAgent: settings.agentWindows?.default, evaluate: settings.evaluate?.default }
}

const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/** The MCP server's name: the package's `brand.mcp.serverName` when valid (the bridge's own rule), else this extension's. */
export function serverNameOf(info: BuildInfo | undefined): string {
  const name = info?.brand?.mcp?.serverName?.trim()
  return name && SERVER_NAME_PATTERN.test(name) ? name : MCP_SERVER_NAME
}

/** Writes `text` to `path` in one move (temp + rename). */
export function writeFileAtomic(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, text, { mode: 0o600 })
  try { renameSync(tmp, path) } finally { rmSync(tmp, { force: true }) }
}

export interface McpConfig {
  mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>
}

/** The --mcp-config the agents receive: `node <bundle> mcp`, pointed at the tether's bridge home and port. No secret: the shell reads api.key from the home. */
export function mcpConfigOf(bridgeHome: string, bundlePath: string, port: number, serverName: string = MCP_SERVER_NAME): McpConfig {
  return {
    mcpServers: {
      [serverName]: {
        command: 'node',
        args: [bundlePath, 'mcp'],
        env: { ATRIUM_BRIDGE_HOME: bridgeHome, ATRIUM_BRIDGE_PORT: String(port), ATRIUM_BRIDGE_SERVER_NAME: serverName },
      },
    },
  }
}

/** Writes <home>/mcp/tether-bridge.json only when its content changed. Returns whether it was written. */
export function writeMcpConfig(home: string, config: McpConfig): boolean {
  const path = mcpConfigPathOf(home)
  const content = JSON.stringify(config, null, 2) + '\n'
  let current: string | undefined
  try { current = readFileSync(path, 'utf8') } catch { /* missing */ }
  if (current === content) return false
  writeFileAtomic(path, content)
  return true
}

// ---- the host --------------------------------------------------------------------------------------------------------

export interface BridgeHostDeps {
  /** TETHER_HOME. */
  home: string
  /** extensions/web-bridge/vendor. */
  vendorDir: string
  port: number
  brand: BridgeBrand
  nodeExe(): string | undefined
  log(msg: string): void
  /** May this tetherd start the daemon (paths.ts warmupAllowed)? Default yes. The files are written either way. */
  warm?: boolean
  /** Injected in the unit test. */
  importBundle?: ImportBundle
  fetch?: WarmupDeps['fetch']
  spawnDaemon?: WarmupDeps['spawnDaemon']
  sleep?: WarmupDeps['sleep']
  /** The process questions of the daemon restart (C5), injected in the unit test. */
  process?: Pick<RestartDeps, 'identify' | 'portOwner' | 'kill' | 'alive'>
}

export interface SetupReport {
  ok: boolean
  /** config.json and api.key were missing and were created now (a first start on this home). */
  created: boolean
  /** Capability keys seeded now ([] when the installation already had its own). */
  capabilities: string[]
  mcpWritten: boolean
  /** The extension folder: not installed on this machine, already the vendored build, or brought to it now (C5). */
  extension: 'absent' | 'current' | 'updated'
  /**
   * `restarted`: it ran an older bundle and was replaced (C5); `skipped`: this home may not start the daemon (deps.warm
   * false), or the setup stopped before.
   */
  daemon: 'running' | 'started' | 'restarted' | 'failed' | 'skipped'
  /** Why it stopped (already logged), when !ok. */
  problem?: string
}

export interface BridgeHost {
  setup(): Promise<SetupReport>
  checks(): Array<() => Promise<DaemonCheck>>
  warmup: Warmup
}

export function createBridgeHost(deps: BridgeHostDeps): BridgeHost {
  const bridgeHome = bridgeHomeOf(deps.home)
  const currentDir = extensionDirOf(deps.home)
  const bundlePath = join(deps.vendorDir, VENDOR_BUNDLE)
  const warmup = createWarmup({ port: deps.port, bundlePath, bridgeHome, nodeExe: deps.nodeExe, log: deps.log, fetch: deps.fetch, spawnDaemon: deps.spawnDaemon, sleep: deps.sleep })
  const importBundle = deps.importBundle ?? importBundleFromDisk

  const setup = async (): Promise<SetupReport> => {
    const report: SetupReport = { ok: false, created: false, capabilities: [], mcpWritten: false, extension: 'absent', daemon: 'skipped' }
    const fail = (problem: string): SetupReport => { deps.log(problem); return { ...report, problem } }
    const problems = auditVendor(deps.vendorDir)
    if (problems.length) return fail(`vendor do bridge inválido, instalação não tocada: ${problems.slice(0, 3).join('; ')}${problems.length > 3 ? '…' : ''}`)
    const info = readBuildInfo(deps.vendorDir)
    if (!info) return fail(`vendor do bridge sem ${VENDOR_BUILD_INFO} legível, instalação não tocada`)
    let b: BridgeBundle
    try { b = await importBundle(bundlePath) } catch (e) { return fail(`bundle do bridge não carregou: ${e instanceof Error ? e.message : String(e)}`) }
    let serverName = MCP_SERVER_NAME
    try {
      const hadConfig = existsSync(join(bridgeHome, 'config.json')) && existsSync(b.localKeyPath(bridgeHome))
      // With a port, ensureConfig also overrides the STORED port in the returned copy; asked without one, an existing
      // config comes back as the installation wrote it (the file is never changed either way after creation).
      const config = hadConfig ? b.ensureConfig(bridgeHome) : b.ensureConfig(bridgeHome, deps.port)
      report.created = !hadConfig
      if (report.created) deps.log(`instalação do bridge criada em ${bridgeHome} (porta ${config.port}, bridge ${info.version}; a pasta da extensão nasce em "Instalar ${deps.brand.name} Bridge…")`)
      else if (config.port !== deps.port) deps.log(`instalação do bridge em ${bridgeHome} usa a porta ${config.port} no config.json; o tetherd sobe o daemon e aponta os agentes para ${deps.port}`)
      b.pinExtensionId(bridgeHome, info.extensionId)
      // C5: an installed folder is brought to the vendored build before its seed is rewritten below (same token).
      if (existsSync(join(currentDir, 'manifest.json'))) {
        const version = extensionVersionOf(join(deps.vendorDir, VENDOR_EXTENSION_DIR)) ?? info.version
        if (extensionOutdated(currentDir, info)) {
          const from = extensionVersionOf(currentDir) ?? '?'
          const u = updateExtensionDir(join(deps.vendorDir, VENDOR_EXTENSION_DIR), currentDir)
          writeUpdateMarker(deps.home, { version, at: new Date().toISOString() })
          report.extension = 'updated'
          deps.log(`extensão em ${currentDir} atualizada em lugar (${from} → ${version}: ${u.written.length} arquivo(s) gravado(s), ${u.removed.length} removido(s)); o navegador precisa recarregá-la`)
        } else report.extension = 'current'
        if (syncExtensionVersion(b, bridgeHome, version)) deps.log(`extensionVersion ${version} gravada no config.json do bridge`)
      }
      brandAndSeed(b, bridgeHome, currentDir, deps.port, deps.brand)
      report.capabilities = b.seedCapabilities(bridgeHome, defaultCapabilities(info))
      if (report.capabilities.length) deps.log(`capabilities semeadas do pacote: ${report.capabilities.join(', ')}`)
      serverName = serverNameOf(info)
    } catch (e) {
      const code = (e as { code?: unknown } | undefined)?.code
      return fail(`instalação do bridge falhou: ${typeof code === 'string' ? code : e instanceof Error ? e.message : String(e)}`)
    }
    report.mcpWritten = writeMcpConfig(deps.home, mcpConfigOf(bridgeHome, bundlePath, deps.port, serverName))
    deps.log(`${mcpConfigPathOf(deps.home)} ${report.mcpWritten ? 'gravado' : 'inalterado'} (servidor ${serverName}, porta ${deps.port})`)
    if (deps.warm === false) deps.log(`aquecimento do daemon pulado: home fora do padrão sem TETHER_BRIDGE_PORT próprio (a porta ${deps.port} é da instalação padrão)`)
    else {
      // C5: a daemon running an older bundle is replaced; otherwise the usual warm-up.
      const restart = await restartIfOutdated({ port: deps.port, bundlePath, bridgeHome, warmup, log: deps.log, sleep: deps.sleep, ...deps.process })
      report.daemon = restart === 'restarted' ? 'restarted' : restart === 'failed' ? 'failed' : await warmup.ensure()
    }
    report.ok = true
    return report
  }

  const checks = (): Array<() => Promise<DaemonCheck>> => [
    async () => {
      const name = `${deps.brand.name} Bridge`
      const problems = auditVendor(deps.vendorDir)
      if (problems.length) return { level: 'ERRO', name, detail: `cópia vendorizada incompleta ou alterada (${problems[0]})`, hint: 'rode "npm run bridge:build" e reinicie o tetherd' }
      const missing = ['config.json', 'api.key'].filter(f => !existsSync(join(bridgeHome, f)))
      if (missing.length) return { level: 'AVISO', name, detail: `instalação em ${bridgeHome} sem ${missing.join(' e ')}`, hint: 'abra o tether: o tetherd cria a instalação ao subir' }
      if (!existsSync(mcpConfigPathOf(deps.home))) return { level: 'AVISO', name, detail: `${mcpConfigPathOf(deps.home)} ausente`, hint: 'abra o tether: o tetherd grava o arquivo ao subir' }
      const info = readBuildInfo(deps.vendorDir)
      return { level: 'OK', name, detail: `instalação em ${bridgeHome} (porta ${deps.port}${info ? `, bridge ${info.version}` : ''})` }
    },
    async () => {
      const name = 'daemon do bridge'
      if (await warmup.health()) return { level: 'OK', name, detail: `responde em 127.0.0.1:${deps.port}` }
      return { level: 'AVISO', name, detail: `não responde na porta ${deps.port}`, hint: `o tetherd o inicia ao subir; veja ${join(bridgeHome, 'daemon.log')}` }
    },
    async () => {
      // C5: the folder under the browser's extension changed; until the extension reloads itself (the bridge's side of the
      // contract), the person clicks "Recarregar" once.
      const name = `extensão ${deps.brand.name} Bridge no navegador`
      if (!existsSync(join(currentDir, 'manifest.json'))) return { level: 'OK', name, detail: 'não instalada neste computador', hint: `"Instalar ${deps.brand.name} Bridge…" no menu do tether` }
      const version = extensionVersionOf(currentDir) ?? '?'
      const pending = readUpdateMarker(deps.home)
      if (pending) return { level: 'AVISO', name, detail: `a extensão foi atualizada para ${pending.version} em ${pending.at.slice(0, 16).replace('T', ' ')} e o navegador pode estar com a versão anterior carregada`, hint: 'clique em "Recarregar" no card da extensão em chrome://extensions (edge://extensions, brave://extensions) ou reinicie o navegador' }
      return { level: 'OK', name, detail: `pasta ${currentDir} na versão ${version}` }
    },
  ]

  return { setup, checks, warmup }
}
