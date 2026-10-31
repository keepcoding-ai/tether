// E2E of the "Mover…" dialog, with shells only (hidden window, private home/pipe, real tetherd, CLAUDE* stripped,
// TETHER_CLAUDE_ARGS unset, no tray icon):
//   1. desk 1 holds a and b (tabs of one group), desk 2 holds c;
//   2. right-click a's tab → "Mover…": desk 2's frame, "À direita" of c → a sits beside c (screen kept);
//   3. the ≡ menu's "Mover…" (active pane b): "Como aba" of c's group → b is a tab next to c;
//   4. c into the drawer ("Novo quadro abaixo" of the Gaveta);
//   5. c out of the drawer (its tab's "Mover…") into a new frame of desk 1 (another desk: the drawer stays open);
//   6. the whole frame of a (desk 2: a | b) beside c's frame on desk 1 ("O quadro inteiro");
//   7. the PIDs never changed and every screen kept its scrollback;
//   8. the keyboard path: search, Esc clears it, Esc cancels, ←→ collapse/expand, ↓ selects, Tab to a zone, Enter moves;
//   9. screenshots of the dialog (light and dark), then a window kill + relaunch keeps the layout.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type Group = { kind: 'group'; id: string; panes: { id: string; title: string }[] }
type Node = Group | { kind: 'split'; children: Node[] }
type Scope = { id: string; kind: string; frames: { id: string; layout: Node; panes: { id: string }[] }[] }
type Hooks = {
  panelIds(): string[]
  slots(): SlotState[]
  text(id: string): string
  connection(): { connected: boolean; pid?: number } | undefined
  activeDesk(): string
  deskOf(slotId: string): string | undefined
  inDrawer(slotId: string): boolean
  drawer(): { open: boolean; panes: string[] }
  openMove(slotId: string, mode?: 'pane' | 'frame'): void
  moveTree(): Scope[]
  activate(slotId: string): void
}
declare const window: { __tether: Hooks; tether: { notice(n: unknown): void } }
declare const document: { activeElement: { closest(s: string): { getAttribute(n: string): string | null } | null } | null; documentElement: { dataset: Record<string, string> } }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const artifacts = join(root, 'test', 'e2e', 'artifacts')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-move-${process.pid}`

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
  ids: (page: Page) => page.evaluate(() => window.__tether.panelIds()),
  slots: (page: Page) => page.evaluate(() => window.__tether.slots()),
  deskOf: (page: Page, id: string) => page.evaluate(id => window.__tether.deskOf(id), id),
  tree: (page: Page) => page.evaluate(() => window.__tether.moveTree()),
  daemonPid: async (page: Page) => (await page.evaluate(() => window.__tether.connection()))?.pid,
}

const groupsOf = (n: Node): Group[] => n.kind === 'group' ? [n] : n.children.flatMap(groupsOf)
/** Per scope, its frames as lists of groups (each a list of pane ids). */
async function shape(page: Page): Promise<Record<string, string[][][]>> {
  const out: Record<string, string[][][]> = {}
  for (const s of await h.tree(page)) out[s.id] = s.frames.map(f => groupsOf(f.layout).map(g => g.panes.map(p => p.id)))
  return out
}

async function pidsOf(page: Page, ids: string[]): Promise<Record<string, number>> {
  await page.waitForFunction(ids => ids.every(id => { const s = window.__tether.slots().find(x => x.slotId === id); return s?.status === 'running' && typeof s.pid === 'number' }), ids, { timeout: 20_000 })
  const out: Record<string, number> = {}
  for (const s of await h.slots(page)) if (ids.includes(s.slotId)) out[s.slotId] = s.pid!
  return out
}

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

async function mark(page: Page, id: string, text: string): Promise<void> {
  await page.evaluate(([id, data]) => window.tether.notice({ t: 'input', slotId: id, data }), [id, `Write-Host ${text}\r`] as const)
  await page.waitForFunction(([id, t]) => window.__tether.text(id).includes(t), [id, text] as const, { timeout: 20_000 })
}

const dialogOpen = (page: Page) => page.waitForSelector('dialog.move[open]')
const dialogClosed = (page: Page) => page.waitForSelector('dialog.move', { state: 'detached' })

test('move dialog: pane beside / as a tab / drawer in and out / whole frame, same PIDs, keyboard, relaunch', { timeout: 300_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(artifacts, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-move-'))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    const daemonPid = (await h.daemonPid(page))!
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))

    // ---- 1. desk 1: a, b (one group); desk 2: c ----
    console.log('step 1')
    const a = await createShell(page, root)
    await page.keyboard.press('Control+Alt+N')
    await page.waitForFunction(() => window.__tether.activeDesk() === 'desk-2')
    const c = await createShell(page, root)
    await page.keyboard.press('Control+1')
    await page.waitForFunction(() => window.__tether.activeDesk() === 'desk-1')
    const b = await createShell(page, root)
    const pids = await pidsOf(page, [a, b, c])
    for (const [id, t] of [[a, 'marca-a'], [b, 'marca-b'], [c, 'marca-c']] as const) await mark(page, id, t)
    assert.deepEqual((await shape(page))['desk-1'], [[[a, b]]])
    assert.deepEqual((await shape(page))['desk-2'], [[[c]]])

    // ---- 2. a → desk 2's frame, to the right of c (the tab's right-click menu) ----
    console.log('step 2')
    await page.locator(`.desk-layer[data-desk="desk-1"] .tether-tab`).first().click({ button: 'right' })
    await page.click('#ctx-menu li:has-text("Mover…")')
    await dialogOpen(page)
    assert.equal(await page.isDisabled('#mv-go'), true, 'Mover waits for a zone')
    assert.ok((await page.locator('dialog.move .mv-row.d[data-scope="desk-1"] .atual').count()) === 1, 'the current desk is marked')
    // the source's own group: "Como aba" is off
    assert.equal(await page.getAttribute(`dialog.move .mv-pn.src .z-tab`, 'aria-disabled'), 'true')
    await page.click('dialog.move .mv-row.f[data-scope="desk-2"]')
    await page.hover('dialog.move .mv-pn .z-right')
    await page.waitForSelector('dialog.move .mv-pn[data-pv="right"]')
    await page.click('dialog.move .mv-pn .z-right')
    assert.match((await page.textContent('#mv-summary'))!, /Mesa 2 › Quadro 1, à direita/)
    await page.click('#mv-go')
    await dialogClosed(page)
    await page.waitForFunction(id => window.__tether.deskOf(id) === 'desk-2', a)
    assert.deepEqual((await shape(page))['desk-2'], [[[c], [a]]], 'a beside c, on its right')
    await page.waitForFunction(id => window.__tether.text(id).includes('marca-a'), a)

    // ---- 3. b as a tab of c's group, from the ≡ menu (b is the active pane of desk 1) ----
    console.log('step 3')
    await page.click('#btn-menu')
    await page.click('#app-menu li[data-cmd="move"]')
    await dialogOpen(page)
    await page.click('dialog.move .mv-row.f[data-scope="desk-2"]')
    const cGroup = (await h.tree(page)).find(s => s.id === 'desk-2')!.frames[0]!
    const gc = groupsOf(cGroup.layout).find(g => g.panes.some(p => p.id === c))!.id
    await page.click(`dialog.move .mv-pn[data-group="${gc}"] .z-tab`)
    await page.click('#mv-go')
    await dialogClosed(page)
    await page.waitForFunction(id => window.__tether.deskOf(id) === 'desk-2', b)
    assert.deepEqual((await shape(page))['desk-2'], [[[c, b], [a]]], 'b is a tab next to c')
    assert.deepEqual((await shape(page))['desk-1'], [], 'desk 1 is empty')

    // ---- 4. c into the drawer, a new frame at its bottom ----
    console.log('step 4')
    await page.keyboard.press('Control+2')
    await page.waitForFunction(() => window.__tether.activeDesk() === 'desk-2')
    await page.evaluate(id => window.__tether.openMove(id), c)
    await dialogOpen(page)
    await page.click('dialog.move .mv-row.g')
    assert.equal(await page.locator('dialog.move .oz').count(), 4)
    await page.click('dialog.move .oz.bottom')
    assert.match((await page.textContent('#mv-summary'))!, /novo quadro abaixo da gaveta/)
    await page.click('#mv-go')
    await page.waitForFunction(id => window.__tether.inDrawer(id), c)
    assert.deepEqual((await shape(page))['drawer'], [[[c]]])

    // ---- 5. c out of the drawer into a new frame at the left of desk 1 (not the desk behind: the drawer stays open) ----
    console.log('step 5')
    await page.keyboard.press('Control+Backquote')
    await page.waitForFunction(() => window.__tether.drawer().open)
    await page.locator('.drawer .tether-tab').first().click({ button: 'right' })
    await page.click('#ctx-menu li:has-text("Mover…")')
    await dialogOpen(page)
    await page.click('dialog.move .mv-row.d[data-scope="desk-1"]')
    await page.click('dialog.move .oz.left')
    await page.click('#mv-go')
    await page.waitForFunction(id => window.__tether.deskOf(id) === 'desk-1', c)
    assert.equal((await page.evaluate(() => window.__tether.drawer())).open, true, 'moved to another desk: the drawer stays open')
    assert.deepEqual((await shape(page))['desk-1'], [[[c]]], 'the empty desk took it in its frame')
    await page.keyboard.press('Control+Backquote')
    await page.waitForFunction(() => !window.__tether.drawer().open)

    // ---- 6. the whole frame of a (desk 2: c-group gone, a | b) beside c's frame on desk 1 ----
    console.log('step 6')
    await page.evaluate(id => window.__tether.openMove(id), a)
    await dialogOpen(page)
    await page.click('dialog.move .mv-seg button[data-mode="frame"]')
    await page.click('dialog.move .mv-row.f[data-scope="desk-1"]')
    assert.equal(await page.getAttribute('dialog.move .z.whole', 'aria-disabled'), 'true', 'a frame never becomes a tab')
    await page.click('dialog.move .oz.right')
    assert.match((await page.textContent('#mv-summary'))!, /à direita do quadro/)
    await page.click('#mv-go')
    await page.waitForFunction(([a, b]) => window.__tether.deskOf(a) === 'desk-1' && window.__tether.deskOf(b) === 'desk-1', [a, b] as const)
    const s6 = await shape(page)
    assert.equal(s6['desk-1']!.length, 2, 'two frames on desk 1')
    assert.deepEqual(s6['desk-1']![0], [[c]])
    assert.deepEqual(s6['desk-1']![1]!.flat().sort(), [a, b].sort(), 'the frame came whole')
    assert.deepEqual(s6['desk-2'], [])

    // ---- 7. same processes, screens kept ----
    console.log('step 7')
    assert.deepEqual(await pidsOf(page, [a, b, c]), pids, 'moving never touches a process')
    for (const [id, t] of [[a, 'marca-a'], [b, 'marca-b'], [c, 'marca-c']] as const) assert.ok((await page.evaluate(id => window.__tether.text(id), id)).includes(t), `${t} kept`)

    // ---- 8. the keyboard path ----
    console.log('step 8')
    await page.evaluate(id => window.__tether.openMove(id), c)
    await dialogOpen(page)
    await page.keyboard.type('zzz')
    await page.waitForSelector('dialog.move .mv-none')
    await page.keyboard.press('Escape')
    assert.equal(await page.inputValue('#mv-q'), '', 'Esc clears the search first')
    await dialogOpen(page)
    await page.keyboard.press('Escape')
    await dialogClosed(page)
    assert.equal(await h.deskOf(page, c), 'desk-1', 'cancel moves nothing')
    await page.evaluate(id => window.__tether.openMove(id), c)
    await dialogOpen(page)
    await page.keyboard.press('ArrowLeft') // the frame row → its desk
    await page.waitForSelector('dialog.move .mv-row.d.sel[data-scope="desk-1"]')
    await page.keyboard.press('ArrowLeft') // collapse
    await page.waitForSelector('dialog.move .mv-row.d.sel[data-scope="desk-1"][aria-expanded="false"]')
    await page.keyboard.press('ArrowRight') // expand
    await page.waitForSelector('dialog.move .mv-row.d.sel[data-scope="desk-1"][aria-expanded="true"]')
    await page.keyboard.type('mesa 2')
    await page.keyboard.press('ArrowDown')
    await page.waitForSelector('dialog.move .mv-row.d.sel[data-scope="desk-2"]')
    await page.keyboard.press('Tab') // the first zone: "Novo quadro acima"
    await page.waitForFunction(() => (document.activeElement as unknown as { dataset?: Record<string, string> } | null)?.dataset?.zone === 'top')
    await page.keyboard.press('Enter')
    await dialogClosed(page)
    await page.waitForFunction(id => window.__tether.deskOf(id) === 'desk-2', c)
    assert.deepEqual((await shape(page))['desk-2'], [[[c]]])

    // ---- 9. screenshots (light, dark), then relaunch ----
    console.log('step 9')
    for (const scheme of ['light', 'dark'] as const) {
      await page.click('#btn-menu')
      await page.click(`#app-menu li[data-theme="${scheme}"]`)
      await page.waitForFunction(s => document.documentElement.dataset.theme === s, scheme)
      await page.evaluate(id => window.__tether.openMove(id), a)
      await dialogOpen(page)
      await page.click('dialog.move .mv-row.f[data-scope="desk-1"]')
      const bGroup = groupsOf((await h.tree(page)).find(s => s.id === 'desk-1')!.frames.find(f => f.panes.some(p => p.id === b))!.layout).find(g => g.panes.some(p => p.id === b))!.id
      await page.hover(`dialog.move .mv-pn[data-group="${bGroup}"] .z-bottom`)
      await page.click(`dialog.move .mv-pn[data-group="${bGroup}"] .z-bottom`)
      await sleep(250)
      await page.locator('dialog.move').screenshot({ path: join(artifacts, `move-dialog-${scheme}.png`), scale: 'css' })
      await page.keyboard.press('Escape')
      await dialogClosed(page)
    }
    await sleep(800) // debounced save
    const before = await shape(page)
    await killElectron(app, root)
    app = undefined
    ;({ app, page } = await launch(home))
    assert.equal(await h.daemonPid(page), daemonPid, 'same tetherd')
    await page.waitForFunction(ids => ids.every(id => window.__tether.deskOf(id) !== undefined), [a, b, c])
    assert.deepEqual(await shape(page), before, 'the moved layout came back as it was')
    assert.deepEqual(await pidsOf(page, [a, b, c]), pids, 'same PIDs through the window kill')
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
