// E2E of the extensions' menu rows (agent door, slice R3) with the door-probe extension (TETHER_TEST_EXTENSIONS=1): a tetherd in
// this process on a private home and pipe, the real app on the same pipe, hidden window. No agent process, no LLM.
//   1. the desk pill's menu has the probe's row before "Hibernar mesa", and picking it runs the provider with the desk id;
//   2. the tab menu of an agent pane (never started), of a shell and of a note has the row before the floor (the link and the
//      close); a provider that throws, registered in each menu, breaks nothing;
//   3. the manager "Painéis da mesa" asks the same menu (`tabMenuEntries` from: 'manager'): the row is there, before the floor.
// Every kill goes through test/kill.ts (pid + creation time); the daemon here is closed in-process.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { startDaemon } from '../../src/daemon/server.ts'
import { removeHome, tempHome, uniquePipe } from '../unit/daemon.helpers.ts'
import { killElectron } from './electron.ts'

type Hooks = {
  activeDesk(): string
  openSlot(id: string): Promise<void>
  switchDesk(id: string): void
  openNote?(path: string): Promise<void>
  ext: Record<string, Record<string, unknown>>
}
declare const window: { __tether: Hooks; tether: { request(r: unknown): Promise<{ slot?: { slotId: string } }> } }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const ROW_DESK = 'Item da sonda (mesa)'
const ROW_PANE = 'Item da sonda (guia)'

async function launch(home: string, pipe: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_') && !k.toUpperCase().startsWith('CLAUDE')) env[k] = v
  env.TETHER_PIPE = pipe
  env.TETHER_HOME = home
  env.TETHER_E2E_HIDDEN = '1'
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  page.on('pageerror', e => console.error(`renderer error: ${e.stack}`))
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  return { app, page }
}

const menuLabels = (page: Page): Promise<string[]> => page.locator('#ctx-menu li').allInnerTexts().then(ts => ts.map(t => t.trim()))
const probe = <T>(page: Page, name: string, ...args: unknown[]): Promise<T> =>
  page.evaluate(({ name, args }) => (window.__tether.ext['door-probe']![name] as unknown as (...a: unknown[]) => unknown)(...args) as never, { name, args })

/** The probe's row is there once, before every close of the menu. The link ("Copiar link do painel") sits mid-menu in the real menus, so the floor the rows precede is the close. */
function assertBeforeFloor(labels: string[], what: string): void {
  const at = labels.indexOf(ROW_PANE)
  assert.ok(at >= 0, `${what}: the row is in the menu (${labels.join(' | ')})`)
  assert.equal(labels.filter(l => l === ROW_PANE).length, 1, `${what}: once`)
  const floor = labels.map((l, i) => (/^Fechar/.test(l) ? i : -1)).filter(i => i >= 0)
  assert.ok(floor.length >= 1, `${what}: the menu has a floor (${labels.join(' | ')})`)
  assert.ok(floor.every(i => i > at), `${what}: the row is before the floor (${labels.join(' | ')})`)
}

test('door menus: the extension row in the pill menu, every tab menu and the manager', { timeout: 300_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit', env: { ...process.env, TETHER_TEST_EXTENSIONS: '1' } })
  assert.equal(build.status, 0, 'app build failed')
  const home = tempHome()
  const pipe = uniquePipe(home)
  const daemon = await startDaemon({ home, pipe, memoryIntervalMs: 0, readyFallbackMs: 60_000, minAgentAgeMs: 0, log: () => {} })
  const notePath = join(home, 'sonda-nota.md')
  writeFileSync(notePath, '# Sonda\n')
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home, pipe))
    // A second desk: the pill strip shows with two (and "Hibernar mesa" is offered).
    await page.keyboard.press('Control+Shift+N')
    await page.waitForFunction(() => window.__tether.activeDesk() === 'desk-2')
    await page.evaluate(() => window.__tether.switchDesk('desk-1'))
    await page.waitForFunction(() => window.__tether.activeDesk() === 'desk-1')
    const desk = 'desk-2'

    // ---- 1. the desk pill ----
    await page.click(`#desk-switch .seg[data-desk="${desk}"]`, { button: 'right' })
    await page.waitForSelector('#ctx-menu li')
    const deskMenu = await menuLabels(page)
    assert.equal(deskMenu.filter(l => l === ROW_DESK).length, 1, `the pill menu has the row (${deskMenu.join(' | ')})`)
    const anchor = deskMenu.findIndex(l => /^(Hibernar mesa|Fechar mesa)/.test(l))
    if (anchor >= 0) assert.ok(deskMenu.indexOf(ROW_DESK) < anchor, 'the row is before the sleep/close of the desk')
    await page.click(`#ctx-menu li:has-text("${ROW_DESK}")`)
    assert.deepEqual(await probe<string[]>(page, 'menuPicked'), [`desk:${desk}`], 'the provider ran for this desk')

    // ---- 2. the tabs: an agent pane (never started), a shell and a note ----
    const create = (kind: string, name: string): Promise<string> =>
      page.evaluate(async ({ kind, name, cwd }) => (await window.tether.request({ t: 'create', kind, cwd, name, start: false })).slot!.slotId, { kind, name, cwd: home })
    const agentId = await create('claude', 'SondaAgente')
    const shellId = await create('shell', 'SondaShell')
    await page.waitForTimeout(500)
    for (const id of [agentId, shellId]) await page.evaluate(id => window.__tether.openSlot(id), id)
    await page.evaluate(p => window.__tether.openNote!(p), notePath)
    for (const [what, text] of [['agent', 'SondaAgente'], ['shell', 'SondaShell'], ['note', 'sonda-nota']] as const) {
      const tab = page.locator('.tether-tab', { hasText: text }).first()
      await tab.waitFor()
      await tab.click({ button: 'right' })
      await page.waitForSelector('#ctx-menu li')
      assertBeforeFloor(await menuLabels(page), `${what} tab`)
      await page.keyboard.press('Escape')
    }
    const pickedBefore = (await probe<string[]>(page, 'menuPicked')).length
    await page.locator('.tether-tab', { hasText: 'SondaShell' }).first().click({ button: 'right' })
    await page.click(`#ctx-menu li:has-text("${ROW_PANE}")`)
    assert.deepEqual((await probe<string[]>(page, 'menuPicked')).slice(pickedBefore), [`pane:${shellId}:terminal`], 'the provider got the shell pane')

    // ---- 3. the manager asks the same menu ----
    for (const [what, id] of [['agent', agentId], ['shell', shellId]] as const) {
      const rows = await probe<string[]>(page, 'managerRows', id)
      assert.ok(rows.includes(ROW_PANE), `the manager menu of the ${what} has the row (${rows.join(' | ')})`)
      assert.ok(rows.indexOf(ROW_PANE) < rows.length - 1, `the row is before the floor (${rows.join(' | ')})`)
    }
  } finally {
    if (app) await killElectron(app, root).catch(() => {})
    await daemon.close()
    await removeHome(home)
  }
})
