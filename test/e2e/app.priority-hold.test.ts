// E4.1 E2E: the app holds its renderer at ABOVE_NORMAL. The test knocks the renderer down to Normal and it must be back in < 500 ms,
// with the fall counted in `perf:get` renderer.priorityDrops. Real app on a private home/pipe, hidden window.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { constants, getPriority, setPriority, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import type { PerfGet } from '../../app/shared/api.ts'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'
import { stopPtyd } from './ptyd-driver.ts'

declare const window: { tether: { perfGet(): Promise<PerfGet> }; __tether: { connection(): { pid?: number } | undefined } }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const pipe = `\\\\.\\pipe\\tether-perfprio-${process.pid}`
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}
const perfGet = (page: Page): Promise<PerfGet> => page.evaluate(() => window.tether.perfGet())

test('the renderer knocked to Normal is back at ABOVE_NORMAL in < 500 ms', async () => {
  const home = mkdtempSync(join(tmpdir(), 'tether-perfprio-'))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_') && !k.toUpperCase().startsWith('CLAUDE')) env[k] = v
    env.TETHER_PIPE = pipe; env.TETHER_HOME = home; env.TETHER_E2E_HIDDEN = '1'
    app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
    const page = await app.firstWindow()
    page.setDefaultTimeout(15_000)
    page.on('pageerror', e => console.error('renderer error: ' + e.message)); page.on('console', m => { if (m.type() === 'error') console.error('console: ' + m.text()) })
    await page.waitForSelector('#conn.on', { timeout: 30_000 }).catch(async e => { console.error('conn:', await page.evaluate(() => document.querySelector('#conn')?.className + ' / ' + document.body.innerText.slice(0, 300)).catch(x => String(x))); throw e })
    const daemonPid = (await page.evaluate(() => window.__tether.connection()))?.pid
    assert.ok(daemonPid && pidAlive(daemonPid), 'the app spawned a tetherd')
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))

    const above = constants.priority.PRIORITY_ABOVE_NORMAL
    let pid = 0
    for (let i = 0; i < 40 && !pid; i++) { pid = (await perfGet(page)).renderer?.pid ?? 0; if (!pid) await sleep(250) }
    assert.ok(pid > 0, 'renderer pid known')
    for (let i = 0; i < 20 && getPriority(pid) !== above; i++) await sleep(250)
    assert.equal(getPriority(pid), above, 'the renderer starts raised')

    const dropsBefore = (await perfGet(page)).renderer?.priorityDrops ?? 0
    setPriority(pid, constants.priority.PRIORITY_NORMAL)
    assert.equal(getPriority(pid), constants.priority.PRIORITY_NORMAL)
    const t0 = performance.now()
    while (getPriority(pid) !== above && performance.now() - t0 < 2000) await sleep(20)
    const back = performance.now() - t0
    console.log(`renderer back to ABOVE_NORMAL in ${Math.round(back)} ms`)
    assert.ok(back < 500, `back in ${Math.round(back)} ms`)
    assert.ok(((await perfGet(page)).renderer?.priorityDrops ?? 0) >= dropsBefore + 1, 'the fall is counted')
  } finally {
    if (app) await killElectron(app, root).catch(e => console.error(String(e)))
    await stopPtyd(home).catch(e => console.error(String(e)))
    for (const d of daemons) await killOwned(d, { tree: true })
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && daemons.some(d => pidAlive(d.pid))) await sleep(200)
    for (let i = 0; i < 5; i++) { try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(300) } }
  }
})
