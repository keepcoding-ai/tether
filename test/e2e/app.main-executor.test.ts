// E2E of the main process' executor (app/main/main.ts, src/exec) in the real Electron app, on a private TETHER_HOME,
// TETHER_USER_DIR and pipe, with TETHER_EXECUTOR=worker (the bundle's own worker, app/dist/exec-worker.cjs):
//   1. the app logs `executor: worker`; its log lines reach tether-app.log through the batch;
//   2. the layout is saved (layout.json, the previous content in layout.json.bak) and a setting is written (settings.json,
//      the person's comment kept) through the worker;
//   3. a graceful quit drains the disk work; the relaunch finds the layout and the setting as they were;
//   4. informational: the main ruler (perf:get.main) holds no `slow` incident above 50 ms and the loop-lag samples are printed.
// With TETHER_EXECUTOR=inline (the fallback) the same flow must hold: second test. Kills go by identity only (test/kill.ts).
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
import { ptydEnv, stopPtyd } from './ptyd-driver.ts'

type PerfMain = { incidents: Array<{ kind: string; label?: string; ms?: number }>; samples: Array<{ maxMs: number; p99Ms: number }>; labels?: Record<string, { n: number; total: number; max: number }> }
declare const window: {
  __tether: { theme(): { setting: string }; connection(): { connected: boolean; pid?: number } | undefined }
  tether: { loadLayout(): Promise<Record<string, unknown> | null>; saveLayout(l: unknown): Promise<void>; perfGet(): Promise<{ main: PerfMain }> }
}

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const pidAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' } }

async function launch(home: string, userDir: string, pipe: string, mode: 'worker' | 'inline'): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_')) env[k] = v
  env.TETHER_PIPE = pipe
  env.TETHER_HOME = home
  env.TETHER_USER_DIR = userDir
  env.TETHER_E2E_HIDDEN = '1'
  env.TETHER_EXECUTOR = mode
  ptydEnv(env, undefined)
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10_000)
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  return { app, page }
}

async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { if (await ok()) return; await sleep(100) }
  assert.fail(`never: ${what}`)
}

/** A quit the person would do ("Sair"): app.quit() through the main process, then wait for the launcher to leave. */
async function quitGracefully(app: ElectronApplication, root: string): Promise<void> {
  const launcher = app.process()
  const exited = new Promise<void>(res => { if (launcher.exitCode !== null) res(); else launcher.once('exit', () => res()) })
  await app.evaluate(({ app }) => { app.quit() }).catch(() => { /* the process may leave before answering */ })
  await Promise.race([exited, sleep(15_000)])
  if (launcher.exitCode === null) await killElectron(app, root).catch(e => console.error(String(e)))
  await sleep(1500) // the helpers hold Chromium's lock file for a moment
}

for (const mode of ['worker', 'inline'] as const) {
  test(`main executor (${mode}): log, layout and settings go through it; a graceful quit drains; a relaunch finds the state`, async () => {
    const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
    assert.equal(build.status, 0, 'app build failed')
    assert.ok(existsSync(join(root, 'app', 'dist', 'exec-worker.cjs')) && existsSync(join(root, 'app', 'dist', 'exec-table.cjs')), 'the executor bundles are in app/dist')
    const home = mkdtempSync(join(tmpdir(), 'tether-mainexec-home-'))
    const userDir = mkdtempSync(join(tmpdir(), 'tether-mainexec-user-'))
    const pipe = `\\\\.\\pipe\\tether-mainexec-${mode}-${process.pid}`
    const seeded = '{\n  // my own note\n  "theme": "light"\n}\n'
    writeFileSync(join(userDir, 'settings.json'), seeded)
    const settingsFile = join(userDir, 'settings.json')
    const layoutFile = join(home, 'layout.json')
    const logFile = join(home, 'tether-app.log')
    const daemons: Owned[] = []
    let app: ElectronApplication | undefined
    try {
      let page: Page
      ;({ app, page } = await launch(home, userDir, pipe, mode))
      const daemonPid = (await page.evaluate(() => window.__tether.connection()))?.pid
      assert.ok(daemonPid && pidAlive(daemonPid), 'the app spawned a tetherd')
      daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))

      // 1. The log reaches the file through the batch.
      await until('executor line in tether-app.log', () => existsSync(logFile) && readFileSync(logFile, 'utf8').includes(`executor: ${mode}`))

      // 2. Layout: save twice (the second keeps the first in .bak); settings: a change through the app edits the text in place.
      await page.evaluate(() => window.tether.saveLayout({ e2eMarker: 'one' }))
      await page.evaluate(() => window.tether.saveLayout({ e2eMarker: 'two' }))
      assert.deepEqual(JSON.parse(readFileSync(layoutFile, 'utf8')), { e2eMarker: 'two' })
      assert.deepEqual(JSON.parse(readFileSync(`${layoutFile}.bak`, 'utf8')), { e2eMarker: 'one' })
      await app.evaluate(({ Menu }) => { Menu.getApplicationMenu()?.getMenuItemById('theme-dark')?.click() })
      await until('settings.json has the dark theme', () => /"theme": "dark"/.test(readFileSync(settingsFile, 'utf8')))
      assert.match(readFileSync(settingsFile, 'utf8'), /\/\/ my own note/)

      // 4 (informational). The main ruler.
      const perf = (await page.evaluate(() => window.tether.perfGet())).main
      const slow = perf.incidents.filter(i => i.kind === 'slow' && (i.ms ?? 0) > 50)
      const lags = perf.samples.map(s => s.p99Ms)
      console.log(`[main ruler ${mode}] slow>50ms: ${JSON.stringify(slow)}; exec labels: ${JSON.stringify(Object.fromEntries(Object.entries(perf.labels ?? {}).filter(([k]) => k.startsWith('exec:'))))}; loop lag p99 ms (per second): ${lags.join(',')}; max ${Math.max(0, ...perf.samples.map(s => s.maxMs))}`)
      assert.ok(Object.keys(perf.labels ?? {}).some(k => k.startsWith('exec:appendText')), 'the log batches went through the executor')

      // 3. Graceful quit: nothing pending is lost. Relaunch: same state.
      await quitGracefully(app, root)
      app = undefined
      assert.match(readFileSync(logFile, 'utf8'), new RegExp(`executor: ${mode}`))
      assert.deepEqual(JSON.parse(readFileSync(layoutFile, 'utf8')), { e2eMarker: 'two' })
      assert.match(readFileSync(settingsFile, 'utf8'), /"theme": "dark"/)
      ;({ app, page } = await launch(home, userDir, pipe, mode))
      assert.deepEqual(await page.evaluate(() => window.tether.loadLayout()), { e2eMarker: 'two' }, 'the layout comes back')
      assert.equal(await page.evaluate(() => window.__tether.theme().setting), 'dark', 'the setting comes back')
      const daemonPid2 = (await page.evaluate(() => window.__tether.connection()))?.pid
      if (daemonPid2 && !daemons.some(d => d.pid === daemonPid2)) daemons.push(await claim(daemonPid2, { cmdIncludes: daemonMain, what: 'tetherd' }))
    } finally {
      if (app) await killElectron(app, root).catch(e => console.error(String(e)))
      for (const d of daemons) {
        const r = await killOwned(d, { tree: true })
        if (r === 'not-ours') console.error(`tetherd cleanup: pid ${d.pid} is no longer ours; not killed`)
      }
      await stopPtyd(home).catch(() => [])
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline && daemons.some(d => pidAlive(d.pid))) await sleep(200)
      for (const dir of [home, userDir]) {
        for (let i = 0; i < 5; i++) {
          try { rmSync(dir, { recursive: true, force: true }); break } catch { await sleep(300) }
        }
      }
    }
  })
}
