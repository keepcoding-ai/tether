// The web-bridge extension (F7 C1), without Electron: the vendored bridge is intact (every file matches its manifest and
// the bridge's own build-info), the browser detection by fixtures (registry text + known paths, order, dedup, the test
// override), and the install engine against the REAL vendored bundle in a temp home: the extension lands in the fixed
// folder with bridge.json seeded (port, token, host), the id is pinned and the brand written in config.json, api.key
// exists, the daemon is started only when /health is silent, the browser is opened at its extensions page, and no
// secret (pairing token, api key) appears in any log line or in the IPC reply.
// F7 C2, the daemon host (bridge-home.ts, daemon.ts): a fresh home gets the installation's files (config at the port via the
// bundle's ensureConfig, api.key, brand, pinned build id, the package's capabilities seeded, mcp/tether-bridge.json with the
// package's server name, daemon warmed up once) and NO extension folder (that is the install flow's); a second run changes
// nothing; the installation's own choices (capabilities, port, an extra pinned id) are kept; a corrupted vendor writes
// nothing; a satellite process only registers the doctor checks; no secret in tetherd.log lines or in the MCP JSON.
// F7 C5 (update.ts): an installed folder older than the vendored build is brought to it file by file (seed kept, the
// marker and the doctor's "recarregar" notice, extensionVersion in config.json), and a daemon running another bundle is
// restarted only after pid + command line + port owner are proven.
import { after, describe, test } from 'node:test'
import { randomBytes } from 'node:crypto'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBridgeHost, defaultCapabilities, importBundleFromDisk, mcpConfigOf, serverNameOf } from '../../extensions/web-bridge/bridge-home.ts'
import { browsersFromOverride, classifyExe, detectBrowsers, extensionsUrlOf, parseStartMenuInternet } from '../../extensions/web-bridge/browsers.ts'
import { activate as activateDaemon } from '../../extensions/web-bridge/daemon.ts'
import { createInstaller } from '../../extensions/web-bridge/installer.ts'
import { BRIDGE_PORT, bridgeHomeOf, bridgePortOf, extensionDirOf, MCP_SERVER_NAME, mcpConfigPathOf, warmupAllowed } from '../../extensions/web-bridge/paths.ts'
import { daemonEnv, findNode, findNodeAsync, readDaemonRecord, writeDaemonRecord, type Warmup } from '../../extensions/web-bridge/warmup.ts'
import { extensionOutdated, extensionVersionOf, readUpdateMarker, restartIfOutdated, storedExtensionVersion, syncExtensionVersion, updateExtensionDir, updateMarkerPath } from '../../extensions/web-bridge/update.ts'
import type { DaemonCheck, TetherDaemon } from '../../src/daemon/ext-api.ts'
import { fsIo } from '../../src/daemon/ext-io.ts'
import { DisposableStore, toDisposable } from '../../app/shared/vscode-lifecycle.ts'
import { DoorHost } from '../../src/daemon/door/host.ts'
import { BRAND } from '../../app/shared/brand.ts'
import { auditVendor, hashTree, sha256, VENDOR_MANIFEST, type BuildInfo } from '../../extensions/web-bridge/vendor-rules.ts'
import { hashTree as hashTreeSync, manifestOf } from '../../extensions/web-bridge/vendor-rules-sync.ts'
import { manifest } from '../../extensions/web-bridge/manifest.ts'
import { tempDirs } from './tmp.helpers.ts'

const root = fileURLToPath(new URL('../../', import.meta.url))
const vendorDir = join(root, 'extensions', 'web-bridge', 'vendor')
/** The vendored extension's manifest version (`<bridge>.<commits>`, stamped by the bridge's build): what the welcome carries. */
const VENDORED_VERSION = (await extensionVersionOf(join(vendorDir, 'extension')))!
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
  test('vendor/ is intact: every file matches manifest.json, the extension tree matches build-info', async () => {
    assert.deepEqual(await auditVendor(vendorDir), [])
    const m = JSON.parse(readFileSync(join(vendorDir, VENDOR_MANIFEST), 'utf8')) as { extensionId: string; files: Record<string, string> }
    assert.match(m.extensionId, /^[a-p]{32}$/)
    assert.ok(Object.keys(m.files).length >= 10, 'bundle, build-info and the extension files')
    assert.ok('atrium-bridge.mjs' in m.files && 'extension/manifest.json' in m.files)
    assert.ok(!(VENDOR_MANIFEST in m.files), 'the manifest does not list itself')
  })

  test('a changed or missing file is caught', async () => {
    const copy = join(tmp.make(), 'vendor')
    cpSync(vendorDir, copy, { recursive: true })
    writeFileSync(join(copy, 'extension', 'popup.html'), '<!-- tampered -->')
    const problems = await auditVendor(copy)
    assert.ok(problems.some(p => p.startsWith('extension/popup.html: sha256')), problems.join('; '))
    assert.ok(problems.some(p => p.startsWith('extension/: hash')), problems.join('; '))
    writeFileSync(join(copy, 'extra.txt'), 'x')
    assert.ok((await auditVendor(copy)).some(p => p === 'extra.txt: fora do manifesto'))
  })

  test('the audit keeps the event loop answering on a large tree and fails closed on a tampered byte; the sync twin agrees', async () => {
    const dir = join(tmp.make(), 'vendor')
    const ext = join(dir, 'extension')
    mkdirSync(ext, { recursive: true })
    for (let i = 0; i < 8; i++) writeFileSync(join(ext, `big-${i}.bin`), randomBytes(12 * 1024 * 1024))
    const bundle = Buffer.from('// bundle')
    writeFileSync(join(dir, 'atrium-bridge.mjs'), bundle)
    const real = JSON.parse(readFileSync(join(vendorDir, 'build-info.json'), 'utf8')) as BuildInfo
    const treeHash = hashTreeSync(ext)
    assert.equal(await hashTree(ext), treeHash, 'async and sync tree hashes are the same recipe')
    const info: BuildInfo = { ...real, bundle: { ...real.bundle, sha256: sha256(bundle), bytes: bundle.length }, extension: { ...real.extension, sha256: treeHash, files: 8 } }
    writeFileSync(join(dir, 'build-info.json'), JSON.stringify(info))
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifestOf(dir, info)))

    let worst = 0
    let last = performance.now()
    const timer = setInterval(() => { const now = performance.now(); worst = Math.max(worst, now - last - 10); last = now }, 10)
    last = performance.now()
    const problems = await auditVendor(dir)
    clearInterval(timer)
    assert.deepEqual(problems, [])
    assert.ok(worst < 50, `the loop was blocked for ${Math.round(worst)} ms during the audit`)

    const target = join(ext, 'big-5.bin')
    const bytes = readFileSync(target)
    bytes[7] = ~bytes[7]! & 0xff
    writeFileSync(target, bytes)
    const bad = await auditVendor(dir)
    assert.ok(bad.some(p => p.startsWith('extension/big-5.bin: sha256')), bad.join(' | '))
    assert.ok(bad.some(p => p.startsWith('extension/: hash')), bad.join(' | '))
  })

  test('the manifest declares the settings, the command and the menu item of the design', () => {
    assert.equal(manifest.id, 'web-bridge')
    assert.equal(manifest.displayName, 'Tether Bridge')
    assert.deepEqual(manifest.hosts, ['renderer', 'main', 'daemon'])
    assert.deepEqual(Object.keys(manifest.contributes!.settings!), ['serveToAgents', 'agentWindows', 'evaluate'])
    assert.equal(manifest.contributes!.settings!.evaluate!.default, 'own-tabs')
    assert.equal(manifest.contributes!.commands![0]!.command, 'web-bridge.install')
    assert.equal(manifest.contributes!.menus!.app![0]!.group, 'tools')
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
    assert.equal((JSON.parse(readFileSync(join(bridgeHome, 'config.json'), 'utf8')) as { extensionVersion?: string }).extensionVersion, VENDORED_VERSION, 'C5: the installed version for the welcome')
    assert.ok(!existsSync(updateMarkerPath(home)), 'no reload notice after an install')
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
  const buildInfo = JSON.parse(readFileSync(join(vendorDir, 'build-info.json'), 'utf8')) as { extensionId: string; brand: { slug: string; name: string; mcp: { serverName: string }; capabilities: Record<string, unknown> } }
  const buildId = buildInfo.extensionId
  /** The package's defaults (brand/brand.json → build-info.brand.capabilities): what a fresh installation starts with. */
  const packageCaps = buildInfo.brand.capabilities
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

  test('a fresh home: config at the port, brand, build id pinned, the package capabilities seeded, MCP file, daemon started once; no extension folder; nothing leaks; a second start changes nothing', async () => {
    const home = tmp.make()
    const log: string[] = []
    const spawns: unknown[][] = []
    const host = hostFor(home, 48131, log, spawns)
    const r = await host.setup()
    assert.deepEqual(r, { ok: true, created: true, capabilities: Object.keys(packageCaps), mcpWritten: true, extension: 'absent', daemon: 'started' })
    assert.deepEqual(Object.keys(packageCaps).sort(), ['download', 'evaluate', 'pdf', 'readNetwork', 'upload', 'windowPerAgent'], 'the vendored build carries the brand defaults')
    const bridgeHome = bridgeHomeOf(home)
    const config = readConfig(home)
    assert.equal(config.port, 48131)
    assert.deepEqual(config.extensionIds, [buildId])
    assert.deepEqual(config.brand, brand)
    assert.deepEqual(config.capabilities, packageCaps)
    assert.equal(config.apiKeys[0]!.name, 'default')
    const apiKey = readFileSync(join(bridgeHome, 'api.key'), 'utf8').trim()
    assert.ok(apiKey.length >= 16)
    // The extension folder is the install flow's (§1.2): the start creates none.
    assert.ok(!existsSync(extensionDirOf(home)), 'no extension folder at startup')
    // The MCP file: paths and env only, exactly the design's shape; the server name is the package's (= this extension's).
    const mcpText = readFileSync(mcpConfigPathOf(home), 'utf8')
    assert.equal(MCP_SERVER_NAME, 'tether-bridge')
    assert.equal(buildInfo.brand.mcp.serverName, 'tether-bridge')
    assert.deepEqual(JSON.parse(mcpText), {
      mcpServers: { 'tether-bridge': { command: 'node', args: [join(vendorDir, 'atrium-bridge.mjs'), 'mcp'], env: { ATRIUM_BRIDGE_HOME: bridgeHome, ATRIUM_BRIDGE_PORT: '48131', ATRIUM_BRIDGE_SERVER_NAME: 'tether-bridge' } } },
    })
    assert.deepEqual(spawns, [['C:\\fake\\node.exe', join(vendorDir, 'atrium-bridge.mjs'), 48131, bridgeHome]])
    const everything = `${log.join('\n')}\n${mcpText}\n${JSON.stringify(r)}`
    assert.ok(!everything.includes(config.pairingToken), 'pairing token leaked')
    assert.ok(!everything.includes(apiKey), 'api key leaked')
    assert.ok(!everything.includes(config.apiKeys[0]!.hash.slice(7, 30)), 'key hash leaked')
    assert.ok(log.some(l => l.includes('instalação do bridge criada')) && log.some(l => l.includes('capabilities semeadas do pacote')) && log.some(l => l.includes('gravado')) && log.some(l => l.includes('daemon do bridge iniciado')), log.join('\n'))

    // The doctor checks after the setup: installation OK, daemon OK.
    const results = await Promise.all(host.checks().map(c => c()))
    assert.deepEqual(results.map(c => [c.level, c.name]), [['OK', 'Tether Bridge'], ['OK', 'daemon do bridge'], ['OK', 'extensão Tether Bridge no navegador']])
    assert.match(results[2]!.detail, /não instalada/)

    // A second start: nothing created, nothing seeded, the MCP file untouched, the daemon found running; the secrets stay.
    const again = await host.setup()
    assert.deepEqual(again, { ok: true, created: false, capabilities: [], mcpWritten: false, extension: 'absent', daemon: 'running' })
    assert.deepEqual(readConfig(home), config)
    assert.equal(readFileSync(join(bridgeHome, 'api.key'), 'utf8').trim(), apiKey)
    assert.equal(spawns.length, 1)
  })

  test('the installation decides: capabilities, port and an extra pinned id already there are kept; an installed folder gets its seed again', async () => {
    const home = tmp.make()
    assert.ok((await hostFor(home, 48132, [], []).setup()).ok)
    // The person's choices, written by hand (the bridge's own writer keeps unknown fields too).
    const path = join(bridgeHomeOf(home), 'config.json')
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    writeFileSync(path, JSON.stringify({ ...raw, port: 48999, capabilities: { evaluate: 'off' }, extensionIds: ['abcdefghijklmnopabcdefghijklmnop'] }, null, 2))
    const log: string[] = []
    const r = await hostFor(home, 48132, log, [], { healthy: true }).setup()
    assert.deepEqual(r, { ok: true, created: false, capabilities: [], mcpWritten: false, extension: 'absent', daemon: 'running' })
    const config = readConfig(home)
    assert.equal(config.port, 48999, 'the installation\'s port stays in config.json (ensureConfig only applies the port at creation)')
    assert.ok(log.some(l => l.includes('usa a porta 48999 no config.json')), log.join('\n'))
    assert.deepEqual(config.capabilities, { evaluate: 'off' }, 'capabilities untouched')
    assert.deepEqual(config.extensionIds, ['abcdefghijklmnopabcdefghijklmnop', buildId], 'the build id is added, the other stays')
    assert.ok(!log.some(l => l.includes('capabilities')), 'nothing seeded')
    assert.ok(!existsSync(join(bridgeHomeOf(home), 'config.lock')), 'the bridge\'s lock is released')
    // The folder the install flow created (here: the vendored extension copied by hand): the next start rewrites only its
    // seed, with host and the port the tetherd runs the daemon on (the seed is what the extension dials).
    const current = extensionDirOf(home)
    cpSync(join(vendorDir, 'extension'), current, { recursive: true })
    assert.ok(!existsSync(join(current, 'bridge.json')))
    const r2 = await hostFor(home, 48132, [], [], { healthy: true }).setup()
    assert.equal(r2.created, false)
    assert.equal(r2.extension, 'current', 'the copy IS the vendored build: nothing to update')
    assert.equal((JSON.parse(readFileSync(path, 'utf8')) as { extensionVersion?: string }).extensionVersion, VENDORED_VERSION, 'the manifest version of the folder goes to config.json for the welcome')
    assert.deepEqual(JSON.parse(readFileSync(join(current, 'bridge.json'), 'utf8')), { port: 48132, token: config.pairingToken, host: 'Tether' })
    assert.equal(readConfig(home).pairingToken, config.pairingToken)
  })

  test('defaultCapabilities and serverNameOf: the package defaults when the build carries them, else this extension\'s', () => {
    const base = { name: 'tether-bridge', version: '0.1.0', extensionId: buildId, bundle: { file: 'a', sha256: 'b', bytes: 1 }, extension: { dir: 'extension', sha256: 'c', files: 1 } }
    assert.deepEqual(defaultCapabilities(base), { windowPerAgent: false, evaluate: 'own-tabs' })
    assert.deepEqual(defaultCapabilities({ ...base, brand: { slug: 't', name: 'T', capabilities: { evaluate: 'all', pdf: false } } }), { evaluate: 'all', pdf: false })
    assert.deepEqual(defaultCapabilities(undefined), { windowPerAgent: false, evaluate: 'own-tabs' })
    assert.equal(serverNameOf(undefined), 'tether-bridge')
    assert.equal(serverNameOf(base), 'tether-bridge')
    assert.equal(serverNameOf({ ...base, brand: { slug: 't', name: 'T', mcp: { serverName: 'other-bridge' } } }), 'other-bridge')
    assert.equal(serverNameOf({ ...base, brand: { slug: 't', name: 'T', mcp: { serverName: 'não vale' } } }), 'tether-bridge', 'an invalid name falls back')
    assert.equal(mcpConfigOf('H', 'B', 1).mcpServers['tether-bridge']!.env.ATRIUM_BRIDGE_PORT, '1')
    const other = mcpConfigOf('H', 'B', 1, 'other-bridge')
    assert.deepEqual(Object.keys(other.mcpServers), ['other-bridge'])
    assert.equal(other.mcpServers['other-bridge']!.env.ATRIUM_BRIDGE_SERVER_NAME, 'other-bridge')
  })

  test('warm: false writes everything and starts nothing (a second home without its own port)', async () => {
    const home = tmp.make()
    const log: string[] = []
    const spawns: unknown[][] = []
    const host = createBridgeHost({ home, vendorDir, port: 48134, brand, nodeExe: () => 'C:\\fake\\node.exe', log: m => log.push(m), warm: false, fetch: async () => new Response('', { status: 503 }), spawnDaemon: (...a) => { spawns.push(a); return 1 }, sleep: async () => {} })
    const r = await host.setup()
    assert.deepEqual(r, { ok: true, created: true, capabilities: Object.keys(packageCaps), mcpWritten: true, extension: 'absent', daemon: 'skipped' })
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

  test('activate(): registers the doctor checks (installation, daemon, extension, debug mode) and waits for onStarted; nothing is written before (a satellite never starts); an empty home reads as AVISO', async () => {
    const home = tmp.make()
    const checks: Array<() => Promise<DaemonCheck>> = []
    const started: Array<() => void> = []
    const log: string[] = []
    const api: TetherDaemon = {
      ...new DoorHost({ log: () => {} }).apiFor('web-bridge', new DisposableStore()),
      id: 'web-bridge', brand: BRAND, home,
      agents: { register: () => toDisposable(() => {}), get: () => undefined },
      launch: { use: () => toDisposable(() => {}) },
      doctor: { register: c => { checks.push(c); return toDisposable(() => {}) } },
      traces: { register: () => toDisposable(() => {}) },
      onStarted: l => { started.push(l); return toDisposable(() => {}) },
      settings: { get: () => undefined },
      profiles: { get: () => undefined },
      io: fsIo,
      log: m => log.push(m),
      onSlot: () => toDisposable(() => {}),
    }
    const disposables = activateDaemon(api)
    assert.equal(disposables.length, 10, 'onStarted + launch middleware + the HTTP host + slot listener (C3) + 3 checks + calls in flight + the debug line + the trace source')
    assert.equal(checks.length, 5)
    assert.deepEqual(await checks[4]!(), { level: 'OK', name: 'depuração do Tether Bridge', detail: 'desligada' })
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

describe('web-bridge: update in place (F7 C5, real vendored build, temp home)', () => {
  const info = JSON.parse(readFileSync(join(vendorDir, 'build-info.json'), 'utf8')) as BuildInfo
  const source = join(vendorDir, 'extension')
  const brand = { name: 'Tether', color: '#6aa6ff', hostId: 'studio.codr.tether' }
  const SEED = new Set(['bridge.json'])
  const filesUnder = (dir: string): string[] => readdirSync(dir, { withFileTypes: true, recursive: true }).filter(e => e.isFile()).map(e => join(e.parentPath, e.name))

  /** An installed folder from an "older build": the vendored files, a seed, a changed file, a file the build no longer has, a missing icon. */
  function olderInstall(home: string): string {
    const current = extensionDirOf(home)
    cpSync(source, current, { recursive: true })
    writeFileSync(join(current, 'bridge.json'), JSON.stringify({ port: 48141, token: 'tok-tok-tok-tok-tok-1', host: 'Tether' }))
    writeFileSync(join(current, 'popup.html'), '<!-- the older build -->')
    mkdirSync(join(current, 'old'), { recursive: true })
    writeFileSync(join(current, 'old', 'stale.js'), '// gone in the new build')
    rmSync(join(current, 'icons', 'icon-16.png'))
    return current
  }

  test('updateExtensionDir: only differing files are written (temp + rename), removed files go, the seed and equal files stay; no-op when equal', async () => {
    const home = tmp.make()
    const current = olderInstall(home)
    assert.equal(await extensionOutdated(current, info), true)
    assert.equal(await extensionOutdated(join(home, 'nowhere'), info), false, 'a missing folder is absent, not outdated')
    const manifestBefore = statSync(join(current, 'manifest.json')).mtimeMs
    const u = await updateExtensionDir(source, current)
    assert.deepEqual(u.written.sort(), ['icons/icon-16.png', 'popup.html'])
    assert.deepEqual(u.removed, ['old/stale.js'])
    assert.ok(!existsSync(join(current, 'old')), 'the emptied folder is pruned')
    assert.equal(readFileSync(join(current, 'popup.html'), 'utf8'), readFileSync(join(source, 'popup.html'), 'utf8'))
    assert.equal(await hashTree(current, SEED), info.extension.sha256, 'the folder IS the build again, seed left out')
    assert.equal(await extensionOutdated(current, info), false)
    assert.deepEqual(JSON.parse(readFileSync(join(current, 'bridge.json'), 'utf8')), { port: 48141, token: 'tok-tok-tok-tok-tok-1', host: 'Tether' }, 'the seed is never touched')
    assert.equal(statSync(join(current, 'manifest.json')).mtimeMs, manifestBefore, 'an equal file is not rewritten')
    assert.ok(!filesUnder(current).some(f => f.endsWith('.tmp')), 'no temp file left behind')
    assert.deepEqual(await updateExtensionDir(source, current), { written: [], removed: [] }, 'second run: nothing')
  })

  test('syncExtensionVersion: the field goes through the REAL bundle\'s setExtensionVersion (its own lock, the rest of the config kept); only when it differs; a stale lock is taken over', async () => {
    const home = tmp.make()
    const bridgeHome = bridgeHomeOf(home)
    const b = await importBundleFromDisk(join(vendorDir, 'atrium-bridge.mjs'))
    assert.equal(typeof b.setExtensionVersion, 'function', 'the vendored bundle exports setExtensionVersion (bridge 782d3ea55+)')
    const created = b.ensureConfig(bridgeHome, 48161)
    b.setBrand(bridgeHome, { name: 'Tether', color: '#6aa6ff', hostId: 'studio.codr.tether' })
    const before = JSON.parse(readFileSync(join(bridgeHome, 'config.json'), 'utf8')) as Record<string, unknown>
    assert.equal(before.extensionVersion, undefined)
    assert.equal(await storedExtensionVersion(bridgeHome), undefined)
    const stale = join(bridgeHome, 'config.lock')
    writeFileSync(stale, '999999\n')
    const old = (Date.now() - 60_000) / 1000
    utimesSync(stale, old, old)
    assert.equal(await syncExtensionVersion(b, bridgeHome, '0.1.0.77'), true)
    assert.ok(!existsSync(stale), 'the bridge took the stale lock over and released it')
    const after = JSON.parse(readFileSync(join(bridgeHome, 'config.json'), 'utf8')) as Record<string, unknown>
    assert.deepEqual(after, { ...before, extensionVersion: '0.1.0.77' }, 'one field added; port, token, keys, brand and ids as they were')
    assert.equal(before.pairingToken, created.pairingToken)
    assert.equal(await storedExtensionVersion(bridgeHome), '0.1.0.77')
    const mtime = statSync(join(bridgeHome, 'config.json')).mtimeMs
    assert.equal(await syncExtensionVersion(b, bridgeHome, '0.1.0.77'), false, 'same version: not written')
    assert.equal(statSync(join(bridgeHome, 'config.json')).mtimeMs, mtime, 'the file was not touched')
    assert.equal(await syncExtensionVersion(b, bridgeHome, '0.2.0'), true)
    assert.equal(await storedExtensionVersion(bridgeHome), '0.2.0')
    await assert.rejects(() => syncExtensionVersion(b, bridgeHome, 'not-a-version'), /INVALID_ARGUMENT|manifest version/, 'the bundle validates the form')
  })

  test('the host updates an older installed folder in place: seed kept with the same token, extensionVersion in config, marker + doctor AVISO; a current folder is left alone', async () => {
    const home = tmp.make()
    const log: string[] = []
    const host = () => createBridgeHost({ home, vendorDir, port: 48141, brand, nodeExe: () => 'C:\\fake\\node.exe', log: m => log.push(m), fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }), spawnDaemon: () => 1, sleep: async () => {}, process: { identify: async () => undefined, portOwner: async () => undefined, kill: async () => {}, alive: () => false } })
    assert.equal((await host().setup()).extension, 'absent')
    const current = olderInstall(home)
    const token = (JSON.parse(readFileSync(join(bridgeHomeOf(home), 'config.json'), 'utf8')) as { pairingToken: string }).pairingToken
    const r = await host().setup()
    assert.equal(r.extension, 'updated')
    assert.equal(r.daemon, 'running')
    assert.equal(await hashTree(current, SEED), info.extension.sha256)
    assert.deepEqual(JSON.parse(readFileSync(join(current, 'bridge.json'), 'utf8')), { port: 48141, token, host: 'Tether' }, 'the seed carries the installation\'s token and the tether\'s port')
    const config = JSON.parse(readFileSync(join(bridgeHomeOf(home), 'config.json'), 'utf8')) as { pairingToken: string; extensionVersion?: string }
    assert.equal(config.pairingToken, token, 'the token did not rotate')
    assert.equal(config.extensionVersion, VENDORED_VERSION)
    assert.deepEqual((await readUpdateMarker(home))?.version, VENDORED_VERSION)
    assert.ok(log.some(l => l.includes(`atualizada em lugar (${VENDORED_VERSION} → ${VENDORED_VERSION}: 2 arquivo(s) gravado(s), 1 removido(s))`)), log.join('\n'))
    assert.ok(!log.join('\n').includes(token), 'token leaked')
    const checks = await Promise.all(host().checks().map(c => c()))
    assert.equal(checks[2]!.level, 'AVISO')
    assert.ok(checks[2]!.detail.includes(`atualizada para ${VENDORED_VERSION} `), checks[2]!.detail)
    assert.match(checks[2]!.hint ?? '', /Recarregar.*chrome:\/\/extensions/)
    // Current already: nothing written, the marker stays until the person reloads (or installs again).
    log.length = 0
    const again = await host().setup()
    assert.equal(again.extension, 'current')
    assert.ok(!log.some(l => l.includes('atualizada')), log.join('\n'))
    assert.ok(await readUpdateMarker(home))
  })

  test('restartIfOutdated: the daemon is ended only with pid + bridge command line + port owner proven, and only when its bundle is not the vendored one', async () => {
    const mk = async (opts: { record?: 'same' | 'old' | 'none'; cmd?: string; owner?: number; healthy?: boolean }) => {
      const home = tmp.make()
      const bridgeHome = bridgeHomeOf(home)
      mkdirSync(bridgeHome, { recursive: true })
      writeFileSync(join(bridgeHome, 'daemon.pid'), '4242\n')
      if (opts.record !== 'none') await writeDaemonRecord(bridgeHome, { pid: 4242, bundleSha256: opts.record === 'same' ? 'sha-new' : 'sha-old', startedAt: 't' })
      const state = { alive: true, healthy: opts.healthy ?? true, ensured: 0, killed: [] as number[] }
      const log: string[] = []
      const warmup: Warmup = { health: async () => state.healthy, ensure: async () => { state.ensured++; state.healthy = true; return 'started' } }
      const run = () => restartIfOutdated({
        port: 48150, bundlePath: 'B', bundleSha256: 'sha-new', bridgeHome, warmup, log: m => log.push(m), sleep: async () => {},
        identify: async pid => (pid === 4242 ? { cmd: opts.cmd ?? 'C:\\node.exe D:\\tether\\extensions\\web-bridge\\vendor\\atrium-bridge.mjs start --port 48150' } : undefined),
        portOwner: async () => opts.owner ?? 4242,
        kill: async pid => { state.killed.push(pid); state.alive = false; state.healthy = false },
        alive: () => state.alive,
      })
      return { run, state, log }
    }
    // Same bundle: nothing happens.
    let t = await mk({ record: 'same' })
    assert.equal(await t.run(), 'current')
    assert.deepEqual(t.state.killed, [])
    // Older bundle, identity proven: killed, started again, said so.
    t = await mk({ record: 'old' })
    assert.equal(await t.run(), 'restarted')
    assert.deepEqual(t.state.killed, [4242])
    assert.equal(t.state.ensured, 1)
    assert.ok(t.log.some(l => l.includes('encerrado para atualizar: o bundle vendorizado mudou')), t.log.join('\n'))
    // No record (a daemon from before this code): outdated by definition, same proof.
    t = await mk({ record: 'none' })
    assert.equal(await t.run(), 'restarted')
    assert.ok(t.log.some(l => l.includes('não há registro')), t.log.join('\n'))
    // The command line is not a bridge daemon's: kept.
    t = await mk({ record: 'old', cmd: 'C:\\node.exe D:\\other\\server.mjs start' })
    assert.equal(await t.run(), 'kept')
    assert.deepEqual(t.state.killed, [])
    assert.ok(t.log.some(l => l.includes('linha de comando')), t.log.join('\n'))
    // Another process owns the port: kept.
    t = await mk({ record: 'old', owner: 777 })
    assert.equal(await t.run(), 'kept')
    assert.deepEqual(t.state.killed, [])
    assert.ok(t.log.some(l => l.includes('pertence ao pid 777')), t.log.join('\n'))
    // Nothing answers on the port: no daemon to replace (the warm-up starts one).
    t = await mk({ record: 'old', healthy: false })
    assert.equal(await t.run(), 'current')
    assert.deepEqual(t.state.killed, [])
    // The record survives a round trip.
    const home = tmp.make()
    await writeDaemonRecord(bridgeHomeOf(home), { pid: 1, bundleSha256: 'x', startedAt: 'now' })
    assert.deepEqual(await readDaemonRecord(bridgeHomeOf(home)), { pid: 1, bundleSha256: 'x', startedAt: 'now' })
  })
})
