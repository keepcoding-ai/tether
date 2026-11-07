// E2E of the note tab (F5, delivery 1): against the real tetherd on a private home/pipe, hidden window.
//   1. "Nova nota" with a PowerShell pane in focus creates `<cwd>/.tether/notes/AAAA-MM-DD-HHmm.md` next to it,
//      the editor (Monaco) gets the focus and its actions are registered as commands;
//   2. typing lands on disk after the debounce; Ctrl+Shift+Alt+↓ selects a column (the app's frame chord stays
//      quiet), typing at the three cursors edits the three lines; Ctrl+Alt+↓ adds a cursor (no pane duplicated);
//   3. Ctrl+Shift+P from inside the editor opens the app's palette, which lists the editor's actions with their chords;
//   4. the cwd is a git repository without `.tether/` in `.gitignore`: the app's own dialog asks once, "add" writes the line;
//   5. the file changed outside while the editor is clean: the text reloads and the cursor stays;
//   6. renaming the tab renames the file; moving the note to the drawer and back keeps text and file;
//   7. the app is killed (main process, no chance to save) and relaunched: the note tab comes back in the same
//      group, same file, same text, same cursor and selection, same scroll;
//   8. screenshots note-{dark,light}.png.
// Every kill goes through test/kill.ts (pid + creation time).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'
import { clickMenuItem } from './menu-helpers.ts'

type Note = {
  id: string; path: string; text: string; savedText: string; dirty: boolean
  cursor: { lineNumber: number; column: number } | undefined
  selections: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }[]
  scrollTop: number; viewport: { width: number; height: number; scrollHeight: number }; focused: boolean; error: string | undefined
}
type Hooks = {
  panelIds(): string[]
  activate(id: string): void
  activeId(): string | undefined
  frameIds(): string[]
  frameOf(id: string): string | undefined
  connection(): { connected: boolean; pid?: number } | undefined
  runCommand(id: string): Promise<'ran' | 'unknown' | 'unavailable'>
  palette(): { open: boolean; mode?: string; shown: string[]; input: string }
  notes(): Note[]
  note(id: string): Note | undefined
  editorCommandIds(): string[]
  commands(): { id: string; title: string; hint: string; available: boolean }[]
  drawer(): { open: boolean; panes: string[] }
  inDrawer(id: string): boolean
  movePaneToDrawer(id: string): void
  movePaneFromDrawer(id: string): void
  layout(): unknown
  wordWrap(): { setting: boolean; editors: string[] }
}
declare const window: { __tether: Hooks }
declare const document: { activeElement: { closest(sel: string): unknown } | null; documentElement: { dataset: Record<string, string> }; querySelectorAll(sel: string): { length: number } }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const artifacts = join(root, 'test', 'e2e', 'artifacts')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const pipe = `\\\\.\\pipe\\tether-note-${process.pid}`
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

async function createShell(page: Page, cwd: string): Promise<void> {
  const before = await page.locator('.tether-tab').count()
  await page.click('#btn-new')
  await page.waitForSelector('#dlg-new[open]')
  await page.fill('#dlg-new .ch-path-input', cwd)
  await page.click('#dlg-new .ch-item[data-id=\"powershell\"]')
  await page.waitForFunction(() => document.querySelectorAll('#dlg-new[open]').length === 0)
  await page.waitForFunction(n => document.querySelectorAll('.tether-tab').length === n, before + 1)
}

async function focusShell(page: Page, id: string): Promise<void> {
  await page.evaluate(id => window.__tether.activate(id), id)
  await page.locator(`.panel[data-slot-id="${id}"] .panel-term`).click()
  await page.waitForFunction(id => window.__tether.activeId() === id, id)
}

async function shot(app: ElectronApplication, name: string): Promise<void> {
  const b64 = await app.evaluate(async ({ BrowserWindow }) => {
    const img = await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()
    return img.resize({ width: Math.round(img.getSize().width / 2), quality: 'best' }).toPNG().toString('base64')
  })
  writeFileSync(join(artifacts, `${name}.png`), Buffer.from(b64, 'base64'))
}

const notes = (page: Page) => page.evaluate(() => window.__tether.notes())
const noteOf = (page: Page, id: string) => page.evaluate(id => window.__tether.note(id), id)
/** Back to a single cursor: Esc removes the secondary cursors (a click in the editor when the key was taken by a widget). */
async function oneCursor(page: Page, id: string): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Escape')
    await sleep(80)
    if ((await noteOf(page, id))!.selections.length === 1) return
    await page.locator(`.note-panel[data-note-id="${id}"] .monaco-editor .view-lines`).click()
    await sleep(80)
  }
  await page.waitForFunction(id => window.__tether.note(id)?.selections.length === 1, id)
}
const focusInEditor = (page: Page) => page.evaluate(() => !!document.activeElement?.closest('[data-editor]'))
const waitSaved = (page: Page, id: string, text: string) => page.waitForFunction(([id, text]) => { const n = window.__tether.note(id!); return !!n && n.text === text && !n.dirty }, [id, text] as const)

test('app note: Monaco tab, autosave, column selection and multi-cursor, palette, .gitignore, outside change, rename, move, kill and resume', async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(artifacts, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-note-'))
  const repo = mkdtempSync(join(tmpdir(), 'tether-note-repo-'))
  // A git repository (just the marker folder: no git command needed) with a .gitignore that does not cover .tether/.
  mkdirSync(join(repo, '.git'))
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n')
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    const daemonPid = (await page.evaluate(() => window.__tether.connection()))?.pid
    assert.ok(daemonPid && pidAlive(daemonPid), 'the app spawned a tetherd')
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))

    await createShell(page, repo)
    const [shell] = await page.evaluate(() => window.__tether.panelIds())
    await focusShell(page, shell!)

    // 1. "Nova nota" from the ≡ menu: the file under the pane's cwd, the editor focused, its actions registered.
    await page.click('#btn-menu')
    await page.waitForSelector('#app-menu:not([hidden])')
    assert.equal(await page.locator('#app-menu li[data-command="note.new"]').getAttribute('aria-disabled'), 'false')
    assert.equal(await page.locator('#app-menu li[data-command="note.save-as"]').getAttribute('aria-disabled'), 'true', 'no note focused yet')
    await clickMenuItem(page, 'note.new')
    await page.waitForFunction(() => window.__tether.notes().length === 1)
    // 4. The repository question comes with the first note: the app's own dialog; "add" writes the line.
    const dlg = page.locator('dialog.ask[data-dialog="note-gitignore"][open]')
    await dlg.waitFor()
    await dlg.locator('button.choice[data-choice="add"]').click()
    await page.waitForFunction(() => document.querySelectorAll('dialog.ask[open]').length === 0)
    assert.equal(readFileSync(join(repo, '.gitignore'), 'utf8'), 'node_modules/\n.tether/\n')
    let [note] = await notes(page)
    const noteId = note!.id
    const notesDir = join(repo, '.tether', 'notes')
    assert.match(note!.path, /\d{4}-\d{2}-\d{2}-\d{4}\.md$/)
    assert.equal(resolve(note!.path), resolve(notesDir, readdirSync(notesDir)[0]!), 'the file lives in <cwd>/.tether/notes')
    assert.ok(existsSync(note!.path) && readFileSync(note!.path, 'utf8') === '', 'created empty')
    assert.equal(await page.evaluate(id => window.__tether.frameOf(id), noteId), await page.evaluate(id => window.__tether.frameOf(id), shell!), 'same frame as the pane')
    await page.locator(`.note-panel[data-note-id="${noteId}"] .monaco-editor`).click()
    await page.waitForFunction(id => window.__tether.note(id)?.focused === true, noteId)
    assert.ok(await focusInEditor(page), 'the editor has the keyboard')
    const editorCommands = await page.evaluate(() => window.__tether.editorCommandIds())
    assert.ok(editorCommands.length > 50, `the editor's actions are commands (${editorCommands.length})`)
    assert.ok(editorCommands.includes('editor.action.insert-cursor-below') && editorCommands.includes('editor.action.select-highlights') && editorCommands.includes('editor.actions.find'), editorCommands.join(' '))
    assert.equal(await page.locator('.tether-tab.note .text').innerText(), note!.path.split(/[\\/]/).pop(), 'the tab shows the file name')

    // 2. Typing is written after the debounce; column selection and multi-cursor editing.
    await page.keyboard.type('alpha one')
    await page.keyboard.press('Enter')
    await page.keyboard.type('beta two')
    await page.keyboard.press('Enter')
    await page.keyboard.type('gamma three')
    await waitSaved(page, noteId, 'alpha one\r\nbeta two\r\ngamma three')
    assert.equal(readFileSync(note!.path, 'utf8'), 'alpha one\r\nbeta two\r\ngamma three', 'on disk')
    // Steady typing for seconds, pauses around the save debounce: our own saves echo through the watcher while
    // more text is pending, and none of them may be taken for an outside change (no conflict dialog, ever).
    const steady = ' the quick brown fox jumps over the lazy dog'
    for (let i = 0; i < steady.length; i++) {
      await page.keyboard.type(steady[i]!)
      await sleep(i % 7 === 0 ? 450 : 60 + (i % 5) * 30)
      assert.equal(await page.evaluate(() => document.querySelectorAll('dialog.ask[open]').length), 0, `no dialog while typing (char ${i})`)
    }
    for (let i = 0; i < steady.length; i++) {
      await page.keyboard.press('Backspace')
      await sleep(i % 9 === 0 ? 400 : 40)
    }
    await waitSaved(page, noteId, 'alpha one\r\nbeta two\r\ngamma three')
    await sleep(800)
    assert.equal(await page.evaluate(() => document.querySelectorAll('dialog.ask[open]').length), 0, 'no dialog after the typing settled')
    const framesBefore = await page.evaluate(() => window.__tether.frameIds())
    const panesBefore = (await page.evaluate(() => window.__tether.panelIds())).length
    await page.keyboard.press('Control+Home')
    await page.keyboard.press('Control+Shift+Alt+ArrowDown')
    await page.keyboard.press('Control+Shift+Alt+ArrowDown')
    note = await noteOf(page, noteId)
    assert.deepEqual(note!.selections.map(s => [s.startLineNumber, s.startColumn, s.endLineNumber, s.endColumn]), [[1, 1, 1, 1], [2, 1, 2, 1], [3, 1, 3, 1]], 'a column of three cursors')
    assert.deepEqual(await page.evaluate(() => window.__tether.frameIds()), framesBefore, 'Ctrl+Shift+Alt+↓ did not duplicate at the frame edge')
    await page.keyboard.type('> ')
    await waitSaved(page, noteId, '> alpha one\r\n> beta two\r\n> gamma three')
    assert.equal(readFileSync(note!.path, 'utf8'), '> alpha one\r\n> beta two\r\n> gamma three')
    await oneCursor(page, noteId)
    await page.keyboard.press('Control+Home')
    await page.keyboard.press('Control+Alt+ArrowDown')
    note = await noteOf(page, noteId)
    assert.equal(note!.selections.length, 2, 'Ctrl+Alt+↓ added a cursor')
    assert.equal((await page.evaluate(() => window.__tether.panelIds())).length, panesBefore, 'and duplicated no pane')
    await oneCursor(page, noteId)
    // Ctrl+D (not an app chord) adds the next occurrence; Ctrl+Z undoes a step.
    await page.keyboard.press('Control+End')
    await page.keyboard.type(' alpha')
    await page.keyboard.press('Control+Home')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Control+Shift+ArrowRight') // selects "alpha"
    await page.keyboard.press('Control+D')
    note = await noteOf(page, noteId)
    assert.equal(note!.selections.length, 2, 'Ctrl+D selected the next "alpha"')
    await oneCursor(page, noteId)
    // Undo back to the text before " alpha" (the typing may sit in more than one undo stop).
    for (let i = 0; i < 6 && (await noteOf(page, noteId))!.text !== '> alpha one\r\n> beta two\r\n> gamma three'; i++) { await page.keyboard.press('Control+Z'); await sleep(120) }
    await waitSaved(page, noteId, '> alpha one\r\n> beta two\r\n> gamma three')

    // 3. The palette from inside the editor: the app's, with the editor's actions in it.
    await page.keyboard.press('Control+Shift+P')
    await page.waitForFunction(() => window.__tether.palette().open)
    await page.keyboard.type('select all occur')
    await page.waitForFunction(() => window.__tether.palette().shown[0] === 'editor.action.select-highlights')
    assert.equal(await page.locator('#palette-list .pal-item[data-command="editor.action.select-highlights"] kbd').innerText(), 'Ctrl+Shift+L', 'the chord Monaco binds, in the app\'s hint style')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !window.__tether.palette().open)
    assert.ok(await focusInEditor(page), 'focus back in the editor')
    const cmds = await page.evaluate(() => window.__tether.commands())
    assert.ok(cmds.find(c => c.id === 'note.save-as')?.available, 'Salvar como… is available with the note focused')
    assert.equal(cmds.find(c => c.id === 'editor.tether.toggle-word-wrap')?.hint, 'Alt+Z', 'the Alt+Z toggle is registered with a stable id and its chord')
    // The wrap is a global preference: Alt+Z flips it for every editor and settings.json keeps it (checked after the relaunch).
    assert.deepEqual(await page.evaluate(() => window.__tether.wordWrap()), { setting: true, editors: ['on'] }, 'wrap defaults to on')
    await page.keyboard.press('Alt+z')
    await page.waitForFunction(() => { const w = window.__tether.wordWrap(); return !w.setting && w.editors.every(o => o === 'off') })
    // The preference is the note extension's (F9 slice 1): settings.json `extensions.note.wordWrap`.
    for (let i = 0; i < 50 && JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')).extensions?.note?.wordWrap !== false; i++) await sleep(100)
    assert.equal(JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')).extensions?.note?.wordWrap, false, 'settings.json extensions.note.wordWrap')

    // 5. Changed outside while clean: reloads, cursor kept.
    await page.keyboard.press('Control+Home')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    writeFileSync(note!.path, '> alpha one\r\n> beta two (fora)\r\n> gamma three')
    await page.waitForFunction(id => window.__tether.note(id)?.text === '> alpha one\r\n> beta two (fora)\r\n> gamma three', noteId)
    note = await noteOf(page, noteId)
    assert.deepEqual(note!.cursor, { lineNumber: 2, column: 3 }, 'cursor where it was')
    assert.equal(note!.dirty, false)

    // 6. Rename through the tab; move to the drawer and back.
    await page.locator('.tether-tab.note').dblclick()
    const rename = page.locator('.tether-tab.note input.rename')
    await rename.waitFor()
    await rename.fill('ideias')
    await rename.press('Enter')
    await page.waitForFunction(id => /ideias\.md$/.test(window.__tether.note(id)?.path ?? ''), noteId)
    assert.ok(existsSync(join(notesDir, 'ideias.md')) && readdirSync(notesDir).length === 1, 'the file was renamed')
    assert.equal(await page.locator('.tether-tab.note .text').innerText(), 'ideias.md')
    assert.deepEqual(await page.evaluate(() => window.__tether.wordWrap()), { setting: false, editors: ['off'] }, 'wrap stays off after the relaunch')
    await page.evaluate(id => window.__tether.movePaneToDrawer(id), noteId)
    await page.waitForFunction(id => window.__tether.inDrawer(id), noteId)
    await page.waitForFunction(id => window.__tether.note(id)?.text === '> alpha one\r\n> beta two (fora)\r\n> gamma three', noteId)
    await page.evaluate(id => window.__tether.movePaneFromDrawer(id), noteId)
    await page.waitForFunction(id => !window.__tether.inDrawer(id), noteId)
    await page.waitForFunction(id => window.__tether.note(id)?.text === '> alpha one\r\n> beta two (fora)\r\n> gamma three', noteId)
    assert.equal((await noteOf(page, noteId))!.path, join(notesDir, 'ideias.md'))

    // 7. A cursor, a selection and a scroll to remember; then the app is killed.
    await page.locator(`.note-panel[data-note-id="${noteId}"] .monaco-editor`).click()
    await page.waitForFunction(id => window.__tether.note(id)?.focused === true, noteId)
    await page.keyboard.press('Control+End')
    for (let i = 0; i < 60; i++) { await page.keyboard.press('Enter') }
    await page.keyboard.type('fim da nota')
    await page.keyboard.press('Shift+Home')
    await waitSaved(page, noteId, '> alpha one\r\n> beta two (fora)\r\n> gamma three' + '\r\n'.repeat(60) + 'fim da nota')
    await sleep(900) // the view state (250 ms throttle) and the layout (300 ms debounce) land
    note = await noteOf(page, noteId)
    assert.deepEqual(note!.selections.map(s => [s.startLineNumber, s.startColumn, s.endLineNumber, s.endColumn]), [[63, 1, 63, 12]], 'the last line selected (Shift+Home)')
    assert.deepEqual(note!.cursor, { lineNumber: 63, column: 1 }, 'the cursor at the selection\'s start (the direction is kept in the view state)')
    assert.ok(note!.scrollTop > 0, `scrolled (${note!.scrollTop})`)
    const before = { viewport: note!.viewport, cursor: note!.cursor, selections: note!.selections, scrollTop: note!.scrollTop, text: note!.text, path: note!.path, frame: await page.evaluate(id => window.__tether.frameOf(id), noteId) }
    assert.ok(JSON.stringify(await page.evaluate(() => window.__tether.layout())).includes('"cursorState"'), 'the layout carries the view state')
    await page.evaluate(() => window.__tether.runCommand('theme.dark'))
    await sleep(400)
    await shot(app, 'note-dark')
    await killElectron(app, root)
    app = undefined
    ;({ app, page } = await launch(home))
    await page.waitForFunction(() => window.__tether.notes().length === 1)
    await page.waitForFunction(id => window.__tether.note(id)?.text.length! > 0, noteId)
    // The window is resized to the same size as before right after it connects; the editor lays out, and the saved view settles on it.
    await page.waitForFunction(([id, h]) => window.__tether.note(id!)?.viewport.height === h, [noteId, before.viewport.height] as const)
    await page.waitForFunction(([id, top]) => window.__tether.note(id!)?.scrollTop === top, [noteId, before.scrollTop] as const, { timeout: 5000 }).catch(() => {})
    const after = (await noteOf(page, noteId))!
    assert.equal(after.path, before.path)
    assert.equal(after.text, before.text)
    assert.deepEqual(after.cursor, before.cursor)
    assert.deepEqual(after.selections, before.selections)
    assert.equal(after.scrollTop, before.scrollTop, `same scroll (viewport before ${JSON.stringify(before.viewport)}, after ${JSON.stringify(after.viewport)})`)
    assert.equal(await page.evaluate(id => window.__tether.frameOf(id), noteId), before.frame, 'same frame')
    assert.equal(await page.evaluate(id => window.__tether.frameOf(id), shell!), before.frame, 'next to the same pane')
    assert.equal(await page.locator('.tether-tab.note .text').innerText(), 'ideias.md')

    // 8. Light screenshot.
    await page.evaluate(() => window.__tether.runCommand('theme.light'))
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
    await page.evaluate(id => window.__tether.activate(id), noteId)
    await sleep(400)
    await shot(app, 'note-light')
  } finally {
    if (app) await killElectron(app, root).catch(e => console.error(String(e)))
    for (const d of daemons) {
      const r = await killOwned(d, { tree: true })
      if (r === 'not-ours') console.error(`tetherd cleanup: pid ${d.pid} is no longer ours; not killed`)
    }
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && daemons.some(d => pidAlive(d.pid))) await sleep(200)
    for (const dir of [home, repo]) {
      for (let i = 0; i < 5; i++) {
        try { rmSync(dir, { recursive: true, force: true }); break } catch { await sleep(300) }
      }
    }
  }
})
