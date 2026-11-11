// E2E of the manager of the panel pad (extension panel-pad-manager): the pad's second state, where the panels of the
// current desk that have a frame are managed. Real tetherd on a private home/pipe, hidden window, CLAUDE* stripped.
//   1. a note in panel A's frame; B with an empty frame (no row); C's empty frame goes away with C, no toast;
//   2. closing A (keeping the process): toast "Ver" → the manager, A's row loose, with "Trazer de volta";
//   3. Trazer de volta: A's pane is back and its frame (with the note) is its again;
//   4. a live row: click brings the panel up; right-click opens the tab's own menu;
//   5. dragging a row onto the desk's edge moves the panel like dragging its tab;
//   6. another desk lists none of this desk's panels;
//   7. a loose row's "Fechar painel…" (the tab's menu item) discards the frame and its record;
//   8. the keyboard and the switch; 9. affinity of desk-only screens.
// Screenshots in <atrium>/.tmp/panel-pad-manager.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type Row = { key: string; panel: string; title: string; kind: string; sub: string; loose: boolean; empty: boolean; revivable: boolean; panes: string[] }
type Manager = { filter: string; rows: Row[]; selected?: string }
type Tree = { loose: { key: string; empty: boolean }[] }
type LayoutJSON = { sidebars?: { pads: Record<string, unknown>; meta?: Record<string, { ownerLabel: string; deskId?: string; updatedAt: number }> } }
type Hooks = {
  slots(): SlotState[]
  connection(): { connected: boolean; pid?: number } | undefined
  openSlot(id: string): void
  padFrames(): { pad: string; desk?: string; panes: string[]; shown: boolean }[]
  focusablePanel(): string | undefined
  activatePanel(id: string): void
  panelIds(): string[]
  openNote(path: string): Promise<void>
  panelPadManager(): Manager[]
  panelFramesTree(): Tree
  panelFramesToast(): { text: string; action?: string } | undefined
  openPanelPadManager(filter?: string, key?: string): void
  panelPadManagerOn(): boolean
  layout(): LayoutJSON
  activeDesk(): string
  switchDesk(id: string): void
  createDesk(side: string, relativeTo: string): string
  frameLayout(frameId?: string): unknown
  frameIds(): string[]
}
declare const window: { __tether: Hooks; tether: { request(body: unknown): Promise<{ t: string; slot?: SlotState }> } }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-ppm-${process.pid}`
const atriumTmp = resolve(root, '..', '..', '.tmp')
const tmpBase = join(existsSync(atriumTmp) ? atriumTmp : tmpdir(), 'panel-pad-manager')
const shots = tmpBase
const electronPath = require('electron') as string

const PANEL = 'frame-pads.panel'
const key = (panelId: string): string => `${PANEL}@${panelId}`
const shown = `#pads .pad.shown[data-pad="${PANEL}"]`
/** The manager as the e2e sees it: inside the pad on screen, never a tab on the desk. */
const inPad = `${shown} .pad-manager.pf-pane:not([hidden])`
const row = (k: string): string => `${inPad} .pf-row[data-key="${k}"]`

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const pidAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' } }

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
  page.on('console', m => { if (m.type() === 'error') console.error(`renderer console: ${m.text()}`) })
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  return { app, page }
}

async function shell(page: Page): Promise<string> {
  const reply = await page.evaluate(cwd => window.tether.request({ t: 'create', kind: 'shell', cwd, start: true }), root)
  assert.equal(reply.t, 'ok')
  const id = reply.slot!.slotId
  await page.waitForFunction(id => typeof window.__tether.slots().find(s => s.slotId === id)?.pid === 'number', id, { timeout: 20_000 })
  await page.evaluate(id => window.__tether.openSlot(id), id)
  await page.waitForFunction(id => window.__tether.focusablePanel() === id, id)
  return id
}

/** Closes a pane through its tab's close button, keeping its process ("detach"). */
async function closePane(page: Page, slotId: string): Promise<void> {
  const tab = page.locator(`#dock .tether-tab[data-slot="${slotId}"]`)
  await tab.hover()
  await tab.locator('.close').click()
  await page.locator('dialog[open] button.choice[data-choice="detach"]').click()
  await page.waitForFunction(id => !window.__tether.panelIds().includes(id), slotId)
}

const manager = async (page: Page): Promise<Manager | undefined> => (await page.evaluate(() => window.__tether.panelPadManager()))[0]
const managerOn = async (page: Page): Promise<boolean> => page.evaluate(() => window.__tether.panelPadManagerOn())
/** The pad to the manager (on Todos) unless it is there already. */
async function ensureManager(page: Page): Promise<void> {
  if (!(await managerOn(page))) await page.evaluate(() => window.__tether.openPanelPadManager('all'))
  await page.waitForSelector(inPad)
}
/** The panes saved in a panel's pad (layout.json's state of `frame-pads.panel@<panel>`). */
const padHas = async (page: Page, panelId: string, paneId: string): Promise<boolean> =>
  page.evaluate(([k, id]) => JSON.stringify(window.__tether.layout().sidebars?.pads[k!] ?? null).includes(`"${id}"`), [key(panelId), paneId])
/** How many groups the desk's frame has. */
const groups = async (page: Page): Promise<number> => page.evaluate(() => window.__tether.frameIds().reduce((n, id) => n + (JSON.stringify(window.__tether.frameLayout(id)).match(/"type":"leaf"/g) ?? []).length, 0))

/** The row's foot bar: the given pinned action first, "Copiar link"/"Mover" as icons, the ⋯ last. */
async function barShape(page: Page, k: string, level: 'icon' | 'primary', label: string): Promise<void> {
  const acts = await page.locator(`${row(k)} .pf-r-bar > button`).evaluateAll(bs => bs.map(b => ({ pin: (b as HTMLElement).dataset.pin ?? (b.classList.contains('more') ? 'more' : ''), label: (b as HTMLElement).dataset.label ?? '' })))
  assert.deepEqual(acts[0], { pin: level, label }, `the ${level} action: ${JSON.stringify(acts)}`)
  assert.equal(acts.filter(x => x.pin === 'highlight').length <= 1 && acts.filter(x => x.pin === 'primary').length <= 2, true)
  assert.ok(acts.some(x => x.pin === 'icon' && x.label === 'Mover…') && acts.some(x => x.pin === 'icon' && x.label === 'Copiar link do painel'), JSON.stringify(acts))
  assert.equal(acts.at(-1)?.pin, 'more', 'the ⋯ is last')
  const bar = (await page.locator(`${row(k)} .pf-r-bar`).boundingBox())!, head = (await page.locator(`${row(k)} .pf-r-head`).boundingBox())!
  assert.ok(bar.y > head.y, 'the bar is at the row\'s foot')
  assert.equal(await page.locator(`${row(k)} .pf-btn`).count(), 0, 'no big buttons')
}

/** The ⋯ opens the menu by the button (not at the window's corner). */
async function menuNearButton(page: Page, k: string, shot: string): Promise<void> {
  await ensureManager(page)
  const more = page.locator(`${row(k)} .pf-act.more`)
  const b = (await more.boundingBox())!
  await more.click()
  await page.waitForSelector('#ctx-menu')
  const mb = (await page.locator('#ctx-menu').boundingBox())!
  await page.screenshot({ path: join(shots, shot) })
  const dx = Math.max(0, mb.x - (b.x + b.width), b.x - (mb.x + mb.width)), dy = Math.max(0, mb.y - (b.y + b.height), b.y - (mb.y + mb.height))
  assert.ok(dx < 40 && dy < 40, `menu by the ⋯: button ${JSON.stringify(b)} menu ${JSON.stringify(mb)}`)
  await page.keyboard.press('Escape')
  await page.waitForSelector('#ctx-menu', { state: 'detached', timeout: 2_000 })
}

test('panel pad manager: the panels of the desk with a frame; a loose one comes back or its frame is closed', { timeout: 300_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(tmpBase, { recursive: true })
  const home = mkdtempSync(join(tmpBase, 'home-'))
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ extensions: { disabled: ['explorer'] } }))
  const notePath = join(home, 'lembrete.md')
  writeFileSync(notePath, 'lembrar do bug do cwd\n')
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    daemons.push(await claim((await page.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))

    // ---- 1. a note in A's frame; B's frame empty; C's empty frame leaves with C ----
    const a = await shell(page)
    await page.click(`.sb-icon[data-pad="${PANEL}"]`)
    await page.waitForSelector(`${shown}[data-panel="${a}"] .empty-panel`)
    await page.click(`${shown} .frame-dock`)
    await page.evaluate(p => window.__tether.openNote(p), notePath)
    await page.waitForFunction(() => window.__tether.padFrames().some(f => f.pad === 'frame-pads.panel' && f.shown && f.panes.some(p => p.startsWith('note:'))))
    const noteId = (await page.evaluate(() => window.__tether.padFrames())).filter(f => f.pad === 'frame-pads.panel' && f.shown).flatMap(f => f.panes).find(p => p.startsWith('note:'))!
    assert.ok(await padHas(page, a, noteId), "the note is in A's frame")
    const b = await shell(page)
    const c = await shell(page)
    await page.waitForSelector(`${shown}[data-panel="${c}"] .empty-panel`)
    await page.waitForFunction(k => k in (window.__tether.layout().sidebars?.pads ?? {}), key(c))
    await closePane(page, c)
    await page.waitForFunction(k => !(k in (window.__tether.layout().sidebars?.pads ?? {})), key(c), { timeout: 5_000 })
    assert.equal(await page.evaluate(() => window.__tether.panelFramesToast()), undefined, 'an empty frame leaves no toast')

    // ---- 2. closing A: toast, Ver → the manager with A loose and revivable ----
    await page.evaluate(id => window.__tether.activatePanel(id), a)
    await closePane(page, a)
    await page.waitForFunction(() => window.__tether.panelFramesToast()?.text === 'O quadro da prancheta ficou solto', undefined, { timeout: 5_000 })
    await page.screenshot({ path: join(shots, '1-toast-solto.png') })
    await page.click('.pf-toast .pf-toast-action')
    await page.waitForSelector(row(key(a)))
    assert.ok(await managerOn(page), 'the pad is in its manager state')
    assert.equal(await page.locator('#dock .tether-tab.frames-manager').count(), 0, 'nothing opened on the desk')
    let m = (await manager(page))!
    assert.equal(m.selected, key(a))
    assert.deepEqual(m.rows.map(r => r.key), [key(a)], 'B has an empty frame: nothing to manage there')
    const ra = m.rows[0]!
    assert.ok(ra.loose && ra.revivable, `A is loose and can come back: ${JSON.stringify(ra)}`)
    assert.ok(ra.sub.startsWith('solto · sessão rodando sem guia'), ra.sub)
    assert.ok(ra.panes.includes(noteId), 'the row shows what the frame keeps')
    assert.equal(await page.locator(`${inPad} .pf-preview`).count(), 0, 'no preview')
    await page.screenshot({ path: join(shots, '2-gestor-solto.png') })
    // A click on a loose row does nothing.
    await page.click(`${row(key(a))} .pf-r-head`)
    await sleep(200)
    assert.ok(!(await page.evaluate(() => window.__tether.panelIds())).includes(a), 'a click on a loose row brings nothing')
    // A loose row is a panel too: the tab's own menu with "Trazer de volta" first, and the bar at the row's foot.
    await barShape(page, key(a), 'icon', 'Trazer de volta')
    {
      const acts = await page.locator(`${row(key(a))} .pf-r-bar > button`).evaluateAll(bs => bs.map(b => ({ pin: (b as HTMLElement).dataset.pin ?? '', label: (b as HTMLElement).dataset.label ?? '' })))
      assert.equal(acts.filter(x => x.pin === 'highlight').length, 0, `no highlight on a loose row: ${JSON.stringify(acts)}`)
      assert.deepEqual(acts.at(-2), { pin: 'icon', label: 'Fechar painel…' }, `"Fechar painel…" right before the ⋯: ${JSON.stringify(acts)}`)
      const box = (await page.locator(`${row(key(a))}`).boundingBox())!
      await page.screenshot({ path: join(shots, '2a-barra-solto.png'), clip: box })
    }
    const looseMenu = async (open: () => Promise<void>, how: string): Promise<void> => {
      await open()
      await page.waitForSelector('#ctx-menu')
      const its = await page.locator('#ctx-menu li[role="menuitem"]').allInnerTexts()
      assert.ok(its[0]?.includes('Trazer de volta'), `"Trazer de volta" first (${how}): ${JSON.stringify(its)}`)
      for (const t of ['Renomear', 'Mover', 'Fechar painel', 'Copiar link do painel']) assert.ok(its.some(i => i.includes(t)), `the loose menu has "${t}" (${how}): ${JSON.stringify(its)}`)
      assert.ok(!its.some(i => i.includes('Fechar quadro')), 'no "Fechar quadro"')
      await page.keyboard.press('Escape')
      await page.waitForSelector('#ctx-menu', { state: 'detached', timeout: 2_000 })
    }
    await looseMenu(() => page.locator(row(key(a))).click({ button: 'right' }), 'right-click')
    await looseMenu(() => page.click(`${row(key(a))} .pf-act.more`), '⋯')
    await menuNearButton(page, key(a), '2b-menu-solto.png')
    assert.ok(!(await page.evaluate(() => window.__tether.panelIds())).includes(a), 'opening the menu brings nothing back')

    // ---- 3. Trazer de volta: A's pane comes back, its frame with it ----
    await page.click(`${row(key(a))} .pf-act.pin-icon[data-label="Trazer de volta"]`)
    await page.waitForFunction(id => window.__tether.panelIds().includes(id), a, { timeout: 10_000 })
    await page.waitForFunction(() => window.__tether.panelFramesTree().loose.length === 0)
    assert.ok(await padHas(page, a, noteId), "A's frame, with the note, is A's again")
    await page.screenshot({ path: join(shots, '3-trazido-de-volta.png') })

    // ---- 4. live row: click brings the panel up; right-click is the tab's menu ----
    await page.evaluate(id => window.__tether.activatePanel(id), b)
    await ensureManager(page)
    await page.waitForSelector(row(key(a)))
    m = (await manager(page))!
    assert.ok(!m.rows[0]!.loose, 'a live row')
    await barShape(page, key(a), 'primary', 'Focar guia')
    // A click only selects; a double click goes to the tab.
    await page.click(`${row(key(a))} .pf-r-head`)
    await sleep(300)
    assert.equal(await page.evaluate(() => window.__tether.focusablePanel()), b, 'a click does not change the focused panel')
    assert.equal((await manager(page))!.selected, key(a), 'a click selects')
    await page.dblclick(`${row(key(a))} .pf-r-head`)
    await page.waitForFunction(id => window.__tether.focusablePanel() === id, a, { timeout: 5_000 })
    await ensureManager(page)
    await page.evaluate(id => window.__tether.activatePanel(id), b)
    await menuNearButton(page, key(a), '4b-menu-aberto.png')
    await page.locator(row(key(a))).click({ button: 'right' })
    await page.waitForSelector('#ctx-menu')
    const items = await page.locator('#ctx-menu li[role="menuitem"]').allInnerTexts()
    assert.ok(items.some(t => t.includes('Fechar painel')), `the tab's menu: ${JSON.stringify(items)}`)
    await page.screenshot({ path: join(shots, '4-menu-da-guia.png') })
    await page.keyboard.press('Escape')
    await page.waitForSelector('#ctx-menu', { state: 'detached', timeout: 2_000 }).catch(() => {})
    // The ⋯ of a live row opens the same tab menu.
    await ensureManager(page)
    await page.click(`${row(key(a))} .pf-act.more`)
    await page.waitForSelector('#ctx-menu')
    const moreItems = await page.locator('#ctx-menu li[role="menuitem"]').allInnerTexts()
    assert.ok(moreItems.some(t => t.includes('Fechar painel')), `the ⋯ of a live row: ${JSON.stringify(moreItems)}`)
    await page.keyboard.press('Escape')
    await page.waitForSelector('#ctx-menu', { state: 'detached', timeout: 2_000 })

    // ---- 5. dragging the row to the desk's right edge splits the desk, like the tab ----
    await ensureManager(page)
    const before = await groups(page)
    const target = page.locator('#dock .dv-dockview').first()
    const box = (await target.boundingBox())!
    await page.locator(row(key(a))).dragTo(target, { targetPosition: { x: box.width - 12, y: box.height / 2 } })
    for (let i = 0; i < 50 && (await groups(page)) <= before; i++) await sleep(100)
    await page.screenshot({ path: join(shots, '5-arrastado.png') })
    assert.ok((await groups(page)) > before, `the desk got a new group from the row (${before} → ${await groups(page)})`)
    assert.ok((await page.evaluate(() => window.__tether.panelIds())).includes(a), 'A moved, not closed')
    await page.screenshot({ path: join(shots, '5-arrastado.png') })

    // ---- 6. another desk lists none of this one's panels ----
    const d1 = await page.evaluate(() => window.__tether.activeDesk())
    const d2 = await page.evaluate(d => window.__tether.createDesk('after', d), d1)
    await page.evaluate(d => window.__tether.switchDesk(d), d2)
    await page.evaluate(() => window.__tether.openPanelPadManager('all'))
    await page.waitForFunction(() => (window.__tether.panelPadManager()[0]?.rows.length ?? -1) === 0, undefined, { timeout: 5_000 })
    await page.screenshot({ path: join(shots, '6-outra-mesa.png') })
    await page.evaluate(d => window.__tether.switchDesk(d), d1)

    // ---- 6b. dragging a loose row onto the desk's edge brings the panel back there ----
    await page.evaluate(id => window.__tether.activatePanel(id), a)
    await closePane(page, a)
    await page.waitForFunction(() => window.__tether.panelFramesTree().loose.length === 1)
    await page.evaluate(k => window.__tether.openPanelPadManager('all', k), key(a))
    await page.waitForSelector(row(key(a)))
    assert.equal(await page.locator(row(key(a))).getAttribute('draggable'), 'true', 'a loose row is draggable')
    const target2 = page.locator('#dock .dv-dockview').first()
    const box2 = (await target2.boundingBox())!
    await page.locator(row(key(a))).dragTo(target2, { targetPosition: { x: box2.width - 12, y: box2.height / 2 } })
    await page.waitForFunction(id => window.__tether.panelIds().includes(id), a, { timeout: 5_000 })
    await page.waitForFunction(() => window.__tether.panelFramesTree().loose.length === 0, undefined, { timeout: 5_000 })
    await page.screenshot({ path: join(shots, '6b-solto-arrastado.png') })

    // ---- 7. a loose row's "Fechar painel…": the close dialog, then frame and record gone ----
    await page.evaluate(id => window.__tether.activatePanel(id), a)
    await closePane(page, a)
    await page.waitForFunction(() => window.__tether.panelFramesTree().loose.length === 1)
    await page.evaluate(k => window.__tether.openPanelPadManager('all', k), key(a))
    await page.click(`${row(key(a))} .pf-act.more`)
    await page.locator('#ctx-menu li[role="menuitem"]', { hasText: 'Fechar painel' }).click()
    await page.locator('dialog[open] button.choice[data-choice="detach"]').click()
    await page.waitForSelector(row(key(a)), { state: 'detached', timeout: 5_000 })
    await page.waitForFunction(() => window.__tether.panelFramesTree().loose.length === 0)
    let saved: LayoutJSON | undefined
    for (let i = 0; i < 40; i++) {
      saved = JSON.parse(readFileSync(join(home, 'layout.json'), 'utf8')) as LayoutJSON
      if (!saved.sidebars?.meta?.[key(a)]) break
      await sleep(100)
    }
    assert.equal(saved!.sidebars?.meta?.[key(a)], undefined, "A's record went with its frame")
    await page.screenshot({ path: join(shots, '7-quadro-fechado.png') })

    // ---- 8. the keyboard and the switch ----
    await page.evaluate(id => window.__tether.activatePanel(id), b)
    if (await managerOn(page)) await page.click(`${shown} .tab-act[data-action="frames-manager"]`)
    await page.waitForFunction(() => !window.__tether.panelPadManagerOn())
    await page.locator(`.panel[data-slot-id="${b}"] .xterm-screen`).click()
    await page.waitForFunction(() => !!document.activeElement?.closest('.xterm'))
    await page.keyboard.press('Control+Shift+M')
    await page.waitForFunction(() => window.__tether.panelPadManagerOn(), undefined, { timeout: 5_000 })
    await page.locator(`${inPad} .pf-list`).focus()
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !window.__tether.panelPadManagerOn(), undefined, { timeout: 5_000 })
    await page.click(`${shown}[data-panel="${b}"] .tab-act[data-action="frames-manager"]`)
    await page.waitForSelector(`${shown}[data-panel="${b}"] .pad-manager.pf-pane:not([hidden])`, { state: 'visible' })
    const barBox = (await page.locator(`${shown}[data-panel="${b}"] .dv-tabs-and-actions-container:visible`).first().boundingBox())!
    const mgrBox = (await page.locator(inPad).boundingBox())!
    await page.screenshot({ path: join(shots, '8-botao-fixo.png') })
    assert.ok(await page.locator('.toolbar, #toolbar, #topbar, header').first().isVisible().catch(() => true), 'the top bar stays')
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('*')].filter(e => e.scrollTop > 0 && !e.closest('.pf-list, .xterm')).map(e => e.id || e.className).join(',')), '', 'nothing outside the list was scrolled')
    assert.ok(Math.abs(mgrBox.y - (barBox.y + barBox.height)) <= 1, `the manager starts where the tab bar ends (${mgrBox.y} vs ${barBox.y}+${barBox.height})`)
    await page.click(`${shown}[data-panel="${b}"] .tab-act[data-action="frames-manager"]`)
    await page.waitForFunction(() => !window.__tether.panelPadManagerOn(), undefined, { timeout: 5_000 })

    // ---- 9. affinity: the settings opened with the pad in focus land on the desk ----
    await page.click(`${shown}[data-panel="${b}"] .frame-dock`)
    await page.keyboard.press('Control+,')
    await page.waitForFunction(() => window.__tether.panelIds().some(id => id.startsWith('settings:')), undefined, { timeout: 5_000 })
    assert.ok(!(await page.evaluate(() => window.__tether.padFrames())).some(f => f.panes.some(p => p.startsWith('settings:'))), 'the settings are not inside a pad')
  } finally {
    if (app) await killElectron(app, root).catch(() => {})
    for (const p of daemons) await killOwned(p, { tree: true })
    for (let i = 0; i < 20 && daemons.some(p => pidAlive(p.pid)); i++) await sleep(500)
    for (let i = 0; i < 5; i++) { try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(300) } }
  }
})
