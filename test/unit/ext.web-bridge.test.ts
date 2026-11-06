// The web-bridge extension (F7 C1), without Electron: the vendored bridge is intact (every file matches its manifest and
// the bridge's own build-info), the browser detection by fixtures (registry text + known paths, order, dedup, the test
// override), and the install engine against the REAL vendored bundle in a temp home: the extension lands in the fixed
// folder with bridge.json seeded (port, token, host), the id is pinned and the brand written in config.json, api.key
// exists, the daemon is started only when /health is silent, the browser is opened at its extensions page, and no
// secret (pairing token, api key) appears in any log line or in the IPC reply.
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { browsersFromOverride, classifyExe, detectBrowsers, extensionsUrlOf, parseStartMenuInternet } from '../../extensions/web-bridge/browsers.ts'
import { createInstaller, daemonEnv, findNode } from '../../extensions/web-bridge/installer.ts'
import { BRIDGE_PORT, bridgeHomeOf, bridgePortOf, extensionDirOf } from '../../extensions/web-bridge/paths.ts'
import { auditVendor, VENDOR_MANIFEST } from '../../extensions/web-bridge/vendor-rules.ts'
import { manifest } from '../../extensions/web-bridge/manifest.ts'
import { tempDirs } from './tmp.helpers.ts'

const root = fileURLToPath(new URL('../../', import.meta.url))
const vendorDir = join(root, 'extensions', 'web-bridge', 'vendor')
const tmp = tempDirs('tether-web-bridge-')
after(() => tmp.cleanup())

const REG = `
HKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet

HKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet\\Google Chrome
    (Padrão)    REG_SZ    Google Chrome
    LocalizedString    REG_SZ    @C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe,-1

HKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet\\Google Chrome\\shell\\open\\command
    (Padrão)    REG_SZ    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"

HKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet\\Firefox-308046B0AF4A39CB\\shell\\open\\command
    (Default)    REG_SZ    "C:\\Program Files\\Mozilla Firefox\\firefox.exe"

HKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet\\Microsoft Edge\\shell\\open\\command
    (Default)    REG_SZ    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" --profile-directory=Default

HKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet\\Brave\\shell\\open\\command
    (Default)    REG_EXPAND_SZ    C:\\Users\\x\\AppData\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe
`

describe('web-bridge: vendored bridge', () => {
  test('vendor/ is intact: every file matches manifest.json, the extension tree matches build-info', () => {
    assert.deepEqual(auditVendor(vendorDir), [])
    const m = JSON.parse(readFileSync(join(vendorDir, VENDOR_MANIFEST), 'utf8')) as { extensionId: string; files: Record<string, string> }
    assert.match(m.extensionId, /^[a-p]{32}$/)
    assert.ok(Object.keys(m.files).length >= 10, 'bundle, build-info and the extension files')
    assert.ok('atrium-bridge.mjs' in m.files && 'extension/manifest.json' in m.files)
    assert.ok(!(VENDOR_MANIFEST in m.files), 'the manifest does not list itself')
  })

  test('a changed or missing file is caught', () => {
    const copy = join(tmp.make(), 'vendor')
    cpSync(vendorDir, copy, { recursive: true })
    writeFileSync(join(copy, 'extension', 'popup.html'), '<!-- tampered -->')
    const problems = auditVendor(copy)
    assert.ok(problems.some(p => p.startsWith('extension/popup.html: sha256')), problems.join('; '))
    assert.ok(problems.some(p => p.startsWith('extension/: hash')), problems.join('; '))
    writeFileSync(join(copy, 'extra.txt'), 'x')
    assert.ok(auditVendor(copy).some(p => p === 'extra.txt: fora do manifesto'))
  })

  test('the manifest declares the settings, the command and the menu item of the design', () => {
    assert.equal(manifest.id, 'web-bridge')
    assert.equal(manifest.displayName, 'Tether Bridge')
    assert.deepEqual(Object.keys(manifest.contributes!.settings!), ['serveToAgents', 'agentWindows', 'evaluate'])
    assert.equal(manifest.contributes!.settings!.evaluate!.default, 'own-tabs')
    assert.equal(manifest.contributes!.commands![0]!.command, 'web-bridge.install')
    assert.equal(manifest.contributes!.menus!.app![0]!.group, 'app')
  })
})

describe('web-bridge: browsers', () => {
  test('parseStartMenuInternet reads every shell\\open\\command, unquoted, without the arguments', () => {
    assert.deepEqual(parseStartMenuInternet(REG), [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Users\\x\\AppData\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    ])
    assert.deepEqual(parseStartMenuInternet(''), [])
  })

  test('classifyExe by base name; Firefox is nobody', () => {
    assert.equal(classifyExe('C:\\x\\chrome.exe'), 'chrome')
    assert.equal(classifyExe('C:\\x\\MSEDGE.EXE'), 'edge')
    assert.equal(classifyExe('/usr/bin/brave-browser'), 'brave')
    assert.equal(classifyExe('C:\\x\\firefox.exe'), undefined)
    assert.equal(extensionsUrlOf('edge'), 'edge://extensions')
  })

  test('detectBrowsers: the registry path wins, known paths fill in, order is Chrome, Edge, Brave, nothing missing is offered', () => {
    const env = { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }
    const present = new Set([
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    ])
    const found = detectBrowsers({ platform: 'win32', env, exists: p => present.has(p), registryText: REG })
    assert.deepEqual(found.map(b => [b.id, b.exe, b.extensionsUrl]), [
      ['chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'chrome://extensions'],
      ['edge', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'edge://extensions'],
    ])
    // No registry: the known paths, in the picker's order whatever the install location.
    present.add('C:\\Users\\x\\AppData\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe')
    const byPath = detectBrowsers({ platform: 'win32', env, exists: p => present.has(p) })
    assert.deepEqual(byPath.map(b => b.id), ['chrome', 'edge', 'brave'])
    assert.equal(byPath[2]!.name, 'Brave')
    assert.deepEqual(detectBrowsers({ platform: 'win32', env, exists: () => false, registryText: REG }), [])
  })

  test('the test override lists only known ids whose exe exists', () => {
    const json = JSON.stringify([{ id: 'chrome', name: 'Chrome falso', exe: 'C:\\fake\\chrome.cmd' }, { id: 'opera', exe: 'C:\\fake\\opera.exe' }, { id: 'edge', exe: 'C:\\missing.exe' }])
    const list = browsersFromOverride(json, p => p === 'C:\\fake\\chrome.cmd')
    assert.deepEqual(list, [{ id: 'chrome', name: 'Chrome falso', exe: 'C:\\fake\\chrome.cmd', extensionsUrl: 'chrome://extensions' }])
    assert.equal(browsersFromOverride('not json', () => true), undefined)
  })

  test('paths: fixed port 47831 unless TETHER_BRIDGE_PORT; home-relative folders', () => {
    assert.equal(BRIDGE_PORT, 47831)
    assert.equal(bridgePortOf({}), 47831)
    assert.equal(bridgePortOf({ TETHER_BRIDGE_PORT: '48000' }), 48000)
    assert.equal(bridgePortOf({ TETHER_BRIDGE_PORT: 'abc' }), 47831)
    assert.equal(bridgeHomeOf('C:\\h'), join('C:\\h', 'bridge'))
    assert.equal(extensionDirOf('C:\\h'), join('C:\\h', 'web-bridge', 'current'))
    assert.equal(findNode({ TETHER_NODE: 'C:\\n\\node.exe' }, p => p === 'C:\\n\\node.exe'), 'C:\\n\\node.exe')
    const env = daemonEnv('C:\\h\\bridge', { PATH: 'x', SECRET_THING: 'y', ATRIUM_BRIDGE_KEY: 'z' })
    assert.deepEqual(env, { PATH: 'x', ATRIUM_BRIDGE_HOME: 'C:\\h\\bridge' })
  })
})

describe('web-bridge: install engine (real vendored bundle, temp home)', () => {
  const browser = { id: 'chrome' as const, name: 'Google Chrome', exe: 'C:\\fake\\chrome.exe', extensionsUrl: 'chrome://extensions' }

  test('copies, seeds bridge.json with host, pins the id, writes the brand; starts the daemon once; opens the browser; leaks no secret', async () => {
    const home = tmp.make()
    const log: string[] = []
    const spawns: unknown[][] = []
    const opened: string[] = []
    let healthy = false
    const fetchStub: typeof fetch = async (input) => {
      const url = String(input)
      if (url.endsWith('/health')) return new Response(healthy ? JSON.stringify({ ok: true }) : '', { status: healthy ? 200 : 503 })
      if (url.endsWith('/browsers')) return new Response(JSON.stringify({ ok: true, browsers: healthy ? [{ id: 'b1', name: 'Chrome' }] : [] }), { status: 200 })
      return new Response('', { status: 404 })
    }
    const installer = createInstaller({
      home, vendorDir, port: 48123, brand: { name: 'Tether', color: '#6aa6ff', hostId: 'studio.codr.tether' },
      nodeExe: () => 'C:\\fake\\node.exe', log: m => log.push(m), fetch: fetchStub,
      spawnDaemon: (...args) => { spawns.push(args); healthy = true; return 4242 },
      openBrowser: b => opened.push(`${b.exe} ${b.extensionsUrl}`),
      sleep: async () => {},
    })
    assert.ok(installer.buildInfo(), 'build-info readable')
    const r = await installer.install(browser)
    assert.ok(r.ok, JSON.stringify(r))
    const current = extensionDirOf(home)
    const bridgeHome = bridgeHomeOf(home)
    assert.equal(r.dir, current)
    assert.equal(r.port, 48123)
    assert.equal(r.daemon, 'started')
    assert.deepEqual(r.before, [], 'nothing was connected before (the daemon was down)')
    assert.deepEqual(spawns, [['C:\\fake\\node.exe', join(vendorDir, 'atrium-bridge.mjs'), 48123, bridgeHome]])
    assert.deepEqual(opened, ['C:\\fake\\chrome.exe chrome://extensions'])

    // The folder: the extension files plus the seed.
    assert.ok(existsSync(join(current, 'manifest.json')) && existsSync(join(current, 'dist', 'background.js')))
    const seed = JSON.parse(readFileSync(join(current, 'bridge.json'), 'utf8')) as { port: number; token: string; host?: string }
    assert.equal(seed.port, 48123)
    assert.ok(seed.token.length >= 16)
    assert.equal(seed.host, 'Tether')
    // The bridge home: config with the pinned id and the brand; api.key present; token is the seed's.
    const config = JSON.parse(readFileSync(join(bridgeHome, 'config.json'), 'utf8')) as { port: number; pairingToken: string; extensionIds: string[]; brand: { name: string; hostId?: string } }
    assert.equal(config.port, 48123)
    assert.equal(config.pairingToken, seed.token)
    assert.deepEqual(config.extensionIds, [r.extensionId])
    assert.equal(config.brand.name, 'Tether')
    assert.equal(config.brand.hostId, 'studio.codr.tether')
    const apiKey = readFileSync(join(bridgeHome, 'api.key'), 'utf8').trim()
    assert.ok(apiKey.length >= 16)
    // No secret anywhere the renderer or a log reader could see it.
    const everything = `${log.join('\n')}\n${JSON.stringify(r)}`
    assert.ok(!everything.includes(seed.token), 'pairing token leaked')
    assert.ok(!everything.includes(apiKey), 'api key leaked')
    assert.ok(log.some(l => l.includes('extensão copiada')) && log.some(l => l.includes('daemon do bridge iniciado')), log.join('\n'))

    // Who is connected: read with the api.key, names and ids only.
    assert.deepEqual(await installer.connected(), { ok: true, browsers: [{ id: 'b1', name: 'Chrome' }] })

    // A second install over the same folder: the daemon is up, nothing is spawned again, `before` carries the connected one.
    const again = await installer.install(browser)
    assert.ok(again.ok)
    assert.equal(again.daemon, 'running')
    assert.deepEqual(again.before, ['b1'])
    assert.equal(spawns.length, 1)
  })

  test('a corrupted vendor copy is refused before anything is written', async () => {
    const home = tmp.make()
    const copy = join(tmp.make(), 'vendor')
    cpSync(vendorDir, copy, { recursive: true })
    writeFileSync(join(copy, 'atrium-bridge.mjs'), '// not the bundle')
    const installer = createInstaller({ home, vendorDir: copy, port: 48124, brand: { name: 'Tether' }, nodeExe: () => undefined, log: () => {}, fetch: async () => new Response('', { status: 503 }), spawnDaemon: () => undefined, openBrowser: () => {} })
    const r = await installer.install(browser)
    assert.equal(r.ok, false)
    assert.ok(!existsSync(extensionDirOf(home)))
    assert.ok(!existsSync(bridgeHomeOf(home)))
  })

  test('connected() without an api.key or a daemon says why', async () => {
    const home = tmp.make()
    const installer = createInstaller({ home, vendorDir, port: 48125, brand: { name: 'Tether' }, nodeExe: () => undefined, log: () => {}, fetch: async () => { throw new Error('ECONNREFUSED') } })
    assert.deepEqual(await installer.connected(), { ok: false, reason: 'no-key' })
  })
})
