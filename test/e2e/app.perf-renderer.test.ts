// E2E of the renderer's always-on ruler (E4.0), against the real app on a private home/pipe, hidden window:
//   1. typing in a shell pane shows up in `perf:get` `renderer.echo` by pane kind (renderer: key -> first data;
//      main: input notice -> first data), and the heartbeat and the priority samples are running;
//   2. a 3 s busy loop injected into the page is an incident in `renderer.incidents`.
// Every kill goes through test/kill.ts (pid + creation time); the tether-ptyd of the test home goes through stopPtyd.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import type { PerfGet } from '../../app/shared/api.ts'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'
import { stopPtyd } from './ptyd-driver.ts'

declare const window: { tether: { request(b: unknown): Promise<{ t: string; slot?: { slotId: string } }>; perfGet(): Promise<PerfGet> }; __tether: { connection(): { pid?: number } | undefined; openSlot(id: string): void } }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const pipe = `\\\\.\\pipe\\tether-perfrend-${process.pid}`
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}
const perfGet = (page: Page): Promise<PerfGet> => page.evaluate(() => window.tether.perfGet())

test('renderer ruler: echo by pane kind, heartbeat, priority, and a 3 s loop as an incident', async () => {
  const home = mkdtempSync(join(tmpdir(), 'tether-perfrend-'))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_') && !k.toUpperCase().startsWith('CLAUDE')) env[k] = v
    env.TETHER_PIPE = pipe; env.TETHER_HOME = home; env.TETHER_E2E_HIDDEN = '1'
    app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
    const page = await app.firstWindow()
    page.setDefaultTimeout(15_000)
    page.on('pageerror', e => console.error('renderer error: ' + e.message))
    page.on('console', m => { if (m.type() === 'error') console.error('console: ' + m.text()) })
    await page.waitForSelector('#conn.on', { timeout: 30_000 }).catch(async e => { console.error('conn:', await page.evaluate(() => document.querySelector('#conn')?.className + ' / ' + document.body.innerText.slice(0, 300)).catch(x => String(x))); throw e })
    const daemonPid = (await page.evaluate(() => window.__tether.connection()))?.pid
    assert.ok(daemonPid && pidAlive(daemonPid), 'the app spawned a tetherd')
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))

    const made = await page.evaluate(cwd => window.tether.request({ t: 'create', kind: 'shell', cwd, start: true }), home)
    assert.equal(made.t, 'ok')
    const slotId = made.slot!.slotId
    await page.evaluate(id => window.__tether.openSlot(id), slotId)
    await page.waitForSelector(`.panel[data-slot-id="${slotId}"]`)
    const input = page.locator('.xterm-helper-textarea').first()
    await input.waitFor({ state: 'attached' })
    await sleep(3000) // the shell prints its banner and prompt
    await input.focus()
    for (let i = 0; i < 25; i++) { await page.keyboard.type('a'); await sleep(90) }

    // 1. echo by kind (the renderer's summary goes out every 5 s)
    let got: PerfGet | undefined
    for (let i = 0; i < 40; i++) {
      got = await perfGet(page)
      if ((got.renderer?.echo.renderer?.byKind.shell.count ?? 0) >= 15) break
      await sleep(500)
    }
    const r = got!.renderer!
    assert.ok(r, 'perf:get carries the renderer field')
    assert.ok((r.echo.renderer?.byKind.shell.count ?? 0) > 0, 'renderer-side shell echo recorded')
    assert.ok(r.echo.main.byKind.shell.count > 0, 'main-side shell echo recorded')
    assert.equal(r.echo.renderer?.byKind.agent.count, 0)
    assert.ok(r.heartbeat.count >= 1 && r.heartbeat.lastMs !== null, 'heartbeat answered')
    assert.ok(r.priorities.length >= 1, 'priority sampled')
    assert.ok(r.pid && r.pid > 0)
    assert.ok(r.summaries.length >= 1)
    console.log('renderer view:', JSON.stringify({ pid: r.pid, priority: r.priority, heartbeat: r.heartbeat, echo: { renderer: r.echo.renderer?.byKind, main: r.echo.main.byKind }, input: r.summaries.at(-1)?.input }))

    // 2. a 3 s loop in the page
    const before = (await perfGet(page)).renderer!.incidents.length
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.executeJavaScript('(() => { const t = performance.now(); while (performance.now() - t < 3000); return 1 })()'))
    let incidents = (await perfGet(page)).renderer!.incidents
    for (let i = 0; i < 20 && incidents.length === before; i++) { await sleep(300); incidents = (await perfGet(page)).renderer!.incidents }
    const slow = incidents.slice(before).filter(x => x.ms >= 2500)
    console.log('incidents:', JSON.stringify(incidents.slice(before)))
    assert.ok(slow.length >= 1, 'the 3 s loop is an incident of >= 2.5 s')
  } finally {
    if (app) await killElectron(app, root).catch(e => console.error(String(e)))
    await stopPtyd(home).catch(e => console.error(String(e)))
    for (const d of daemons) await killOwned(d, { tree: true })
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && daemons.some(d => pidAlive(d.pid))) await sleep(200)
    for (let i = 0; i < 5; i++) { try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(300) } }
  }
})
