// E2E of the side bars' core (F10a) with shells only (hidden window, private home/pipe, real tetherd, CLAUDE* stripped):
//   1. a v2 layout.json (two desks, a split frame, the drawer) written by hand restores intact under the v3 code: same
//      desks, frames and panes (same PIDs), the drawer's pane in the drawer; layout.v2.bak keeps the v2 file; the first
//      change the person makes writes v3 with the side bars and the desks untouched;
//   2. with no extension declaring a pad, neither side bar shows (no strip), the desks take the whole width, and the
//      side bar commands are unavailable (their keys pass: Ctrl+B in the window does nothing).
//      (the frame pads and the explorer are turned off for this one);
//   3. the frame pads (F10b): each opens and closes by its icon and by its command, one open per side, Ctrl+Alt+B toggles
//      the right bar; a pad moved to the left and restored; the desk pad's content swaps with the desk, the global pad is
//      the same frame in every desk; a terminal in a pad survives a relaunch with the same PID; widths and open state too;
//   4. pads in the focus (F10b-2): one focused frame in the window (the F6 outline and the dim follow a pad frame and
//      come back to the desk); "Nova nota" with a pad frame focused opens in that pad; Ctrl+K arrows (frame.focus.*)
//      cross desk ↔ pad; "Mover…" offers the desk pad and the global pad and moves a pane in and out; a pad pane's
//      attention counts on its desk's badge and locating it (openSlot) opens its pad; the desk line spans the window.
//      Screenshots light+dark in <repo>/../../.tmp/f10.
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

type DeskJSON = { id: string; name: string; color: string; frames: { grid: unknown; views: Record<string, { panels: Record<string, unknown> }> }; pads?: unknown }
type LayoutJSON = { v: number; desks: DeskJSON[]; activeDesk: string; drawer: { frames: { views: Record<string, { panels: Record<string, unknown> }> } } | null; sidebars?: unknown }
type Hooks = {
  panelIds(): string[]
  slots(): SlotState[]
  connection(): { connected: boolean; pid?: number } | undefined
  layout(): LayoutJSON
  desks(): { id: string; name: string; panes: string[]; attention: { done: number; waiting: number } }[]
  createDesk(side: 'before' | 'after'): string
  switchDesk(id: string): void
  activeDesk(): string
  openSlot(id: string): void
  drawer(): { open: boolean; panes: string[] }
  movePaneToDrawer(slotId: string): void
  duplicate(slotId: string, direction: string, level?: string): void
  frameIds(): string[]
  sidebars(): { left: { strip: string[]; open?: string; width: number }; right: { strip: string[]; open?: string; width: number } } | undefined
  padFrames(): { pad: string; desk?: string; panes: string[]; shown: boolean }[]
  openSlotInPad(slotId: string, padId: string): void
  togglePad(id: string): void
  currentPane(): string | undefined
  openMove(slotId: string, mode?: 'pane' | 'frame'): void
  moveTree(): { id: string; kind: string; name: string }[]
  applyState(slot: SlotState): void
  movePad(id: string): void
  restorePad(id: string): void
  runCommand(id: string): Promise<string>
  renameDesk(id: string, name: string): void
}
declare const window: { __tether: Hooks; tether: { request(body: unknown): Promise<{ t: string; slot?: SlotState }> } }
type El = { hidden: boolean; dataset: Record<string, string>; closest(s: string): El | null; getBoundingClientRect(): { width: number } }
declare const document: { querySelector(s: string): El | null; querySelectorAll(s: string): ArrayLike<El> & Iterable<El>; documentElement: El }
declare const getComputedStyle: (el: El, pseudo?: string) => { width: string; content: string; opacity: string }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const artifacts = join(root, 'test', 'e2e', 'artifacts')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-sidebars-${process.pid}`
const atriumTmp = resolve(root, '..', '..', '.tmp')
const tmpBase = existsSync(atriumTmp) ? atriumTmp : tmpdir()

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

/** A running shell slot opened as a pane in the current desk. */
async function shell(page: Page): Promise<string> {
  const reply = await page.evaluate(cwd => window.tether.request({ t: 'create', kind: 'shell', cwd, start: true }), root)
  assert.equal(reply.t, 'ok')
  const id = reply.slot!.slotId
  await page.evaluate(id => window.__tether.openSlot(id), id)
  await page.waitForFunction(id => window.__tether.slots().find(s => s.slotId === id)?.status === 'running', id, { timeout: 20_000 })
  return id
}

const pidOf = async (page: Page, id: string): Promise<number> => (await page.evaluate(id => window.__tether.slots().find(s => s.slotId === id)?.pid, id))!

/** What must survive: per desk its name and, per frame, its panes; the drawer's panes. */
function shape(l: LayoutJSON): unknown {
  return {
    desks: l.desks.map(d => ({ id: d.id, name: d.name, color: d.color, frames: Object.fromEntries(Object.entries(d.frames.views).map(([f, v]) => [f, Object.keys(v.panels).sort()])) })),
    activeDesk: l.activeDesk,
    drawer: Object.values(l.drawer?.frames.views ?? {}).flatMap(v => Object.keys(v.panels)).sort(),
  }
}

test('side bars core: a v2 layout restores intact under v3; no pads, no strips', { timeout: 240_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(artifacts, { recursive: true })
  const home = mkdtempSync(join(tmpBase, 'tether-sidebars-'))
  // Part 2 is the window with no pad at all: the frame pads extension is off.
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ extensions: { disabled: ['frame-pads', 'explorer', 'browser'] } }))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    // ---- 1. a v2 file of two desks, a split frame and the drawer ----
    let page: Page
    ;({ app, page } = await launch(home))
    daemons.push(await claim((await page.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    const a = await shell(page)
    page.evaluate(id => window.__tether.duplicate(id, 'right'), a).catch(() => {})
    await page.waitForFunction(() => window.__tether.panelIds().length === 2, undefined, { timeout: 20_000 })
    const b = (await page.evaluate(() => window.__tether.panelIds())).find(id => id !== a)!
    const desk2 = await page.evaluate(() => window.__tether.createDesk('after'))
    await page.evaluate(([id]) => window.__tether.renameDesk(id!, 'Revisão'), [desk2])
    const c = await shell(page)
    const d = await shell(page)
    await page.evaluate(id => window.__tether.movePaneToDrawer(id), d)
    await page.waitForFunction(id => window.__tether.drawer().panes.includes(id), d)
    await page.waitForFunction(ids => ids.every(id => typeof window.__tether.slots().find(s => s.slotId === id)?.pid === 'number'), [a, b, c, d], { timeout: 20_000 })
    const pids = { a: await pidOf(page, a), b: await pidOf(page, b), c: await pidOf(page, c), d: await pidOf(page, d) }
    const live = await page.evaluate(() => window.__tether.layout())
    assert.equal(live.v, 4, 'the app writes v4')
    const v2: LayoutJSON = { v: 2, desks: live.desks.map(({ pads: _p, ...rest }) => rest), activeDesk: live.activeDesk, drawer: live.drawer }
    await killElectron(app, root)
    app = undefined
    writeFileSync(join(home, 'layout.json'), JSON.stringify(v2, null, 2))

    // ---- relaunch: the v2 file restores intact ----
    ;({ app, page } = await launch(home))
    await page.waitForFunction(n => window.__tether.panelIds().length >= n, 3, { timeout: 20_000 })
    const back = await page.evaluate(() => window.__tether.layout())
    assert.equal(back.v, 4)
    assert.deepEqual(shape(back), shape(v2), 'desks, frames, panes and the drawer as the v2 file had them')
    assert.deepEqual(back.sidebars, { left: { width: 380 }, right: { width: 380 }, placement: {}, pads: {} }, 'closed side bars')
    assert.deepEqual((await page.evaluate(() => window.__tether.drawer())).panes, [d])
    for (const [k, id] of Object.entries({ a, b, c, d })) {
      await page.waitForFunction(id => typeof window.__tether.slots().find(s => s.slotId === id)?.pid === 'number', id)
      assert.equal(await pidOf(page, id), pids[k as keyof typeof pids], `${k}: same shell`)
    }
    const bak = join(home, 'layout.v2.bak')
    for (let i = 0; i < 20 && !existsSync(bak); i++) await sleep(100)
    assert.deepEqual(JSON.parse(readFileSync(bak, 'utf8')), JSON.parse(JSON.stringify(v2)), 'layout.v2.bak keeps the v2 file')
    assert.equal(JSON.parse(readFileSync(join(home, 'layout.json'), 'utf8')).v, 2, 'the file stays v2 until the person changes something')

    // ---- the first change writes v4, desks untouched ----
    await page.evaluate(id => window.__tether.renameDesk(id, 'Revisão 2'), desk2)
    let saved: LayoutJSON | undefined
    for (let i = 0; i < 40; i++) { saved = JSON.parse(readFileSync(join(home, 'layout.json'), 'utf8')) as LayoutJSON; if (saved.v === 4) break; await sleep(100) }
    assert.equal(saved!.v, 4)
    const expected = shape(v2) as { desks: { name: string }[] }
    expected.desks[1]!.name = 'Revisão 2'
    assert.deepEqual(shape(saved!), expected)
    assert.ok(saved!.sidebars, 'the side bars are in the file')

    // ---- 2. no pads: no strips, the desks take the whole width, the commands are unavailable ----
    const bars = (await page.evaluate(() => window.__tether.sidebars()))!
    assert.deepEqual([bars.left.strip, bars.right.strip], [[], []])
    assert.deepEqual(await page.evaluate(() => [document.querySelector('#sidebar-left')!.hidden, document.querySelector('#sidebar-right')!.hidden]), [true, true])
    const widths = await page.evaluate(() => [document.querySelector('#workbench')!.getBoundingClientRect().width, document.querySelector('#dock')!.getBoundingClientRect().width])
    assert.equal(widths[1], widths[0], 'the desks fill the workbench')
    assert.equal(await page.evaluate(() => window.__tether.runCommand('sidebar.left.toggle')), 'unavailable')
    assert.equal(await page.evaluate(() => window.__tether.runCommand('sidebar.right.toggle')), 'unavailable')
    assert.equal(await page.evaluate(() => window.__tether.runCommand('pad.move-to-other-side')), 'unavailable')
    await page.locator('#btn-menu').focus()
    await page.keyboard.press('Escape')
    await page.keyboard.press('Control+b')
    await page.keyboard.press('Control+Alt+b')
    await sleep(200)
    assert.deepEqual(await page.evaluate(() => [document.querySelector('#sidebar-left')!.hidden, document.querySelector('#sidebar-right')!.hidden]), [true, true])
    await page.screenshot({ path: join(artifacts, 'sidebars-none.png') })
  } finally {
    if (app) await killElectron(app, root).catch(() => {})
    for (const p of daemons) await killOwned(p, { tree: true })
    for (let i = 0; i < 20 && daemons.some(p => pidAlive(p.pid)); i++) await sleep(500)
    for (let i = 0; i < 5; i++) { try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(300) } }
  }
})

/** A running shell slot, not opened anywhere yet. */
async function bareShell(page: Page): Promise<string> {
  const reply = await page.evaluate(cwd => window.tether.request({ t: 'create', kind: 'shell', cwd, start: true }), root)
  assert.equal(reply.t, 'ok')
  return reply.slot!.slotId
}

const DESK_PAD = 'frame-pads.desk'
const GLOBAL_PAD = 'frame-pads.global'
const PANEL_PAD = 'frame-pads.panel'

test('frame pads (F10b): toggles, one per side, moving, desk swap, global, relaunch', { timeout: 300_000 }, async () => {
  mkdirSync(artifacts, { recursive: true })
  const home = mkdtempSync(join(tmpBase, 'tether-pads-'))
  // The explorer (left strip) has its own e2e; this one is about the frame pads' sides.
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ extensions: { disabled: ['explorer', 'browser'] } }))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  const bars = (page: Page) => page.evaluate(() => window.__tether.sidebars()!)
  const frames = (page: Page) => page.evaluate(() => window.__tether.padFrames())
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    daemons.push(await claim((await page.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    const deskTerm = await shell(page)
    const desk1 = await page.evaluate(() => window.__tether.activeDesk())
    assert.deepEqual((await bars(page)).right.strip, [PANEL_PAD, DESK_PAD, GLOBAL_PAD], 'the three pads on the right strip: panel, desk, global')
    assert.deepEqual((await bars(page)).left.strip, [])

    // ---- by icon ----
    await page.click(`#sidebar-right .sb-icon[data-pad="${DESK_PAD}"]`)
    assert.equal((await bars(page)).right.open, DESK_PAD)
    await page.waitForFunction(p => window.__tether.padFrames().some(f => f.pad === p && f.shown && f.panes.length === 1), DESK_PAD)
    const padTerm = await bareShell(page)
    await page.evaluate(([id, pad]) => window.__tether.openSlotInPad(id!, pad!), [padTerm, DESK_PAD])
    await page.waitForFunction(id => window.__tether.padFrames().some(f => f.panes.includes(id)), padTerm)
    await page.waitForFunction(id => typeof window.__tether.slots().find(s => s.slotId === id)?.pid === 'number', padTerm, { timeout: 20_000 })
    const padPid = await pidOf(page, padTerm)
    assert.ok((await frames(page)).find(f => f.pad === DESK_PAD && f.desk === desk1)!.panes.includes(padTerm))
    await page.click(`#sidebar-right .sb-icon[data-pad="${GLOBAL_PAD}"]`)
    assert.equal((await bars(page)).right.open, GLOBAL_PAD, 'one pad open per side: the global replaced the desk pad')
    assert.equal((await frames(page)).find(f => f.pad === DESK_PAD)!.shown, false)
    await page.click(`#sidebar-right .sb-icon[data-pad="${GLOBAL_PAD}"]`)
    assert.equal((await bars(page)).right.open, undefined, 'the icon toggles')

    // ---- by command and by Ctrl+Alt+B ----
    assert.equal(await page.evaluate(id => window.__tether.runCommand(`pad.toggle.${id}`), DESK_PAD), 'ran')
    assert.equal((await bars(page)).right.open, DESK_PAD)
    assert.equal(await page.evaluate(id => window.__tether.runCommand(`pad.toggle.${id}`), GLOBAL_PAD), 'ran')
    assert.equal((await bars(page)).right.open, GLOBAL_PAD)
    assert.equal(await page.evaluate(id => window.__tether.runCommand(`pad.toggle.${id}`), GLOBAL_PAD), 'ran')
    assert.equal((await bars(page)).right.open, undefined)
    await page.locator('#btn-menu').focus()
    await page.keyboard.press('Escape')
    await page.keyboard.press('Control+Alt+b')
    await page.waitForFunction(() => window.__tether.sidebars()!.right.open !== undefined)
    await page.keyboard.press('Control+Alt+b')
    await page.waitForFunction(() => window.__tether.sidebars()!.right.open === undefined)

    // ---- move to the left and back ----
    await page.evaluate(id => window.__tether.togglePad(id), GLOBAL_PAD)
    await page.evaluate(id => window.__tether.movePad(id), GLOBAL_PAD)
    let b = await bars(page)
    assert.deepEqual([b.left.strip, b.right.strip, b.left.open], [[GLOBAL_PAD], [PANEL_PAD, DESK_PAD], GLOBAL_PAD])
    await page.evaluate(id => window.__tether.togglePad(id), DESK_PAD)
    b = await bars(page)
    assert.deepEqual([b.left.open, b.right.open], [GLOBAL_PAD, DESK_PAD], 'one open on each side')
    await page.screenshot({ path: join(artifacts, 'pads-moved-left.png') })
    await page.evaluate(id => window.__tether.restorePad(id), GLOBAL_PAD)
    b = await bars(page)
    assert.deepEqual([b.left.strip, b.right.strip], [[], [PANEL_PAD, DESK_PAD, GLOBAL_PAD]], 'restored to the right')

    // ---- desk swap and global identity ----
    await page.evaluate(id => { if (window.__tether.sidebars()!.right.open !== id) window.__tether.togglePad(id) }, GLOBAL_PAD)
    const globalFrames = (await frames(page)).filter(f => f.pad === GLOBAL_PAD)
    assert.equal(globalFrames.length, 1, 'one global frame')
    const desk2 = await page.evaluate(() => window.__tether.createDesk('after'))
    await page.evaluate(id => window.__tether.switchDesk(id), desk2)
    assert.deepEqual((await frames(page)).filter(f => f.pad === GLOBAL_PAD), globalFrames, 'the same global frame in desk 2, shown')
    await page.evaluate(id => window.__tether.togglePad(id), DESK_PAD)
    await page.waitForFunction(([p, d]) => window.__tether.padFrames().some(f => f.pad === p && f.desk === d && f.shown), [DESK_PAD, desk2])
    const f2 = await frames(page)
    assert.ok(!f2.find(f => f.pad === DESK_PAD && f.desk === desk2)!.panes.includes(padTerm), 'desk 2 has its own desk pad')
    assert.equal(f2.find(f => f.pad === DESK_PAD && f.desk === desk1)!.shown, false, 'the desk pad of desk 1 is hidden')
    await page.evaluate(id => window.__tether.switchDesk(id), desk1)
    await page.waitForFunction(([p, d]) => window.__tether.padFrames().some(f => f.pad === p && f.desk === d && f.shown), [DESK_PAD, desk1])

    // ---- relaunch: the pad terminal keeps its PID; widths and open state survive ----
    const before = await bars(page)
    for (let i = 0; i < 40; i++) {
      const raw = existsSync(join(home, 'layout.json')) ? readFileSync(join(home, 'layout.json'), 'utf8') : '{}'
      const saved = JSON.parse(raw) as { sidebars?: { right?: { open?: string } } }
      if (saved.sidebars?.right?.open === DESK_PAD && raw.includes(padTerm)) break
      await sleep(100)
      assert.ok(i < 39, 'layout.json has the open desk pad and its terminal')
    }
    await killElectron(app, root)
    ;({ app, page } = await launch(home))
    await page.waitForFunction(id => window.__tether.padFrames().some(f => f.panes.includes(id)), padTerm, { timeout: 20_000 })
    const after = await bars(page)
    assert.deepEqual([after.right.open, after.right.width, after.left.width], [before.right.open, before.right.width, before.left.width])
    await page.waitForFunction(id => typeof window.__tether.slots().find(s => s.slotId === id)?.pid === 'number', padTerm, { timeout: 20_000 })
    assert.equal(await pidOf(page, padTerm), padPid, 'same PID after relaunch')
    assert.ok(pidAlive(padPid))
    assert.ok((await page.evaluate(() => window.__tether.panelIds())).includes(deskTerm))
    assert.equal((await frames(page)).find(f => f.pad === DESK_PAD && f.desk === desk1)!.shown, true)
    await page.screenshot({ path: join(artifacts, 'pads-desk-open.png') })
  } finally {
    if (app) await killElectron(app, root).catch(() => {})
    for (const p of daemons) await killOwned(p, { tree: true })
    for (let i = 0; i < 20 && daemons.some(p => pidAlive(p.pid)); i++) await sleep(500)
    for (let i = 0; i < 5; i++) { try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(300) } }
  }
})

/** Where the keyboard's frame is: 'pads' while a pad's frame wears `.kbd-focused`, else 'desk'. The Foco de Mesa (`.frame.focused`) stays on the desk either way. */
const focusedFrames = (page: Page) => page.evaluate(() => {
  const foco = [...document.querySelectorAll('.frame.focused')].filter(f => !f.closest('.drawer'))
  if (foco.length !== 1 || foco[0]!.closest('#pads')) return ['foco de mesa fora da mesa: ' + foco.length]
  return [document.querySelector('#pads .frame.kbd-focused') ? 'pads' : 'desk']
})
/** How many frames wear the dim veil (their ::after above 0), in the shown pads and on the visible desk. */
const dimmed = (page: Page) => page.evaluate(() => {
  const n = (sel: string) => [...document.querySelectorAll(sel)].filter(f => Number(getComputedStyle(f, '::after').opacity) > 0.05).length
  return { pads: n('#pads .pad.shown .frame:has(> .frame-dock)'), desk: n('.desk-layer:not(.inactive) .frame:has(> .frame-dock)') }
})

async function setTheme(page: Page, scheme: 'light' | 'dark'): Promise<void> {
  await page.click('#btn-theme')
  await page.click(`#theme-menu li[data-theme="${scheme}"]`)
  await page.waitForFunction(s => document.documentElement.dataset.theme === s, scheme)
  await sleep(300)
}

test('frame pads in the focus (F10b-2): one focused frame, new panes, Ctrl+K, Mover, attention, full-width line', { timeout: 300_000 }, async () => {
  mkdirSync(artifacts, { recursive: true })
  const shots = join(atriumTmp, 'f10')
  mkdirSync(shots, { recursive: true })
  const home = mkdtempSync(join(tmpBase, 'tether-padfocus-'))
  // A folder of its own: the note the test creates lands in <cwd>/.tether/notes, never in the repo.
  const work = mkdtempSync(join(tmpBase, 'tether-padfocus-work-'))
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ extensions: { disabled: ['browser'] }, theme: 'light', ui: { deskLine: true, tabBorder: true, dimUnfocused: true, dimLevel: 'medium' } }))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  const frames = (page: Page) => page.evaluate(() => window.__tether.padFrames())
  const padPanes = async (page: Page, desk: string) => (await frames(page)).find(f => f.pad === DESK_PAD && f.desk === desk)?.panes ?? []
  const workShell = async (page: Page, open: boolean): Promise<string> => {
    const reply = await page.evaluate(cwd => window.tether.request({ t: 'create', kind: 'shell', cwd, start: true }), work)
    assert.equal(reply.t, 'ok')
    const id = reply.slot!.slotId
    if (open) await page.evaluate(id => window.__tether.openSlot(id), id)
    await page.waitForFunction(id => window.__tether.slots().find(s => s.slotId === id)?.status === 'running', id, { timeout: 20_000 })
    return id
  }
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    daemons.push(await claim((await page.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    const a = await workShell(page, true)
    page.evaluate(id => window.__tether.duplicate(id, 'right', 'desk'), a).catch(() => {})
    await page.waitForFunction(() => window.__tether.panelIds().length === 2, undefined, { timeout: 20_000 })
    const b = (await page.evaluate(() => window.__tether.panelIds())).find(id => id !== a)!
    await page.waitForFunction(id => window.__tether.slots().find(s => s.slotId === id)?.status === 'running', b, { timeout: 20_000 })
    const desk1 = await page.evaluate(() => window.__tether.activeDesk())

    // ---- the desk line spans the window, over the side bars ----
    await page.evaluate(id => window.__tether.togglePad(id), DESK_PAD)
    await page.waitForFunction(p => window.__tether.padFrames().some(f => f.pad === p && f.shown && f.panes.length === 1), DESK_PAD)
    const line = await page.evaluate(() => {
      const st = getComputedStyle(document.querySelector('#workbench')!, '::before')
      return { content: st.content, width: parseFloat(st.width), window: document.documentElement.getBoundingClientRect().width, dockLine: getComputedStyle(document.querySelector('#dock')!, '::before').content }
    })
    assert.notEqual(line.content, 'none', 'the line is drawn on the workbench')
    assert.ok(Math.abs(line.width - line.window) < 2, `the line spans the window (${line.width} of ${line.window})`)
    assert.equal(line.dockLine, 'none', 'no second line on the desks alone')

    // ---- the keyboard in the pad (neutral outline) while the Foco de Mesa stays on the desk, then back ----
    const seeded = (await padPanes(page, desk1))[0]!
    await page.waitForFunction(() => document.querySelectorAll('#workbench .frame.focused').length === 1 && !document.querySelector('#workbench .frame.focused')!.closest('#pads') && !!document.querySelector('#pads .frame.kbd-focused'))
    assert.equal(await page.evaluate(() => window.__tether.currentPane()), seeded, 'the active pane is the pad\'s')
    await sleep(300)
    assert.deepEqual(await dimmed(page), { pads: 0, desk: 1 }, 'the pad frame has the keyboard: the Foco de Mesa stays, only the other desk frame dims, a pad never dims')
    for (const scheme of ['light', 'dark'] as const) {
      await setTheme(page, scheme)
      // The theme menu took the keyboard: give it back to the pad's pane (focusing it keeps the pad frame focused).
      await page.locator('#pads .pad.shown .dv-tab').first().click()
      await page.waitForFunction(() => !!document.querySelector('#pads .frame.kbd-focused'))
      await sleep(300)
      await page.screenshot({ path: join(shots, `pad-focused-${scheme}.png`) })
    }
    await page.locator('.desk-layer:not(.inactive) .frame .panel-term:visible').first().click()
    await page.waitForFunction(() => document.querySelectorAll('#workbench .frame.focused').length === 1 && !document.querySelector('#workbench .frame.focused')!.closest('#pads') && !document.querySelector('#pads .frame.kbd-focused'))
    await sleep(300)
    assert.deepEqual(await dimmed(page), { pads: 0, desk: 1 }, 'back on the desk: one desk frame is the Foco, the other dims; the pad does not')

    // ---- Ctrl+K arrows: desk → pad → desk ----
    await page.locator('.desk-layer:not(.inactive) .frame:has(> .frame-dock)').last().locator('.panel-term:visible').first().click() // b's frame: the rightmost
    await page.waitForFunction(id => window.__tether.currentPane() === id, b)
    assert.equal(await page.evaluate(() => window.__tether.runCommand('frame.focus.right')), 'ran')
    await page.waitForFunction(id => window.__tether.currentPane() === id, seeded)
    assert.deepEqual(await focusedFrames(page), ['pads'], 'Ctrl+K → reaches the pad frame')
    assert.equal(await page.evaluate(() => window.__tether.runCommand('frame.focus.left')), 'ran')
    await page.waitForFunction(id => window.__tether.currentPane() === id, b)
    assert.deepEqual(await focusedFrames(page), ['desk'], 'Ctrl+K ← comes back to the desk')

    // ---- "Nova nota" with the pad frame focused opens in the pad ----
    assert.equal(await page.evaluate(() => window.__tether.runCommand('frame.focus.right')), 'ran')
    await page.waitForFunction(id => window.__tether.currentPane() === id, seeded)
    assert.equal(await page.evaluate(() => window.__tether.runCommand('note.new')), 'ran')
    // The note takes the place of the pad's blank seed (a blank pane is a place kept for what comes next).
    await page.waitForFunction(([p, seed]) => window.__tether.padFrames().some(f => f.pad === p && f.panes.length === 1 && !f.panes.includes(seed!)), [DESK_PAD, seeded])
    const note = (await padPanes(page, desk1))[0]!
    assert.ok(!(await page.evaluate(() => window.__tether.panelIds())).includes(note), 'the note is in the pad, not on the desk')
    await page.waitForFunction(id => window.__tether.currentPane() === id, note)
    await sleep(500)
    for (const scheme of ['light', 'dark'] as const) {
      await setTheme(page, scheme)
      await page.locator('#pads .pad.shown .monaco-editor').first().click()
      await page.waitForFunction(() => !!document.querySelector('#pads .frame.kbd-focused'))
      await sleep(300)
      await page.screenshot({ path: join(shots, `pad-note-${scheme}.png`) })
    }

    // ---- "Mover…": the pads are destinations; b goes into the desk pad and comes back ----
    const tree = await page.evaluate(() => window.__tether.moveTree())
    const padNodes = tree.filter(s => s.kind === 'pad')
    assert.deepEqual(padNodes.map(s => s.name), ['Prancheta do painel', 'Prancheta da mesa', 'Prancheta global'], 'the panel pad (of the focused panel) comes first')
    assert.ok(padNodes[0]!.id.startsWith(`pad:${PANEL_PAD}@`))
    assert.deepEqual(padNodes.slice(1).map(s => s.id), [`pad:${DESK_PAD}@${desk1}`, `pad:${GLOBAL_PAD}`])
    const bPid = await pidOf(page, b)
    await page.evaluate(id => window.__tether.openMove(id), b)
    await page.waitForSelector('dialog.move[open]')
    await page.click(`dialog.move .mv-row.g[data-scope="pad:${DESK_PAD}@${desk1}"]`)
    await page.click('dialog.move .oz.bottom')
    assert.match((await page.textContent('#mv-summary'))!, /da prancheta/)
    await page.click('#mv-go')
    await page.waitForFunction(([id, p]) => window.__tether.padFrames().some(f => f.pad === p && f.panes.includes(id!)), [b, DESK_PAD])
    assert.ok(!(await page.evaluate(() => window.__tether.panelIds())).includes(b))
    assert.equal(await pidOf(page, b), bPid, 'same process after the move')
    await page.evaluate(id => window.__tether.openMove(id), b)
    await page.waitForSelector('dialog.move[open]')
    await page.click(`dialog.move .mv-row.d[data-scope="${desk1}"]`)
    await page.click('dialog.move .oz.right')
    await page.click('#mv-go')
    await page.waitForFunction(id => window.__tether.panelIds().includes(id), b)
    assert.ok(!(await padPanes(page, desk1)).includes(b), 'out of the pad')
    // Into the global pad, never opened before: it opens and takes the pane, with no seeded empty pane beside it.
    await page.evaluate(id => window.__tether.openMove(id), b)
    await page.waitForSelector('dialog.move[open]')
    await page.click(`dialog.move .mv-row.g[data-scope="pad:${GLOBAL_PAD}"]`)
    await page.click('dialog.move .oz.left')
    await page.click('#mv-go')
    await page.waitForFunction(([id, p]) => window.__tether.padFrames().some(f => f.pad === p && f.shown && f.panes.length === 1 && f.panes[0] === id), [b, GLOBAL_PAD])
    assert.equal(await pidOf(page, b), bPid, 'same process in the global pad')

    // ---- attention: a desk pad's pane counts on its desk's badge; locating it opens its pad ----
    const c = await workShell(page, false)
    await page.evaluate(id => window.__tether.togglePad(id), DESK_PAD)
    await page.waitForFunction(p => window.__tether.sidebars()!.right.open === p, DESK_PAD)
    await page.evaluate(([id, pad]) => window.__tether.openSlotInPad(id!, pad!), [c, DESK_PAD])
    await page.waitForFunction(id => window.__tether.padFrames().some(f => f.panes.includes(id)), c)
    const cState = (await page.evaluate(id => window.__tether.slots().find(s => s.slotId === id), c))!
    const desk2 = await page.evaluate(() => window.__tether.createDesk('after'))
    await page.evaluate(id => window.__tether.switchDesk(id), desk2)
    await page.evaluate(s => window.__tether.applyState(s), { ...cState, attention: 'waiting' as const })
    await page.waitForFunction(d => window.__tether.desks().find(x => x.id === d)?.attention.waiting === 1, desk1)
    await page.evaluate(id => window.__tether.openSlot(id), c)
    await page.waitForFunction(([d, p]) => window.__tether.activeDesk() === d && window.__tether.sidebars()!.right.open === p, [desk1, DESK_PAD])
    await page.waitForFunction(id => window.__tether.currentPane() === id, c)
    // Every desk keeps its own Foco de Mesa (the hidden desk's too): count the visible one.
    await page.waitForFunction(() => document.querySelectorAll('#workbench .desk-layer:not(.inactive) .frame.focused').length === 1 && !document.querySelector('#pads .frame.focused') && !!document.querySelector('#pads .frame.kbd-focused'))
  } finally {
    if (app) await killElectron(app, root).catch(() => {})
    for (const p of daemons) await killOwned(p, { tree: true })
    for (let i = 0; i < 20 && daemons.some(p => pidAlive(p.pid)); i++) await sleep(500)
    for (const dir of [home, work]) for (let i = 0; i < 5; i++) { try { rmSync(dir, { recursive: true, force: true }); break } catch { await sleep(300) } }
  }
})
