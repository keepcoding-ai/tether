// E2E of the geometry-first restore: the app paints every pane of layout.json before the daemon answers,
// each pane shows its loading stage, then its terminal; a pane whose folder is gone shows its error while
// the others load. The daemon's answer is held back by a proxy on the app's pipe (the real tetherd sits on
// a second pipe): the proxy accepts at once and forwards nothing for HOLD_MS, under the client's 5 s hello
// timeout, so the app neither fails nor spawns a daemon of its own.
// Own home and pipes; hidden window (TETHER_E2E_HIDDEN=1); kills by identity only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { connect, createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type Hooks = {
  panelIds(): string[]
  slots(): SlotState[]
  text(id: string): string
  connection(): { connected: boolean; pid?: number } | undefined
  openSlot(id: string): void
  activate(id: string): void
}
type El = { dataset: Record<string, string>; hidden: boolean; textContent: string | null; querySelector(s: string): El | null }
declare const window: {
  __tether: Hooks
  tether: { request(body: unknown): Promise<{ t: 'ok'; slot?: SlotState } | { t: 'error'; code: string; message: string }> }
}
declare const document: { querySelectorAll(selector: string): ArrayLike<El> & Iterable<El>; querySelector(selector: string): El | null }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const artifacts = join(root, 'test', 'e2e', 'artifacts')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const daemonPipe = `\\\\.\\pipe\\tether-restoretest-d-${process.pid}`
const appPipe = `\\\\.\\pipe\\tether-restoretest-a-${process.pid}`
const HOLD_MS = 3_500

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

async function launch(home: string, pipe: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_') && !k.startsWith('CLAUDE')) env[k] = v
  delete env.TETHER_CLAUDE_ARGS
  env.TETHER_PIPE = pipe
  env.TETHER_HOME = home
  env.TETHER_E2E_HIDDEN = '1'
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10_000)
  page.on('console', m => { if (m.type() === 'error') console.log(`renderer console: ${m.text()}`) })
  return { app, page }
}

/** A pipe that accepts at once and forwards to the daemon only after `release()`. */
function holdingProxy(): { release(): void; released(): boolean; close(): void } {
  let released = false
  const waiting: Array<() => void> = []
  const sockets: Socket[] = []
  const server = createServer(client => {
    sockets.push(client)
    client.pause()
    const go = (): void => {
      const upstream = connect(daemonPipe)
      sockets.push(upstream)
      upstream.on('error', () => client.destroy())
      client.on('error', () => upstream.destroy())
      client.pipe(upstream); upstream.pipe(client)
      client.resume()
    }
    if (released) go(); else waiting.push(go)
  })
  server.listen(appPipe)
  return {
    release: () => { released = true; for (const go of waiting.splice(0)) go() },
    released: () => released,
    close: () => { for (const s of sockets) s.destroy(); server.close() },
  }
}

test('restore: panes painted before the daemon answers, loading stages, then terminals; a missing folder errors alone', async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(artifacts, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-restoretest-'))
  const gone = mkdtempSync(join(tmpdir(), 'tether-restoretest-gone-'))
  let daemon: Owned | undefined
  let app: ElectronApplication | undefined
  let proxy: ReturnType<typeof holdingProxy> | undefined
  try {
    // ---- 1. a layout with three shells (one in a folder about to vanish), saved by the app itself ----
    let page: Page
    ;({ app, page } = await launch(home, daemonPipe))
    await page.waitForSelector('#conn.on', { timeout: 30_000 })
    const daemonPid = (await page.evaluate(() => window.__tether.connection()))!.pid!
    daemon = await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' })
    const ids: string[] = []
    // Through the chooser, side by side: every pane is mounted (dockview only mounts the active tab of a group).
    for (const [i, cwd] of [root, root, gone].entries()) {
      const before = await page.evaluate(() => window.__tether.panelIds())
      await page.click('#btn-new')
      await page.waitForSelector('#dlg-new[open]')
      await page.fill('#dlg-new .ch-path-input', cwd)
      if (i > 0) { await page.click('#dlg-new .where-sum'); await page.click('#dlg-new .placement[data-level="pane"][data-placement="right"]') }
      await page.click('#dlg-new .ch-item[data-id=\"powershell\"]')
      await page.waitForFunction(() => document.querySelectorAll('#dlg-new[open]').length === 0)
      await page.waitForFunction(n => window.__tether.panelIds().length === n, before.length + 1)
      ids.push((await page.evaluate(() => window.__tether.panelIds())).find(id => !before.includes(id))!)
    }
    const goneId = ids[2]!
    const okIds = ids.slice(0, 2)
    await page.waitForFunction(ids => ids.every(id => window.__tether.slots().find(s => s.slotId === id)?.status === 'running'), ids, { timeout: 20_000 })
    const stop = await page.evaluate(id => window.tether.request({ t: 'stop', slotId: id }), goneId)
    assert.equal(stop.t, 'ok', JSON.stringify(stop))
    await page.waitForFunction(id => window.__tether.slots().find(s => s.slotId === id)?.status === 'exited', goneId, { timeout: 20_000 })
    await sleep(800) // the debounced layout save
    await killElectron(app, root)
    app = undefined
    for (let i = 0; ; i++) {
      try { rmSync(gone, { recursive: true, force: true }); break } catch (e) { if (i > 20) throw e; await sleep(250) }
    }

    // ---- 2. relaunch through the holding proxy: the geometry comes first ----
    proxy = holdingProxy()
    ;({ app, page } = await launch(home, appPipe))
    await page.waitForFunction(n => document.querySelectorAll('.panel[data-slot-id]').length === n, ids.length, { timeout: 15_000 })
    assert.equal(proxy.released(), false, 'the panes exist before the daemon could answer')
    assert.equal(await page.evaluate(() => window.__tether.connection()), undefined, 'no daemon connection yet')
    const early = await page.evaluate(() => [...document.querySelectorAll('.panel[data-slot-id]')].map(p => {
      const l = p.querySelector('.panel-loading')
      return { id: p.dataset.slotId!, stage: l && !l.hidden ? l.dataset.stage : undefined, text: l?.textContent ?? '', cwd: p.querySelector('.status-bar .info-cwd')?.textContent ?? '' }
    }))
    assert.deepEqual(early.map(e => e.id).sort(), [...ids].sort(), 'every pane of the layout is in the DOM')
    for (const e of early) {
      assert.equal(e.stage, 'connecting', `pane ${e.id} shows the connecting stage`)
      assert.match(e.text, /Conectando ao serviço/)
      assert.ok(e.cwd.length > 0, `pane ${e.id} paints its folder from the layout hint`)
    }
    assert.equal(await page.locator('.tether-tab').count(), ids.length, 'every tab is painted')
    await page.screenshot({ path: join(artifacts, 'restore-connecting.png') })

    proxy.release()
    await page.waitForSelector('#conn.on', { timeout: 30_000 })
    // The live panes lose their skeleton once their terminal has output; the gone one shows its error.
    for (const id of okIds) {
      await page.evaluate(id => window.__tether.activate(id), id)
      await page.waitForFunction(id => /PS.*>/.test(window.__tether.text(id).replace(/\s+/g, '')), id, { timeout: 20_000 })
      await page.waitForFunction(id => document.querySelector(`.panel[data-slot-id="${id}"] .panel-loading`)?.hidden === true, id, { timeout: 5_000 })
    }
    await page.evaluate(id => window.__tether.activate(id), goneId)
    await page.waitForFunction(id => {
      const p = document.querySelector(`.panel[data-slot-id="${id}"]`)
      const o = p?.querySelector('.panel-overlay')
      return !!o && !o.hidden && /A pasta não existe mais/.test(o.textContent ?? '') && p?.querySelector('.panel-loading')?.hidden === true
    }, goneId, { timeout: 20_000 })
    assert.ok(await page.locator(`.panel[data-slot-id="${goneId}"] button[data-action="pick-folder"]`).count() === 1, 'the error keeps its actions')
    await page.screenshot({ path: join(artifacts, 'restore-done.png') })
    assert.deepEqual([...(await page.evaluate(() => window.__tether.panelIds()))].sort(), [...ids].sort(), 'no pane lost')
  } finally {
    if (app) await killElectron(app, root).catch(() => {})
    proxy?.close()
    if (daemon) await killOwned(daemon)
    await sleep(500)
    rmSync(home, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 })
    rmSync(gone, { recursive: true, force: true })
  }
})
