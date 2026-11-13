// E2E of the panel pad driven by clicks across desks: real tetherd on a private home/pipe, hidden window, CLAUDE* stripped.
// The pad's view of a panel is created on first need; creating it re-enters SideBars.render (its frame's panes make the
// host notify the active pane). A desk switch renders before it notifies, so the view of the new desk's panel used to be
// built twice and the copy stayed in #pads, shown, out of every render: painted over the pads (the pad "did not follow
// the panel") and over the desks after the pad closed ("it never closes").
//   1. desk 1 with shell A, the panel pad open on A; desk 2 with shell B and C made while the pad is closed;
//   2. back on desk 1 the pad opens; a click on desk 2's pill shows B's frame: one wrapper per panel, and the pixels
//      of the pad's area are B's;
//   3. a click on C's tab, then desk 1's pill: the pad's area shows C's frame, then A's;
//   4. a click on the pad's icon closes it: nothing of any pad paints over the desks.
// Screenshots in <atrium>/.tmp/panel-pad-follow.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type Hooks = {
  slots(): SlotState[]
  connection(): { connected: boolean; pid?: number } | undefined
  openSlot(id: string): void
  sidebars(): { right: { open?: string } } | undefined
  focusablePanel(): string | undefined
  runCommand(id: string): Promise<string>
  activeDesk(): string
}
declare const window: { __tether: Hooks; tether: { request(body: unknown): Promise<{ t: string; slot?: SlotState }> } }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-ppfollow-${process.pid}`
const atriumTmp = resolve(root, '..', '..', '.tmp')
const tmpBase = existsSync(atriumTmp) ? atriumTmp : tmpdir()
const shots = join(tmpBase, 'panel-pad-follow')
const electronPath = require('electron') as string

const PANEL = 'frame-pads.panel'
const shown = `#pads .pad.shown[data-pad="${PANEL}"]`
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const pidAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' } }

async function launch(home: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_') && !k.toUpperCase().startsWith('CLAUDE')) env[k] = v
  env.TETHER_PIPE = pipe
  env.TETHER_HOME = home
  env.TETHER_E2E_HIDDEN = '1'
  delete env.TETHER_CLAUDE_ARGS
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10_000)
  page.on('pageerror', e => console.error(`renderer error: ${e.message}`))
  page.on('console', m => { if (m.type() === 'error') console.error(`renderer console: ${m.text()}`) })
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  return { app, page }
}

async function shell(page: Page): Promise<string> {
  const reply = await page.evaluate(cwd => window.tether.request({ t: 'create', kind: 'shell', cwd, start: true }), root)
  assert.equal(reply.t, 'ok')
  const id = reply.slot!.slotId
  await page.waitForFunction(id => typeof window.__tether.slots().find(s => s.slotId === id)?.pid === 'number', id, { timeout: 20_000 })
  await page.evaluate(id => window.__tether.openSlot(id), id)
  return id
}

test('panel pad across desks: one view per panel, follows the focus, closes for real', { timeout: 300_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(shots, { recursive: true })
  const home = mkdtempSync(join(tmpBase, 'tether-ppfollow-'))
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ extensions: { disabled: ['explorer'] } }))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    daemons.push(await claim((await page.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    /** Wrappers in #pads per pad view (pad@panel), and the view that owns the pixels of the right side's pad area. */
    const screen = async (): Promise<{ wrappers: Record<string, number>; owner: string[] }> => page.evaluate(() => {
      const wrappers: Record<string, number> = {}
      for (const w of document.querySelectorAll<HTMLElement>('#pads > .pad:not(.pad-no-target)')) {
        const k = `${w.dataset.pad}@${w.dataset.panel ?? w.dataset.desk ?? ''}`
        wrappers[k] = (wrappers[k] ?? 0) + 1
      }
      const strip = document.querySelector<HTMLElement>('#sidebar-right .sb-strip')!.getBoundingClientRect()
      const owner = new Set<string>()
      for (const dx of [40, 150, 300]) for (const y of [strip.top + 20, strip.top + strip.height / 2]) {
        const pad = document.elementFromPoint(strip.left - dx, y)?.closest<HTMLElement>('.pad')
        if (pad) owner.add(`${pad.dataset.pad}@${pad.dataset.panel ?? pad.dataset.desk ?? ''}`)
      }
      return { wrappers, owner: [...owner] }
    })
    const single = (w: Record<string, number>, what: string): void => {
      for (const [k, n] of Object.entries(w)) assert.equal(n, 1, `${what}: one wrapper for ${k}, found ${n}`)
    }
    const tabOf = (id: string): string => `#dock .dv-tab[data-tab-panel-id="${id}"]`

    // ---- 1 ----
    const a = await shell(page)
    const desk1 = await page.evaluate(() => window.__tether.activeDesk())
    await page.click(`.sb-icon[data-pad="${PANEL}"]`)
    await page.waitForSelector(`${shown}[data-panel="${a}"]`)
    await page.click(`.sb-icon[data-pad="${PANEL}"]`)
    assert.equal(await page.evaluate(() => window.__tether.runCommand('desk.new')), 'ran')
    await page.waitForFunction(d => window.__tether.activeDesk() !== d, desk1)
    const desk2 = await page.evaluate(() => window.__tether.activeDesk())
    const c = await shell(page)
    const b = await shell(page) // the last one opened has the focus when desk 2 comes back
    await page.waitForFunction(id => window.__tether.focusablePanel() === id, b)

    // ---- 2 ----
    await page.click(`#desk-switch .seg[data-desk="${desk1}"]`)
    await page.waitForFunction(id => window.__tether.focusablePanel() === id, a)
    await page.click(`.sb-icon[data-pad="${PANEL}"]`)
    await page.waitForSelector(`${shown}[data-panel="${a}"]`)
    await page.click(`#desk-switch .seg[data-desk="${desk2}"]`)
    await page.waitForFunction(id => window.__tether.focusablePanel() === id, b)
    await page.waitForSelector(`${shown}[data-panel="${b}"]`)
    await sleep(300)
    let s = await screen()
    await page.screenshot({ path: join(shots, '2-desk2-b.png') })
    single(s.wrappers, 'after the desk switch')
    assert.deepEqual(s.owner, [`${PANEL}@${b}`], "the pad's area shows B's frame")

    // ---- 3 ----
    await page.click(tabOf(c))
    await page.waitForFunction(id => window.__tether.focusablePanel() === id, c)
    await sleep(300)
    s = await screen()
    single(s.wrappers, 'after the tab click')
    assert.deepEqual(s.owner, [`${PANEL}@${c}`], "a click on C's tab: the pad's area shows C's frame")
    await page.click(`#desk-switch .seg[data-desk="${desk1}"]`)
    await page.waitForFunction(id => window.__tether.focusablePanel() === id, a)
    await sleep(300)
    s = await screen()
    await page.screenshot({ path: join(shots, '3-desk1-a.png') })
    assert.deepEqual(s.owner, [`${PANEL}@${a}`], "back on desk 1: the pad's area shows A's frame")

    // ---- 4 ----
    await page.click(`.sb-icon[data-pad="${PANEL}"]`)
    await page.waitForFunction(() => window.__tether.sidebars()?.right.open === undefined)
    await sleep(300)
    s = await screen()
    await page.screenshot({ path: join(shots, '4-closed.png') })
    assert.deepEqual(s.owner, [], 'the pad closed: nothing of it paints over the desks')
    assert.equal(await page.locator('#pads .pad.shown').count(), 0, 'no pad wrapper is shown')
  } finally {
    if (app) await killElectron(app, root).catch(() => {})
    for (const p of daemons) await killOwned(p, { tree: true })
    for (let i = 0; i < 20 && daemons.some(p => pidAlive(p.pid)); i++) await sleep(500)
    for (let i = 0; i < 5; i++) { try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(300) } }
  }
})
