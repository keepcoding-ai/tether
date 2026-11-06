// E2E of the side bars' core (F10a) with shells only (hidden window, private home/pipe, real tetherd, CLAUDE* stripped):
//   1. a v2 layout.json (two desks, a split frame, the drawer) written by hand restores intact under the v3 code: same
//      desks, frames and panes (same PIDs), the drawer's pane in the drawer; layout.v2.bak keeps the v2 file; the first
//      change the person makes writes v3 with the side bars and the desks untouched;
//   2. with no extension declaring a pad, neither side bar shows (no strip), the desks take the whole width, and the
//      side bar commands are unavailable (their keys pass: Ctrl+B in the window does nothing).
// The pads themselves (icons, toggles, moving, widths) are proven with the frame pads (F10b).
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
  desks(): { id: string; name: string; panes: string[] }[]
  createDesk(side: 'before' | 'after'): string
  switchDesk(id: string): void
  activeDesk(): string
  openSlot(id: string): void
  drawer(): { open: boolean; panes: string[] }
  movePaneToDrawer(slotId: string): void
  duplicate(slotId: string, direction: string, level?: string): void
  frameIds(): string[]
  sidebars(): { left: { strip: string[]; open?: string }; right: { strip: string[]; open?: string } } | undefined
  runCommand(id: string): Promise<string>
  renameDesk(id: string, name: string): void
}
declare const window: { __tether: Hooks; tether: { request(body: unknown): Promise<{ t: string; slot?: SlotState }> } }
declare const document: { querySelector(s: string): { hidden: boolean; getBoundingClientRect(): { width: number } } | null }

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
    assert.equal(live.v, 3, 'the app writes v3')
    const v2: LayoutJSON = { v: 2, desks: live.desks.map(({ pads: _p, ...rest }) => rest), activeDesk: live.activeDesk, drawer: live.drawer }
    await killElectron(app, root)
    app = undefined
    writeFileSync(join(home, 'layout.json'), JSON.stringify(v2, null, 2))

    // ---- relaunch: the v2 file restores intact ----
    ;({ app, page } = await launch(home))
    await page.waitForFunction(n => window.__tether.panelIds().length >= n, 3, { timeout: 20_000 })
    const back = await page.evaluate(() => window.__tether.layout())
    assert.equal(back.v, 3)
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

    // ---- the first change writes v3, desks untouched ----
    await page.evaluate(id => window.__tether.renameDesk(id, 'Revisão 2'), desk2)
    let saved: LayoutJSON | undefined
    for (let i = 0; i < 40; i++) { saved = JSON.parse(readFileSync(join(home, 'layout.json'), 'utf8')) as LayoutJSON; if (saved.v === 3) break; await sleep(100) }
    assert.equal(saved!.v, 3)
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
