// E2E of the zero-click update (F7 slice C5, design §1.3) with a PRIVATE home, a free port, the REAL bridge daemon and a
// REAL Chromium loading the installed folder:
//   1. an "older build" of the vendored bridge is fabricated in a temp folder (manifest version 0.0.9, a changed popup, a
//      file the new build does not have, a bundle with one more line; build-info and manifest recomputed, so the vendor
//      audit passes) and installed with the install engine: `current` holds the old files, the OLD daemon runs on the port
//      and daemon.build.json records the old bundle;
//   2. Chromium gets `current` the way the person does it ("Load unpacked": CDP Extensions.loadUnpacked, location UNPACKED)
//      with Developer mode on (the guide's step 1; without it Chrome disables an unpacked extension at its first reload);
//      the extension (0.0.9) connects to the old daemon;
//   3. a private tetherd starts with the repo's vendor: it brings `current` to the new build file by file (seed kept, same
//      token), writes extensionVersion into config.json, ends the old daemon by its daemon.pid (identity proven) and starts
//      the new one (new pid); the log tells the story without a secret;
//   4. the extension reconnects to the new daemon on its own; then the reload the extension will do by itself in the next
//      bridge slice is simulated from the test (`chrome.runtime.reload()` in the service worker): the reloaded extension
//      reports the vendored version and connects again.
// Every kill goes through test/kill.ts (pid + identity). The person's tetherd, %LOCALAPPDATA%\tether, ~/.atrium-bridge,
// port 47831 and Chrome are never touched.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, type BrowserContext } from 'playwright-core'
import { DaemonClient } from '../../src/daemon/client.ts'
import { createInstaller } from '../../extensions/web-bridge/installer.ts'
import { bridgeHomeOf, extensionDirOf } from '../../extensions/web-bridge/paths.ts'
import { readUpdateMarker } from '../../extensions/web-bridge/update.ts'
import { auditVendor, hashTree, manifestOf, sha256, walk, type BuildInfo } from '../../extensions/web-bridge/vendor-rules.ts'
import { findNode, readDaemonRecord } from '../../extensions/web-bridge/warmup.ts'
import { claim, killOwned, type Owned } from '../kill.ts'

/** The extension's own global inside its pages (popup.html), and chrome://extensions' private API (developer mode). */
declare const chrome: {
  runtime: { getManifest(): { version: string }; reload(): void; lastError?: { message: string } }
  developerPrivate: { updateProfileConfiguration(update: { inDeveloperMode: boolean }, cb: () => void): void }
}

const root = resolve(import.meta.dirname, '..', '..')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const vendorDir = join(root, 'extensions', 'web-bridge', 'vendor')

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}
function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer()
    s.on('error', rej)
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)) })
  })
}
async function waitUntil(cond: () => Promise<boolean> | boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timeout (${timeoutMs} ms) waiting for ${what}`)
    await sleep(250)
  }
}
const health = (port: number): Promise<boolean> => fetch(`http://127.0.0.1:${port}/health`).then(r => r.ok, () => false)
type Browsers = { browsers: { id: string; name: string; connectedAt: string }[] }
const browsers = (port: number, key: string): Promise<Browsers> => fetch(`http://127.0.0.1:${port}/browsers`, { headers: { authorization: `Bearer ${key}` } }).then(r => r.json() as Promise<Browsers>, () => ({ browsers: [] }))
const readPid = (bridgeHome: string): number | undefined => { try { return Number(readFileSync(join(bridgeHome, 'daemon.pid'), 'utf8').trim()) || undefined } catch { return undefined } }

/** A Chromium build (not the branded Chrome: it refuses --load-extension since 137): CHROME_PATH, Playwright's, or the bridge tests' golden copy. */
function findChromium(): string | undefined {
  const candidates = [process.env.CHROME_PATH, chromium.executablePath(), 'D:/atrium/.tmp/atrium-browser-e7a/golden/browsers/chromium-1243/chrome-win64/chrome.exe']
  return candidates.find((c): c is string => !!c && existsSync(c))
}

/** The guide's step 1, done the way chrome://extensions does it: an unpacked extension survives a reload only in developer mode. */
async function developerModeOn(context: BrowserContext): Promise<void> {
  const page = await context.newPage()
  try {
    await page.goto('chrome://extensions', { timeout: 10_000 })
    const r = await page.evaluate(() => new Promise<string>(res => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }, () => res(chrome.runtime.lastError?.message ?? 'on'))))
    assert.equal(r, 'on')
  } finally { await page.close().catch(() => {}) }
}

/** The manifest version of the extension the browser is running right now, read in its own popup page. */
async function loadedVersion(context: BrowserContext, extensionId: string): Promise<string> {
  const page = await context.newPage()
  try {
    await page.goto(`chrome-extension://${extensionId}/popup.html`, { timeout: 10_000 })
    return await page.evaluate(() => chrome.runtime.getManifest().version)
  } finally { await page.close().catch(() => {}) }
}

/** The repo's vendor as an "older build": version 0.0.9, a changed popup, an extra file, a bundle one line longer; audit-clean. */
function olderVendor(dir: string): BuildInfo {
  cpSync(vendorDir, dir, { recursive: true })
  const ext = join(dir, 'extension')
  const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8')) as { version: string }
  manifest.version = '0.0.9'
  writeFileSync(join(ext, 'manifest.json'), JSON.stringify(manifest, null, 2))
  writeFileSync(join(ext, 'popup.html'), readFileSync(join(ext, 'popup.html'), 'utf8').replace('</body>', '<!-- older build --></body>'))
  mkdirSync(join(ext, 'old'), { recursive: true })
  writeFileSync(join(ext, 'old', 'stale.txt'), 'only in the older build')
  appendFileSync(join(dir, 'atrium-bridge.mjs'), '\n// older build\n')
  const info = JSON.parse(readFileSync(join(dir, 'build-info.json'), 'utf8')) as BuildInfo
  info.version = '0.0.9'
  const bundle = readFileSync(join(dir, 'atrium-bridge.mjs'))
  info.bundle = { ...info.bundle, sha256: sha256(bundle), bytes: bundle.length }
  info.extension = { ...info.extension, sha256: hashTree(ext), files: walk(ext).length }
  writeFileSync(join(dir, 'build-info.json'), JSON.stringify(info, null, 2))
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifestOf(dir, info), null, 2))
  return info
}

test('an installed older build is updated in place at tetherd start, the daemon is restarted, and the extension reconnects before and after its reload', { timeout: 240_000 }, async () => {
  const chromePath = findChromium()
  assert.ok(chromePath, 'a Chromium that allows --load-extension: CHROME_PATH, the Playwright one, or the golden copy of the bridge tests')
  const home = mkdtempSync(join(tmpdir(), 'tether-wb-update-'))
  const oldVendor = mkdtempSync(join(tmpdir(), 'tether-wb-oldvendor-'))
  const profile = mkdtempSync(join(tmpdir(), 'tether-wb-update-profile-'))
  const pipe = `\\\\.\\pipe\\tether-wb-update-${process.pid}`
  const port = await freePort()
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(CLAUDE|TETHER_|ATRIUM_)/i.test(k)) env[k] = v
  env.TETHER_BRIDGE_PORT = String(port)
  const bridgeHome = bridgeHomeOf(home)
  const current = extensionDirOf(home)
  const newInfo = JSON.parse(readFileSync(join(vendorDir, 'build-info.json'), 'utf8')) as BuildInfo
  // The vendored extension's manifest version (`<bridge>.<commits>`, stamped by the bridge's build): what the folder, config.json and the browser must report after the update.
  const newVersion = (JSON.parse(readFileSync(join(vendorDir, 'extension', 'manifest.json'), 'utf8')) as { version: string }).version
  assert.notEqual(newVersion, '0.0.9')
  const owned: Owned[] = []
  let context: BrowserContext | undefined
  let client: DaemonClient | undefined
  let tetherd: Owned | undefined
  const log: string[] = []
  try {
    // 1. The older build, installed: current/ at 0.0.9, the old daemon on the port, the record naming the old bundle.
    const oldInfo = olderVendor(oldVendor)
    assert.deepEqual(auditVendor(oldVendor), [], 'the fabricated older vendor is audit-clean')
    assert.notEqual(oldInfo.bundle.sha256, newInfo.bundle.sha256)
    assert.notEqual(oldInfo.extension.sha256, newInfo.extension.sha256)
    const installer = createInstaller({ home, vendorDir: oldVendor, port, brand: { name: 'Tether', color: '#6aa6ff', hostId: 'studio.codr.tether' }, nodeExe: () => findNode(), log: m => log.push(m), openBrowser: () => {} })
    const installed = await installer.install({ id: 'chrome', name: 'Chromium de teste', exe: chromePath, extensionsUrl: 'chrome://extensions' })
    assert.ok(installed.ok, JSON.stringify(installed))
    assert.equal(installed.daemon, 'started')
    await waitUntil(() => readPid(bridgeHome) !== undefined, 10_000, 'daemon.pid of the old daemon')
    const oldPid = readPid(bridgeHome)!
    owned.push(await claim(oldPid, { cmdIncludes: 'atrium-bridge.mjs', what: 'old bridge daemon' }))
    assert.equal(readDaemonRecord(bridgeHome)?.bundleSha256, oldInfo.bundle.sha256, 'the record names the old bundle')
    assert.equal((JSON.parse(readFileSync(join(current, 'manifest.json'), 'utf8')) as { version: string }).version, '0.0.9')
    assert.ok(existsSync(join(current, 'old', 'stale.txt')))
    const seedBefore = JSON.parse(readFileSync(join(current, 'bridge.json'), 'utf8')) as { port: number; token: string; host?: string }
    const configBefore = JSON.parse(readFileSync(join(bridgeHome, 'config.json'), 'utf8')) as { pairingToken: string; extensionVersion?: string }
    assert.equal(configBefore.extensionVersion, '0.0.9', 'the install writes the installed version')
    const apiKey = readFileSync(join(bridgeHome, 'api.key'), 'utf8').trim()

    // 2. Chromium loads the folder; the 0.0.9 extension connects to the old daemon.
    context = await chromium.launchPersistentContext(profile, { executablePath: chromePath, headless: true, ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'] })
    const cdp = await context.browser()!.newBrowserCDPSession()
    const loaded = await cdp.send('Extensions.loadUnpacked' as never, { path: current } as never) as unknown as { id: string }
    assert.equal(loaded.id, newInfo.extensionId, 'the folder loads with the id of the build (manifest key)')
    await developerModeOn(context)
    assert.equal(await loadedVersion(context, newInfo.extensionId), '0.0.9', 'the browser runs the older build')
    await waitUntil(async () => (await browsers(port, apiKey)).browsers.length === 1, 30_000, 'the extension connected to the old daemon')
    const firstConnection = (await browsers(port, apiKey)).browsers[0]!.connectedAt

    // 3. The private tetherd starts with the repo's vendor: folder updated, daemon replaced.
    client = await DaemonClient.connect({ home, pipe, client: 'test', env, startTimeoutMs: 30_000 })
    tetherd = await claim(client.hello.pid, { cmdIncludes: daemonMain, what: 'tetherd' })
    await waitUntil(() => { const p = readPid(bridgeHome); return p !== undefined && p !== oldPid && pidAlive(p) }, 60_000, 'a new daemon.pid')
    const newPid = readPid(bridgeHome)!
    owned.push(await claim(newPid, { cmdIncludes: 'atrium-bridge.mjs', what: 'new bridge daemon' }))
    await waitUntil(() => health(port), 30_000, `/health of the new daemon on ${port}`)
    assert.ok(!pidAlive(oldPid), 'the old daemon is gone')
    assert.equal(readDaemonRecord(bridgeHome)?.pid, newPid)
    assert.equal(readDaemonRecord(bridgeHome)?.bundleSha256, newInfo.bundle.sha256, 'the record names the vendored bundle now')
    // The folder: the new build exactly (seed left out), the seed as it was.
    assert.equal(hashTree(current, new Set(['bridge.json'])), newInfo.extension.sha256, 'current/ is the vendored build')
    assert.equal((JSON.parse(readFileSync(join(current, 'manifest.json'), 'utf8')) as { version: string }).version, newVersion)
    assert.ok(!existsSync(join(current, 'old')), 'the file the new build does not have is gone')
    assert.equal(readFileSync(join(current, 'popup.html'), 'utf8'), readFileSync(join(vendorDir, 'extension', 'popup.html'), 'utf8'))
    assert.deepEqual(JSON.parse(readFileSync(join(current, 'bridge.json'), 'utf8')), seedBefore, 'the seed keeps port, token and host')
    const configAfter = JSON.parse(readFileSync(join(bridgeHome, 'config.json'), 'utf8')) as { pairingToken: string; extensionVersion?: string }
    assert.equal(configAfter.pairingToken, configBefore.pairingToken, 'the token did not rotate')
    assert.equal(configAfter.extensionVersion, newVersion, 'the welcome contract field')
    assert.equal(readUpdateMarker(home)?.version, newVersion, 'the "reload" notice is pending')
    // The log tells the story, without a secret.
    const tlog = readFileSync(join(home, 'tetherd.log'), 'utf8')
    assert.ok(tlog.includes(`atualizada em lugar (0.0.9 → ${newVersion}: `), tlog)
    assert.ok(tlog.includes(`[web-bridge] extensionVersion ${newVersion} gravada`), tlog)
    assert.match(tlog, new RegExp(`\\[web-bridge\\] daemon do bridge \\(pid ${oldPid}\\) encerrado para atualizar: o bundle vendorizado mudou`), tlog)
    assert.match(tlog, /\[web-bridge\] daemon do bridge iniciado \(pid \d+/, tlog)
    for (const text of [tlog, log.join('\n')]) {
      assert.ok(!text.includes(configBefore.pairingToken), 'pairing token leaked')
      assert.ok(!text.includes(apiKey), 'api key leaked')
    }

    // 4. The (still 0.0.9) extension reconnects to the new daemon by itself, gets `extensionVersion: <new>` in the welcome
    //    and, as the bridge's side of the C5 contract (782d3ea55), calls chrome.runtime.reload() ONCE for that version: the
    //    browser ends up running the vendored build, connected again, with nobody clicking anything.
    await waitUntil(async () => { const b = (await browsers(port, apiKey)).browsers; return b.length === 1 && b[0]!.connectedAt > firstConnection }, 60_000, 'the extension reconnected to the new daemon')
    await waitUntil(async () => (await loadedVersion(context!, newInfo.extensionId).catch(() => '')) === newVersion, 60_000, `the extension reloaded itself to ${newVersion}`)
    await waitUntil(async () => { const b = (await browsers(port, apiKey)).browsers; return b.length === 1 && b[0]!.connectedAt > firstConnection }, 60_000, 'the reloaded extension connected')
    await sleep(3000)
    assert.equal(await loadedVersion(context, newInfo.extensionId), newVersion, 'and stays there: one reload per version, no loop')
    assert.equal((await browsers(port, apiKey)).browsers.length, 1)
  } finally {
    if (context) await context.close().catch(() => {})
    for (const p of owned) await killOwned(p)
    if (client && tetherd) {
      try { await client.request({ t: 'shutdown' }) } catch { /* already gone */ }
      const deadline = Date.now() + 20_000
      while (pidAlive(tetherd.pid) && Date.now() < deadline) await sleep(100)
      if (pidAlive(tetherd.pid)) await killOwned(tetherd, { tree: true })
      client.close()
    }
    for (const dir of [home, oldVendor, profile]) {
      for (let i = 0; i < 10; i++) { try { rmSync(dir, { recursive: true, force: true }); break } catch { await sleep(500) } }
    }
  }
})
