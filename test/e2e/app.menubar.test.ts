// E2E of the hidden native menu bar: Alt belongs to Monaco's multi-cursor editing, so pressing and releasing Alt must never
// reveal the bar, while the application menu's accelerators stay installed and registered.
// Real tetherd on a private home/pipe, hidden window, no panes needed.
// Every kill goes through test/kill.ts (pid + creation time).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type Hooks = { connection(): { connected: boolean; pid?: number } | undefined }
declare const window: { __tether: Hooks }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const pipe = `\\\\.\\pipe\\tether-mbar-${process.pid}`
const daemonMain = join(root, 'src', 'daemon', 'main.ts')

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

const barState = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0]!
  return { visible: w.isMenuBarVisible(), autoHide: w.isMenuBarAutoHide(), devtools: w.webContents.isDevToolsOpened() }
})

test('app menu bar: Alt never shows it, the menu accelerators still work', { timeout: 120_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  const home = mkdtempSync(join(tmpdir(), 'tether-mbar-'))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_') && !k.toUpperCase().startsWith('CLAUDE')) env[k] = v
    env.TETHER_PIPE = pipe
    env.TETHER_HOME = home
    env.TETHER_E2E_HIDDEN = '1'
    app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
    const page: Page = await app.firstWindow()
    page.setDefaultTimeout(10_000)
    page.on('pageerror', e => console.error('renderer error: ' + e.message))
    page.on('console', m => { if (m.type() === 'error') console.error('renderer console: ' + m.text().slice(0, 300)) })
    await page.waitForSelector('#conn.on', { timeout: 30_000 })
    const daemonPid = (await page.evaluate(() => window.__tether.connection()))?.pid
    assert.ok(daemonPid && pidAlive(daemonPid), 'the app spawned a tetherd')
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))

    const before = await barState(app)
    assert.equal(before.visible, false, 'the bar starts hidden')
    assert.equal(before.autoHide, false, 'no auto-hide: Alt has nothing to reveal')

    // Alt through the renderer and through the native input path (the one the OS menu bar listens to).
    await page.keyboard.press('Alt')
    await app.evaluate(({ BrowserWindow }) => {
      const wc = BrowserWindow.getAllWindows()[0]!.webContents
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Alt' })
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Alt' })
    })
    await sleep(500)
    assert.equal((await barState(app)).visible, false, 'press and release Alt: the bar stays hidden')

    // The menu is rebuilt when the theme changes; the bar must stay hidden after that too.
    await page.evaluate(() => (window as unknown as { tether: { setTheme(s: string): Promise<unknown> } }).tether.setTheme('dark'))
    await sleep(500)
    await page.keyboard.press('Alt')
    assert.equal((await barState(app)).visible, false, 'still hidden after the menu was rebuilt')

    // The application menu is still installed with its accelerators (a hidden bar does not unregister them).
    // Synthetic key events do not reach the native accelerator path of an offscreen window, so this checks the registration.
    const menu = await app.evaluate(({ Menu }) => {
      const m = Menu.getApplicationMenu()
      const find = (id: string) => m?.getMenuItemById(id)
      return {
        installed: !!m,
        quit: find('quit-all')?.accelerator?.toString() ?? null,
        quitRegistered: find('quit-all')?.registerAccelerator ?? null,
        devtools: (m?.items ?? []).flatMap(i => i.submenu?.items ?? []).some(i => i.role?.toLowerCase() === 'toggledevtools'),
      }
    })
    assert.equal(menu.installed, true, 'the application menu is still set')
    assert.equal(menu.quit, 'CmdOrCtrl+Shift+Q', 'accelerators stay on the menu items')
    assert.equal(menu.quitRegistered, true, 'and registered')
    assert.equal(menu.devtools, true, 'the dev tools role (Ctrl+Shift+I) is still in the menu')
    assert.equal((await barState(app)).visible, false, 'the bar is still hidden')
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
