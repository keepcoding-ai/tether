// E2E of the folder the chooser of a panel pad suggests (the target panel's folder) and of the folder field's bidi bug
// (\:D instead of D:\): real tetherd on a private home/pipe, hidden window, CLAUDE* stripped.
//   1. a shell in folder X in focus: the pad's chooser (after "Abrir algo aqui") suggests X;
//   2. a shell in X/.tether/notes: the suggestion is cut where .tether starts (X);
//   3. the person edits the folder: what they typed is what applies;
//   4. the field shows "D:\" in reading order (no direction: rtl), with a long folder its end is in view.
// Screenshots in <repo>/../../.tmp/panel-cwd.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type Empty = { id: string; blank: boolean; origin: string; effectiveFolder: string; folder: string; touched: boolean }
type LayoutJSON = { sidebars?: { pads: Record<string, unknown>; right: { open?: string } } }
type Hooks = {
  slots(): SlotState[]
  connection(): { connected: boolean; pid?: number } | undefined
  layout(): LayoutJSON
  openSlot(id: string): void
  sidebars(): { right: { strip: string[]; open?: string }; views: { pad: string; panel?: string; desk?: string; shown: boolean }[] } | undefined
  padFrames(): { pad: string; desk?: string; panes: string[]; shown: boolean }[]
  openSlotInPad(slotId: string, padId: string): void
  togglePad(id: string): void
  focusablePanel(): string | undefined
  activatePanel(id: string): void
  empties(): Empty[]
  runCommand(id: string): Promise<string>
  activeDesk(): string
  desks(): { id: string; name: string; panes: string[] }[]
}
declare const window: { __tether: Hooks; tether: { request(body: unknown): Promise<{ t: string; slot?: SlotState }> } }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-panelcwd-${process.pid}`
const atriumTmp = resolve(root, '..', '..', '.tmp')
const tmpBase = existsSync(atriumTmp) ? atriumTmp : tmpdir()
const shots = join(tmpBase, 'panel-cwd')
const electronPath = require('electron') as string

const PANEL = 'frame-pads.panel'
const SEP = String.fromCharCode(92) // a backslash
const DRIVE_ROOT = `D:${SEP}`
const DESK = 'frame-pads.desk'
const GLOBAL = 'frame-pads.global'

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const pidAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' } }
const norm = (p: string): string => p.split(String.fromCharCode(92)).join('/').replace(/\/+$/, '').toLowerCase()
const same = (a: string, b: string): boolean => norm(a) === norm(b)

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
  return { app, page }
}

async function shellIn(page: Page, cwd: string): Promise<string> {
  const reply = await page.evaluate(cwd => window.tether.request({ t: 'create', kind: 'shell', cwd, start: true }), cwd)
  assert.equal(reply.t, 'ok')
  const id = reply.slot!.slotId
  await page.waitForFunction(id => typeof window.__tether.slots().find(s => s.slotId === id)?.pid === 'number', id, { timeout: 20_000 })
  await page.evaluate(id => window.__tether.openSlot(id), id)
  await page.waitForFunction(id => window.__tether.focusablePanel() === id, id)
  return id
}

const shown = (pad: string): string => `#pads .pad.shown[data-pad="${pad}"]`

/** The pad's pane in the chooser state, from the panel pad of the panel in focus. */
async function openChooserInPad(page: Page, panel: string): Promise<Empty> {
  await page.waitForSelector(`${shown(PANEL)}[data-panel="${panel}"] .empty-panel[data-blank="true"] .blank-action`)
  await page.click(`${shown(PANEL)}[data-panel="${panel}"] .blank-action`)
  await page.waitForSelector(`${shown(PANEL)}[data-panel="${panel}"] .empty-panel[data-blank="false"] .ch`)
  const id = (await page.evaluate(() => window.__tether.padFrames())).find(p => p.pad === PANEL && p.shown)!.panes[0]!
  return (await page.evaluate(() => window.__tether.empties())).find(e => e.id === id)!
}

test('panel pad chooser: the target panel folder is the suggestion; the folder field reads the drive root in order', { timeout: 300_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(shots, { recursive: true })
  const home = mkdtempSync(join(tmpBase, 'tether-panelcwd-'))
  const proj = join(home, 'proj-a')
  const nested = join(home, 'proj-b', '.tether', 'notes')
  mkdirSync(proj, { recursive: true })
  mkdirSync(nested, { recursive: true })
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ extensions: { disabled: ['explorer'] } }))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    daemons.push(await claim((await page.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    await page.click(`.sb-icon[data-pad="${PANEL}"]`)

    // ---- 1. a shell in X: the pad's chooser suggests X (before the current and the recent folders) ----
    const a = await shellIn(page, proj)
    const ea = await openChooserInPad(page, a)
    assert.ok(same(ea.effectiveFolder, proj), `suggested ${ea.effectiveFolder}, wanted ${proj}`)
    assert.ok(same(await page.locator(`${shown(PANEL)} .ch-path-input`).inputValue(), proj), 'and the field shows it')
    await page.screenshot({ path: join(shots, '1-panel-folder-suggested.png') })

    // ---- 2. a shell inside .tether: cut where .tether starts ----
    const b = await shellIn(page, nested)
    const eb = await openChooserInPad(page, b)
    assert.ok(same(eb.effectiveFolder, join(home, 'proj-b')), `cut at .tether: ${eb.effectiveFolder}`)
    await page.screenshot({ path: join(shots, '2-tether-cut.png') })

    // ---- 3. the person's own folder wins ----
    const input = page.locator(`${shown(PANEL)} .ch-path-input`)
    await input.fill(proj)
    const typed = (await page.evaluate(() => window.__tether.empties())).find(e => e.id === eb.id)!
    assert.ok(typed.touched && same(typed.effectiveFolder, proj), 'what was typed applies')

    // ---- 4. the bug: "D:\" never reads "\:D" ----
    await input.fill(DRIVE_ROOT)
    await page.locator(`${shown(PANEL)} .ch-q`).first().focus()
    await sleep(300)
    const dir = await input.evaluate(el => getComputedStyle(el).direction)
    assert.equal(dir, 'ltr', 'the field is laid out in reading order (rtl moved the trailing "\:" to the left)')
    await page.screenshot({ path: join(shots, '4a-root-folder.png') })
    // A long folder, unfocused: its end is in view.
    const long = DRIVE_ROOT + Array.from({ length: 12 }, (_, i) => `pasta-bem-comprida-${i}`).join(SEP)
    await input.fill(long)
    await page.locator(`${shown(PANEL)} .ch-q`).first().focus()
    await sleep(300)
    const tail = await input.evaluate(el => { const i = el as HTMLInputElement; return { end: Math.abs(i.scrollWidth - i.clientWidth - i.scrollLeft), overflow: i.scrollWidth > i.clientWidth } })
    assert.ok(tail.overflow && tail.end <= 2, 'the end of a long folder is in view')
    await page.screenshot({ path: join(shots, '4b-long-folder-tail.png') })
  } finally {
    if (app) await killElectron(app, root).catch(() => {})
    for (const p of daemons) await killOwned(p, { tree: true })
    for (let i = 0; i < 20 && daemons.some(p => pidAlive(p.pid)); i++) await sleep(500)
    for (let i = 0; i < 5; i++) { try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(300) } }
  }
})
