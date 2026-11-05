// E2E of Ctrl+click on paths printed in a terminal (F5): against the real tetherd on a private home/pipe, hidden window,
// a PowerShell pane opened in a temporary folder.
//   1. a relative `src/app.ts:3` printed by the shell: the pointer shows only while Ctrl is down; a click without Ctrl
//      opens nothing; Ctrl+click opens a note tab in the SHELL's tab group, cursor on line 3;
//   2. clicking again with the shell focused focuses that tab (no duplicate); `src/app.ts(4,2): error` moves the cursor to
//      4:2; an absolute path outside the folder opens too;
//   3. after `cd` to another folder: a relative path that only exists there is no link; `docs/note.md` still resolves
//      against the folder the pane was OPENED in (the other folder has its own, different docs/note.md);
//   4. a folder goes to the Explorer, a binary to the system program (both recorded, not run), an .exe is refused with
//      a message; 5. a web link still shows the pointer without Ctrl. Every kill goes through test/kill.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type Snap = { id: string; path: string; text: string; cursor?: { lineNumber: number; column: number } }
type Hooks = {
  panelIds(): string[]
  activate(id: string): void
  activeId(): string | undefined
  connection(): { connected: boolean; pid?: number } | undefined
  deskOf(slotId: string): string | undefined
  switchDesk(id: string): void
  notes(): Snap[]
  note(id: string): Snap | undefined
  groupOf(id: string): string | undefined
  text(id: string): string
  screenPos(id: string, needle: string): { row: number; col: number } | undefined
  cellSize(id: string): { width: number; height: number } | undefined
  termSize(id: string): { cols: number; rows: number } | undefined
}
declare const window: { __tether: Hooks }
declare const document: { querySelector(sel: string): unknown; querySelectorAll(sel: string): { length: number } }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const artifacts = join(root, 'test', 'e2e', 'artifacts')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const pipe = `\\\\.\\pipe\\tether-termlinks-${process.pid}`
const daemonMain = join(root, 'src', 'daemon', 'main.ts')

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
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10_000)
  page.on('pageerror', e => console.error(`renderer error: ${e.message}`))
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800))
  return { app, page }
}

async function createShell(page: Page, cwd: string): Promise<void> {
  const before = await page.locator('.tether-tab').count()
  await page.click('#btn-new')
  await page.waitForSelector('#dlg-new[open]')
  await page.fill('#dlg-new .ch-path-input', cwd)
  await page.click('#dlg-new .ch-item[data-id="powershell"]')
  await page.waitForFunction(() => document.querySelectorAll('#dlg-new[open]').length === 0)
  await page.waitForFunction(n => document.querySelectorAll('.tether-tab').length === n, before + 1)
}

async function focusPane(page: Page, id: string): Promise<void> {
  await page.evaluate(id => { const d = window.__tether.deskOf(id); if (d) window.__tether.switchDesk(d); window.__tether.activate(id) }, id)
  await page.locator(`.panel[data-slot-id="${id}"] .panel-term`).click()
  await page.waitForFunction(id => window.__tether.activeId() === id, id)
}

const notes = (page: Page) => page.evaluate(() => window.__tether.notes())
const sameGroup = (page: Page, a: string, b: string) => page.evaluate(([x, y]) => window.__tether.groupOf(x!) === window.__tether.groupOf(y!), [a, b])

/** Prints `parts` joined (the typed command never contains the printed text, so the text is on screen once) and waits for it. */
async function print(page: Page, id: string, ...parts: string[]): Promise<string> {
  const printed = parts.join('')
  await page.keyboard.type(`Write-Output (${parts.map(p => `'${p}'`).join('+')})`)
  await page.keyboard.press('Enter')
  await page.waitForFunction(([id, needle]) => window.__tether.screenPos(id!, needle!) !== undefined, [id, printed] as [string, string])
  return printed
}

/** Where on the page the cell `offset` characters into `needle` is. */
async function pointOf(page: Page, id: string, needle: string, offset = 2): Promise<{ x: number; y: number }> {
  const pos = await page.evaluate(([id, n]) => window.__tether.screenPos(id!, n!), [id, needle])
  assert.ok(pos, `${needle} is on screen`)
  const cell = (await page.evaluate(id => window.__tether.cellSize(id), id))!
  const box = (await page.locator(`.panel[data-slot-id="${id}"] .xterm-screen`).boundingBox())!
  return { x: box.x + (pos.col + offset + 0.5) * cell.width, y: box.y + (pos.row + 0.5) * cell.height }
}

const pointerShown = (page: Page): Promise<boolean> => page.evaluate(() => document.querySelector('.xterm.xterm-cursor-pointer, .xterm-cursor-pointer') !== null)

/** Moves over the text (with or without Ctrl) and waits for the link provider's answer, then reports whether the pointer shows. */
async function hover(page: Page, p: { x: number; y: number }, ctrl: boolean): Promise<boolean> {
  await page.mouse.move(5, 5)
  if (ctrl) await page.keyboard.down('Control')
  await page.mouse.move(p.x, p.y, { steps: 3 })
  await sleep(300)
  await page.mouse.move(p.x + 10, p.y); await sleep(100); await page.mouse.move(p.x, p.y)
  await sleep(400)
  const shown = await pointerShown(page)
  if (ctrl) await page.keyboard.up('Control')
  return shown
}

/** Ctrl+click on the text, once the link provider has answered (hover first). */
async function ctrlClick(page: Page, p: { x: number; y: number }): Promise<void> {
  await page.mouse.move(5, 5)
  await page.keyboard.down('Control')
  await page.mouse.move(p.x, p.y, { steps: 3 })
  await sleep(300)
  await page.mouse.move(p.x + 10, p.y); await sleep(100); await page.mouse.move(p.x, p.y)
  await sleep(400)
  await page.mouse.down(); await page.mouse.up()
  await page.keyboard.up('Control')
  await page.mouse.move(5, 5)
}

test('app terminal links: Ctrl+click opens the printed path (opening folder, tab group, line:col); folders, binaries and executables follow the Quick Open rules', async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(artifacts, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-termlinks-'))
  const base = mkdtempSync(join(tmpdir(), 'tether-tl-'))
  const open = join(base, 'open'), other = join(base, 'other'), abs = join(base, 'abs')
  const files: Record<string, string> = {
    'open/src/app.ts': 'linha 1\nlinha 2\nlinha 3\n    linha 4 aqui\nlinha 5\n',
    'open/docs/note.md': '# a nota da pasta de abertura\n',
    'open/docs/more.md': '# mais\n',
    'open/docs/sub/keep.txt': 'x\n',
    'open/img/logo.png': 'PNG\0\0binary',
    'open/bin/tool.exe': 'MZ\0\0binary',
    'other/only-here.md': '# so aqui\n',
    'other/docs/note.md': '# a nota da OUTRA pasta\n',
    'abs/outside.md': 'um\ndois\ntres\n',
  }
  for (const [p, text] of Object.entries(files)) { mkdirSync(dirname(join(base, p)), { recursive: true }); writeFileSync(join(base, p), text) }
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    const daemonPid = (await page.evaluate(() => window.__tether.connection()))?.pid
    assert.ok(daemonPid && pidAlive(daemonPid), 'the app spawned a tetherd')
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))
    // What the system would be asked to open is recorded, never run.
    await app.evaluate(({ shell }) => {
      const g = globalThis as unknown as { __opened: string[] }
      g.__opened = []
      shell.openPath = async (p: string) => { g.__opened.push(p); return '' }
    })
    const opened = () => app!.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened)

    await createShell(page, open)
    const [shell] = await page.evaluate(() => window.__tether.panelIds())
    await focusPane(page, shell!)
    await page.waitForFunction(id => /PS .*>/.test(window.__tether.text(id)), shell!, { timeout: 20_000 })

    // 1. relative path with :line — pointer only with Ctrl; a click without Ctrl opens nothing; Ctrl+click opens in the shell's group.
    const rel = await print(page, shell!, 'sr', 'c/app.ts:3')
    const relPoint = await pointOf(page, shell!, rel)
    assert.equal(await hover(page, relPoint, true), true, 'the pointer shows over the path while Ctrl is down')
    assert.equal(await hover(page, relPoint, false), false, 'no pointer without Ctrl')
    await page.mouse.move(relPoint.x, relPoint.y); await page.mouse.down(); await page.mouse.up()
    await sleep(500)
    assert.equal((await notes(page)).length, 0, 'a plain click opens nothing')
    await ctrlClick(page, relPoint)
    await page.waitForFunction(() => window.__tether.notes().length === 1)
    const [app1] = await notes(page)
    assert.equal(app1!.path.toLowerCase(), join(open, 'src', 'app.ts').toLowerCase())
    assert.ok(await sameGroup(page, app1!.id, shell!), 'same tab group as the shell')
    await page.waitForFunction(id => window.__tether.note(id)?.cursor?.lineNumber === 3, app1!.id)
    await page.waitForFunction(id => window.__tether.activeId() === id, app1!.id)

    // 2. back on the shell, the same path again focuses the tab (no duplicate); (4,2) moves the cursor; an absolute path outside opens.
    await focusPane(page, shell!)
    await ctrlClick(page, await pointOf(page, shell!, rel))
    await page.waitForFunction(id => window.__tether.activeId() === id, app1!.id)
    assert.equal((await notes(page)).length, 1, 'no duplicate tab')
    await focusPane(page, shell!)
    const tsc = await print(page, shell!, 'sr', 'c/app.ts(4,2): error TS2322')
    await ctrlClick(page, await pointOf(page, shell!, tsc))
    await page.waitForFunction(id => { const c = window.__tether.note(id)?.cursor; return c?.lineNumber === 4 && c.column === 2 }, app1!.id)
    assert.equal((await notes(page)).length, 1)
    await focusPane(page, shell!)
    const outside = join(abs, 'outside.md')
    const half = Math.floor(outside.length / 2)
    const absPrinted = await print(page, shell!, outside.slice(0, half), `${outside.slice(half)}:2`)
    await ctrlClick(page, await pointOf(page, shell!, absPrinted, 3))
    await page.waitForFunction(() => window.__tether.notes().length === 2)
    const outNote = (await notes(page)).find(n => n.path.toLowerCase() === outside.toLowerCase())
    assert.ok(outNote, 'the absolute path opened')
    assert.ok(await sameGroup(page, outNote!.id, shell!))
    await page.waitForFunction(id => window.__tether.note(id)?.cursor?.lineNumber === 2, outNote!.id)

    // 3. after `cd other`: what only exists there is no link; docs/note.md resolves against the folder the pane was OPENED in.
    await focusPane(page, shell!)
    await page.keyboard.type(`cd '${other}'`); await page.keyboard.press('Enter')
    await page.waitForFunction(([id, dir]) => window.__tether.text(id!).includes(`PS ${dir}>`), [shell!, other] as [string, string])
    const gone = await print(page, shell!, 'only-he', 're.md:1')
    assert.equal(await hover(page, await pointOf(page, shell!, gone), true), false, 'a relative path that only exists in the current folder is no link')
    await ctrlClick(page, await pointOf(page, shell!, gone))
    await sleep(500)
    assert.equal((await notes(page)).length, 2, 'nothing opened')
    await focusPane(page, shell!)
    const doc = await print(page, shell!, 'do', 'cs/note.md')
    await ctrlClick(page, await pointOf(page, shell!, doc))
    await page.waitForFunction(() => window.__tether.notes().length === 3)
    const docNote = (await notes(page)).find(n => n.path.toLowerCase().endsWith('note.md'))!
    assert.equal(docNote.path.toLowerCase(), join(open, 'docs', 'note.md').toLowerCase(), 'the OPENING folder\'s file, not the cwd\'s')
    assert.match(docNote.text, /pasta de abertura/)

    // 4. a folder → Explorer; a binary → the system program; an .exe → refused with a message. None is run.
    await focusPane(page, shell!)
    const folder = await print(page, shell!, 'do', 'cs/sub')
    await ctrlClick(page, await pointOf(page, shell!, folder))
    await page.waitForFunction(() => true)
    for (let i = 0; i < 20 && (await opened()).length < 1; i++) await sleep(100)
    assert.deepEqual((await opened()).map(p => p.toLowerCase()), [join(open, 'docs', 'sub').toLowerCase()])
    await focusPane(page, shell!)
    const png = await print(page, shell!, 'im', 'g/logo.png')
    await ctrlClick(page, await pointOf(page, shell!, png))
    for (let i = 0; i < 20 && (await opened()).length < 2; i++) await sleep(100)
    assert.equal((await opened())[1]?.toLowerCase(), join(open, 'img', 'logo.png').toLowerCase())
    assert.equal((await notes(page)).length, 3, 'a binary opens no note')
    await focusPane(page, shell!)
    const exe = await print(page, shell!, 'bi', 'n/tool.exe')
    await ctrlClick(page, await pointOf(page, shell!, exe))
    await page.waitForSelector('text=/executável/')
    assert.equal((await opened()).length, 2, 'the executable was not handed to the system')
    await page.click('button.choice[data-choice="ok"]')

    // 5. web links are untouched: the pointer shows over a URL without Ctrl.
    await focusPane(page, shell!)
    const url = await print(page, shell!, 'https://exam', 'ple.com/x')
    assert.equal(await hover(page, await pointOf(page, shell!, url), false), true, 'the web link still shows the pointer without Ctrl')
    await page.mouse.move(5, 5)

    // 6. a plain click on an existing path that is not open yet opens nothing.
    await focusPane(page, shell!)
    const more = await print(page, shell!, 'do', 'cs/more.md')
    const morePoint = await pointOf(page, shell!, more)
    await page.mouse.click(morePoint.x, morePoint.y)
    await sleep(500)
    assert.equal((await notes(page)).length, 3)
    await hover(page, morePoint, true)
    await page.keyboard.down('Control'); await page.mouse.move(morePoint.x + 1, morePoint.y); await sleep(300)
    const b64 = await app.evaluate(async ({ BrowserWindow }) => {
      const img = await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()
      return img.resize({ width: Math.round(img.getSize().width / 2), quality: 'best' }).toPNG().toString('base64')
    })
    await page.keyboard.up('Control')
    writeFileSync(join(artifacts, 'terminal-links-hover.png'), Buffer.from(b64, 'base64'))
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
