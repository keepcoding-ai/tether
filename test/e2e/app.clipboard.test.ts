// E2E of the clipboard keys in a terminal pane (Electron app, real tetherd on a private home/pipe, hidden
// window, one PowerShell pane):
//   1. selecting text copies nothing by itself; Ctrl+C with the selection copies it, clears the selection and
//      sends no ^C (a `ping -t` keeps printing);
//   2. Ctrl+C without a selection reaches the shell: the ping is interrupted and the prompt comes back;
//   3. Ctrl+V pastes the clipboard text into the shell line; Ctrl+Shift+V too;
//   4. an OSC 52 written by the program sets the Windows clipboard;
//   5. with mouse tracking on (what Claude's full screen does), Shift+drag still selects.
// The Windows clipboard is global: the text that was there is saved first and restored at the end.
// Every kill goes through test/kill.ts (pid + creation time, command line of this test's own processes).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type Hooks = {
  panelIds(): string[]
  text(id: string): string
  connection(): { connected: boolean; pid?: number } | undefined
  activate(id: string): void
  selection(id: string): string
  selectText(id: string, needle: string): boolean
  cellSize(id: string): { width: number; height: number } | undefined
  screenPos(id: string, needle: string): { row: number; col: number } | undefined
  mouseMode(id: string): string | undefined
  inject(id: string, data: string): void
}
declare const window: { __tether: Hooks }
declare const document: { querySelectorAll(selector: string): { length: number } }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const pipe = `\\\\.\\pipe\\tether-cliptest-${process.pid}`
const daemonMain = join(root, 'src', 'daemon', 'main.ts')

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

async function launch(home: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_') && !k.startsWith('CLAUDE')) env[k] = v
  env.TETHER_PIPE = pipe
  env.TETHER_HOME = home
  env.TETHER_E2E_HIDDEN = '1'
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10_000)
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  return { app, page }
}

async function createShellPanel(page: Page, cwd: string): Promise<string> {
  const before = await page.locator('.tether-tab').count()
  await page.click('#btn-new')
  await page.waitForSelector('#dlg-new[open]')
  await page.check('input[name=profile][value=powershell]')
  await page.fill('#new-cwd', cwd)
  await page.click('#btn-create')
  await page.waitForFunction(n => document.querySelectorAll('.tether-tab').length === n, before + 1)
  const ids = await page.evaluate(() => window.__tether.panelIds())
  return ids[ids.length - 1]!
}

const clip = {
  read: (app: ElectronApplication) => app.evaluate(({ clipboard }) => clipboard.readText()),
  write: (app: ElectronApplication, text: string) => app.evaluate(({ clipboard }, t) => clipboard.writeText(t), text),
}
const text = (page: Page, id: string) => page.evaluate(id => window.__tether.text(id), id)
const selection = (page: Page, id: string) => page.evaluate(id => window.__tether.selection(id), id)
const promptCount = (t: string): number => (t.match(/^PS [^\n]*>/gm) ?? []).length
const replyCount = (t: string): number => (t.match(/^(Resposta de|Reply from)/gm) ?? []).length

async function waitClipboard(app: ElectronApplication, want: string, what: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (await clip.read(app) === want) return
    await sleep(100)
  }
  assert.equal(await clip.read(app), want, what)
}

test('app clipboard: Ctrl+C copies a selection and interrupts without one; Ctrl+V pastes; OSC 52 sets the clipboard; Shift+drag selects under mouse mode', async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  const home = mkdtempSync(join(tmpdir(), 'tether-cliptest-'))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  let savedClipboard: string | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    savedClipboard = await clip.read(app)
    const daemonPid = (await page.evaluate(() => window.__tether.connection()))?.pid
    assert.ok(daemonPid && pidAlive(daemonPid), 'the app spawned a tetherd')
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))

    const id = await createShellPanel(page, root)
    await page.evaluate(id => window.__tether.activate(id), id)
    await page.waitForFunction(id => /PS.*>/.test(window.__tether.text(id).replace(/\s+/g, '')), id, { timeout: 20_000 })
    const term = page.locator(`.panel[data-slot-id="${id}"] .panel-term`)
    await term.click()

    // 1. A marker line, then a ping that keeps printing. Selecting copies nothing; Ctrl+C with the selection
    //    copies, clears it and does not interrupt the ping.
    await clip.write(app, 'antes-do-teste')
    await page.keyboard.type('Write-Host marcador-copia-7f3a; ping -t localhost')
    await page.keyboard.press('Enter')
    await page.waitForFunction(id => /marcador-copia-7f3a\s*\n/.test(window.__tether.text(id)), id, { timeout: 15_000 })
    await page.waitForFunction(id => (window.__tether.text(id).match(/^(Resposta de|Reply from)/gm) ?? []).length >= 2, id, { timeout: 15_000 })
    assert.equal(await page.evaluate(id => window.__tether.selectText(id, 'marcador-copia-7f3a'), id), true, 'marker selected')
    assert.equal(await selection(page, id), 'marcador-copia-7f3a')
    await sleep(300)
    assert.equal(await clip.read(app), 'antes-do-teste', 'selecting alone copies nothing')
    const repliesBefore = replyCount(await text(page, id))
    const promptsBefore = promptCount(await text(page, id))
    await page.keyboard.press('Control+C')
    await waitClipboard(app, 'marcador-copia-7f3a', 'Ctrl+C with a selection copies it')
    assert.equal(await selection(page, id), '', 'the selection is cleared after the copy')
    await sleep(2_500)
    const afterCopy = await text(page, id)
    assert.ok(replyCount(afterCopy) > repliesBefore, 'the ping kept printing: no ^C reached the shell')
    assert.equal(promptCount(afterCopy), promptsBefore, 'no new prompt: the ping was not interrupted')

    // 2. Ctrl+C with no selection reaches the shell: the ping stops and the prompt comes back.
    await page.keyboard.press('Control+C')
    await page.waitForFunction(({ id, n }) => (window.__tether.text(id).match(/^PS [^\n]*>/gm) ?? []).length > n, { id, n: promptsBefore }, { timeout: 15_000 })
    const repliesStopped = replyCount(await text(page, id))
    await sleep(2_000)
    assert.equal(replyCount(await text(page, id)), repliesStopped, 'the ping stopped printing')

    // 3. Ctrl+V and Ctrl+Shift+V paste the clipboard text into the shell line.
    await clip.write(app, 'Write-Host colado-ctrl-v-5c1d')
    await page.keyboard.press('Control+V')
    await page.waitForFunction(id => /colado-ctrl-v-5c1d/.test(window.__tether.text(id)), id)
    await page.keyboard.press('Enter')
    await page.waitForFunction(id => (window.__tether.text(id).match(/colado-ctrl-v-5c1d/g) ?? []).length >= 2, id)
    await clip.write(app, 'Write-Host colado-ctrl-shift-v-9e2b')
    await page.keyboard.press('Control+Shift+V')
    await page.waitForFunction(id => /colado-ctrl-shift-v-9e2b/.test(window.__tether.text(id)), id)
    await page.keyboard.press('Enter')
    await page.waitForFunction(id => (window.__tether.text(id).match(/colado-ctrl-shift-v-9e2b/g) ?? []).length >= 2, id)

    // 4. OSC 52 from the program → Windows clipboard.
    await clip.write(app, 'antes-do-osc52')
    const b64 = Buffer.from('osc52-texto-3b7e ação', 'utf8').toString('base64')
    await page.keyboard.type(`Write-Host "$([char]27)]52;c;${b64}$([char]7)fim-osc52"`)
    await page.keyboard.press('Enter')
    await page.waitForFunction(id => /fim-osc52\s*\n/.test(window.__tether.text(id)), id)
    await waitClipboard(app, 'osc52-texto-3b7e ação', 'OSC 52 set the clipboard')

    // 5. Mouse tracking on (as Claude's full screen does): a plain drag goes to the program; Shift+drag selects.
    //    The DECSET is written into the xterm from the renderer: ConPTY on this machine does not forward a
    //    program's `?1000h` to the terminal (a `Write-Host` of it leaves xterm in mode 'none'), while the OSC 52
    //    above does come through. What is proven here is the terminal's behaviour once the mode is on.
    await page.keyboard.type('Write-Host "linha-para-selecionar-4d2f"')
    await page.keyboard.press('Enter')
    await page.waitForFunction(id => /linha-para-selecionar-4d2f\s*\n/.test(window.__tether.text(id)), id)
    await page.evaluate(id => window.__tether.inject(id, '\x1b[?1000h'), id)
    await page.waitForFunction(id => window.__tether.mouseMode(id) === 'vt200', id)
    const cell = await page.evaluate(id => window.__tether.cellSize(id), id)
    assert.ok(cell && cell.width > 0 && cell.height > 0, 'cell size known')
    const pos = await page.evaluate(id => window.__tether.screenPos(id, 'linha-para-selecionar-4d2f'), id)
    assert.ok(pos, 'the line is on screen')
    const screen = page.locator(`.panel[data-slot-id="${id}"] .xterm-screen`)
    const box = (await screen.boundingBox())!
    const y = box.y + (pos.row + 0.5) * cell!.height
    const x0 = box.x + (pos.col + 0.5) * cell!.width
    const x1 = box.x + (pos.col + 10.5) * cell!.width
    // Control: a plain drag under mouse mode is the program's (mouse reports), not a selection.
    await page.mouse.move(x0, y); await page.mouse.down(); await page.mouse.move(x1, y, { steps: 5 }); await page.mouse.up()
    await sleep(200)
    assert.equal(await selection(page, id), '', 'a plain drag under mouse mode selects nothing')
    await page.keyboard.down('Shift')
    await page.mouse.move(x0, y)
    await page.mouse.down()
    await page.mouse.move(x1, y, { steps: 5 })
    await page.mouse.up()
    await page.keyboard.up('Shift')
    await sleep(200)
    // The drag covers ~10 cells; where xterm rounds the last cell is not the point, the selection is.
    const shiftSel = await selection(page, id)
    assert.match(shiftSel, /^linha-para-?$/, `Shift+drag selects under mouse mode (got ${JSON.stringify(shiftSel)})`)
    await page.keyboard.press('Control+Shift+C')
    await waitClipboard(app, shiftSel, 'Ctrl+Shift+C copies the Shift+drag selection')
    await page.evaluate(id => window.__tether.inject(id, '\x1b[?1000l'), id)
    await page.keyboard.press('Escape') // PSReadLine: drops the mouse reports the plain drag typed into the line
  } finally {
    if (app && savedClipboard !== undefined) await clip.write(app, savedClipboard).catch(() => {})
    if (app) await killElectron(app, root).catch(e => console.error(String(e)))
    for (const d of daemons) {
      const r = await killOwned(d, { tree: true })
      if (r === 'not-ours') console.error(`tetherd cleanup: pid ${d.pid} is no longer ours; not killed`)
    }
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && daemons.some(d => pidAlive(d.pid))) await sleep(200)
    for (let i = 0; i < 5; i++) {
      try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
  }
})
