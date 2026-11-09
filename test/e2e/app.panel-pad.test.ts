// E2E of the panel pad ("Prancheta do painel") and the blank frame ("frame vazio"): real tetherd on a private home/pipe,
// hidden window, CLAUDE* stripped.
//   1. the right strip, top to bottom: panel, desk, global;
//   2. the panel pad with no panel in focus: only a discreet line, no button;
//   3. with a panel in focus and nothing in its pad: the blank view with its action; the action leaves and the chooser
//      ("O que abrir aqui?") takes its place;
//   4. the pad follows the focused panel and swaps when the focus changes (each panel its own frame, a shell in a pad keeps
//      running), and the keyboard inside the pad does not move the target;
//   5. it persists like the desk pad: layout.json carries it, and after a relaunch the same shell (same PID) is in it;
//   6. the desk pad and the global pad start blank too;
//   7. a new desk (command, "+" and menu) and a new frame start blank, while a pane split inside a frame still opens the chooser.
// Screenshots in <repo>/../../.tmp/panel-pad (dark and light).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type Empty = { id: string; blank: boolean; origin: string }
type LayoutJSON = { sidebars?: { pads: Record<string, unknown>; right: { open?: string } } }
type Hooks = {
  slots(): SlotState[]
  connection(): { connected: boolean; pid?: number } | undefined
  layout(): LayoutJSON
  openSlot(id: string): void
  sidebars(): { right: { strip: string[]; open?: string }; views: { pad: string; panel?: string; desk?: string; shown: boolean }[] } | undefined
  padFrames(): { pad: string; desk?: string; panes: string[]; shown: boolean }[]
  openSlotInPad(slotId: string, padId: string): void
  togglePad(id: string): void
  focusablePanel(): string | undefined
  activatePanel(id: string): void
  empties(): Empty[]
  runCommand(id: string): Promise<string>
  activeDesk(): string
  desks(): { id: string; name: string; panes: string[] }[]
}
declare const window: { __tether: Hooks; tether: { request(body: unknown): Promise<{ t: string; slot?: SlotState }> } }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-panelpad-${process.pid}`
const atriumTmp = resolve(root, '..', '..', '.tmp')
const tmpBase = existsSync(atriumTmp) ? atriumTmp : tmpdir()
const shots = join(tmpBase, 'panel-pad')
const electronPath = require('electron') as string

const PANEL = 'frame-pads.panel'
const DESK = 'frame-pads.desk'
const GLOBAL = 'frame-pads.global'

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

async function bareShell(page: Page): Promise<string> {
  const reply = await page.evaluate(cwd => window.tether.request({ t: 'create', kind: 'shell', cwd, start: true }), root)
  assert.equal(reply.t, 'ok')
  const id = reply.slot!.slotId
  await page.waitForFunction(id => typeof window.__tether.slots().find(s => s.slotId === id)?.pid === 'number', id, { timeout: 20_000 })
  return id
}

async function shell(page: Page): Promise<string> {
  const id = await bareShell(page)
  await page.evaluate(id => window.__tether.openSlot(id), id)
  return id
}

const pidOf = async (page: Page, id: string): Promise<number> => (await page.evaluate(id => window.__tether.slots().find(s => s.slotId === id)?.pid, id))!
const shown = (pad: string): string => `#pads .pad.shown[data-pad="${pad}"]`

test('panel pad: strip order, follows the focused panel, persists; the blank frame is the starting point', { timeout: 300_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(shots, { recursive: true })
  const home = mkdtempSync(join(tmpBase, 'tether-panelpad-'))
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ extensions: { disabled: ['explorer'] } }))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    daemons.push(await claim((await page.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))

    // ---- 1. the strip, top to bottom ----
    assert.deepEqual((await page.evaluate(() => window.__tether.sidebars()))!.right.strip, [PANEL, DESK, GLOBAL])
    assert.deepEqual(await page.locator('#sidebar-right .sb-icon').evaluateAll(els => els.map(e => (e as HTMLElement).dataset.pad)), [PANEL, DESK, GLOBAL], 'the icons on screen, in the same order')
    await page.screenshot({ path: join(shots, '1-strip-light.png') })

    // ---- 2. no panel in focus: a discreet line, nothing to click ----
    assert.equal(await page.evaluate(() => window.__tether.focusablePanel()), undefined)
    await page.click(`.sb-icon[data-pad="${PANEL}"]`)
    await page.waitForSelector('#pads .pad-no-target.shown .blank-view')
    assert.equal(await page.locator('#pads .pad-no-target.shown .blank-message').innerText(), 'Nenhum painel em foco.')
    assert.equal(await page.locator('#pads .pad-no-target.shown button.blank-action').count(), 0, 'no target, no action')
    assert.equal(await page.locator('#pads .pad-no-target.shown .empty-panel').count(), 0, 'and no chooser')
    await page.screenshot({ path: join(shots, '2-empty-no-target.png') })

    // ---- 3. a panel in focus, nothing in its pad: the blank view; its action brings the chooser ----
    const a = await shell(page)
    await page.waitForFunction(id => window.__tether.focusablePanel() === id, a)
    await page.waitForSelector(`${shown(PANEL)} .empty-panel[data-blank="true"] .blank-action`)
    assert.equal(await page.locator('#pads .pad-no-target.shown').count(), 0, 'the no-target line leaves when a panel has the focus')
    assert.equal(await page.locator(`${shown(PANEL)} .blank-message`).innerText(), 'Nada aberto aqui ainda.')
    assert.equal(await page.locator(`${shown(PANEL)} .blank-action`).innerText(), 'Abrir algo aqui')
    assert.equal(await page.locator(`${shown(PANEL)} .ch`).count(), 0, 'the chooser is not there yet')
    assert.equal(await page.locator(`${shown(PANEL)}`).getAttribute('data-panel'), a)
    await page.screenshot({ path: join(shots, '3a-empty-with-target-light.png') })
    await page.click(`${shown(PANEL)} .blank-action`)
    await page.waitForSelector(`${shown(PANEL)} .empty-panel[data-blank="false"] .ch`)
    assert.equal(await page.locator(`${shown(PANEL)} .blank-view`).count(), 0, 'the blank view left')
    assert.ok(await page.locator(`${shown(PANEL)} .ch-item`).count() > 3, 'the chooser lists what to open')
    await page.screenshot({ path: join(shots, '3b-chooser-after-action-light.png') })
    const panelEmpty = (await page.evaluate(() => window.__tether.padFrames())).find(p => p.pad === PANEL && p.shown)!.panes[0]!

    // ---- 4. the pad follows the focused panel ----
    const inA = await bareShell(page)
    await page.evaluate(([id, pad]) => window.__tether.openSlotInPad(id!, pad!), [inA, PANEL])
    await page.waitForFunction(([id, pad]) => window.__tether.padFrames().some(p => p.pad === pad && p.shown && p.panes.includes(id!)), [inA, PANEL])
    const pidInA = await pidOf(page, inA)
    const b = await shell(page) // a second panel: it takes the Foco de Mesa
    await page.waitForFunction(id => window.__tether.focusablePanel() === id, b)
    await page.waitForSelector(`${shown(PANEL)}[data-panel="${b}"] .empty-panel[data-blank="true"]`)
    let views = (await page.evaluate(() => window.__tether.sidebars()))!.views.filter(v => v.pad === PANEL)
    assert.deepEqual(views.map(v => [v.panel, v.shown]).sort(), [[a, false], [b, true]].sort(), 'a hidden, b shown: one view per panel')
    assert.equal(await pidOf(page, inA), pidInA, "a's shell in its pad keeps running while hidden")
    await page.screenshot({ path: join(shots, '4a-follows-focus-b-light.png') })
    // The focus goes back to a: its pad content is back, with its shell.
    await page.evaluate(id => window.__tether.activatePanel(id), a)
    await page.waitForSelector(`${shown(PANEL)}[data-panel="${a}"]`)
    assert.ok((await page.evaluate(() => window.__tether.padFrames())).some(p => p.pad === PANEL && p.shown && p.panes.includes(inA)), "a's pad shows its shell again")
    await page.screenshot({ path: join(shots, '4b-follows-focus-a-light.png') })
    // The keyboard inside the pad does not move the target.
    await page.click(`${shown(PANEL)} .frame-dock`)
    await sleep(300)
    assert.equal(await page.evaluate(() => window.__tether.focusablePanel()), a, 'working inside the pad leaves the panel in focus')
    assert.equal(await page.locator(`${shown(PANEL)}`).getAttribute('data-panel'), a)

    // ---- 5. persistence, like the desk pad ----
    let saved: LayoutJSON | undefined
    for (let i = 0; i < 40; i++) {
      saved = JSON.parse(readFileSync(join(home, 'layout.json'), 'utf8')) as LayoutJSON
      if (saved.sidebars && `${PANEL}@${a}` in saved.sidebars.pads) break
      await sleep(100)
    }
    assert.ok(saved?.sidebars && `${PANEL}@${a}` in saved.sidebars.pads, "a's pad state is in layout.json")
    assert.ok(`${PANEL}@${b}` in saved!.sidebars!.pads, "b's pad state is in layout.json")
    assert.equal(saved!.sidebars!.right.open, PANEL)
    await killElectron(app, root)
    app = undefined
    ;({ app, page } = await launch(home))
    await page.waitForFunction(() => window.__tether.focusablePanel() !== undefined, undefined, { timeout: 20_000 })
    await page.evaluate(id => window.__tether.activatePanel(id), a)
    await page.waitForSelector(`${shown(PANEL)}[data-panel="${a}"]`)
    await page.waitForFunction(id => window.__tether.padFrames().some(p => p.pad === 'frame-pads.panel' && p.shown && p.panes.includes(id)), inA, { timeout: 20_000 })
    assert.equal(await pidOf(page, inA), pidInA, 'after the relaunch the same shell is in the pad of a')
    assert.ok((await page.evaluate(() => window.__tether.padFrames())).some(p => p.pad === PANEL && p.panes.includes(panelEmpty)), "a's chooser pane is back too, same id")
    await page.screenshot({ path: join(shots, '5-after-relaunch-light.png') })

    // ---- 6. the desk pad and the global pad start blank ----
    await page.click(`.sb-icon[data-pad="${DESK}"]`)
    await page.waitForSelector(`${shown(DESK)} .empty-panel[data-blank="true"] .blank-action`)
    await page.screenshot({ path: join(shots, '6a-desk-pad-blank-light.png') })
    await page.click(`.sb-icon[data-pad="${GLOBAL}"]`)
    await page.waitForSelector(`${shown(GLOBAL)} .empty-panel[data-blank="true"] .blank-action`)
    await page.screenshot({ path: join(shots, '6b-global-pad-blank-light.png') })
    // The same action on the desk pad hands over to the chooser too.
    await page.click(`.sb-icon[data-pad="${DESK}"]`)
    await page.click(`${shown(DESK)} .blank-action`)
    await page.waitForSelector(`${shown(DESK)} .empty-panel[data-blank="false"] .ch`)
    await page.click(`.sb-icon[data-pad="${DESK}"]`) // closes the right bar

    // ---- 7. new desk and new frame start blank ----
    const blankOf = async (): Promise<Empty[]> => (await page.evaluate(() => window.__tether.empties())).filter(e => e.blank)
    const before = (await blankOf()).length
    const desk0 = await page.evaluate(() => window.__tether.activeDesk())
    assert.equal(await page.evaluate(() => window.__tether.runCommand('desk.new')), 'ran')
    await page.waitForFunction(d => window.__tether.activeDesk() !== d, desk0)
    await page.waitForFunction(n => window.__tether.empties().filter(e => e.blank).length === n + 1, before)
    await page.waitForSelector('#dock .empty-panel[data-blank="true"] .blank-action')
    await page.screenshot({ path: join(shots, '7a-new-desk-blank-light.png') })
    await page.click('#dock .empty-panel[data-blank="true"] .blank-action')
    await page.waitForSelector('#dock .empty-panel[data-blank="false"] .ch')
    assert.equal((await blankOf()).length, before, 'the action took that pane out of the blank state')
    // The "+" of the desk strip.
    await page.click('#desk-switch .desk-add')
    await page.waitForFunction(n => window.__tether.empties().filter(e => e.blank).length === n + 1, before)
    // "Nova mesa vazia".
    assert.equal(await page.evaluate(() => window.__tether.runCommand('desk.new-empty')), 'ran')
    await page.waitForFunction(n => window.__tether.empties().filter(e => e.blank).length === n + 2, before)
    // A new frame beside: blank. A pane split inside the frame (a request in progress): the chooser, not blank.
    const blanks = (await blankOf()).length
    assert.equal(await page.evaluate(() => window.__tether.runCommand('frame.new-empty.right')), 'ran')
    await page.waitForFunction(n => window.__tether.empties().filter(e => e.blank).length === n + 1, blanks)
    await page.screenshot({ path: join(shots, '7b-new-frame-blank-light.png') })
    const chooserBefore = (await page.evaluate(() => window.__tether.empties())).length
    assert.equal(await page.evaluate(() => window.__tether.runCommand('pane.split-empty.pane.right')), 'ran')
    await page.waitForFunction(n => window.__tether.empties().length === n + 1, chooserBefore)
    assert.equal((await blankOf()).length, blanks + 1, 'a pane split is not blank')
    // Opening something with no place named (a new desk, then a new terminal) fills the blank: no "Vazio" tab left behind.
    const total = (await blankOf()).length
    assert.equal(await page.evaluate(() => window.__tether.runCommand('desk.new')), 'ran')
    await page.waitForFunction(n => window.__tether.empties().filter(e => e.blank).length === n + 1, total)
    const fresh = await shell(page)
    await page.waitForFunction(n => window.__tether.empties().filter(e => e.blank).length === n, total)
    const here = await page.evaluate(() => window.__tether.activeDesk())
    assert.deepEqual((await page.evaluate(() => window.__tether.desks())).find(d => d.id === here)!.panes, [fresh], 'the shell took the blank place')
  } finally {
    if (app) await killElectron(app, root).catch(() => {})
    for (const p of daemons) await killOwned(p, { tree: true })
    for (let i = 0; i < 20 && daemons.some(p => pidAlive(p.pid)); i++) await sleep(500)
    for (let i = 0; i < 5; i++) { try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(300) } }
  }
})
