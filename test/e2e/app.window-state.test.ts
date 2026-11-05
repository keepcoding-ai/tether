// E2E of the remembered window state, hidden windows on a private home/pipe: the first launch has the default
// window; it is given custom normal bounds and maximized, then closed (the X); the next launch on the same home
// comes back maximized with the same normal bounds, and un-maximizing returns to them. A saved rect that no display
// shows is replaced by a centered default (the pure rules are in test/unit/app.window-state.test.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type Hooks = { connection(): { pid?: number } | undefined }
declare const window: { __tether: Hooks }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-appwinstate-${process.pid}`
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

function appEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_')) env[k] = v
  env.TETHER_PIPE = pipe
  env.TETHER_HOME = home
  env.TETHER_E2E_HIDDEN = '1'
  return env
}

async function launch(home: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env: appEnv(home) })
  const page = await app.firstWindow()
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  return { app, page }
}

type State = { maximized: boolean; fullscreen: boolean; normal: { x: number; y: number; width: number; height: number } }
const stateOf = (app: ElectronApplication): Promise<State> => app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0]!
  return { maximized: w.isMaximized(), fullscreen: w.isFullScreen(), normal: w.getNormalBounds() }
})
const saved = (home: string): { window?: Record<string, unknown> } => {
  try { return JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')) } catch { return {} } // not written yet
}

async function waitUntil(cond: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timeout (${ms} ms) waiting for ${what}`)
    await sleep(100)
  }
}

test('window state: maximized and normal bounds survive close + relaunch; off-screen bounds fall back', async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  const home = mkdtempSync(join(tmpdir(), 'tether-appwinstate-'))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    // ---- 1. first run: default window; custom bounds, then maximized ----
    let l = await launch(home)
    app = l.app
    const daemonPid = (await l.page.evaluate(() => window.__tether.connection()))!.pid!
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))
    const first = await stateOf(app)
    assert.equal(first.maximized, false, 'first run is not maximized')
    assert.ok(first.normal.width > 1300 && first.normal.width < 1500, `first run keeps the default size (${first.normal.width})`) // the OS may trim it to the display
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setBounds({ x: 60, y: 50, width: 1000, height: 640 }))
    const target = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBounds())
    await waitUntil(() => saved(home).window?.width === target.width, 5_000, 'the resized bounds to be saved')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.maximize())
    await waitUntil(() => saved(home).window?.maximized === true, 5_000, 'maximized to be saved')
    const normal = (await stateOf(app)).normal
    const w = saved(home).window!
    assert.deepEqual([w.x, w.y, w.width, w.height], [normal.x, normal.y, normal.width, normal.height], 'the NORMAL bounds are saved while maximized')
    assert.equal(normal.width, target.width)

    // ---- 2. close (X), leave, relaunch on the same home ----
    const mainPid = await app.evaluate(() => process.pid)
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.close() })
    // Without a tray the X ends the app by itself; its helpers hold Chromium's lock a little longer.
    await waitUntil(() => !pidAlive(mainPid), 15_000, 'the app to exit after the window closed')
    await sleep(4_000)
    app = undefined
    l = await launch(home)
    app = l.app
    const back = await stateOf(app)
    assert.equal(back.maximized, true, 'comes back maximized')
    // An offscreen (hidden) window grows by a few px of frame on creation; a few px is the tolerance.
    for (const k of ['x', 'y', 'width', 'height'] as const) assert.ok(Math.abs(back.normal[k] - normal[k]) <= 10, `same normal bounds (${k}: ${back.normal[k]} vs ${normal[k]})`)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.unmaximize())
    await waitUntil(() => saved(home).window?.maximized === false, 5_000, 'un-maximized to be saved')
    await killElectron(app, root)
    app = undefined

    // ---- 3. a rect on a display that is gone: centered default, not off-screen ----
    const settings = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'))
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ ...settings, window: { x: 90_000, y: 90_000, width: 1000, height: 640, maximized: false, fullscreen: false } }))
    l = await launch(home)
    app = l.app
    const area = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea)
    const fb = (await stateOf(app)).normal
    assert.ok(fb.x >= area.x && fb.y >= area.y && fb.x < area.x + area.width && fb.y < area.y + area.height, `fallback is on the primary display (${JSON.stringify(fb)})`)
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
