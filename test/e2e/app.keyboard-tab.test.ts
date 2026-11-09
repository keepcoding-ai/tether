// E2E of the tab marks (app/renderer/tab-marks.ts), real tetherd on a private home/pipe, hidden window. The keyboard mark
// (`.dv-tab.keyboard-tab`) is on ONE tab in the whole app, the tab of the pane that has the keyboard, at every step:
//   1. at start (one desk pane);
//   2. two frames on a desk: a click into the other frame's pane moves it;
//   3. two tabs in one frame: activating the other tab moves it;
//   4. a desk switch: the new desk's active pane has it, no tab on the hidden desk keeps it;
//   5. a click into a pad's pane: the pad's tab has it (the desk frame keeps its Foco de Mesa), a click back into the desk returns it;
//   6. the drawer open with a pane: the drawer's tab; closed: back on the desk's pane;
//   7. a note (Monaco) gets it the same way;
//   8. a tab dragged to another frame keeps a single mark;
//   9. attention: a tether://tab/<id> to a pane on another desk pulses that tab ~1.2 s, and the keyboard mark is on it.
// Screenshots (default and light theme) of the mark in a desk and in a pad land in artifacts/.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { tabUrl } from '../../app/shared/tether-url.ts'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type Hooks = {
  panelIds(): string[]
  slots(): SlotState[]
  connection(): { connected: boolean; pid?: number } | undefined
  activeId(): string | undefined
  currentPane(): string | undefined
  activeDesk(): string
  switchDesk(id: string): void
  createDesk(side: 'before' | 'after', relativeTo?: string): string
  drawer(): { open: boolean; panes: string[] }
  movePaneToDrawer(slotId: string): void
  openDrawer(): void
  closeDrawer(): void
  togglePad(id: string): void
  padFrames(): { pad: string; desk?: string; panes: string[]; shown: boolean }[]
  openSlotInPad(slotId: string, padId: string): void
  openFile(path: string): Promise<void>
  notes(): { id: string; path: string }[]
  frameOf(slotId: string): string | undefined
  frameIds(): string[]
  duplicate(slotId: string, direction: string, level?: string): void
}
type El = { getAttribute(n: string): string | null; closest(s: string): El | null; querySelector(s: string): El | null; classList: { contains(c: string): boolean } }
declare const window: { __tether: Hooks; tether: { request(r: unknown): Promise<{ t: string; slot?: SlotState }> } }
declare const document: { activeElement: El | null; querySelector(s: string): El | null; querySelectorAll(s: string): ArrayLike<El> }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const artifacts = join(root, 'test', 'e2e', 'artifacts')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-kbtab-${process.pid}`
const DESK_PAD = 'frame-pads.desk'

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
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800))
  return { app, page }
}

const ids = (page: Page) => page.evaluate(() => window.__tether.panelIds())
const tab = (id: string): string => `.tether-tab[data-slot="${id}"]`
const pane = (id: string): string => `.panel[data-slot-id="${id}"]`

async function createShell(page: Page, cwd: string): Promise<string> {
  const before = await ids(page)
  await page.click('#btn-new')
  await page.waitForSelector('#dlg-new[open]')
  await page.fill('#dlg-new .ch-path-input', cwd)
  await page.click('#dlg-new .ch-item[data-id="powershell"]')
  await page.click('#dlg-new .btn.primary.go') // two steps: the click selects, the button opens
  await page.waitForFunction(() => document.querySelectorAll('#dlg-new[open]').length === 0)
  await page.waitForFunction(n => window.__tether.panelIds().length === n, before.length + 1)
  const id = (await ids(page)).find(x => !before.includes(x))!
  await page.waitForFunction(id => window.__tether.slots().find(s => s.slotId === id)?.status === 'running', id, { timeout: 20_000 })
  return id
}

/** "Duplicar" at a level/placement; returns the new pane's id. */
async function duplicate(page: Page, from: string, placement: string, level: string): Promise<string> {
  const before = await ids(page)
  await page.evaluate(([id, p, l]) => window.__tether.duplicate(id!, p!, l), [from, placement, level] as const)
  await page.waitForFunction(n => window.__tether.panelIds().length === n, before.length + 1)
  return (await ids(page)).find(x => !before.includes(x))!
}

async function bareShell(page: Page, cwd: string): Promise<string> {
  const reply = await page.evaluate(cwd => window.tether.request({ t: 'create', kind: 'shell', cwd, start: true }), cwd)
  assert.equal(reply.t, 'ok')
  return reply.slot!.slotId
}

async function follow(app: ElectronApplication, url: string): Promise<void> {
  await app.evaluate(({ app }, url) => { app.emit('second-instance', {}, [process.execPath, url], process.cwd()) }, url)
}

/** What the marks look like right now: how many tabs carry the keyboard mark, whose tab, and the pane with the keyboard. */
function marks(page: Page) {
  return page.evaluate(() => {
    const all = document.querySelectorAll('.dv-tab.keyboard-tab')
    const marked = all.length ? all[0]!.querySelector('.tether-tab')?.getAttribute('data-slot') ?? null : null
    const g = document.activeElement?.closest('.dv-content-container')?.closest('.dv-groupview')
    const focused = g?.querySelector('.dv-tab.dv-active-tab .tether-tab')?.getAttribute('data-slot') ?? null
    return { count: all.length, marked, focused }
  })
}

/** Exactly one keyboard mark, on `id`'s tab, and the keyboard is inside `id`'s pane. */
async function expectMark(page: Page, id: string, step: string): Promise<void> {
  try {
    await page.waitForFunction(id => {
      const all = document.querySelectorAll('.dv-tab.keyboard-tab')
      if (all.length !== 1) return false
      if (all[0]!.querySelector('.tether-tab')?.getAttribute('data-slot') !== id) return false
      // The keyboard is inside the content of the group whose active tab is id's (a terminal or a note alike).
      const g = document.activeElement?.closest('.dv-content-container')?.closest('.dv-groupview')
      return g?.querySelector('.dv-tab.dv-active-tab .tether-tab')?.getAttribute('data-slot') === id
    }, id, { timeout: 5000 })
  } catch {
    assert.fail(`${step}: expected the single mark on ${id} with the keyboard; got ${JSON.stringify(await marks(page))}`)
  }
  await sleep(150) // stays put (no late repaint moves it)
  assert.deepEqual(await marks(page), { count: 1, marked: id, focused: id }, step)
}

async function clickInto(page: Page, id: string): Promise<void> {
  await page.locator(pane(id)).click({ position: { x: 60, y: 60 } })
}

async function setTheme(page: Page, t: string): Promise<void> {
  await page.click('#btn-theme')
  await page.waitForSelector('#theme-menu:not([hidden])')
  await page.click(`#theme-menu li[data-theme="${t}"]`)
  await page.waitForFunction(t => (document.querySelector('html') as unknown as { dataset: Record<string, string> }).dataset.theme === t, t)
}

test('tab marks: one keyboard mark on the tab of the pane with the keyboard (desks, pads, drawer, notes, moves); attention pulse', { timeout: 300_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(artifacts, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-kbtab-'))
  const base = mkdtempSync(join(tmpdir(), 'tether-kbt-'))
  const file = join(base, 'nota.md')
  writeFileSync(file, '# nota\n')
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    const daemonPid = (await page.evaluate(() => window.__tether.connection()))?.pid
    assert.ok(daemonPid && pidAlive(daemonPid), 'the app spawned a tetherd')
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))
    const desk1 = await page.evaluate(() => window.__tether.activeDesk())

    // ---- 1. at start ----
    console.log('step 1')
    const a = await createShell(page, base)
    await expectMark(page, a, '1 start')

    // ---- 2. two frames: a click into the other frame's pane ----
    console.log('step 2')
    const b = await duplicate(page, a, 'right', 'desk')
    assert.notEqual(await page.evaluate(id => window.__tether.frameOf(id), a), await page.evaluate(id => window.__tether.frameOf(id), b), 'b is in another frame')
    await expectMark(page, b, '2 new frame pane')
    await clickInto(page, a)
    await expectMark(page, a, '2 click into a')
    await clickInto(page, b)
    await expectMark(page, b, '2 click into b')
    await page.screenshot({ path: join(artifacts, 'keyboard-tab-desk.png') })

    // ---- 3. two tabs in one frame ----
    console.log('step 3')
    const c = await duplicate(page, b, 'within', 'pane')
    assert.equal(await page.evaluate(id => window.__tether.frameOf(id), c), await page.evaluate(id => window.__tether.frameOf(id), b), 'c is a tab beside b')
    await expectMark(page, c, '3 new tab')
    await page.click(tab(b))
    await expectMark(page, b, '3 tab b')
    await page.click(tab(c))
    await expectMark(page, c, '3 tab c')

    // ---- 4. desk switch ----
    console.log('step 4')
    const desk2 = await page.evaluate(d => window.__tether.createDesk('after', d), desk1)
    await page.evaluate(d => window.__tether.switchDesk(d), desk2)
    const d = await createShell(page, base)
    await expectMark(page, d, '4 desk 2')
    await page.evaluate(d => window.__tether.switchDesk(d), desk1)
    await expectMark(page, c, '4 back to desk 1')
    await page.evaluate(d => window.__tether.switchDesk(d), desk2)
    await expectMark(page, d, '4 desk 2 again')
    assert.equal(await page.evaluate(() => document.querySelectorAll('.desk-layer.inactive .dv-tab.keyboard-tab').length), 0, 'no hidden desk keeps a mark')
    await page.evaluate(d => window.__tether.switchDesk(d), desk1)
    await expectMark(page, c, '4 desk 1')

    // ---- 5. a pad ----
    console.log('step 5')
    const p = await bareShell(page, base)
    await page.evaluate(id => window.__tether.togglePad(id), DESK_PAD)
    await page.waitForFunction(id => window.__tether.padFrames().some(f => f.pad === id && f.shown), DESK_PAD)
    await page.evaluate(([id, pad]) => window.__tether.openSlotInPad(id!, pad!), [p, DESK_PAD] as const)
    await page.waitForFunction(id => window.__tether.padFrames().some(f => f.panes.includes(id)), p)
    await clickInto(page, c)
    await expectMark(page, c, '5 desk before the pad')
    await clickInto(page, p)
    await expectMark(page, p, '5 click into the pad')
    assert.ok(await page.evaluate(id => !!document.querySelector(`.desk-layer:not(.inactive) .frame.focused .tether-tab[data-slot="${id}"]`), c), 'the desk frame keeps its Foco de Mesa')
    await page.screenshot({ path: join(artifacts, 'keyboard-tab-pad.png') })
    await setTheme(page, 'light')
    await clickInto(page, p) // the theme menu keeps the keyboard after a pick
    await expectMark(page, p, '5 light theme, pad')
    await page.screenshot({ path: join(artifacts, 'keyboard-tab-pad-light.png') })
    await clickInto(page, a)
    await expectMark(page, a, '5 click back into the desk')
    await page.screenshot({ path: join(artifacts, 'keyboard-tab-desk-light.png') })
    await clickInto(page, p)
    await expectMark(page, p, '5 pad again')
    await page.evaluate(id => window.__tether.togglePad(id), DESK_PAD)
    await page.waitForFunction(() => !window.__tether.padFrames().some(f => f.shown))
    await expectMark(page, a, '5 pad closed')

    // ---- 6. drawer ----
    console.log('step 6')
    const dr = await createShell(page, base)
    await page.evaluate(id => window.__tether.movePaneToDrawer(id), dr)
    await page.waitForFunction(id => window.__tether.drawer().panes.includes(id), dr)
    if (await page.evaluate(() => window.__tether.drawer().open)) await page.evaluate(() => window.__tether.closeDrawer())
    await page.waitForFunction(() => !window.__tether.drawer().open)
    const back = (await marks(page)).focused!
    await expectMark(page, back, '6 drawer closed')
    await page.evaluate(() => window.__tether.openDrawer())
    await page.waitForFunction(() => window.__tether.drawer().open)
    await expectMark(page, dr, '6 drawer open')
    await page.evaluate(() => window.__tether.closeDrawer())
    await page.waitForFunction(() => !window.__tether.drawer().open)
    await expectMark(page, back, '6 drawer closed again')

    // ---- 7. a note ----
    console.log('step 7')
    await page.evaluate(f => window.__tether.openFile(f), file)
    await page.waitForFunction(() => window.__tether.notes().length === 1)
    const note = (await page.evaluate(() => window.__tether.notes()))[0]!.id
    await expectMark(page, note, '7 note opened')
    const away = (await page.evaluate(([n, a, b]) => window.__tether.frameOf(n!) === window.__tether.frameOf(a!) ? b : a, [note, a, b] as const))!
    await page.click(tab(away))
    await clickInto(page, away)
    await expectMark(page, away, '7 away from the note')
    await page.click(tab(note))
    await page.locator(`.dv-groupview:has(${tab(note)}) .monaco-editor .view-lines`).click()
    await expectMark(page, note, '7 click into the note')

    // ---- 8. a tab dragged to another frame ----
    console.log('step 8')
    await page.click(tab(c))
    await expectMark(page, c, '8 before the drag')
    const from = (await page.locator(tab(c)).boundingBox())!
    const to = (await page.locator(`.dv-groupview:has(${tab(a)}) .dv-content-container`).boundingBox())!
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(from.x + from.width / 2 + 8, from.y + from.height / 2 + 8, { steps: 3 })
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 15 })
    await sleep(120)
    await page.mouse.up()
    await sleep(250)
    await page.waitForFunction(([c, a]) => window.__tether.frameOf(c!) === window.__tether.frameOf(a!), [c, a] as const)
    await expectMark(page, c, '8 after the drag')

    // ---- 9. attention through a link ----
    console.log('step 9')
    await page.evaluate(d => window.__tether.switchDesk(d), desk2)
    await expectMark(page, d, '9 on desk 2')
    await follow(app, tabUrl(b))
    await page.waitForFunction(id => !!document.querySelector(`.dv-tab.attention-tab .tether-tab[data-slot="${id}"]`), b, { timeout: 2000 })
    const t0 = Date.now()
    assert.equal(await page.evaluate(() => document.querySelectorAll('.dv-tab.attention-tab').length), 1, 'one tab pulses')
    await expectMark(page, b, '9 link followed')
    await page.waitForFunction(() => document.querySelectorAll('.dv-tab.attention-tab').length === 0, undefined, { timeout: 3000 })
    const lasted = Date.now() - t0
    assert.ok(lasted > 700 && lasted < 2000, `the pulse goes away after ~1.2 s (${lasted} ms)`)
    await expectMark(page, b, '9 after the pulse')
  } finally {
    if (app) await killElectron(app, root).catch(e => console.error(String(e)))
    for (const d of daemons) {
      const r = await killOwned(d, { tree: true })
      if (r === 'not-ours') console.error(`tetherd cleanup: pid ${d.pid} is no longer ours; not killed`)
    }
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && daemons.some(d => pidAlive(d.pid))) await sleep(200)
    for (const dir of [home, base]) for (let i = 0; i < 5; i++) {
      try { rmSync(dir, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
  }
})
