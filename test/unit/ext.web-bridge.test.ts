// The web-bridge extension (F7 C1), without Electron: the vendored bridge is intact (every file matches its manifest and
// the bridge's own build-info), the browser detection by fixtures (registry text + known paths, order, dedup, the test
// override), and the install engine against the REAL vendored bundle in a temp home: the extension lands in the fixed
// folder with bridge.json seeded (port, token, host), the id is pinned and the brand written in config.json, api.key
// exists, the daemon is started only when /health is silent, the browser is opened at its extensions page, and no
// secret (pairing token, api key) appears in any log line or in the IPC reply.
// F7 C2, the daemon host (bridge-home.ts, daemon.ts): a fresh home gets the whole installation (config at the port, api.key,
// brand, pinned build id, capabilities seeded, mcp/tether-bridge.json, daemon warmed up once); a second run changes nothing;
// the installation's own choices (capabilities, an extra pinned id) are kept; a corrupted vendor writes nothing; a
// satellite process only registers the doctor checks; no secret in tetherd.log lines or in the MCP JSON.
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBridgeHost, defaultCapabilities, mcpConfigOf, seedCapabilities } from '../../extensions/web-bridge/bridge-home.ts'
import { browsersFromOverride, classifyExe, detectBrowsers, extensionsUrlOf, parseStartMenuInternet } from '../../extensions/web-bridge/browsers.ts'
import { activate as activateDaemon } from '../../extensions/web-bridge/daemon.ts'
import { createInstaller } from '../../extensions/web-bridge/installer.ts'
import { BRIDGE_PORT, bridgeHomeOf, bridgePortOf, extensionDirOf, MCP_SERVER_NAME, mcpConfigPathOf, warmupAllowed } from '../../extensions/web-bridge/paths.ts'
import { daemonEnv, findNode } from '../../extensions/web-bridge/warmup.ts'
import type { DaemonCheck, TetherDaemon } from '../../src/daemon/ext-api.ts'
import { toDisposable } from '../../app/shared/vscode-lifecycle.ts'
import { BRAND } from '../../app/shared/brand.ts'
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
    assert.deepEqual(manifest.hosts, ['renderer', 'main', 'daemon'])
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

  test('warmupAllowed: the default home may start the daemon; another home only with an explicit test port', () => {
    const local = 'C:\\Users\\x\\AppData\\Local'
    assert.equal(warmupAllowed({ LOCALAPPDATA: local }), true, 'no TETHER_HOME')
    assert.equal(warmupAllowed({ LOCALAPPDATA: local, TETHER_HOME: 'c:\\users\\x\\appdata\\local\\tether\\' }), process.platform === 'win32', 'the default path spelled differently')
    assert.equal(warmupAllowed({ LOCALAPPDATA: local, TETHER_HOME: 'C:\\tmp\\tether-test' }), false, 'a temp home without a port')
    assert.equal(warmupAllowed({ LOCALAPPDATA: local, TETHER_HOME: 'C:\\tmp\\tether-test', TETHER_BRIDGE_PORT: '50123' }), true, 'a temp home with its own port')
    assert.equal(warmupAllowed({ LOCALAPPDATA: local, TETHER_HOME: 'C:\\tmp\\tether-test', TETHER_BRIDGE_PORT: String(BRIDGE_PORT) }), false, 'the default port is never a test port')
    assert.equal(warmupAllowed({ LOCALAPPDATA: local, TETHER_HOME: 'C:\\tmp\\tether-test', TETHER_BRIDGE_PORT: 'abc' }), false, 'an invalid port is no port')
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

describe('web-bridge: daemon host (real vendored bundle, temp home)', () => {
  const buildId = (JSON.parse(readFileSync(join(vendorDir, 'build-info.json'), 'utf8')) as { extensionId: string }).extensionId
  const brand = { name: 'Tether', color: '#6aa6ff', hostId: 'studio.codr.tether' }
  type Config = { port: number; pairingToken: string; extensionIds: string[]; brand: { name: string; hostId?: string }; capabilities?: Record<string, unknown>; apiKeys: { name: string; hash: string }[] }
  const readConfig = (home: string): Config => JSON.parse(readFileSync(join(bridgeHomeOf(home), 'config.json'), 'utf8')) as Config

  /** A host over `home` with a fake daemon: /health answers once `healthy`; the spawn flips it and is recorded. */
  function hostFor(home: string, port: number, log: string[], spawns: unknown[][], state = { healthy: false }) {
    const fetchStub: typeof fetch = async (input) => new Response(state.healthy && String(input).endsWith('/health') ? JSON.stringify({ ok: true }) : '', { status: state.healthy ? 200 : 503 })
    return createBridgeHost({
      home, vendorDir, port, brand, nodeExe: () => 'C:\\fake\\node.exe', log: m => log.push(m), fetch: fetchStub,
      spawnDaemon: (...args) => { spawns.push(args); state.healthy = true; return 4343 }, sleep: async () => {},
    })
  }

  test('a fresh home: installation at the port, brand, build id pinned, capabilities seeded, MCP file, daemon started once; nothing leaks; a second start changes nothing', async () => {
    const home = tmp.make()
    const log: string[] = []
    const spawns: unknown[][] = []
    const host = hostFor(home, 48131, log, spawns)
    const r = await host.setup()
    assert.deepEqual(r, { ok: true, installed: true, capabilities: ['agentWindows', 'evaluate'], mcpWritten: true, daemon: 'started' })
    const bridgeHome = bridgeHomeOf(home)
    const config = readConfig(home)
    assert.equal(config.port, 48131)
    assert.deepEqual(config.extensionIds, [buildId])
    assert.deepEqual(config.brand, brand)
    assert.deepEqual(config.capabilities, { agentWindows: true, evaluate: 'own-tabs' })
    assert.equal(config.apiKeys[0]!.name, 'default')
    const apiKey = readFileSync(join(bridgeHome, 'api.key'), 'utf8').trim()
    assert.ok(apiKey.length >= 16)
    // The extension folder is staged with its seed (the folder §1.3 updates in place), host included.
    const seed = JSON.parse(readFileSync(join(extensionDirOf(home), 'bridge.json'), 'utf8')) as { port: number; token: string; host?: string }
    assert.deepEqual(seed, { port: 48131, token: config.pairingToken, host: 'Tether' })
    assert.ok(existsSync(join(extensionDirOf(home), 'manifest.json')))
    // The MCP file: paths and env only, exactly the design's shape.
    const mcpText = readFileSync(mcpConfigPathOf(home), 'utf8')
    assert.equal(MCP_SERVER_NAME, 'tether-bridge')
    assert.deepEqual(JSON.parse(mcpText), {
      mcpServers: { 'tether-bridge': { command: 'node', args: [join(vendorDir, 'atrium-bridge.mjs'), 'mcp'], env: { ATRIUM_BRIDGE_HOME: bridgeHome, ATRIUM_BRIDGE_PORT: '48131', ATRIUM_BRIDGE_SERVER_NAME: 'tether-bridge' } } },
    })
    assert.deepEqual(spawns, [['C:\\fake\\node.exe', join(vendorDir, 'atrium-bridge.mjs'), 48131, bridgeHome]])
    const everything = `${log.join('\n')}\n${mcpText}\n${JSON.stringify(r)}`
    assert.ok(!everything.includes(config.pairingToken), 'pairing token leaked')
    assert.ok(!everything.includes(apiKey), 'api key leaked')
    assert.ok(!everything.includes(config.apiKeys[0]!.hash.slice(7, 30)), 'key hash leaked')
    assert.ok(log.some(l => l.includes('instalação do bridge criada')) && log.some(l => l.includes('capabilities semeadas')) && log.some(l => l.includes('gravado')) && log.some(l => l.includes('daemon do bridge iniciado')), log.join('\n'))

    // The doctor checks after the setup: installation OK, daemon OK.
    const results = await Promise.all(host.checks().map(c => c()))
    assert.deepEqual(results.map(c => [c.level, c.name]), [['OK', 'Tether Bridge'], ['OK', 'daemon do bridge']])

    // A second start: nothing installed, nothing seeded, the MCP file untouched, the daemon found running; the secrets stay.
    const again = await host.setup()
    assert.deepEqual(again, { ok: true, installed: false, capabilities: [], mcpWritten: false, daemon: 'running' })
    assert.deepEqual(readConfig(home), config)
    assert.equal(readFileSync(join(bridgeHome, 'api.key'), 'utf8').trim(), apiKey)
    assert.equal(spawns.length, 1)
  })

  test('the installation decides: capabilities and an extra pinned id already there are kept; a removed folder is staged again', async () => {
    const home = tmp.make()
    assert.ok((await hostFor(home, 48132, [], []).setup()).ok)
    // The person's choices, written by hand (the bridge's own writer keeps unknown fields too).
    const path = join(bridgeHomeOf(home), 'config.json')
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    writeFileSync(path, JSON.stringify({ ...raw, capabilities: { evaluate: 'off' }, extensionIds: ['abcdefghijklmnopabcdefghijklmnop'] }, null, 2))
    const log: string[] = []
    const r = await hostFor(home, 48132, log, [], { healthy: true }).setup()
    assert.deepEqual(r, { ok: true, installed: false, capabilities: [], mcpWritten: false, daemon: 'running' })
    const config = readConfig(home)
    assert.deepEqual(config.capabilities, { evaluate: 'off' }, 'capabilities untouched')
    assert.deepEqual(config.extensionIds, ['abcdefghijklmnopabcdefghijklmnop', buildId], 'the build id is added, the other stays')
    assert.ok(!log.some(l => l.includes('capabilities')), 'nothing seeded')
    assert.equal(seedCapabilities(bridgeHomeOf(home), { x: 1 }).length, 0)
    assert.ok(!existsSync(join(bridgeHomeOf(home), 'config.lock')), 'the lock is released')
    // The folder removed by the person: the next start stages it again, config kept (same pairing token).
    const token = config.pairingToken
    rmSync(extensionDirOf(home), { recursive: true, force: true })
    const r2 = await hostFor(home, 48132, [], [], { healthy: true }).setup()
    assert.equal(r2.installed, true)
    assert.equal(readConfig(home).pairingToken, token)
    assert.equal((JSON.parse(readFileSync(join(extensionDirOf(home), 'bridge.json'), 'utf8')) as { token: string }).token, token)
  })

  test('defaultCapabilities: the package defaults when the build carries them, else the settings defaults', () => {
    const base = { name: 'tether-bridge', version: '0.1.0', extensionId: buildId, bundle: { file: 'a', sha256: 'b', bytes: 1 }, extension: { dir: 'extension', sha256: 'c', files: 1 } }
    assert.deepEqual(defaultCapabilities(base), { agentWindows: true, evaluate: 'own-tabs' })
    assert.deepEqual(defaultCapabilities({ ...base, brand: { slug: 't', name: 'T', capabilities: { evaluate: 'all', pdf: false } } }), { evaluate: 'all', pdf: false })
    assert.deepEqual(defaultCapabilities(undefined), { agentWindows: true, evaluate: 'own-tabs' })
    assert.equal(mcpConfigOf('H', 'B', 1).mcpServers['tether-bridge']!.env.ATRIUM_BRIDGE_PORT, '1')
  })

  test('warm: false writes everything and starts nothing (a second home without its own port)', async () => {
    const home = tmp.make()
    const log: string[] = []
    const spawns: unknown[][] = []
    const host = createBridgeHost({ home, vendorDir, port: 48134, brand, nodeExe: () => 'C:\\fake\\node.exe', log: m => log.push(m), warm: false, fetch: async () => new Response('', { status: 503 }), spawnDaemon: (...a) => { spawns.push(a); return 1 }, sleep: async () => {} })
    const r = await host.setup()
    assert.deepEqual(r, { ok: true, installed: true, capabilities: ['agentWindows', 'evaluate'], mcpWritten: true, daemon: 'skipped' })
    assert.deepEqual(spawns, [])
    assert.ok(existsSync(join(bridgeHomeOf(home), 'api.key')) && existsSync(mcpConfigPathOf(home)))
    assert.ok(log.some(l => l.includes('aquecimento do daemon pulado')), log.join('\n'))
  })

  test('a corrupted vendor copy writes nothing and says so', async () => {
    const home = tmp.make()
    const copy = join(tmp.make(), 'vendor')
    cpSync(vendorDir, copy, { recursive: true })
    writeFileSync(join(copy, 'atrium-bridge.mjs'), '// not the bundle')
    const log: string[] = []
    const host = createBridgeHost({ home, vendorDir: copy, port: 48133, brand, nodeExe: () => undefined, log: m => log.push(m), fetch: async () => new Response('', { status: 503 }), spawnDaemon: () => undefined, sleep: async () => {} })
    const r = await host.setup()
    assert.equal(r.ok, false)
    assert.match(r.problem ?? '', /vendor do bridge inválido/)
    assert.ok(!existsSync(bridgeHomeOf(home)) && !existsSync(mcpConfigPathOf(home)))
    const [install, daemon] = await Promise.all(host.checks().map(c => c()))
    assert.equal(install!.level, 'ERRO')
    assert.equal(daemon!.level, 'AVISO')
  })

  test('activate(): registers the two doctor checks and waits for onStarted; nothing is written before (a satellite never starts); an empty home reads as AVISO', async () => {
    const home = tmp.make()
    const checks: Array<() => Promise<DaemonCheck>> = []
    const started: Array<() => void> = []
    const log: string[] = []
    const api: TetherDaemon = {
      id: 'web-bridge', brand: BRAND, home,
      agents: { register: () => toDisposable(() => {}), get: () => undefined },
      launch: { use: () => toDisposable(() => {}) },
      doctor: { register: c => { checks.push(c); return toDisposable(() => {}) } },
      onStarted: l => { started.push(l); return toDisposable(() => {}) },
      settings: { get: () => undefined },
      log: m => log.push(m),
      onSlot: () => toDisposable(() => {}),
    }
    const disposables = activateDaemon(api)
    assert.equal(disposables.length, 5, 'onStarted + launch middleware + slot listener (C3) + 2 checks')
    assert.equal(checks.length, 2)
    assert.equal(started.length, 1, 'the setup waits for the start')
    await new Promise(r => setTimeout(r, 50))
    assert.ok(!existsSync(bridgeHomeOf(home)) && !existsSync(mcpConfigPathOf(home)), 'nothing written before the start')
    assert.deepEqual(log, [])
    const install = await checks[0]!()
    assert.equal(install.level, 'AVISO')
    assert.match(install.detail, /sem config\.json e api\.key/)
    mkdirSync(join(home, 'mcp'), { recursive: true })
    assert.equal((await checks[0]!()).level, 'AVISO')
  })
})
