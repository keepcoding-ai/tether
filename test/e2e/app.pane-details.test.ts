// E2E of the collapsible pane header (hidden window, private home/pipe, real tetherd, PowerShell panes: no Claude):
//   - collapsed by default; the tab tooltip carries title, profile, folder and state;
//   - toggle by the tab's button, by the tab context menu and by Ctrl+Shift+H;
//   - the terminal refits: its rows grow when the header collapses and shrink when it opens;
//   - the state is saved in the layout and survives a relaunch (both ways);
//   - a missing-folder situation still shows on a collapsed pane.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type Hooks = {
  panelIds(): string[]
  slots(): SlotState[]
  connection(): { connected: boolean; pid?: number } | undefined
  openSlot(id: string): void
  termSize(id: string): { cols: number; rows: number } | undefined
  text(id: string): string
  activate(id: string): void
}
type El = { dataset: Record<string, string>; inert: boolean; clientHeight: number; title: string }
declare const window: {
  __tether: Hooks
  tether: { request(body: unknown): Promise<{ t: 'ok'; slot?: SlotState } | { t: 'error'; code: string; message: string }> }
}
declare const document: { querySelector(selector: string): El | null }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const artifacts = join(root, 'test', 'e2e', 'artifacts')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-details-${process.pid}`

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

async function launch(home: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_') && !k.startsWith('CLAUDE')) env[k] = v
  delete env.TETHER_CLAUDE_ARGS
  env.TETHER_PIPE = pipe
  env.TETHER_HOME = home
  env.TETHER_E2E_HIDDEN = '1'
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10_000)
  page.on('console', m => { if (m.type() === 'error') console.log(`renderer console: ${m.text()}`) })
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  return { app, page }
}

const details = (page: Page, id: string) => page.evaluate(id => {
  const p = document.querySelector(`.panel[data-slot-id="${id}"]`)
  const d = document.querySelector(`.panel[data-slot-id="${id}"] .panel-details`)
  return { state: p?.dataset.details, height: d?.clientHeight ?? -1, inert: d?.inert }
}, id)
const rows = (page: Page, id: string) => page.evaluate(id => window.__tether.termSize(id)?.rows ?? 0, id)
const waitDetails = (page: Page, id: string, open: boolean) =>
  page.waitForFunction(([id, open]) => document.querySelector(`.panel[data-slot-id="${id}"]`)?.dataset.details === String(open), [id, open] as const)

/** Waits for the grid to settle (the height transition plus the debounced fit) and returns its rows. */
async function settledRows(page: Page, id: string): Promise<number> {
  let last = -1
  for (let stable = 0; stable < 5;) {
    await sleep(120)
    const r = await rows(page, id)
    stable = r === last ? stable + 1 : 0
    last = r
  }
  return last
}

async function tabMenu(page: Page, label: string): Promise<void> {
  await page.locator('.tether-tab').first().click({ button: 'right' })
  await page.locator('#ctx-menu [role=menuitem]', { hasText: label }).click()
}

test('pane details: collapsed by default, three ways to toggle, refit, persistence, situations', async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(artifacts, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-detailstest-'))
  let daemon: Owned | undefined
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    daemon = await claim((await page.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' })

    await page.click('#btn-new')
    await page.waitForSelector('#dlg-new[open]')
    await page.check('input[name=profile][value=powershell]')
    await page.fill('#new-cwd', root)
    await page.click('#btn-create')
    await page.waitForFunction(() => window.__tether.panelIds().length === 1)
    const id = (await page.evaluate(() => window.__tether.panelIds()))[0]!
    await page.waitForFunction(id => /PS.*>/.test(window.__tether.text(id).replace(/\s+/g, '')), id, { timeout: 30_000 })

    // ---- 1. collapsed by default, with the facts on the tab ----
    let d = await details(page, id)
    assert.deepEqual(d, { state: 'false', height: 0, inert: true }, 'collapsed: no height, out of the tab order')
    const tip = await page.evaluate(() => document.querySelector('.tether-tab')!.title)
    assert.match(tip, /Pasta: /)
    assert.match(tip, /rodando/)
    assert.match(tip, /Perfil:/)
    assert.ok(tip.startsWith(await page.locator('.tether-tab .text').innerText()), 'the tooltip opens with the title')
    const toggle = page.locator('.dv-right-actions-container [data-action="status-bar"]')
    assert.equal(await toggle.getAttribute('aria-pressed'), 'false')
    assert.match((await toggle.getAttribute('title'))!, /Mostrar barra de status \(Ctrl\+Shift\+H\)/)
    const collapsedRows = await settledRows(page, id)
    assert.ok(collapsedRows > 5)

    // ---- 2. the strip's status-bar toggle opens it; the grid gives rows to the header ----
    await toggle.click()
    await waitDetails(page, id, true)
    await page.waitForFunction(id => (document.querySelector(`.panel[data-slot-id="${id}"] .panel-details`)?.clientHeight ?? 0) > 10, id)
    d = await details(page, id)
    assert.equal(d.inert, false)
    assert.equal(await toggle.getAttribute('aria-pressed'), 'true')
    const openRows = await settledRows(page, id)
    assert.ok(openRows < collapsedRows, `rows shrink when the header opens (${collapsedRows} -> ${openRows})`)
    assert.ok(await page.locator(`.panel[data-slot-id="${id}"] .status-bar [data-action="switch-profile"]`).isVisible(), 'the switch-profile action is reachable')
    await page.waitForFunction(id => (document.querySelector(`.panel[data-slot-id="${id}"] .panel-details`)?.clientHeight ?? 0) === 26, id) // the open status bar is 26px tall
    await page.screenshot({ path: join(artifacts, 'pane-details-open.png') })

    // ---- 3. the tab menu closes it; the rows come back ----
    await tabMenu(page, 'Ocultar barra de status')
    await waitDetails(page, id, false)
    assert.equal(await settledRows(page, id), collapsedRows, 'rows grow back when collapsed')
    await page.screenshot({ path: join(artifacts, 'pane-details-collapsed.png') })
    await tabMenu(page, 'Mostrar barra de status')
    await waitDetails(page, id, true)

    // ---- 4. the shortcut, from inside the terminal ----
    await page.locator('.xterm-helper-textarea').first().focus()
    await page.keyboard.press('Control+Shift+H')
    await waitDetails(page, id, false)
    await page.keyboard.press('Control+Shift+H')
    await waitDetails(page, id, true)

    // ---- 5. the open state survives a relaunch ----
    await sleep(900) // the debounced layout save
    await killElectron(app, root); app = undefined
    ;({ app, page } = await launch(home))
    await page.waitForSelector(`.panel[data-slot-id="${id}"]`)
    await waitDetails(page, id, true)
    assert.equal(await page.locator('.dv-right-actions-container [data-action="status-bar"]').getAttribute('aria-pressed'), 'true')

    // ---- 6. a missing folder still shows on a collapsed pane; the collapsed state survives too ----
    await tabMenu(page, 'Ocultar barra de status')
    await waitDetails(page, id, false)
    const missing = join(home, 'pasta-que-nao-existe')
    const created = await page.evaluate(async cwd => {
      const r = await window.tether.request({ t: 'create', kind: 'shell', cwd, start: true })
      return { code: r.t === 'error' ? r.code : 'ok', slotId: window.__tether.slots().find(s => s.cwd === cwd)?.slotId }
    }, missing)
    assert.equal(created.code, 'cwd-missing')
    const errId = created.slotId!
    await page.evaluate(id => window.__tether.openSlot(id), errId)
    await page.waitForSelector(`.panel[data-slot-id="${errId}"][data-status="error"] .panel-overlay button[data-action="pick-folder"]`)
    assert.equal((await details(page, errId)).state, 'false', 'the pane is collapsed')
    assert.match(await page.locator(`.panel[data-slot-id="${errId}"] .panel-overlay`).innerText(), /A pasta não existe mais/)
    await page.screenshot({ path: join(artifacts, 'pane-details-situation.png') })

    await sleep(900)
    await killElectron(app, root); app = undefined
    ;({ app, page } = await launch(home))
    await page.waitForFunction(() => window.__tether.panelIds().length === 2)
    await page.evaluate(id => window.__tether.activate(id), id) // a background tab is mounted only once active
    await page.waitForSelector(`.panel[data-slot-id="${id}"]`)
    await waitDetails(page, id, false)
    assert.equal(await page.locator('.dv-right-actions-container [data-action="status-bar"]').first().getAttribute('aria-pressed'), 'false')
  } finally {
    if (app) await killElectron(app, root).catch(() => {})
    if (daemon) await killOwned(daemon)
    await sleep(500)
    rmSync(home, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 })
  }
})
