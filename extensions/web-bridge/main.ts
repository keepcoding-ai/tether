// The web-bridge extension's Electron-main side: the browsers on this machine, the install (installer.ts), the "who is
// connected" poll of the guide and, for the status icon (C4, status-poll.ts), the /status poll with the popover's
// actions. Main is the only side that touches the bridge home (config, api.key) and the file system; the renderer gets
// paths, names, counts and the sanitized snapshot, on the bus `ext:web-bridge:*`.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { TetherMain } from '../../app/main/ext-api.ts'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import { toDisposable } from '../../app/shared/vscode-lifecycle.ts'
import { readBuildInfo } from './bridge-home.ts'
import { browsersFromOverride, detectBrowsers, optionsUrl, type DetectedBrowser } from './browsers.ts'
import { createInstaller } from './installer.ts'
import type { WebBridgeChannels } from './ipc.ts'
import { bridgeHomeOf, bridgePortOf, extensionDirOf } from './paths.ts'
import { createStatusPoller } from './status-poll.ts'
import { bundleSha256Of, readDaemonRecord } from './warmup.ts'
import type { StatusSnapshot } from './status.ts'
import { extensionVersionOf, readUpdateMarker, settleUpdateMarker } from './update.ts'
import { findNode } from './find-node-sync.ts'

export { manifest } from './manifest.ts'

const isFile = (p: string): boolean => { try { return statSync(p).isFile() } catch { return false } }

/** `reg query` of the StartMenuInternet clients (HKLM and HKCU), or '' off Windows or when reg fails. */
function registryText(): string {
  if (process.platform !== 'win32') return ''
  let out = ''
  for (const hive of ['HKLM', 'HKCU']) {
    try { out += execFileSync('reg', ['query', `${hive}\\SOFTWARE\\Clients\\StartMenuInternet`, '/s'], { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }) + '\n' } catch { /* hive absent */ }
  }
  return out
}

export function listBrowsers(env: NodeJS.ProcessEnv = process.env): DetectedBrowser[] {
  const override = env.TETHER_WEB_BRIDGE_BROWSERS
  if (override && existsSync(override)) {
    const list = browsersFromOverride(readFileSync(override, 'utf8'), isFile)
    if (list) return list
  }
  return detectBrowsers({ platform: process.platform, env, exists: isFile, registryText: registryText() })
}

/** The browser "Opções da extensão" opens in: the one connected (by name), else the first detected. */
export function optionsBrowser(detected: DetectedBrowser[], connected: StatusSnapshot['browsers']): DetectedBrowser | undefined {
  if (!detected.length) return undefined
  for (const c of connected) {
    const hit = detected.find(d => d.name.toLowerCase().includes(c.name.toLowerCase()))
    if (hit) return hit
  }
  return detected[0]
}

export function activate(main: TetherMain): IDisposable[] {
  const ipc = main.ipc<WebBridgeChannels>()
  // The app runs from this repository (no asar): app/dist/../../extensions/web-bridge/vendor.
  const vendorDir = resolve(main.dist, '..', '..', 'extensions', 'web-bridge', 'vendor')
  const port = bridgePortOf()
  const currentDir = extensionDirOf(main.home)
  const installer = createInstaller({
    home: main.home,
    vendorDir,
    port,
    brand: { name: main.brand.name, color: main.brand.accent, hostId: main.brand.appId },
    nodeExe: () => findNode(),
    log: msg => main.log(msg),
  })
  let browsers: DetectedBrowser[] | undefined
  const detected = (): DetectedBrowser[] => browsers ?? (browsers = listBrowsers())

  // C4: the poll. The versions are the EXTENSION's (the manifest version, `<bridge>.<commits>` since bridge 782d3ea55, the
  // one chrome.runtime.getManifest().version reports): the vendored folder's (what the tether carries; the bridge version
  // of build-info as a fallback for a build without the stamp), the installed folder's, and C5's marker (the files under a
  // loaded extension changed).
  // The vendored build's contract, as of the last poll (the options below need it synchronously).
  let buildInfo: Awaited<ReturnType<typeof readBuildInfo>>
  const version = async (browsers: StatusSnapshot['browsers']): Promise<StatusSnapshot['version']> => {
    buildInfo = await readBuildInfo(vendorDir)
    const vendored = await extensionVersionOf(join(vendorDir, 'extension')) ?? buildInfo?.version
    const installed = await extensionVersionOf(currentDir)
    // A browser already on the vendored version has reloaded: the marker would otherwise outlive the reload.
    await settleUpdateMarker(main.home, browsers, vendored).catch(() => false)
    return { ...(vendored ? { vendored } : {}), ...(installed ? { installed } : {}), pendingReload: !!await readUpdateMarker(main.home) }
  }
  const poller = createStatusPoller({
    port,
    bridgeHome: bridgeHomeOf(main.home),
    version,
    daemonBuildStale: async () => {
      const [record, vendored] = await Promise.all([readDaemonRecord(bridgeHomeOf(main.home)), bundleSha256Of(join(vendorDir, 'atrium-bridge.mjs'))])
      return !!record && !!vendored && record.bundleSha256 !== vendored
    },
    options: () => {
      // Detected once the daemon is up (reg query costs ~100 ms; the list is cached for the session).
      if (!buildInfo) return undefined
      const b = optionsBrowser(detected(), poller.current().browsers)
      return b ? { browserId: b.id, browserName: b.name } : undefined
    },
    onChange: snapshot => ipc.send('status', snapshot),
    log: msg => main.log(`status: ${msg}`),
  })
  poller.start()

  const openOptions = async (browserName?: string): Promise<{ ok: true } | { ok: false; message: string }> => {
    const info = await readBuildInfo(vendorDir)
    if (!info) return { ok: false, message: 'A cópia vendorizada do bridge está sem build-info.' }
    const target = poller.current().options
    const named = typeof browserName === 'string' && browserName ? optionsBrowser(detected(), [{ id: '', name: browserName, tabs: 0 }]) : undefined
    const browser = named ?? (target ? detected().find(b => b.id === target.browserId) : undefined)
    if (!browser) return { ok: false, message: 'Nenhum navegador compatível encontrado neste computador.' }
    try {
      const script = /\.(cmd|bat)$/i.test(browser.exe)
      const child = spawn(browser.exe, [optionsUrl(info.extensionId)], { detached: true, stdio: 'ignore', windowsHide: script, shell: script })
      child.on('error', () => {})
      child.unref()
      main.log(`opções da extensão abertas no ${browser.name}`)
      return { ok: true }
    } catch (e) { return { ok: false, message: e instanceof Error ? e.message : String(e) } }
  }

  return [
    ipc.handle('browsers', () => Promise.resolve(detected())),
    ipc.handle('install', browserId => {
      const browser = detected().find(b => b.id === browserId)
      if (!browser) return Promise.resolve({ ok: false as const, message: 'Esse navegador não está mais na lista.' })
      return installer.install(browser).then(r => { void poller.refresh(); return r })
    }),
    ipc.handle('connected', () => installer.connected()),
    ipc.handle('status', () => Promise.resolve(poller.current())),
    ipc.handle('pause', on => poller.pause(on === true)),
    ipc.handle('releaseAll', () => poller.releaseAll()),
    ipc.handle('openOptions', name => openOptions(name)),
    ipc.handle('activate', id => typeof id === 'string' ? poller.activate(id) : Promise.resolve({ ok: false as const, message: 'Navegador inválido.' })),
    ipc.handle('focusTab', (id, tabId) => typeof id === 'string' && Number.isInteger(tabId) ? poller.focusTab(id, tabId) : Promise.resolve({ ok: false as const, message: 'Aba inválida.' })),
    ipc.on('watch', open => poller.watch(open === true)),
    toDisposable(() => poller.stop()),
  ]
}
