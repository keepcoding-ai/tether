// E2E of the app surviving a tetherd restart from outside (a crash, `tether daemon restart`) WITHOUT being relaunched:
// hidden window, private home/pipe, real tetherd, an inert stand-in for the soul (TETHER_SOUL_CMD), CLAUDE* stripped.
//   1. one agent tab running;
//   2. the tetherd is killed by PID: the main reconnects (spawning a new one) and reloads the page;
//   3. the NEW page learns the connection by itself (pull at boot): the connection shows the new pid, the tab is back
//      and its slot is running again. It used to stay on "Conectando ao serviço…" forever.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'
import { FAKE_SOUL_CMD as FAKE_SOUL } from './browser-kit.ts'
import { ptydEnv, stopPtyd } from './ptyd-driver.ts'

type Hooks = {
  slots(): SlotState[]
  connection(): { connected: boolean; pid?: number } | undefined
  openSlot(slotId: string): Promise<void>
}
declare const window: { __tether: Hooks; tether: { request(r: unknown): Promise<{ t: string; slot?: SlotState }> } }
declare const document: { querySelectorAll(selector: string): { length: number } }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-dmrestart-${process.pid}`

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}
async function until(what: string, cond: () => Promise<boolean> | boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms
  while (!(await cond())) { if (Date.now() > end) throw new Error(`timeout (${ms} ms): ${what}`); await sleep(100) }
}

async function launch(home: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_') && !k.toUpperCase().startsWith('CLAUDE')) env[k] = v
  env.TETHER_PIPE = pipe
  env.TETHER_HOME = home
  env.TETHER_E2E_HIDDEN = '1'
  env.TETHER_SOUL_CMD = FAKE_SOUL
  delete env.NODE_TEST_CONTEXT
  delete env.TETHER_CLAUDE_ARGS
  ptydEnv(env, undefined)
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10_000)
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  return { app, page }
}

test('app: a tetherd restarted from outside is picked up by the reloaded page, no relaunch', { timeout: 180_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  const home = mkdtempSync(join(tmpdir(), 'tether-dmrestart-'))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    const pid1 = (await page.evaluate(() => window.__tether.connection()))!.pid!
    daemons.push(await claim(pid1, { cmdIncludes: daemonMain, what: 'tetherd' }))

    // ---- 1. one agent tab, running ----
    const slotId = await page.evaluate(async cwd => (await window.tether.request({ t: 'create', kind: 'soul', cwd, name: 'Sonda', start: true })).slot!.slotId, home)
    await until('the renderer knows the slot', async () => (await page.evaluate(() => window.__tether.slots())).some(s => s.slotId === slotId))
    await page.evaluate(id => window.__tether.openSlot(id), slotId)
    await page.waitForFunction(() => document.querySelectorAll('.tether-tab').length === 1)
    const running = (): Promise<boolean> => page.evaluate(id => window.__tether.slots().find(s => s.slotId === id)?.status === 'running', slotId)
    await until('the agent runs', running, 20_000)
    await sleep(800) // let the debounced layout save land: the reloaded page restores from it

    // ---- 2. the tetherd dies from outside ----
    assert.equal(await killOwned(daemons[0]!), 'killed', 'tetherd killed by identity')
    await until('the old tetherd to die', () => !pidAlive(pid1), 10_000)

    // ---- 3. the app reconnects to a new tetherd and the reloaded page follows, with no relaunch ----
    await until('the page to see the new tetherd', async () => {
      try { return ((await page.evaluate(() => window.__tether.connection()))?.pid ?? pid1) !== pid1 } catch { return false } // mid-reload
    }, 40_000)
    const pid2 = (await page.evaluate(() => window.__tether.connection()))!.pid!
    assert.ok(pid2 !== pid1 && pidAlive(pid2), 'a new tetherd')
    daemons.push(await claim(pid2, { cmdIncludes: daemonMain, what: 'tetherd' }))
    await page.waitForFunction(() => document.querySelectorAll('.tether-tab').length === 1, undefined, { timeout: 20_000 })
    await until('the agent runs again', async () => (await page.evaluate(id => window.__tether.slots().find(s => s.slotId === id)?.status, slotId)) === 'running', 30_000)
  } finally {
    if (app) await killElectron(app, root).catch(() => {})
    for (const d of daemons) await killOwned(d, { tree: true })
    await until('tetherd processes to exit', () => daemons.every(d => !pidAlive(d.pid)), 10_000).catch(() => {})
    await stopPtyd(home)
    for (let i = 0; i < 5; i++) {
      try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
  }
})
