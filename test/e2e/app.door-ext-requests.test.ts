// E2E of extension requests and events (N1, renderer half: `ui.daemon`) with the door-probe extension (TETHER_TEST_EXTENSIONS=1):
// a tetherd in this process on a private home and pipe, the real app on the same pipe, hidden window. The probe's daemon half is
// this test's: `DoorHost.apiFor('door-probe', ...)` registers `ping` and emits `tick`. No agent, no LLM.
//   1. the probe asks `ping` and gets the handler's result, with the client kind the core saw (`app`);
//   2. a name with no handler rejects with `unknown-request`;
//   3. a `tick` the daemon emits reaches the probe's listener; another extension's `tick` does not;
//   4. the daemon is closed and a new one starts on the same pipe: the app reconnects (and reloads the page, as
//      it does on every lost connection), the probe's listener hears the new daemon's `tick` and `ping` answers again.
// Every kill goes through test/kill.ts (pid + creation time); the daemon here is closed in-process.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { DisposableStore } from '../../app/shared/vscode-lifecycle.ts'
import { DoorHost } from '../../src/daemon/door/host.ts'
import { startDaemon } from '../../src/daemon/server.ts'
import { removeHome, tempHome, uniquePipe } from '../unit/daemon.helpers.ts'
import { killElectron } from './electron.ts'

type Hooks = { ext: Record<string, Record<string, unknown>> }
declare const window: { __tether: Hooks }
type Asked = { ok: boolean; result?: unknown; code?: string }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')

async function launch(home: string, pipe: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_') && !k.toUpperCase().startsWith('CLAUDE')) env[k] = v
  env.TETHER_PIPE = pipe
  env.TETHER_HOME = home
  env.TETHER_E2E_HIDDEN = '1'
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  page.on('pageerror', e => console.error(`renderer error: ${e.stack}`))
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  return { app, page }
}

const probe = <T>(page: Page, name: string, ...args: unknown[]): Promise<T> =>
  page.evaluate(({ name, args }) => (window.__tether.ext['door-probe']![name] as unknown as (...a: unknown[]) => unknown)(...args) as never, { name, args })
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
async function until(cond: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const end = Date.now() + timeoutMs
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timeout: ${what}`)
    await sleep(100)
  }
}

/** A tetherd whose door has the probe's daemon half: `ping` answers its args and the asking client's kind. */
async function daemonWithProbe(home: string, pipe: string, logs: string[]) {
  const door = new DoorHost({ log: m => logs.push(m) })
  const own = new DisposableStore()
  const daemon = await startDaemon({ home, pipe, memoryIntervalMs: 0, readyFallbackMs: 60_000, minAgentAgeMs: 0, door, log: m => logs.push(m) })
  const api = door.apiFor('door-probe', own)
  api.requests.handle('ping', (args, ctx) => ({ pong: args, client: ctx.client }))
  const other = door.apiFor('other-probe', own)
  return { daemon, own, events: api.events, otherEvents: other.events }
}

test('door ext requests: the renderer asks its daemon half and hears its events', { timeout: 300_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit', env: { ...process.env, TETHER_TEST_EXTENSIONS: '1' } })
  assert.equal(build.status, 0, 'app build failed')
  const home = tempHome()
  const pipe = uniquePipe(home)
  const logs: string[] = []
  let side = await daemonWithProbe(home, pipe, logs)
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home, pipe))
    await page.waitForFunction(() => typeof window.__tether.ext?.['door-probe']?.extAsk === 'function')

    console.log('step 1')
    const asked = await probe<Asked>(page, 'extAsk', 'ping', { n: 1 })
    assert.deepEqual(asked, { ok: true, result: { pong: { n: 1 }, client: 'app' } })

    console.log('step 2')
    const missing = await probe<Asked>(page, 'extAsk', 'nope')
    assert.equal(missing.ok, false)
    assert.equal(missing.code, 'unknown-request')

    console.log('step 3')
    side.otherEvents.emit('tick', { n: 0 })
    side.events.emit('tick', { n: 1 })
    await until(async () => (await probe<unknown[]>(page, 'extHeard')).length >= 1, 10_000, 'the first tick was heard')
    await sleep(300)
    assert.deepEqual(await probe<unknown[]>(page, 'extHeard'), [{ n: 1 }], 'only the probe\'s own tick')

    console.log('step 4')
    await page.waitForSelector('#conn.on')
    await page.evaluate(() => { (window as unknown as { __before?: true }).__before = true })
    side.own.dispose()
    await side.daemon.close()
    await page.waitForSelector('#conn:not(.on)', { timeout: 30_000 })
    side = await daemonWithProbe(home, pipe, logs)
    // A lost connection reloads the page on the next one (app/main/main.ts, reloadOnReconnect): the probe activates again and
    // its listener is the one registered by the new page. Wait for the reload, then emit until it hears.
    await page.waitForFunction(() => !(window as unknown as { __before?: true }).__before && typeof window.__tether?.ext?.['door-probe']?.extHeard === 'function', undefined, { timeout: 60_000 })
    await page.waitForSelector('#conn.on', { timeout: 60_000 })
    await until(async () => {
      side.events.emit('tick', { n: 2 })
      await sleep(200)
      return (await probe<unknown[]>(page, 'extHeard')).length >= 1
    }, 15_000, 'the tick after the reconnection was heard')
    const after = await probe<unknown[]>(page, 'extHeard')
    assert.ok(after.length >= 1 && after.every(p => JSON.stringify(p) === '{"n":2}'), `only ticks of the new daemon (${JSON.stringify(after)})`)
    assert.deepEqual(await probe<Asked>(page, 'extAsk', 'ping', 'again'), { ok: true, result: { pong: 'again', client: 'app' } })
  } finally {
    if (app) await killElectron(app, root).catch(() => {})
    side.own.dispose()
    await side.daemon.close()
    await removeHome(home)
  }
})
