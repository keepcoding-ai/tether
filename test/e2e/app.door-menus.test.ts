// E2E of the extensions' menu rows (agent door, slice R3) with the door-probe extension (TETHER_TEST_EXTENSIONS=1): a tetherd in
// this process on a private home and pipe, the real app on the same pipe, hidden window. No agent process, no LLM.
//   1. the desk pill's menu has the probe's row before "Hibernar mesa", and picking it runs the provider with the desk id;
//   2. the tab menu of an agent pane (never started), of a shell and of a note has the row before the floor (the link and the
//      close); a provider that throws, registered in each menu, breaks nothing;
//   3. the manager "Painéis da mesa" asks the same menu (`tabMenuEntries` from: 'manager'): the row is there, before the floor;
//   4. (K1.1) a heading line, a submenu row and the top of a tab menu (`place: 'top'`) show when the probe gives them and go
//      when it stops or when the extension goes; without them the menus keep today's rows. With TETHER_K1_PRINTS set to a
//      folder, the prints of the tab menu (submenu open) and of the pill menu go there (light theme).
// Every kill goes through test/kill.ts (pid + creation time); the daemon here is closed in-process.
import { before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
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

before(() => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit', env: { ...process.env, TETHER_TEST_EXTENSIONS: '1' } })
  assert.equal(build.status, 0, 'app build failed')
})

test('door menus: the extension row in the pill menu, every tab menu and the manager', { timeout: 300_000 }, async () => {
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

/** A menu's own rows as text (a submenu's rows live inside their row and are read apart): '—' a separator, '# …' a heading. */
const rowsOf = (page: Page, selector: string): Promise<string[]> => page.locator(selector).evaluateAll(lis => lis.map(li => {
  if (li.classList.contains('sep')) return '—'
  if (li.classList.contains('hd')) return `# ${li.textContent ?? ''}`
  return [...li.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent ?? '').join('')
}))

test('door menus K1.1: heading, submenu and the top of the tab menu come and go with the extension', { timeout: 300_000 }, async () => {
  const home = tempHome()
  const pipe = uniquePipe(home)
  const daemon = await startDaemon({ home, pipe, memoryIntervalMs: 0, readyFallbackMs: 60_000, minAgentAgeMs: 0, log: () => {} })
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home, pipe))
    await page.keyboard.press('Control+Shift+N')
    await page.waitForFunction(() => window.__tether.activeDesk() === 'desk-2')
    await page.evaluate(() => window.__tether.switchDesk('desk-1'))
    await page.waitForFunction(() => window.__tether.activeDesk() === 'desk-1')
    const shellId = await page.evaluate(async cwd => (await window.tether.request({ t: 'create', kind: 'shell', cwd, name: 'SondaDono', start: false })).slot!.slotId, home)
    await page.waitForTimeout(500)
    await page.evaluate(id => window.__tether.openSlot(id), shellId)
    const tab = page.locator(`.tether-tab[data-slot="${shellId}"]`)
    await tab.waitFor()
    const tabMenu = async (): Promise<string[]> => { await tab.click({ button: 'right' }); await page.waitForSelector('#ctx-menu li'); return rowsOf(page, '#ctx-menu > li') }
    const pillMenu = async (): Promise<string[]> => { await page.click('#desk-switch .seg[data-desk="desk-2"]', { button: 'right' }); await page.waitForSelector('#ctx-menu li'); return rowsOf(page, '#ctx-menu > li') }
    const closeMenu = async (): Promise<void> => { await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.getElementById('ctx-menu')) }

    // Without the rows: today's menus (the probe's R3 rows only), no heading and no submenu.
    const tabBefore = await tabMenu()
    assert.equal(await page.locator('#ctx-menu li.sub').count(), 0, 'no submenu row today')
    await closeMenu()
    const pillBefore = await pillMenu()
    await closeMenu()
    assert.ok(!tabBefore.some(l => l.startsWith('# Sonda')) && !pillBefore.some(l => l.startsWith('# Sonda')), 'no probe heading today')

    // ---- the tab menu: the owner's group on top, the heading first ----
    await probe(page, 'ownerMenus', true)
    const tabOn = await tabMenu()
    assert.deepEqual(tabOn.slice(0, 5), ['# Sonda: comanda 4 guias, vê 2', 'Tomar (sonda)', 'O que é da sonda', 'Submenu vazio (sonda)', '—'], `the group is on top (${tabOn.join(' | ')})`)
    assert.deepEqual(tabOn.slice(5), tabBefore, 'and the rest is today\'s menu')
    assert.equal(await page.locator('#ctx-menu > li.sub[aria-disabled="true"]').count(), 1, 'an empty submenu is drawn disabled')
    // The submenu opens on a click, its heading lines are not items, and a child runs.
    await page.locator('#ctx-menu > li.sub', { hasText: 'O que é da sonda' }).click()
    await page.locator('#ctx-menu ul.submenu:not([hidden])').waitFor()
    assert.deepEqual(await rowsOf(page, '#ctx-menu ul.submenu:not([hidden]) > li'), ['# Mesas', 'mesa da sonda', '—', '# Guias', 'guia da sonda'])
    const dir = process.env.TETHER_K1_PRINTS
    if (dir) {
      mkdirSync(dir, { recursive: true })
      await page.evaluate(() => { document.documentElement.dataset.theme = 'light' })
      await page.waitForTimeout(300)
      const m = (await page.locator('#ctx-menu').boundingBox())!
      const s = (await page.locator('#ctx-menu ul.submenu:not([hidden])').boundingBox())!
      const t = (await tab.boundingBox())!
      const x = Math.max(0, Math.min(m.x, s.x, t.x) - 8), y = Math.max(0, Math.min(m.y, s.y, t.y) - 8)
      await page.screenshot({ path: join(dir, 'k1.1-menu-da-aba-light.png'), clip: { x, y, width: Math.max(m.x + m.width, s.x + s.width) + 8 - x, height: Math.max(m.y + m.height, s.y + s.height) + 8 - y } })
    }
    await page.locator('#ctx-menu ul.submenu li', { hasText: 'guia da sonda' }).click()
    await page.waitForFunction(() => !document.getElementById('ctx-menu'))
    assert.deepEqual(await probe<string[]>(page, 'ownerPicked'), [`pane:${shellId}:guia`], 'the child ran, the submenu row itself did not')
    // Keyboard: → on the submenu row opens it on its first item, ← goes back to the row.
    await tab.click({ button: 'right' })
    await page.waitForSelector('#ctx-menu li')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowRight')
    await page.waitForFunction(() => document.activeElement?.closest('ul.submenu') != null && document.activeElement?.textContent === 'mesa da sonda')
    await page.keyboard.press('ArrowLeft')
    await page.waitForFunction(() => document.activeElement?.classList.contains('sub') === true)
    await closeMenu()

    // ---- the pill menu: the heading in the extensions' group ----
    const pillOn = await pillMenu()
    const at = pillOn.indexOf('# Sonda: comanda 4 guias, vê 2')
    assert.ok(at > 0, `the heading is in the pill menu (${pillOn.join(' | ')})`)
    assert.deepEqual(pillOn.slice(at, at + 3), ['# Sonda: comanda 4 guias, vê 2', 'Tomar (sonda)', 'O que é da sonda'])
    if (dir) {
      const m = (await page.locator('#ctx-menu').boundingBox())!
      const strip = (await page.locator('#desk-switch').boundingBox())!
      const x = Math.max(0, Math.min(m.x, strip.x) - 8), y = Math.max(0, strip.y - 8)
      await page.screenshot({ path: join(dir, 'k1.1-menu-da-pilula-light.png'), clip: { x, y, width: Math.max(m.x + m.width, strip.x + strip.width) + 8 - x, height: m.y + m.height + 8 - y } })
    }
    await closeMenu()

    // ---- they go when the provider stops, and with the extension ----
    await probe(page, 'ownerMenus', false)
    assert.deepEqual(await tabMenu(), tabBefore, 'the tab menu is today\'s again')
    await closeMenu()
    assert.deepEqual(await pillMenu(), pillBefore, 'the pill menu is today\'s again')
    await closeMenu()
    await probe(page, 'ownerMenus', true)
    await page.evaluate(() => (window.__tether as unknown as { disposeExtension(id: string): void }).disposeExtension('door-probe'))
    const tabGone = await tabMenu()
    assert.ok(!tabGone.some(l => /sonda/i.test(l) && l !== 'SondaDono'), `nothing of the probe after it went (${tabGone.join(' | ')})`)
    assert.equal(await page.locator('#ctx-menu li.sub, #ctx-menu li.hd').count(), 0)
    await closeMenu()
  } finally {
    if (app) await killElectron(app, root).catch(() => {})
    await daemon.close()
    await removeHome(home)
  }
})
