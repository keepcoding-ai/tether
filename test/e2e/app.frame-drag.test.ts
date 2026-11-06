// E2E of dragging tabs between frames, with shells and a note (hidden window, private home/pipe, real tetherd,
// CLAUDE* stripped, TETHER_CLAUDE_ARGS unset). Every frame is its own dockview: dockview moves a tab natively inside one
// frame, and desk.ts moves a tab dropped from another frame. Real mouse drags (HTML5 drag and drop):
//   1. frame-1 holds a and c (tabs of one group), frame-2 (Alt+Shift+→) holds b;
//   2. reorder inside a frame: c's tab dropped on a's tab → [c, a] (native);
//   3. a's tab dropped on the center of frame-2 → a tab of b's group; a is the active pane, frame-2 the focused frame,
//      the keyboard is in a's terminal; screenshot of the drop indicator while hovering;
//   4. b's tab dropped on the left edge of frame-1 → a new group to the left of c's, inside frame-1;
//   5. a note with fresh text dragged from frame-2 into frame-1 → the same text, on disk too;
//   6. a's tab dragged into the desk pad's frame (a side bar) and back: the pad's frame gets the keyboard (neutral outline) while the Foco de Mesa stays on the desk;
//   7. the PIDs never changed and every terminal kept its scrollback;
//   8. window kill + relaunch: the same arrangement, the same PIDs.
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

type Note = { id: string; path: string; text: string; dirty: boolean }
type Hooks = {
  panelIds(): string[]
  activeId(): string | undefined
  layout(): unknown
  frameIds(): string[]
  activeFrameId(): string | undefined
  frameOf(slotId: string): string | undefined
  slots(): SlotState[]
  text(id: string): string
  connection(): { connected: boolean; pid?: number } | undefined
  activate(id: string): void
  runCommand(id: string): Promise<'ran' | 'unknown' | 'unavailable'>
  notes(): Note[]
  note(id: string): Note | undefined
  togglePad(id: string): void
  padFrames(): { pad: string; desk?: string; panes: string[]; shown: boolean }[]
}
declare const window: { __tether: Hooks; tether: { notice(n: unknown): void } }
declare const document: {
  activeElement: { closest(s: string): { getAttribute(n: string): string | null } | null } | null
  querySelectorAll(selector: string): { length: number }
  querySelector(selector: string): { getBoundingClientRect(): { x: number; y: number; width: number; height: number } } | null
}

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const artifacts = join(root, 'test', 'e2e', 'artifacts')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-frame-drag-${process.pid}`
const DESK_PAD = 'frame-pads.desk'

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

const consoleErrors: string[] = []

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
  page.on('pageerror', e => { console.error(`renderer error: ${e.message}`); consoleErrors.push(e.message) })
  page.on('console', m => { if (m.type() === 'error') { console.error(`renderer console: ${m.text()}`); consoleErrors.push(m.text()) } })
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  return { app, page }
}

const h = {
  ids: (page: Page) => page.evaluate(() => window.__tether.panelIds()),
  frameOf: (page: Page, id: string) => page.evaluate(id => window.__tether.frameOf(id), id),
  frameIds: (page: Page) => page.evaluate(() => window.__tether.frameIds()),
  activeFrame: (page: Page) => page.evaluate(() => window.__tether.activeFrameId()),
  activeId: (page: Page) => page.evaluate(() => window.__tether.activeId()),
  daemonPid: async (page: Page) => (await page.evaluate(() => window.__tether.connection()))?.pid,
  rect: (page: Page, selector: string) => page.evaluate(sel => { const r = document.querySelector(sel)?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : undefined }, selector),
  pads: (page: Page) => page.evaluate(() => window.__tether.padFrames()),
}

type GridNode = { type: 'leaf' | 'branch'; data: { views: string[] } | GridNode[] }
type LayoutFile = { desks: Array<{ id: string; frames: { grid: { root: { data: Array<{ data: { id: string } }> } }; views: Record<string, { grid: { root: GridNode } }> } }> }
/** Arrangement only (tabs per group, nesting), ignoring sizes and group ids. */
const arr = (node: GridNode): unknown => node.type === 'leaf' ? (node.data as { views: string[] }).views : (node.data as GridNode[]).map(arr)
/** Desk 1's frames, each as its groups' arrangement, keyed by frame id. */
async function deskShape(page: Page): Promise<Record<string, unknown>> {
  const layout = await page.evaluate(() => window.__tether.layout()) as LayoutFile
  const out: Record<string, unknown> = {}
  for (const [id, view] of Object.entries(layout.desks[0]!.frames.views)) {
    const root = view.grid.root
    // The root is always a branch: a frame with one group is that group's tabs.
    out[id] = root.type === 'branch' && (root.data as GridNode[]).length === 1 ? arr((root.data as GridNode[])[0]!) : arr(root)
  }
  return out
}

async function waitShape(page: Page, expected: Record<string, unknown>): Promise<void> {
  const deadline = Date.now() + 5000
  let last: unknown
  while (Date.now() < deadline) {
    last = await deskShape(page)
    try { assert.deepEqual(last, expected); return } catch { await sleep(100) }
  }
  assert.deepEqual(last, expected)
}

async function pidsOf(page: Page, ids: string[]): Promise<Record<string, number>> {
  await page.waitForFunction(ids => ids.every(id => { const s = window.__tether.slots().find(x => x.slotId === id); return s?.status === 'running' && typeof s.pid === 'number' }), ids, { timeout: 20_000 })
  const out: Record<string, number> = {}
  for (const s of await page.evaluate(() => window.__tether.slots())) if (ids.includes(s.slotId)) out[s.slotId] = s.pid!
  return out
}

async function createShell(page: Page, cwd: string): Promise<string> {
  const before = await h.ids(page)
  await page.click('#btn-new')
  await page.waitForSelector('#dlg-new[open]')
  await page.fill('#dlg-new .ch-path-input', cwd)
  await page.click('#dlg-new .ch-item[data-id="powershell"]')
  await page.locator('#dlg-new[open]').waitFor({ state: 'hidden' })
  await page.waitForFunction(n => window.__tether.panelIds().length === n, before.length + 1)
  const added = (await h.ids(page)).filter(id => !before.includes(id))
  assert.equal(added.length, 1)
  return added[0]!
}

async function mark(page: Page, id: string, text: string): Promise<void> {
  await page.evaluate(([id, data]) => window.tether.notice({ t: 'input', slotId: id, data }), [id, `Write-Host ${text}\r`] as const)
  await page.waitForFunction(([id, t]) => window.__tether.text(id).includes(t), [id, text] as const, { timeout: 20_000 })
}

async function focusTerm(page: Page, id: string): Promise<void> {
  await page.evaluate(id => window.__tether.activate(id), id)
  await page.locator(`.panel[data-slot-id="${id}"] .panel-term`).click()
  await page.waitForFunction(id => window.__tether.activeId() === id, id)
}

/** Waits until `selector`'s box is laid out (wider than a placeholder) and holds still across a few frames. */
async function settled(page: Page, selector: string): Promise<void> {
  await page.waitForFunction(sel => {
    const w = window as unknown as { __settle?: { key: string; n: number } }
    const r = document.querySelector(sel)?.getBoundingClientRect()
    if (!r || r.width < 160 || r.height < 160) return false
    const key = `${r.x},${r.y},${r.width},${r.height}`
    w.__settle = w.__settle?.key === key ? { key, n: w.__settle.n + 1 } : { key, n: 0 }
    return w.__settle.n >= 3
  }, selector, { polling: 'raf', timeout: 5000 })
}

type Pt = { x: number; y: number }
const tab = (id: string): string => `.tether-tab[data-slot="${id}"]`
/** The content area of the group whose tab bar holds `id`'s tab. */
const groupContent = (id: string, scope = ''): string => `${scope} .dv-groupview:has(${tab(id)}) .dv-content-container`.trim()

async function point(page: Page, selector: string, fx = 0.5, fy = 0.5): Promise<Pt> {
  const r = await h.rect(page, selector)
  assert.ok(r, `nothing at ${selector}`)
  return { x: r.x + r.width * fx, y: r.y + r.height * fy }
}

/** A real mouse drag (HTML5 drag and drop through Chromium); `shot` captures the drop indicator before releasing. */
async function drag(page: Page, from: Pt, to: Pt, shot?: string): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + 8, from.y + 8, { steps: 3 })
  await page.mouse.move(to.x, to.y, { steps: 15 })
  await sleep(120)
  if (shot) await page.screenshot({ path: shot })
  await page.mouse.up()
  await sleep(250) // the move runs once the drag is over
}


test('drag tabs between frames: reorder, into a frame, its edge, a note, a pad and back; same PIDs; relaunch', { timeout: 300_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(artifacts, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-frame-drag-'))
  const work = mkdtempSync(join(tmpdir(), 'tether-frame-drag-work-'))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    const daemonPid = (await h.daemonPid(page))!
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))

    // ---- 1. frame-1: a, c; frame-2: b ----
    console.log('step 1')
    const a = await createShell(page, work)
    await focusTerm(page, a)
    await page.keyboard.press('Alt+Shift+ArrowRight')
    await page.waitForFunction(() => window.__tether.frameIds().length === 2)
    const b = (await h.ids(page)).find(id => id !== a)!
    await focusTerm(page, a)
    const c = await createShell(page, work)
    assert.equal(await h.frameOf(page, a), 'frame-1')
    assert.equal(await h.frameOf(page, c), 'frame-1')
    assert.equal(await h.frameOf(page, b), 'frame-2')
    const pids = await pidsOf(page, [a, b, c])
    for (const [id, t] of [[a, 'marca-a'], [b, 'marca-b'], [c, 'marca-c']] as const) await mark(page, id, t)
    assert.deepEqual(await deskShape(page), { 'frame-1': [a, c], 'frame-2': [b] })

    // ---- 2. reorder inside frame-1 (dockview's own drag) ----
    console.log('step 2')
    await drag(page, await point(page, tab(c)), await point(page, tab(a), 0.2))
    await waitShape(page, { 'frame-1': [c, a], 'frame-2': [b] })

    // ---- 3. a into the center of frame-2: a tab of b's group, active, focused ----
    console.log('step 3')
    await drag(page, await point(page, tab(a)), await point(page, groupContent(b)), join(artifacts, 'frame-drag-center.png'))
    await page.waitForFunction(a => window.__tether.frameOf(a) === 'frame-2', a)
    assert.deepEqual(await deskShape(page), { 'frame-1': [c], 'frame-2': [b, a] })
    assert.equal(await h.activeId(page), a, 'the moved tab is the active pane')
    assert.equal(await h.activeFrame(page), 'frame-2', 'its frame is the focused frame')
    await page.waitForFunction(() => document.querySelectorAll('#dock .frame.focused').length === 1)
    assert.ok(await h.rect(page, `#dock .frame.focused ${tab(a)}`), 'the F6 signal is on the target frame')
    await page.waitForFunction(a => document.activeElement?.closest('.panel')?.getAttribute('data-slot-id') === a, a)
    await page.screenshot({ path: join(artifacts, 'frame-drag-center-done.png') })

    // ---- 4. b onto the left edge of frame-1: a new group inside frame-1, left of c's ----
    console.log('step 4')
    await page.evaluate(id => window.__tether.activate(id), b)
    await drag(page, await point(page, tab(b)), await point(page, groupContent(c), 0.06, 0.5), join(artifacts, 'frame-drag-edge.png'))
    await page.waitForFunction(b => window.__tether.frameOf(b) === 'frame-1', b)
    assert.deepEqual(await deskShape(page), { 'frame-1': [[b], [c]], 'frame-2': [a] })
    const rb = (await h.rect(page, groupContent(b)))!, rc = (await h.rect(page, groupContent(c)))!
    assert.ok(rb.x + rb.width <= rc.x + 2, 'b sits to the left of c')
    assert.equal(await h.activeFrame(page), 'frame-1')

    // ---- 5. a note with fresh text, dragged from frame-2 into frame-1 ----
    console.log('step 5')
    await focusTerm(page, a)
    assert.equal(await page.evaluate(() => window.__tether.runCommand('note.new')), 'ran')
    await page.waitForFunction(() => window.__tether.notes().length === 1)
    const note = (await page.evaluate(() => window.__tether.notes()))[0]!
    assert.equal(await h.frameOf(page, note.id), 'frame-2')
    await page.locator(`.note-panel[data-note-id="${note.id}"] .monaco-editor`).click()
    await page.keyboard.type('texto que viaja')
    await page.waitForFunction(id => window.__tether.note(id)?.text === 'texto que viaja', note.id)
    await drag(page, await point(page, tab(note.id)), await point(page, groupContent(c)))
    await page.waitForFunction(id => window.__tether.frameOf(id) === 'frame-1', note.id)
    await page.waitForFunction(id => window.__tether.note(id)?.text === 'texto que viaja', note.id)
    assert.equal(readFileSync(note.path, 'utf8'), 'texto que viaja', 'the note wrote what it held')
    assert.equal(await h.activeId(page), note.id)

    // ---- 6. a into the desk pad's frame and back ----
    console.log('step 6')
    await page.evaluate(id => window.__tether.togglePad(id), DESK_PAD)
    await page.waitForFunction(() => window.__tether.padFrames().some(p => p.shown && p.panes.length > 0))
    const seed = (await h.pads(page)).find(p => p.shown)!.panes[0]!
    // The pad opens before its frame's dockview takes the pad's size (it starts at dockview's default box): aiming at
    // that first box lands in the left edge band once the frame grows, a new group instead of a tab. Aim once it settled.
    await settled(page, groupContent(seed, '.pad-frames'))
    await drag(page, await point(page, tab(a)), await point(page, groupContent(seed, '.pad-frames')), join(artifacts, 'frame-drag-pad.png'))
    await page.waitForFunction(a => window.__tether.padFrames().some(p => p.panes.includes(a)), a)
    assert.equal(await h.frameOf(page, a), undefined, 'a left the desk')
    await page.waitForFunction(() => document.querySelectorAll('.pad-frames .frame.kbd-focused').length === 1 && document.querySelectorAll('.pad-frames .frame.focused').length === 0 && document.querySelectorAll('#dock .frame.focused').length === 1)
    await page.waitForFunction(a => document.activeElement?.closest('.panel')?.getAttribute('data-slot-id') === a, a)
    await mark(page, a, 'na-prancheta')
    await page.screenshot({ path: join(artifacts, 'frame-drag-pad-done.png') })
    // Grab the tab by its start: in a narrow group a long title is clipped and its middle sits under the group's actions.
    await drag(page, await point(page, tab(a), 0.15, 0.5), await point(page, groupContent(c), 0.94, 0.5))
    await page.waitForFunction(a => window.__tether.frameOf(a) === 'frame-1', a)
    await page.waitForFunction(() => document.querySelectorAll('.pad-frames .frame.kbd-focused').length === 0 && document.querySelectorAll('#dock .frame.focused').length === 1)
    await page.waitForFunction(a => document.activeElement?.closest('.panel')?.getAttribute('data-slot-id') === a, a)
    assert.deepEqual((await deskShape(page))['frame-1'], [[b], [c, note.id], [a]])

    // ---- 7. same PIDs, scrollback kept ----
    console.log('step 7')
    assert.deepEqual(await pidsOf(page, [a, b, c]), pids, 'no process was touched')
    for (const [id, t] of [[a, 'marca-a'], [a, 'na-prancheta'], [b, 'marca-b'], [c, 'marca-c']] as const) {
      assert.ok((await page.evaluate(id => window.__tether.text(id), id)).includes(t), `${id} kept ${t}`)
    }

    // ---- 8. relaunch: the arrangement comes back ----
    console.log('step 8')
    await sleep(800) // debounced save
    const before = await deskShape(page)
    await killElectron(app, root)
    app = undefined
    ;({ app, page } = await launch(home))
    assert.equal(await h.daemonPid(page), daemonPid, 'same tetherd')
    await page.waitForFunction(ids => ids.every(id => window.__tether.frameOf(id) !== undefined), [a, b, c, note.id])
    assert.deepEqual(await deskShape(page), before, 'the dragged layout came back as it was')
    assert.deepEqual(await pidsOf(page, [a, b, c]), pids, 'same PIDs through the window kill')
    await page.screenshot({ path: join(artifacts, 'frame-drag-restored.png') })
    assert.deepEqual(consoleErrors.filter(e => /arrastar|layout inválido|grade de quadros/.test(e)), [], 'no refused move or layout')
  } finally {
    console.log('teardown')
    if (app) await killElectron(app, root).catch(() => {})
    for (const d of daemons) await killOwned(d, { tree: true })
    for (let i = 0; i < 20 && daemons.some(d => pidAlive(d.pid)); i++) await sleep(500)
    for (const dir of [home, work]) {
      for (let i = 0; i < 5; i++) {
        try { rmSync(dir, { recursive: true, force: true }); break } catch { await sleep(300) }
      }
    }
  }
})
