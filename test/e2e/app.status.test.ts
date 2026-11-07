// E2E of the top bar's status contribution point (F7 slice B1), against the real tetherd on a private home/pipe,
// hidden window. A test contribution is declared and registered through window.__tether.status:
//   1. its icon appears left of the connection icon, with the tooltip from title(), no badge at first;
//   2. update() redraws: a number badge, a dot, the states idle/normal/busy/warn/error colour the icon;
//   3. a click opens the popover the contribution renders (and re-renders it on update() while open);
//      a click outside and Esc close it; opening the connection popover closes it; two statuses never share a popover;
//   4. the order puts the lower `order` first; disposing the registration takes the icon away;
//   5. screenshots status-{light,dark}.png (the bar with the icon, badge and open popover).
// Every kill goes through test/kill.ts (pid + creation time).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type Probe = { state: string; badge: number | 'dot' | undefined; text: string; title: string; update(): void; dispose(): void }
type Reg = {
  declare(d: { id: string; icon: string; order?: number; extension: string }): unknown
  register(i: { id: string; title(): string; render(el: unknown): void; badge?(): number | 'dot' | undefined; state?(): string }): { update(): void; dispose(): void }
}
declare const window: { __tether: { status: Reg; connection(): { pid?: number } | undefined }; probes: Record<string, Probe> }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const artifacts = join(root, 'test', 'e2e', 'artifacts')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const pipe = `\\\\.\\pipe\\tether-status-${process.pid}`
const daemonMain = join(root, 'src', 'daemon', 'main.ts')

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

async function launch(home: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_') && !/^(CLAUDE|TETHER_|ATRIUM_)/i.test(k)) env[k] = v
  env.TETHER_PIPE = pipe
  env.TETHER_HOME = home
  env.TETHER_E2E_HIDDEN = '1'
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10_000)
  page.on('pageerror', e => console.error(`renderer error: ${e.message}`))
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800))
  return { app, page }
}

async function setTheme(page: Page, scheme: 'light' | 'dark'): Promise<void> {
  await page.click('#btn-theme')
  await page.waitForSelector('#theme-menu:not([hidden])')
  await page.click(`#theme-menu li[data-theme="${scheme}"]`)
  await page.waitForFunction(s => (document as unknown as { documentElement: { dataset: Record<string, string> } }).documentElement.dataset.theme === s, scheme)
  await sleep(300)
}

/** Declares and registers a controllable status; the page keeps its knobs in window.probes[id]. */
async function addStatus(page: Page, id: string, icon: string, order: number): Promise<void> {
  await page.evaluate(({ id, icon, order }) => {
    const w = window as unknown as { probes?: Record<string, Probe> }
    w.probes ??= {}
    const probe: Probe = { state: 'normal', badge: undefined, text: `popover de ${id}`, title: `Título de ${id}`, update: () => {}, dispose: () => {} }
    w.probes[id] = probe
    window.__tether.status.declare({ id, icon, order, extension: id.split('.')[0]! })
    const h = window.__tether.status.register({
      id,
      title: () => probe.title,
      render: el => { (el as { textContent: string }).textContent = probe.text },
      badge: () => probe.badge,
      state: () => probe.state,
    })
    probe.update = () => h.update()
    probe.dispose = () => h.dispose()
  }, { id, icon, order })
}

const set = (page: Page, id: string, patch: Partial<Probe>) => page.evaluate(({ id, patch }) => {
  const p = window.probes[id]!
  Object.assign(p, patch)
  p.update()
}, { id, patch })

async function shotWindowTop(app: ElectronApplication, name: string): Promise<void> {
  const b64 = await app.evaluate(async ({ BrowserWindow }) => {
    const img = await BrowserWindow.getAllWindows()[0]!.webContents.capturePage({ x: 700, y: 0, width: 580, height: 190 })
    return img.toPNG().toString('base64')
  })
  writeFileSync(join(artifacts, `${name}.png`), Buffer.from(b64, 'base64'))
}

test('status contribution point: icon, badge, state, popover (F7 B1)', async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(artifacts, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-status-'))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    const daemonPid = (await page.evaluate(() => window.__tether.connection()))?.pid
    assert.ok(daemonPid && pidAlive(daemonPid), 'the app spawned a tetherd')
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))

    // The web-bridge extension contributes its own icon (C4); the probes are the ones this test counts.
    assert.equal(await page.locator('.status-wrap[data-status^="probe."]').count(), 0, 'no probe icon before the contribution')

    await addStatus(page, 'probe.second', 'globe-simple', 20)
    await addStatus(page, 'probe.first', 'plugs-connected', 10)
    const first = page.locator('.status-wrap[data-status="probe.first"]')
    const second = page.locator('.status-wrap[data-status="probe.second"]')
    await first.waitFor()

    // 1. Left of the connection icon, ordered, tooltip from title(), no badge.
    const xs = await page.evaluate(() => {
      const d = (globalThis as unknown as { document: { querySelector(s: string): { getBoundingClientRect(): { left: number; right: number } } } }).document
      return [d.querySelector('[data-status="probe.first"]').getBoundingClientRect().right, d.querySelector('[data-status="probe.second"]').getBoundingClientRect().left, d.querySelector('#conn-wrap').getBoundingClientRect().left]
    })
    assert.ok(xs[0]! <= xs[1]! + 1 && xs[1]! < xs[2]!, `lower order first, both left of the connection icon: ${xs}`)
    assert.equal(await first.locator('.status-btn').getAttribute('title'), 'Título de probe.first')
    assert.equal(await first.locator('.status-badge').isHidden(), true)

    // 2. Badge and states follow update().
    await set(page, 'probe.first', { badge: 3, title: 'Três conectados' })
    assert.equal(await first.locator('.status-badge').textContent(), '3')
    assert.equal(await first.locator('.status-btn').getAttribute('title'), 'Três conectados')
    await set(page, 'probe.first', { badge: 'dot' })
    assert.equal(await first.locator('.status-badge.dot').count(), 1)
    const colors: Record<string, string> = {}
    for (const state of ['idle', 'normal', 'busy', 'warn', 'error']) {
      await set(page, 'probe.first', { state })
      assert.equal(await first.locator('.status-btn').getAttribute('data-state'), state)
      colors[state] = await first.locator('.status-btn').evaluate(el => `${getComputedStyle(el).color} ${getComputedStyle(el).opacity}`)
    }
    assert.equal(new Set(Object.values(colors)).size, 5, `five distinct colours: ${JSON.stringify(colors)}`)
    await set(page, 'probe.first', { badge: 3, state: 'normal', title: 'Três conectados' })

    // 3. Popover: click opens, re-renders on update(), outside click / Esc / the connection popover close it.
    const pop = first.locator('.status-pop')
    assert.equal(await pop.isVisible(), false)
    await first.locator('.status-btn').click()
    await pop.waitFor()
    assert.equal(await pop.textContent(), 'popover de probe.first')
    assert.equal(await first.locator('.status-btn').getAttribute('aria-expanded'), 'true')
    await set(page, 'probe.first', { text: 'mudou com o popover aberto' })
    assert.equal(await pop.textContent(), 'mudou com o popover aberto')
    await page.mouse.click(400, 400)
    await pop.waitFor({ state: 'hidden' })
    assert.equal(await first.locator('.status-btn').getAttribute('aria-expanded'), 'false')
    await first.locator('.status-btn').click()
    await pop.waitFor()
    await page.keyboard.press('Escape')
    await pop.waitFor({ state: 'hidden' })
    await first.locator('.status-btn').click()
    await pop.waitFor()
    await second.locator('.status-btn').click()
    await second.locator('.status-pop').waitFor()
    assert.equal(await pop.isVisible(), false, 'one popover at a time')
    await page.click('#conn')
    await second.locator('.status-pop').waitFor({ state: 'hidden' })
    assert.equal(await page.locator('#conn-wrap.pinned').count(), 1, 'the connection popover is open')
    await page.mouse.click(400, 400)
    await first.locator('.status-btn').click()
    assert.equal(await page.locator('#conn-wrap.pinned').count(), 0, 'opening a status closes the connection popover')
    await page.mouse.click(400, 400)

    // 4. Disposing the registration takes the icon away.
    await page.evaluate(() => window.probes['probe.second']!.dispose())
    await second.waitFor({ state: 'detached' })
    assert.equal(await page.locator('.status-wrap[data-status^="probe."]').count(), 1)

    // 5. Screenshots: icon, badge, amber state and open popover, in both themes.
    await set(page, 'probe.first', { state: 'warn', badge: 3, text: 'Tether Bridge pausado' })
    for (const scheme of ['light', 'dark'] as const) {
      await setTheme(page, scheme)
      await first.locator('.status-btn').click()
      await pop.waitFor()
      await page.mouse.move(100, 400)
      await sleep(150)
      await shotWindowTop(app, `status-${scheme}`)
      await page.mouse.click(400, 400)
      await pop.waitFor({ state: 'hidden' })
    }
  } finally {
    if (app) await killElectron(app, root).catch(e => console.error(String(e)))
    for (const d of daemons) {
      const r = await killOwned(d, { tree: true })
      if (r === 'not-ours') console.error(`tetherd cleanup: pid ${d.pid} is no longer ours; not killed`)
    }
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && daemons.some(d => pidAlive(d.pid))) await sleep(200)
    for (let i = 0; i < 5; i++) {
      try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
  }
})
