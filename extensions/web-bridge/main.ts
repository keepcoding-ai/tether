// The web-bridge extension's Electron-main side: the browsers on this machine, the install (installer.ts) and the
// "who is connected" poll, on the bus `ext:web-bridge:*`. Main is the only side that touches the bridge home (config,
// api.key) and the file system; the renderer gets paths, names and counts.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import type { TetherMain } from '../../app/main/ext-api.ts'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import { browsersFromOverride, detectBrowsers, type DetectedBrowser } from './browsers.ts'
import { createInstaller, findNode } from './installer.ts'
import type { WebBridgeChannels } from './ipc.ts'
import { bridgePortOf } from './paths.ts'

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

export function activate(main: TetherMain): IDisposable[] {
  const ipc = main.ipc<WebBridgeChannels>()
  // The app runs from this repository (no asar): app/dist/../../extensions/web-bridge/vendor.
  const vendorDir = resolve(main.dist, '..', '..', 'extensions', 'web-bridge', 'vendor')
  const installer = createInstaller({
    home: main.home,
    vendorDir,
    port: bridgePortOf(),
    brand: { name: main.brand.name, color: main.brand.accent, hostId: main.brand.appId },
    nodeExe: () => findNode(),
    log: msg => main.log(msg),
  })
  let browsers: DetectedBrowser[] | undefined
  return [
    ipc.handle('browsers', () => Promise.resolve((browsers = listBrowsers()))),
    ipc.handle('install', browserId => {
      const browser = (browsers ?? (browsers = listBrowsers())).find(b => b.id === browserId)
      if (!browser) return Promise.resolve({ ok: false as const, message: 'Esse navegador não está mais na lista.' })
      return installer.install(browser)
    }),
    ipc.handle('connected', () => installer.connected()),
  ]
}
