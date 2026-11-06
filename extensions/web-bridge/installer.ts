// The install flow's engine (design §1.2), Electron-free so the unit test runs it with a fake browser and a temp home:
//   1. the vendored copy is checked against its manifest (a corrupted vendor/ never reaches the browser);
//   2. the bridge bundle's `installExtension` copies vendor/extension into the fixed `current` folder, seeds `bridge.json`
//      (port + pairing token) and pins the extension id in the bridge home's config.json; the brand goes in the config
//      and the seed is rewritten with `host` so the extension can say who it is connecting to;
//   3. the daemon is warmed up: when GET /health does not answer, `node atrium-bridge.mjs start --port N` is spawned
//      detached with a minimal environment (the bridge's own allowlist idea: nothing of the shell becomes its config),
//      cwd and ATRIUM_BRIDGE_HOME in the bridge home, stdout/stderr in its daemon.log; /health is awaited up to 15 s.
//      The daemon side (C2) will own the steady-state warm-up; the guide needs the daemon now so "waiting" can end;
//   4. the browser opens at its extensions page, detached.
// Secrets: the pairing token and the api.key are read from files here and handed only to the bridge's functions or to
// the HTTP bearer header; they never go in a log line, an error message or an IPC reply.
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { DetectedBrowser } from './browsers.ts'
import type { ConnectedOutcome, InstallOutcome } from './ipc.ts'
import { bridgeHomeOf, browsersUrl, extensionDirOf, healthUrl } from './paths.ts'
import { auditVendor, isBuildInfo, VENDOR_BUILD_INFO, VENDOR_BUNDLE, VENDOR_EXTENSION_DIR, type BuildInfo } from './vendor-rules.ts'

/** What the bridge bundle exports that this host uses (chrome-extensions/bridge/daemon/src/bundle.ts). */
export interface BridgeBundle {
  installExtension(opts: { home: string; dir: string; source?: string; pin?: boolean; port?: number }): { dir: string; extensionId: string; port: number; extensionIds: string[]; files: number }
  writeSeed(dir: string, seed: { port: number; token: string; host?: string }): string
  setBrand(home: string, brand: { name: string; color?: string; hostId?: string } | null): void
  localKeyPath(home: string): string
  version: string
}

export interface InstallerDeps {
  /** TETHER_HOME. */
  home: string
  /** extensions/web-bridge/vendor. */
  vendorDir: string
  port: number
  brand: { name: string; color?: string; hostId?: string }
  /** The node that runs the daemon (Electron's own binary cannot: the bundle is a Node program). */
  nodeExe(): string | undefined
  log(msg: string): void
  /** Injected in the unit test: the bundle import, the HTTP fetch, the spawns. */
  importBundle?(path: string): Promise<BridgeBundle>
  fetch?: typeof fetch
  spawnDaemon?(node: string, bundle: string, port: number, bridgeHome: string): number | undefined
  openBrowser?(browser: DetectedBrowser): void
  sleep?(ms: number): Promise<void>
}

/** `TETHER_NODE`, then npm's node, then the first `node` on PATH: the same rule app/main/main.ts uses for tetherd. */
export function findNode(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): string | undefined {
  if (env.TETHER_NODE && exists(env.TETHER_NODE)) return env.TETHER_NODE
  if (env.npm_node_execpath && exists(env.npm_node_execpath)) return env.npm_node_execpath
  const name = process.platform === 'win32' ? 'node.exe' : 'node'
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir.replace(/^"|"$/g, ''), name)
    if (exists(candidate)) return candidate
  }
  return undefined
}

/** The daemon's environment: a fixed allowlist of the system's variables plus its home. Nothing else of this process. */
const DAEMON_ENV_KEYS = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'COMSPEC', 'OS', 'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'LANG', 'LC_ALL']
export function daemonEnv(bridgeHome: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of DAEMON_ENV_KEYS) if (env[k] !== undefined) out[k] = env[k]!
  out.ATRIUM_BRIDGE_HOME = resolve(bridgeHome)
  return out
}

/** Starts the bridge daemon detached (survives the app, no window), its output appended to <bridgeHome>/daemon.log. */
export function spawnBridgeDaemon(node: string, bundle: string, port: number, bridgeHome: string): number | undefined {
  mkdirSync(bridgeHome, { recursive: true })
  const fd = openSync(join(bridgeHome, 'daemon.log'), 'a')
  try {
    const child = spawn(node, [bundle, 'start', '--port', String(port)], { cwd: resolve(bridgeHome), env: daemonEnv(bridgeHome), detached: true, windowsHide: true, stdio: ['ignore', fd, fd] })
    child.on('error', () => {})
    child.unref()
    return child.pid
  } finally { closeSync(fd) }
}

/** Opens the browser at its extensions page, detached. A `.cmd`/`.bat` launcher (tests, portable shims) needs the shell. */
export function openBrowserAt(browser: DetectedBrowser): void {
  const script = /\.(cmd|bat)$/i.test(browser.exe)
  const child = spawn(browser.exe, [browser.extensionsUrl], { detached: true, stdio: 'ignore', windowsHide: script, shell: script })
  child.on('error', () => {})
  child.unref()
}

export interface Installer {
  install(browser: DetectedBrowser): Promise<InstallOutcome>
  connected(): Promise<ConnectedOutcome>
  /** The vendored build's contract (undefined when vendor/ is missing or corrupted). */
  buildInfo(): BuildInfo | undefined
}

const HEALTH_WAIT_MS = 15_000

export function createInstaller(deps: InstallerDeps): Installer {
  const bridgeHome = bridgeHomeOf(deps.home)
  const currentDir = extensionDirOf(deps.home)
  const bundlePath = join(deps.vendorDir, VENDOR_BUNDLE)
  const doFetch = deps.fetch ?? fetch
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const importBundle = deps.importBundle ?? (p => import(pathToFileURL(p).href) as Promise<BridgeBundle>)
  let bundle: Promise<BridgeBundle> | undefined
  const loadBundle = (): Promise<BridgeBundle> => (bundle ??= importBundle(bundlePath).catch(e => { bundle = undefined; throw e }))

  const buildInfo = (): BuildInfo | undefined => {
    try {
      const info: unknown = JSON.parse(readFileSync(join(deps.vendorDir, VENDOR_BUILD_INFO), 'utf8'))
      return isBuildInfo(info) ? info : undefined
    } catch { return undefined }
  }

  const health = async (): Promise<boolean> => {
    try {
      const ctl = new AbortController()
      const t = setTimeout(() => ctl.abort(), 1500)
      const r = await doFetch(healthUrl(deps.port), { signal: ctl.signal, headers: { connection: 'close' } }).finally(() => clearTimeout(t))
      if (!r.ok) return false
      const body = (await r.json().catch(() => null)) as { ok?: unknown } | null
      return body?.ok === true
    } catch { return false }
  }

  const readKey = (): string | undefined => {
    try { return readFileSync(join(bridgeHome, 'api.key'), 'utf8').trim() || undefined } catch { return undefined }
  }

  const connected = async (): Promise<ConnectedOutcome> => {
    const key = readKey()
    if (!key) return { ok: false, reason: 'no-key' }
    try {
      const ctl = new AbortController()
      const t = setTimeout(() => ctl.abort(), 2000)
      const r = await doFetch(browsersUrl(deps.port), { signal: ctl.signal, headers: { authorization: `Bearer ${key}`, connection: 'close' } }).finally(() => clearTimeout(t))
      if (r.status === 401 || r.status === 403) return { ok: false, reason: 'refused' }
      if (!r.ok) return { ok: false, reason: 'error', message: `HTTP ${r.status}` }
      const body = (await r.json()) as { ok?: boolean; browsers?: { id?: unknown; name?: unknown }[] }
      const browsers = (body.browsers ?? []).filter(b => typeof b.id === 'string').map(b => ({ id: b.id as string, name: typeof b.name === 'string' ? b.name : '' }))
      return { ok: true, browsers }
    } catch {
      return { ok: false, reason: 'daemon-down' }
    }
  }

  /** The daemon up: already answering, or started now and answering within the wait. */
  const ensureDaemon = async (): Promise<'running' | 'started' | 'failed'> => {
    if (await health()) return 'running'
    const node = deps.nodeExe()
    if (!node) { deps.log('daemon do bridge: node não encontrado (TETHER_NODE ou PATH); não iniciado'); return 'failed' }
    const pid = (deps.spawnDaemon ?? spawnBridgeDaemon)(node, bundlePath, deps.port, bridgeHome)
    deps.log(`daemon do bridge iniciado (pid ${pid ?? '?'}, porta ${deps.port}, home ${bridgeHome})`)
    const deadline = Date.now() + HEALTH_WAIT_MS
    while (Date.now() < deadline) {
      await sleep(250)
      if (await health()) return 'started'
    }
    deps.log(`daemon do bridge: /health não respondeu em ${HEALTH_WAIT_MS} ms na porta ${deps.port}`)
    return 'failed'
  }

  const install = async (browser: DetectedBrowser): Promise<InstallOutcome> => {
    const problems = auditVendor(deps.vendorDir)
    if (problems.length) {
      deps.log(`vendor do bridge inválido: ${problems.slice(0, 3).join('; ')}${problems.length > 3 ? '…' : ''}`)
      return { ok: false, message: `A cópia do ${deps.brand.name} Bridge dentro do tether está incompleta ou alterada (${problems[0]}). Rode "node extensions/web-bridge/vendor.mjs" e tente de novo.` }
    }
    const before = await connected().then(c => (c.ok ? c.browsers.map(b => b.id) : []))
    let b: BridgeBundle
    try { b = await loadBundle() } catch (e) {
      deps.log(`bundle do bridge não carregou: ${e instanceof Error ? e.message : String(e)}`)
      return { ok: false, message: 'O bundle do bridge não carregou. Veja tether-app.log.' }
    }
    let result: ReturnType<BridgeBundle['installExtension']>
    try {
      result = b.installExtension({ home: bridgeHome, dir: currentDir, source: join(deps.vendorDir, VENDOR_EXTENSION_DIR), pin: true, port: deps.port })
      b.setBrand(bridgeHome, deps.brand)
      // The seed again, now with `host`: the extension names who it connects to before the daemon's welcome.
      const config = JSON.parse(readFileSync(join(bridgeHome, 'config.json'), 'utf8')) as { port?: number; pairingToken?: string }
      if (typeof config.pairingToken === 'string') b.writeSeed(currentDir, { port: result.port, token: config.pairingToken, host: deps.brand.name })
    } catch (e) {
      const code = (e as { code?: unknown } | undefined)?.code
      deps.log(`instalação da extensão falhou: ${typeof code === 'string' ? code : e instanceof Error ? e.message : String(e)}`)
      return { ok: false, message: `Não deu para preparar a pasta da extensão (${typeof code === 'string' ? code : 'erro'}). Veja tether-app.log.` }
    }
    deps.log(`extensão copiada para ${result.dir} (${result.files} arquivos, id ${result.extensionId}, porta ${result.port}); ids aceitos: ${result.extensionIds.length}`)
    const daemon = await ensureDaemon()
    let openError: string | undefined
    try { (deps.openBrowser ?? openBrowserAt)(browser) } catch (e) { openError = e instanceof Error ? e.message : String(e) }
    deps.log(`${browser.name} aberto em ${browser.extensionsUrl}${openError ? ` (falhou: ${openError})` : ''}`)
    return { ok: true, dir: result.dir, extensionId: result.extensionId, port: result.port, browser, daemon, before, ...(openError ? { openError } : {}) }
  }

  return { install, connected, buildInfo }
}
