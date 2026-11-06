// The tether's installation of the bridge, kept by the daemon host at every tetherd start (design §1.1 a, b, c, e) with
// no action of the person. Electron-free and injectable, so the unit test runs it against the REAL vendored bundle in a
// temp home. What `setup()` guarantees, idempotently:
//   a. the bridge home <TETHER_HOME>/bridge exists with config.json (port 47831, pairing token, the `default` key) and
//      api.key. The bundle exports no `ensureConfig`; the one export that creates the config AT A GIVEN PORT is
//      `installExtension`, which also stages the extension folder `current/` with its seed (the folder §1.3 updates in
//      place). So a missing config or a missing folder means an install from the vendored copy; otherwise nothing is copied;
//   b. `brand` (the host's own: name, accent, appId) and the vendored build's extension id pinned in `extensionIds`
//      (`pinExtensionId` adds, never removes: a second id the person pinned stays). The seed gets `host` so the extension
//      can say who it connects to before the daemon's welcome;
//   c. `capabilities` seeded ONCE, when the config has none: from build-info.json `brand.capabilities` (the package's
//      defaults, f7-bridge-marca §1.3) or, while the vendored build has none, from this extension's settings defaults.
//      Existing values are never touched: the package brings the default, the installation decides;
//   d. <TETHER_HOME>/mcp/tether-bridge.json, the --mcp-config the agents will receive (C3): `node <vendor>/atrium-bridge.mjs
//      mcp` with ATRIUM_BRIDGE_HOME, ATRIUM_BRIDGE_PORT and ATRIUM_BRIDGE_SERVER_NAME. Rewritten only when its content
//      changed (the ensureSettingsFile pattern of src/agents/claude.ts). No secret: the shell reads api.key by the home;
//   e. the daemon warmed up (warmup.ts), so the browser finds it before any agent does.
// Secrets (pairing token, api key) stay inside the bundle's functions and the files it owns: no log line, no error and
// no file written here carries one. The `capabilities` merge preserves every other field byte for byte in meaning and
// honours the bridge's folder lock (config.lock, created exclusively; a dead owner's lock expires in 10 s).
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { DaemonCheck } from '../../src/daemon/ext-api.ts'
import { manifest } from './manifest.ts'
import { bridgeHomeOf, extensionDirOf, MCP_SERVER_NAME, mcpConfigPathOf } from './paths.ts'
import { auditVendor, isBuildInfo, VENDOR_BUILD_INFO, VENDOR_BUNDLE, VENDOR_EXTENSION_DIR, type BuildInfo } from './vendor-rules.ts'
import { createWarmup, type Warmup, type WarmupDeps } from './warmup.ts'

/** What the bridge bundle exports that this host uses (chrome-extensions/bridge/daemon/src/bundle.ts). */
export interface BridgeBundle {
  installExtension(opts: { home: string; dir: string; source?: string; pin?: boolean; port?: number }): { dir: string; extensionId: string; port: number; extensionIds: string[]; files: number }
  writeSeed(dir: string, seed: { port: number; token: string; host?: string }): string
  setBrand(home: string, brand: BridgeBrand | null): void
  pinExtensionId(home: string, id: string): string[]
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

/** The brand into the config and the seed rewritten with `host`, after an install (shared with the install flow, installer.ts). */
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
  return { agentWindows: settings.agentWindows?.default, evaluate: settings.evaluate?.default }
}

const LOCK_STALE_MS = 10_000
const LOCK_WAIT_MS = 10_000
const sleepSync = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }

/** Runs `fn` holding the bridge's own config lock (<bridgeHome>/config.lock, the protocol of its config.ts). */
function withBridgeConfigLock<T>(bridgeHome: string, fn: () => T): T {
  const lock = join(bridgeHome, 'config.lock')
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try { writeFileSync(lock, `${process.pid}\n`, { flag: 'wx' }); break } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      try { if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { force: true }) } catch { /* the owner just released it */ }
      if (Date.now() > deadline) throw new Error(`config lock ${lock} is held by another process`)
      sleepSync(20)
    }
  }
  try { return fn() } finally { rmSync(lock, { force: true }) }
}

/** Writes `text` to `path` in one move (temp + rename). */
export function writeFileAtomic(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, text, { mode: 0o600 })
  try { renameSync(tmp, path) } finally { rmSync(tmp, { force: true }) }
}

/** Adds `capabilities` to config.json when it has none. Returns the keys written, or [] when the installation already decided. */
export function seedCapabilities(bridgeHome: string, caps: Record<string, unknown>): string[] {
  const path = join(bridgeHome, 'config.json')
  return withBridgeConfigLock(bridgeHome, () => {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    if ('capabilities' in raw) return []
    writeFileAtomic(path, JSON.stringify({ ...raw, capabilities: caps }, null, 2))
    return Object.keys(caps)
  })
}

export interface McpConfig {
  mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>
}

/** The --mcp-config the agents receive: `node <bundle> mcp`, pointed at the tether's bridge home and port. No secret: the shell reads api.key from the home. */
export function mcpConfigOf(bridgeHome: string, bundlePath: string, port: number): McpConfig {
  return {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        command: 'node',
        args: [bundlePath, 'mcp'],
        env: { ATRIUM_BRIDGE_HOME: bridgeHome, ATRIUM_BRIDGE_PORT: String(port), ATRIUM_BRIDGE_SERVER_NAME: MCP_SERVER_NAME },
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
  /** Injected in the unit test. */
  importBundle?: ImportBundle
  fetch?: WarmupDeps['fetch']
  spawnDaemon?: WarmupDeps['spawnDaemon']
  sleep?: WarmupDeps['sleep']
}

export interface SetupReport {
  ok: boolean
  /** The config and/or the extension folder were missing and were installed from the vendored copy. */
  installed: boolean
  /** Capability keys seeded now ([] when the installation already had its own). */
  capabilities: string[]
  mcpWritten: boolean
  daemon: 'running' | 'started' | 'failed' | 'skipped'
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
    const report: SetupReport = { ok: false, installed: false, capabilities: [], mcpWritten: false, daemon: 'skipped' }
    const fail = (problem: string): SetupReport => { deps.log(problem); return { ...report, problem } }
    const problems = auditVendor(deps.vendorDir)
    if (problems.length) return fail(`vendor do bridge inválido, instalação não tocada: ${problems.slice(0, 3).join('; ')}${problems.length > 3 ? '…' : ''}`)
    const info = readBuildInfo(deps.vendorDir)
    if (!info) return fail(`vendor do bridge sem ${VENDOR_BUILD_INFO} legível, instalação não tocada`)
    let b: BridgeBundle
    try { b = await importBundle(bundlePath) } catch (e) { return fail(`bundle do bridge não carregou: ${e instanceof Error ? e.message : String(e)}`) }
    try {
      const hasConfig = existsSync(join(bridgeHome, 'config.json'))
      const hasFolder = existsSync(join(currentDir, 'manifest.json'))
      if (!hasConfig || !hasFolder) {
        const r = b.installExtension({ home: bridgeHome, dir: currentDir, source: join(deps.vendorDir, VENDOR_EXTENSION_DIR), pin: true, port: deps.port })
        report.installed = true
        deps.log(`instalação do bridge ${hasConfig ? 'completada' : 'criada'} em ${bridgeHome} (porta ${r.port}, extensão em ${r.dir}, ${r.files} arquivos)`)
      }
      b.pinExtensionId(bridgeHome, info.extensionId)
      brandAndSeed(b, bridgeHome, currentDir, deps.port, deps.brand)
      report.capabilities = seedCapabilities(bridgeHome, defaultCapabilities(info))
      if (report.capabilities.length) deps.log(`capabilities semeadas: ${report.capabilities.join(', ')}`)
    } catch (e) {
      const code = (e as { code?: unknown } | undefined)?.code
      return fail(`instalação do bridge falhou: ${typeof code === 'string' ? code : e instanceof Error ? e.message : String(e)}`)
    }
    report.mcpWritten = writeMcpConfig(deps.home, mcpConfigOf(bridgeHome, bundlePath, deps.port))
    deps.log(`${mcpConfigPathOf(deps.home)} ${report.mcpWritten ? 'gravado' : 'inalterado'} (servidor ${MCP_SERVER_NAME}, porta ${deps.port})`)
    report.daemon = await warmup.ensure()
    report.ok = true
    return report
  }

  const checks = (): Array<() => Promise<DaemonCheck>> => [
    async () => {
      const name = `${deps.brand.name} Bridge`
      const problems = auditVendor(deps.vendorDir)
      if (problems.length) return { level: 'ERRO', name, detail: `cópia vendorizada incompleta ou alterada (${problems[0]})`, hint: 'rode "node extensions/web-bridge/vendor.mjs" e reinicie o tetherd' }
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
  ]

  return { setup, checks, warmup }
}
