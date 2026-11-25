// E2E of "Abrir no <navegador> pelo Bridge" in the right-click menu of an http link (link-menu-rules.ts, web-bridge openUrl),
// against the real app and the real tetherd on a private home/pipe (hidden window), with a FAKE bridge daemon (an HTTP server on
// a free port answering /health and /status with the api.key the tetherd wrote in the private home) and a FAKE browser (a .cmd
// that appends its arguments to a file, given through TETHER_WEB_BRIDGE_BROWSERS). The person's browser and Bridge are never
// touched:
//   1. a browser connected: the menu of a printed http link reads system browser, "Abrir no Chrome pelo Bridge", copy; the row
//      launches the connected browser with exactly the address, and nothing goes to the system browser;
//   2. no browser connected: the row is gone;
//   3. the daemon down: the row stays out;
//   4. capture: l5-menu-bridge.png (the menu with the row).
// Every kill goes through test/kill.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { createRequire } from 'node:module'
import { createServer as createNetServer, type Socket } from 'node:net'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type Hooks = {
  panelIds(): string[]
  activate(id: string): void
  activeId(): string | undefined
  connection(): { connected: boolean; pid?: number } | undefined
  text(slotId: string): string
  screenPos(id: string, needle: string): { row: number; col: number } | undefined
  cellSize(id: string): { width: number; height: number } | undefined
  webBridge: { status(): { snapshot: { daemon: string; browsers: { id: string; name: string }[] } } }
}
declare const window: { __tether: Hooks }
declare const document: any

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const shots = process.env.L5_SHOTS_DIR ?? 'C:/atrium/.tmp/tether-agents/onda-3/espiar/l5'
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-linkbridge-${process.pid}`
const TETHER_ROWS = ['Abrir no navegador do tether', 'Abrir ao lado']
const STATUS ='.status-wrap[data-status="web-bridge.status"]'

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

/** The fake bridge daemon: /status answers `state` to the right bearer; `up` false answers nothing but 503. */
interface FakeBridge { server: Server; state: { paused: boolean; browsers: unknown[]; clients: unknown[] }; up: boolean; sockets: Set<Socket>; close(): Promise<void> }
function fakeBridge(port: number, keyFile: () => string | undefined): Promise<FakeBridge> {
  const fake: FakeBridge = {
    server: createServer(), state: { paused: false, browsers: [], clients: [] }, up: true, sockets: new Set(),
    close: () => new Promise(res => { for (const s of fake.sockets) s.destroy(); fake.server.close(() => res()) }),
  }
  fake.server.on('connection', s => { fake.sockets.add(s); s.on('close', () => fake.sockets.delete(s)) })
  fake.server.on('request', (req, res) => {
    const json = (status: number, body: unknown): void => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (!fake.up) { res.destroy(); return }
    const path = req.url ?? '/'
    if (path === '/health') return json(200, { ok: true })
    const key = keyFile()
    if (!key || req.headers.authorization !== `Bearer ${key}`) return json(401, { ok: false, error: 'unauthorized' })
    if (path === '/status') return json(200, { ok: true, ...fake.state })
    json(404, { ok: false })
  })
  return new Promise((res, rej) => { fake.server.on('error', rej); fake.server.listen(port, '127.0.0.1', () => res(fake)) })
}

async function launch(home: string, extra: Record<string, string>): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_') && !k.toUpperCase().startsWith('CLAUDE')) env[k] = v
  Object.assign(env, { TETHER_PIPE: pipe, TETHER_HOME: home, TETHER_E2E_HIDDEN: '1' }, extra)
  delete env.TETHER_CLAUDE_ARGS
  delete env.NODE_TEST_CONTEXT
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10_000)
  page.on('pageerror', e => console.error(`renderer error: ${e.message}`))
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800))
  return { app, page }
}

async function createShell(page: Page, cwd: string): Promise<string> {
  const before = await page.evaluate(() => window.__tether.panelIds())
  await page.click('#btn-new')
  await page.waitForSelector('#dlg-new[open]')
  await page.fill('#dlg-new .ch-path-input', cwd)
  await page.click('#dlg-new .ch-item[data-id="powershell"]')
  await page.click('#dlg-new .btn.primary.go')
  await page.waitForFunction(() => document.querySelectorAll('#dlg-new[open]').length === 0)
  await page.waitForFunction(n => window.__tether.panelIds().length === n, before.length + 1)
  const id = (await page.evaluate(() => window.__tether.panelIds())).find(x => !before.includes(x))!
  await page.waitForFunction(id => /PS .*>/.test(window.__tether.text(id)), id, { timeout: 30_000 })
  return id
}

async function focusPane(page: Page, id: string): Promise<void> {
  await page.evaluate(id => window.__tether.activate(id), id)
  await page.locator(`.panel[data-slot-id="${id}"] .panel-term`).click()
  await page.waitForFunction(id => window.__tether.activeId() === id, id)
}

/** Prints `parts` joined (the typed command never holds the printed text) and waits for it on the screen. */
async function print(page: Page, id: string, ...parts: string[]): Promise<string> {
  const printed = parts.join('')
  await page.keyboard.type(`Write-Output (${parts.map(p => `'${p}'`).join('+')})`)
  await page.keyboard.press('Enter')
  await page.waitForFunction(([id, needle]) => window.__tether.screenPos(id!, needle!) !== undefined, [id, printed] as [string, string])
  return printed
}

async function pointOf(page: Page, id: string, needle: string, offset = 2): Promise<{ x: number; y: number }> {
  const pos = await page.evaluate(([id, n]) => window.__tether.screenPos(id!, n!), [id, needle])
  assert.ok(pos, `${needle} is on screen`)
  const cell = (await page.evaluate(id => window.__tether.cellSize(id), id))!
  const box = (await page.locator(`.panel[data-slot-id="${id}"] .xterm-screen`).boundingBox())!
  return { x: box.x + (pos.col + offset + 0.5) * cell.width, y: box.y + (pos.row + 0.5) * cell.height }
}

async function over(page: Page, p: { x: number; y: number }): Promise<void> {
  await page.mouse.move(5, 5)
  await page.mouse.move(p.x, p.y, { steps: 3 })
  await sleep(300)
  await page.mouse.move(p.x + 10, p.y); await sleep(100); await page.mouse.move(p.x, p.y)
  await sleep(400)
}

const menuRows = (page: Page): Promise<string[]> => page.evaluate(() => {
  const out: string[] = []
  for (const li of document.querySelectorAll('#ctx-menu > li') as any[]) {
    if (li.classList.contains('sep')) { out.push('-'); continue }
    const label = [...li.childNodes].filter((n: any) => n.nodeType === 3).map((n: any) => n.textContent).join('')
    const hint = li.querySelector('kbd')?.textContent
    out.push(hint ? `${label} [${hint}]` : label)
  }
  return out
})
async function rightClick(page: Page, p: { x: number; y: number }): Promise<string[]> {
  await over(page, p)
  await page.mouse.click(p.x, p.y, { button: 'right' })
  await page.waitForSelector('#ctx-menu')
  return menuRows(page)
}
async function closeMenu(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => document.getElementById('ctx-menu') === null)
  await page.mouse.move(5, 5)
}

/** Opens and closes the status popover (it polls at once), until the snapshot satisfies `cond`. */
async function snapshotUntil(page: Page, cond: (s: { daemon: string; browsers: unknown[] }) => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 20_000
  for (;;) {
    const s = (await page.evaluate(() => window.__tether.webBridge.status())).snapshot
    if (cond(s)) break
    if (Date.now() > deadline) throw new Error(`${what}: ${JSON.stringify(s)}`)
    await page.locator(`${STATUS} .status-btn`).click()
    await sleep(700)
    await page.keyboard.press('Escape')
    await sleep(300)
  }
  if (await page.locator(`${STATUS} .status-pop`).isVisible()) { await page.keyboard.press('Escape'); await sleep(200) }
}

test('menu de link http: "Abrir no Chrome pelo Bridge" só com navegador conectado; abre o navegador conectado com o endereço', { timeout: 300_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(shots, { recursive: true })
  mkdirSync(tmpdir(), { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-linkbridge-'))
  const base = mkdtempSync(join(tmpdir(), 'tether-lb-files-'))
  const port = await freePort()
  const keyFile = (): string | undefined => { try { return readFileSync(join(home, 'bridge', 'api.key'), 'utf8').trim() || undefined } catch { return undefined } }
  const fakeExe = join(home, 'fake-chrome.cmd')
  const argsFile = join(home, 'browser-args.txt')
  writeFileSync(fakeExe, `@echo %* >> "${argsFile}"\r\n`)
  const browsersJson = join(home, 'browsers.json')
  writeFileSync(browsersJson, JSON.stringify([{ id: 'chrome', name: 'Chrome de teste', exe: fakeExe }]))
  const fake = await fakeBridge(port, keyFile)
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home, { TETHER_BRIDGE_PORT: String(port), TETHER_WEB_BRIDGE_BROWSERS: browsersJson }))
    daemons.push(await claim((await page.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    const external: string[] = []
    await app.evaluate(({ shell }) => { (globalThis as any).__external = []; shell.openExternal = async (u: string) => { (globalThis as any).__external.push(u) } })

    const host = await createShell(page, base)
    await focusPane(page, host)
    const url = await print(page, host, 'http://local', `host:${port}/l5/pagina`)

    // ---- 1. a browser connected ----
    console.log('step 1')
    fake.state.browsers = [{ id: 'b1', name: 'Chrome', userAgent: 'Mozilla/5.0 Chrome/130', connectedAt: Date.now() - 60_000, active: true, policy: { source: 'config' }, tabs: [] }]
    await snapshotUntil(page, s => s.daemon === 'up' && s.browsers.length === 1, 'one browser connected')
    await focusPane(page, host)
    const rows = await rightClick(page, await pointOf(page, host, url))
    assert.deepEqual(rows, ['Abrir no navegador do sistema [Ctrl+clique]', ...TETHER_ROWS, 'Abrir no Chrome pelo Bridge', '-', 'Copiar link'])
    await sleep(300)
    await page.screenshot({ path: join(shots, 'l5-menu-bridge.png') })
    await page.locator('#ctx-menu li', { hasText: 'pelo Bridge' }).first().click()
    for (let i = 0; i < 50 && !existsSync(argsFile); i++) await sleep(100)
    await sleep(300)
    assert.equal(readFileSync(argsFile, 'utf8').trim(), url, 'the connected browser got exactly the address')
    external.push(...await app.evaluate(() => (globalThis as any).__external as string[]))
    assert.deepEqual(external, [], 'nothing went to the system browser')

    // ---- 2. no browser connected ----
    console.log('step 2')
    fake.state.browsers = []
    await snapshotUntil(page, s => s.daemon === 'up' && s.browsers.length === 0, 'no browser')
    await focusPane(page, host)
    assert.deepEqual(await rightClick(page, await pointOf(page, host, url)), ['Abrir no navegador do sistema [Ctrl+clique]', ...TETHER_ROWS, '-', 'Copiar link'])
    await closeMenu(page)

    // ---- 3. the daemon down ----
    console.log('step 3')
    fake.state.browsers = [{ id: 'b1', name: 'Chrome', userAgent: 'Mozilla/5.0 Chrome/130', active: true, tabs: [] }]
    fake.up = false
    await snapshotUntil(page, s => s.daemon !== 'up', 'daemon down')
    await focusPane(page, host)
    assert.deepEqual(await rightClick(page, await pointOf(page, host, url)), ['Abrir no navegador do sistema [Ctrl+clique]', ...TETHER_ROWS, '-', 'Copiar link'])
    await closeMenu(page)
  } finally {
    if (app) await killElectron(app, root).catch(e => console.error(String(e)))
    for (const d of daemons) {
      const r = await killOwned(d, { tree: true })
      if (r === 'not-ours') console.error(`tetherd cleanup: pid ${d.pid} is no longer ours; not killed`)
    }
    await fake.close()
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && daemons.some(d => pidAlive(d.pid))) await sleep(200)
    for (const dir of [home, base]) for (let i = 0; i < 5; i++) {
      try { rmSync(dir, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
  }
})
