// E2E of "Instalar Tether Bridge…" (F7 slice C1) against the real app, the real tetherd on a private home/pipe (hidden
// window), the REAL vendored bridge daemon on a free test port, a fake browser (a .cmd that records its arguments) and,
// as the browser that connects, Playwright's Chromium loading the installed folder with --load-extension:
//   1. the command opens "Em qual navegador?" listing the fake browser (TETHER_WEB_BRIDGE_BROWSERS); "Preparar e abrir";
//   2. the guide opens: the fixed folder <home>/web-bridge/current is shown, is in the clipboard ("Copiar de novo" puts it
//      back), the fake browser was launched with chrome://extensions, bridge.json/config.json/api.key/daemon.pid exist,
//      /health answers on the test port, the pairing token and the api key appear nowhere in tether-app.log;
//   3. screenshots web-bridge-guide-{light,dark}.png;
//   4. Chromium loads the folder, the extension reads its seed and connects: the guide says "conectado" and closes by itself;
//   5. the extension wears the tether's brand (F7 T3): the popup is titled "Tether Bridge" with the logo, the loaded manifest
//      names it and carries the icons derived from brand/src (screenshot web-bridge-popup.png).
// Every kill goes through test/kill.ts (pid + identity); the bridge daemon is killed by its daemon.pid only if its
// command line names the vendored bundle. The person's bridge (~/.atrium-bridge, %LOCALAPPDATA%\tether) is never touched.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, chromium, type BrowserContext, type ElectronApplication, type Page } from 'playwright-core'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type Guide = { open: boolean; state?: string; path?: string; browser?: string; connected?: string[] }
declare const window: { __tether: { runCommand(id: string): Promise<string>; connection(): { pid?: number } | undefined; webBridge: { guide(): Guide } } }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const artifacts = join(root, 'test', 'e2e', 'artifacts')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const pipe = `\\\\.\\pipe\\tether-web-bridge-${process.pid}`
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

async function launch(home: string, extra: Record<string, string>): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_') && !/^(CLAUDE|TETHER_|ATRIUM_)/i.test(k)) env[k] = v
  Object.assign(env, { TETHER_PIPE: pipe, TETHER_HOME: home, TETHER_E2E_HIDDEN: '1' }, extra)
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10_000)
  page.on('pageerror', e => console.error(`renderer error: ${e.message}`))
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800))
  return { app, page }
}

/** The native menu's theme item: it works with a modal dialog open (the ≡ menu is under the backdrop). */
async function setTheme(app: ElectronApplication, page: Page, scheme: 'light' | 'dark'): Promise<void> {
  await app.evaluate(({ Menu }, id) => { Menu.getApplicationMenu()?.getMenuItemById(id)?.click() }, `theme-${scheme}`)
  await page.waitForFunction(s => (document as unknown as { documentElement: { dataset: Record<string, string> } }).documentElement.dataset.theme === s, scheme)
  await sleep(300)
}

async function shot(app: ElectronApplication, name: string): Promise<void> {
  const b64 = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG().toString('base64'))
  writeFileSync(join(artifacts, `${name}.png`), Buffer.from(b64, 'base64'))
}

/** A Chromium build (not the branded Chrome: it refuses --load-extension since 137): CHROME_PATH, Playwright's, or the bridge tests' golden copy. */
function findChromium(): string | undefined {
  const candidates = [process.env.CHROME_PATH, chromium.executablePath(), 'D:/atrium/.tmp/atrium-browser-e7a/golden/browsers/chromium-1243/chrome-win64/chrome.exe']
  return candidates.find((c): c is string => !!c && existsSync(c))
}

const guide = (page: Page): Promise<Guide> => page.evaluate(() => window.__tether.webBridge.guide())
const clipboard = (app: ElectronApplication): Promise<string> => app.evaluate(({ clipboard }) => clipboard.readText())

test('web-bridge: Instalar Tether Bridge… prepares the folder, opens the browser, guides, and closes when Chromium connects (F7 C1)', async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(artifacts, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-web-bridge-'))
  const port = await freePort()
  const bridgeHome = join(home, 'bridge')
  const current = join(home, 'web-bridge', 'current')
  // The fake browser: a .cmd that appends its arguments next to itself and exits.
  const fakeExe = join(home, 'fake-chrome.cmd')
  const argsFile = join(home, 'browser-args.txt')
  writeFileSync(fakeExe, `@echo %* >> "${argsFile}"\r\n`)
  const browsersJson = join(home, 'browsers.json')
  writeFileSync(browsersJson, JSON.stringify([{ id: 'chrome', name: 'Chrome de teste', exe: fakeExe }]))
  const expectedId = (JSON.parse(readFileSync(join(vendorDir, 'build-info.json'), 'utf8')) as { extensionId: string }).extensionId

  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  let context: BrowserContext | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home, { TETHER_BRIDGE_PORT: String(port), TETHER_WEB_BRIDGE_BROWSERS: browsersJson }))
    const daemonPid = (await page.evaluate(() => window.__tether.connection()))?.pid
    assert.ok(daemonPid && pidAlive(daemonPid), 'the app spawned a tetherd')
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))

    // 1. The picker lists the fake browser.
    await app.evaluate(({ clipboard }) => clipboard.writeText('(nada)'))
    void page.evaluate(() => window.__tether.runCommand('web-bridge.install'))
    const pick = page.locator('dialog.ask[data-dialog="web-bridge-install"][open]')
    await pick.waitFor()
    assert.equal(await pick.locator('h2').textContent(), 'Em qual navegador?')
    assert.equal(await pick.locator('.option[data-option="chrome"] .o-label').textContent(), 'Chrome de teste')
    assert.ok(await pick.locator('.option[data-option="chrome"] input').isChecked())
    await pick.locator('button.choice[data-choice="install"]').click()

    // 2. The guide: path, clipboard, browser launched, files, daemon up, no secret in the log.
    const dlg = page.locator('dialog.ask[data-dialog="web-bridge-guide"][open]')
    await dlg.waitFor({ timeout: 40_000 })
    let g = await guide(page)
    assert.equal(g.open, true)
    assert.equal(g.path, current)
    assert.equal(g.browser, 'Chrome de teste')
    assert.equal(await dlg.locator('.wb-path-text').textContent(), current)
    assert.equal(await dlg.locator('.wb-steps li').count(), 3)
    assert.equal(await clipboard(app), current, 'the path is in the clipboard')
    await app.evaluate(({ clipboard }) => clipboard.writeText('(apagado)'))
    await dlg.locator('.wb-copy').click()
    assert.equal(await clipboard(app), current, '"Copiar de novo" puts it back')
    for (let i = 0; i < 20 && !existsSync(argsFile); i++) await sleep(250)
    assert.match(readFileSync(argsFile, 'utf8'), /chrome:\/\/extensions/, 'the browser was opened at its extensions page')

    const seed = JSON.parse(readFileSync(join(current, 'bridge.json'), 'utf8')) as { port: number; token: string; host?: string }
    assert.equal(seed.port, port)
    assert.equal(seed.host, 'Tether')
    const config = JSON.parse(readFileSync(join(bridgeHome, 'config.json'), 'utf8')) as { extensionIds: string[]; brand?: { name: string } }
    assert.deepEqual(config.extensionIds, [expectedId])
    assert.equal(config.brand?.name, 'Tether')
    const apiKey = readFileSync(join(bridgeHome, 'api.key'), 'utf8').trim()
    assert.ok(apiKey.length >= 16)
    assert.ok(existsSync(join(current, 'manifest.json')), 'the extension was copied')
    const health = await fetch(`http://127.0.0.1:${port}/health`).then(r => r.ok, () => false)
    assert.equal(health, true, 'the bridge daemon answers on the test port')
    const bridgePid = Number(readFileSync(join(bridgeHome, 'daemon.pid'), 'utf8').trim())
    assert.ok(bridgePid && pidAlive(bridgePid), 'daemon.pid names a live process')
    daemons.push(await claim(bridgePid, { cmdIncludes: 'atrium-bridge.mjs', what: 'bridge daemon' }))
    await page.waitForFunction(() => window.__tether.webBridge.guide().state === 'waiting')
    const appLog = readFileSync(join(home, 'tether-app.log'), 'utf8')
    assert.ok(appLog.includes('web-bridge') && appLog.includes('extensão copiada'), 'main logged the install')
    assert.ok(!appLog.includes(seed.token) && !appLog.includes(apiKey), 'no secret in tether-app.log')

    // 3. Screenshots in both themes.
    await page.mouse.move(5, 5)
    for (const scheme of ['light', 'dark'] as const) {
      await setTheme(app, page, scheme)
      await shot(app, `web-bridge-guide-${scheme}`)
    }

    // 4. A real Chromium loads the installed folder: the extension connects, the guide closes by itself.
    const chrome = findChromium()
    assert.ok(chrome, 'a Chromium that allows --load-extension: CHROME_PATH, the Playwright one, or the golden copy of the bridge tests')
    const profile = mkdtempSync(join(tmpdir(), 'tether-web-bridge-profile-'))
    context = await chromium.launchPersistentContext(profile, {
      executablePath: chrome, headless: true, ignoreDefaultArgs: ['--disable-extensions'],
      args: [`--disable-extensions-except=${current}`, `--load-extension=${current}`],
    })
    await page.waitForFunction(() => window.__tether.webBridge.guide().state === 'connected', undefined, { timeout: 30_000 })
    g = await guide(page)
    assert.ok(g.connected && g.connected.length === 1, `one browser connected: ${JSON.stringify(g.connected)}`)
    assert.match((await dlg.locator('.wb-wait-text').textContent()) ?? '', /Chrome de teste conectado/)
    await shot(app, 'web-bridge-guide-connected-dark')
    await dlg.waitFor({ state: 'detached', timeout: 6000 })
    assert.equal((await guide(page)).open, false)
    const browsers = await fetch(`http://127.0.0.1:${port}/browsers`, { headers: { authorization: `Bearer ${apiKey}` } }).then(r => r.json()) as { browsers: { name: string }[] }
    assert.equal(browsers.browsers.length, 1, 'the daemon lists the Chromium')

    // 5. The brand as the browser shows it: the popup (title from the packed brand, the logo-h in place of the text) and
    //    the manifest Chromium loaded (name, the four derived icons; the 128 is byte for byte brand/assets/bridge's).
    const popup = await context.newPage()
    await popup.setViewportSize({ width: 360, height: 420 })
    await popup.goto(`chrome-extension://${expectedId}/popup.html`)
    await popup.waitForFunction(() => document.title === 'Tether Bridge' && !!document.querySelector('#title img, #title svg'), undefined, { timeout: 15_000 })
    await popup.screenshot({ path: join(artifacts, 'web-bridge-popup.png') })
    assert.equal(await popup.title(), 'Tether Bridge')
    await popup.close()
    const loaded = JSON.parse(readFileSync(join(current, 'manifest.json'), 'utf8')) as { name: string; icons: Record<string, string> }
    assert.equal(loaded.name, 'Tether Bridge')
    assert.deepEqual(loaded.icons, { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' })
    const sha256 = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex')
    assert.equal(sha256(join(current, 'icons', 'icon-128.png')), sha256(join(root, 'brand', 'assets', 'bridge', 'icon-128.png')), 'the icon in the browser is the derived one')
    // chrome://extensions with the card, best effort: a headless build may refuse the page; the popup above is the proof.
    try {
      const ext = await context.newPage()
      await ext.setViewportSize({ width: 1100, height: 700 })
      await ext.goto('chrome://extensions', { timeout: 10_000 })
      await ext.waitForTimeout(1500)
      await ext.screenshot({ path: join(artifacts, 'web-bridge-chrome-extensions.png') })
      await ext.close()
    } catch (e) { console.error(`chrome://extensions screenshot skipped: ${e instanceof Error ? e.message : String(e)}`) }
    await context.close().catch(() => {})
    context = undefined
    rmSync(profile, { recursive: true, force: true })
  } finally {
    if (context) await context.close().catch(() => {})
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
