// E2E of the keyboard scheme (F5, delivery 5): against the real tetherd on a private home/pipe, hidden window, a
// PowerShell pane in a temporary folder.
//   1. Ctrl+K from inside the terminal shows the pill (with the terminal's reminder) and Ctrl+S opens the "Atalhos de
//      teclado" screen in the peek card, whose "Abrir nesta mesa" makes it a tab in the shell's group, with the keyboard
//      in it; the Esc of a pending prefix cancels;
//   2. the screen: search "fechar mesa", double-click records; Ctrl+W is typed, the dialog names the conflict with
//      "Fechar painel…", Enter assigns: "Fechar mesa…" has Ctrl+W, "Fechar painel…" lost it (Ctrl+F4 stays);
//      <home>/keybindings.json holds exactly that (a `-pane.close` and a `desk.close`), the row says "você";
//   3. Ctrl+W inside the shell still passes to PSReadLine (erases the word; the pane stays), Ctrl+F4 asks to close (cancelled);
//   4. a note closed with Ctrl+F4 comes back with Ctrl+Shift+T (the same file); Ctrl+W, now "Fechar mesa…", closes nothing with one desk;
//   5. Ctrl+\ in the shell duplicates it to the right (a second PowerShell pane);
//   6. the file edited by hand (an invalid one) shows the banner and keeps the defaults; fixed, the override applies again;
//   7. the app is killed and relaunched: the override survives and the tab comes back;
//   8. screenshots keybindings-{dark,light}.png.
// Every kill goes through test/kill.ts (pid + creation time).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type KbRow = { command: string; keys: string | null; where: string[]; user: boolean; conflict: boolean; fixed?: string }
type Hooks = {
  panelIds(): string[]
  activate(id: string): void
  activeId(): string | undefined
  text(id: string): string
  connection(): { connected: boolean; pid?: number } | undefined
  runCommand(id: string): Promise<'ran' | 'unknown' | 'unavailable'>
  commands(): { id: string; title: string; hint: string; available: boolean }[]
  keybindings(): { id: string; query: string; rows: KbRow[]; selected?: string; dialog?: { command: string; keys: string; where: string[]; conflict: string; terminal: string }; banner?: string; overrides: number }[]
  pill(): { state: string; text: string; continuations: number }
  keyTable(): { keys: string; command: string; where: string[]; source: string }[]
  keybindingsFile(): { path: string; error?: { message: string; line?: number }; warnings: string[] }
  notes(): { id: string; path: string }[]
  newNote(): Promise<void>
  groupOf(id: string): string | undefined
  closedPanes(): number
}
declare const window: { __tether: Hooks }
declare const document: { activeElement: { closest(sel: string): unknown } | null; documentElement: { dataset: Record<string, string> }; querySelectorAll(sel: string): { length: number } }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const artifacts = join(root, 'test', 'e2e', 'artifacts')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const pipe = `\\\\.\\pipe\\tether-kb-${process.pid}`
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
  page.on('console', m => { if (m.type() === 'error') console.error(`renderer console: ${m.text()}`) })
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
  await page.click('#dlg-new .btn.primary.go') // two steps: the click selects, the button opens
  await page.waitForFunction(() => document.querySelectorAll('#dlg-new[open]').length === 0)
  await page.waitForFunction(n => document.querySelectorAll('.tether-tab').length === n, before + 1)
}

async function focusShell(page: Page, id: string): Promise<void> {
  await page.evaluate(id => window.__tether.activate(id), id)
  await page.locator(`.panel[data-slot-id="${id}"] .panel-term`).click()
  await page.waitForFunction(id => window.__tether.activeId() === id, id)
  await page.waitForFunction(() => !!document.activeElement?.closest('.xterm'))
}

async function shot(app: ElectronApplication, name: string): Promise<void> {
  const b64 = await app.evaluate(async ({ BrowserWindow }) => {
    const img = await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()
    return img.resize({ width: Math.round(img.getSize().width / 2), quality: 'best' }).toPNG().toString('base64')
  })
  writeFileSync(join(artifacts, `${name}.png`), Buffer.from(b64, 'base64'))
}

const screen = (page: Page) => page.evaluate(() => window.__tether.keybindings()[0])
const table = (page: Page) => page.evaluate(() => window.__tether.keyTable())
const keysOf = async (page: Page, command: string): Promise<string[]> => (await table(page)).filter(b => b.command === command).map(b => b.keys)

test('app keybindings: Ctrl+K Ctrl+S opens the screen, Ctrl+W recorded with its conflict, the file, Ctrl+W passes in the shell, Ctrl+Shift+T reopens, Ctrl+\\ duplicates, a relaunch keeps it', async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(artifacts, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-kb-'))
  const work = mkdtempSync(join(tmpdir(), 'tether-kb-work-'))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    const daemonPid = (await page.evaluate(() => window.__tether.connection()))?.pid
    assert.ok(daemonPid && pidAlive(daemonPid), 'the app spawned a tetherd')
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))

    await createShell(page, work)
    const [shell] = await page.evaluate(() => window.__tether.panelIds())
    await focusShell(page, shell!)
    await page.waitForFunction(id => /PS .*>/.test(window.__tether.text(id)), shell!, { timeout: 30_000 })

    // 1. The prefix from the terminal: the pill waits (with the terminal's reminder); Esc cancels; Ctrl+K Ctrl+S opens the tab.
    await page.keyboard.press('Control+K')
    await page.waitForFunction(() => window.__tether.pill().state === 'wait')
    let pill = await page.evaluate(() => window.__tether.pill())
    assert.match(pill.text, /Ctrl\+K.*aguardando a segunda tecla/)
    assert.match(pill.text, /Foco no terminal/, 'inside a terminal the pill says Ctrl+K again sends the key')
    await page.waitForFunction(() => window.__tether.pill().state === 'list', undefined, { timeout: 3000 })
    pill = await page.evaluate(() => window.__tether.pill())
    assert.ok(pill.continuations >= 8, `after ~800 ms the list of what can come: ${pill.continuations}`)
    assert.match(pill.text, /Atalhos de teclado/)
    // The arrows scroll the list instead of ending the chord (it is often taller than the window).
    const scrollOf = (): Promise<number> => page.evaluate(() => Math.max(...Array.from(document.querySelectorAll('#chord-pill, #chord-pill *'), (e: { scrollTop: number }) => e.scrollTop)))
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('PageDown')
    assert.equal(await page.evaluate(() => window.__tether.pill().state), 'list', 'arrow/PageDown keep the pill open')
    assert.ok(await scrollOf() > 0, 'arrow/PageDown scrolled the list')
    await page.keyboard.press('Home')
    assert.equal(await scrollOf(), 0, 'Home back to the top')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => window.__tether.pill().state === 'hidden')
    assert.deepEqual(await page.evaluate(() => window.__tether.keybindings()), [], 'Esc cancelled: nothing opened')
    await page.keyboard.press('Control+K')
    await page.waitForFunction(() => window.__tether.pill().state === 'wait')
    await page.keyboard.press('Control+S')
    // The screen opens in the peek card; its "Abrir nesta mesa" makes it a tab of the shell's group (the rest works on the tab).
    await page.waitForSelector('#peek .kb-pane')
    await page.click('#peek .peek-open')
    await page.waitForSelector('#peek', { state: 'hidden' })
    await page.waitForSelector('.tether-tab.keybindings')
    await page.waitForFunction(() => window.__tether.keybindings().length === 1 && !window.__tether.keybindings()[0]!.id.includes('peek'))
    const kb = (await screen(page))!
    assert.equal(await page.evaluate(() => window.__tether.activeId()), kb.id, 'the screen is the active pane')
    assert.equal(await page.evaluate(([a, b]: string[]) => window.__tether.groupOf(a!) === window.__tether.groupOf(b!), [kb.id, shell!]), true, 'a tab of the shell\'s group')
    await page.waitForFunction(() => !!document.activeElement?.closest('.kb-list'), undefined, { timeout: 3000 })
    assert.ok(kb.rows.some(r => r.command === 'pane.close' && r.keys === 'Ctrl+F4'), 'every command listed with its keys')
    assert.ok(kb.rows.some(r => r.command === 'pane.close' && r.keys === 'Ctrl+W' && r.where.join(',') === 'window,note'))
    assert.ok(kb.rows.some(r => r.command === 'chord.prefix' && r.keys === 'Ctrl+K'))
    assert.ok(kb.rows.some(r => r.fixed === 'editor'), 'the editor\'s keys are shown (Monaco)')
    assert.ok(kb.rows.some(r => r.fixed === 'nativo' && r.command === 'window.close'))
    assert.ok(kb.rows.some(r => r.command === 'editor.action.add-comment-line' || r.command.startsWith('editor.')), 'Monaco rows')
    await page.waitForFunction(() => window.__tether.pill().state === 'hidden', undefined, { timeout: 3000 })

    // 2. Record Ctrl+W on "Fechar mesa…": the conflict with "Fechar painel…" is told and resolved on the act; the file is written.
    await page.fill('.kb-pane .kb-q', 'fechar mesa')
    await page.waitForFunction(() => window.__tether.keybindings()[0]!.rows[0]?.command === 'desk.close')
    await page.dblclick('.kb-pane tr.r[data-command="desk.close"] td.cmd')
    const after = await page.evaluate(() => ({ panels: window.__tether.panelIds(), screens: window.__tether.keybindings().length, active: window.__tether.activeId(), pane: document.querySelectorAll('.kb-pane').length }))
    assert.equal(after.screens, 1, `the screen is still there after the double-click: ${JSON.stringify(after)}`)
    await sleep(400)
    const after2 = await page.evaluate(() => ({ panels: window.__tether.panelIds(), screens: window.__tether.keybindings().length, active: window.__tether.activeId(), pane: document.querySelectorAll('.kb-pane').length, veil: document.querySelectorAll('.kb-veil:not([hidden])').length }))
    assert.equal(after2.screens, 1, `the screen 400 ms after the double-click: ${JSON.stringify(after2)}`)
    await page.waitForFunction(() => !!window.__tether.keybindings()[0]!.dialog && !!document.activeElement?.closest('.kb-veil'))
    await page.keyboard.press('Control+W')
    await page.waitForFunction(() => window.__tether.keybindings()[0]!.dialog?.keys === 'Ctrl+W')
    let dlg = (await screen(page))!.dialog!
    assert.match(dlg.conflict, /Já usado por «Fechar painel…»/)
    assert.deepEqual(dlg.where, ['window', 'terminal', 'note'], 'editing an existing binding keeps where it was valid (Ctrl+K F was everywhere)')
    assert.match(dlg.terminal, /apaga a palavra anterior/, 'with Terminal on, the dialog tells what the shell loses')
    assert.equal(await page.evaluate(() => window.__tether.panelIds().length), 2, 'Ctrl+W inside the record box closed nothing (the shell and the screen)')
    await page.click('.kb-veil .where button[data-w="terminal"]')
    await page.waitForFunction(() => window.__tether.keybindings()[0]!.dialog?.where.join(',') === 'window,note')
    dlg = (await screen(page))!.dialog!
    assert.equal(dlg.terminal, '', 'Terminal off: nothing to warn about, the key passes to the program')
    assert.match(dlg.conflict, /Já usado por «Fechar painel…»/, 'the conflict stays (window and note overlap)')
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => !window.__tether.keybindings()[0]!.dialog)
    await page.waitForFunction(() => window.__tether.keyTable().some(b => b.command === 'desk.close' && b.keys === 'ctrl+w'))
    assert.deepEqual(await keysOf(page, 'desk.close'), ['ctrl+w'], 'editing a row replaces that binding (Ctrl+K F is gone; ↺ gives it back)')
    assert.deepEqual(await keysOf(page, 'pane.close'), ['ctrl+f4'], '"Fechar painel…" lost Ctrl+W')
    const file = join(home, 'keybindings.json')
    await page.waitForFunction(() => window.__tether.keybindings()[0]!.overrides === 2)
    const written = JSON.parse(readFileSync(file, 'utf8').split('\n').filter(l => !l.startsWith('//')).join('\n')) as { key: string; command: string; where?: string[] }[]
    assert.deepEqual(written, [{ key: 'ctrl+w', command: '-pane.close' }, { key: 'ctrl+k f', command: '-desk.close' }, { key: 'ctrl+w', command: 'desk.close' }], 'only what differs from the defaults')
    await page.fill('.kb-pane .kb-q', '')
    await page.waitForFunction(() => window.__tether.keybindings()[0]!.query === '')
    let rows = (await screen(page))!.rows
    assert.ok(rows.some(r => r.command === 'desk.close' && r.keys === 'Ctrl+W' && r.user), 'the row says "você"')
    assert.ok(rows.some(r => r.command === 'pane.close' && r.user), 'the one that lost the key is marked too (↺ gives it back)')
    assert.ok(!rows.some(r => r.conflict), 'no conflict left')
    assert.equal(await page.evaluate(() => window.__tether.commands().find(c => c.id === 'desk.close')?.hint), 'Ctrl+W', 'the hint follows the table')

    // 3. Ctrl+W inside the shell passes to PSReadLine (erases the word, the pane stays); Ctrl+F4 asks to close (cancelled).
    await focusShell(page, shell!)
    await page.keyboard.type('Write-Host alpha bravo')
    await page.keyboard.press('Control+W')
    await sleep(300)
    await page.keyboard.press('Enter')
    await page.waitForFunction(id => window.__tether.text(id).split('\n').some(l => l.trim() === 'alpha'), shell!)
    assert.equal(await page.evaluate(() => window.__tether.panelIds().length), 2, 'the shell (and the screen) are still there: Ctrl+W erased "bravo"')
    await page.keyboard.press('Control+F4')
    await page.waitForSelector('dialog.ask[open]', { timeout: 5000 })
    await page.keyboard.press('Escape')
    await sleep(300)
    assert.equal(await page.evaluate(() => window.__tether.panelIds().length), 2, 'cancelled: nothing closed')

    // 4. A note closed with Ctrl+F4 (Ctrl+W is the desk's now) comes back with Ctrl+Shift+T.
    await page.evaluate(() => window.__tether.newNote())
    await page.waitForFunction(() => window.__tether.notes().length === 1)
    const notePath = (await page.evaluate(() => window.__tether.notes()))[0]!.path
    await page.waitForFunction(() => !!document.activeElement?.closest('[data-editor]'))
    await page.keyboard.press('Control+W')
    await sleep(300)
    assert.equal((await page.evaluate(() => window.__tether.notes())).length, 1, 'Ctrl+W is "Fechar mesa…" now (unavailable with one desk): the note stays')
    await page.keyboard.press('Control+F4')
    await page.waitForFunction(() => window.__tether.notes().length === 0)
    assert.ok((await page.evaluate(() => window.__tether.closedPanes())) >= 1)
    await page.keyboard.press('Control+Shift+T')
    await page.waitForFunction(() => window.__tether.notes().length === 1)
    assert.equal((await page.evaluate(() => window.__tether.notes()))[0]!.path, notePath, 'the same file reopened')
    await page.waitForFunction(() => !!document.activeElement?.closest('[data-editor]'))
    await page.keyboard.press('Control+F4')
    await page.waitForFunction(() => window.__tether.notes().length === 0)

    // 5. Ctrl+\ in the shell duplicates it to the right.
    await focusShell(page, shell!)
    await page.keyboard.press('Control+Backslash')
    await page.waitForFunction(() => window.__tether.panelIds().length === 3, undefined, { timeout: 15_000 })
    const ids = await page.evaluate(() => window.__tether.panelIds())
    const dup = ids.find(id => id !== shell && !id.startsWith('keybindings:'))!
    assert.notEqual(await page.evaluate(id => window.__tether.groupOf(id), dup), await page.evaluate(id => window.__tether.groupOf(id), shell!), 'beside, not a tab')

    // 6. The file edited by hand: invalid → banner, defaults; valid again → the override applies.
    writeFileSync(file, '[\n  { "key": "ctrl+w", "command": "-pane.close" },\n  { "key": "ctrl+w", "command": "desk.close" },\n]')
    await page.waitForFunction(() => !!window.__tether.keybindingsFile().error, undefined, { timeout: 10_000 })
    assert.equal((await page.evaluate(() => window.__tether.keybindingsFile())).error?.line, 4)
    assert.deepEqual(await keysOf(page, 'pane.close'), ['ctrl+f4', 'ctrl+w'], 'defaults while the file is broken')
    await page.evaluate(id => window.__tether.activate(id), kb.id)
    await page.waitForFunction(() => !!window.__tether.keybindings()[0]!.banner)
    assert.match((await screen(page))!.banner!, /linha 4/)
    writeFileSync(file, '[\n  { "key": "ctrl+w", "command": "-pane.close" },\n  { "key": "ctrl+w", "command": "desk.close" }\n]')
    await page.waitForFunction(() => !window.__tether.keybindingsFile().error, undefined, { timeout: 10_000 })
    await page.waitForFunction(() => window.__tether.keyTable().some(b => b.command === 'desk.close' && b.keys === 'ctrl+w'))
    assert.deepEqual(await keysOf(page, 'pane.close'), ['ctrl+f4'])

    // 8a. Dark screenshot of the screen.
    await page.evaluate(() => window.__tether.runCommand('theme.dark'))
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
    await sleep(300)
    await shot(app, 'keybindings-dark')

    // 7. Killed and relaunched: the override survives (the file), the tab comes back (the layout).
    await sleep(1200) // the layout save debounce
    await killElectron(app, root)
    app = undefined
    ;({ app, page } = await launch(home))
    await page.waitForFunction(() => window.__tether.keybindings().length === 1, undefined, { timeout: 20_000 })
    await page.waitForFunction(() => window.__tether.keyTable().some(b => b.command === 'desk.close' && b.keys === 'ctrl+w'))
    assert.deepEqual(await keysOf(page, 'pane.close'), ['ctrl+f4'], 'the override survived the relaunch')
    rows = (await screen(page))!.rows
    assert.ok(rows.some(r => r.command === 'desk.close' && r.keys === 'Ctrl+W' && r.user))

    // 8b. Light screenshot, the record dialog open with a chord typed.
    await page.evaluate(() => window.__tether.runCommand('theme.light'))
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
    await page.evaluate(id => window.__tether.activate(id), (await screen(page))!.id)
    await page.click('.kb-pane .kb-list') // restored as the active pane already: a click gives it the keyboard
    await page.fill('.kb-pane .kb-q', 'atalhos de teclado')
    await page.waitForFunction(() => window.__tether.keybindings()[0]!.rows[0]?.command === 'keybindings.show')
    await page.dblclick('.kb-pane tr.r[data-command="keybindings.show"] td.cmd')
    await page.waitForFunction(() => !!window.__tether.keybindings()[0]!.dialog && !!document.activeElement?.closest('.kb-veil'))
    await page.keyboard.press('Control+K')
    await page.keyboard.press('Control+W')
    await page.waitForFunction(() => window.__tether.keybindings()[0]!.dialog?.keys === 'Ctrl+K Ctrl+W')
    dlg = (await screen(page))!.dialog!
    assert.equal(dlg.conflict, '', 'a chord nobody has')
    await sleep(300)
    await shot(app, 'keybindings-light')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !window.__tether.keybindings()[0]!.dialog)
    assert.deepEqual(await keysOf(page, 'keybindings.show'), ['ctrl+k ctrl+s'], 'Esc recorded nothing')
  } finally {
    if (app) await killElectron(app, root).catch(e => console.error(String(e)))
    for (const d of daemons) {
      const r = await killOwned(d, { tree: true })
      if (r === 'not-ours') console.error(`tetherd cleanup: pid ${d.pid} is no longer ours; not killed`)
    }
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && daemons.some(d => pidAlive(d.pid))) await sleep(200)
    for (const dir of [home, work]) for (let i = 0; i < 5; i++) {
      try { rmSync(dir, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
  }
})
