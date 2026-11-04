// E2E of the command palette (F5, delivery 0): against the real tetherd on a private home/pipe, hidden window,
// a PowerShell pane in focus.
//   1. Ctrl+Shift+P from inside the terminal opens the box with ">" typed, every available command listed by
//      title, the key hint next to the ones that have a chord;
//   2. "nvmesa" (letters apart) ranks "Nova mesa" first with the matched letters highlighted; Enter runs it
//      (a second desk exists) and closes the box; the focus goes back to the terminal;
//   3. reopened, "Nova mesa" comes first with the "recente" tag; Esc closes;
//   4. Ctrl+P opens the quick-open mode (empty field, the hint about files); typing ">" turns it into the command
//      mode; "tema escuro" + Enter switches the theme;
//   5. commands that need a pane are greyed in the ≡ menu (whose hints come from the registry) when no pane is active;
//   6. a plain Ctrl+letter still reaches the terminal (Ctrl+C with no selection cancels the line in PSReadLine);
//   7. window.__tether.runCommand runs by id (the CLI's future path) and refuses an unknown id;
//   8. screenshots palette-{light,dark}.png.
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

type Hooks = {
  panelIds(): string[]
  activate(id: string): void
  activeId(): string | undefined
  text(id: string): string
  connection(): { connected: boolean; pid?: number } | undefined
  desks(): { id: string; name: string }[]
  deskOf(slotId: string): string | undefined
  switchDesk(id: string): void
  commands(): { id: string; title: string; hint: string; available: boolean }[]
  runCommand(id: string): Promise<'ran' | 'unknown' | 'unavailable'>
  palette(): { open: boolean; mode?: 'commands' | 'quick-open'; shown: string[]; input: string }
  theme(): { setting: string; scheme: string }
  closePanel(id: string): void
}
declare const window: { __tether: Hooks }
declare const document: { activeElement: { closest(sel: string): unknown } | null; documentElement: { dataset: Record<string, string> }; querySelectorAll(sel: string): { length: number } }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const artifacts = join(root, 'test', 'e2e', 'artifacts')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const pipe = `\\\\.\\pipe\\tether-palette-${process.pid}`
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
  await page.keyboard.press('Control+Shift+T')
  await page.waitForSelector('#dlg-new[open]')
  await page.check('input[name=profile][value=powershell]')
  await page.fill('#new-cwd', cwd)
  await page.click('#btn-create')
  await page.waitForFunction(n => document.querySelectorAll('.tether-tab').length === n, before + 1)
}

async function focusPane(page: Page, id: string): Promise<void> {
  await page.evaluate(id => { const d = window.__tether.deskOf(id); if (d) window.__tether.switchDesk(d); window.__tether.activate(id) }, id)
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

const paletteState = (page: Page) => page.evaluate(() => window.__tether.palette())
const paletteOpen = (page: Page, open: boolean) => page.waitForFunction(o => window.__tether.palette().open === o, open)
const focusInTerminal = (page: Page) => page.evaluate(() => !!document.activeElement?.closest('.xterm'))

test('app palette: Ctrl+Shift+P / Ctrl+P, fuzzy search, Enter runs, recents, the ≡ menu reads the registry, Ctrl+letter stays the terminal\'s', async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(artifacts, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-palette-'))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    const daemonPid = (await page.evaluate(() => window.__tether.connection()))?.pid
    assert.ok(daemonPid && pidAlive(daemonPid), 'the app spawned a tetherd')
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))

    await createShell(page, root)
    const [shell] = await page.evaluate(() => window.__tether.panelIds())
    await focusPane(page, shell!)
    assert.ok(await focusInTerminal(page), 'the terminal has the focus')

    // 1. Ctrl+Shift+P from inside the terminal: ">" typed, every available command, hints next to the chords.
    await page.keyboard.press('Control+Shift+P')
    await paletteOpen(page, true)
    let st = await paletteState(page)
    assert.equal(st.mode, 'commands')
    assert.equal(st.input, '>')
    const all = await page.evaluate(() => window.__tether.commands())
    const available = all.filter(c => c.available).map(c => c.id)
    assert.deepEqual([...st.shown].sort(), [...available].sort(), 'every available command (no recents yet)')
    const titles = all.filter(c => st.shown.includes(c.id)).sort((a, b) => st.shown.indexOf(a.id) - st.shown.indexOf(b.id)).map(c => c.title)
    assert.deepEqual(titles, [...titles].sort((a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' })), 'by title')
    assert.ok(available.includes('pane.close') && available.includes('desk.new') && !available.includes('desk.close'), `availability with one pane and one desk: ${available.join(' ')}`)
    assert.equal(await page.locator('#palette-list .pal-item[data-command="pane.new"] kbd').innerText(), 'Ctrl+Shift+T')
    assert.equal(await page.locator('#palette-list .pal-item[data-command="drawer.toggle"] kbd').innerText(), 'Ctrl+`')
    assert.equal(await page.locator('#palette-list .pal-item[data-command="pane.rename"] kbd').count(), 0, 'no hint without a chord')
    assert.equal(await page.locator('#palette-list .pal-item.selected').getAttribute('data-command'), st.shown[0], 'the first row is selected')

    // 2. Letters apart: "nvmesa" → "Nova mesa" first, highlighted; Enter runs it and closes the box.
    await page.keyboard.type('nvmesa')
    await page.waitForFunction(() => window.__tether.palette().shown[0] === 'desk.new')
    st = await paletteState(page)
    assert.ok(!st.shown.includes('pane.close'), 'what does not match is out')
    const marks = await page.locator('#palette-list .pal-item[data-command="desk.new"] .pal-title b').allInnerTexts()
    assert.deepEqual(marks.join(''), 'Nvmesa', `highlighted letters: ${JSON.stringify(marks)}`)
    const desksBefore = (await page.evaluate(() => window.__tether.desks())).length
    await page.keyboard.press('Enter')
    await paletteOpen(page, false)
    await page.waitForFunction(n => window.__tether.desks().length === n, desksBefore + 1)

    // 3. Back on the pane (the new desk is empty): reopened, the command just used comes first, tagged; Esc closes
    //    and the terminal has the focus again.
    await focusPane(page, shell!)
    await page.keyboard.press('Control+Shift+P')
    await paletteOpen(page, true)
    st = await paletteState(page)
    assert.equal(st.shown[0], 'desk.new', 'recently used first')
    assert.equal(await page.locator('#palette-list .pal-item[data-command="desk.new"] .pal-tag').textContent(), 'recente')
    assert.ok(st.shown.includes('desk.close') && st.shown.includes('desk.go.2'), 'two desks: closing and going to the second are offered now')
    await page.keyboard.press('Escape')
    await paletteOpen(page, false)
    assert.ok(await focusInTerminal(page), 'focus back in the terminal after Esc')

    // 4. Ctrl+P: quick-open mode (empty field, the hint); ">" switches to commands; "tema escuro" + Enter.
    await page.keyboard.press('Control+P')
    await paletteOpen(page, true)
    st = await paletteState(page)
    assert.equal(st.mode, 'quick-open')
    assert.equal(st.input, '')
    assert.deepEqual(st.shown, [])
    assert.match(await page.locator('#palette .pal-empty').innerText(), /Digite > para procurar um comando/)
    await page.keyboard.type('>tema escuro')
    await page.waitForFunction(() => window.__tether.palette().shown[0] === 'theme.dark')
    await page.keyboard.press('Enter')
    await paletteOpen(page, false)
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
    // The palette chord while open switches the mode instead of stacking.
    await page.keyboard.press('Control+P')
    await paletteOpen(page, true)
    await page.keyboard.press('Control+Shift+P')
    await page.waitForFunction(() => window.__tether.palette().mode === 'commands')
    assert.equal((await paletteState(page)).input, '>')
    await sleep(250)
    await shot(app, 'palette-dark')
    // Arrow keys move the selection; the field keeps the focus.
    await page.keyboard.press('ArrowDown')
    assert.equal(await page.locator('#palette-list .pal-item.selected').getAttribute('data-command'), (await paletteState(page)).shown[1])
    await page.keyboard.press('Escape')
    await paletteOpen(page, false)

    // 5. The ≡ menu: hints from the registry; pane items greyed without a pane.
    await page.click('#btn-menu')
    await page.waitForSelector('#app-menu:not([hidden])')
    assert.equal(await page.locator('#app-menu li[data-command="pane.new"] kbd').innerText(), 'Ctrl+Shift+T')
    assert.equal(await page.locator('#app-menu li[data-command="palette.show"] kbd').innerText(), 'Ctrl+Shift+P')
    assert.equal(await page.locator('#app-menu li[data-command="pane.move"]').getAttribute('aria-disabled'), 'false')
    assert.equal(await page.locator('#app-menu li[data-command="desk.close"]').getAttribute('aria-disabled'), 'false', 'two desks now')
    await page.click('#app-menu li[data-command="palette.show"]')
    await paletteOpen(page, true)
    await page.keyboard.press('Escape')
    await paletteOpen(page, false)

    // 6. A plain Ctrl+letter still reaches the terminal: Ctrl+C with nothing selected cancels the typed line.
    await focusPane(page, shell!)
    await page.waitForFunction(id => /PS .*>/.test(window.__tether.text(id)), shell!, { timeout: 30_000 })
    await page.keyboard.type('Write-Host nope-3c9')
    await page.keyboard.press('Control+C')
    await sleep(300)
    await page.keyboard.type('Write-Host ok-7b1')
    await page.keyboard.press('Enter')
    await page.waitForFunction(id => window.__tether.text(id).split('\n').some(l => l.trim() === 'ok-7b1'), shell!)
    const lines = (await page.evaluate(id => window.__tether.text(id), shell!)).split('\n').map(l => l.trim())
    assert.ok(!lines.includes('nope-3c9'), 'the cancelled line never ran (Ctrl+C reached PSReadLine)')
    assert.equal((await paletteState(page)).open, false, 'Ctrl+C opened nothing')

    // 7. Run by id (the CLI's path): a known id runs, an unknown one is refused, an unavailable one too.
    assert.equal(await page.evaluate(() => window.__tether.runCommand('desk.go.9')), 'unavailable')
    assert.equal(await page.evaluate(() => window.__tether.runCommand('nao.existe')), 'unknown')
    assert.equal(await page.evaluate(() => window.__tether.runCommand('theme.light')), 'ran')
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')

    // 8. Light screenshot, with a query typed.
    await focusPane(page, shell!)
    await page.keyboard.press('Control+Shift+P')
    await paletteOpen(page, true)
    await page.keyboard.type('mesa')
    await sleep(250)
    await shot(app, 'palette-light')
    await page.keyboard.press('Escape')
    await paletteOpen(page, false)
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
