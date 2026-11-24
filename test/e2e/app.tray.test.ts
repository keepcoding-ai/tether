// E2E of the system tray behaviour (hidden windows, private home/pipe, shell slots only). The tray menu itself is
// native and cannot be clicked, so main exposes `(globalThis as unknown as G).__tetherTray`: the same functions the menu items call.
//   1. the tray exists and its model follows the slots (one running pane);
//   2. closing the window (X) shows the in-app notice once, then destroys the window: the app process and the
//      daemon stay alive; a later close hides without asking;
//   3. "Abrir" (tray) recreates the window: same slots, same daemon, same shell PID, scrollback intact;
//      opening with a pane focuses it;
//   4. a second launch while hidden brings the window back (and exits);
//   5. "Reiniciar serviço" asks in the app's dialog, then the daemon is replaced and the panels come back;
//   6. "Sair (manter agentes)" ends the app while tetherd and the pane survive.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { DaemonClient } from '../../src/daemon/client.ts'
import { claim, killOwned, type Owned } from '../kill.ts'
import { guardAppEnv } from './app-env.ts'
import { killElectron } from './electron.ts'

type Hooks = {
  panelIds(): string[]
  activeId(): string | undefined
  slots(): SlotState[]
  text(id: string): string
  connection(): { connected: boolean; pid?: number } | undefined
  activate(id: string): void
}
declare const window: { __tether: Hooks }
declare const document: { querySelectorAll(selector: string): { length: number } }
type TrayHook = {
  windowOpen(): boolean
  hasTray(): boolean
  model(): { running: number; badge: string; tooltip: string; items: Array<{ kind: string; slotId?: string; label?: string }> }
  open(slotId?: string): Promise<void>
  toggle(): void
  command(id: string): void
}
type G = { __tetherTray: TrayHook }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-apptray-${process.pid}`

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

async function waitUntil(cond: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timeout (${timeoutMs} ms) waiting for ${what}`)
    await sleep(100)
  }
}

function appEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_')) env[k] = v
  env.TETHER_PIPE = pipe
  env.TETHER_HOME = home
  env.TETHER_E2E_HIDDEN = '1'
  env.TETHER_TRAY = '1' // this is the one suite that exercises the tray: it opts back in
  return env
}

async function ready(page: Page): Promise<Page> {
  page.setDefaultTimeout(10_000)
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  return page
}

const tray = {
  windowOpen: (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as G).__tetherTray.windowOpen()),
  model: (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as G).__tetherTray.model()),
  /** Calls the hook that opens the window and returns the new window's page (the listener is armed first). */
  async open(app: ElectronApplication, slotId?: string): Promise<Page> {
    const next = app.waitForEvent('window', { timeout: 30_000 })
    await app.evaluate((_, id) => (globalThis as unknown as G).__tetherTray.open(id), slotId)
    return ready(await next)
  },
  /** The window's own close button path (BrowserWindow.close → the 'close' event main intercepts). */
  close: (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.close() }),
}

async function createShellPanel(page: Page, cwd: string, count: number): Promise<void> {
  await page.click('#btn-new')
  await page.waitForSelector('#dlg-new[open]')
  await page.fill('#dlg-new .ch-path-input', cwd)
  await page.click('#dlg-new .ch-item[data-id=\"powershell\"]')
  await page.click('#dlg-new .btn.primary.go') // two steps: the click selects, the button opens
  await page.waitForFunction(() => document.querySelectorAll('#dlg-new[open]').length === 0)
  await page.waitForFunction(n => document.querySelectorAll('.tether-tab').length === n, count)
  await page.waitForFunction(() => {
    const id = window.__tether.panelIds().at(-1)!
    return /PS.*>/.test(window.__tether.text(id).replace(/\s+/g, ''))
  }, undefined, { timeout: 20_000 })
}

const slotsOf = (page: Page) => page.evaluate(() => window.__tether.slots())
const idsOf = (page: Page) => page.evaluate(() => window.__tether.panelIds())
const daemonPidOf = async (page: Page) => (await page.evaluate(() => window.__tether.connection()))?.pid

test('tray: close hides to the tray (app + daemon alive), Abrir restores, restart service, Sair mantendo agentes', async t => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  const home = mkdtempSync(join(tmpdir(), 'tether-apptray-'))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env: appEnv(home) })
    let page = await ready(await app.firstWindow())
    const mainPid = await app.evaluate(() => process.pid)
    const daemonPid = (await daemonPidOf(page))!
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))

    // ---- 1. the tray model follows the slots ----
    assert.equal(await app.evaluate(() => (globalThis as unknown as G).__tetherTray.hasTray()), true, 'the tray icon exists')
    await createShellPanel(page, root, 1)
    await createShellPanel(page, root, 2)
    const ids = await idsOf(page)
    assert.equal(ids.length, 2)
    await waitUntil(async () => (await tray.model(app!)).running === 2, 10_000, 'the tray to count 2 running')
    const model = await tray.model(app)
    assert.equal(model.badge, 'active')
    assert.equal(model.tooltip, 'Tether: 2 agentes rodando')
    assert.deepEqual(model.items.filter(i => i.kind === 'pane').map(i => i.slotId).sort(), [...ids].sort())
    const shellPids = new Map((await slotsOf(page)).map(s => [s.slotId, s.pid]))
    await page.evaluate(id => window.__tether.activate(id), ids[1]!)
    await sleep(800) // the debounced layout save

    // ---- 2. close (X): the notice once, then the window is gone and everything else lives ----
    await tray.close(app)
    await page.locator('dialog.ask[data-dialog="tray-first-close"][open]').waitFor()
    await page.locator('button.choice[data-choice="ok"]').click()
    await waitUntil(async () => !(await tray.windowOpen(app!)), 5_000, 'the window to be destroyed')
    assert.equal(JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')).trayNoticeShown, true, 'the notice is remembered')
    assert.equal(await app.evaluate(() => process.pid), mainPid, 'the app process is still the same')
    assert.ok(pidAlive(daemonPid), 'the daemon is alive')
    assert.equal((await tray.model(app)).running, 2, 'the tray still follows the daemon with no window')

    // ---- 3. Abrir: the window comes back with the panes intact ----
    page = await tray.open(app)
    await page.waitForFunction(() => document.querySelectorAll('.tether-tab').length === 2, undefined, { timeout: 15_000 })
    assert.deepEqual([...(await idsOf(page))].sort(), [...ids].sort(), 'same slots')
    assert.equal(await daemonPidOf(page), daemonPid, 'the same tetherd')
    for (const s of await slotsOf(page)) assert.equal(s.pid, shellPids.get(s.slotId), `same shell pid for ${s.slotId}`)
    await page.waitForFunction(id => /PS.*>/.test(window.__tether.text(id).replace(/\s+/g, '')), ids[0]!, { timeout: 15_000 })
    assert.equal(await page.evaluate(() => window.__tether.activeId()), ids[1], 'the active pane was restored')

    // ---- 3b. a later close hides without asking; opening on a pane focuses it ----
    await tray.close(app)
    await waitUntil(async () => !(await tray.windowOpen(app!)), 5_000, 'the second close to hide with no notice')
    page = await tray.open(app, ids[0]!)
    await page.waitForFunction(id => window.__tether.activeId() === id, ids[0]!, { timeout: 15_000 })

    // ---- 4. a second launch while hidden brings the window back ----
    await tray.close(app)
    await waitUntil(async () => !(await tray.windowOpen(app!)), 5_000, 'the window to hide again')
    const next = app.waitForEvent('window', { timeout: 30_000 })
    const second = spawn(electronPath, [mainPath], { env: guardAppEnv(appEnv(home)), stdio: 'ignore', windowsHide: true })
    const secondExit = new Promise<number | null>(res => second.once('exit', code => res(code)))
    page = await ready(await next)
    assert.equal(await secondExit, 0, 'the second launch exited at once')
    assert.equal(await tray.windowOpen(app), true)
    assert.equal(await daemonPidOf(page), daemonPid)

    // ---- 5. Reiniciar serviço: asks first, then the daemon is replaced and the panels return ----
    await app.evaluate(() => { (globalThis as unknown as G).__tetherTray.command('restart-daemon') })
    await page.locator('dialog.ask[data-dialog="restart-daemon"][open]').waitFor()
    await page.locator('button.choice[data-choice="restart"]').click()
    await waitUntil(async () => { const p = await daemonPidOf(page); return p !== undefined && p !== daemonPid }, 30_000, 'a new tetherd')
    const newDaemonPid = (await daemonPidOf(page))!
    daemons.push(await claim(newDaemonPid, { cmdIncludes: daemonMain, what: 'new tetherd' }))
    await waitUntil(() => !pidAlive(daemonPid), 10_000, 'the old tetherd to exit')
    await page.waitForFunction(ids => {
      const slots = window.__tether.slots()
      return ids.every(id => slots.find(s => s.slotId === id)?.status === 'running')
    }, ids, { timeout: 30_000 })
    assert.deepEqual([...(await idsOf(page))].sort(), [...ids].sort(), 'the panels came back')

    // ---- 6. Sair (manter agentes): the app ends, tetherd and the panes live ----
    const survivors = new Map((await slotsOf(page)).map(s => [s.slotId, s.pid]))
    const closed = app.waitForEvent('close', { timeout: 30_000 })
    await app.evaluate(() => { (globalThis as unknown as G).__tetherTray.command('quit-keep') }).catch(() => {})
    await closed
    app = undefined
    await waitUntil(() => !pidAlive(mainPid), 15_000, 'the app process to exit')
    assert.ok(pidAlive(newDaemonPid), 'tetherd survived the app')
    const probe = await DaemonClient.open(pipe, 'test')
    try {
      const list = await probe.request({ t: 'list' })
      const after = new Map<string, number | undefined>((list.slots ?? []).map(s => [s.slotId, s.status === 'running' ? s.pid : undefined]))
      for (const [id, pid] of survivors) assert.equal(after.get(id), pid, `pane ${id} still running with the same pid`)
    } finally {
      probe.close()
    }
    t.diagnostic(`app ${mainPid} quit, tetherd ${newDaemonPid} kept ${survivors.size} panes`)
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

/** "Sair" from the tray while the window is hidden (its usual state): the app process must end and leave no tray behind. */
for (const mode of ['quit-keep', 'quit-all'] as const) {
  test(`tray: "${mode === 'quit-keep' ? 'Sair (manter agentes)' : 'Sair e encerrar tudo'}" with the window hidden ends the app process`, async () => {
    const home = mkdtempSync(join(tmpdir(), 'tether-apptray-'))
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ trayNoticeShown: true })) // no first-close notice in the way
    const daemons: Owned[] = []
    let app: ElectronApplication | undefined
    try {
      app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env: appEnv(home) })
      const page = await ready(await app.firstWindow())
      const mainPid = await app.evaluate(() => process.pid)
      const daemonPid = (await daemonPidOf(page))!
      daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))
      assert.equal(await app.evaluate(() => (globalThis as unknown as G).__tetherTray.hasTray()), true, 'the tray icon exists')
      await createShellPanel(page, root, 1)
      await tray.close(app)
      await waitUntil(async () => !(await tray.windowOpen(app!)), 5_000, 'the window to hide')
      const closed = app.waitForEvent('close', { timeout: 30_000 })
      if (mode === 'quit-all') {
        const next = app.waitForEvent('window', { timeout: 30_000 })
        await app.evaluate(() => { (globalThis as unknown as G).__tetherTray.command('quit-all') }).catch(() => {})
        const p = await ready(await next)
        await p.locator('dialog.ask[data-dialog="quit-all"][open]').waitFor()
        await p.locator('button.choice[data-choice="quit"]').click()
      } else {
        await app.evaluate(() => { (globalThis as unknown as G).__tetherTray.command('quit-keep') }).catch(() => {})
      }
      await closed
      app = undefined
      await waitUntil(() => !pidAlive(mainPid), 15_000, 'the app process to exit (its tray icon goes with it)')
      if (mode === 'quit-all') await waitUntil(() => !pidAlive(daemonPid), 15_000, 'tetherd to exit')
      else assert.ok(pidAlive(daemonPid), 'tetherd survived the app')
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
}
