// E2E of the Electron app against the fake daemon (app/fake-daemon): create 2 panels, split to 4 by
// shortcut, type and see the echo, kill the window by PID, relaunch → same 4 panels in the same
// arrangement, each re-attached with its scrollback. Screenshots go to test/e2e/artifacts/.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'

// Browser-side globals used inside page.evaluate callbacks (this tsconfig has no DOM lib).
declare const window: {
  __tether: { panelIds(): string[]; activeId(): string | undefined; layout(): unknown; slots(): Array<{ status: string }>; text(id: string): string }
}
declare const document: { querySelectorAll(selector: string): { length: number } }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const artifacts = join(root, 'test', 'e2e', 'artifacts')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const pipe = `\\\\.\\pipe\\tether-apptest-${process.pid}`

type Layout = { grid: { root: Node }; panels: Record<string, unknown>; activeGroup?: string }
type Node = { type: 'leaf' | 'branch'; data: { views: string[] } | Node[] }

/** Arrangement only (views per leaf, nesting), ignoring sizes and group ids. */
function shape(node: Node): unknown {
  return node.type === 'leaf' ? (node.data as { views: string[] }).views : (node.data as Node[]).map(shape)
}

function waitForPipe(tries = 50): Promise<void> {
  return new Promise((res, rej) => {
    const attempt = (n: number): void => {
      const s = connect(pipe)
      s.once('connect', () => { s.destroy(); res() })
      s.once('error', () => { if (n <= 0) rej(new Error('fake daemon did not open the pipe')); else setTimeout(() => attempt(n - 1), 100) })
    }
    attempt(tries)
  })
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise(res => { if (child.exitCode !== null) res(); else child.once('exit', () => res()) })
}

async function launch(home: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_')) env[k] = v
  env.TETHER_PIPE = pipe
  env.TETHER_HOME = home
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10_000)
  await page.waitForSelector('#conn.on', { timeout: 15_000 })
  return { app, page }
}

/**
 * Kills the Electron main process by PID. On Windows the process Playwright spawns is a launcher whose
 * child is the real main process (the one with the window and the pipe connection), so the PID is read
 * from inside Electron; the launcher exits once its child is gone.
 */
async function killElectron(app: ElectronApplication): Promise<void> {
  const mainPid = await app.evaluate(() => process.pid)
  const launcher = app.process()
  process.kill(mainPid)
  if (launcher.pid && launcher.pid !== mainPid) {
    const exited = waitForExit(launcher)
    const timeout = new Promise<void>(res => setTimeout(res, 3000))
    await Promise.race([exited, timeout])
    if (launcher.exitCode === null) process.kill(launcher.pid)
  }
  await waitForExit(launcher)
}

async function createPanel(page: Page, kind: 'claude' | 'soul' | 'shell', cwd: string, shot?: string): Promise<void> {
  const before = await page.locator('.tether-tab').count()
  await page.click('#btn-new')
  await page.waitForSelector('#dlg-new[open]')
  await page.check(`input[name=kind][value=${kind}]`)
  await page.fill('#new-cwd', cwd)
  if (shot) await page.screenshot({ path: join(artifacts, shot) })
  await page.click('#btn-create')
  await page.waitForFunction(n => document.querySelectorAll('.tether-tab').length === n, before + 1)
}

const hooks = {
  ids: (page: Page) => page.evaluate(() => window.__tether.panelIds()),
  active: (page: Page) => page.evaluate(() => window.__tether.activeId()),
  layout: (page: Page) => page.evaluate(() => window.__tether.layout() as unknown as Layout),
  text: (page: Page, id: string) => page.evaluate(id => window.__tether.text(id), id),
}

test('app: 4 panels survive a forced window kill and re-attach with scrollback', async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(artifacts, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-apptest-'))
  const daemon = spawn(process.execPath, [join(root, 'app', 'fake-daemon', 'fake-daemon.ts')], {
    env: { ...process.env, TETHER_PIPE: pipe }, stdio: 'ignore',
  })
  let app: ElectronApplication | undefined
  try {
    await waitForPipe()
    let page: Page
    ;({ app, page } = await launch(home))
    await page.waitForSelector('.watermark')
    await page.screenshot({ path: join(artifacts, 'empty.png') })

    await createPanel(page, 'shell', root, 'new-panel-dialog.png')
    await createPanel(page, 'claude', root)
    assert.equal((await hooks.ids(page)).length, 2)

    // Split by shortcut: right, then below (from the active panel, same kind/folder).
    await page.keyboard.press('Control+Shift+D')
    await page.waitForFunction(() => document.querySelectorAll('.tether-tab').length === 3)
    await page.keyboard.press('Control+Shift+E')
    await page.waitForFunction(() => document.querySelectorAll('.tether-tab').length === 4)
    const ids = await hooks.ids(page)
    assert.equal(ids.length, 4)

    // Type in the active panel and see the fake daemon echo it back.
    const typedId = (await hooks.active(page))!
    assert.ok(typedId)
    await page.locator(`.panel[data-slot-id="${typedId}"] .panel-term`).click()
    await page.keyboard.type('hello tether')
    await page.keyboard.press('Enter')
    await page.waitForFunction(id => window.__tether.text(id).includes('echo: hello tether'), typedId, { timeout: 5000 })
    await page.waitForTimeout(800) // let the debounced layout save land
    await page.screenshot({ path: join(artifacts, 'four-panels.png') })

    const layoutBefore = await hooks.layout(page)
    assert.equal(Object.keys(layoutBefore.panels).length, 4)
    const textsBefore: Record<string, string> = {}
    for (const id of ids) textsBefore[id] = await hooks.text(page, id)

    // Forced close: kill the Electron main process by PID (TerminateProcess on Windows).
    await killElectron(app)
    app = undefined

    ;({ app, page } = await launch(home))
    await page.waitForFunction(() => document.querySelectorAll('.tether-tab').length === 4, undefined, { timeout: 10_000 })
    const idsAfter = await hooks.ids(page)
    assert.deepEqual([...idsAfter].sort(), [...ids].sort(), 'same 4 slots')
    const layoutAfter = await hooks.layout(page)
    assert.deepEqual(shape(layoutAfter.grid.root), shape(layoutBefore.grid.root), 'same arrangement')

    // Each panel re-attached with its scrollback from the daemon.
    await page.waitForFunction(id => window.__tether.text(id).includes('echo: hello tether'), typedId, { timeout: 5000 })
    // Compared without whitespace: a hidden tab re-attaches at the default 80 columns, so long lines wrap differently.
    const squash = (s: string): string => s.replace(/\s+/g, '')
    for (const id of ids) {
      await page.waitForFunction(id => window.__tether.text(id).includes('(falso)'), id, { timeout: 5000 })
      const banner = textsBefore[id]!.split('\n').slice(0, 2).join('')
      assert.ok(squash(await hooks.text(page, id)).includes(squash(banner)), `scrollback of ${id} restored`)
    }
    await page.screenshot({ path: join(artifacts, 'four-panels-restored.png') })
    const slots = await page.evaluate(() => window.__tether.slots())
    assert.ok(slots.every(s => s.status === 'running'), 'all slots still running in the daemon')
  } finally {
    if (app) await app.close().catch(() => {})
    if (daemon.pid) process.kill(daemon.pid)
    await waitForExit(daemon)
    rmSync(home, { recursive: true, force: true })
  }
})
