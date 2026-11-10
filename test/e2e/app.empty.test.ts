// E2E of the empty pane (F5): against the real tetherd on a private home/pipe, hidden window.
//   1. the chooser ("Novo painel…") offers "Vazio" and "Nota" on top of the profiles;
//   2. Ctrl+Shift+→ from inside a PowerShell pane makes an empty pane beside it (its chooser suggests the pane's
//      folder and gets the keyboard); the palette command "Dividir abaixo (vazio)" makes another; the dialog's
//      "Vazio" with "nesta aba" makes one as the second tab of the shell's group; "Novo quadro vazio à direita"
//      opens a frame with one;
//   3. "Onde, em relação a" names the reference as its tab reads ("Vazio", a note's file name), never an id;
//   4. the app is killed (main process, by pid) and relaunched: the four empty panes come back, same ids, same
//      frames, same suggested folder;
//   5. filling one with PowerShell through the chooser inside it replaces it in the same group at the same index;
//      filling another with "Nova nota" does the same with a note (file under <folder>/.tether/notes);
//   6. screenshots empty-{dark,light}.png.
// Every kill goes through test/kill.ts (pid + creation time).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type Empty = { id: string; cwd: string; origin: 'add' | 'layout'; highlight: string | undefined; query: string; focused: boolean; error: string | undefined }
type Note = { id: string; path: string; text: string }
type Hooks = {
  panelIds(): string[]
  activate(id: string): void
  activeId(): string | undefined
  frameIds(): string[]
  frameOf(id: string): string | undefined
  groupOf(id: string): string | undefined
  tabIndex(id: string): number | undefined
  connection(): { connected: boolean; pid?: number } | undefined
  runCommand(id: string): Promise<'ran' | 'unknown' | 'unavailable'>
  commands(): { id: string; title: string; hint: string; available: boolean }[]
  empties(): Empty[]
  empty(id: string): Empty | undefined
  notes(): Note[]
  layout(): unknown
  desks(): { id: string; panes: string[] }[]
  activeDesk(): string
}
declare const window: { __tether: Hooks }
declare const document: { activeElement: { closest(sel: string): unknown } | null; documentElement: { dataset: Record<string, string> }; querySelectorAll(sel: string): { length: number } }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const artifacts = join(root, 'test', 'e2e', 'artifacts')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const pipe = `\\\\.\\pipe\\tether-empty-${process.pid}`
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
  page.setDefaultTimeout(15_000)
  page.on('pageerror', e => console.error(`renderer error: ${e.message}`))
  page.on('console', m => { if (m.type() === 'error') console.error(`renderer console: ${m.text().slice(0, 300)}`) })
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800))
  return { app, page }
}

/** The keyboard to a shell pane. Retried: a pane just added takes the focus on its next frame, which can land after our click. */
async function focusShell(page: Page, id: string): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await page.evaluate(id => window.__tether.activate(id), id)
    await page.locator(`.panel[data-slot-id="${id}"] .panel-term`).click()
    try { await page.waitForFunction(id => window.__tether.activeId() === id, id, { timeout: 2000 }); return } catch { await sleep(150) }
  }
  await page.waitForFunction(id => window.__tether.activeId() === id, id)
}

async function shot(app: ElectronApplication, name: string): Promise<void> {
  const b64 = await app.evaluate(async ({ BrowserWindow }) => {
    const img = await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()
    return img.resize({ width: Math.round(img.getSize().width / 2), quality: 'best' }).toPNG().toString('base64')
  })
  writeFileSync(join(artifacts, `${name}.png`), Buffer.from(b64, 'base64'))
}

const empties = (page: Page) => page.evaluate(() => window.__tether.empties())
const place = (page: Page, id: string) => page.evaluate(id => ({ frame: window.__tether.frameOf(id), group: window.__tether.groupOf(id), index: window.__tether.tabIndex(id) }), id)
const dialogRef = (page: Page) => page.locator('#dlg-new .where-sum .w').innerText().then(s => s.replace(/^como aba, ao lado de /, ''))

test('app empty: chooser offers Vazio/Nota, empty panes by chord/command/dialog, kill and resume, filled in place with a shell and a note', async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(artifacts, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-empty-'))
  const work = mkdtempSync(join(tmpdir(), 'tether-empty-work-'))
  const other = mkdtempSync(join(tmpdir(), 'tether-empty-other-'))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    const daemonPid = (await page.evaluate(() => window.__tether.connection()))?.pid
    assert.ok(daemonPid && pidAlive(daemonPid), 'the app spawned a tetherd')
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))

    // 1. The popup: the profiles, then Nota and Vazio; a PowerShell is opened from it by a click.
    await page.click('#btn-new')
    await page.waitForSelector('#dlg-new[open]')
    const groupLabels = await page.locator('#dlg-new .ch-sep').allInnerTexts()
    assert.deepEqual(groupLabels.slice(-2).map(s => s.trim().toLowerCase()), ['nota', 'vazio'], groupLabels.join(' | ')) // innerText carries the CSS uppercase
    assert.equal(await page.locator('#dlg-new .ch-item[data-kind="empty"] .ch-name').innerText(), 'Vazio — escolher depois')
    assert.equal(await page.locator('#dlg-new .ch-item[data-kind="note-new"]').count(), 1)
    assert.equal(await page.locator('#dlg-new .ch-item[data-kind="note-open"]').count(), 1)
    assert.equal(await page.locator('#dlg-new .where').count(), 0, 'nothing to be relative to yet')
    await page.fill('#dlg-new .ch-path-input', work)
    await page.click('#dlg-new .ch-item[data-id="powershell"]')
    await page.click('#dlg-new .btn.primary.go') // two steps: the click selects, the button opens
    await page.locator('#dlg-new[open]').waitFor({ state: 'hidden' })
    await page.waitForFunction(() => window.__tether.panelIds().length === 1)
    const [shell] = await page.evaluate(() => window.__tether.panelIds())
    await focusShell(page, shell!)
    const shellPlace = await place(page, shell!)

    // 2a. Ctrl+Shift+→ from inside the terminal: an empty pane beside it, suggesting the pane's folder, with the keyboard.
    await page.keyboard.press('Control+Shift+ArrowRight')
    await page.waitForFunction(() => window.__tether.empties().length === 1)
    let [e1] = await empties(page)
    assert.ok(e1!.id.startsWith('empty:'), e1!.id)
    assert.equal(e1!.cwd, work, 'the chooser suggests the folder of the pane it was split from')
    assert.equal(await page.evaluate(id => window.__tether.frameOf(id), e1!.id), shellPlace.frame, 'same frame')
    assert.notEqual(await page.evaluate(id => window.__tether.groupOf(id), e1!.id), shellPlace.group, 'a group of its own, to the right')
    await page.waitForFunction(id => window.__tether.empty(id)?.focused === true, e1!.id)
    assert.equal(await page.locator('.tether-tab.empty .text').first().innerText(), 'Vazio')
    assert.equal(e1!.origin, 'add', 'Ctrl+Shift+Arrow is a request: Esc would close it')
    assert.equal(await page.locator(`.empty-panel[data-empty-id="${e1!.id}"] .ch-item[data-kind="note-new"]`).count(), 1, 'the notes are offered inside the pane')
    assert.equal(await page.locator(`.empty-panel[data-empty-id="${e1!.id}"] .ch-item[data-kind="empty"]`).count(), 0, 'no "Vazio" inside a Vazio')

    // 2b. The palette command, with the shell as reference: an empty pane below it.
    await focusShell(page, shell!)
    const cmds = await page.evaluate(() => window.__tether.commands())
    assert.equal(cmds.find(c => c.id === 'pane.split-empty.pane.right')?.hint, 'Ctrl+Shift+→')
    assert.equal(cmds.find(c => c.id === 'pane.split-empty.pane.below')?.title, 'Dividir abaixo (vazio)')
    assert.ok(cmds.find(c => c.id === 'frame.new-empty.right')?.available && cmds.find(c => c.id === 'desk.new-empty')?.available)
    assert.equal(await page.evaluate(() => window.__tether.runCommand('pane.split-empty.pane.below')), 'ran')
    await page.waitForFunction(() => window.__tether.empties().length === 2)
    const e2 = (await empties(page)).find(e => e.id !== e1!.id)!
    assert.equal(await page.evaluate(id => window.__tether.frameOf(id), e2.id), shellPlace.frame)

    // 2c. The popup's "Vazio", "como aba" relative to the shell: the second tab of the shell's group, origin layout.
    await focusShell(page, shell!)
    await page.click('#btn-new')
    await page.waitForSelector('#dlg-new[open]')
    assert.ok((await dialogRef(page)).length > 0 && !/^[0-9a-f]{6,}$/i.test(await dialogRef(page)), `the reference reads as a title: ${await dialogRef(page)}`)
    assert.match(await page.locator('#dlg-new .where-sum .w').innerText(), /^como aba, ao lado de /, '"como aba" by default')
    await page.fill('#dlg-new .ch-path-input', other)
    await page.click('#dlg-new .ch-item[data-id="kind:empty"]')
    await page.click('#dlg-new .btn.primary.go') // two steps: the click selects, the button opens
    await page.locator('#dlg-new[open]').waitFor({ state: 'hidden' })
    await page.waitForFunction(() => window.__tether.empties().length === 3)
    const e3 = (await empties(page)).find(e => e.id !== e1!.id && e.id !== e2.id)!
    const e3Place = await place(page, e3.id)
    assert.equal(e3Place.group, shellPlace.group, 'in the shell\'s group')
    assert.equal(e3Place.index, 1, 'the second tab')
    assert.equal(e3.cwd, other, 'the folder typed in the popup is what its chooser suggests')
    assert.equal(e3.origin, 'layout', 'a "Vazio" picked on purpose is layout: Esc will not close it')

    // 2d. "Novo quadro vazio à direita": a second frame with one empty pane.
    assert.equal(await page.evaluate(() => window.__tether.runCommand('frame.new-empty.right')), 'ran')
    await page.waitForFunction(() => window.__tether.empties().length === 4 && window.__tether.frameIds().length === 2)
    const e4 = (await empties(page)).find(e => ![e1!.id, e2.id, e3.id].includes(e.id))!
    assert.notEqual(await page.evaluate(id => window.__tether.frameOf(id), e4.id), shellPlace.frame, 'a frame of its own')

    // 3. "Onde, em relação a" with an empty pane as the reference: "Vazio".
    await page.evaluate(id => window.__tether.activate(id), e1!.id)
    await page.waitForFunction(id => window.__tether.activeId() === id, e1!.id)
    await page.click('#btn-new')
    await page.waitForSelector('#dlg-new[open]')
    assert.equal(await dialogRef(page), 'Vazio')
    await page.click('#dlg-new .btn.cancel')
    await page.waitForFunction(() => document.querySelectorAll('#dlg-new[open]').length === 0)

    // 4. Kill (main process, by pid) and relaunch: the four come back, same ids, same frames, same folders.
    await sleep(700) // the layout debounce
    const savedIds = JSON.stringify(await page.evaluate(() => window.__tether.layout()))
    for (const e of [e1!, e2, e3, e4]) assert.ok(savedIds.includes(e.id), `${e.id} in layout.json`)
    const before: Record<string, { frame: string | undefined; group: string | undefined; index: number | undefined; cwd: string }> = {}
    for (const e of [e1!, e2, e3, e4]) before[e.id] = { ...(await place(page, e.id)), cwd: (await page.evaluate(id => window.__tether.empty(id), e.id))!.cwd }
    await page.evaluate(() => window.__tether.runCommand('theme.dark'))
    await page.evaluate(id => window.__tether.activate(id), e1!.id)
    await sleep(400)
    await shot(app, 'empty-dark')
    await killElectron(app, root)
    app = undefined
    ;({ app, page } = await launch(home))
    await page.waitForFunction(() => window.__tether.empties().length === 4)
    await page.waitForFunction(() => window.__tether.panelIds().length === 5)
    for (const [id, was] of Object.entries(before)) {
      const now = await place(page, id)
      assert.equal(now.frame, was.frame, `${id}: same frame`)
      assert.equal(now.index, was.index, `${id}: same tab index`)
      assert.equal((await page.evaluate(id => window.__tether.empty(id), id))!.cwd, was.cwd, `${id}: same suggested folder`)
    }
    assert.equal((await page.evaluate(id => window.__tether.empty(id), e1!.id))!.origin, 'add', 'the origin survived the restart')
    assert.equal((await page.evaluate(id => window.__tether.empty(id), e3.id))!.origin, 'layout')
    assert.equal(await page.evaluate(id => window.__tether.groupOf(id), e3.id), await page.evaluate(id => window.__tether.groupOf(id), shell!), 'still the shell\'s group')

    // 5a. Fill e3 (second tab of the shell's group) with PowerShell from the chooser inside it: Enter opens; same group, same index.
    await page.evaluate(id => window.__tether.activate(id), e3.id)
    const pane3 = page.locator(`.empty-panel[data-empty-id="${e3.id}"]`)
    await pane3.locator('.ch-path-input').fill(work)
    await pane3.locator('.ch-q').focus()
    await page.keyboard.type('power')
    await page.waitForFunction(id => window.__tether.empty(id)?.highlight === 'powershell', e3.id)
    const idsBefore = await page.evaluate(() => window.__tether.panelIds())
    await page.keyboard.press('Enter')
    await page.waitForFunction(n => window.__tether.empties().length === n, 3)
    const idsAfter = await page.evaluate(() => window.__tether.panelIds())
    const newShell = idsAfter.find(id => !idsBefore.includes(id))!
    assert.ok(newShell && !newShell.startsWith('empty:') && !newShell.startsWith('note:'), `a slot pane took its place (${newShell})`)
    assert.ok(!idsAfter.includes(e3.id), 'the empty pane is gone')
    const shellNow = await place(page, newShell)
    assert.equal(shellNow.group, before[e3.id]!.group, 'same group')
    assert.equal(shellNow.index, before[e3.id]!.index, 'same tab index')
    assert.equal(await page.evaluate(() => window.__tether.activeId()), newShell, 'and it is the active pane')
    await page.waitForSelector(`.panel[data-slot-id="${newShell}"] .panel-term`)

    // 5b. Fill e1 with "Nova nota" (folder = other, no git): a note in its place, file under other/.tether/notes.
    await page.evaluate(id => window.__tether.activate(id), e1!.id)
    const pane1 = page.locator(`.empty-panel[data-empty-id="${e1!.id}"]`)
    await pane1.locator('.ch-path-input').fill(other)
    await pane1.locator('.ch-item[data-id="kind:note-new"]').click()
    await page.waitForFunction(id => window.__tether.empty(id)?.highlight === 'kind:note-new', e1!.id)
    assert.equal(await pane1.locator('.btn.primary .go-l').innerText(), 'Criar', 'the button says what it does')
    await pane1.locator('.btn.primary').click()
    await page.waitForFunction(() => window.__tether.notes().length === 1)
    const [note] = await page.evaluate(() => window.__tether.notes())
    const notesDir = join(other, '.tether', 'notes')
    assert.ok(existsSync(notesDir) && readdirSync(notesDir).length === 1, 'the file was created in <folder>/.tether/notes')
    assert.equal(resolve(note!.path), resolve(notesDir, readdirSync(notesDir)[0]!))
    const notePlace = await place(page, note!.id)
    assert.equal(notePlace.group, before[e1!.id]!.group, 'the note took the empty pane\'s group')
    assert.equal(notePlace.index, before[e1!.id]!.index)
    assert.equal((await empties(page)).length, 2)
    assert.ok(!(await page.evaluate(() => window.__tether.panelIds())).includes(e1!.id))

    // 3 (again). The reference of a note reads as its file name.
    await page.waitForFunction(id => window.__tether.activeId() === id, note!.id)
    await page.click('#btn-new')
    await page.waitForSelector('#dlg-new[open]')
    assert.equal(await dialogRef(page), note!.path.split(/[\\/]/).pop())
    await page.click('#dlg-new .where-sum')
    assert.equal(await page.locator('#dlg-new .placement-group[data-level="desk"] .placement-hint').innerText(), 'num quadro novo, na borda da mesa')
    await page.click('#dlg-new .btn.cancel')
    await page.waitForFunction(() => document.querySelectorAll('#dlg-new[open]').length === 0)

    // 6. Light screenshot on an empty pane.
    await page.evaluate(() => window.__tether.runCommand('theme.light'))
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
    await page.evaluate(id => window.__tether.activate(id), e2.id)
    await sleep(400)
    await shot(app, 'empty-light')
  } finally {
    if (app) await killElectron(app, root).catch(e => console.error(String(e)))
    for (const d of daemons) {
      const r = await killOwned(d, { tree: true })
      if (r === 'not-ours') console.error(`tetherd cleanup: pid ${d.pid} is no longer ours; not killed`)
    }
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && daemons.some(d => pidAlive(d.pid))) await sleep(200)
    for (const dir of [home, work, other]) {
      for (let i = 0; i < 5; i++) {
        try { rmSync(dir, { recursive: true, force: true }); break } catch { await sleep(300) }
      }
    }
  }
})
