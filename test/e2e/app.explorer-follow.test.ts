// E2E of the explorer extension, slice 2 (F8): "seguir" and "revelar". Hidden window on a private home/pipe, real tetherd, no
// real agent: claude slots created with `start: false` are agent panes (kind 'claude', a folder) with no process behind them.
//   1. follow is on by default: focusing the agent pane of B makes B the current project, then A's agent makes A; focusing a
//      plain terminal (in B) or a note (in B) changes nothing;
//   2. the pad's header toggles "Seguir o agente ativo" (pressed) and "Revelar o arquivo ativo" (not pressed); unpressing follow
//      freezes the current project when an agent is focused;
//   3. "Revelar no explorador" (palette command and the note's tab menu) expands the folders down to the note's file and
//      selects it;
//   4. auto-reveal off selects nothing when a note is focused; on, it selects the note's file;
//   5. both settings are in settings.json and survive a relaunch.
// Screenshots (light and dark) go to <atrium>/.tmp/f8: the current project followed.
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

type Row = { root: string; path: string; name: string; level: number; kind: string; expanded: boolean; selected: boolean }
type Snapshot = { mode: 'empty' | 'roots'; roots: { path: string; name: string; current: boolean }[]; rows: Row[] }
type Hooks = {
  connection(): { pid?: number } | undefined
  explorer(): Snapshot | undefined
  sidebars(): { left: { open?: string } } | undefined
  addSlotPane(slotId: string): void
  activate(slotId: string): void
  openNote(path: string): Promise<void>
  notes(): { id: string; path: string }[]
  runCommand(id: string): Promise<string>
}
type El = { textContent: string | null; getAttribute(n: string): string | null }
declare const window: { __tether: Hooks; tether: { request(body: unknown): Promise<{ t: string; slot?: SlotState; message?: string }> } }
declare const document: { documentElement: { dataset: Record<string, string> }; querySelectorAll(s: string): ArrayLike<El> & Iterable<El> }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-appexplorerfollow-${process.pid}`
const atriumTmp = resolve(root, '..', '..', '.tmp')
const tmpBase = existsSync(atriumTmp) ? atriumTmp : tmpdir()
const shots = join(atriumTmp, 'f8')
const PAD = 'explorer.files'
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const pidAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' } }
const sameDir = (a: string, b: string): boolean => a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase()

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
const currentName = async (page: Page): Promise<string> => (await snap(page)).roots.find(r => r.current)?.name ?? ''

async function waitCurrent(page: Page, name: string, what: string): Promise<void> {
  const deadline = Date.now() + 8_000
  let got = ''
  while (Date.now() < deadline) {
    got = await currentName(page)
    if (got === name) return
    await sleep(100)
  }
  assert.equal(got, name, what)
}

/** The current project stays put for a while after the focus moves (a rule that does nothing is proved by waiting). */
async function stays(page: Page, name: string, what: string): Promise<void> {
  await sleep(600)
  assert.equal(await currentName(page), name, what)
}

async function padMenu(page: Page): Promise<{ label: string; checked: string | null }[]> {
  await page.click('.pad.shown .xp-topbar .xp-more')
  await page.waitForSelector('#ctx-menu')
  return page.evaluate(() => [...document.querySelectorAll('#ctx-menu li[role^=menuitem]')].map(li => ({ label: li.textContent ?? '', checked: li.getAttribute('aria-checked') })))
}

/** The two header toggles' `aria-pressed`, in order: [follow, auto-reveal]. */
async function headerToggles(page: Page): Promise<(string | null)[]> {
  return page.evaluate(() => ['Seguir o agente ativo', 'Revelar o arquivo ativo'].map(l =>
    document.querySelectorAll(`.pad.shown .xp-topbar .xp-toggle[aria-label="${l}"]`)[0]?.getAttribute('aria-pressed') ?? null))
}

async function toggleFromHeader(page: Page, label: string): Promise<void> {
  const before = (await headerToggles(page))[label === 'Seguir o agente ativo' ? 0 : 1]
  await page.click(`.pad.shown .xp-topbar .xp-toggle[aria-label="${label}"]`)
  await page.waitForFunction(([l, b]) => document.querySelectorAll(`.pad.shown .xp-topbar .xp-toggle[aria-label="${l}"]`)[0]?.getAttribute('aria-pressed') !== b, [label, before] as const)
}

const settingsOf = (home: string): { follow?: unknown; autoReveal?: unknown } => {
  const file = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')) as { extensions?: Record<string, unknown> }
  return (file.extensions?.explorer ?? {}) as { follow?: unknown; autoReveal?: unknown }
}

async function waitRow(page: Page, path: string, pred: (r: Row) => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    const r = (await snap(page)).rows.find(x => sameDir(x.path, path))
    if (r && pred(r)) return
    await sleep(100)
  }
  assert.fail(what)
}

const noteOpen = (page: Page, path: string): Promise<unknown> =>
  page.waitForFunction(p => window.__tether.notes().some(n => n.path.toLowerCase() === p.toLowerCase()), path)

test('explorer 2: seguir o agente ativo; revelar no explorador; revelar automático; configurações persistem', { timeout: 300_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(shots, { recursive: true })
  const home = mkdtempSync(join(tmpBase, 'tether-follow-'))
  const A = join(home, 'proj', 'alpha')
  const B = join(home, 'proj', 'beta')
  const deep = join(A, 'sub', 'deep')
  for (const d of [deep, B]) mkdirSync(d, { recursive: true })
  const xmd = join(deep, 'x.md')
  const topmd = join(A, 'top.md')
  const bmd = join(B, 'b.md')
  for (const f of [xmd, topmd, bmd]) writeFileSync(f, `# note\n`)
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    daemons.push(await claim((await page.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    const agentA = await create(page, 'claude', A)
    const agentB = await create(page, 'claude', B)
    const shellB = await create(page, 'shell', B)
    for (const id of [agentA, agentB, shellB]) await page.evaluate(id => window.__tether.addSlotPane(id), id)
    await page.click(`#sidebar-left .sb-icon[data-pad="${PAD}"]`)
    await page.waitForFunction(() => window.__tether.explorer()?.roots.length === 2, undefined, { timeout: 10_000 })

    // ---- 1. follow (on by default): an agent moves the current project; a terminal and a note do not ----
    assert.deepEqual(await headerToggles(page), ['true', 'false'], 'header toggles: follow on, auto-reveal off by default')
    assert.deepEqual((await padMenu(page)).slice(-3), [
      { label: 'Revelar no explorador', checked: null },
      { label: 'Atualizar', checked: null },
      { label: 'Recolher tudo', checked: null },
    ], 'the pad menu: the reveal command, then the two actions on the tree (the toggles moved to the header)')
    await page.keyboard.press('Escape')
    await page.evaluate(id => window.__tether.activate(id), agentB)
    await waitCurrent(page, 'beta', 'focusing the agent of B makes B current')
    await page.evaluate(id => window.__tether.activate(id), agentA)
    await waitCurrent(page, 'alpha', 'focusing the agent of A makes A current')
    for (const scheme of ['light', 'dark'] as const) {
      await setTheme(page, scheme)
      await sleep(250)
      await page.screenshot({ path: join(shots, `explorer-follow-${scheme}.png`) })
    }
    await page.evaluate(id => window.__tether.activate(id), shellB)
    await stays(page, 'alpha', 'a plain terminal (in B) changes nothing')
    await page.evaluate(p => window.__tether.openNote(p), bmd)
    await noteOpen(page, bmd)
    await stays(page, 'alpha', 'a note (in B) changes nothing')
    assert.equal((await snap(page)).rows.some(r => r.selected), false, 'auto-reveal is off: opening a note selects nothing')

    // ---- 2. follow off freezes the current project ----
    await toggleFromHeader(page, 'Seguir o agente ativo')
    await page.evaluate(id => window.__tether.activate(id), agentB)
    await stays(page, 'alpha', 'follow off: focusing the agent of B changes nothing')
    await toggleFromHeader(page, 'Seguir o agente ativo') // back on
    await page.evaluate(id => window.__tether.activate(id), agentA)
    await page.evaluate(id => window.__tether.activate(id), agentB)
    await waitCurrent(page, 'beta', 'follow on again')

    // ---- 3. "Revelar no explorador": palette command and the note's tab menu ----
    await page.evaluate(p => window.__tether.openNote(p), xmd)
    await noteOpen(page, xmd)
    assert.equal((await snap(page)).rows.some(r => sameDir(r.path, xmd)), false, 'x.md is not on the tree yet (sub is collapsed)')
    assert.equal(await page.evaluate(() => window.__tether.runCommand('explorer.reveal')), 'ran')
    await waitRow(page, xmd, r => r.selected, 'the command expands to x.md and selects it')
    const s = await snap(page)
    assert.ok(s.rows.find(r => sameDir(r.path, join(A, 'sub')))?.expanded && s.rows.find(r => sameDir(r.path, deep))?.expanded, 'sub and sub/deep are expanded')
    assert.equal(s.roots.find(r => r.current)?.name, 'alpha', "revealing makes the file's project current")
    // the tab menu entry reaches the same command: select another file, then reveal x.md from its tab
    await page.click('.pad.shown .xp-row[data-path$="top.md"]')
    await waitRow(page, topmd, r => r.selected, 'top.md selected by a click')
    await page.locator('.dv-tab:has-text("x.md")').first().click({ button: 'right' })
    await page.click('#ctx-menu li:has-text("Revelar no explorador")')
    await waitRow(page, xmd, r => r.selected, 'the tab menu reveals x.md again')

    // ---- 4. auto-reveal: off selects nothing; on selects the focused note's file ----
    await page.evaluate(p => window.__tether.openNote(p), topmd)
    await noteOpen(page, topmd)
    await sleep(500)
    await waitRow(page, xmd, r => r.selected, 'auto-reveal off: the selection stays where it was')
    await toggleFromHeader(page, 'Revelar o arquivo ativo')
    assert.equal((await headerToggles(page))[1], 'true')
    await page.locator('.dv-tab:has-text("x.md")').first().click()
    await waitRow(page, xmd, r => r.selected, 'auto-reveal on: focusing x.md selects it')
    await page.locator('.dv-tab:has-text("top.md")').first().click()
    await waitRow(page, topmd, r => r.selected, 'auto-reveal on: focusing top.md selects it')

    // ---- 5. the settings are saved and survive a relaunch ----
    await toggleFromHeader(page, 'Seguir o agente ativo') // follow off, auto-reveal on
    const deadline = Date.now() + 8_000
    while (Date.now() < deadline && !(settingsOf(home).follow === false && settingsOf(home).autoReveal === true)) await sleep(100)
    assert.deepEqual([settingsOf(home).follow, settingsOf(home).autoReveal], [false, true], 'both settings are in settings.json')
    await sleep(1_500)
    await killElectron(app, root)
    app = undefined
    await sleep(2_000)
    ;({ app, page } = await launch(home))
    await page.waitForFunction(() => window.__tether.sidebars()?.left.open === 'explorer.files', undefined, { timeout: 15_000 })
    await page.waitForSelector('.pad.shown .xp-topbar .xp-more')
    assert.deepEqual(await headerToggles(page), ['false', 'true'], 'the toggles come back as they were left')
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
