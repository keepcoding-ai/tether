// E2E of "Espiar" on a slot's tab (slice E3): Alt+click on a background tab opens the peek card WITHOUT activating the tab; Alt+click on
// the tab already in view only moves the keyboard (no card); the tab's right-click menu has the row "Espiar" with the hint "Alt+clique".
// Shells only (hidden window, private home/pipe, real tetherd, CLAUDE* stripped). One E2E at a time: the build is remade.
//   node --test test/e2e/app.tab-peek.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type Hooks = {
  panelIds(): string[]
  connection(): { connected: boolean; pid?: number } | undefined
  peekState(): { open: boolean; slotId?: string; routed: boolean; lent: boolean }
}
type El = { classList: { contains(c: string): boolean }; closest(s: string): El | null; dataset: Record<string, string> }
declare const window: { __tether: Hooks }
declare const document: { querySelector(selector: string): El | null; querySelectorAll(selector: string): { length: number }; activeElement: El | null }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const shots = process.env.PEEK_SHOTS_DIR ?? 'C:/atrium/.tmp/tether-agents/onda-3/espiar'
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-tab-peek-${process.pid}`

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

async function launch(home: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_') && !k.toUpperCase().startsWith('CLAUDE')) env[k] = v
  env.TETHER_PIPE = pipe
  env.TETHER_HOME = home
  env.TETHER_E2E_HIDDEN = '1'
  delete env.TETHER_CLAUDE_ARGS
  delete env.NODE_TEST_CONTEXT
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10_000)
  page.on('pageerror', e => console.error(`renderer error: ${e.message}`))
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  return { app, page }
}

const idsOf = (page: Page): Promise<string[]> => page.evaluate(() => window.__tether.panelIds())

/** A PowerShell in the visible group through the chooser; returns its slot id once it runs. */
async function createShell(page: Page, cwd: string): Promise<string> {
  const before = await idsOf(page)
  await page.click('#btn-new')
  await page.waitForSelector('#dlg-new[open]')
  await page.fill('#dlg-new .ch-path-input', cwd)
  await page.click('#dlg-new .ch-item[data-id="powershell"]')
  await page.click('#dlg-new .btn.primary.go')
  await page.waitForFunction(() => document.querySelectorAll('#dlg-new[open]').length === 0)
  await page.waitForFunction(n => window.__tether.panelIds().length === n, before.length + 1)
  const id = (await idsOf(page)).find(x => !before.includes(x))!
  await page.waitForFunction(id => window.__tether.panelIds().includes(id), id)
  return id
}

/** Whether the dockview tab of the slot is the active one of its group. */
const isActiveTab = (page: Page, id: string): Promise<boolean> =>
  page.evaluate(id => document.querySelector(`.tether-tab[data-slot="${id}"]`)?.closest('.dv-tab')?.classList.contains('dv-active-tab') === true, id)

test('espiar pela aba: Alt+clique numa aba de fundo abre o cartão sem ativá-la; o menu da aba tem "Espiar"', { timeout: 300_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  const home = mkdtempSync(join(tmpdir(), 'tether-tab-peek-'))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    daemons.push(await claim((await page.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800))

    // Two shells in one group: the second is the active tab, the first is a background tab.
    const back = await createShell(page, home)
    const front = await createShell(page, home)
    await page.waitForFunction(id => document.querySelector(`.tether-tab[data-slot="${id}"]`)?.closest('.dv-tab')?.classList.contains('dv-active-tab') === true, front)
    assert.equal(await isActiveTab(page, back), false, 'the first tab is in the background')

    // ---- 1. Alt+click on the background tab: the card opens, the tab is not activated ----
    console.log('step 1')
    await page.locator(`.tether-tab[data-slot="${back}"]`).click({ modifiers: ['Alt'] })
    await page.waitForSelector('#peek[data-open="true"]')
    await page.waitForFunction(id => { const s = window.__tether.peekState(); return s.open && s.slotId === id }, back)
    assert.equal(await isActiveTab(page, back), false, 'the background tab was not activated by the Alt+click')
    assert.equal(await isActiveTab(page, front), true, 'the active tab stays active')
    await page.screenshot({ path: join(shots, 'e3-alt-clique-aba.png') })
    await page.click('#peek .peek-close')
    await page.waitForSelector('#peek', { state: 'hidden' })
    assert.equal(await isActiveTab(page, back), false, 'closing the card does not activate it either')

    // ---- 2. a plain click still activates (the gesture is only Alt+click) ----
    console.log('step 2')
    await page.locator(`.tether-tab[data-slot="${back}"]`).click()
    await page.waitForFunction(id => document.querySelector(`.tether-tab[data-slot="${id}"]`)?.closest('.dv-tab')?.classList.contains('dv-active-tab') === true, back)
    assert.equal((await page.evaluate(() => window.__tether.peekState())).open, false, 'a plain click opens no card')

    // ---- 3. Alt+click on the tab in view: only the keyboard, no card ----
    console.log('step 3')
    await page.locator(`.tether-tab[data-slot="${back}"]`).click({ modifiers: ['Alt'] })
    await sleep(500)
    assert.equal((await page.evaluate(() => window.__tether.peekState())).open, false, 'a tab in view opens no card')
    assert.equal(await isActiveTab(page, back), true)

    // ---- 4. the tab's menu has "Espiar" with its hint, and it works ----
    console.log('step 4')
    await page.locator(`.tether-tab[data-slot="${front}"]`).click({ button: 'right' })
    await page.waitForSelector('#ctx-menu li')
    const labels = (await page.locator('#ctx-menu li').allInnerTexts()).map(t => t.replace(/\s+/g, ' ').trim())
    assert.ok(labels.some(l => /^Espiar\s*Alt\+clique$/.test(l)), `tab menu: ${labels.join(' | ')}`)
    // The right-click activated `front`, now in view: "Espiar" only moves the keyboard (the same decision as the Alt+click).
    await page.locator('#ctx-menu li', { hasText: /^Espiar/ }).click()
    await page.waitForSelector('#ctx-menu li', { state: 'detached' })
    assert.equal((await page.evaluate(() => window.__tether.peekState())).open, false)
    assert.equal(await isActiveTab(page, front), true)
  } finally {
    console.log('teardown')
    if (app) await killElectron(app, root).catch(() => {})
    for (const d of daemons) await killOwned(d, { tree: true })
    for (let i = 0; i < 20 && daemons.some(d => pidAlive(d.pid)); i++) await sleep(500)
    for (let i = 0; i < 5; i++) {
      try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
  }
})
