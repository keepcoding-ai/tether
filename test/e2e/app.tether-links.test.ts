// E2E of tether:// links (app/shared/tether-url.ts), against the real tetherd on a private home/pipe, hidden window. Each
// link reaches the app the way the OS hands it to the running instance: main's `second-instance` with the link in argv
// (main parses it, sends it over IPC, the renderer follows it). A followed link brings the pane up wherever it lives:
//   1. a shell on desk 2 while desk 1 is shown → desk 2 comes forward, the pane is active, focused and on screen;
//   2. a pane in a closed pad (the desk pad of another desk, and the global pad) → the pad opens, the pane has the keyboard;
//   3. a pane in the closed drawer → the drawer opens, the pane has the keyboard;
//   4. a note open on another desk → that desk comes forward, the note is active (not opened twice); a file not open
//      opens as a note;
//   5. a slot whose pane was closed (the shell runs on) → the "tether-link-closed" dialog; "reopen" brings it back;
//   6. an unknown id → the "tether-link-missing" dialog, nothing else changes;
//   7. "Copiar link do painel" (palette command and the tab menu) copies tether://tab/<id>; a note's copies tether://note?path=…;
//   8. every terminal knows its own link: $env:TETHER_TAB_URL;
//   9. a tether://tab/<id> printed in a terminal, Ctrl+click → that pane comes up.
// Every kill goes through test/kill.ts. The system clipboard is restored at the end.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { noteUrl, tabUrl } from '../../app/shared/tether-url.ts'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type Note = { id: string; path: string; text: string }
type Hooks = {
  panelIds(): string[]
  slots(): SlotState[]
  text(id: string): string
  connection(): { connected: boolean; pid?: number } | undefined
  activeId(): string | undefined
  currentPane(): string | undefined
  activate(id: string): void
  activeDesk(): string
  deskOf(slotId: string): string | undefined
  switchDesk(id: string): void
  createDesk(side: 'before' | 'after', relativeTo?: string): string
  drawer(): { open: boolean; panes: string[] }
  movePaneToDrawer(slotId: string): void
  togglePad(id: string): void
  sidebars(): { left: { open?: string }; right: { open?: string } } | undefined
  padFrames(): { pad: string; desk?: string; panes: string[]; shown: boolean }[]
  openSlotInPad(slotId: string, padId: string): void
  detachPane(slotId: string): void
  openFile(path: string): Promise<void>
  notes(): Note[]
  runCommand(id: string): Promise<'ran' | 'unknown' | 'unavailable'>
  screenPos(id: string, needle: string): { row: number; col: number } | undefined
  cellSize(id: string): { width: number; height: number } | undefined
}
type El = { getAttribute(n: string): string | null; closest(s: string): El | null; getBoundingClientRect(): { x: number; y: number; width: number; height: number } }
declare const window: { __tether: Hooks; tether: { notice(n: unknown): void; request(r: unknown): Promise<{ t: string; slot?: SlotState }> } }
declare const document: { activeElement: El | null; querySelector(s: string): El | null; querySelectorAll(s: string): { length: number }; elementFromPoint(x: number, y: number): El | null }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const artifacts = join(root, 'test', 'e2e', 'artifacts')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-links-${process.pid}`
const DESK_PAD = 'frame-pads.desk'
const GLOBAL_PAD = 'frame-pads.global'

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
const activeDesk = (page: Page) => page.evaluate(() => window.__tether.activeDesk())

/** A PowerShell in the visible desk through the chooser; returns its slot id once it runs. */
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

/** A running shell the daemon knows, with no pane anywhere. */
async function bareShell(page: Page, cwd: string): Promise<string> {
  const reply = await page.evaluate(cwd => window.tether.request({ t: 'create', kind: 'shell', cwd, start: true }), cwd)
  assert.equal(reply.t, 'ok')
  return reply.slot!.slotId
}

/** The OS handing a followed link to the running instance: a second launch with the link in argv. */
async function follow(app: ElectronApplication, url: string): Promise<void> {
  await app.evaluate(({ app }, url) => { app.emit('second-instance', {}, [process.execPath, url], process.cwd()) }, url)
}

/** The pane has the keyboard, and the point at its middle is that pane (its place is open and on top). */
async function expectUp(page: Page, id: string): Promise<void> {
  await page.waitForFunction(id => {
    const el = document.querySelector(`.panel[data-slot-id="${id}"]`)
    if (!el) return false
    const r = el.getBoundingClientRect()
    if (r.width < 50 || r.height < 50) return false
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('.panel')?.getAttribute('data-slot-id')
    const focused = document.activeElement?.closest('.panel')?.getAttribute('data-slot-id')
    return hit === id && focused === id
  }, id)
}

async function clipboardText(app: ElectronApplication): Promise<string> {
  return app.evaluate(({ clipboard }) => clipboard.readText())
}

test('tether:// links: a pane comes up wherever it lives (desk, pad, drawer, note); closed and unknown panes; copy link; TETHER_TAB_URL; Ctrl+click', { timeout: 420_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(artifacts, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-links-'))
  const base = mkdtempSync(join(tmpdir(), 'tether-lk-'))
  const fileA = join(base, 'aberta.md'), fileB = join(base, 'fechada.md')
  writeFileSync(fileA, '# nota aberta\n')
  writeFileSync(fileB, '# nota ainda fechada\n')
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  let savedClipboard: string | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    const daemonPid = (await page.evaluate(() => window.__tether.connection()))?.pid
    assert.ok(daemonPid && pidAlive(daemonPid), 'the app spawned a tetherd')
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))
    savedClipboard = await clipboardText(app)

    const desk1 = await activeDesk(page)
    const a = await createShell(page, base)
    const desk2 = await page.evaluate(d => window.__tether.createDesk('after', d), desk1)
    await page.evaluate(d => window.__tether.switchDesk(d), desk2)
    const b = await createShell(page, base)
    assert.equal(await page.evaluate(id => window.__tether.deskOf(id), b), desk2)

    // ---- 1. a pane on another desk ----
    console.log('step 1')
    await page.evaluate(d => window.__tether.switchDesk(d), desk1)
    await follow(app, tabUrl(b))
    await page.waitForFunction(([d, id]) => window.__tether.activeDesk() === d && window.__tether.activeId() === id, [desk2, b] as const)
    await expectUp(page, b)

    // ---- 2. a pane in a closed pad: the desk pad of desk 1 (from desk 2), then the global pad ----
    console.log('step 2')
    await page.evaluate(d => window.__tether.switchDesk(d), desk1)
    const padded: Array<[string, string]> = []
    for (const pad of [DESK_PAD, GLOBAL_PAD]) {
      const id = await bareShell(page, base)
      await page.evaluate(p => window.__tether.togglePad(p), pad)
      await page.waitForFunction(p => window.__tether.padFrames().some(f => f.pad === p && f.shown), pad)
      await page.evaluate(([id, p]) => window.__tether.openSlotInPad(id!, p!), [id, pad] as const)
      await page.waitForFunction(id => window.__tether.padFrames().some(f => f.panes.includes(id)), id)
      await page.evaluate(p => window.__tether.togglePad(p), pad)
      await page.waitForFunction(p => !window.__tether.padFrames().some(f => f.pad === p && f.shown), pad)
      padded.push([pad, id])
    }
    for (const [pad, id] of padded) {
      await page.evaluate(d => window.__tether.switchDesk(d), desk2)
      await page.waitForFunction(() => !window.__tether.padFrames().some(f => f.shown))
      await follow(app, tabUrl(id))
      if (pad === DESK_PAD) await page.waitForFunction(d => window.__tether.activeDesk() === d, desk1)
      await page.waitForFunction(([p, id]) => window.__tether.padFrames().some(f => f.pad === p && f.shown && f.panes.includes(id!)), [pad, id] as const)
      await page.waitForFunction(id => window.__tether.currentPane() === id, id)
      await expectUp(page, id)
      await page.evaluate(p => window.__tether.togglePad(p), pad)
      await page.waitForFunction(() => !window.__tether.padFrames().some(f => f.shown))
    }

    // ---- 3. a pane in the closed drawer ----
    console.log('step 3')
    await page.evaluate(d => window.__tether.switchDesk(d), desk1)
    const d = await createShell(page, base)
    await page.evaluate(id => window.__tether.movePaneToDrawer(id), d)
    await page.waitForFunction(id => window.__tether.drawer().panes.includes(id) && !window.__tether.drawer().open, d)
    await page.evaluate(d => window.__tether.switchDesk(d), desk2)
    await follow(app, tabUrl(d))
    await page.waitForFunction(id => window.__tether.drawer().open && window.__tether.currentPane() === id, d)
    await expectUp(page, d)
    // Back to the desks: a desk pane's link closes the drawer on its way.
    await follow(app, tabUrl(a))
    await page.waitForFunction(([d, id]) => !window.__tether.drawer().open && window.__tether.activeDesk() === d && window.__tether.activeId() === id, [desk1, a] as const)
    await expectUp(page, a)

    // ---- 4. notes: open on another desk → revealed, not reopened; a file not open → opened ----
    console.log('step 4')
    await page.evaluate(d => window.__tether.switchDesk(d), desk2)
    await page.evaluate(p => window.__tether.openFile(p), fileA)
    await page.waitForFunction(() => window.__tether.notes().length === 1)
    const noteA = (await page.evaluate(() => window.__tether.notes()))[0]!
    assert.equal(await page.evaluate(id => window.__tether.deskOf(id), noteA.id), desk2)
    await page.evaluate(d => window.__tether.switchDesk(d), desk1)
    await follow(app, noteUrl(fileA))
    await page.waitForFunction(([d, id]) => window.__tether.activeDesk() === d && window.__tether.activeId() === id, [desk2, noteA.id] as const)
    await sleep(300)
    assert.equal((await page.evaluate(() => window.__tether.notes())).length, 1, 'the open note was revealed, not opened twice')
    await follow(app, noteUrl(fileB))
    await page.waitForFunction(() => window.__tether.notes().length === 2)
    const noteB = (await page.evaluate(() => window.__tether.notes())).find(n => n.path.toLowerCase() === fileB.toLowerCase())
    assert.ok(noteB, 'the file not open was opened as a note')
    assert.match(noteB!.text, /ainda fechada/)
    await page.waitForFunction(id => window.__tether.activeId() === id, noteB!.id)

    // ---- 5. a slot whose pane was closed: offered back ----
    console.log('step 5')
    await page.evaluate(d => window.__tether.switchDesk(d), desk1)
    const e = await createShell(page, base)
    const pidE = (await page.evaluate(() => window.__tether.slots())).find(s => s.slotId === e)!.pid
    await page.evaluate(id => window.__tether.detachPane(id), e)
    await page.waitForFunction(id => !window.__tether.panelIds().includes(id), e)
    await page.evaluate(d => window.__tether.switchDesk(d), desk2)
    await follow(app, tabUrl(e))
    const closedDlg = page.locator('dialog[open][data-dialog="tether-link-closed"]')
    await closedDlg.waitFor()
    await page.screenshot({ path: join(artifacts, 'tether-links-closed.png') })
    await closedDlg.locator('button.choice[data-choice="reopen"]').click()
    await page.waitForFunction(id => window.__tether.panelIds().includes(id), e)
    await expectUp(page, e)
    assert.equal((await page.evaluate(() => window.__tether.slots())).find(s => s.slotId === e)!.pid, pidE, 'the same shell came back')

    // ---- 6. an unknown id: said so, nothing changes ----
    console.log('step 6')
    const snap = () => page.evaluate(() => ({ desk: window.__tether.activeDesk(), active: window.__tether.activeId(), panes: window.__tether.panelIds(), drawer: window.__tether.drawer().open, pads: window.__tether.padFrames().filter(f => f.shown).map(f => f.pad), notes: window.__tether.notes().length }))
    const before = await snap()
    await follow(app, tabUrl('deadbeef'))
    const missingDlg = page.locator('dialog[open][data-dialog="tether-link-missing"]')
    await missingDlg.waitFor()
    await page.screenshot({ path: join(artifacts, 'tether-links-missing.png') })
    assert.deepEqual(await snap(), before, 'nothing moved while the dialog is up')
    await missingDlg.locator('button.choice[data-choice="ok"]').click()
    await missingDlg.waitFor({ state: 'detached' })
    assert.deepEqual(await snap(), before, 'nothing moved after it')

    // ---- 6b. "Associar links tether:// a este tether…" shows the association; cancelled (associating would touch the person's registry) ----
    console.log('step 6b')
    assert.equal(await page.evaluate(() => window.__tether.runCommand('links.associate')), 'ran')
    const assocDlg = page.locator('dialog[open][data-dialog="associate-links"]')
    await assocDlg.waitFor()
    assert.equal(await assocDlg.locator('button.choice[data-choice="associate"]').count(), 1, 'the offer to associate is there')
    await page.screenshot({ path: join(artifacts, 'tether-links-associate.png') })
    await page.keyboard.press('Escape')
    await assocDlg.waitFor({ state: 'detached' })

    // ---- 7. Copiar link do painel ----
    console.log('step 7')
    await follow(app, tabUrl(b))
    await expectUp(page, b)
    assert.equal(await page.evaluate(() => window.__tether.runCommand('pane.copy-link')), 'ran')
    for (let i = 0; i < 20 && (await clipboardText(app)) !== tabUrl(b); i++) await sleep(100)
    assert.equal(await clipboardText(app), tabUrl(b), 'the palette command copies the pane\'s link')
    await app.evaluate(({ clipboard }) => clipboard.writeText(''))
    await page.locator(`.tether-tab[data-slot="${b}"]`).click({ button: 'right' })
    await page.getByText('Copiar link do painel', { exact: true }).click()
    for (let i = 0; i < 20 && (await clipboardText(app)) !== tabUrl(b); i++) await sleep(100)
    assert.equal(await clipboardText(app), tabUrl(b), 'the tab menu copies the pane\'s link')
    await follow(app, noteUrl(fileA))
    await page.waitForFunction(id => window.__tether.activeId() === id, noteA.id)
    assert.equal(await page.evaluate(() => window.__tether.runCommand('pane.copy-link')), 'ran')
    for (let i = 0; i < 20 && (await clipboardText(app)) !== noteUrl(fileA); i++) await sleep(100)
    assert.equal(await clipboardText(app), noteUrl(fileA), 'a note\'s link names its file')

    // ---- 8. the terminal knows its own link ----
    console.log('step 8')
    await follow(app, tabUrl(b))
    await expectUp(page, b)
    await page.waitForFunction(id => /PS .*>/.test(window.__tether.text(id)), b, { timeout: 20_000 })
    await page.keyboard.type('echo ("<" + $env:TETHER_TAB_URL + ">")')
    await page.keyboard.press('Enter')
    await page.waitForFunction(([id, url]) => window.__tether.text(id!).includes(`<${url}>`), [b, tabUrl(b)] as const)

    // ---- 9. a link printed in a terminal: Ctrl+click brings that pane up ----
    console.log('step 9')
    const url = tabUrl(a)
    const half = Math.floor(url.length / 2)
    await page.keyboard.type(`Write-Output ('${url.slice(0, half)}'+'${url.slice(half)}')`)
    await page.keyboard.press('Enter')
    await page.waitForFunction(([id, n]) => window.__tether.screenPos(id!, n!) !== undefined, [b, url] as const)
    const pos = (await page.evaluate(([id, n]) => window.__tether.screenPos(id!, n!), [b, url] as const))!
    const cell = (await page.evaluate(id => window.__tether.cellSize(id), b))!
    const box = (await page.locator(`.panel[data-slot-id="${b}"] .xterm-screen`).boundingBox())!
    const p = { x: box.x + (pos.col + 4.5) * cell.width, y: box.y + (pos.row + 0.5) * cell.height }
    await page.mouse.move(5, 5)
    await page.keyboard.down('Control')
    await page.mouse.move(p.x, p.y, { steps: 3 })
    await sleep(300)
    await page.mouse.move(p.x + 10, p.y); await sleep(100); await page.mouse.move(p.x, p.y)
    await sleep(400)
    await page.mouse.down(); await page.mouse.up()
    await page.keyboard.up('Control')
    await page.waitForFunction(([d, id]) => window.__tether.activeDesk() === d && window.__tether.activeId() === id, [desk1, a] as const)
    await expectUp(page, a)
  } finally {
    if (app && savedClipboard !== undefined) await app.evaluate(({ clipboard }, t) => clipboard.writeText(t), savedClipboard).catch(() => {})
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
