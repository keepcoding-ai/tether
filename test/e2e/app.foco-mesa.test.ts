// E2E of the Foco de Mesa, drop anywhere and the "+N" (hidden window, private home/pipe, real tetherd, shells and notes):
//   (a) the keyboard in a pad's note (typing): the desk's frame keeps the aura (`.frame.focused`), the pad's frame only carries the
//       behaviour marker `.kbd-focused` (no ring, aura or dim: it looks the same with or without the keyboard); a file opened the way the explorer opens one lands in the Foco de Mesa frame, not the pad;
//   (b) the pad emptied by dragging its tabs out shows "Nenhum painel aberto"; a tab dropped there becomes its first frame;
//   (c) a tab dropped on the desk's outer left, right and bottom edge makes a new frame spanning that side;
//   (d) with many tabs, the "+N" sits right after the last visible tab, before the action icons.
// Same PIDs and scrollback throughout. Screenshots in <atrium>/.tmp/tether-foco-mesa.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
  openFile(path: string): Promise<void>
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
const pipe = `\\\\.\\pipe\\tether-foco-mesa-${process.pid}`
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

const shots = process.env.TETHER_SHOTS ?? join(artifacts, 'foco-mesa')
const DESK = '.desk-layer:not(.inactive)'
/** The desk frame (element) holding `id`'s tab. */
const deskFrame = (id: string): string => `${DESK} .frame:has(${tab(id)})`

test('Foco de Mesa: a pad with the keyboard keeps the aura on the desk, files open there; drop anywhere; +N after the tabs', { timeout: 300_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(artifacts, { recursive: true })
  mkdirSync(shots, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-foco-mesa-'))
  const work = mkdtempSync(join(tmpdir(), 'tether-foco-mesa-work-'))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    daemons.push(await claim((await h.daemonPid(page))!, { cmdIncludes: daemonMain, what: 'tetherd' }))

    // ---- frame-1: a; frame-2: b; the Foco de Mesa on frame-1 ----
    console.log('step 1')
    const a = await createShell(page, work)
    await focusTerm(page, a)
    await page.keyboard.press('Alt+Shift+ArrowRight')
    await page.waitForFunction(() => window.__tether.frameIds().length === 2)
    const b = (await h.ids(page)).find(id => id !== a)!
    await focusTerm(page, a)
    const pids = await pidsOf(page, [a, b])
    await mark(page, a, 'marca-a')
    await mark(page, b, 'marca-b')

    // ---- (a) the keyboard in a pad's editor: the aura stays on the desk; a file opens on the desk ----
    console.log('step a')
    await page.evaluate(id => window.__tether.togglePad(id), DESK_PAD)
    await page.waitForFunction(() => window.__tether.padFrames().some(p => p.shown && p.panes.length === 1))
    await page.locator('.pad-frames .dv-tab').first().click()
    assert.equal(await page.evaluate(() => window.__tether.runCommand('note.new')), 'ran')
    await page.waitForFunction(() => window.__tether.notes().length === 1)
    const padNote = (await page.evaluate(() => window.__tether.notes()))[0]!
    assert.ok((await h.pads(page)).some(p => p.panes.includes(padNote.id)), 'the new note is in the pad (the keyboard was there)')
    await page.locator(`.pad-frames .note-panel[data-note-id="${padNote.id}"] .monaco-editor`).click()
    await page.keyboard.type('digitando na prancheta')
    await page.waitForFunction(id => window.__tether.note(id)?.text === 'digitando na prancheta', padNote.id)
    await page.waitForFunction(() => document.querySelectorAll('#workbench .frame.focused').length === 1 && !!document.querySelector('#dock .frame.focused') && document.querySelectorAll('.pad-frames .frame.kbd-focused').length === 1)
    assert.ok(await h.rect(page, `#dock .frame.focused ${tab(a)}`), 'the Foco de Mesa is still a\'s frame')
    const padLook = await page.evaluate(() => {
      const f = document.querySelector('.pad-frames .frame.kbd-focused') as Element
      const dock = f.querySelector(':scope > .frame-dock') as Element
      const cs = (window as unknown as { getComputedStyle(e: unknown, p: string): { content: string; opacity: string } }).getComputedStyle
      return { ring: cs(dock, '::after').content, veil: cs(f, '::after').opacity }
    })
    assert.ok(padLook.ring === 'none' || padLook.ring === 'normal', 'a pad with the keyboard has no ring')
    assert.equal(padLook.veil, '0', 'a pad is never dimmed')
    await page.screenshot({ path: join(shots, 'a-pad-typing-dark.png') })
    await page.click('#btn-menu')
    await page.waitForSelector('#app-menu:not([hidden])')
    await page.click('#app-menu li[data-theme="light"]')
    await page.waitForFunction(() => (document.querySelector('html') as unknown as { dataset: Record<string, string> }).dataset.theme === 'light')
    await new Promise(r => setTimeout(r, 400))
    await page.screenshot({ path: join(shots, 'a-pad-typing-light.png') })
    const file = join(work, 'leia-me.txt')
    writeFileSync(file, 'conteúdo do arquivo')
    await page.evaluate(p => window.__tether.openFile(p), file)
    await page.waitForFunction(p => window.__tether.notes().some(n => n.path.toLowerCase() === p.toLowerCase()), file)
    const opened = (await page.evaluate(() => window.__tether.notes())).find(n => n.path.toLowerCase() === file.toLowerCase())!
    assert.equal(await h.frameOf(page, opened.id), 'frame-1', 'the file opened in the Foco de Mesa frame, not in the pad')
    assert.ok(!(await h.pads(page)).some(p => p.panes.includes(opened.id)), 'nothing opened in the pad')
    await page.screenshot({ path: join(shots, 'a-file-on-desk.png') })

    // ---- (b) a pad is one frame: emptied it shows the chooser; drops join that frame, its edge never adds another ----
    console.log('step b')
    const padFrameCount = () => page.evaluate(() => (document as unknown as { querySelectorAll(s: string): { length: number } }).querySelectorAll('.pad.shown .pad-frames .frame:has(> .frame-dock)').length)
    const shownPanes = async () => (await h.pads(page)).find(p => p.shown)!.panes
    const seed0 = (await shownPanes()).find(id => id !== padNote.id)!
    for (const id of [padNote.id, seed0]) {
      await page.evaluate(id => window.__tether.activate(id), id)
      await drag(page, await point(page, `.pad-frames ${tab(id)}`), await point(page, groupContent(b)))
      await page.waitForFunction(id => window.__tether.frameOf(id) === 'frame-2', id)
    }
    // Emptied: the pad seeds its chooser again, in its one frame.
    await page.waitForFunction(() => window.__tether.padFrames().some(p => p.shown && p.panes.length === 1 && p.panes[0]!.startsWith('empty:')))
    await page.waitForSelector('.pad.shown .pad-frames .ch')
    assert.equal(await padFrameCount(), 1, 'an empty pad is one frame with the chooser')
    await page.screenshot({ path: join(shots, 'b-pad-empty.png') })
    const seed1 = (await shownPanes())[0]!
    await drag(page, await point(page, tab(b)), await point(page, groupContent(seed1, '.pad-frames')), join(shots, 'b-drop-hint.png'))
    await page.waitForFunction(b => window.__tether.padFrames().some(p => p.shown && p.panes.includes(b)), b)
    assert.equal(await h.frameOf(page, b), undefined, 'b left the desk')
    assert.equal(await padFrameCount(), 1, 'a drop on the pad joins its one frame')
    const pr = (await h.rect(page, '.pad.shown .pad-frames'))!
    await drag(page, await point(page, tab(padNote.id)), { x: pr.x + pr.width - 4, y: pr.y + pr.height / 2 }, join(shots, 'b-pad-edge-hint.png'))
    await page.waitForFunction(id => window.__tether.padFrames().some(p => p.shown && p.panes.includes(id)), padNote.id)
    assert.equal(await padFrameCount(), 1, 'a drop on the outer edge of the pad never makes a second frame')
    await page.screenshot({ path: join(shots, 'b-pad-got-tabs.png') })
    await page.evaluate(id => window.__tether.togglePad(id), DESK_PAD)
    await page.waitForFunction(() => !window.__tether.padFrames().some(p => p.shown))

    // ---- (c) the desk's outer left / right / bottom edge: a new frame spanning that side ----
    console.log('step c')
    for (const side of ['left', 'right', 'bottom'] as const) {
      const before = await h.frameIds(page)
      const moving = side === 'left' ? a : side === 'right' ? seed0 : opened.id
      const d = (await h.rect(page, DESK))!
      const to = side === 'left' ? { x: d.x + 5, y: d.y + d.height / 2 } : side === 'right' ? { x: d.x + d.width - 5, y: d.y + d.height / 2 } : { x: d.x + d.width / 2, y: d.y + d.height - 5 }
      await page.evaluate(id => window.__tether.activate(id), moving)
      await drag(page, await point(page, tab(moving)), to, join(shots, `c-edge-${side}-hint.png`))
      await page.waitForFunction(([n, id]) => window.__tether.frameIds().length === n && !!window.__tether.frameOf(id), [before.length + 1, moving] as const).catch(async () => {
        // The source frame may have emptied and gone: the count stays, the pane still sits alone in a new frame.
      })
      const f = (await h.rect(page, deskFrame(moving)))!
      await page.screenshot({ path: join(shots, `c-edge-${side}.png`) })
      if (side === 'bottom') {
        assert.ok(f.width >= d.width - 20, `bottom: the new frame spans the desk's width (${f.width} of ${d.width})`)
        assert.ok(f.y + f.height >= d.y + d.height - 12, 'bottom: it sits at the bottom')
      } else {
        assert.ok(f.height >= d.height - 20, `${side}: the new frame spans the desk's height (${f.height} of ${d.height})`)
        assert.ok(side === 'left' ? f.x <= d.x + 12 : f.x + f.width >= d.x + d.width - 12, `${side}: it sits on that side`)
      }
      assert.equal(await page.evaluate(() => window.__tether.activeFrameId()), await h.frameOf(page, moving), 'the new frame is the Foco de Mesa')
    }
    assert.deepEqual(await pidsOf(page, [a, b]), pids, 'no process was touched')
    assert.ok((await page.evaluate(id => window.__tether.text(id), a)).includes('marca-a'), 'a kept its scrollback')
    await page.waitForFunction(id => window.__tether.note(id)?.text === 'digitando na prancheta', padNote.id)

    // ---- (d) the "+N" sits right after the last visible tab, before the actions ----
    console.log('step d')
    await focusTerm(page, a)
    for (let i = 0; i < 8; i++) assert.equal(await page.evaluate(() => window.__tether.runCommand('note.new')), 'ran')
    const more = `${deskFrame(a)} .dv-tabs-and-actions-container .tab-more`
    await page.waitForFunction(sel => { const m = document.querySelector(sel) as unknown as { hidden: boolean } | null; return !!m && !m.hidden }, more)
    const pos = await page.evaluate(([sel, frame]) => {
      type R = { left: number; right: number }
      type El = { getBoundingClientRect(): R; closest(s: string): El | null; querySelector(s: string): El | null; querySelectorAll(s: string): ArrayLike<El> & Iterable<El> }
      const doc = document as unknown as { querySelector(s: string): El | null }
      const m = doc.querySelector(sel)!.getBoundingClientRect()
      const head = doc.querySelector(sel)!.closest('.dv-tabs-and-actions-container')!
      const tabs = [...head.querySelectorAll('.dv-tabs-container > .dv-tab:not(.tab-hidden)')].map(t => t.getBoundingClientRect())
      const acts = head.querySelector('.tab-actions')!.getBoundingClientRect()
      void frame
      return { more: m.left, moreRight: m.right, lastTab: Math.max(...tabs.map(t => t.right)), actions: acts.left }
    }, [more, deskFrame(a)] as const)
    assert.ok(pos.more >= pos.lastTab - 1 && pos.more - pos.lastTab <= 8, `the +N follows the last visible tab (${JSON.stringify(pos)})`)
    assert.ok(pos.moreRight <= pos.actions + 1, 'the +N is before the action icons')
    await page.screenshot({ path: join(shots, 'd-plus-n.png') })
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
