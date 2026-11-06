// E2E of "Reiniciar o app (os agentes continuam rodando)" exactly as the person runs it, against the real tetherd on
// a private home/pipe, hidden window:
//   1. the app is launched like the Start Menu shortcut does (app/install.mjs): Electron's own exe with the
//      RELATIVE argument `app\dist\main.cjs`, cwd = repo, no Playwright launcher in between (the process is
//      driven over CDP, --remote-debugging-port=0), so argv and cwd are what the relaunch has to reproduce;
//   2. two PowerShell panes; Ctrl+Shift+P from inside a terminal, "Reiniciar o app" typed, Enter;
//   3. a NEW main process comes up (other pid, told which pid it replaces), the old one is gone, the window is
//      back with the same panes connected to the SAME tetherd (same pid, agents untouched), and the main
//      process' own log (<home>/tether-app.log) says what happened: relaunch started → next pid → lock acquired →
//      window shown; in hidden mode the window is never put on the screen, so "visible" is checked only when
//      TETHER_RELAUNCH_E2E_SHOW=1 (a manual run that does show the window);
//   4. a second relaunch from the relaunched instance works the same (the hand-off flag is replaced, not stacked).
// Every kill goes through test/kill.ts (pid + creation time + a token only this run puts on the command line).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright-core'
import { claim, findProcesses, identify, killOwned, type Owned } from '../kill.ts'

type Hooks = {
  panelIds(): string[]
  text(id: string): string
  connection(): { connected: boolean; pid?: number } | undefined
  palette(): { open: boolean; mode?: 'commands' | 'default'; shown: string[]; input: string }
}
declare const window: { __tether: Hooks }
declare const document: { querySelectorAll(selector: string): { length: number }; visibilityState: string; hasFocus(): boolean }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-relaunch-${process.pid}`
/** Only this run puts it on a command line: the main processes are found and claimed by it. */
const token = `--tether-e2e-run=${process.pid}`
const show = process.env.TETHER_RELAUNCH_E2E_SHOW === '1'
/** The shortcut's relative script argument on a command line, quoted or not (Node quotes only what needs it). */
const SCRIPT_ARG = /(^|\s|")app\\dist\\main\.cjs("|\s|$)/
/** New main up (the lock may be retried for up to 12 s while the old helpers leave) plus the page connected. */
const RELAUNCH_TIMEOUT_MS = 45_000

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

function appEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_') && !k.toUpperCase().startsWith('CLAUDE')) env[k] = v
  env.TETHER_PIPE = pipe
  env.TETHER_HOME = home
  if (!show) env.TETHER_E2E_HIDDEN = '1'
  return env
}

/** Like the shortcut: the exe, the relative script path, cwd = repo. Detached: the test is not its parent for long. */
function launchLikeShortcut(home: string): number {
  const child = spawn(electronPath, ['app\\dist\\main.cjs', '--remote-debugging-port=0', token], { cwd: root, env: appEnv(home), detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
  return child.pid!
}

/** The main processes of this run (never a helper: those carry --type=). */
async function mains(): Promise<Owned[]> {
  return (await findProcesses({ name: 'electron.exe', cmdIncludes: token })).filter(p => !/--type=/.test(p.cmd ?? ''))
}

/** Connects over CDP to the window page of the main that owns `home` now; `notPort` = the previous instance's port. */
async function connectPage(home: string, notPort: string | undefined, timeoutMs: number): Promise<{ browser: Browser; page: Page; port: string }> {
  const portFile = join(home, 'electron', 'DevToolsActivePort')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    let port: string | undefined
    try { port = readFileSync(portFile, 'utf8').split(/\r?\n/)[0] } catch { /* not yet */ }
    if (port && /^\d+$/.test(port) && port !== notPort) {
      try {
        const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 3000 })
        const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes('renderer/index.html'))
        if (page) { page.setDefaultTimeout(10_000); return { browser, page, port } }
        await browser.close()
      } catch { /* the port file may be the dead instance's for a moment */ }
    }
    await sleep(250)
  }
  throw new Error(`no window page over CDP within ${timeoutMs} ms`)
}

async function createShellPanel(page: Page, cwd: string): Promise<void> {
  const before = await page.evaluate(() => document.querySelectorAll('.tether-tab').length)
  await page.click('#btn-new')
  await page.waitForSelector('#dlg-new[open]')
  await page.fill('#dlg-new .ch-path-input', cwd)
  await page.click('#dlg-new .ch-item[data-id="powershell"]')
  await page.waitForFunction(n => document.querySelectorAll('.tether-tab').length === n, before + 1)
}

/** Ctrl+Shift+P from inside the focused terminal, the command typed, Enter: the window goes away under the keyboard. */
async function relaunchFromPalette(page: Page): Promise<void> {
  await page.locator('.panel .panel-term').first().click()
  await page.keyboard.press('Control+Shift+P')
  await page.waitForFunction(() => window.__tether.palette().open === true && window.__tether.palette().mode === 'commands')
  await page.keyboard.type('Reiniciar o app')
  await page.waitForFunction(() => window.__tether.palette().shown[0] === 'app.relaunch')
  await page.keyboard.press('Enter').catch(() => { /* the window is destroyed before the key round-trip answers */ })
}

async function waitGone(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { if (!pidAlive(pid)) return true; await sleep(100) }
  return !pidAlive(pid)
}

/** Waits until no process lists `parentPid` as its parent (the dead main's helpers hold the lockfile for a while). */
async function waitForChildrenExit(parentPid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const r = spawnSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${parentPid}" | Measure-Object).Count`], { encoding: 'utf8' })
    if (r.status === 0 && r.stdout.trim() === '0') return
    await sleep(500)
  }
}

const logOf = (home: string): string => { try { return readFileSync(join(home, 'tether-app.log'), 'utf8') } catch { return '' } }
const lines = (home: string, pid: number): string[] => logOf(home).split(/\r?\n/).filter(l => l.includes(`[${pid}]`))

test('app relaunch: shortcut-style launch, palette command, new main pid, window back with the same panes on the same tetherd, logged', async t => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  const home = mkdtempSync(join(tmpdir(), 'tether-relaunch-'))
  const daemons: Owned[] = []
  const toKill: Owned[] = []
  let browser: Browser | undefined
  try {
    // ---- 1. launch like the shortcut ----
    const firstPid = launchLikeShortcut(home)
    let { browser: b, page, port } = await connectPage(home, undefined, 30_000)
    browser = b
    await page.waitForSelector('#conn.on', { timeout: 30_000 })
    const main0 = await claim(firstPid, { cmdIncludes: token, what: 'electron main' })
    toKill.push(main0)
    assert.match(main0.cmd ?? '', SCRIPT_ARG, 'the main runs with the relative script path, as the shortcut passes it')
    const daemonPid = (await page.evaluate(() => window.__tether.connection()))?.pid
    assert.ok(daemonPid && pidAlive(daemonPid), 'the app spawned a tetherd')
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))
    assert.match(lines(home, firstPid).join('\n'), /start: ppid \d+.*lock: acquired at attempt 1/s, 'the launch is logged')

    // ---- 2. two panes, then the command from the palette ----
    await createShellPanel(page, root)
    await createShellPanel(page, root)
    const ids = await page.evaluate(() => window.__tether.panelIds())
    assert.equal(ids.length, 2)
    await page.waitForFunction(() => window.__tether.panelIds().every(id => /PS.*>/.test(window.__tether.text(id).replace(/\s+/g, ''))), undefined, { timeout: 20_000 })
    await sleep(800) // the debounced layout save
    assert.ok(existsSync(join(home, 'layout.json')), 'layout saved')

    let oldPid = firstPid
    for (let round = 1; round <= 2; round++) {
      const t0 = Date.now()
      await relaunchFromPalette(page)
      browser.close().catch(() => {})
      browser = undefined

      // ---- 3. the old main leaves, a new one takes over ----
      assert.ok(await waitGone(oldPid, 20_000), `round ${round}: the old main (pid ${oldPid}) left`)
      ;({ browser: b, page, port } = await connectPage(home, port, RELAUNCH_TIMEOUT_MS))
      browser = b
      await page.waitForSelector('#conn.on', { timeout: 30_000 })
      const alive = await mains()
      assert.equal(alive.length, 1, `round ${round}: exactly one main process of this run (${alive.map(p => p.pid).join(', ')})`)
      const main = alive[0]!
      assert.notEqual(main.pid, oldPid, 'a new main process')
      assert.match(main.cmd ?? '', new RegExp(`--relaunched-from=${oldPid}(\\s|"|$)`), 'the new main knows which pid it replaces')
      assert.match(main.cmd ?? '', SCRIPT_ARG, 'same relative script path as the shortcut')
      toKill.push(main)
      const upIn = Date.now() - t0

      // the same panes, on the same tetherd
      assert.equal((await page.evaluate(() => window.__tether.connection()))?.pid, daemonPid, 'connected to the same tetherd (agents untouched)')
      await page.waitForFunction(n => document.querySelectorAll('.tether-tab').length === n, ids.length, { timeout: 15_000 })
      assert.deepEqual([...(await page.evaluate(() => window.__tether.panelIds()))].sort(), [...ids].sort(), 'same slots in the window')
      assert.equal(await page.evaluate(() => document.visibilityState), 'visible')

      // the trail in the app's own log
      const oldLog = lines(home, oldPid).join('\n')
      assert.match(oldLog, /relaunch: starting .*--relaunched-from=\d+/, 'the old main logged the relaunch it started')
      assert.match(oldLog, new RegExp(`relaunch: next instance is pid ${main.pid}; leaving`), 'the old main logged the pid it started')
      const newLog = lines(home, main.pid).join('\n')
      assert.match(newLog, new RegExp(`start: .*replaces pid ${oldPid} \\(Reiniciar o app\\)`), 'the new main logged what it replaces')
      assert.match(newLog, /lock: acquired at attempt \d+/, 'the new main got the single-instance lock')
      assert.doesNotMatch(newLog, /a live instance .* answered this launch/, 'the new main never mistook the dying one for a live window')
      const windowLine = /window: visible=(\w+) focused=(\w+) minimized=(\w+)/.exec(newLog)
      assert.ok(windowLine, `the new main logged its window state:\n${newLog}`)
      if (show) {
        assert.equal(windowLine![1], 'true', 'the window is visible')
        assert.equal(windowLine![2], 'true', 'the window is focused')
        assert.equal(await page.evaluate(() => document.hasFocus()), true, 'the page has the focus')
      }
      assert.equal(windowLine![3], 'false', 'the window is not minimized')
      t.diagnostic(`round ${round}: relaunch ${oldPid} → ${main.pid} up and connected in ${upIn} ms (${/lock: acquired at attempt (\d+)/.exec(newLog)![1]} lock attempt(s))`)
      oldPid = main.pid
    }
  } finally {
    browser?.close().catch(() => {})
    for (const p of toKill) if (await killOwned(p) === 'killed') await waitForChildrenExit(p.pid, 15_000)
    for (const d of daemons) await killOwned(d, { tree: true })
    const deadline = Date.now() + 10_000
    while (daemons.some(d => pidAlive(d.pid)) && Date.now() < deadline) await sleep(100)
    for (let i = 0; i < 5; i++) {
      try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
  }
})
