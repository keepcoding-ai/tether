// E2E of phase D (the drawer), with shells only (hidden window, private home/pipe, real tetherd, CLAUDE* stripped):
//   1. Ctrl+` opens the drawer; being empty it opens a shell in the folder of the pane it came from; the desks
//      behind are inert and the shell has the keyboard; Ctrl+` closes it and the focus goes back to the pane;
//   2. a shell in the closed drawer keeps printing (same PID, same size: nothing resized);
//   3. the Esc rule: one Esc on the chrome closes; in a shell at its prompt only a double Esc closes; on the
//      alternate screen (vim) never; a dialog's Esc is the dialog's;
//   4. clicking the backdrop closes, clicking inside does not; Ctrl+Tab stays quiet while it is open;
//   5. moving work: pane desk → drawer → current desk from the tab's menu (same PID, screen kept), a whole
//      frame by the app's hooks, and the drawer is the same one from every desk;
//   6. attention of a drawer pane shows on the toolbar button; the tray's "Abrir gaveta" opens it;
//   7. window kill + relaunch: the drawer's panes come back in the drawer (closed), same PIDs, output flowing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type DrawerInfo = { open: boolean; panes: string[]; frames: string[]; attention: { done: number; waiting: number } }
type Hooks = {
  panelIds(): string[]
  slots(): SlotState[]
  text(id: string): string
  connection(): { connected: boolean; pid?: number } | undefined
  activeDesk(): string
  deskOf(slotId: string): string | undefined
  switchDesk(id: string): void
  applyState(slot: SlotState): void
  inject(slotId: string, data: string): void
  drawer(): DrawerInfo
  inDrawer(slotId: string): boolean
  moveFrameToDrawer(slotId: string): void
  moveFrameFromDrawer(slotId: string): void
  layout(): { drawer: { frames: { views: Record<string, { panels: Record<string, unknown> }> } } | null }
}
type Doc = {
  querySelectorAll(selector: string): { length: number }
  querySelector(selector: string): { clientWidth: number; clientHeight: number; hasAttribute(n: string): boolean; getAttribute(n: string): string | null; textContent: string | null; hidden: boolean } | null
  activeElement: { closest(selector: string): { getAttribute(n: string): string | null } | null; id: string } | null
}
declare const window: { __tether: Hooks; tether: { notice(n: unknown): void }; getComputedStyle(el: unknown): { visibility: string } }
declare const document: Doc
type TrayHook = { command(id: string): void; model(): { items: { kind: string; id?: string; label?: string }[] } }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const artifacts = join(root, 'test', 'e2e', 'artifacts')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-drawer-${process.pid}`

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
  page.on('console', m => { if (m.type() === 'error') console.error(`renderer console: ${m.text()}`) })
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  return { app, page }
}

const h = {
  drawer: (page: Page) => page.evaluate(() => window.__tether.drawer()),
  ids: (page: Page) => page.evaluate(() => window.__tether.panelIds()),
  slots: (page: Page) => page.evaluate(() => window.__tether.slots()),
  text: (page: Page, id: string) => page.evaluate(id => window.__tether.text(id), id),
  daemonPid: async (page: Page) => (await page.evaluate(() => window.__tether.connection()))?.pid,
  /** The pane whose terminal has the keyboard. */
  focused: (page: Page) => page.evaluate(() => document.activeElement?.closest('.panel')?.getAttribute('data-slot-id') ?? null),
  sizeOf: (page: Page, id: string) => page.evaluate(id => { const el = document.querySelector(`.panel[data-slot-id="${id}"] .panel-term`); return el ? [el.clientWidth, el.clientHeight] : undefined }, id),
  visibility: (page: Page, selector: string) => page.evaluate(sel => { const el = document.querySelector(sel); return el ? window.getComputedStyle(el).visibility : 'missing' }, selector),
  inert: (page: Page, selector: string) => page.evaluate(sel => document.querySelector(sel)?.hasAttribute('inert') ?? false, selector),
}

async function waitDrawer(page: Page, open: boolean): Promise<void> {
  await page.waitForFunction(open => window.__tether.drawer().open === open, open)
  // The panel is on screen only while open (the slide takes 200 ms; the visibility flips at its end when closing).
  await page.waitForFunction(([open]) => (window.getComputedStyle(document.querySelector('#drawer')).visibility === 'visible') === open, [open] as const)
}

async function pidsOf(page: Page, ids: string[]): Promise<Record<string, number>> {
  await page.waitForFunction(ids => ids.every(id => { const s = window.__tether.slots().find(x => x.slotId === id); return s?.status === 'running' && typeof s.pid === 'number' }), ids, { timeout: 20_000 })
  const out: Record<string, number> = {}
  for (const s of await h.slots(page)) if (ids.includes(s.slotId)) out[s.slotId] = s.pid!
  return out
}

/** A PowerShell in the visible desk through the chooser (drawer closed); returns its pane id. */
async function createShell(page: Page, cwd: string): Promise<string> {
  const before = await h.ids(page)
  await page.keyboard.press('Control+Shift+T')
  await page.waitForSelector('#dlg-new[open]')
  await page.check('input[name=profile][value=powershell]')
  await page.fill('#new-cwd', cwd)
  await page.click('#btn-create')
  await page.waitForFunction(n => window.__tether.panelIds().length === n, before.length + 1)
  const added = (await h.ids(page)).filter(id => !before.includes(id))
  assert.equal(added.length, 1)
  return added[0]!
}

async function typeInto(page: Page, id: string, text: string): Promise<void> {
  await page.evaluate(([id, data]) => window.tether.notice({ t: 'input', slotId: id, data }), [id, text] as const)
}

async function openDrawer(page: Page): Promise<void> {
  await page.keyboard.press('Control+Backquote')
  await waitDrawer(page, true)
}

async function closeDrawerByShortcut(page: Page): Promise<void> {
  await page.keyboard.press('Control+Backquote')
  await waitDrawer(page, false)
}

/** Waits for the keyboard to be in `slotId`'s terminal (focus moves a frame after the drawer opens). */
async function expectFocus(page: Page, slotId: string): Promise<void> {
  await page.waitForFunction(id => document.activeElement?.closest('.panel')?.getAttribute('data-slot-id') === id, slotId)
}

test('drawer: toggle, quick shell, output while closed, Esc rule, backdrop, moves, tray, relaunch', { timeout: 300_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(artifacts, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-drawer-'))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    const daemonPid = (await h.daemonPid(page))!
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))

    // ---- 1. toggle, quick shell, focus ----
    console.log('step 1')
    assert.deepEqual(await h.drawer(page), { open: false, panes: [], frames: ['frame-1'], attention: { done: 0, waiting: 0 } })
    assert.equal(await h.visibility(page, '#drawer'), 'hidden')
    assert.equal(await h.inert(page, '#drawer'), true, 'a closed drawer takes no focus and no clicks')
    const a = await createShell(page, root)
    await pidsOf(page, [a])
    await page.locator(`.panel[data-slot-id="${a}"] .panel-term`).click()
    await expectFocus(page, a)

    await openDrawer(page)
    assert.equal(await h.inert(page, '#dock'), true, 'the desks behind are inert while it is open')
    assert.equal(await h.inert(page, '#toolbar'), true)
    await page.waitForFunction(() => window.__tether.drawer().panes.length === 1)
    const [d] = (await h.drawer(page)).panes as [string]
    const dSlot = (await h.slots(page)).find(s => s.slotId === d)!
    assert.equal(dSlot.kind, 'shell', 'an empty drawer opens a shell')
    assert.equal(dSlot.cwd.toLowerCase(), root.toLowerCase(), 'in the folder of the pane it came from')
    const pids = await pidsOf(page, [a, d])
    await expectFocus(page, d)
    await sleep(800)
    assert.equal((await h.drawer(page)).panes.length, 1, 'one quick shell, not more')
    assert.deepEqual(await h.ids(page), [a], 'the desk still holds only its own pane')
    await page.screenshot({ path: join(artifacts, 'drawer-open.png') })
    const sizeOpen = await h.sizeOf(page, d)
    await typeInto(page, d, 'Write-Host marca-gaveta\r')
    await page.waitForFunction(id => window.__tether.text(id).includes('marca-gaveta'), d)

    // ---- 2. closed: output keeps flowing, nothing resized, the focus goes back ----
    console.log('step 2')
    await typeInto(page, d, '1..40 | % { Write-Host "gaveta-tick-$_"; Start-Sleep -Milliseconds 150 }\r')
    await closeDrawerByShortcut(page)
    await expectFocus(page, a)
    assert.equal(await h.inert(page, '#dock'), false)
    assert.equal(await h.visibility(page, '#drawer'), 'hidden')
    await page.waitForFunction(id => window.__tether.text(id).includes('gaveta-tick-40'), d, { timeout: 30_000 })
    assert.deepEqual(await h.sizeOf(page, d), sizeOpen, 'the closed drawer keeps its pane size (no resize sent to the shell)')
    assert.equal((await pidsOf(page, [d]))[d], pids[d], 'same shell')
    await page.screenshot({ path: join(artifacts, 'drawer-closed.png') })

    // ---- 3. the Esc rule ----
    console.log('step 3')
    await openDrawer(page)
    await expectFocus(page, d)
    await page.keyboard.press('Escape')
    await sleep(150)
    assert.equal((await h.drawer(page)).open, true, 'one Esc in a shell goes to the shell')
    await sleep(800) // the window of a double Esc passes
    await page.keyboard.press('Escape')
    await sleep(150)
    assert.equal((await h.drawer(page)).open, true, 'two Esc too far apart are two first ones')
    await sleep(800)
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await waitDrawer(page, false)
    await expectFocus(page, a)
    // a program on the alternate screen (vim, less) keeps every Esc
    await openDrawer(page)
    await expectFocus(page, d)
    await page.evaluate(id => window.__tether.inject(id, '\x1b[?1049h'), d)
    await sleep(800)
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await sleep(300)
    assert.equal((await h.drawer(page)).open, true, 'on the alternate screen Esc is the program\'s')
    await page.evaluate(id => window.__tether.inject(id, '\x1b[?1049l'), d)
    await sleep(800)
    // a dialog's Esc is the dialog's
    await page.keyboard.press('Control+Shift+T')
    await page.waitForSelector('#dlg-new[open]')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => document.querySelectorAll('#dlg-new[open]').length === 0)
    assert.equal((await h.drawer(page)).open, true, 'Esc closed the chooser, not the drawer')
    // on the chrome one Esc is enough
    await page.focus('#drawer-new')
    await page.keyboard.press('Escape')
    await waitDrawer(page, false)
    await expectFocus(page, a)

    // ---- 4. backdrop; desk shortcuts stay quiet behind the drawer ----
    console.log('step 4')
    await openDrawer(page)
    const desk1 = await page.evaluate(() => window.__tether.activeDesk())
    await page.keyboard.press('Control+Alt+N')
    await page.keyboard.press('Control+Tab')
    await sleep(200)
    assert.deepEqual([await page.evaluate(() => window.__tether.activeDesk()), await page.evaluate(() => document.querySelectorAll('.desk-layer').length)], [desk1, 1], 'no desk was created or switched behind the drawer')
    await page.mouse.click(300, 300) // inside the panel
    await sleep(300)
    assert.equal((await h.drawer(page)).open, true, 'a click inside does not close it')
    await page.mouse.click(3, 300) // the 8 px gap: the backdrop
    await waitDrawer(page, false)
    await expectFocus(page, a)

    // ---- 5. moving work ----
    console.log('step 5')
    const b = await createShell(page, root)
    const bPid = (await pidsOf(page, [b]))[b]!
    await typeInto(page, b, 'Write-Host marca-b\r')
    await page.waitForFunction(id => window.__tether.text(id).includes('marca-b'), b)
    await page.locator(`.panel[data-slot-id="${b}"]`).first().waitFor()
    await page.locator(`.desk-layer[data-desk="${desk1}"] .tether-tab`).nth(1).click({ button: 'right' })
    await page.click('#ctx-menu li:has-text("Mover para a gaveta")')
    await page.waitForFunction(id => window.__tether.drawer().panes.includes(id), b)
    assert.ok(!(await h.ids(page)).includes(b), 'a pane is in one place only')
    await page.waitForFunction(id => window.__tether.text(id).includes('marca-b'), b) // the new terminal got the scrollback
    assert.equal((await pidsOf(page, [b]))[b], bPid, 'moving never touches the process')
    // the drawer is the same from every desk
    await page.keyboard.press('Control+Alt+N')
    await page.waitForFunction(() => window.__tether.activeDesk() !== 'desk-1')
    await openDrawer(page)
    assert.deepEqual([...(await h.drawer(page)).panes].sort(), [d, b].sort(), 'the same drawer from desk 2')
    await page.locator('.drawer .tether-tab').nth(1).click({ button: 'right' }) // b: the second tab
    const items = await page.locator('#ctx-menu li').allTextContents()
    assert.ok(items.some(t => t.includes('Mover para a mesa atual')) && items.some(t => t.includes('Mover quadro para a mesa atual')), 'the drawer\'s tab offers the way out')
    assert.ok(!items.some(t => t.includes('Mover para a gaveta')))
    await page.keyboard.press('Escape') // closes the menu only
    await page.waitForFunction(() => document.querySelectorAll('#ctx-menu').length === 0)
    assert.equal((await h.drawer(page)).open, true)
    await page.locator('.drawer .tether-tab').nth(1).click({ button: 'right' })
    await page.click('#ctx-menu li:has-text("Mover para a mesa atual")')
    await waitDrawer(page, false)
    assert.equal(await page.evaluate(id => window.__tether.deskOf(id), b), await page.evaluate(() => window.__tether.activeDesk()), 'it lands on the desk the user is on')
    assert.ok(!(await h.drawer(page)).panes.includes(b))
    await expectFocus(page, b)
    assert.equal((await pidsOf(page, [b]))[b], bPid)
    // a whole frame, by the hooks (desk 2 holds only b's frame)
    await page.evaluate(id => window.__tether.moveFrameToDrawer(id), b)
    await page.waitForFunction(id => window.__tether.inDrawer(id), b)
    assert.deepEqual(await h.ids(page), [a], 'desk 2 is empty now: only desk 1 holds a pane')
    await page.evaluate(id => window.__tether.moveFrameFromDrawer(id), b)
    await page.waitForFunction(id => !window.__tether.inDrawer(id), b)
    assert.equal((await pidsOf(page, [b]))[b], bPid)
    await page.waitForFunction(() => window.__tether.drawer().open === false)

    // ---- 6. attention on the button, and the tray ----
    console.log('step 6')
    const dState = (await h.slots(page)).find(s => s.slotId === d)!
    await page.evaluate(s => window.__tether.applyState(s), { ...dState, attention: 'done' } as SlotState)
    await page.waitForFunction(() => { const b = document.querySelector('#drawer-badge'); return !!b && !b.hidden && b.textContent === '1' && b.getAttribute('class')!.includes('done') })
    assert.deepEqual((await h.drawer(page)).attention, { done: 1, waiting: 0 })
    await page.evaluate(s => window.__tether.applyState(s), { ...dState, attention: 'waiting' } as SlotState)
    await page.waitForFunction(() => document.querySelector('#drawer-badge')!.getAttribute('class')!.includes('waiting'))
    await page.evaluate(s => window.__tether.applyState(s), { ...dState, attention: undefined } as SlotState)
    await page.waitForFunction(() => document.querySelector('#drawer-badge')!.hidden)
    type G = { __tetherTray: TrayHook }
    const model = await app.evaluate(() => (globalThis as unknown as G).__tetherTray.model())
    assert.ok(model.items.some(i => i.kind === 'command' && i.id === 'open-drawer' && i.label === 'Abrir gaveta'), 'the tray has "Abrir gaveta"')
    await app.evaluate(() => { (globalThis as unknown as G).__tetherTray.command('open-drawer') })
    await waitDrawer(page, true)
    await closeDrawerByShortcut(page)
    await page.click('#btn-drawer')
    await waitDrawer(page, true)
    await page.click('#drawer-close')
    await waitDrawer(page, false)

    // ---- 7. relaunch ----
    console.log('step 7')
    await typeInto(page, d, 'Write-Host marca-antes-do-kill\r')
    await page.waitForFunction(id => window.__tether.text(id).includes('marca-antes-do-kill'), d)
    await sleep(800) // debounced save
    const saved = JSON.parse(readFileSync(join(home, 'layout.json'), 'utf8')) as { drawer: { frames: { views: Record<string, { panels: Record<string, unknown> }> } } | null }
    assert.deepEqual(Object.values(saved.drawer!.frames.views).flatMap(v => Object.keys(v.panels)), [d], 'the layout file keeps the drawer\'s pane')
    const deskPanes = await h.ids(page)
    await killElectron(app, root)
    app = undefined
    ;({ app, page } = await launch(home))
    assert.equal(await h.daemonPid(page), daemonPid, 'same tetherd')
    await page.waitForFunction(id => window.__tether.drawer().panes.includes(id), d)
    assert.deepEqual(await h.drawer(page).then(x => [x.open, x.panes]), [false, [d]], 'back in the drawer, which starts closed')
    assert.deepEqual(await h.ids(page), deskPanes, 'the desks are as they were')
    assert.deepEqual(await pidsOf(page, [a, b, d]), { ...pids, [b]: bPid }, 'same PIDs through the window kill')
    await page.waitForFunction(id => window.__tether.text(id).includes('marca-antes-do-kill'), d)
    await typeInto(page, d, 'Write-Host marca-depois\r') // closed: the pane is attached and receives
    await page.waitForFunction(id => window.__tether.text(id).includes('marca-depois'), d)
    await openDrawer(page)
    await expectFocus(page, d)
    await closeDrawerByShortcut(page)
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
