// E2E of the daemon's place in the process tree (PRD §12: "tetherd é um processo separado e destacado da janela"):
//   1. open → the tetherd the app spawned is NOT a descendant of the Electron main process and its parent is
//      already dead (it was started through a short-lived intermediate, outside any tree a kill could walk);
//   2. two shell panels → `taskkill /PID <electron main> /T /F` (what Task Manager's "End task" does) → the
//      daemon and both shells are still alive, checked by identity (pid + creation time);
//   3. relaunch → same daemon, same slots, same shell pids, scrollback intact;
//   4. `app.close()` returns promptly while the daemon lives: the daemon inherited none of the app's handles
//      (before: it held Playwright's CDP pipe and close() hung until the daemon died).
// Windows stay hidden (TETHER_E2E_HIDDEN=1).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { DaemonClient } from '../../src/daemon/client.ts'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { claim, killOwned, stillOurs, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'
import { processTree } from './harness.ts'

type Hooks = {
  panelIds(): string[]
  slots(): SlotState[]
  text(id: string): string
  connection(): { connected: boolean; pid?: number } | undefined
  activate(id: string): void
}
declare const window: { __tether: Hooks }
declare const document: { querySelectorAll(selector: string): { length: number } }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const pipe = `\\\\.\\pipe\\tether-apptree-${process.pid}`

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

async function launch(home: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_')) env[k] = v
  env.TETHER_PIPE = pipe
  env.TETHER_HOME = home
  env.TETHER_E2E_HIDDEN = '1'
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10_000)
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  return { app, page }
}

async function createShellPanel(page: Page, cwd: string): Promise<void> {
  const before = await page.locator('.tether-tab').count()
  await page.click('#btn-new')
  await page.waitForSelector('#dlg-new[open]')
  await page.check('input[name=kind][value=shell]')
  await page.fill('#new-cwd', cwd)
  await page.click('#btn-create')
  await page.waitForFunction(n => document.querySelectorAll('.tether-tab').length === n, before + 1)
}

async function waitRunning(page: Page, ids: string[]): Promise<Map<string, number>> {
  await page.waitForFunction(ids => {
    const slots = window.__tether.slots()
    return ids.every(id => { const s = slots.find(x => x.slotId === id); return s?.status === 'running' && typeof s.pid === 'number' })
  }, ids, { timeout: 20_000 })
  const pids = new Map<string, number>()
  for (const s of await page.evaluate(() => window.__tether.slots())) if (ids.includes(s.slotId)) pids.set(s.slotId, s.pid!)
  return pids
}

async function typeEcho(page: Page, id: string, n: number): Promise<void> {
  await page.evaluate(id => window.__tether.activate(id), id)
  await page.waitForFunction(id => /PS.*>/.test(window.__tether.text(id).replace(/\s+/g, '')), id, { timeout: 20_000 })
  await page.locator(`.panel[data-slot-id="${id}"] .panel-term`).click()
  await page.keyboard.type(`echo tether-${n}`)
  await page.keyboard.press('Enter')
  await page.waitForFunction(([id, n]) => new RegExp(`(^|\\n)tether-${n}\\s*(\\n|$)`).test(window.__tether.text(id)), [id, String(n)] as const, { timeout: 10_000 })
}

function parentPid(pid: number): Promise<number> {
  return new Promise((res, rej) => execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').ParentProcessId`],
    { windowsHide: true }, (e, so) => (e ? rej(e) : res(Number.parseInt(so.trim(), 10)))))
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

test('app + tetherd: the daemon is outside the app tree: End task (taskkill /T) on the app leaves daemon and shells alive; relaunch reattaches', async t => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  const home = mkdtempSync(join(tmpdir(), 'tether-apptree-'))
  let daemon: Owned | undefined
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    const daemonPid = (await page.evaluate(() => window.__tether.connection()))!.pid!
    daemon = await claim(daemonPid, { cmdIncludes: join(root, 'src', 'daemon', 'main.ts'), what: 'tetherd' })

    // ---- 1. not in the app's tree; parent already dead ----
    const mainPid = await app.evaluate(() => process.pid)
    const tree = await processTree(mainPid)
    assert.ok(tree.length >= 1 && !tree.some(p => p.pid === daemonPid), `tetherd ${daemonPid} is not a descendant of electron main ${mainPid} (tree: ${tree.map(p => `${p.pid} ${p.name}`).join(', ')})`)
    const ppid = await parentPid(daemonPid)
    assert.ok(!pidAlive(ppid), `tetherd's parent pid ${ppid} is gone`)
    t.diagnostic(`tetherd ${daemonPid}: parent ${ppid} (dead), electron main ${mainPid} tree of ${tree.length}`)

    await createShellPanel(page, root)
    await createShellPanel(page, root)
    const ids = await page.evaluate(() => window.__tether.panelIds())
    assert.equal(ids.length, 2)
    const pids = await waitRunning(page, ids)
    const shells: Owned[] = []
    for (const [id, pid] of pids) shells.push(await claim(pid, { what: `shell of ${id}` }))
    for (const [i, id] of ids.entries()) await typeEcho(page, id, i + 1)
    await sleep(800) // debounced layout save

    // ---- 2. End task on the app: the whole electron tree goes; daemon and shells stay ----
    await killElectron(app, root, { tree: true })
    app = undefined
    await sleep(1000)
    assert.ok(await stillOurs(daemon), 'tetherd survived taskkill /T of the app (same pid and creation time)')
    for (const s of shells) assert.ok(await stillOurs(s), `shell pid ${s.pid} survived taskkill /T of the app`)

    // ---- 3. relaunch: same daemon, same slots, same shells, scrollback ----
    ;({ app, page } = await launch(home))
    assert.equal((await page.evaluate(() => window.__tether.connection()))?.pid, daemonPid, 'reconnected to the same tetherd')
    await page.waitForFunction(() => document.querySelectorAll('.tether-tab').length === 2, undefined, { timeout: 10_000 })
    const pidsAfter = await waitRunning(page, ids)
    assert.deepEqual([...pidsAfter].sort(), [...pids].sort(), 'same shell pids')
    for (const [i, id] of ids.entries()) {
      await page.evaluate(id => window.__tether.activate(id), id)
      await page.waitForFunction(([id, n]) => new RegExp(`tether-${n}`).test(window.__tether.text(id)), [id, String(i + 1)] as const, { timeout: 10_000 })
    }

    // ---- 4. the daemon holds nothing of the app's: a graceful close returns while the daemon lives ----
    const t0 = Date.now()
    const closing = app
    app = undefined
    await Promise.race([closing.close(), sleep(20_000).then(() => { throw new Error('app.close() hung: something still holds the app\'s pipes (the daemon inherited a handle?)') })])
    t.diagnostic(`app.close() returned in ${Date.now() - t0} ms with tetherd alive`)
    assert.ok(await stillOurs(daemon), 'tetherd still alive after the app closed gracefully')
  } finally {
    if (app) await killElectron(app, root).catch(() => {})
    if (daemon && await stillOurs(daemon)) {
      try {
        const client = await DaemonClient.connect({ home, pipe, client: 'test', spawn: false })
        await client.request({ t: 'shutdown' }).catch(() => {})
        client.close()
        const deadline = Date.now() + 15_000
        while (await stillOurs(daemon) && Date.now() < deadline) await sleep(300)
      } catch { /* not answering */ }
      await killOwned(daemon, { tree: true })
    }
    for (let i = 0; i < 5; i++) { try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(300) } }
  }
})
