// E2E of the explorer extension, slice 1a (F8): the left pad with the list of project roots. Hidden window on a private
// home/pipe, real tetherd, no real agent: claude slots created with `start: false` give agent panes (kind 'claude', a
// folder) with no process behind them. The native folder picker is replaced in main (ipcMain 'folder:pick').
//   1. the explorer's icon is on the left strip; it opens the pad by the icon and by Ctrl+K E; with no project the pad shows
//      "Nenhum projeto aberto", "Abrir pasta…" and the recent folders (which open as pinned roots);
//   2. "Abrir pasta…" B → one pinned root; again → still one (idempotent, no dialog);
//   3. two agents in folder A → one inferred root "alpha" with "2 agentes" (the tooltip names the panes);
//   4. the pin toggle promotes A (still "2 agentes") and demotes it back; the root menu by state (pinned without agents:
//      Fechar projeto; inferred: the disabled note); "Mover para baixo" reorders; "Fechar projeto" closes B;
//   5. A pinned, its agents gone → still there; a relaunch on the same home brings A back, pinned, with the pad open.
// Screenshots (light and dark) go to <atrium>/.tmp/f8: the empty state and the roots (pinned and inferred).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type Snapshot = { mode: 'empty' | 'roots'; roots: { path: string; name: string; pinned: boolean; hint: string; current: boolean }[]; recent: string[] }
type Hooks = {
  connection(): { pid?: number } | undefined
  explorer(): Snapshot | undefined
  sidebars(): { left: { strip: string[]; open?: string; width: number }; right: { strip: string[]; open?: string; width: number } } | undefined
  addSlotPane(slotId: string): void
  detachPane(slotId: string): void
  panelIds(): string[]
  slots(): SlotState[]
  runCommand(id: string): Promise<string>
}
declare const window: { __tether: Hooks; tether: { request(body: unknown): Promise<{ t: string; slot?: SlotState; message?: string }>; rememberFolder(path: string): Promise<void> } }
type El = { textContent: string | null; title: string; contains(n: unknown): boolean; dispatchEvent(e: unknown): boolean; getAttribute(n: string): string | null }
declare const document: { querySelector(s: string): El | null; querySelectorAll(s: string): ArrayLike<El> & Iterable<El>; activeElement: unknown; documentElement: { dataset: Record<string, string> } }
declare const MouseEvent: new (type: string) => unknown

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-appexplorer-${process.pid}`
const atriumTmp = resolve(root, '..', '..', '.tmp')
const tmpBase = existsSync(atriumTmp) ? atriumTmp : tmpdir()
const shots = join(atriumTmp, 'f8')
const PAD = 'explorer.files'
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const pidAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' } }

async function launch(home: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_') && !/^(CLAUDE|TETHER_|ATRIUM_)/i.test(k)) env[k] = v
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

/** The native picker answers `folder` (main-side stub; the real one is a system dialog). */
async function stubPicker(app: ElectronApplication, folder: string): Promise<void> {
  await app.evaluate(({ ipcMain }, f) => { ipcMain.removeHandler('folder:pick'); ipcMain.handle('folder:pick', () => f) }, folder)
}

async function setTheme(page: Page, scheme: 'light' | 'dark'): Promise<void> {
  await page.click('#btn-theme')
  await page.click(`#theme-menu li[data-theme="${scheme}"]`)
  await page.waitForFunction(s => document.documentElement.dataset.theme === s, scheme)
}

async function create(page: Page, kind: string, cwd: string): Promise<string> {
  const reply = await page.evaluate(body => window.tether.request(body), { t: 'create', kind, cwd, start: false })
  assert.equal(reply.t, 'ok', `create ${kind}: ${reply.message ?? ''}`)
  return reply.slot!.slotId
}

const snap = async (page: Page): Promise<Snapshot> => (await page.evaluate(() => window.__tether.explorer()))!
const rows = async (page: Page): Promise<string[]> => (await snap(page)).roots.map(r => `${r.name}:${r.pinned ? 'pinned' : 'inferred'}${r.hint ? `:${r.hint}` : ''}`)
const sameDir = (a: string, b: string): boolean => a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase()

async function waitRows(page: Page, expected: string[], what: string): Promise<void> {
  const deadline = Date.now() + 8_000
  let got: string[] = []
  while (Date.now() < deadline) {
    got = await rows(page)
    if (got.join('|') === expected.join('|')) return
    await sleep(100)
  }
  assert.deepEqual(got, expected, what)
}

const menuLabels = (page: Page): Promise<string[]> => page.evaluate(() => [...document.querySelectorAll('#ctx-menu li[role=menuitem]')].map(li => li.textContent ?? ''))
const rowSel = (name: string): string => `.xp-root:has(.xp-name:text-is("${name}"))`

test('explorer 1a: the left pad lists the project roots; empty state; open folder; pin; menu; relaunch', { timeout: 300_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(shots, { recursive: true })
  const home = mkdtempSync(join(tmpBase, 'tether-explorer-'))
  const A = join(home, 'proj', 'alpha')
  const B = join(home, 'proj', 'beta')
  const C = join(home, 'proj', 'gamma')
  for (const d of [A, B, C]) mkdirSync(d, { recursive: true })
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    daemons.push(await claim((await page.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))

    // ---- 1. the icon, the pad, the empty state, Ctrl+K E ----
    const bars = (): Promise<NonNullable<Awaited<ReturnType<Hooks['sidebars']>>>> => page.evaluate(() => window.__tether.sidebars()!)
    assert.deepEqual((await bars()).left.strip, [PAD], 'the explorer is the left strip')
    assert.equal((await bars()).left.open, undefined)
    // recent folders to offer in the empty state (the app's "Novo painel" keeps them the same way)
    await page.evaluate(d => window.tether.rememberFolder(d), C)
    await page.click(`#sidebar-left .sb-icon[data-pad="${PAD}"]`)
    assert.equal((await bars()).left.open, PAD, 'the icon opens the pad')
    await page.waitForSelector('.pad[data-pad="explorer.files"].shown .xp-empty')
    assert.equal(await page.textContent('.xp-empty-title'), 'Nenhum projeto aberto')
    assert.equal(await page.textContent('.xp-primary'), 'Abrir pasta…')
    await page.waitForFunction(c => window.__tether.explorer()?.recent.some(r => r.toLowerCase() === c.toLowerCase()), C)
    for (const scheme of ['light', 'dark'] as const) {
      await setTheme(page, scheme)
      await sleep(250)
      await page.screenshot({ path: join(shots, `explorer-empty-${scheme}.png`) })
    }
    await page.click(`#sidebar-left .sb-icon[data-pad="${PAD}"]`)
    assert.equal((await bars()).left.open, undefined, 'the icon closes it')
    await page.locator('#btn-menu').focus()
    await page.keyboard.press('Escape')
    await page.keyboard.press('Control+k')
    await page.keyboard.press('e')
    await page.waitForFunction(() => window.__tether.sidebars()!.left.open === 'explorer.files')
    await page.waitForFunction(() => !!document.querySelector('.pad.shown .xp')?.contains(document.activeElement), undefined, { timeout: 5_000 })
    assert.equal(await page.evaluate(() => window.__tether.runCommand('explorer.focus')), 'ran', 'the command is in the palette')

    // ---- 2. a recent folder opens as a pinned root; "Abrir pasta…" B; again → still one ----
    await page.click('.xp-recent-item')
    await waitRows(page, ['gamma:pinned'], 'the recent folder is pinned')
    await page.click(`.pad.shown .xp-root:has(.xp-name:text-is("gamma")) .xp-pin`)
    await waitRows(page, [], 'unpinned with no agent closes it')
    await page.waitForSelector('.xp-empty')
    await stubPicker(app, B)
    await page.click('.xp-primary')
    await waitRows(page, ['beta:pinned'], 'Abrir pasta… pins the picked folder')
    await page.click('.xp-topbar .xp-open')
    await sleep(300)
    await page.click('.xp-topbar .xp-open')
    await sleep(300)
    assert.deepEqual(await rows(page), ['beta:pinned'], 'opening it again changes nothing')
    assert.equal(await page.evaluate(() => document.querySelector('dialog[open]') !== null), false, 'no dialog')

    // ---- 3. two agents in A → one inferred root ----
    const a1 = await create(page, 'claude', A)
    const a2 = await create(page, 'claude', A)
    for (const id of [a1, a2]) await page.evaluate(id => window.__tether.addSlotPane(id), id)
    await waitRows(page, ['beta:pinned', 'alpha:inferred:2 agentes'], 'A inferred from the two agents')
    // "seguir" (on by default) makes the new agents' project current; settle that before the click moves it to beta
    await page.waitForFunction(() => window.__tether.explorer()?.roots.find(r => r.name === 'alpha')?.current === true)
    await page.hover(`.pad.shown ${rowSel('alpha')} .xp-hint`)
    const tip = await page.evaluate(() => document.querySelector('.xp-hint')?.title ?? '')
    assert.match(tip, /Claude · /, 'the tooltip names the agent panes')
    assert.equal(tip.split('\n').length, 2)
    await page.hover(`.pad.shown ${rowSel('beta')}`)
    for (const scheme of ['light', 'dark'] as const) {
      await setTheme(page, scheme)
      await page.click(`.pad.shown ${rowSel('beta')} .xp-name`) // beta is the current project
      await sleep(250)
      await page.screenshot({ path: join(shots, `explorer-roots-${scheme}.png`) })
    }
    // (the theme menu hands the keyboard back to alpha's agent, which "seguir" follows: click beta once more)
    await page.click(`.pad.shown ${rowSel('beta')} .xp-name`)
    assert.equal((await snap(page)).roots.find(r => r.name === 'beta')!.current, true, 'a click makes the root current')

    // ---- 4. the pin toggle, the menus, move, close ----
    await page.click(`.pad.shown ${rowSel('alpha')} .xp-pin`)
    await waitRows(page, ['beta:pinned', 'alpha:pinned:2 agentes'], 'the pin promotes A, still held by two agents')
    await page.click(`.pad.shown ${rowSel('alpha')} .xp-pin`)
    await waitRows(page, ['beta:pinned', 'alpha:inferred:2 agentes'], 'the toggle demotes it back to inferred')
    await page.click(`.pad.shown ${rowSel('alpha')}`, { button: 'right' })
    assert.deepEqual(await menuLabels(page), ['Fixar', 'Fecha sozinho quando os agentes saírem', 'Novo arquivo…', 'Nova pasta…', 'Novo painel aqui…', 'Mover para cima', 'Copiar caminho', 'Abrir no explorador de arquivos'])
    await page.click('#ctx-menu li:has-text("Fecha sozinho")', { force: true })
    assert.equal(await page.locator('#ctx-menu').count(), 1, 'the disabled note does nothing and leaves the menu')
    await page.keyboard.press('Escape')
    await page.click(`.pad.shown ${rowSel('beta')}`, { button: 'right' })
    assert.deepEqual(await menuLabels(page), ['Desafixar', 'Fechar projeto', 'Novo arquivo…', 'Nova pasta…', 'Novo painel aqui…', 'Mover para baixo', 'Copiar caminho', 'Abrir no explorador de arquivos'])
    await page.click('#ctx-menu li:has-text("Mover para baixo")')
    await waitRows(page, ['alpha:inferred:2 agentes', 'beta:pinned'], 'move down reorders')
    await page.click(`.pad.shown ${rowSel('beta')}`, { button: 'right' })
    await page.click('#ctx-menu li:has-text("Fechar projeto")')
    await waitRows(page, ['alpha:inferred:2 agentes'], 'Fechar projeto closes the pinned root without agents')

    // ---- 5. A pinned, no agent → stays; a relaunch brings it back, pinned, with the pad open ----
    await page.click(`.pad.shown ${rowSel('alpha')} .xp-pin`)
    await waitRows(page, ['alpha:pinned:2 agentes'], 'A pinned')
    for (const id of [a1, a2]) await page.evaluate(id => window.__tether.detachPane(id), id)
    await waitRows(page, ['alpha:pinned'], 'a pinned root stays without agents')
    await sleep(1_500) // layout.json is written soon after the last change
    await killElectron(app, root)
    app = undefined
    await sleep(2_000)
    ;({ app, page } = await launch(home))
    await page.waitForFunction(() => window.__tether.explorer()?.roots.length === 1, undefined, { timeout: 15_000 })
    const after = await snap(page)
    assert.equal(after.mode, 'roots')
    assert.ok(sameDir(after.roots[0]!.path, A) && after.roots[0]!.pinned, 'A is back, pinned')
    assert.equal((await page.evaluate(() => window.__tether.sidebars()!)).left.open, PAD, 'the pad is still open')
  } finally {
    if (app) await killElectron(app, root).catch(() => {})
    for (const d of daemons) await killOwned(d, { tree: true })
    const deadline = Date.now() + 10_000
    while (daemons.some(d => pidAlive(d.pid)) && Date.now() < deadline) await sleep(100)
    for (let i = 0; i < 5; i++) {
      try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
    assert.equal(existsSync(home), false, 'test home removed')
  }
})
