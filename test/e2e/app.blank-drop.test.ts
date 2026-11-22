// E2E of the blank frame ("Vazio") giving way to a tab dropped on it (hidden window, private home/pipe, real tetherd,
// CLAUDE* stripped). A frame holding only the blank view takes what arrives in its place, never as a second tab:
//   1. a shell dropped on the blank's content area ("Nada aberto aqui ainda") replaces it;
//   2. another shell dropped on the tab bar of a new blank frame replaces it too.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type Empty = { id: string; blank: boolean }
type Hooks = {
  panelIds(): string[]
  frameOf(slotId: string): string | undefined
  activeId(): string | undefined
  empties(): Empty[]
  runCommand(id: string): Promise<string>
  connection(): { connected: boolean; pid?: number } | undefined
}
declare const window: { __tether: Hooks }
declare const document: { querySelector(selector: string): { getBoundingClientRect(): { x: number; y: number; width: number; height: number } } | null }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-blank-drop-${process.pid}`

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const pidAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' } }

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
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  return { app, page }
}

async function createShell(page: Page, cwd: string): Promise<string> {
  const before = await page.evaluate(() => window.__tether.panelIds())
  await page.click('#btn-new')
  await page.waitForSelector('#dlg-new[open]')
  await page.fill('#dlg-new .ch-path-input', cwd)
  await page.click('#dlg-new .ch-item[data-id="powershell"]')
  await page.click('#dlg-new .btn.primary.go')
  await page.locator('#dlg-new[open]').waitFor({ state: 'hidden' })
  await page.waitForFunction(n => window.__tether.panelIds().length === n, before.length + 1)
  return (await page.evaluate(() => window.__tether.panelIds())).find(id => !before.includes(id))!
}

type Pt = { x: number; y: number }
const tab = (id: string): string => `.tether-tab[data-slot="${id}"]`
const BLANK_GROUP = '.dv-groupview:has(.empty-panel[data-blank="true"])'

async function point(page: Page, selector: string, fx = 0.5, fy = 0.5): Promise<Pt> {
  const r = await page.evaluate(sel => { const b = document.querySelector(sel)?.getBoundingClientRect(); return b ? { x: b.x, y: b.y, width: b.width, height: b.height } : undefined }, selector)
  assert.ok(r, `nothing at ${selector}`)
  return { x: r.x + r.width * fx, y: r.y + r.height * fy }
}

async function drag(page: Page, from: Pt, to: Pt): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + 8, from.y + 8, { steps: 3 })
  await page.mouse.move(to.x, to.y, { steps: 15 })
  await sleep(120)
  await page.mouse.up()
  await sleep(300) // the move runs once the drag is over
}

test('a tab dropped on a blank frame replaces it: on its content and on its tab bar', { timeout: 300_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  const home = mkdtempSync(join(tmpdir(), 'tether-blank-drop-'))
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ extensions: { disabled: ['browser'] } }))
  const work = mkdtempSync(join(tmpdir(), 'tether-blank-drop-work-'))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    daemons.push(await claim((await page.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))

    const a = await createShell(page, work)
    const c = await createShell(page, work)
    const base = await page.evaluate(() => window.__tether.empties().filter(e => e.blank).length)

    // ---- 1. a onto the blank's content area ----
    assert.equal(await page.evaluate(() => window.__tether.runCommand('frame.new-empty.right')), 'ran')
    await page.waitForFunction(n => window.__tether.empties().filter(e => e.blank).length === n + 1, base)
    await page.waitForSelector(`${BLANK_GROUP} .blank-message`)
    await drag(page, await point(page, tab(a)), await point(page, `${BLANK_GROUP} .blank-message`))
    await page.waitForFunction(a => window.__tether.frameOf(a) === 'frame-2', a)
    await page.waitForFunction(n => window.__tether.empties().filter(e => e.blank).length === n, base)
    assert.equal(await page.evaluate(() => window.__tether.activeId()), a, 'the arrived tab is active')
    assert.equal(await page.locator(`.dv-groupview:has(${tab(a)}) .tether-tab`).count(), 1, 'a is alone in its group: no Vazio tab')

    // ---- 2. c onto the tab bar of another blank frame ----
    assert.equal(await page.evaluate(() => window.__tether.runCommand('frame.new-empty.right')), 'ran')
    await page.waitForFunction(n => window.__tether.empties().filter(e => e.blank).length === n + 1, base)
    await page.waitForSelector(BLANK_GROUP)
    await drag(page, await point(page, tab(c)), await point(page, `${BLANK_GROUP} .dv-tabs-and-actions-container`, 0.5, 0.5))
    await page.waitForFunction(c => window.__tether.frameOf(c) !== 'frame-1', c)
    await page.waitForFunction(n => window.__tether.empties().filter(e => e.blank).length === n, base)
    assert.equal(await page.locator(`.dv-groupview:has(${tab(c)}) .tether-tab`).count(), 1, 'c is alone in its group: no Vazio tab')
    assert.equal(await page.evaluate(() => window.__tether.activeId()), c, 'the arrived tab is active')
  } finally {
    if (app) await killElectron(app, root).catch(() => {})
    for (const d of daemons) await killOwned(d, { tree: true })
    for (let i = 0; i < 20 && daemons.some(d => pidAlive(d.pid)); i++) await sleep(500)
    for (const dir of [home, work]) for (let i = 0; i < 5; i++) { try { rmSync(dir, { recursive: true, force: true }); break } catch { await sleep(300) } }
  }
})
