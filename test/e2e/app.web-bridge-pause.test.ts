// E2E of Pausar/Retomar from the tether's status popover (F7 C4) against the REAL chain, nothing faked: the real app
// (hidden window) and its real tetherd on a PRIVATE home/pipe, the REAL vendored bridge daemon the tetherd warms on a free
// port, and a REAL Chromium running the extension folder the install flow writes (CDP Extensions.loadUnpacked):
//   1. the tetherd warms the vendored daemon; the install engine writes web-bridge/current (seed with the home's token and
//      the test port) and config.extensionVersion through the bundle; Chromium loads the folder and the extension pairs;
//   2. the popover shows the browser (badge 1); an "agent" (HTTP POST /browsers/:id/call with X-Bridge-Client, the same
//      route the MCP shell uses) opens a tab under control (`tabs {action:"new"}`): the browser row counts it, the agent row goes busy;
//   3. Pausar in the popover → the daemon's real POST /pause: the icon goes amber "Tether Bridge pausado", the extension
//      lets the tab go (the browser row says "nenhuma aba sob controle"), and the agent's next call is refused with
//      BRIDGE_PAUSED (HTTP 423) — the daemon says so to the agent, with a message that tells it to wait;
//   4. Retomar → POST /resume: the next call works again and the tab is under control once more;
//   5. the footer names ONE version (installed = vendored, the manifest's `<bridge>.<commits>`), no "recarregue" notice;
//      config.json carries that version; no secret in tether-app.log or the snapshot.
// Every kill goes through test/kill.ts (pid + identity). The person's tether (%LOCALAPPDATA%\tether, port 47831),
// ~/.atrium-bridge and Chrome are never touched.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, chromium, type BrowserContext, type ElectronApplication, type Page } from 'playwright-core'
import { createInstaller } from '../../extensions/web-bridge/installer.ts'
import { bridgeHomeOf, extensionDirOf } from '../../extensions/web-bridge/paths.ts'
import { readUpdateMarker } from '../../extensions/web-bridge/update.ts'
import { findNode } from '../../extensions/web-bridge/find-node-sync.ts'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type Snapshot = { daemon: string; paused: boolean; pauseSupported: boolean; browsers: { id: string; name: string; tabs: number }[]; agents: { clientId: string; slotId?: string; name: string; tabs: number; lastTool?: string }[]; version: { vendored?: string; installed?: string; pendingReload: boolean } }
type Status = { snapshot: Snapshot; state: string; badge: number | 'dot' | undefined; title: string; watching: boolean }
declare const window: { __tether: { connection(): { pid?: number } | undefined; panelIds(): string[]; webBridge: { status(): Status } } }
/** chrome://extensions' private API (developer mode), inside the test Chromium. */
declare const chrome: { runtime: { lastError?: { message: string } }; developerPrivate: { updateProfileConfiguration(update: { inDeveloperMode: boolean }, cb: () => void): void } }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const artifacts = join(root, 'test', 'e2e', 'artifacts')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const pipe = `\\\\.\\pipe\\tether-wb-pause-${process.pid}`
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const vendorDir = join(root, 'extensions', 'web-bridge', 'vendor')
const STATUS = '.status-wrap[data-status="web-bridge.status"]'

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
const readPid = (bridgeHome: string): number | undefined => { try { return Number(readFileSync(join(bridgeHome, 'daemon.pid'), 'utf8').trim()) || undefined } catch { return undefined } }

/** A Chromium build (not the branded Chrome: it refuses --load-extension since 137): CHROME_PATH, Playwright's, or the bridge tests' golden copy. */
function findChromium(): string | undefined {
  const candidates = [process.env.CHROME_PATH, chromium.executablePath(), 'C:/atrium/.tmp/atrium-browser-e7a/golden/browsers/chromium-1243/chrome-win64/chrome.exe']
  return candidates.find((c): c is string => !!c && existsSync(c))
}

/** The guide's step 1, done the way chrome://extensions does it. */
async function developerModeOn(context: BrowserContext): Promise<void> {
  const page = await context.newPage()
  try {
    await page.goto('chrome://extensions', { timeout: 10_000 })
    const r = await page.evaluate(() => new Promise<string>(res => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }, () => res(chrome.runtime.lastError?.message ?? 'on'))))
    assert.equal(r, 'on')
  } finally { await page.close().catch(() => {}) }
}

/** The daemon's HTTP API as an agent's shell speaks it (the MCP shell does exactly these requests). */
function bridgeApi(port: number, apiKey: string) {
  const headers = { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }
  return {
    browsers: () => fetch(`http://127.0.0.1:${port}/browsers`, { headers }).then(r => r.json() as Promise<{ browsers: { id: string; name: string }[] }>),
    status: () => fetch(`http://127.0.0.1:${port}/status`, { headers }).then(r => r.json() as Promise<{ paused: boolean; browsers: { id: string; tabs: { id: number; owner?: string }[] }[] }>),
    call: async (browserId: string, client: { id: string; name: string }, tool: string, args: Record<string, unknown>) => {
      const r = await fetch(`http://127.0.0.1:${port}/browsers/${encodeURIComponent(browserId)}/call`, { method: 'POST', headers: { ...headers, 'x-bridge-client': client.id, 'x-bridge-client-name': client.name }, body: JSON.stringify({ tool, args, timeoutMs: 30_000 }) })
      return { status: r.status, body: await r.json() as { ok: boolean; result?: unknown; error?: { code: string; message: string } } }
    },
  }
}

async function launch(home: string, extra: Record<string, string>): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_') && !k.toUpperCase().startsWith('CLAUDE')) env[k] = v
  Object.assign(env, { TETHER_PIPE: pipe, TETHER_HOME: home, TETHER_E2E_HIDDEN: '1' }, extra)
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10_000)
  page.on('pageerror', e => console.error(`renderer error: ${e.message}`))
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800))
  return { app, page }
}

const status = (page: Page): Promise<Status> => page.evaluate(() => window.__tether.webBridge.status())
const pop = (page: Page) => page.locator(`${STATUS} .status-pop`)
const btn = (page: Page) => page.locator(`${STATUS} .status-btn`)

/** Opens the popover (which polls every 2 s while open) unless open, then waits for `cond` on the hook. */
async function openAndWait(page: Page, cond: (s: Status) => boolean, what: string, timeoutMs = 20_000): Promise<Status> {
  if (!(await pop(page).isVisible())) { await btn(page).click(); await pop(page).waitFor() }
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const s = await status(page)
    if (cond(s)) return s
    if (Date.now() > deadline) throw new Error(`${what}: ${JSON.stringify(s)}`)
    await sleep(150)
  }
}
async function openShell(page: Page, cwd: string): Promise<string> {
  const before = await page.evaluate(() => window.__tether.panelIds())
  await page.click('#btn-new')
  await page.waitForSelector('#dlg-new[open]')
  await page.fill('#dlg-new .ch-path-input', cwd)
  await page.click('#dlg-new .ch-item[data-id="powershell"]')
  await page.click('#dlg-new .btn.primary.go') // two steps: the click selects, the button opens
  await page.locator('#dlg-new[open]').waitFor({ state: 'hidden' })
  await page.waitForFunction(n => window.__tether.panelIds().length === n, before.length + 1)
  return (await page.evaluate(() => window.__tether.panelIds())).find(id => !before.includes(id))!
}
async function shotWindowTop(app: ElectronApplication, name: string): Promise<void> {
  const b64 = await app.evaluate(async ({ BrowserWindow }) => {
    const img = await BrowserWindow.getAllWindows()[0]!.webContents.capturePage({ x: 740, y: 0, width: 540, height: 460 })
    return img.toPNG().toString('base64')
  })
  writeFileSync(join(artifacts, `${name}.png`), Buffer.from(b64, 'base64'))
}

test('web-bridge: Pausar no popover pausa o daemon real — a extensão solta as abas e o agente recebe BRIDGE_PAUSED; Retomar devolve (F7 C4 × real)', { timeout: 300_000 }, async () => {
  const chromePath = findChromium()
  assert.ok(chromePath, 'a Chromium that allows --load-extension: CHROME_PATH, the Playwright one, or the golden copy of the bridge tests')
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(artifacts, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-wb-pause-'))
  const profile = mkdtempSync(join(tmpdir(), 'tether-wb-pause-profile-'))
  const port = await freePort()
  const bridgeHome = bridgeHomeOf(home)
  const current = extensionDirOf(home)
  // The app's browser list is a fake .cmd, so no action here can ever open the person's Chrome.
  const fakeExe = join(home, 'fake-chrome.cmd')
  writeFileSync(fakeExe, `@echo %* >> "${join(home, 'browser-args.txt')}"\r\n`)
  const browsersJson = join(home, 'browsers.json')
  writeFileSync(browsersJson, JSON.stringify([{ id: 'chrome', name: 'Chrome de teste', exe: fakeExe }]))
  const info = JSON.parse(readFileSync(join(vendorDir, 'build-info.json'), 'utf8')) as { extensionId: string; version: string }
  const vendoredVersion = (JSON.parse(readFileSync(join(vendorDir, 'extension', 'manifest.json'), 'utf8')) as { version: string }).version
  assert.notEqual(vendoredVersion, info.version, 'the extension version is stamped `<bridge>.<commits>` (bridge 782d3ea55+)')

  const owned: Owned[] = []
  const installLog: string[] = []
  let app: ElectronApplication | undefined
  let context: BrowserContext | undefined
  try {
    // ---- 1. app + tetherd + the REAL vendored daemon; the folder installed; Chromium pairs ----
    let page: Page
    ;({ app, page } = await launch(home, { TETHER_BRIDGE_PORT: String(port), TETHER_WEB_BRIDGE_BROWSERS: browsersJson }))
    const tetherdPid = (await page.evaluate(() => window.__tether.connection()))?.pid
    assert.ok(tetherdPid && pidAlive(tetherdPid), 'the app spawned a tetherd')
    owned.push(await claim(tetherdPid, { cmdIncludes: daemonMain, what: 'tetherd' }))
    await waitUntil(() => health(port), 60_000, `/health of the vendored daemon on ${port}`)
    await waitUntil(() => readPid(bridgeHome) !== undefined, 10_000, 'daemon.pid')
    owned.push(await claim(readPid(bridgeHome)!, { cmdIncludes: 'atrium-bridge.mjs', what: 'bridge daemon' }))
    const apiKey = readFileSync(join(bridgeHome, 'api.key'), 'utf8').trim()
    const api = bridgeApi(port, apiKey)

    const installer = createInstaller({ home, vendorDir, port, brand: { name: 'Tether', color: '#6aa6ff', hostId: 'studio.codr.tether' }, nodeExe: () => findNode(), log: m => installLog.push(m), openBrowser: () => {} })
    const installed = await installer.install({ id: 'chrome', name: 'Chromium de teste', exe: chromePath, extensionsUrl: 'chrome://extensions' })
    assert.ok(installed.ok, JSON.stringify(installed))
    assert.equal(installed.daemon, 'running', 'the tetherd\'s daemon is the one; the install starts none')
    assert.equal(readPid(bridgeHome), owned[1]!.pid, 'same daemon pid')
    const config = JSON.parse(readFileSync(join(bridgeHome, 'config.json'), 'utf8')) as { pairingToken: string; extensionVersion?: string }
    assert.equal(config.extensionVersion, vendoredVersion, 'the install wrote the folder\'s version through the bundle')
    assert.equal(await readUpdateMarker(home), undefined)

    context = await chromium.launchPersistentContext(profile, { executablePath: chromePath, headless: true, ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'] })
    const cdp = await context.browser()!.newBrowserCDPSession()
    const loaded = await cdp.send('Extensions.loadUnpacked' as never, { path: current } as never) as unknown as { id: string }
    assert.equal(loaded.id, info.extensionId, 'the folder loads with the vendored id')
    await developerModeOn(context)
    await waitUntil(async () => (await api.browsers()).browsers.length === 1, 60_000, 'the extension paired with the daemon')
    const browserId = (await api.browsers()).browsers[0]!.id

    // ---- 2. the popover sees the real browser; an agent takes a tab ----
    await page.locator(STATUS).waitFor()
    let s = await openAndWait(page, x => x.snapshot.daemon === 'up' && x.snapshot.browsers.length === 1, 'one browser')
    assert.equal(s.state, 'normal')
    assert.equal(s.badge, 1)
    assert.match(s.title, / conectado$/)
    assert.equal(await page.locator(`${STATUS} .status-badge`).textContent(), '1')
    assert.equal(s.snapshot.browsers[0]!.tabs, 0)
    assert.ok(s.snapshot.pauseSupported)
    assert.equal(await pop(page).locator('.wb-version').textContent(), `Extensão ${vendoredVersion}`, 'installed = vendored: one version in the footer')
    assert.equal(await pop(page).locator('.wb-reload').count(), 0, 'nothing to reload')
    assert.deepEqual(s.snapshot.version, { vendored: vendoredVersion, installed: vendoredVersion, pendingReload: false })

    const pane = await openShell(page, root)
    const agent = { id: `tether:${pane}`, name: 'Claude · prova' }
    const first = await api.call(browserId, agent, 'tabs', { action: 'new', url: 'about:blank' })
    assert.equal(first.status, 200, JSON.stringify(first.body))
    assert.ok(first.body.ok)
    s = await openAndWait(page, x => x.snapshot.browsers[0]?.tabs === 1 && x.snapshot.agents.length === 1, 'a tab under control and the agent listed')
    assert.equal(s.state, 'busy', 'the call was seconds ago')
    assert.equal(await pop(page).locator('[data-section="browsers"] .wb-browser .wb-go').count(), 1, 'a tab under control: the browser has its arrow')
    const agentRow = pop(page).locator(`[data-section="agents"] .wb-agent[data-slot="${pane}"]`)
    assert.equal(await agentRow.locator('.wb-name').textContent(), 'Claude · prova')
    assert.equal(await agentRow.locator('.wb-go').count(), 1, 'its tab: the arrow')
    assert.equal((await api.status()).browsers[0]!.tabs.filter(t => t.owner === agent.id).length, 1, 'the daemon: one tab owned by the agent')

    // ---- 3. Pausar: real /pause → amber, the extension lets the tab go, the agent is refused ----
    await pop(page).locator('.wb-action[data-action="pause"]').click()
    s = await openAndWait(page, x => x.snapshot.paused && x.snapshot.browsers[0]?.tabs === 0, 'paused and the tab released')
    assert.equal(s.state, 'warn')
    assert.equal(s.title, 'Tether Bridge pausado')
    assert.equal(await btn(page).getAttribute('data-state'), 'warn')
    assert.equal(await pop(page).locator('.wb-notice.ok').textContent(), 'Tether Bridge pausado: os agentes esperam.')
    assert.equal(await pop(page).locator('.wb-action[data-action="pause"]').count(), 0)
    assert.equal(await pop(page).locator('.wb-action[data-action="resume"]').count(), 1)
    assert.equal(await pop(page).locator('[data-section="browsers"] .wb-browser .wb-go').count(), 0, 'paused: no tab under control')
    const daemon = await api.status()
    assert.equal(daemon.paused, true)
    assert.equal(daemon.browsers[0]!.tabs.length, 0, 'the extension detached from every tab under control')
    const refused = await api.call(browserId, agent, 'tabs', { action: 'new', url: 'about:blank' })
    assert.equal(refused.status, 423, JSON.stringify(refused.body))
    assert.equal(refused.body.ok, false)
    assert.equal(refused.body.error?.code, 'BRIDGE_PAUSED')
    assert.match(refused.body.error?.message ?? '', /paused/)
    assert.equal((await api.status()).browsers[0]!.tabs.length, 0, 'still nothing under control')
    await page.mouse.move(100, 600)
    await sleep(200)
    await shotWindowTop(app, 'web-bridge-pause-paused')

    // ---- 4. Retomar: real /resume → the agent works again ----
    await pop(page).locator('.wb-action[data-action="resume"]').click()
    s = await openAndWait(page, x => !x.snapshot.paused, 'resumed')
    assert.ok(s.state === 'normal' || s.state === 'busy', `no longer amber (the refused call seconds ago still counts as activity): ${s.state}`)
    assert.equal(await pop(page).locator('.wb-action[data-action="pause"]').count(), 1)
    const again = await api.call(browserId, agent, 'tabs', { action: 'new', url: 'about:blank' })
    assert.equal(again.status, 200, JSON.stringify(again.body))
    assert.ok(again.body.ok)
    s = await openAndWait(page, x => x.snapshot.browsers[0]?.tabs === 1, 'a tab under control again')
    assert.equal(s.state, 'busy')
    assert.equal((await api.status()).browsers[0]!.tabs.filter(t => t.owner === agent.id).length, 1)

    // ---- 5. no secret anywhere the renderer or the logs can see ----
    assert.ok(!JSON.stringify(s.snapshot).includes(apiKey), 'the key never reaches the renderer')
    for (const text of [readFileSync(join(home, 'tether-app.log'), 'utf8'), readFileSync(join(home, 'tetherd.log'), 'utf8'), installLog.join('\n')]) {
      assert.ok(!text.includes(apiKey), 'api key leaked')
      assert.ok(!text.includes(config.pairingToken), 'pairing token leaked')
    }
    const copyDir = 'C:/atrium/.tmp/tether-f7'
    try { mkdirSync(copyDir, { recursive: true }); copyFileSync(join(artifacts, 'web-bridge-pause-paused.png'), join(copyDir, 'web-bridge-pause-paused.png')) } catch { /* optional copy */ }
  } finally {
    if (context) await context.close().catch(() => {})
    if (app) await killElectron(app, root).catch(e => console.error(String(e)))
    for (const d of owned.reverse()) {
      const r = await killOwned(d, { tree: true })
      if (r === 'not-ours') console.error(`cleanup: pid ${d.pid} is no longer ours; not killed`)
    }
    for (const dir of [home, profile]) {
      for (let i = 0; i < 10; i++) { try { rmSync(dir, { recursive: true, force: true }); break } catch { await sleep(500) } }
    }
  }
})
