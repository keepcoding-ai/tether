// E2E of the geometry reads (forced layouts) the WHOLE window does for a daemon `state` event that changes nothing on
// screen and for a chunk of terminal output (hidden window, private home/pipe, real tetherd, a shell only).
// Every read of getBoundingClientRect / getClientRects / offset* / client* / scroll* sizes and every getComputedStyle
// call is counted with its caller (top app frames of the stack) so a regression names its culprit.
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

type Hooks = { text(slotId: string): string; panelIds(): string[]; slots(): SlotState[]; connection(): { connected: boolean; pid?: number } | undefined; desks(): { id: string }[] }
declare const window: { __tether: Hooks; __geo: Record<string, number>; requestAnimationFrame(cb: () => void): number; getComputedStyle: unknown }
declare const document: { querySelectorAll(selector: string): { length: number } }
declare const Element: { prototype: object }
declare const HTMLElement: { prototype: object }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-layout-cost-${process.pid}`
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

/** Runs `step` EVENTS times (two frames after each) and returns the geometry reads per caller. */
async function measure(page: Page, step: (i: number) => Promise<void>): Promise<Record<string, number>> {
  await frames(page)
  await page.evaluate(() => { window.__geo = {} })
  for (let i = 0; i < EVENTS; i++) { await step(i); await frames(page) }
  return page.evaluate(() => ({ ...window.__geo }))
}

const total = (r: Record<string, number>): number => Object.values(r).reduce((a, b) => a + b, 0)
const show = (what: string, r: Record<string, number>): void => {
  console.log(`${what}: ${total(r)} geometry reads in ${EVENTS} events`)
  for (const [k, v] of Object.entries(r).sort((a, b) => b[1] - a[1]).slice(0, 40)) if (!k.includes('DeskSwitch')) console.log(`   ${v}  ${k}`)
}

test('layout: a state event or an output chunk that changes nothing on screen reads no geometry', { timeout: 300_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'tether-layout-cost-'))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    const daemonPid = (await page.evaluate(() => window.__tether.connection()))!.pid!
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))
    for (let i = 1; i < DESKS; i++) await page.keyboard.press('Control+Shift+N')
    await page.waitForFunction(n => window.__tether.desks().length === n, DESKS)
    // The shell goes into the last desk, the active one: its terminal is on screen and receives the output.
    const shell = await createShell(page, root)
    for (let i = 0; i < 3; i++) await createShell(page, root) // tabs of one frame: the tab strip and the agents' panes have work to do
    await page.waitForFunction(id => window.__tether.slots().filter(s => s.status === 'running').length >= 4 && window.__tether.slots().some(s => s.slotId === id), shell)
    await page.waitForFunction(id => window.__tether.slots().some(s => s.slotId === id && s.status === 'running'), shell, { timeout: 20_000 })
    const slot = (await page.evaluate(() => window.__tether.slots())).find(s => s.slotId === shell)!
    await page.evaluate(() => {
      window.__geo = {}
      const note = (what: string): void => {
        const lines = (new Error().stack ?? '').split('\n').slice(3, 7).map(l => l.trim().replace(/^at /, '').replace(/\(?(file|app):[^)]*[\/]/, '(').replace(/\)$/, ''))
        const key = `${what} <- ${lines.join(' < ')}`
        window.__geo[key] = (window.__geo[key] ?? 0) + 1
      }
      const wrapMethod = (proto: object, name: string): void => {
        const o = proto as Record<string, (...a: unknown[]) => unknown>
        const orig = o[name]!
        o[name] = function (this: unknown, ...a: unknown[]) { note(name); return orig.apply(this, a) }
      }
      const wrapGetter = (proto: object, name: string): void => {
        const d = Object.getOwnPropertyDescriptor(proto, name)
        if (!d?.get) return
        const get = d.get
        Object.defineProperty(proto, name, { ...d, get(this: unknown) { note(name); return get.call(this) } })
      }
      wrapMethod(Element.prototype, 'getBoundingClientRect')
      wrapMethod(Element.prototype, 'getClientRects')
      for (const n of ['clientWidth', 'clientHeight', 'scrollWidth', 'scrollHeight']) wrapGetter(Element.prototype, n)
      for (const n of ['offsetWidth', 'offsetHeight', 'offsetTop', 'offsetLeft']) wrapGetter(HTMLElement.prototype, n)
      const gcs = window.getComputedStyle as (...a: unknown[]) => unknown
      ;(window as unknown as Record<string, unknown>).getComputedStyle = function (this: unknown, ...a: unknown[]) { note('getComputedStyle'); return gcs.apply(this, a) }
    })
    assert.ok(await page.evaluate(() => document.querySelectorAll('.xterm').length > 0), 'the terminal is not on screen')
    const send = (ev: object): Promise<void> => app!.evaluate(({ BrowserWindow }, e) => {
      const w = BrowserWindow.getAllWindows().find(x => /\/renderer\/index\.html(\?|$)/.test(x.webContents.getURL()))
      w!.webContents.send('tether:event', e)
    }, ev)

    const same = await measure(page, () => send({ t: 'state', slot } as { t: string }))
    // Fields the daemon refreshes all the time that no pixel shows.
    const noise = await measure(page, i => send({ t: 'state', slot: { ...slot, memoryMB: 100 + i, idleSince: new Date(Date.now() + i).toISOString() } } as { t: string }))
    const out = await measure(page, i => send({ t: 'data', slotId: shell, data: `line ${i}\r\n` }))
    // Sanity of the instrumentation: changes that DO alter the screen (busy dot, window resize) read geometry.
    const busy = await measure(page, i => send({ t: 'state', slot: { ...slot, turn: i % 2 ? 'busy' : 'idle' } } as { t: string }))
    const resized = await measure(page, async i => { await app!.evaluate(({ BrowserWindow }, w) => { BrowserWindow.getAllWindows()[0]!.setSize(w, 700) }, 1000 + (i % 2) * 120) })
    show('busy-toggling state events (informational)', busy)
    show('window resizes (informational)', resized)
    assert.ok(total(resized) > 0, 'the geometry probe sees nothing: instrumentation broken')
    show('unchanged state events', same)
    show('state events refreshing memoryMB/idleSince', noise)
    show('terminal output chunks', out)
    // The chunks reached the visible terminal (so the zero is not an artefact of a hidden or detached pane).
    await page.waitForFunction(({ id, last }: { id: string; last: number }) => window.__tether.text(id).includes(`line ${last}`), { id: shell, last: EVENTS - 1 }, { timeout: 10_000 })
    // The real daemon keeps talking while we measure (a tooltip's idle time, a status): such a real change may cost one
    // coalesced toolbar pass (about a dozen reads, once per frame at most). Everything else must stay at zero.
    const outsideToolbar = (r: Record<string, number>): number => total(Object.fromEntries(Object.entries(r).filter(([k]) => !/ pass \(/.test(k))))
    const toolbar = (r: Record<string, number>): number => total(r) - outsideToolbar(r)
    for (const [what, r] of [['unchanged state events', same], ['output chunks', out], ['memoryMB/idleSince events', noise]] as const) {
      assert.equal(outsideToolbar(r), 0, `geometry reads over ${EVENTS} ${what}: ${outsideToolbar(r)}`)
      assert.ok(toolbar(r) <= 24, `toolbar re-measured over ${EVENTS} ${what}: ${toolbar(r)} reads`)
    }
  } finally {
    if (app) await killElectron(app, root)
    for (const d of daemons) await killOwned(d, { tree: true })
    await stopPtyd(home)
    try { rmSync(home, { recursive: true, force: true }) } catch { /* daemon files may linger a moment */ }
  }
})
