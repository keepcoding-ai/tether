// E2E of phase B (frames inside the desk), with shells only (hidden windows, private home/pipe, real tetherd,
// CLAUDE* stripped and --model haiku set in case a Claude is ever launched):
//   1. two shell panes side by side; the window is killed and layout.json is rewritten as a v1 file (the
//      frame's dockview JSON alone, as the app wrote it before phase B): the relaunch migrates it (same panes,
//      same arrangement, same shell PIDs), keeps layout.v1.bak byte for byte, and writes the current version (v4) back;
//   2. Ctrl+Alt+Shift+↓ duplicates the focused pane at the frame's bottom edge, spanning the frame's width;
//   3. Alt+Shift+→ duplicates into a new frame at the desk's right edge;
//   4. the builder mode: the "+" at every border shown at once (none outside it); a click on a tab activates nothing;
//      the desk's "+" right-click duplicates into a new frame, a frame's "+" opens the chooser preset to that edge
//      (the mode stays on); a double click on a frame leaves it with that frame in focus;
//   5. the chooser's "Onde" has the three levels; "Mesa · abaixo" opens a PowerShell in a frame spanning the desk;
//   6. window kill + relaunch: same frames, same pane-to-frame assignment, same PIDs;
//   7. the last pane of a frame leaves (slot forgotten): the frame goes with it;
//   8. in the builder mode a tab still drags into another frame.
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

type Hooks = {
  panelIds(): string[]
  activeId(): string | undefined
  layout(): unknown
  frameLayout(frameId?: string): unknown
  frameIds(): string[]
  activeFrameId(): string | undefined
  frameOf(slotId: string): string | undefined
  slots(): SlotState[]
  text(id: string): string
  connection(): { connected: boolean; pid?: number } | undefined
  activate(id: string): void
  builder(): boolean
  setBuilder(on: boolean): void
}
declare const window: {
  __tether: Hooks
  tether: { request(body: unknown): Promise<{ t: 'ok'; slot?: SlotState } | { t: 'error'; code: string; message: string }> }
}
declare const document: {
  querySelectorAll(selector: string): { length: number }
  querySelector(selector: string): { getBoundingClientRect(): { x: number; y: number; width: number; height: number } } | null
}

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const artifacts = join(root, 'test', 'e2e', 'artifacts')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-frames-${process.pid}`

type DockLayout = { grid: { root: Node }; panels: Record<string, unknown> }
type Node = { type: 'leaf' | 'branch'; data: { views: string[] } | Node[] }
type LayoutV2 = { v: number; desks: Array<{ id: string; frames: { grid: unknown; views: Record<string, DockLayout> }; activeFrame?: string }>; activeDesk: string }

/** Arrangement only (views per leaf, nesting), ignoring sizes and group ids. */
function shape(node: Node): unknown {
  return node.type === 'leaf' ? (node.data as { views: string[] }).views : (node.data as Node[]).map(shape)
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

async function waitUntil(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timeout (${timeoutMs} ms) waiting for ${what}`)
    await sleep(100)
  }
}

/** Renderer console errors of every launch: a layout refused by dockview (and reopened pane by pane) must fail the test. */
const consoleErrors: string[] = []

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
  page.on('console', m => { if (m.type() === 'error') { console.error(`renderer console: ${m.text()}`); consoleErrors.push(m.text()) } })
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  return { app, page }
}

const hooks = {
  ids: (page: Page) => page.evaluate(() => window.__tether.panelIds()),
  frameIds: (page: Page) => page.evaluate(() => window.__tether.frameIds()),
  activeFrame: (page: Page) => page.evaluate(() => window.__tether.activeFrameId()),
  frameOf: (page: Page, id: string) => page.evaluate(id => window.__tether.frameOf(id), id),
  frameLayout: (page: Page, frameId?: string) => page.evaluate(f => window.__tether.frameLayout(f) as unknown as DockLayout, frameId),
  layout: (page: Page) => page.evaluate(() => window.__tether.layout() as unknown as LayoutV2),
  slots: (page: Page) => page.evaluate(() => window.__tether.slots()),
  daemonPid: async (page: Page) => (await page.evaluate(() => window.__tether.connection()))?.pid,
  rect: (page: Page, selector: string) => page.evaluate(sel => { const r = document.querySelector(sel)?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : undefined }, selector),
}

async function waitTabs(page: Page, n: number): Promise<void> {
  await page.waitForFunction(n => document.querySelectorAll('.tether-tab').length === n, n)
}

async function waitRunning(page: Page, ids: string[]): Promise<Map<string, number>> {
  await page.waitForFunction(ids => {
    const slots = window.__tether.slots()
    return ids.every(id => { const s = slots.find(x => x.slotId === id); return s?.status === 'running' && typeof s.pid === 'number' })
  }, ids, { timeout: 20_000 })
  const pids = new Map<string, number>()
  for (const s of await hooks.slots(page)) if (ids.includes(s.slotId)) pids.set(s.slotId, s.pid!)
  return pids
}

/** Clicks into a pane's terminal so the keyboard chords go through it. */
async function focusPane(page: Page, id: string): Promise<void> {
  await page.evaluate(id => window.__tether.activate(id), id)
  await page.locator(`.panel[data-slot-id="${id}"] .panel-term`).click()
  await page.waitForFunction(id => window.__tether.activeId() === id, id)
}

async function createShell(page: Page, cwd: string, placement?: string): Promise<void> {
  const before = (await hooks.ids(page)).length
  await page.click('#btn-new')
  await page.waitForSelector('#dlg-new[open]')
  await page.fill('#dlg-new .ch-path-input', cwd)
  if (placement) {
    // "Onde" is one line until opened; the chips are buttons. `placement` is a target key, "level:placement".
    const [level, where] = placement.split(':')
    await page.click('#dlg-new .where-sum')
    await page.click(`#dlg-new .placement[data-level="${level}"][data-placement="${where}"]`)
    assert.equal(await page.locator(`#dlg-new .placement[data-level="${level}"][data-placement="${where}"]`).getAttribute('aria-pressed'), 'true', `${placement} chosen`)
  }
  await page.click('#dlg-new .ch-item[data-id="powershell"]')
  await page.locator('#dlg-new[open]').waitFor({ state: 'hidden' })
  await waitTabs(page, before + 1)
}

const newId = (before: string[], after: string[]): string => {
  const added = after.filter(id => !before.includes(id))
  assert.equal(added.length, 1, `exactly one new pane (before ${before}, after ${after})`)
  return added[0]!
}

const near = (a: number, b: number, tol: number, what: string): void => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`)

// Hard cap: a hung Electron main (no window, no CDP answer) must fail the test, not hold the runner forever.
test('frames: v1 migration keeps the panes; pane at the frame edge; frame at the desk edge; "+"; chooser levels; relaunch; empty frame leaves', { timeout: 300_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(artifacts, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-frames-'))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    const daemonPid = (await hooks.daemonPid(page))!
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))

    // ---- 1. two panes in one frame, saved as v1, migrated on relaunch ----
    await createShell(page, root)
    const [a] = await hooks.ids(page)
    await focusPane(page, a!)
    await page.keyboard.press('Control+Backslash')
    await waitTabs(page, 2)
    const ids2 = await hooks.ids(page)
    const b = newId([a!], ids2)
    const pids = await waitRunning(page, ids2)
    await sleep(800) // debounced save
    const saved = JSON.parse(readFileSync(join(home, 'layout.json'), 'utf8')) as LayoutV2
    assert.equal(saved.v, 4, 'the app writes the current version (v4 since N1a)')
    assert.deepEqual(await hooks.frameIds(page), ['frame-1'])
    const frameView = saved.desks[0]!.frames.views['frame-1']!
    assert.deepEqual(Object.keys(frameView.panels).sort(), [a, b].sort())
    const shapeBefore = shape(frameView.grid.root)

    await killElectron(app, root)
    app = undefined
    const v1Text = JSON.stringify(frameView, null, 2)
    writeFileSync(join(home, 'layout.json'), v1Text) // what the app wrote before phase B
    ;({ app, page } = await launch(home))
    assert.equal(await hooks.daemonPid(page), daemonPid, 'same tetherd')
    await waitTabs(page, 2)
    assert.deepEqual([...(await hooks.ids(page))].sort(), [a, b].sort(), 'the migrated layout opens the same panes')
    assert.deepEqual(await hooks.frameIds(page), ['frame-1'])
    assert.deepEqual(shape((await hooks.frameLayout(page)).grid.root), shapeBefore, 'same arrangement inside the frame')
    const pidsAfterMigration = await waitRunning(page, [a!, b])
    assert.deepEqual([...pidsAfterMigration].sort(), [...pids].sort(), 'same shell PIDs')
    await sleep(800)
    assert.ok(existsSync(join(home, 'layout.v1.bak')), 'layout.v1.bak written')
    assert.equal(readFileSync(join(home, 'layout.v1.bak'), 'utf8'), v1Text, 'the backup is the v1 file byte for byte')
    // Restoring is not a change the person made: layout.json stays v1 until they change something (planRestore).
    assert.equal(readFileSync(join(home, 'layout.json'), 'utf8'), v1Text, 'layout.json untouched by the restore')
    await page.screenshot({ path: join(artifacts, 'frames-migrated.png') })

    // ---- 2. Ctrl+Alt+Shift+↓: a pane at the frame's bottom edge, spanning its width ----
    await focusPane(page, a!)
    await page.keyboard.press('Control+Alt+Shift+ArrowDown')
    await waitTabs(page, 3)
    const c = newId([a!, b], await hooks.ids(page))
    assert.equal(await hooks.frameOf(page, c), 'frame-1', 'same frame')
    await sleep(800) // debounced save of the person's first change
    const rewritten = JSON.parse(readFileSync(join(home, 'layout.json'), 'utf8')) as LayoutV2
    assert.equal(rewritten.v, 4, 'the first change rewrites layout.json in the current version')
    assert.deepEqual(Object.keys(rewritten.desks[0]!.frames.views['frame-1']!.panels).sort(), [a, b, c].sort())
    const layoutC = await hooks.frameLayout(page, 'frame-1')
    const topLevel = (layoutC.grid.root.data as Node[])
    assert.ok(topLevel.some(n => n.type === 'leaf' && (n.data as { views: string[] }).views.includes(c)), `the new pane is a direct child of the frame's root: ${JSON.stringify(shape(layoutC.grid.root))}`)
    const frameRect = (await hooks.rect(page, '.frame .frame-dock'))!
    const cRect = (await hooks.rect(page, `.panel[data-slot-id="${c}"]`))!
    near(cRect.width, frameRect.width, 12, 'the edge pane spans the frame width')
    const cSlot = (await hooks.slots(page)).find(s => s.slotId === c)!
    assert.equal(cSlot.kind, 'shell'); assert.equal(cSlot.cwd, root)

    // ---- 3. Alt+Shift+→: a new frame at the desk's right edge with the duplicate ----
    await focusPane(page, c)
    await page.keyboard.press('Alt+Shift+ArrowRight')
    await waitTabs(page, 4)
    const d = newId([a!, b, c], await hooks.ids(page))
    await page.waitForFunction(() => window.__tether.frameIds().length === 2)
    const frames2 = await hooks.frameIds(page)
    assert.deepEqual(frames2, ['frame-1', 'frame-2'])
    assert.equal(await hooks.frameOf(page, d), 'frame-2')
    assert.equal(await hooks.activeFrame(page), 'frame-2', 'focus follows the new frame')
    const f1 = (await hooks.rect(page, '.frame:has([data-slot-id="' + a + '"])'))!
    const f2 = (await hooks.rect(page, '.frame:has([data-slot-id="' + d + '"])'))!
    assert.ok(f2.x > f1.x + f1.width - 8, 'the new frame is to the right')
    near(f2.height, f1.height, 8, 'the new frame spans the desk height')
    await page.screenshot({ path: join(artifacts, 'frames-two.png') })

    // ---- 4. the "+" at the borders: only in the builder mode ----
    assert.equal(await page.locator('.edge-plus:visible').count(), 0, 'no "+" outside the builder mode')
    await page.click('#btn-builder')
    await page.waitForFunction(() => window.__tether.builder())
    assert.equal(await page.locator('#btn-builder').getAttribute('aria-pressed'), 'true')
    // Every "+" at once, the mouse never moved to an edge: 4 at the desk's edges, 4 per frame.
    assert.equal(await page.locator('#dock .edge-plus.desk:visible').count(), 4, 'four "+" at the desk edges')
    assert.equal(await page.locator('#dock .edge-plus.frame:visible').count(), 8, 'four "+" per frame')
    await page.screenshot({ path: join(artifacts, 'frames-plus-desk.png') })
    // A click on a tab of another frame activates nothing (the tabs only drag in the builder).
    assert.equal(await page.evaluate(() => window.__tether.activeId()), d)
    await page.locator(`.dv-tab:has(.tether-tab[data-slot="${a}"])`).click()
    await sleep(250)
    assert.equal(await page.evaluate(() => window.__tether.activeId()), d, 'a click on a tab activates nothing in the builder')
    assert.equal(await hooks.activeFrame(page), 'frame-2', 'the Foco de Mesa stays put')
    // A click ADDS an empty pane in a new frame (the chooser inside it); "Duplicar" lives in its right-click menu.
    await page.click('.edge-plus.desk[data-side="right"]:visible', { button: 'right' })
    await page.waitForSelector('#ctx-menu')
    await page.click('#ctx-menu li:has-text("Duplicar")')
    await waitTabs(page, 5)
    const e = newId([a!, b, c, d], await hooks.ids(page))
    await page.waitForFunction(() => window.__tether.frameIds().length === 3)
    assert.equal(await hooks.frameOf(page, e), 'frame-3')
    assert.equal((await hooks.slots(page)).find(s => s.slotId === e)?.kind, 'shell', 'a duplicate of the focused pane')
    assert.ok(await page.evaluate(() => window.__tether.builder()), 'the builder mode stays on after a "+"')
    assert.equal(await page.locator('#dock .edge-plus.frame:visible').count(), 12, 'the new frame has its four "+" at once')
    // The frame's top "+" sits under the tab bar, never over a tab.
    const tab = (await hooks.rect(page, '.frame:has([data-slot-id="' + e + '"]) .dv-tab'))!
    const topPlus = (await page.locator('.edge-plus.frame[data-frame="frame-3"][data-side="top"]').boundingBox())!
    assert.ok(topPlus.y >= tab.y + tab.height, `the top "+" is below the tab bar: ${topPlus.y} vs ${tab.y + tab.height}`)
    await page.screenshot({ path: join(artifacts, 'frames-plus-frame.png') })
    await page.click('.edge-plus.frame[data-frame="frame-3"][data-side="top"]', { button: 'right' })
    await page.waitForSelector('#ctx-menu')
    await page.click('#ctx-menu li:has-text("modo foco")')
    await page.waitForSelector('#dlg-new[open]')
    assert.equal(await page.locator('#dlg-new .where-sum .w').innerText(), 'na borda do quadro, acima', 'the focus-mode popup opens preset to that edge')
    await page.click('#dlg-new .where-sum')
    await page.screenshot({ path: join(artifacts, 'frames-chooser-levels.png') })
    assert.equal(await page.locator('#dlg-new .placement-group').count(), 3, 'three levels in "Onde"')
    await page.click('#dlg-new .btn.cancel')
    await page.locator('#dlg-new[open]').waitFor({ state: 'hidden' }) // a closed <dialog> is not visible: wait for it to go, not to show
    assert.ok(await page.evaluate(() => window.__tether.builder()), 'still in the builder mode')
    // A double click on frame-1 (over a's dimmed content) leaves the builder with frame-1 in focus: its active pane (c,
    // the last one used there) takes the keyboard.
    const aRect = (await hooks.rect(page, `.panel[data-slot-id="${a}"]`))!
    await page.mouse.dblclick(aRect.x + aRect.width / 2, aRect.y + aRect.height / 2)
    await page.waitForFunction(() => !window.__tether.builder())
    assert.equal(await page.locator('#btn-builder').getAttribute('aria-pressed'), 'false')
    assert.equal(await hooks.activeFrame(page), 'frame-1', 'the double-clicked frame has the focus')
    await page.waitForFunction(id => window.__tether.activeId() === id, c)
    await page.waitForFunction(id => {
      const doc = (globalThis as unknown as { document: { activeElement: { closest(s: string): { getAttribute(n: string): string | null } | null } | null } }).document
      return doc.activeElement?.closest('.panel')?.getAttribute('data-slot-id') === id
    }, c)
    assert.equal(await page.locator('.edge-plus:visible').count(), 0, 'out of the builder: no "+"')

    // ---- 5. chooser: "Mesa · abaixo" opens a PowerShell in a frame spanning the desk ----
    await focusPane(page, a!)
    await createShell(page, root, 'desk:below')
    const f = newId([a!, b, c, d, e], await hooks.ids(page))
    await page.waitForFunction(() => window.__tether.frameIds().length === 4)
    assert.equal(await hooks.frameOf(page, f), 'frame-4')
    const f4 = (await hooks.rect(page, '.frame:has([data-slot-id="' + f + '"])'))!
    const grid = (await hooks.rect(page, '.desk-grid'))!
    near(f4.width, grid.width, 8, 'the bottom frame spans the desk width')
    assert.ok(f4.y > f1.y + 20, 'the new frame is below')
    await page.screenshot({ path: join(artifacts, 'frames-four.png') })
    const all = [a!, b, c, d, e, f]
    const pidsAll = await waitRunning(page, all)
    const assignment = Object.fromEntries(await Promise.all(all.map(async id => [id, await hooks.frameOf(page, id)] as const)))
    await sleep(800)

    // ---- 6. window kill + relaunch: same frames, same assignment, same PIDs ----
    await killElectron(app, root)
    app = undefined
    ;({ app, page } = await launch(home))
    await waitTabs(page, 6)
    assert.deepEqual([...(await hooks.frameIds(page))].sort(), ['frame-1', 'frame-2', 'frame-3', 'frame-4'])
    const assignmentAfter = Object.fromEntries(await Promise.all(all.map(async id => [id, await hooks.frameOf(page, id)] as const)))
    assert.deepEqual(assignmentAfter, assignment, 'every pane is back in its frame')
    const pidsAfter = await waitRunning(page, all)
    assert.deepEqual([...pidsAfter].sort(), [...pidsAll].sort(), 'same shell PIDs through the window kill')
    await page.screenshot({ path: join(artifacts, 'frames-restored.png') })

    // ---- 7. the last pane of frame-2 leaves: the frame goes ----
    await page.evaluate(id => window.tether.request({ t: 'forget', slotId: id }), d)
    await waitTabs(page, 5)
    await page.waitForFunction(() => !window.__tether.frameIds().includes('frame-2'))
    assert.deepEqual([...(await hooks.frameIds(page))].sort(), ['frame-1', 'frame-3', 'frame-4'])
    await sleep(800)
    const finalFile = JSON.parse(readFileSync(join(home, 'layout.json'), 'utf8')) as LayoutV2
    assert.deepEqual(Object.keys(finalFile.desks[0]!.frames.views).sort(), ['frame-1', 'frame-3', 'frame-4'])

    // ---- 8. builder mode: a tab still drags into another frame (dockview's native drag is never guarded) ----
    await page.evaluate(() => window.__tether.setBuilder(true))
    const from = (await hooks.rect(page, `.dv-tab:has(.tether-tab[data-slot="${e}"])`))!
    const to = (await hooks.rect(page, `.dv-tab:has(.tether-tab[data-slot="${a}"])`))!
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(from.x + from.width / 2 + 8, from.y + from.height / 2 + 8, { steps: 3 })
    await page.mouse.move(to.x + to.width * 0.8, to.y + to.height / 2, { steps: 15 })
    await sleep(120)
    await page.mouse.up()
    await page.waitForFunction(id => window.__tether.frameOf(id) === 'frame-1', e)
    assert.ok(await page.evaluate(() => window.__tether.builder()), 'still in the builder after the drag')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !window.__tether.builder())
  } finally {
    if (app) await killElectron(app, root).catch(() => {})
    for (const d of daemons) await killOwned(d, { tree: true })
    await waitUntil(() => daemons.every(d => !pidAlive(d.pid)), 10_000, 'tetherd processes to exit').catch(() => {})
    for (let i = 0; i < 5; i++) {
      try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
  }
})
