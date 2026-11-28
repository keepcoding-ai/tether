// E2E of phase C (desks), with shells only (hidden window, private home/pipe, real tetherd, CLAUDE* stripped):
//   1. three desks with one PowerShell each: Ctrl+Shift+N creates a desk after the current one;
//   2. switching by Ctrl+1…3 and Ctrl+Tab / Ctrl+Shift+Tab; only the active layer is visible;
//   3. a shell on a hidden desk keeps printing into its terminal (same PID, same size: nothing resized);
//   4. "Mover…" from the tab's menu moves a pane (as a tab of desk 1) (same PID, its screen still there);
//   5. strip: rename in place, recolour, Ctrl+Alt+Shift+N before;
//   6. closing a desk with a running shell asks with the app's dialog: "move" keeps it on the neighbour desk;
//      "stop" ends it (the slot stays under "Slots fechados"); an empty desk closes without asking;
//   7. window kill + relaunch: same desks (ids, names, colours, order), same active desk, panes on the same
//      desks, same PIDs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'
import { stopPtyd } from './ptyd-driver.ts'

type DeskRow = { id: string; name: string; color: string; panes: string[]; attention: { done: number; waiting: number } }
type Hooks = {
  panelIds(): string[]
  activeId(): string | undefined
  runCommand(id: string): Promise<'ran' | 'unknown' | 'unavailable'>
  slots(): SlotState[]
  text(id: string): string
  connection(): { connected: boolean; pid?: number } | undefined
  activate(id: string): void
  desks(): DeskRow[]
  activeDesk(): string
  deskOf(slotId: string): string | undefined
  switchDesk(id: string): void
  recolorDesk(id: string, color: string): void
  closeDesk(id: string): void
}
declare const window: { __tether: Hooks; tether: { notice(n: unknown): void } }
declare const document: { querySelectorAll(selector: string): { length: number } }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const artifacts = join(root, 'test', 'e2e', 'artifacts')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-desks-${process.pid}`

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
  env.TETHER_CLAUDE_ARGS = '--model haiku'
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10_000)
  page.on('pageerror', e => console.error(`renderer error: ${e.message}`))
  page.on('console', m => { if (m.type() === 'error') console.error(`renderer console: ${m.text()}`) })
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  return { app, page }
}

const h = {
  ids: (page: Page) => page.evaluate(() => window.__tether.panelIds()),
  desks: (page: Page) => page.evaluate(() => window.__tether.desks()),
  active: (page: Page) => page.evaluate(() => window.__tether.activeDesk()),
  deskOf: (page: Page, id: string) => page.evaluate(id => window.__tether.deskOf(id), id),
  slots: (page: Page) => page.evaluate(() => window.__tether.slots()),
  text: (page: Page, id: string) => page.evaluate(id => window.__tether.text(id), id),
  daemonPid: async (page: Page) => (await page.evaluate(() => window.__tether.connection()))?.pid,
}

async function waitTabs(page: Page, n: number): Promise<void> {
  await page.waitForFunction(n => document.querySelectorAll('.tether-tab').length === n, n)
}

async function pidsOf(page: Page, ids: string[]): Promise<Record<string, number>> {
  await page.waitForFunction(ids => ids.every(id => { const s = window.__tether.slots().find(x => x.slotId === id); return s?.status === 'running' && typeof s.pid === 'number' }), ids, { timeout: 20_000 })
  const out: Record<string, number> = {}
  for (const s of await h.slots(page)) if (ids.includes(s.slotId)) out[s.slotId] = s.pid!
  return out
}

/** A PowerShell in the active desk through the chooser; returns its pane id. */
async function createShell(page: Page, cwd: string): Promise<string> {
  const before = await h.ids(page)
  await page.click('#btn-new')
  await page.waitForSelector('#dlg-new[open]')
  await page.fill('#dlg-new .ch-path-input', cwd)
  await page.click('#dlg-new .ch-item[data-id=\"powershell\"]')
  await page.click('#dlg-new .btn.primary.go') // two steps: the click selects, the button opens
  await page.waitForFunction(() => document.querySelectorAll('#dlg-new[open]').length === 0)
  // On a fresh desk the new pane takes the place of the blank pane (the tab count does not grow): wait for the new id.
  await page.waitForFunction(before => window.__tether.panelIds().some(id => !before.includes(id)), before)
  const added = (await h.ids(page)).filter(id => !before.includes(id))
  assert.equal(added.length, 1)
  return added[0]!
}

async function typeInto(page: Page, id: string, text: string): Promise<void> {
  await page.evaluate(([id, data]) => window.tether.notice({ t: 'input', slotId: id, data }), [id, text] as const)
}

async function expectActive(page: Page, deskId: string): Promise<void> {
  await page.waitForFunction(id => window.__tether.activeDesk() === id, deskId)
  // Exactly one visible layer, the active one; the others are still in the DOM.
  const vis = await page.evaluate(() => [...(globalThis as unknown as { document: { querySelectorAll(s: string): Iterable<{ dataset: { desk: string }; classList: { contains(c: string): boolean } }> } }).document.querySelectorAll('.desk-layer')].map(l => [l.dataset.desk, !l.classList.contains('inactive')]))
  assert.deepEqual(vis.filter(([, on]) => on).map(([d]) => d), [deskId], `only ${deskId} is visible`)
}

test('desks: create, switch by shortcut, hidden desk keeps output, move pane, close with dialog, relaunch', { timeout: 300_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(artifacts, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-desks-'))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    const daemonPid = (await h.daemonPid(page))!
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))

    // ---- 1. three desks, one shell each ----
    console.log('step 1')
    assert.deepEqual((await h.desks(page)).map(d => [d.id, d.name]), [['desk-1', 'Mesa 1']])
    await page.waitForSelector('#desk-switch .seg.on[data-desk="desk-1"]')
    const a = await createShell(page, root)
    await page.keyboard.press('Control+Shift+N')
    await expectActive(page, 'desk-2')
    const b = await createShell(page, root)
    await page.keyboard.press('Control+Shift+N')
    await expectActive(page, 'desk-3')
    const c = await createShell(page, root)
    const desks3 = await h.desks(page)
    assert.deepEqual(desks3.map(d => [d.id, d.name, d.panes]), [['desk-1', 'Mesa 1', [a]], ['desk-2', 'Mesa 2', [b]], ['desk-3', 'Mesa 3', [c]]])
    assert.equal(new Set(desks3.map(d => d.color)).size, 3, 'each new desk gets its own colour')
    assert.deepEqual(desks3.map(d => d.color), ['blue', 'green', 'orange'], 'a fresh app starts blue, then the old order')
    const pids = await pidsOf(page, [a, b, c])
    await page.screenshot({ path: join(artifacts, 'desks-three.png') })

    // ---- 2. switching by shortcut (the keyboard is in a terminal: the chord must still reach the app) ----
    console.log('step 2')
    await page.locator(`.panel[data-slot-id="${c}"] .panel-term`).click()
    await page.keyboard.press('Control+1'); await expectActive(page, 'desk-1')
    await page.keyboard.press('Control+Tab'); await expectActive(page, 'desk-2')
    await page.keyboard.press('Control+Tab'); await expectActive(page, 'desk-3')
    await page.keyboard.press('Control+Tab'); await expectActive(page, 'desk-1')
    await page.keyboard.press('Control+Shift+Tab'); await expectActive(page, 'desk-3')
    await page.keyboard.press('Control+2'); await expectActive(page, 'desk-2')
    await page.waitForFunction(id => window.__tether.activeId() === id, b)
    assert.ok(!(await h.text(page, b)).includes('\x00'), 'no control code leaked')

    // ---- 3. output keeps flowing into a hidden desk's shell; nothing resized ----
    console.log('step 3')
    const sizeOf = (id: string) => page.evaluate(id => { const el = (globalThis as unknown as { document: { querySelector(s: string): { clientWidth: number; clientHeight: number } | null } }).document.querySelector(`.panel[data-slot-id="${id}"] .panel-term`); return el ? [el.clientWidth, el.clientHeight] : undefined }, id)
    const sizeA = await sizeOf(a)
    await typeInto(page, a, '1..40 | % { Write-Host "tick-$_"; Start-Sleep -Milliseconds 150 }\r')
    await page.keyboard.press('Control+3'); await expectActive(page, 'desk-3')
    // A hidden terminal receives no output (performance.hiddenPanes, on by default): the shell keeps running and
    // the missing output is delivered, complete and in order, when the desk is shown again.
    await sleep(8_000) // the loop runs ~6 s
    assert.equal(await h.deskOf(page, a), 'desk-1')
    assert.deepEqual(await sizeOf(a), sizeA, 'the hidden pane keeps its size (no resize sent to the shell)')
    assert.equal((await pidsOf(page, [a]))[a], pids[a], 'same shell')
    await page.keyboard.press('Control+1'); await expectActive(page, 'desk-1')
    await page.waitForFunction(id => window.__tether.text(id).includes('tick-40'), a, { timeout: 30_000 })
    const shown = await h.text(page, a)
    assert.ok(shown.includes('tick-2') && shown.indexOf('tick-2') < shown.lastIndexOf('tick-40'), 'the output arrives from the start, in order')
    await page.keyboard.press('Control+3'); await expectActive(page, 'desk-3')

    // ---- 4. "Mover…" from the tab's menu: a tab of desk 1's frame ----
    console.log('step 4')
    await typeInto(page, c, 'Write-Host marca-c\r')
    await page.waitForFunction(id => window.__tether.text(id).includes('marca-c'), c)
    const tabC = page.locator('.desk-layer[data-desk="desk-3"] .tether-tab')
    await tabC.click({ button: 'right' })
    await page.click('#ctx-menu li:has-text("Mover…")')
    await page.waitForSelector('dialog.move[open]')
    await page.click('dialog.move .mv-row.f[data-scope="desk-1"]')
    await page.click('dialog.move .mv-pn .z-tab')
    await page.screenshot({ path: join(artifacts, 'desks-move-menu.png') })
    await page.click('#mv-go')
    await page.waitForFunction(id => window.__tether.deskOf(id) === 'desk-1', c)
    await page.waitForFunction(id => window.__tether.text(id).includes('marca-c'), c) // the new terminal got the scrollback
    assert.equal((await pidsOf(page, [c]))[c], pids[c], 'moving never touches the process')
    assert.deepEqual((await h.desks(page)).find(d => d.id === 'desk-3')!.panes, [])

    // ---- 5. capsule: rename in place, recolour, move right by the menu, a desk before ----
    console.log('step 5')
    await page.dblclick('#desk-switch .seg[data-desk="desk-1"]')
    await page.waitForSelector('#desk-switch input.desk-rename')
    await page.fill('#desk-switch input.desk-rename', 'Cliente X')
    await page.keyboard.press('Enter')
    await page.waitForSelector('#desk-switch .seg[data-desk="desk-1"]:has-text("Cliente X")')
    await page.click('#desk-switch .seg[data-desk="desk-2"]', { button: 'right' })
    await page.click('#ctx-menu li:has-text("Cor…")')
    assert.equal(await page.locator('#desk-colors .swatch').count(), 12, 'the picker offers the 12 hues')
    await page.click('#desk-colors .swatch[data-color="cyan"]')
    assert.equal((await h.desks(page)).find(d => d.id === 'desk-2')!.color, 'cyan')
    // Reordering is in the desk's menu (no drag): desk-1 moves right, then back left.
    await page.click('#desk-switch .seg[data-desk="desk-1"]', { button: 'right' })
    await page.click('#ctx-menu li:has-text("Mover para a direita")')
    assert.deepEqual((await h.desks(page)).map(d => d.id), ['desk-2', 'desk-1', 'desk-3'])
    assert.equal(await page.locator('#desk-switch .seg[draggable="true"]').count(), 0, 'segments are not draggable')
    await page.click('#desk-switch .seg[data-desk="desk-1"]', { button: 'right' })
    await page.click('#ctx-menu li:has-text("Mover para a esquerda")')
    assert.deepEqual((await h.desks(page)).map(d => d.id), ['desk-1', 'desk-2', 'desk-3'])
    await page.keyboard.press('Control+2'); await expectActive(page, 'desk-2')
    await page.evaluate(() => window.__tether.runCommand('desk.new-before'))
    await expectActive(page, 'desk-4')
    assert.deepEqual((await h.desks(page)).map(d => d.id), ['desk-1', 'desk-4', 'desk-2', 'desk-3'], 'the new desk sits before the current one')
    await page.screenshot({ path: join(artifacts, 'desks-strip.png') })

    // ---- 6. closing desks ----
    console.log('step 6')
    // An empty desk closes without asking.
    await page.evaluate(() => window.__tether.closeDesk('desk-4'))
    await page.waitForFunction(() => !window.__tether.desks().some(d => d.id === 'desk-4'))
    assert.equal(await page.locator('dialog.ask[open]').count(), 0)
    // desk-2 has a running shell: the dialog; "move" takes it to the right neighbour (desk-3).
    await page.click('#desk-switch .seg[data-desk="desk-2"]', { button: 'right' })
    await page.click('#ctx-menu li:has-text("Fechar mesa…")')
    const dlg = page.locator('dialog.ask[data-dialog="close-desk"][open]')
    await dlg.waitFor()
    assert.ok(await dlg.locator('button.choice.safe.default[data-choice="move"]').count() === 1, 'moving is the safe default')
    assert.ok(await dlg.locator('button.choice.destructive[data-choice="stop"]').count() === 1, 'stopping is destructive')
    assert.match((await dlg.locator('button.choice[data-choice="move"]').textContent())!, /Mesa 3/)
    await page.screenshot({ path: join(artifacts, 'desks-close-dialog.png') })
    await dlg.locator('button.choice[data-choice="move"]').click()
    await page.waitForFunction(() => !window.__tether.desks().some(d => d.id === 'desk-2'))
    assert.equal(await h.deskOf(page, b), 'desk-3')
    assert.equal((await pidsOf(page, [b]))[b], pids[b], 'the moved shell still runs')
    // A new desk with a shell, closed with "stop": the shell ends, its slot stays (Slots fechados).
    await page.keyboard.press('Control+Shift+N')
    const d = await createShell(page, root)
    const deskD = (await h.deskOf(page, d))!
    assert.equal(deskD, 'desk-5', 'a closed desk\'s id (desk-2, desk-4) never comes back (RR5 M-1)')
    const pidD = (await pidsOf(page, [d]))[d]!
    await page.evaluate(id => window.__tether.closeDesk(id), deskD)
    await dlg.waitFor()
    await dlg.locator('button.choice[data-choice="stop"]').click()
    await page.waitForFunction(id => !window.__tether.desks().some(x => x.id === id), deskD)
    await page.waitForFunction(id => { const s = window.__tether.slots().find(x => x.slotId === id); return s !== undefined && s.status !== 'running' }, d, { timeout: 20_000 })
    assert.ok(!(await h.ids(page)).includes(d), 'the pane is gone')
    for (let i = 0; i < 40 && pidAlive(pidD); i++) await sleep(250)
    assert.ok(!pidAlive(pidD), 'the stopped shell is gone')

    // ---- 7. relaunch ----
    console.log('step 7')
    await page.keyboard.press('Control+1'); await expectActive(page, 'desk-1')
    await page.evaluate(() => window.__tether.recolorDesk('desk-3', 'purple'))
    await sleep(800) // debounced save
    const before = await h.desks(page)
    const saved = JSON.parse(readFileSync(join(home, 'layout.json'), 'utf8')) as { desks: { id: string; name: string; color: string }[]; activeDesk: string; deskSeq?: number }
    assert.deepEqual(saved.desks.map(x => [x.id, x.name, x.color]), before.map(x => [x.id, x.name, x.color]))
    assert.equal(saved.activeDesk, 'desk-1')
    assert.equal(saved.deskSeq, 5, 'the desk counter is kept with the layout')
    await killElectron(app, root)
    app = undefined
    ;({ app, page } = await launch(home))
    assert.equal(await h.daemonPid(page), daemonPid, 'same tetherd')
    await waitTabs(page, 3)
    const after = await h.desks(page)
    assert.deepEqual(after.map(x => [x.id, x.name, x.color, [...x.panes].sort()]), before.map(x => [x.id, x.name, x.color, [...x.panes].sort()]), 'same desks, same panes on each')
    await expectActive(page, 'desk-1')
    const pidsAfter = await pidsOf(page, [a, b, c])
    assert.deepEqual(pidsAfter, { [a]: pids[a], [b]: pids[b], [c]: pids[c] }, 'same PIDs through the window kill')
    await page.waitForFunction(id => window.__tether.text(id).includes('tick-40'), a)
    await page.screenshot({ path: join(artifacts, 'desks-restored.png') })

    // ---- 8. a layout.json written before the 12-hue palette: numbers read as the old palette, saved back as names ----
    console.log('step 8')
    await killElectron(app, root)
    app = undefined
    const file = join(home, 'layout.json')
    const old = JSON.parse(readFileSync(file, 'utf8')) as { desks: { id: string; color: unknown }[] }
    const OLD_INDEX: Record<string, number> = { 'desk-1': 3, 'desk-3': 7 }
    for (const d of old.desks) d.color = OLD_INDEX[d.id]
    writeFileSync(file, JSON.stringify(old))
    ;({ app, page } = await launch(home))
    await waitTabs(page, 3)
    assert.deepEqual((await h.desks(page)).map(d => [d.id, d.color]), [['desk-1', 'red'], ['desk-3', 'sky']], 'old indexes 3 and 7 read as red (never lime) and sky')
    assert.ok(typeof (JSON.parse(readFileSync(file, 'utf8')) as { desks: { color: unknown }[] }).desks[0]!.color === 'number', 'reading alone does not rewrite the file')
    await page.evaluate(() => window.__tether.recolorDesk('desk-1', 'red')) // a person's change: the next save writes names
    await sleep(900)
    assert.deepEqual((JSON.parse(readFileSync(file, 'utf8')) as { desks: { id: string; color: unknown }[] }).desks.map(d => d.color), ['red', 'sky'], 'saved back as names')
  } finally {
    console.log('teardown')
    if (app) await killElectron(app, root).catch(() => {})
    console.log('teardown: electron gone')
    for (const d of daemons) await killOwned(d, { tree: true })
    await stopPtyd(home)
    console.log('teardown: daemon gone')
    for (let i = 0; i < 20 && daemons.some(d => pidAlive(d.pid)); i++) await sleep(500)
    for (let i = 0; i < 5; i++) {
      try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
  }
})
