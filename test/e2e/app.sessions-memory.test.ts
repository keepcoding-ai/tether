// E2E of the memory/time fields in "Sessões" (hidden window, private home/pipe, real tetherd with shells, CLAUDE* stripped):
// busySince/endedAt/memoryMB are injected with window.__tether.applyState; checks the menu rows, the header total, the tooltip,
// the popup detail and footer, and takes screenshots into SESSIONS_MEM_SHOTS_DIR (default D:/atrium/.tmp/sessions-mem-proof).
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
  applyState(slot: SlotState): void
  connection(): { connected: boolean; pid?: number } | undefined
}
declare const window: { __tether: Hooks }
declare const document: { querySelectorAll(selector: string): { length: number }; getElementById(id: string): { hidden: boolean; textContent: string | null } | null; documentElement: { dataset: Record<string, string> }; activeElement: { id: string } | null }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const shots = process.env.SESSIONS_MEM_SHOTS_DIR ?? 'D:/atrium/.tmp/sessions-mem-proof'
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-sessmem-${process.pid}`

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
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10_000)
  page.on('pageerror', e => console.error(`renderer error: ${e.message}`))
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  return { app, page }
}

const slotsOf = (page: Page): Promise<SlotState[]> => page.evaluate(() => window.__tether.slots())
const idsOf = (page: Page): Promise<string[]> => page.evaluate(() => window.__tether.panelIds())

/** A PowerShell in the visible desk through the chooser; returns its slot id once it runs. */
async function createShell(page: Page, cwd: string): Promise<string> {
  const before = await idsOf(page)
  await page.click('#btn-new')
  await page.waitForSelector('#dlg-new[open]')
  await page.fill('#dlg-new .ch-path-input', cwd)
  await page.click('#dlg-new .ch-item[data-id=\"powershell\"]')
  await page.click('#dlg-new .btn.primary.go') // two steps: the click selects, the button opens
  await page.waitForFunction(() => document.querySelectorAll('#dlg-new[open]').length === 0)
  await page.waitForFunction(n => window.__tether.panelIds().length === n, before.length + 1)
  const id = (await idsOf(page)).find(x => !before.includes(x))!
  await page.waitForFunction(id => window.__tether.slots().find(s => s.slotId === id)?.status === 'running', id, { timeout: 20_000 })
  return id
}

/** Closes the pane through its tab's close button and picks `choice` in the dialog ('detach' keeps the process, 'stop' ends it). */
async function closePane(page: Page, slotId: string, choice: 'detach' | 'stop'): Promise<void> {
  const tab = page.locator(`.tether-tab[data-slot="${slotId}"]`)
  await tab.hover()
  await tab.locator('.close').click()
  await page.locator(`dialog[open] button.choice[data-choice="${choice}"]`).click()
  await page.waitForFunction(id => !window.__tether.panelIds().includes(id), slotId)
}

const openMenu = async (page: Page): Promise<void> => {
  if (await page.locator('#sessions-list').isHidden()) await toggle(page)
  await page.waitForSelector('#sessions-list:not([hidden])')
}
// At 400 px the toolbar's left icons run under the desk switch (existing layout), so the narrow capture toggles by script.
const toggle = (page: Page): Promise<void> => page.evaluate(() => (document.getElementById('btn-sessions') as unknown as { click(): void }).click())
const closeMenu = async (page: Page): Promise<void> => {
  if (await page.locator('#sessions-list').isVisible()) await toggle(page)
  await page.waitForSelector('#sessions-list', { state: 'hidden' })
}
const row = (page: Page, slotId: string) => page.locator(`#sessions-list .sx-row[data-slot="${slotId}"]`)
const counter = (page: Page): Promise<string> => page.evaluate(() => { const c = document.getElementById('sessions-count')!; return c.hidden ? '' : c.textContent! })
const header = async (page: Page): Promise<string> => (await page.locator('#sessions-list .sx-hd').textContent())!.replace(/\s+/g, ' ').trim()
const title = (page: Page): Promise<string | null> => page.getAttribute('#btn-sessions', 'title')
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString()

/** Feeds the renderer the slot as the daemon would report it: idle for hours (no waiting 10 minutes), busy, or asking attention. */
async function inject(page: Page, slotId: string, patch: Partial<SlotState>): Promise<void> {
  await page.evaluate(([id, p]) => {
    const s = window.__tether.slots().find(x => x.slotId === id)!
    const next = { ...s } as Record<string, unknown>
    delete next.idleSince; delete next.turn; delete next.attention
    window.__tether.applyState({ ...next, ...(p as object) } as unknown as SlotState)
  }, [slotId, patch] as const)
}

async function setTheme(page: Page, scheme: 'dark' | 'light'): Promise<void> {
  await closeMenu(page)
  await page.click('#btn-theme')
  await page.click(`#theme-menu li[data-theme="${scheme}"]`)
  await page.waitForFunction(s => document.documentElement.dataset.theme === s, scheme)
}


async function injectFull(page: Page, slotId: string, patch: Partial<SlotState>): Promise<void> {
  await page.evaluate(([id, p]) => {
    const s = window.__tether.slots().find(x => x.slotId === id)!
    window.__tether.applyState({ ...s, ...(p as object) } as unknown as SlotState)
  }, [slotId, patch] as const)
}

test('sessões: tempo (trabalhando há, encerrada) e memória nas linhas, cabeçalho e popup', { timeout: 300_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(shots, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-sessmem-'))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    daemons.push(await claim((await page.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800))
    await createShell(page, home) // keeps a pane
    const [a, b, c] = [await createShell(page, home), await createShell(page, home), await createShell(page, home)]
    const d = await createShell(page, home)
    for (const id of [a, b, c, d]) await closePane(page, id, 'detach')
    // the daemon's first memory sample broadcasts every slot and would wipe the injected fields: let it land first
    await page.waitForFunction(ids => ids.every(id => (window.__tether.slots().find(s => s.slotId === id) as { memoryMB?: number } | undefined)?.memoryMB !== undefined), [a, b, c, d], { timeout: 30_000 })
    await sleep(1_000)
    const idleAt = ago(3 * 3_600_000)
    await injectFull(page, d, { memoryMB: 1 } as Partial<SlotState>)
    await injectFull(page, a, { turn: 'busy', busySince: ago(12 * 60_000), memoryMB: 1229 } as Partial<SlotState>)
    await injectFull(page, b, { idleSince: idleAt, memoryMB: 420.4 } as Partial<SlotState>)
    await injectFull(page, c, { idleSince: idleAt, memoryMB: 1800 } as Partial<SlotState>)
    await closeMenu(page).catch(() => {})
    await openMenu(page)
    assert.equal(await header(page), '1 em andamento · 4 sem guia · 3,4 GB', 'header carries the total')
    assert.match((await title(page))!, /1 em andamento · 4 sem guia · 3,4 GB/, 'tooltip too')
    assert.equal(await row(page, a).locator('.cw').textContent(), 'trabalhando há 12 min · 1,2 GB')
    assert.match((await row(page, b).locator('.cw').textContent())!, /^ocioso há 3 h · 420 MB$/)
    const order = await page.locator('#sessions-list .sx-row.idle').evaluateAll(els => els.map(e => (e as unknown as { dataset: { slot: string } }).dataset.slot))
    assert.ok(order.indexOf(c) < order.indexOf(b), 'same idle time: the heavier comes first')
    await page.screenshot({ path: join(shots, 'sessions-menu-memory.png') })

    await page.click('#sessions-follow')
    const dlgSel = 'dialog[data-dialog="sessions"]'
    await page.waitForSelector(dlgSel + '[open]')
    await page.locator(`${dlgSel} .pd-row[data-slot="${a}"]`).click()
    assert.match((await page.locator(`${dlgSel} .pd-facts`).textContent())!, /Memória1,2 GB .medida há até 1 min./)
    assert.match((await page.locator(`${dlgSel} .pd-line b`).first().textContent())!, /Memória das sessões vivas: [0-9],[0-9] GB/)
    await sleep(300)
    await page.screenshot({ path: join(shots, 'sessions-popup-memory.png') })
    await page.keyboard.press('Escape')
  } finally {
    if (app) await killElectron(app, root).catch(() => {})
    for (const dm of daemons) await killOwned(dm, { tree: true })
    for (let i = 0; i < 20 && daemons.some(x => pidAlive(x.pid)); i++) await sleep(500)
    for (let i = 0; i < 5; i++) {
      try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
  }
})
