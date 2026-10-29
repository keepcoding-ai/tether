// E2E of the theme setting (claro / automático / escuro) in the Electron app, against the real tetherd on a
// private home/pipe, hidden window:
//   1. two shell panels with colored output (Write-Host) → "Escuro" through the menu → chrome, dockview
//      and every xterm are dark; settings.json remembers it; screenshot;
//   2. "Claro" through the toolbar select → everything light, BrowserWindow background light; screenshot;
//   3. "Automático" through the menu → the scheme is whatever Electron reports for the OS right now
//      (nativeTheme.shouldUseDarkColors; the OS itself cannot be faked from here);
//   4. "Escuro" again → window killed by PID → relaunch → comes up dark with the radio/select in sync.
// Every kill goes through pid-guard.ts: only processes provably spawned by this test are killed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { killOwned, processInfo, type KillGuard } from './pid-guard.ts'

type ThemeState = { setting: 'light' | 'auto' | 'dark'; scheme: 'light' | 'dark' }
type Hooks = {
  panelIds(): string[]
  slots(): SlotState[]
  text(id: string): string
  connection(): { connected: boolean; pid?: number } | undefined
  activate(id: string): void
  theme(): ThemeState
  termTheme(id: string): Record<string, string | undefined> | undefined
}
declare const window: { __tether: Hooks; getComputedStyle(el: unknown): { backgroundColor: string; color: string } }
declare const document: {
  querySelectorAll(selector: string): { length: number }
  querySelector(selector: string): { value?: string } | null
  documentElement: { dataset: Record<string, string | undefined> }
}

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const artifacts = join(root, 'test', 'e2e', 'artifacts')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const pipe = `\\\\.\\pipe\\tether-themetest-${process.pid}`
const startedAt = Date.now()

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise(res => { if (child.exitCode !== null) res(); else child.once('exit', () => res()) })
}

async function launch(home: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_')) env[k] = v
  env.TETHER_PIPE = pipe
  env.TETHER_HOME = home
  env.TETHER_E2E_HIDDEN = '1'
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10_000)
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  return { app, page }
}

/** Kills the Electron main by PID (see app.layout.test.ts for why not app.close()), guarded by pid-guard. */
async function killElectron(app: ElectronApplication, guard: KillGuard): Promise<void> {
  const mainPid = await app.evaluate(() => process.pid)
  const launcher = app.process()
  assert.equal(killOwned(mainPid, guard), 'killed', 'electron main is ours')
  if (launcher.pid && launcher.pid !== mainPid) {
    await Promise.race([waitForExit(launcher), sleep(3000)])
    if (launcher.exitCode === null) killOwned(launcher.pid, guard)
  }
  await waitForExit(launcher)
}

async function createShellPanel(page: Page, cwd: string): Promise<void> {
  const before = await page.locator('.tether-tab').count()
  await page.click('#btn-new')
  await page.waitForSelector('#dlg-new[open]')
  await page.check('input[name=kind][value=shell]')
  await page.fill('#new-cwd', cwd)
  await page.click('#btn-create')
  await page.waitForFunction(n => document.querySelectorAll('.tether-tab').length === n, before + 1)
}

/** Several -ForegroundColor lines plus a dim and a truecolor (Claude's orange) run, in one command. */
const COLORED = [
  'Write-Host vermelho -ForegroundColor Red',
  'Write-Host verde -ForegroundColor Green',
  'Write-Host amarelo -ForegroundColor Yellow',
  'Write-Host azul -ForegroundColor Blue',
  'Write-Host ciano -ForegroundColor Cyan',
  'Write-Host magenta -ForegroundColor Magenta',
  'Write-Host cinza -ForegroundColor DarkGray',
  'Write-Host "$([char]27)[2mtexto dim$([char]27)[0m $([char]27)[1mnegrito$([char]27)[0m $([char]27)[38;2;215;119;87m✻ Claude$([char]27)[0m fim-cores"',
].join('; ')

async function typeColored(page: Page, id: string): Promise<void> {
  await page.evaluate(id => window.__tether.activate(id), id)
  await page.waitForFunction(id => /PS.*>/.test(window.__tether.text(id).replace(/\s+/g, '')), id, { timeout: 20_000 })
  await page.locator(`.panel[data-slot-id="${id}"] .panel-term`).click()
  await page.keyboard.type(COLORED)
  await page.keyboard.press('Enter')
  await page.waitForFunction(id => /fim-cores\s*(\n|$)/.test(window.__tether.text(id)), id, { timeout: 15_000 })
}

const hooks = {
  ids: (page: Page) => page.evaluate(() => window.__tether.panelIds()),
  theme: (page: Page) => page.evaluate(() => window.__tether.theme()),
  termBg: (page: Page, id: string) => page.evaluate(id => window.__tether.termTheme(id)?.background, id),
  daemonPid: async (page: Page) => (await page.evaluate(() => window.__tether.connection()))?.pid,
  bg: (page: Page, selector: string) => page.locator(selector).first().evaluate(el => window.getComputedStyle(el).backgroundColor),
  selectValue: (page: Page) => page.evaluate(() => document.querySelector('#theme-select')?.value),
  dataTheme: (page: Page) => page.evaluate(() => document.documentElement.dataset.theme),
  clickMenu: (app: ElectronApplication, id: string) => app.evaluate(({ Menu }, id) => { Menu.getApplicationMenu()?.getMenuItemById(id)?.click() }, id),
  menuChecked: (app: ElectronApplication, id: string) => app.evaluate(({ Menu }, id) => Menu.getApplicationMenu()?.getMenuItemById(id)?.checked, id),
  osDark: (app: ElectronApplication) => app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors),
  windowBg: (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getBackgroundColor()),
}

async function waitScheme(page: Page, scheme: 'light' | 'dark'): Promise<void> {
  await page.waitForFunction(s => window.__tether.theme().scheme === s && document.documentElement.dataset.theme === s, scheme)
}

const EXPECTED = {
  dark: { toolbar: 'rgb(35, 35, 41)', term: 'rgb(27, 27, 31)', termHex: '#1b1b1f', windowBg: '#1B1B1F', dockClass: 'dockview-theme-dark' },
  light: { toolbar: 'rgb(241, 242, 245)', term: 'rgb(251, 251, 253)', termHex: '#fbfbfd', windowBg: '#FBFBFD', dockClass: 'dockview-theme-light' },
} as const

/** Everything the scheme touches: toolbar, dockview class, every xterm (palette + painted viewport), window color. */
async function assertScheme(app: ElectronApplication, page: Page, scheme: 'light' | 'dark', ids: string[]): Promise<void> {
  const want = EXPECTED[scheme]
  await waitScheme(page, scheme)
  assert.equal(await hooks.bg(page, '#toolbar'), want.toolbar, `${scheme}: toolbar background`)
  assert.equal(await page.locator(`#dock .${want.dockClass}, #dock.${want.dockClass}`).count() > 0, true, `${scheme}: dockview class`)
  let painted = 0
  for (const id of ids) {
    assert.equal(await hooks.termBg(page, id), want.termHex, `${scheme}: xterm palette of ${id}`)
    // Hidden tabs are unmounted by dockview: only the visible terminals have a painted viewport.
    const viewport = page.locator(`.panel[data-slot-id="${id}"] .xterm-viewport`)
    if (await viewport.count() === 0) continue
    assert.equal(await viewport.evaluate(el => window.getComputedStyle(el).backgroundColor), want.term, `${scheme}: painted xterm background of ${id}`)
    painted++
  }
  assert.ok(painted >= 1, `${scheme}: at least one visible terminal checked`)
  assert.equal((await hooks.windowBg(app))?.toUpperCase(), want.windowBg, `${scheme}: BrowserWindow background`)
}

function savedTheme(home: string): unknown {
  return (JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')) as { theme?: unknown }).theme
}

test('app theme: claro / automático / escuro apply live to chrome, dockview and xterm, and are remembered', async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(artifacts, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-themetest-'))
  const guard: KillGuard = { markers: [root, home, pipe], notBefore: startedAt }
  const daemonPids: number[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    const daemonPid = (await hooks.daemonPid(page))!
    assert.ok(daemonPid && processInfo(daemonPid), 'the app spawned a tetherd')
    daemonPids.push(daemonPid)

    // Default: no settings.json → automático, following the OS.
    const initial = await hooks.theme(page)
    assert.equal(initial.setting, 'auto', 'default setting is auto')
    assert.equal(initial.scheme, (await hooks.osDark(app)) ? 'dark' : 'light', 'auto follows nativeTheme')
    assert.equal(await hooks.menuChecked(app, 'theme-auto'), true)

    await createShellPanel(page, root)
    await createShellPanel(page, root)
    await page.keyboard.press('Control+Shift+D') // side by side, so the screenshot shows both
    await page.waitForFunction(() => document.querySelectorAll('.tether-tab').length === 3)
    const ids = await hooks.ids(page)
    assert.equal(ids.length, 3)
    for (const id of ids.slice(1)) await typeColored(page, id)
    await page.evaluate(id => window.__tether.activate(id), ids[1]!)

    // 1. Escuro through the menu.
    await hooks.clickMenu(app, 'theme-dark')
    await assertScheme(app, page, 'dark', ids)
    assert.equal(await hooks.selectValue(page), 'dark', 'toolbar select follows the menu')
    assert.equal(await hooks.menuChecked(app, 'theme-dark'), true)
    assert.equal(savedTheme(home), 'dark', 'settings.json remembers escuro')
    await sleep(300) // xterm repaint
    await page.screenshot({ path: join(artifacts, 'theme-dark.png') })

    // 2. Claro through the toolbar select.
    await page.selectOption('#theme-select', 'light')
    await assertScheme(app, page, 'light', ids)
    assert.equal(await hooks.menuChecked(app, 'theme-light'), true, 'menu radio follows the toolbar')
    assert.equal(await hooks.menuChecked(app, 'theme-dark'), false)
    assert.equal(savedTheme(home), 'light', 'settings.json remembers claro')
    await sleep(300)
    await page.screenshot({ path: join(artifacts, 'theme-light.png') })

    // 3. Automático: the scheme is what Electron sees in the OS right now.
    await hooks.clickMenu(app, 'theme-auto')
    const osDark = await hooks.osDark(app)
    await assertScheme(app, page, osDark ? 'dark' : 'light', ids)
    assert.equal((await hooks.theme(page)).setting, 'auto')
    assert.equal(await hooks.selectValue(page), 'auto')
    assert.equal(savedTheme(home), 'auto', 'settings.json remembers automático')

    // 4. Remembered across a restart: escuro, kill the window, relaunch.
    await hooks.clickMenu(app, 'theme-dark')
    await waitScheme(page, 'dark')
    assert.equal(savedTheme(home), 'dark')
    await killElectron(app, guard)
    app = undefined
    ;({ app, page } = await launch(home))
    assert.equal(await hooks.dataTheme(page), 'dark', 'comes up dark')
    assert.deepEqual(await hooks.theme(page), { setting: 'dark', scheme: 'dark' })
    assert.equal(await hooks.selectValue(page), 'dark')
    assert.equal(await hooks.menuChecked(app, 'theme-dark'), true)
    assert.equal((await hooks.windowBg(app))?.toUpperCase(), EXPECTED.dark.windowBg)
    const restoredIds = await hooks.ids(page)
    assert.deepEqual(restoredIds, ids, 'layout restored')
    await assertScheme(app, page, 'dark', restoredIds)

    // A corrupt settings.json is tolerated: back to automático.
    await killElectron(app, guard)
    app = undefined
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(home, 'settings.json'), '{ not json')
    ;({ app, page } = await launch(home))
    assert.equal((await hooks.theme(page)).setting, 'auto', 'corrupt settings.json → auto')
  } finally {
    if (app) await killElectron(app, guard).catch(e => console.error(String(e)))
    for (const pid of daemonPids) {
      const r = killOwned(pid, guard)
      if (r !== 'killed' && r !== 'gone') console.error(`tetherd cleanup: ${r}`)
    }
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && daemonPids.some(p => processInfo(p))) await sleep(200)
    for (let i = 0; i < 5; i++) {
      try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
  }
})
