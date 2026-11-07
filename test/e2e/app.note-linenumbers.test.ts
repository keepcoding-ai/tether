// E2E of the note editor's line numbers toggle, against the real tetherd on a private home/pipe, hidden window:
//   1. the line numbers is on by default (the Monaco element is there and has width);
//   2. the ≡ menu's "Números de linha nos editores" flips the general setting for every editor and settings.json keeps it
//      (`extensions.note.lineNumbers`);
//   3. the focused editor's command and the tab menu set a per-editor choice that wins over the general setting,
//      and "usar o padrão" drops it;
//   4. the choices survive the app being killed and relaunched (pane params in layout.json + settings.json).
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

type LnState = { setting: boolean; editors: { id: string; override: boolean | null; enabled: boolean; shown: { option: number; width: number }; visible: boolean }[] }
type Hooks = {
  panelIds(): string[]
  activate(id: string): void
  activeId(): string | undefined
  connection(): { connected: boolean; pid?: number } | undefined
  runCommand(id: string): Promise<'ran' | 'unknown' | 'unavailable'>
  notes(): { id: string }[]
  lineNumbers(): LnState
}
declare const window: { __tether: Hooks }
declare const document: { querySelectorAll(sel: string): { length: number } }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const pipe = `\\\\.\\pipe\\tether-linenumbers-${process.pid}`
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const shots = process.env.TETHER_SHOTS ?? join(root, 'test', 'e2e', 'artifacts')

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

async function launch(home: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_') && !/^(CLAUDE|TETHER_|ATRIUM_)/i.test(k)) env[k] = v
  env.TETHER_PIPE = pipe
  env.TETHER_HOME = home
  env.TETHER_E2E_HIDDEN = '1'
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  page.on('pageerror', e => console.error(`renderer error: ${e.message}`))
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800))
  return { app, page }
}

async function shot(app: ElectronApplication, name: string): Promise<void> {
  const b64 = await app.evaluate(async ({ BrowserWindow }) => {
    const img = await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()
    return img.toPNG().toString('base64')
  })
  mkdirSync(shots, { recursive: true })
  writeFileSync(join(shots, `${name}.png`), Buffer.from(b64, 'base64'))
}

const state = (page: Page) => page.evaluate(() => window.__tether.lineNumbers())
/** Waits for the editors to show exactly `shown` (by note id order), then returns the state. */
async function expectShown(page: Page, shown: boolean[], what: string): Promise<LnState> {
  await page.waitForFunction(want => { const s = window.__tether.lineNumbers(); return s.editors.length === want.length && s.editors.every((e, i) => (e.shown.option !== 0) === want[i] && (!e.visible || (e.shown.width > 0) === want[i])) }, shown, { timeout: 8000 })
    .catch(async () => { throw new Error(`${what}: ${JSON.stringify(await state(page))}`) })
  return state(page)
}
const savedSetting = (home: string): unknown => JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')).extensions?.note?.lineNumbers
async function settingIs(home: string, want: unknown): Promise<void> {
  for (let i = 0; i < 50 && savedSetting(home) !== want; i++) await sleep(100)
  assert.equal(savedSetting(home), want, 'settings.json extensions.note.line-numbers')
}
async function focusEditor(page: Page, id: string): Promise<void> {
  await page.evaluate(id => window.__tether.activate(id), id)
  await page.locator(`.note-panel[data-note-id="${id}"] .monaco-editor .view-lines`).click()
  await page.waitForFunction(id => window.__tether.activeId() === id, id)
}
async function appMenuToggle(page: Page): Promise<void> {
  await page.evaluate(() => (globalThis as unknown as { __tether: { runCommand(id: string): Promise<unknown> } }).__tether.runCommand('ui.line-numbers'))
}
async function tabMenu(page: Page, id: string, label: string): Promise<void> {
  await page.locator(`.tether-tab[data-slot="${id}"]`).click({ button: 'right' })
  await page.locator('li[role^=menuitem]', { hasText: label }).first().click()
}

test('app note: line numbers toggled in general and per editor, remembered across sessions', async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  const home = mkdtempSync(join(tmpdir(), 'tether-linenumbers-'))
  const dir = mkdtempSync(join(tmpdir(), 'tether-linenumbers-dir-'))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    const daemonPid = (await page.evaluate(() => window.__tether.connection()))?.pid
    assert.ok(daemonPid && pidAlive(daemonPid), 'the app spawned a tetherd')
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))

    // A shell pane for the notes to open beside, and two notes with enough lines for the line numbers to draw.
    await page.click('#btn-new')
    await page.waitForSelector('#dlg-new[open]')
    await page.fill('#dlg-new .ch-path-input', dir)
    await page.click('#dlg-new .ch-item[data-id="powershell"]')
    await page.waitForFunction(() => document.querySelectorAll('#dlg-new[open]').length === 0)
    const body = Array.from({ length: 60 }, (_, i) => `# linha ${i + 1} ${'texto '.repeat(6)}`).join('\n')
    for (let n = 1; n <= 2; n++) {
      assert.equal(await page.evaluate(() => window.__tether.runCommand('note.new')), 'ran')
      await page.waitForFunction(n => window.__tether.notes().length === n, n)
      const id = (await page.evaluate(() => window.__tether.notes()))[n - 1]!.id
      await focusEditor(page, id)
      await page.keyboard.insertText(body)
    }
    const [a, b] = (await page.evaluate(() => window.__tether.notes())).map(n => n.id) as [string, string]

    // 1. On by default: both editors show it.
    await sleep(400)
    await shot(app, 'linenumbers-default-on')
    let s = await expectShown(page, [true, true], 'default')
    assert.equal(s.setting, true)
    assert.ok(s.editors.every(e => e.override === null && e.enabled), 'no editor has its own choice')

    // 2. The general setting, from the ≡ menu: both hide; settings.json keeps it; again, both come back.
    await appMenuToggle(page)
    s = await expectShown(page, [false, false], 'general off')
    assert.equal(s.setting, false)
    await settingIs(home, false)
    await shot(app, 'linenumbers-general-off')
    await appMenuToggle(page)
    await expectShown(page, [true, true], 'general on')
    await settingIs(home, true)

    // 3. Per editor: the palette command acts on the focused editor and wins over the general setting.
    await focusEditor(page, a)
    assert.equal(await page.evaluate(() => window.__tether.runCommand('note.line-numbers')), 'ran')
    s = await expectShown(page, [false, true], 'a off by command')
    assert.deepEqual(s.editors.map(e => e.override), [false, null])
    await appMenuToggle(page) // general off: b follows, a keeps its own choice
    await expectShown(page, [false, false], 'general off, a own off')
    await appMenuToggle(page) // general on again: a still has its own choice (off)
    await expectShown(page, [false, true], 'general on, a own off')
    // The tab menu: b gets its own choice (off); a's "usar o padrão" drops it, so a follows the general setting again.
    await tabMenu(page, b, 'Números de linha neste editor')
    s = await expectShown(page, [false, false], 'b off by tab menu')
    assert.deepEqual(s.editors.map(e => e.override), [false, false])
    await tabMenu(page, a, 'Números de linha: usar o padrão')
    s = await expectShown(page, [true, false], 'a back to the default')
    assert.deepEqual(s.editors.map(e => e.override), [null, false])
    // The final shape that must survive the restart: general off, a on by its own choice, b without its own choice (off).
    await appMenuToggle(page)
    await expectShown(page, [false, false], 'general off again')
    await tabMenu(page, a, 'Números de linha neste editor')
    s = await expectShown(page, [true, false], 'a on by its own choice')
    assert.deepEqual(s.editors.map(e => e.override), [true, false])
    await tabMenu(page, b, 'Números de linha: usar o padrão')
    s = await expectShown(page, [true, false], 'b follows the (off) general setting')
    assert.deepEqual(s.editors.map(e => e.override), [true, null])
    await settingIs(home, false)
    await page.evaluate(id => window.__tether.activate(id), a)
    await sleep(400)
    await shot(app, 'linenumbers-per-editor-a-on')
    await page.evaluate(id => window.__tether.activate(id), b)
    await sleep(400)
    await shot(app, 'linenumbers-per-editor-b-off')
    await page.evaluate(id => window.__tether.activate(id), a)
    await sleep(1500) // layout.json is written on a short timer

    // 4. Killed and relaunched: the general setting and each editor's own choice come back.
    await killElectron(app, root)
    app = undefined
    ;({ app, page } = await launch(home))
    await page.waitForFunction(() => window.__tether.notes().length === 2)
    s = await expectShown(page, [true, false], 'after the relaunch')
    assert.equal(s.setting, false)
    assert.deepEqual(s.editors.map(e => e.override), [true, null], 'the per-editor choice survived')
    await page.evaluate(id => window.__tether.activate(id), a)
    await sleep(400)
    await shot(app, 'linenumbers-after-relaunch-a-on')
    assert.ok((await state(page)).editors.find(e => e.id === a)!.shown.width > 0, 'the line numbers element is on screen after the relaunch')
  } finally {
    if (app) await killElectron(app, root).catch(e => console.error(String(e)))
    for (const d of daemons) await killOwned(d, { tree: true })
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && daemons.some(d => pidAlive(d.pid))) await sleep(200)
    for (const d of [home, dir]) {
      for (let i = 0; i < 5; i++) {
        try { rmSync(d, { recursive: true, force: true }); break } catch { await sleep(300) }
      }
    }
  }
})
