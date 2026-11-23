// E2E of the Tether Bridge status icon (F7 slice C4) against the real app and the real tetherd on a private home/pipe
// (hidden window), with a FAKE bridge daemon: an HTTP server on a free port that answers /health, /status (bearer = the
// api.key the tetherd created in the private home), /pause, /resume and /clients/:id/release, driven by the test:
//   1. no browser → grey icon, no badge, tooltip "nenhum navegador conectado · Instalar…";
//   2. two browsers → badge 2, "Chrome, Edge conectados"; the popover lists them with their tabs under control;
//   3. an agent (`tether:<slotId>` of a pane) called 3 s ago → busy dot, "<agent> está usando o navegador"; the popover
//      lists it with tool and time; clicking it brings its pane to the front; the busy state ends by itself after 10 s;
//   4. Pausar → POST /pause → amber "Tether Bridge pausado" and the button turns into Retomar → POST /resume;
//      a daemon answering 404 → "indisponível nesta versão" and the button disabled;
//   5. Retomar todas as abas → one release per client; Instalar em outro navegador… opens the picker;
//      Opções da extensão opens chrome-extension://<id>/options.html in the (fake) browser;
//   6. the daemon dies → red "O daemon do bridge caiu…";
//   7. the poll: ≥2 /status within 5 s while the popover is open, the key never in the snapshot;
//   8. screenshots web-bridge-status-{light,dark}.png (icon + badge + open popover).
// Every kill goes through test/kill.ts (pid + identity). The person's tether (%LOCALAPPDATA%\tether, port 47831) is never touched.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { createRequire } from 'node:module'
import { createServer as createNetServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type Snapshot = { daemon: string; everUp: boolean; paused: boolean; pauseSupported: boolean; browsers: { id: string; name: string; tabs: number }[]; agents: { clientId: string; slotId?: string; name: string; tabs: number; lastTool?: string }[]; version: { vendored?: string; installed?: string; pendingReload: boolean }; options?: { browserName: string } }
type Status = { snapshot: Snapshot; state: string; badge: number | 'dot' | undefined; title: string; watching: boolean }
declare const window: { __tether: { runCommand(id: string): Promise<string>; connection(): { pid?: number } | undefined; panelIds(): string[]; activeId(): string | undefined; webBridge: { status(): Status } } }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const artifacts = join(root, 'test', 'e2e', 'artifacts')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const pipe = `\\\\.\\pipe\\tether-wb-status-${process.pid}`
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const vendorDir = join(root, 'extensions', 'web-bridge', 'vendor')
const STATUS = '.status-wrap[data-status="web-bridge.status"]'

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}
function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createNetServer()
    s.on('error', rej)
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)) })
  })
}

/** The fake bridge daemon: what /status says is `state`; every request is recorded. */
interface FakeBridge {
  server: Server
  state: { paused: boolean; browsers: unknown[]; clients: unknown[] }
  pauseStatus: number
  calls: { method: string; path: string; auth?: string }[]
  sockets: Set<Socket>
  close(): Promise<void>
}
function fakeBridge(port: number, keyFile: () => string | undefined): Promise<FakeBridge> {
  const fake: FakeBridge = {
    server: createServer(), state: { paused: false, browsers: [], clients: [] }, pauseStatus: 200, calls: [], sockets: new Set(),
    close: () => new Promise(res => { for (const s of fake.sockets) s.destroy(); fake.server.close(() => res()) }),
  }
  fake.server.on('connection', s => { fake.sockets.add(s); s.on('close', () => fake.sockets.delete(s)) })
  fake.server.on('request', (req, res) => {
    const path = req.url ?? '/'
    const auth = req.headers.authorization
    fake.calls.push({ method: req.method ?? 'GET', path, ...(auth ? { auth } : {}) })
    const json = (status: number, body: unknown): void => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (path === '/health') return json(200, { ok: true })
    const key = keyFile()
    if (!key || auth !== `Bearer ${key}`) return json(401, { ok: false, error: 'unauthorized' })
    if (path === '/status') return json(200, { ok: true, ...fake.state })
    if (path === '/pause' || path === '/resume') {
      if (fake.pauseStatus !== 200) return json(fake.pauseStatus, { ok: false })
      fake.state.paused = path === '/pause'
      return json(200, { ok: true, paused: fake.state.paused })
    }
    const act = /^\/browsers\/([^/]+)\/activate$/.exec(path)
    if (act) {
      const id = decodeURIComponent(act[1]!)
      const list = fake.state.browsers as { id: string; active?: boolean }[]
      if (!list.some(b => b.id === id)) return json(404, { ok: false })
      for (const b of list) b.active = b.id === id
      return json(200, { ok: true, activeBrowserId: id })
    }
    if (/^\/browsers\/[^/]+\/tabs\/[^/]+\/focus$/.test(path)) return json(200, { ok: true })
    const m = /^\/clients\/([^/]+)\/release$/.exec(path)
    if (m) {
      const id = decodeURIComponent(m[1]!)
      fake.state.clients = fake.state.clients.filter(c => (c as { id: string }).id !== id)
      for (const b of fake.state.browsers as { tabs: { owner?: string }[] }[]) b.tabs = b.tabs.filter(t => t.owner !== id)
      return json(200, { ok: true })
    }
    json(404, { ok: false })
  })
  return new Promise((res, rej) => { fake.server.on('error', rej); fake.server.listen(port, '127.0.0.1', () => res(fake)) })
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

async function setTheme(page: Page, scheme: 'light' | 'dark'): Promise<void> {
  await page.click('#btn-theme')
  await page.waitForSelector('#theme-menu:not([hidden])')
  await page.click(`#theme-menu li[data-theme="${scheme}"]`)
  await page.waitForFunction(s => (document as unknown as { documentElement: { dataset: Record<string, string> } }).documentElement.dataset.theme === s, scheme)
  await sleep(300)
}

async function shotWindowTop(app: ElectronApplication, name: string): Promise<void> {
  const b64 = await app.evaluate(async ({ BrowserWindow }) => {
    const img = await BrowserWindow.getAllWindows()[0]!.webContents.capturePage({ x: 740, y: 0, width: 540, height: 460 })
    return img.toPNG().toString('base64')
  })
  writeFileSync(join(artifacts, `${name}.png`), Buffer.from(b64, 'base64'))
}

const status = (page: Page): Promise<Status> => page.evaluate(() => window.__tether.webBridge.status())
const pop = (page: Page) => page.locator(`${STATUS} .status-pop`)
const btn = (page: Page) => page.locator(`${STATUS} .status-btn`)
/** Opens the first browser's "⋯" menu and clicks one entry (the menu closes after the click). */
async function menuAction(page: Page, action: string): Promise<void> {
  await pop(page).locator('.wb-browser [data-action="browser-menu"]').first().click()
  await pop(page).locator(`.wb-menu .wb-action[data-action="${action}"]`).click()
}
const menuEntry = async (page: Page, action: string) => { await pop(page).locator('.wb-browser [data-action="browser-menu"]').first().click(); return pop(page).locator(`.wb-menu .wb-action[data-action="${action}"]`) }

/** Opens the popover (which polls at once) unless open, then waits for `cond` on the hook. */
async function openAndWait(page: Page, cond: (s: Status) => boolean, what: string): Promise<Status> {
  if (!(await pop(page).isVisible())) { await btn(page).click(); await pop(page).waitFor() }
  const deadline = Date.now() + 15_000
  for (;;) {
    const s = await status(page)
    if (cond(s)) return s
    if (Date.now() > deadline) throw new Error(`${what}: ${JSON.stringify(s)}`)
    await sleep(150)
  }
}
async function closePop(page: Page): Promise<void> {
  if (await pop(page).isVisible()) { await page.mouse.click(400, 500); await pop(page).waitFor({ state: 'hidden' }) }
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

test('web-bridge: status icon, popover, Pausar/Retomar, release, foco no painel (F7 C4)', async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(artifacts, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-wb-status-'))
  const port = await freePort()
  const bridgeHome = join(home, 'bridge')
  const keyFile = (): string | undefined => { try { return readFileSync(join(bridgeHome, 'api.key'), 'utf8').trim() || undefined } catch { return undefined } }
  const fakeExe = join(home, 'fake-chrome.cmd')
  const argsFile = join(home, 'browser-args.txt')
  writeFileSync(fakeExe, `@echo %* >> "${argsFile}"\r\n`)
  const browsersJson = join(home, 'browsers.json')
  writeFileSync(browsersJson, JSON.stringify([{ id: 'chrome', name: 'Chrome de teste', exe: fakeExe }]))
  const expectedId = (JSON.parse(readFileSync(join(vendorDir, 'build-info.json'), 'utf8')) as { extensionId: string; version: string })
  const vendoredVersion = (JSON.parse(readFileSync(join(vendorDir, 'extension', 'manifest.json'), 'utf8')) as { version: string }).version
  const fake = await fakeBridge(port, keyFile)

  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home, { TETHER_BRIDGE_PORT: String(port), TETHER_WEB_BRIDGE_BROWSERS: browsersJson }))
    const daemonPid = (await page.evaluate(() => window.__tether.connection()))?.pid
    assert.ok(daemonPid && pidAlive(daemonPid), 'the app spawned a tetherd')
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))

    // ---- 1. no browser: grey, no badge ----
    await page.locator(STATUS).waitFor()
    let s = await openAndWait(page, x => x.snapshot.daemon === 'up', 'daemon up')
    assert.equal(s.state, 'idle')
    assert.equal(s.badge, undefined)
    assert.equal(s.title, 'Tether Bridge: nenhum navegador conectado · Instalar…')
    assert.equal(await btn(page).getAttribute('data-state'), 'idle')
    assert.equal(await btn(page).getAttribute('title'), s.title)
    assert.equal(await page.locator(`${STATUS} .status-badge`).isHidden(), true)
    assert.equal(await pop(page).locator('[data-section="browsers"] .wb-empty').textContent(), 'Nenhum navegador conectado.')
    assert.equal(await pop(page).locator('.wb-version, .wb-reload, .wb-actions').count(), 0, 'no global version line, reload warning or action row')
    assert.equal(await pop(page).locator('[data-section="browsers"] [data-action="install"]').count(), 1, 'Instalar em outro navegador… closes Navegadores')
    assert.equal(await pop(page).locator('[data-action="release-all"]').count(), 0, 'no live agent: no Soltar todas')
    assert.ok(s.watching, 'the open popover is watched')
    const key = keyFile()
    assert.ok(key && key.length >= 16, 'the tetherd created api.key')
    assert.ok(fake.calls.some(c => c.path === '/status' && c.auth === `Bearer ${key}`), 'main sends the api.key as bearer')
    assert.ok(!JSON.stringify(s.snapshot).includes(key), 'the key never reaches the renderer')

    // ---- 7a. cadence while open: ≥2 /status in 5 s ----
    const n0 = fake.calls.filter(c => c.path === '/status').length
    await sleep(5000)
    assert.ok(fake.calls.filter(c => c.path === '/status').length - n0 >= 2, 'polls every 2 s while the popover is open')
    await closePop(page)
    await page.waitForFunction(() => !window.__tether.webBridge.status().watching)
    const n1 = fake.calls.filter(c => c.path === '/status').length
    await sleep(4000)
    assert.ok(fake.calls.filter(c => c.path === '/status').length - n1 <= 1, 'closed: the slow cadence')

    // ---- 2. two browsers ----
    const paneA = await openShell(page, root)
    const paneB = await openShell(page, root)
    assert.equal(await page.evaluate(() => window.__tether.activeId()), paneB)
    const clientA = `tether:${paneA}`
    fake.state.browsers = [
      { id: 'b1', name: 'Chrome', userAgent: 'Mozilla/5.0 Chrome/130', connectedAt: Date.now() - 120_000, lastFocusedAt: Date.now() - 30_000, active: true, extensionVersion: vendoredVersion, debug: { on: false, callTimeoutMs: null },
        policy: { source: 'extension', evaluate: 'own-tabs', evaluateHandedTabs: false, upload: true, download: true, pdf: true, readNetwork: true, windowPerAgent: true },
        tabs: [{ id: 1, windowId: 3, url: 'https://a', title: 'GitHub – PR #42', owner: clientA }, { id: 2, windowId: 3, url: 'https://b' }] },
      { id: 'b2', name: 'Chrome', userAgent: 'Mozilla/5.0 Chrome/130 Edg/130', connectedAt: Date.now() - 5000, active: false, policy: { source: 'config' }, tabs: [] },
    ]
    s = await openAndWait(page, x => x.snapshot.browsers.length === 2, 'two browsers')
    assert.equal(s.state, 'normal')
    assert.equal(s.badge, 2)
    assert.equal(s.title, 'Chrome, Edge conectados')
    assert.equal(await page.locator(`${STATUS} .status-badge`).textContent(), '2')
    const rows = pop(page).locator('[data-section="browsers"] .wb-browser')
    assert.equal(await rows.count(), 2)
    assert.equal(await rows.nth(0).locator('.wb-name').textContent(), 'Chrome')
    assert.ok(await rows.nth(0).locator('input[type="radio"]').isChecked(), 'the active browser is the checked radio')
    assert.equal(await rows.nth(0).locator('.wb-marks').textContent(), `JS ✓ · v${vendoredVersion}`)
    assert.equal(await rows.nth(0).locator('.wb-go').count(), 1, 'a tab under control: the arrow focuses the window')
    assert.equal(await rows.nth(1).locator('.wb-name').textContent(), 'Edge')
    assert.match((await rows.nth(1).locator('.wb-alert-text').textContent()) ?? '', /desatualizada/)
    assert.equal(await rows.nth(1).locator('.wb-action[data-action="extension-page"]').count(), 1)
    assert.equal(await rows.nth(1).locator('.wb-go').count(), 0, 'no tab: no arrow')
    // The debug mode: the browser's "dev" mark (amber icon), no global banner.
    ;(fake.state.browsers[0] as { debug: unknown }).debug = { on: true, callTimeoutMs: null }
    s = await openAndWait(page, x => x.state === 'warn', 'debug on: amber')
    assert.equal(await rows.nth(0).locator('.wb-marks').textContent(), `JS ✓ · dev ● · v${vendoredVersion}`, 'the debug mode is the browser\'s "dev" mark')
    assert.equal(await pop(page).locator('.wb-debug').count(), 0, 'no global debug banner')
    ;(fake.state.browsers[0] as { debug: unknown }).debug = { on: false, callTimeoutMs: null }
    s = await openAndWait(page, x => x.state === 'normal', 'debug off: normal')
    assert.equal(await pop(page).locator('[data-section="agents"] .wb-empty').textContent(), 'Nenhum agente usando o navegador agora')
    // The radio activates at once.
    await rows.nth(1).locator('input[type="radio"]').check()
    s = await openAndWait(page, x => (x.snapshot.browsers as { id: string; active?: boolean }[]).find(b => b.id === 'b2')?.active === true, 'Edge active')
    assert.ok(fake.calls.some(c => c.method === 'POST' && c.path === '/browsers/b2/activate'), 'POST /browsers/b2/activate')
    await pop(page).locator('[data-section="browsers"] .wb-browser[data-browser="b1"] input[type="radio"]').check()
    s = await openAndWait(page, x => (x.snapshot.browsers as { id: string; active?: boolean }[]).find(b => b.id === 'b1')?.active === true, 'Chrome active again')
    // The arrow of a browser focuses one of its tabs.
    await pop(page).locator('[data-section="browsers"] .wb-browser[data-browser="b1"] .wb-go').click()
    for (let i = 0; i < 20 && !fake.calls.some(c => c.path === '/browsers/b1/tabs/1/focus'); i++) await sleep(100)
    assert.ok(fake.calls.some(c => c.method === 'POST' && c.path === '/browsers/b1/tabs/1/focus'), 'POST focus on a tab of the browser')

    // ---- 3. a busy agent; click → its pane ----
    fake.state.clients = [
      { id: clientA, name: 'Claude · teste', lastTool: 'navigate', lastSeenAt: Date.now() - 3000, calls: 4, live: true, browserId: 'b1' },
      { id: 'tether:antigo', name: 'Antigo', lastTool: 'snapshot', lastSeenAt: Date.now() - 600_000, calls: 2, live: false, browserId: 'b2' },
    ]
    s = await openAndWait(page, x => x.state === 'busy', 'busy')
    assert.equal(s.badge, 'dot')
    assert.equal(s.title, 'Claude · teste está usando o navegador')
    assert.equal(await page.locator(`${STATUS} .status-badge.dot`).count(), 1)
    assert.equal(await btn(page).getAttribute('data-state'), 'busy')
    const agentRow = pop(page).locator(`[data-section="agents"] .wb-agent[data-slot="${paneA}"]`)
    assert.equal(await agentRow.count(), 1)
    assert.ok(await agentRow.evaluate(el => el.classList.contains('active')))
    assert.equal(await agentRow.locator('.wb-name').textContent(), 'Claude · teste')
    assert.equal(await agentRow.locator('.wb-tab').textContent(), '"GitHub – PR #42"')
    const groups = pop(page).locator('[data-section="agents"] .wb-group')
    assert.equal(await groups.count(), 1, 'only live agents; Edge has none, so no group for it')
    assert.equal(await groups.nth(0).locator('.wb-group-label').textContent(), 'Chrome')
    await agentRow.locator('.wb-go').click()
    for (let i = 0; i < 20 && !fake.calls.some(c => c.path === '/browsers/b1/tabs/1/focus' && c.method === 'POST'); i++) await sleep(100)
    assert.ok(fake.calls.filter(c => c.method === 'POST' && c.path === '/browsers/b1/tabs/1/focus').length >= 2, 'the agent\'s arrow focuses its tab')

    // Screenshots with the icon busy, badge dot and the popover open.
    for (const scheme of ['light', 'dark'] as const) {
      await closePop(page)
      await setTheme(page, scheme)
      fake.state.clients = [{ id: clientA, name: 'Claude · teste', lastTool: 'navigate', lastSeenAt: Date.now() - 1000, calls: 4, live: true, browserId: 'b1' }]
      await openAndWait(page, x => x.state === 'busy', `busy for the ${scheme} shot`)
      await page.mouse.move(100, 600)
      await sleep(200)
      await shotWindowTop(app, `web-bridge-status-${scheme}`)
    }

    await agentRow.locator('.wb-who').click()
    await page.waitForFunction(id => window.__tether.activeId() === id, paneA)
    assert.equal(await page.evaluate(() => window.__tether.activeId()), paneA, 'clicking the agent brings its pane to the front')

    // The busy window closes by itself (no newer call): normal with the browser count, after 10 s.
    fake.state.clients = [{ id: clientA, name: 'Claude · teste', lastTool: 'navigate', lastSeenAt: Date.now() - 9000, calls: 4, live: true, browserId: 'b1' }]
    s = await openAndWait(page, x => x.state === 'normal' && x.snapshot.agents.length === 1, 'busy ends after 10 s')
    assert.equal(s.badge, 2)
    assert.equal(await btn(page).getAttribute('data-state'), 'normal')

    // ---- 4. Pausar / Retomar ----
    await menuAction(page, "pause")
    s = await openAndWait(page, x => x.snapshot.paused, 'paused')
    assert.ok(fake.calls.some(c => c.method === 'POST' && c.path === '/pause'), 'POST /pause')
    assert.equal(s.state, 'warn')
    assert.equal(s.title, 'Tether Bridge pausado')
    assert.equal(await btn(page).getAttribute('data-state'), 'warn')
    await pop(page).locator('.wb-browser [data-action="browser-menu"]').first().click()
    assert.equal(await pop(page).locator('.wb-menu .wb-action[data-action="pause"]').count(), 0)
    assert.equal(await pop(page).locator('.wb-menu .wb-action[data-action="resume"]').count(), 1, 'paused: the menu offers Retomar')
    await pop(page).locator('.wb-browser [data-action="browser-menu"]').first().click()
    assert.equal(await pop(page).locator('.wb-notice.ok').textContent(), 'Tether Bridge pausado: os agentes esperam.')
    await menuAction(page, "resume")
    s = await openAndWait(page, x => !x.snapshot.paused, 'resumed')
    assert.ok(fake.calls.some(c => c.method === 'POST' && c.path === '/resume'), 'POST /resume')
    assert.equal(s.state, 'normal')
    // An older daemon: 404.
    fake.pauseStatus = 404
    await menuAction(page, "pause")
    await pop(page).locator('.wb-notice.warn').waitFor()
    assert.match((await pop(page).locator('.wb-notice.warn').textContent()) ?? '', /indisponível nesta versão/)
    s = await openAndWait(page, x => !x.snapshot.pauseSupported, 'pause unsupported remembered')
    assert.ok(await (await menuEntry(page, 'pause')).isDisabled(), 'Pausar disabled once the daemon said 404')
    assert.equal(await pop(page).locator('.wb-menu .wb-hint').count(), 1, 'the menu says why Pausar is unavailable')
    await pop(page).locator('.wb-browser [data-action="browser-menu"]').first().click()
    fake.pauseStatus = 200

    // ---- 5. Retomar todas as abas, Instalar em outro navegador…, Opções da extensão ----
    await pop(page).locator('.wb-action[data-action="release-all"]').click()
    s = await openAndWait(page, x => x.snapshot.agents.length === 0, 'released')
    assert.deepEqual(fake.calls.filter(c => c.path.endsWith('/release')).map(c => c.path), [`/clients/${encodeURIComponent(clientA)}/release`])
    assert.equal(s.snapshot.browsers[0]!.tabs, 0)
    assert.equal(await pop(page).locator('.wb-action[data-action="release-all"]').count(), 0, 'nothing left to release: the action goes away')

    assert.equal(s.snapshot.options?.browserName, 'Chrome de teste')
    await pop(page).locator('.wb-browser [data-action="browser-menu"]').first().click()
    assert.equal(await pop(page).locator('.wb-menu .wb-action[data-action="options"]').textContent(), 'Opções da extensão')
    await pop(page).locator('.wb-browser [data-action="browser-menu"]').first().click()
    await menuAction(page, "options")
    for (let i = 0; i < 40 && !existsSync(argsFile); i++) await sleep(250)
    assert.ok(existsSync(argsFile), 'the browser was launched')
    assert.match(readFileSync(argsFile, 'utf8'), new RegExp(`chrome-extension://${expectedId.extensionId}/options.html`), "at the extension's own options page")

    await pop(page).locator('[data-section="browsers"] .wb-action[data-action="install"]').click()
    const pick = page.locator('dialog.ask[data-dialog="web-bridge-install"][open]')
    await pick.waitFor()
    assert.equal(await pick.locator('h2').textContent(), 'Em qual navegador?')
    await page.keyboard.press('Escape')
    await pick.waitFor({ state: 'hidden' })

    // ---- 6. the daemon dies: red ----
    await fake.close()
    s = await openAndWait(page, x => x.snapshot.daemon === 'down', 'daemon down')
    assert.equal(s.state, 'error')
    assert.equal(s.badge, undefined)
    assert.equal(s.title, 'O daemon do bridge caiu; a próxima chamada o reinicia')
    assert.equal(await btn(page).getAttribute('data-state'), 'error')
    assert.match((await pop(page).locator('.wb-down').textContent()) ?? '', /parou de responder/)
    assert.equal(await pop(page).locator('.wb-menu-btn').count(), 0, 'daemon down: no browser, no menu')
    await closePop(page)

    // No secret anywhere the renderer or the logs can see.
    const appLog = readFileSync(join(home, 'tether-app.log'), 'utf8')
    assert.ok(!appLog.includes(key), 'no api.key in tether-app.log')
    for (const name of ['web-bridge-status-light.png', 'web-bridge-status-dark.png']) assert.ok(existsSync(join(artifacts, name)))
    const copyDir = 'C:/atrium/.tmp/tether-c4'
    try { mkdirSync(copyDir, { recursive: true }); for (const name of ['web-bridge-status-light.png', 'web-bridge-status-dark.png']) copyFileSync(join(artifacts, name), join(copyDir, name)) } catch { /* optional copy */ }
  } finally {
    await fake.close().catch(() => undefined)
    if (app) await killElectron(app, root).catch(e => console.error(String(e)))
    for (const d of daemons) {
      const r = await killOwned(d, { tree: true })
      if (r === 'not-ours') console.error(`cleanup: pid ${d.pid} is no longer ours; not killed`)
    }
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && daemons.some(d => pidAlive(d.pid))) await sleep(200)
    for (let i = 0; i < 5; i++) {
      try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
  }
})
