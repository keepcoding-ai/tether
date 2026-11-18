// E2E of the single-instance behaviour of the Electron app (hidden windows, private home/pipe, shell slots only):
//   1. kill the Electron main by PID and relaunch AT ONCE, without waiting for its helpers (GPU, renderer,
//      network): they keep Chromium's lockfile open for a few seconds, and the relaunch must still come up
//      with the layout restored, instead of quitting as a "second instance";
//   2. the same, with the stale lock made deterministic: the test itself holds the lockfile for a while (longer
//      than the ~5 s Chromium blocks inside one refused request, so the retry is what gets the lock);
//   3. a second launch while the first is alive: the first gets `second-instance` (its ack is written) and
//      the second exits right away;
//   4. a lock that never frees: the app gives up after its retry window with the Portuguese message on stderr
//      (the message box is skipped in hidden mode).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

declare const window: { __tether: { panelIds(): string[]; text(id: string): string; connection(): { connected: boolean; pid?: number } | undefined } }
declare const document: { querySelectorAll(selector: string): { length: number } }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-appinstance-${process.pid}`
const GIVE_UP = /o Tether ainda está fechando; tente de novo em alguns segundos/
/** The app's retry window for the lock (LOCK_RETRY_MS in app/main/main.ts). */
const LOCK_RETRY_MS = 12_000

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

function waitForExit(child: ChildProcess): Promise<number | null> {
  return new Promise(res => { if (child.exitCode !== null) res(child.exitCode); else child.once('exit', code => res(code)) })
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
  page.setDefaultTimeout(10_000)
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  return { app, page }
}

/** Runs the app bare (no Playwright) and resolves when it exits, with what it wrote. */
function runBare(home: string): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(electronPath, [mainPath], { env: appEnv(home), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let stderr = ''
  child.stderr?.on('data', d => { stderr += d })
  child.stdout?.on('data', d => { stderr += d })
  return waitForExit(child).then(code => ({ code, stderr }))
}

/** Opens Chromium's lockfile for writing: it refuses the share mode the app asks for, exactly like a dying helper's inherited handle. */
function holdLock(home: string): () => void {
  const dir = join(home, 'electron')
  mkdirSync(dir, { recursive: true })
  const fd = openSync(join(dir, 'lockfile'), 'w')
  return () => closeSync(fd)
}

const hooks = {
  ids: (page: Page) => page.evaluate(() => window.__tether.panelIds()),
  daemonPid: async (page: Page) => (await page.evaluate(() => window.__tether.connection()))?.pid,
  /** How many tries the main needed for the single-instance lock (1 = got it at once). */
  lockAttempts: (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { __tetherLockAttempts: number }).__tetherLockAttempts),
}

async function createShellPanel(page: Page, cwd: string): Promise<void> {
  await page.click('#btn-new')
  await page.waitForSelector('#dlg-new[open]')
  await page.fill('#dlg-new .ch-path-input', cwd)
  await page.click('#dlg-new .ch-item[data-id=\"powershell\"]')
  await page.click('#dlg-new .btn.primary.go') // two steps: the click selects, the button opens
  await page.waitForFunction(() => document.querySelectorAll('#dlg-new[open]').length === 0)
  await page.waitForFunction(() => document.querySelectorAll('.tether-tab').length === 1)
  // The shell prompt must be up (PowerShell shows "PS <folder>>"): the slot is running and the layout has settled.
  await page.waitForFunction(() => /PS.*>/.test(window.__tether.text(window.__tether.panelIds()[0]!).replace(/\s+/g, '')), undefined, { timeout: 20_000 })
}

async function restored(page: Page, ids: string[], daemonPid: number): Promise<void> {
  assert.equal(await hooks.daemonPid(page), daemonPid, 'reconnected to the same tetherd')
  await page.waitForFunction(n => document.querySelectorAll('.tether-tab').length === n, ids.length, { timeout: 10_000 })
  assert.deepEqual([...(await hooks.ids(page))].sort(), [...ids].sort(), 'same slots')
}

test('single instance: immediate relaunch after a window kill, stale lock, second launch while alive', async t => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  const home = mkdtempSync(join(tmpdir(), 'tether-appinstance-'))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    const daemonPid = (await hooks.daemonPid(page))!
    assert.ok(daemonPid && pidAlive(daemonPid), 'the app spawned a tetherd')
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))
    assert.equal(await hooks.lockAttempts(app), 1, 'a fresh home: the lock comes at the first try')
    await createShellPanel(page, root)
    const ids = await hooks.ids(page)
    assert.equal(ids.length, 1)
    await sleep(800) // let the debounced layout save land
    assert.ok(existsSync(join(home, 'layout.json')), 'layout saved')
    assert.ok(existsSync(join(home, 'electron', 'lockfile')), 'Chromium keeps its single-instance lockfile under TETHER_HOME/electron')

    // ---- 1. window kill → relaunch at once, no wait for the dying helpers (3 rounds: the race is timing-dependent) ----
    let raced = 0
    for (let round = 1; round <= 3; round++) {
      await killElectron(app, root)
      app = undefined
      const t0 = Date.now()
      ;({ app, page } = await launch(home))
      await restored(page, ids, daemonPid)
      const attempts = await hooks.lockAttempts(app)
      if (attempts > 1) raced++
      t.diagnostic(`round ${round}: relaunch up in ${Date.now() - t0} ms, lock in ${attempts} ${attempts === 1 ? 'try' : 'tries (stale lock hit and retried)'}`)
    }
    t.diagnostic(`immediate relaunch: the dying helpers held the lock in ${raced}/3 rounds`)

    // ---- 2. deterministic stale lock: held by the test for 7 s after the kill; the app must wait it out ----
    // Chromium blocks ~5 s inside a refused requestSingleInstanceLock() before saying no: 7 s means the first
    // request is refused and the retry gets the lock (the unfixed app quit silently after the first refusal).
    await killElectron(app, root)
    app = undefined
    await sleep(3000) // let the old helpers go, so the lock below is the only obstacle
    const release = holdLock(home)
    const t1 = Date.now()
    const pending = launch(home)
    await sleep(7000)
    release()
    ;({ app, page } = await pending)
    const took = Date.now() - t1
    const attempts = await hooks.lockAttempts(app)
    assert.ok(attempts > 1, `the lock was refused while the test held it, then retried (${attempts} tries)`)
    assert.ok(took >= 7000, `the app waited for the lock (${took} ms)`)
    await restored(page, ids, daemonPid)
    t.diagnostic(`held lock: relaunch up in ${took} ms after ${attempts} tries`)

    // ---- 3. second launch while the first is alive: the first is poked (ack written), the second exits at once ----
    const ackPath = join(home, 'electron', 'second-instance.json')
    const t2 = Date.now()
    const second = await runBare(home)
    const secondTook = Date.now() - t2
    assert.equal(second.code, 0, `second instance exited cleanly: ${second.stderr}`)
    assert.ok(secondTook < 6000, `second instance left promptly (${secondTook} ms)`)
    assert.ok(existsSync(ackPath), 'the running instance acknowledged the second launch')
    const ack = JSON.parse(readFileSync(ackPath, 'utf8')) as { at: number; pid: number }
    assert.ok(ack.at >= t2, 'the ack is from this launch')
    assert.equal(ack.pid, await app.evaluate(() => process.pid), 'the ack came from the live main process')
    assert.doesNotMatch(second.stderr, GIVE_UP)
    assert.equal((await hooks.ids(page)).length, 1, 'the first window is untouched')
    t.diagnostic(`second launch while alive: exited in ${secondTook} ms, ack by pid ${ack.pid}`)

    // ---- 4. a lock that never frees: after the retry window the in-app "ainda está fechando" dialog comes up in
    //         its own window (message on stderr too); "Fechar" quits. The retry path is proven in app.dialogs.test.ts.
    await killElectron(app, root)
    app = undefined
    await sleep(3000)
    const releaseForever = holdLock(home)
    const t3 = Date.now()
    const stuck = await _electron.launch({ executablePath: electronPath, args: [mainPath], env: appEnv(home) })
    app = stuck
    let stuckErr = ''
    stuck.process().stderr?.on('data', d => { stuckErr += d })
    const dlgWin = await stuck.firstWindow({ timeout: LOCK_RETRY_MS + 20_000 })
    await dlgWin.locator('dialog.ask[data-dialog="still-closing"][open]').waitFor({ timeout: 10_000 })
    const stuckTook = Date.now() - t3
    assert.ok(stuckTook >= LOCK_RETRY_MS, `gave up only after the retry window (${stuckTook} ms)`)
    const stuckClosed = stuck.waitForEvent('close', { timeout: 15_000 })
    await dlgWin.locator('button.choice[data-choice="close"]').click()
    await stuckClosed
    app = undefined
    releaseForever()
    assert.match(stuckErr, GIVE_UP)
    t.diagnostic(`stuck lock: dialog after ${stuckTook} ms, "Fechar" quit the app`)
  } finally {
    if (app) await killElectron(app, root).catch(() => {})
    for (const d of daemons) await killOwned(d, { tree: true })
    const deadline = Date.now() + 10_000
    while (daemons.some(d => pidAlive(d.pid)) && Date.now() < deadline) await sleep(100)
    for (let i = 0; i < 5; i++) {
      try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
  }
})
