// The install flow's engine (design §1.2), Electron-free so the unit test runs it with a fake browser and a temp home:
//   1. the vendored copy is checked against its manifest (a corrupted vendor/ never reaches the browser);
//   2. the bridge bundle's `installExtension` copies vendor/extension into the fixed `current` folder, seeds `bridge.json`
//      (port + pairing token) and pins the extension id in the bridge home's config.json; the brand goes in the config
//      and the seed is rewritten with `host` so the extension can say who it is connecting to;
//   3. the daemon is warmed up (warmup.ts, the same code the daemon host runs at every tetherd start, C2). Here it is
//      the fallback: the guide needs the daemon now so "waiting" can end, and the running tetherd may predate C2 or the
//      daemon may have died since. /health answers → nothing is spawned;
//   4. the browser opens at its extensions page, detached.
// Secrets: the pairing token and the api.key are read from files here and handed only to the bridge's functions or to
// the HTTP bearer header; they never go in a log line, an error message or an IPC reply.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { brandAndSeed, importBundleFromDisk, readBuildInfo, type BridgeBrand, type BridgeBundle, type ImportBundle } from './bridge-home.ts'
import type { DetectedBrowser } from './browsers.ts'
import type { ConnectedOutcome, InstallOutcome } from './ipc.ts'
import { bridgeHomeOf, browsersUrl, extensionDirOf } from './paths.ts'
import { clearUpdateMarker, extensionVersionOf, syncExtensionVersion } from './update.ts'
import { auditVendor, VENDOR_BUNDLE, VENDOR_EXTENSION_DIR, type BuildInfo } from './vendor-rules.ts'
import { createWarmup, type WarmupDeps } from './warmup.ts'

export type { BridgeBundle } from './bridge-home.ts'
export { daemonEnv, findNode, spawnBridgeDaemon } from './warmup.ts'

export interface InstallerDeps {
  /** TETHER_HOME. */
  home: string
  /** extensions/web-bridge/vendor. */
  vendorDir: string
  port: number
  brand: BridgeBrand
  /** The node that runs the daemon (Electron's own binary cannot: the bundle is a Node program). */
  nodeExe(): string | undefined
  log(msg: string): void
  /** Injected in the unit test: the bundle import, the HTTP fetch, the spawns. */
  importBundle?: ImportBundle
  fetch?: WarmupDeps['fetch']
  spawnDaemon?: WarmupDeps['spawnDaemon']
  openBrowser?(browser: DetectedBrowser): void
  sleep?: WarmupDeps['sleep']
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

export function createInstaller(deps: InstallerDeps): Installer {
  const bridgeHome = bridgeHomeOf(deps.home)
  const currentDir = extensionDirOf(deps.home)
  const bundlePath = join(deps.vendorDir, VENDOR_BUNDLE)
  const doFetch = deps.fetch ?? fetch
  const importBundle = deps.importBundle ?? importBundleFromDisk
  let bundle: Promise<BridgeBundle> | undefined
  const loadBundle = (): Promise<BridgeBundle> => (bundle ??= importBundle(bundlePath).catch(e => { bundle = undefined; throw e }))
  const warmup = createWarmup({ port: deps.port, bundlePath, bridgeHome, nodeExe: deps.nodeExe, log: deps.log, fetch: deps.fetch, spawnDaemon: deps.spawnDaemon, sleep: deps.sleep })

  const buildInfo = (): BuildInfo | undefined => readBuildInfo(deps.vendorDir)

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

  const install = async (browser: DetectedBrowser): Promise<InstallOutcome> => {
    const problems = await auditVendor(deps.vendorDir)
    if (problems.length) {
      deps.log(`vendor do bridge inválido: ${problems.slice(0, 3).join('; ')}${problems.length > 3 ? '…' : ''}`)
      return { ok: false, message: `A cópia do ${deps.brand.name} Bridge dentro do Tether está incompleta ou alterada (${problems[0]}). Rode "npm run bridge:build" e tente de novo.` }
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
      // The brand, and the seed again with `host`: the extension names who it connects to before the daemon's welcome.
      brandAndSeed(b, bridgeHome, currentDir, result.port, deps.brand)
      // C5: the folder is the vendored build now, and the daemon will say so in its welcome; a pending "reload" notice is
      // over (the person is at the browser's extensions page with this folder).
      const version = extensionVersionOf(currentDir)
      if (version) syncExtensionVersion(b, bridgeHome, version)
      await clearUpdateMarker(deps.home)
    } catch (e) {
      const code = (e as { code?: unknown } | undefined)?.code
      deps.log(`instalação da extensão falhou: ${typeof code === 'string' ? code : e instanceof Error ? e.message : String(e)}`)
      return { ok: false, message: `Não deu para preparar a pasta da extensão (${typeof code === 'string' ? code : 'erro'}). Veja tether-app.log.` }
    }
    deps.log(`extensão copiada para ${result.dir} (${result.files} arquivos, id ${result.extensionId}, porta ${result.port}); ids aceitos: ${result.extensionIds.length}`)
    const daemon = await warmup.ensure()
    let openError: string | undefined
    try { (deps.openBrowser ?? openBrowserAt)(browser) } catch (e) { openError = e instanceof Error ? e.message : String(e) }
    deps.log(`${browser.name} aberto em ${browser.extensionsUrl}${openError ? ` (falhou: ${openError})` : ''}`)
    return { ok: true, dir: result.dir, extensionId: result.extensionId, port: result.port, browser, daemon, before, ...(openError ? { openError } : {}) }
  }

  return { install, connected, buildInfo }
}
