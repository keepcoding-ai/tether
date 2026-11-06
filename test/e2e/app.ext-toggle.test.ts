// E2E of F9 slice 1 (the note as an extension) against the real tetherd on a private home/pipe, hidden window:
//   1. a note opened and saved in the layout; "Extensões": the switch turns the note off for the next start (settings.json
//      `extensions.disabled`), the row and the screen say "Reiniciar o app";
//   2. after the restart the app works: the note's pane stands in its place as "extensão desligada" (its id and params
//      untouched in the layout, also after a change the person makes is saved), the note's commands, ≡ items and test
//      hooks are gone; the placeholder's "Abrir Extensões" leads to the switch, which turns the note back on;
//   3. after the next restart the note is back, with its file.
// Every kill goes through test/kill.ts (pid + creation time).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type SavedPanel = { id: string; contentComponent: string; tabComponent: string; params?: Record<string, unknown> }
type Hooks = {
  connection(): { connected: boolean; pid?: number } | undefined
  layout(): { desks: { frames: { views: Record<string, { panels: Record<string, SavedPanel> }> } }[] }
  runCommand(id: string): Promise<string>
  commands(): { id: string }[]
  ext: Record<string, Record<string, unknown>>
  notes?: () => { id: string; path: string; text: string }[]
  openNote?: (path: string) => Promise<void>
}
declare const window: { __tether: Hooks }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const pipe = `\\\\.\\pipe\\tether-ext-toggle-${process.pid}`
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
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  return { app, page }
}

/** Every pane of the saved layout.json (all desks). */
function savedPanes(home: string): SavedPanel[] {
  try {
    const file = JSON.parse(readFileSync(join(home, 'layout.json'), 'utf8')) as ReturnType<Hooks['layout']>
    return file.desks.flatMap(d => Object.values(d.frames.views).flatMap(v => Object.values(v.panels)))
  } catch { return [] }
}
const settings = (home: string): Record<string, unknown> => JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')) as Record<string, unknown>
const disabled = (home: string): unknown => (settings(home).extensions as { disabled?: unknown } | undefined)?.disabled

async function waitFor(what: string, check: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { if (check()) return; await sleep(100) }
  assert.fail(`timed out: ${what}`)
}

test('app note extension (F9 slice 1): off → restart → placeholder keeps the pane; on → restart → the note is back', async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  const home = mkdtempSync(join(tmpdir(), 'tether-ext-toggle-'))
  const notePath = join(home, 'ideia.md')
  writeFileSync(notePath, '# Ideia\r\n\r\numa linha')
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    // ---------- 1. a note in the layout; the switch turns the extension off ----------
    let page: Page
    ;({ app, page } = await launch(home))
    const daemonPid = (await page.evaluate(() => window.__tether.connection()))?.pid
    assert.ok(daemonPid && pidAlive(daemonPid), 'the app spawned a tetherd')
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))
    await page.evaluate(p => window.__tether.openNote!(p), notePath)
    await page.waitForFunction(() => (window.__tether.notes?.() ?? []).some(n => n.text.includes('uma linha')))
    assert.ok(await page.evaluate(() => 'note' in window.__tether.ext && typeof window.__tether.ext.note!.notes === 'function'), 'hooks under window.__tether.ext.note')
    await waitFor('the note saved in layout.json', () => savedPanes(home).some(p => p.contentComponent === 'note'))
    const saved = savedPanes(home).find(p => p.contentComponent === 'note')!
    assert.match(saved.id, /^note:/)

    await page.evaluate(() => window.__tether.runCommand('extensions.show'))
    const row = page.locator('.ext-pane .ext-row[data-ext="note"]')
    await row.waitFor()
    assert.equal(await row.getAttribute('data-state'), 'enabled')
    assert.ok(await page.locator('.ext-pane .ext-restart').isHidden(), 'nothing pending yet')
    await row.locator('.ext-toggle').click()
    await page.waitForSelector('.ext-pane .ext-row[data-ext="note"] .ext-toggle[aria-checked="false"]')
    assert.match(await row.locator('.ext-pending').innerText(), /Reiniciar o app/)
    assert.ok(await page.locator('.ext-pane .ext-restart').isVisible(), 'the screen offers the restart')
    assert.equal(await row.getAttribute('data-state'), 'enabled', 'still running until the restart')
    assert.deepEqual(disabled(home), ['note'])
    await killElectron(app, root)
    app = undefined
    // The pane as layout.json holds it when the app goes down (its view state included): the reference from here on.
    const atRestart = savedPanes(home).find(p => p.id === saved.id)!
    assert.ok(atRestart, 'the note pane is in layout.json')

    // ---------- 2. restarted with the note off ----------
    ;({ app, page } = await launch(home))
    // The "Extensões" tab was active when the app went down and comes back active; the note's tab sits beside it.
    const offTab = page.locator(`.tether-tab.ext-off[data-slot="${saved.id}"]`)
    await offTab.waitFor()
    assert.equal(await offTab.locator('.text').innerText(), 'ideia.md', 'the tab keeps the title')
    await offTab.click()
    const placeholder = page.locator(`.ext-off-pane[data-extension-off-id="${saved.id}"]`)
    await placeholder.waitFor()
    assert.match(await placeholder.innerText(), /A extensão Nota está desligada/)
    const live = await page.evaluate(id => window.__tether.layout().desks.flatMap(d => Object.values(d.frames.views).flatMap(v => Object.values(v.panels))).find(p => p.id === id), saved.id)
    assert.deepEqual(live && { c: live.contentComponent, t: live.tabComponent, p: live.params }, { c: atRestart.contentComponent, t: atRestart.tabComponent, p: atRestart.params }, 'component, tab and params untouched')
    const ids = await page.evaluate(() => window.__tether.commands().map(c => c.id))
    assert.ok(!ids.includes('note.new') && !ids.includes('markdown.preview') && !ids.includes('ui.word-wrap'), 'the note commands are gone')
    assert.ok(ids.includes('pane.new') && ids.includes('extensions.show'), 'the core commands are there')
    assert.equal(await page.evaluate(() => typeof window.__tether.notes), 'undefined', 'no note hooks')
    assert.equal(await page.locator('#app-menu li[data-command="note.new"]').count(), 0, 'no note items in ≡')
    // A change the person makes is saved: the note's entry stays as it was.
    await page.evaluate(() => window.__tether.runCommand('desk.new'))
    await waitFor('a second desk saved', () => (JSON.parse(readFileSync(join(home, 'layout.json'), 'utf8')) as { desks: unknown[] }).desks.length === 2)
    assert.deepEqual(savedPanes(home).find(p => p.id === saved.id), atRestart, 'the saved note pane is the same as before')
    await page.evaluate(() => window.__tether.runCommand('desk.previous'))

    // The placeholder leads to the switch.
    await placeholder.locator('.ext-off-open').click()
    const row2 = page.locator('.ext-pane .ext-row[data-ext="note"]')
    await row2.waitFor()
    assert.equal(await row2.getAttribute('data-state'), 'disabled')
    await row2.locator('.ext-toggle').click()
    await page.waitForSelector('.ext-pane .ext-row[data-ext="note"] .ext-toggle[aria-checked="true"]')
    assert.match(await row2.locator('.ext-pending').innerText(), /Liga depois de "Reiniciar o app"/)
    assert.deepEqual(disabled(home), [])
    await killElectron(app, root)
    app = undefined

    // ---------- 3. restarted with the note on: the pane is a note again ----------
    ;({ app, page } = await launch(home))
    await page.waitForFunction(id => (window.__tether.notes?.() ?? []).some(n => n.id === id && n.text.includes('uma linha')), saved.id)
    assert.equal(await page.locator('.ext-off-pane').count(), 0, 'no placeholder left')
    assert.ok((await page.evaluate(() => window.__tether.commands().map(c => c.id))).includes('note.new'))
  } finally {
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

test('app quick-open extension (F9 slice 2): off → the app opens, Ctrl+P does nothing, the box keeps the commands', async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  const home = mkdtempSync(join(tmpdir(), 'tether-ext-toggle-qo-'))
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ extensions: { disabled: ['quick-open'] } }))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    const errors: string[] = []
    page.on('pageerror', e => errors.push(String(e)))
    const daemonPid = (await page.evaluate(() => window.__tether.connection()))?.pid
    assert.ok(daemonPid && pidAlive(daemonPid), 'the app spawned a tetherd')
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))

    const ids = await page.evaluate(() => window.__tether.commands().map(c => c.id))
    assert.ok(!ids.includes('palette.quick-open'), 'the Ir para… command is gone')
    assert.ok(ids.includes('palette.show') && ids.includes('pane.new'), 'the core commands are there')

    // Ctrl+P is nobody's: the box stays closed (a terminal would get the key).
    await page.keyboard.press('Control+P')
    await sleep(500)
    assert.equal(await page.evaluate(() => (window.__tether as unknown as { palette(): { open: boolean } }).palette().open), false, 'Ctrl+P opened nothing')

    // The command box works, and without ">" it only hints at the commands.
    await page.keyboard.press('Control+Shift+P')
    await page.waitForFunction(() => (window.__tether as unknown as { palette(): { open: boolean } }).palette().open)
    await page.locator('#palette-input').fill('')
    assert.match(await page.locator('#palette .pal-empty').innerText(), /Digite > para procurar um comando/)
    assert.doesNotMatch(await page.locator('#palette .pal-empty').innerText(), /arquivos/)
    await page.keyboard.press('Escape')

    // The note still opens a file by path (the core's opening does not depend on the extension).
    const notePath = join(home, 'a.md')
    writeFileSync(notePath, '# a\r\n\r\nlinha')
    await page.evaluate(p => window.__tether.openNote!(p), notePath)
    await page.waitForFunction(() => (window.__tether.notes?.() ?? []).some(n => n.text.includes('linha')))
    assert.deepEqual(errors, [], 'no page errors')
  } finally {
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

test('app keybindings-screen extension (F9 slice 3): on → the screen lists every extension\'s keys; off → Ctrl+K Ctrl+S does nothing, the overrides file still applies, a saved screen is a placeholder', async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  const home = mkdtempSync(join(tmpdir(), 'tether-ext-toggle-kb-'))
  // An override of the person's: Ctrl+Alt+J makes a new desk (core command), honoured with or without the screen.
  writeFileSync(join(home, 'keybindings.json'), JSON.stringify([{ key: 'ctrl+alt+j', command: 'desk.new' }]))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    // ---------- 1. on: Ctrl+K Ctrl+S opens the screen, which lists the commands of every extension ----------
    let page: Page
    ;({ app, page } = await launch(home))
    const daemonPid = (await page.evaluate(() => window.__tether.connection()))?.pid
    assert.ok(daemonPid && pidAlive(daemonPid), 'the app spawned a tetherd')
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))
    await page.locator('body').click()
    await page.keyboard.press('Control+K')
    await page.keyboard.press('Control+S')
    await page.waitForSelector('.kb-pane')
    const commands = await page.evaluate(() => (window.__tether as unknown as { keybindings(): { rows: { command: string }[] }[] }).keybindings()[0]!.rows.map(r => r.command))
    for (const id of ['pane.new', 'note.open', 'palette.quick-open', 'explorer.open-folder', 'keybindings.show']) assert.ok(commands.includes(id), `the screen lists ${id}`)
    await waitFor('the screen saved in layout.json', () => savedPanes(home).some(p => p.contentComponent === 'keybindings'))
    const saved = savedPanes(home).find(p => p.contentComponent === 'keybindings')!
    assert.match(saved.id, /^keybindings:/)
    await killElectron(app, root)
    app = undefined

    // ---------- 2. off ----------
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ extensions: { disabled: ['keybindings-screen'] } }))
    ;({ app, page } = await launch(home))
    const errors: string[] = []
    page.on('pageerror', e => errors.push(String(e)))
    const offTab = page.locator(`.tether-tab.ext-off[data-slot="${saved.id}"]`)
    await offTab.waitFor()
    await offTab.click()
    await page.locator(`.ext-off-pane[data-extension-off-id="${saved.id}"]`).waitFor()
    const ids = await page.evaluate(() => window.__tether.commands().map(c => c.id))
    assert.ok(!ids.includes('keybindings.show') && !ids.includes('keybindings.record'), 'the screen commands are gone')
    assert.ok(ids.includes('pane.new') && ids.includes('desk.new'), 'the core commands are there')
    assert.equal(await page.locator('#app-menu li[data-command="keybindings.show"]').count(), 0, 'no item in ≡')
    const panesBefore = savedPanes(home).length
    await page.keyboard.press('Control+K')
    await page.keyboard.press('Control+S')
    await sleep(500)
    assert.equal(await page.locator('.kb-pane').count(), 0, 'Ctrl+K Ctrl+S opened nothing')
    assert.equal(await page.evaluate(() => (window.__tether as unknown as { openKeybindings?: unknown }).openKeybindings), undefined, 'no screen hooks')
    // The person's file is the core's: the override still works.
    const desks = (): Promise<number> => page.evaluate(() => window.__tether.layout().desks.length)
    const before = await desks()
    await page.keyboard.press('Control+Alt+J')
    await page.waitForFunction(n => window.__tether.layout().desks.length === n + 1, before)
    assert.ok(savedPanes(home).length >= panesBefore)
    assert.deepEqual(errors, [], 'no page errors')
  } finally {
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
