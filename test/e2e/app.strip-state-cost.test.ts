// E2E of what a daemon `state` event costs the renderer (hidden window, private home/pipe, real tetherd, a shell only).
// Each state event repaints the desk capsule, the drawer button, the tabs and the agents' panes; an event that changes
// nothing on screen must not force synchronous layouts of the window (the capsule used to measure itself three or
// more times per event, each a full layout of the window).
// Measured with CDP Performance.getMetrics (LayoutCount/RecalcStyleCount include the frames' own lifecycle, so the
// test compares against an idle stretch of the same length) and a count of getBoundingClientRect calls.
//   TETHER_PERF_NOBUILD=1 measures the current app/dist as it is, without asserting (to compare one build with another).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'
import { ptydEnv, stopPtyd } from './ptyd-driver.ts'

type Hooks = { panelIds(): string[]; slots(): SlotState[]; connection(): { connected: boolean; pid?: number } | undefined; desks(): { id: string }[] }
declare const window: { __tether: Hooks; __gbcr: number; __gbcrCapsule: number; requestAnimationFrame(cb: () => void): number }
declare const document: { querySelectorAll(selector: string): { length: number } }
declare const Element: { prototype: { getBoundingClientRect(): unknown; closest(selector: string): unknown } }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-strip-cost-${process.pid}`
const EVENTS = 40
const DESKS = 8

async function launch(home: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_') && !k.toUpperCase().startsWith('CLAUDE')) env[k] = v
  env.TETHER_PIPE = pipe
  env.TETHER_HOME = home
  ptydEnv(env, undefined)
  env.TETHER_E2E_HIDDEN = '1'
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  page.on('pageerror', e => console.error(`renderer error: ${e.message}`))
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  return { app, page }
}

async function createShell(page: Page, cwd: string): Promise<string> {
  const before = await page.evaluate(() => window.__tether.panelIds())
  await page.click('#btn-new')
  await page.waitForSelector('#dlg-new[open]')
  await page.fill('#dlg-new .ch-path-input', cwd)
  await page.click('#dlg-new .ch-item[data-id="powershell"]')
  await page.click('#dlg-new .btn.primary.go')
  await page.waitForFunction(() => document.querySelectorAll('#dlg-new[open]').length === 0)
  await page.waitForFunction(before => window.__tether.panelIds().some(id => !before.includes(id)), before)
  return (await page.evaluate(() => window.__tether.panelIds())).find(id => !before.includes(id))!
}

const frames = (page: Page): Promise<void> => page.evaluate(() => new Promise<void>(r => { window.requestAnimationFrame(() => { window.requestAnimationFrame(() => r()) }) }))

type Cost = { layouts: number; styles: number; layoutMs: number; styleMs: number; scriptMs: number; gbcr: number; capsule: number }
type Cdp = { send(method: string, params?: object): Promise<unknown> }

/** Runs `step` EVENTS times (two frames after each) and returns what the renderer spent meanwhile. */
async function measure(page: Page, cdp: Cdp, step: (i: number) => Promise<void>): Promise<Cost> {
  const read = async (): Promise<Record<string, number>> => {
    const r = await cdp.send('Performance.getMetrics') as { metrics: { name: string; value: number }[] }
    return Object.fromEntries(r.metrics.map(m => [m.name, m.value]))
  }
  await frames(page)
  const g0 = await page.evaluate(() => [window.__gbcr, window.__gbcrCapsule] as const)
  const a = await read()
  for (let i = 0; i < EVENTS; i++) { await step(i); await frames(page) }
  const b = await read()
  const g1 = await page.evaluate(() => [window.__gbcr, window.__gbcrCapsule] as const)
  const d = (k: string): number => (b[k] ?? 0) - (a[k] ?? 0)
  return { layouts: d('LayoutCount'), styles: d('RecalcStyleCount'), layoutMs: d('LayoutDuration') * 1000, styleMs: d('RecalcStyleDuration') * 1000, scriptMs: d('ScriptDuration') * 1000, gbcr: g1[0] - g0[0], capsule: g1[1] - g0[1] }
}

const fmt = (c: Cost): string => `layouts ${c.layouts} styles ${c.styles} layout ${c.layoutMs.toFixed(1)}ms style ${c.styleMs.toFixed(1)}ms script ${c.scriptMs.toFixed(1)}ms getBoundingClientRect ${c.gbcr} (capsule ${c.capsule})`
const per = (c: Cost, idle: Cost): string => `${((c.layouts - idle.layouts) / EVENTS).toFixed(2)} layouts, ${((c.layoutMs + c.styleMs - idle.layoutMs - idle.styleMs) / EVENTS).toFixed(2)} ms layout+style, ${(c.gbcr / EVENTS).toFixed(2)} getBoundingClientRect, ${(c.capsule / EVENTS).toFixed(2)} of them in the capsule`

test('strip: a state event that changes nothing on screen forces no layout', { timeout: 300_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'tether-strip-cost-'))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    const daemonPid = (await page.evaluate(() => window.__tether.connection()))!.pid!
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))
    const shell = await createShell(page, root)
    for (let i = 1; i < DESKS; i++) await page.keyboard.press('Control+Shift+N')
    await page.waitForFunction(n => window.__tether.desks().length === n, DESKS)
    await page.waitForFunction(id => window.__tether.slots().some(s => s.slotId === id && s.status === 'running'), shell, { timeout: 20_000 })
    const slot = (await page.evaluate(() => window.__tether.slots())).find(s => s.slotId === shell)!
    await page.evaluate(() => {
      window.__gbcr = 0
      window.__gbcrCapsule = 0
      const orig = Element.prototype.getBoundingClientRect
      Element.prototype.getBoundingClientRect = function (this: { closest(s: string): unknown }) {
        window.__gbcr++
        if (this.closest('#desk-switch')) window.__gbcrCapsule++
        return orig.call(this)
      }
    })
    const cdp = await page.context().newCDPSession(page) as unknown as Cdp
    await cdp.send('Performance.enable')
    const send = (s: SlotState): Promise<void> => app!.evaluate(({ BrowserWindow }, ev) => {
      const w = BrowserWindow.getAllWindows().find(x => /\/renderer\/index\.html(\?|$)/.test(x.webContents.getURL()))
      w!.webContents.send('tether:event', ev)
    }, { t: 'state', slot: s })

    const idle = await measure(page, cdp, async () => {})
    const same = await measure(page, cdp, () => send(slot))
    const busy = await measure(page, cdp, i => send({ ...slot, turn: i % 2 ? 'busy' : 'idle' } as SlotState))
    console.log(`idle (${EVENTS} x 2 frames): ${fmt(idle)}`)
    console.log(`${EVENTS} unchanged state events: ${fmt(same)}`)
    console.log(`${EVENTS} state events toggling the busy dot: ${fmt(busy)}`)
    console.log(`extra per unchanged event: ${per(same, idle)}`)
    console.log(`extra per busy-toggling event: ${per(busy, idle)}`)
    // The capsule reads no geometry at all for an event that changes nothing it shows (the old one measured the whole
    // row, a forced layout of the window, several times per event). The layout counts above are informational: frames
    // lay out on their own.
    assert.equal(same.capsule, 0, `capsule geometry reads over ${EVENTS} unchanged state events: ${same.capsule}`)
  } finally {
    if (app) await killElectron(app, root)
    for (const d of daemons) await killOwned(d, { tree: true })
    await stopPtyd(home)
    try { rmSync(home, { recursive: true, force: true }) } catch { /* daemon files may linger a moment */ }
  }
})
