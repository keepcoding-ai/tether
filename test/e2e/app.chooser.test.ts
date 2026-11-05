// E2E of the new chooser (F5): against the real tetherd on a private home/pipe, hidden window.
//   1. "Novo painel…" (toolbar) with no pane: the popup has no "Onde"; a PowerShell opens from it by a click;
//   2. the "+" of the group's tab strip: an empty tab (origin add) in the group, the pane's folder suggested, the
//      keyboard in the search; Recentes shows the shell just opened and is the highlight; Enter opens it in place;
//   3. Ctrl+N from inside the terminal: an empty tab (origin add) in the same group; Esc closes it;
//   4. "Dividir à direita (vazio)" (palette): origin layout, no Cancelar; Esc leaves it there;
//   5. the digits open the item with that number as shown (renumbered under a filter);
//   6. ⤢: the same chooser as a popup with the typed text, a context chip, no "Onde"; Esc hands the text back;
//   7. the desk-edge "+" ADDS an empty pane (no duplicate); its right-click menu names the three actions;
//   8. the contextless popup with a pane active: "Onde" in one line, the grid in one click, "abaixo" honoured;
//   9. the origin travels in layout.json; screenshots chooser-{dark,light}.png.
// Every kill goes through test/kill.ts (pid + creation time).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type Snap = { query: string; highlight: string | undefined; folder: string; touched: boolean; busy: boolean; error: string | undefined; recentsOpen: boolean; shown: { id: string; n: number | undefined }[]; effectiveFolder: string; focused: boolean }
type Empty = Snap & { id: string; cwd: string; origin: 'add' | 'layout' }
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
  chooser(): Snap | undefined
  slots(): { slotId: string; kind: string; cwd: string }[]
  layout(): unknown
  profiles(): { id: string }[]
  rect(sel: string): { x: number; y: number; width: number; height: number } | undefined
}
declare const window: { __tether: Hooks }
declare const document: { documentElement: { dataset: Record<string, string> }; querySelector(sel: string): { getBoundingClientRect(): { x: number; y: number; width: number; height: number } } | null; querySelectorAll(sel: string): { length: number } }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const artifacts = join(root, 'test', 'e2e', 'artifacts')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const pipe = `\\\\.\\pipe\\tether-chooser-${process.pid}`
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
const ids = (page: Page) => page.evaluate(() => window.__tether.panelIds())
const place = (page: Page, id: string) => page.evaluate(id => ({ frame: window.__tether.frameOf(id), group: window.__tether.groupOf(id), index: window.__tether.tabIndex(id) }), id)
const newOf = (before: string[], after: string[]): string => { const fresh = after.filter(id => !before.includes(id)); assert.equal(fresh.length, 1, `one new pane: ${after.join(', ')}`); return fresh[0]! }
const noDialog = (page: Page) => page.waitForFunction(() => document.querySelectorAll('#dlg-new[open]').length === 0)

test('app chooser: popup, strip "+", Ctrl+N, origins, digits, focus mode, edge "+", Onde', async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(artifacts, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-chooser-'))
  const work = mkdtempSync(join(tmpdir(), 'tether-chooser-work-'))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    const daemonPid = (await page.evaluate(() => window.__tether.connection()))?.pid
    assert.ok(daemonPid && pidAlive(daemonPid), 'the app spawned a tetherd')
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))
    await page.waitForFunction(() => window.__tether.profiles().length >= 3)

    // 1. The popup with no pane: three bands, no "Onde", Claude highlighted (no history), a click opens.
    assert.equal(await page.locator('#btn-new').getAttribute('title').then(t => t?.includes('Ctrl+N')), true, 'the toolbar title explains the chord')
    await page.click('#btn-new')
    await page.waitForSelector('#dlg-new[open]')
    assert.equal(await page.locator('#dlg-new .where').count(), 0, 'nothing to be relative to: no "Onde"')
    assert.ok(await page.locator('#dlg-new #new-context').isHidden(), 'no context chip')
    let snap = (await page.evaluate(() => window.__tether.chooser()))!
    assert.equal(snap.highlight, 'claude', 'no history: the Claude default')
    assert.equal(snap.shown[0]!.id, 'claude')
    assert.ok(snap.shown.some(s => s.id === 'kind:note-new') && snap.shown.some(s => s.id === 'kind:empty'), 'notes and the empty pane are offered in the popup')
    assert.ok(snap.focused, 'the search has the keyboard')
    assert.deepEqual(await page.locator('#dlg-new .ch-sep').allInnerTexts().then(l => l.map(s => s.trim().toLowerCase())), ['claude', 'soul', 'shell', 'nota', 'vazio'])
    assert.equal(await page.locator('#dlg-new .btn.primary .go-l').innerText(), 'Abrir')
    await page.fill('#dlg-new .ch-path-input', work)
    await page.click('#dlg-new .ch-item[data-id="powershell"]')
    await noDialog(page)
    await page.waitForFunction(() => window.__tether.panelIds().length === 1)
    const [shell] = await ids(page)
    await focusShell(page, shell!)
    const shellPlace = await place(page, shell!)

    // 2. The "+" of the strip: an empty tab (add) in the group; Recentes = powershell, highlighted; Enter opens it in place.
    await page.locator(`.dv-groupview:has(.panel[data-slot-id="${shell}"]) .dv-right-actions-container [data-action="add-tab"]`).click()
    await page.waitForFunction(() => window.__tether.empties().length === 1)
    let [e1] = await empties(page)
    assert.equal(e1!.origin, 'add')
    assert.equal(e1!.cwd, work, 'the group\'s pane folder is suggested')
    assert.deepEqual([await page.evaluate(id => window.__tether.groupOf(id), e1!.id), await page.evaluate(id => window.__tether.tabIndex(id), e1!.id)], [shellPlace.group, 1], 'second tab of the shell\'s group')
    await page.waitForFunction(id => window.__tether.empty(id)?.focused === true, e1!.id)
    e1 = (await page.evaluate(id => window.__tether.empty(id), e1!.id))!
    assert.equal(e1.shown[0]!.id, 'powershell', 'Recentes first: the shell just opened')
    assert.equal(e1.highlight, 'powershell', 'the last used is the highlight')
    assert.equal(await page.locator(`.empty-panel[data-empty-id="${e1.id}"] .ch-sep`).first().innerText().then(s => s.trim().toLowerCase()), 'recentes')
    assert.equal(await page.locator(`.empty-panel[data-empty-id="${e1.id}"] .ch-item[data-id="kind:empty"]`).count(), 0, 'no "Vazio" inside a pane')
    assert.equal(await page.locator(`.empty-panel[data-empty-id="${e1.id}"] .btn.primary`).innerText().then(s => s.replace(/\s+/g, ' ').trim()), 'Abrir PowerShell Enter')
    assert.equal(await page.locator(`.empty-panel[data-empty-id="${e1.id}"] .btn.cancel`).count(), 1, 'a "+" pane has Cancelar')
    let before = await ids(page)
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => window.__tether.empties().length === 0)
    const shell2 = newOf(before, await ids(page))
    assert.deepEqual(await place(page, shell2), { ...shellPlace, index: 1 }, 'the shell took the empty tab\'s place')
    assert.equal((await page.evaluate(() => window.__tether.slots())).find(s => s.slotId === shell2)?.cwd, work)

    // 3. Ctrl+N inside the terminal: an empty tab (add) in the group; Esc closes it.
    await focusShell(page, shell2)
    await page.keyboard.press('Control+N')
    await page.waitForFunction(() => window.__tether.empties().length === 1)
    const e2 = (await empties(page))[0]!
    assert.equal(e2.origin, 'add')
    assert.equal(await page.evaluate(id => window.__tether.groupOf(id), e2.id), shellPlace.group)
    await page.waitForFunction(id => window.__tether.empty(id)?.focused === true, e2.id)
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => window.__tether.empties().length === 0)
    assert.ok(!(await ids(page)).includes(e2.id), 'Esc closed the "+" pane')

    // 4. A laid-out empty pane (palette command): origin layout, no Cancelar, Esc leaves it there.
    await focusShell(page, shell!)
    assert.equal(await page.evaluate(() => window.__tether.runCommand('pane.split-empty.pane.right')), 'ran')
    await page.waitForFunction(() => window.__tether.empties().length === 1)
    const e3 = (await empties(page))[0]!
    assert.equal(e3.origin, 'layout')
    assert.equal(await page.locator(`.empty-panel[data-empty-id="${e3.id}"] .btn.cancel`).count(), 0, 'a laid-out pane has no Cancelar')
    await page.waitForFunction(id => window.__tether.empty(id)?.focused === true, e3.id)
    await page.keyboard.press('Escape')
    await sleep(300)
    assert.ok((await ids(page)).includes(e3.id), 'Esc did not close a laid-out pane')
    await page.waitForFunction(id => window.__tether.empty(id)?.focused === false, e3.id)
    assert.equal(await page.evaluate(() => window.__tether.activeId()), shell, 'the keyboard went back to the pane that had it')

    // 5. Digits: the number shown is the key; a filter renumbers.
    await page.evaluate(id => window.__tether.activate(id), e3.id)
    await page.waitForFunction(id => window.__tether.empty(id)?.focused === true, e3.id)
    await page.keyboard.type('pow')
    await page.waitForFunction(id => window.__tether.empty(id)?.query === 'pow', e3.id)
    let s3 = (await page.evaluate(id => window.__tether.empty(id), e3.id))!
    assert.equal(s3.shown[0]!.id, 'powershell')
    assert.equal(s3.shown[0]!.n, 1, 'renumbered from 1 under the filter')
    await page.keyboard.press('Escape') // clears the text
    await page.waitForFunction(id => window.__tether.empty(id)?.query === '', e3.id)
    s3 = (await page.evaluate(id => window.__tether.empty(id), e3.id))!
    assert.ok((await ids(page)).includes(e3.id), 'Esc with text only cleared it')
    const n = s3.shown.find(x => x.id === 'soul')?.n
    assert.ok(n && n <= 9, 'soul has a number')
    assert.equal(await page.locator(`.empty-panel[data-empty-id="${e3.id}"] .ch-item[data-id="soul"] kbd.num`).innerText(), String(n))
    before = await ids(page)
    await page.locator(`.empty-panel[data-empty-id="${e3.id}"] .ch-path-input`).fill(work)
    await page.locator(`.empty-panel[data-empty-id="${e3.id}"] .ch-q`).focus()
    await page.keyboard.press(String(n))
    await page.waitForFunction(() => window.__tether.empties().length === 0)
    const soul = newOf(before, await ids(page))
    assert.equal((await page.evaluate(() => window.__tether.slots())).find(s => s.slotId === soul)?.kind, 'soul', 'the digit opened soul in the pane\'s place')

    // 6. ⤢: the same chooser in focus mode with the typed text; Esc hands it back.
    await focusShell(page, shell!)
    await page.keyboard.press('Control+N')
    await page.waitForFunction(() => window.__tether.empties().length === 1)
    const e4 = (await empties(page))[0]!
    await page.waitForFunction(id => window.__tether.empty(id)?.focused === true, e4.id)
    await page.keyboard.type('so')
    await page.locator(`.empty-panel[data-empty-id="${e4.id}"] .ch-expand`).click()
    await page.waitForSelector('#dlg-new[open]')
    assert.ok(await page.locator('#new-context').isVisible(), 'the context chip')
    assert.equal(await page.locator('#dlg-new .where').count(), 0, 'the pane is the place: no "Onde"')
    snap = (await page.evaluate(() => window.__tether.chooser()))!
    assert.equal(snap.query, 'so', 'the typed text travelled')
    assert.equal(snap.shown[0]!.id, 'soul')
    assert.ok(snap.focused)
    await page.evaluate(() => window.__tether.runCommand('theme.dark'))
    await sleep(300)
    await shot(app, 'chooser-focus-dark')
    await page.keyboard.press('Escape') // clears the popup's text
    await page.waitForFunction(() => window.__tether.chooser()?.query === '')
    await page.keyboard.press('Escape') // closes the popup, back to the pane
    await noDialog(page)
    await page.waitForFunction(id => window.__tether.empty(id)?.focused === true, e4.id)
    assert.ok((await ids(page)).includes(e4.id), 'the pane continues')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => window.__tether.empties().length === 0)

    // 7. The desk-edge "+": adds (no duplicate); right-click names the three actions.
    await focusShell(page, shell!)
    const dock = (await page.evaluate(() => document.querySelector('#dock')?.getBoundingClientRect()))!
    await page.mouse.move(dock.x + dock.width / 2, dock.y + dock.height / 2)
    await page.mouse.move(dock.x + dock.width - 3, dock.y + dock.height / 2)
    await page.waitForSelector('.edge-plus.desk[data-side="right"]:not([hidden])')
    assert.ok((await page.locator('.edge-plus.desk[data-side="right"]:not([hidden])').getAttribute('title'))!.includes('clique direito: duplicar'))
    const slotsBefore = (await page.evaluate(() => window.__tether.slots())).length
    const framesBefore = (await page.evaluate(() => window.__tether.frameIds())).length
    await page.click('.edge-plus.desk[data-side="right"]:not([hidden])')
    await page.waitForFunction(() => window.__tether.empties().length === 1)
    const e5 = (await empties(page))[0]!
    assert.equal(e5.origin, 'add')
    assert.equal(e5.cwd, work, 'the focused pane\'s folder')
    assert.equal((await page.evaluate(() => window.__tether.frameIds())).length, framesBefore + 1, 'a new frame')
    assert.equal((await page.evaluate(() => window.__tether.slots())).length, slotsBefore, 'nothing was duplicated')
    await page.waitForFunction(id => window.__tether.empty(id)?.focused === true, e5.id)
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => window.__tether.empties().length === 0)
    await page.waitForFunction(n => window.__tether.frameIds().length === n, framesBefore, undefined)
    await focusShell(page, shell!)
    await page.mouse.move(dock.x + dock.width / 2, dock.y + dock.height / 2)
    await page.mouse.move(dock.x + dock.width - 3, dock.y + dock.height / 2)
    await page.waitForSelector('.edge-plus.desk[data-side="right"]:not([hidden])')
    await page.click('.edge-plus.desk[data-side="right"]:not([hidden])', { button: 'right' })
    await page.waitForSelector('#ctx-menu')
    const menu = await page.locator('#ctx-menu li[role=menuitem]').allTextContents()
    assert.equal(menu[0], 'Novo quadro aqui')
    assert.match(menu[1]!, /^Duplicar .+ aqui$/)
    assert.equal(menu[2], 'Novo painel… (modo foco)')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('#ctx-menu'))

    // 8. The contextless popup with a pane active: "Onde" in one line; the grid in a click; "abaixo" honoured.
    await focusShell(page, shell!)
    await page.click('#btn-new')
    await page.waitForSelector('#dlg-new[open]')
    assert.equal(await page.locator('#dlg-new .where').count(), 1)
    assert.match(await page.locator('#dlg-new .where-sum .w').innerText(), /^como aba, ao lado de /)
    assert.ok(await page.locator('#dlg-new .placements').isHidden(), 'the grid starts folded')
    await page.click('#dlg-new .where-sum')
    await page.waitForSelector('#dlg-new .placements:not([hidden])')
    assert.equal(await page.locator('#dlg-new .placement-group').count(), 3, 'PAINEL / QUADRO / MESA')
    await page.click('#dlg-new .placement[data-level="pane"][data-placement="below"]')
    assert.match(await page.locator('#dlg-new .where-sum .w').innerText(), /^abaixo de /)
    await page.evaluate(() => window.__tether.runCommand('theme.light'))
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
    await sleep(300)
    await shot(app, 'chooser-popup-light')
    await page.fill('#dlg-new .ch-path-input', work)
    before = await ids(page)
    await page.click('#dlg-new .ch-item[data-id="powershell"]')
    await noDialog(page)
    await page.waitForFunction(n => window.__tether.panelIds().length === n, before.length + 1)
    const below = newOf(before, await ids(page))
    const belowPlace = await place(page, below)
    assert.equal(belowPlace.frame, shellPlace.frame)
    assert.notEqual(belowPlace.group, shellPlace.group, 'a group of its own, below')
    const a = await page.locator(`.panel[data-slot-id="${below}"]`).boundingBox()
    const b = await page.locator(`.panel[data-slot-id="${shell}"]`).boundingBox()
    assert.ok(a && b && a.y >= b.y + b.height - 2, 'the shell sits below the first one')

    // 9. The origin travels in layout.json; screenshots on an empty pane, light and dark.
    await focusShell(page, shell!)
    await page.keyboard.press('Control+N')
    await page.waitForFunction(() => window.__tether.empties().length === 1)
    const e6 = (await empties(page))[0]!
    await sleep(700) // the layout debounce
    const layout = JSON.stringify(await page.evaluate(() => window.__tether.layout()))
    assert.ok(layout.includes(e6.id) && layout.includes('"origin":"add"'), 'origin add saved with the pane')
    await page.waitForFunction(id => window.__tether.empty(id)?.focused === true, e6.id)
    await sleep(300)
    await shot(app, 'chooser-light')
    await page.evaluate(() => window.__tether.runCommand('theme.dark'))
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
    await sleep(300)
    await shot(app, 'chooser-dark')
  } finally {
    if (app) await killElectron(app, root).catch(e => console.error(String(e)))
    for (const d of daemons) {
      const r = await killOwned(d, { tree: true })
      if (r === 'not-ours') console.error(`tetherd cleanup: pid ${d.pid} is no longer ours; not killed`)
    }
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && daemons.some(d => pidAlive(d.pid))) await sleep(200)
    for (const dir of [home, work]) {
      for (let i = 0; i < 5; i++) {
        try { rmSync(dir, { recursive: true, force: true }); break } catch { await sleep(300) }
      }
    }
  }
})
