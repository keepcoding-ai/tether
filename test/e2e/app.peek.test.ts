// E2E of the peek card for a slot without a tab (app/renderer/peek.ts), with shells only (hidden window, private home/pipe,
// real tetherd, CLAUDE* stripped):
//   1. a shell closed with "só fechar" keeps running without a tab; `peek` opens the card over the desk: its terminal is
//      the routed one, shows the shell's screen and takes typing (an echo comes back); the window behind is inert and the
//      card holds the freeze; the header and foot read as the rules say;
//   2. Esc: the slot reported as an agent keeps Esc (twice, the card stays); as a shell at its prompt a double Esc closes;
//   3. the ✕, a press on the margin, the chord (Ctrl+Shift+O) and the palette command close it, the keyboard back on the
//      exact element that had it; the command is unavailable with the card closed;
//   4. over the open drawer: the drawer stays open (inert behind the card) and the keyboard goes back into it;
//   5. peeking another slot with the card open swaps the content;
//   6. the slot ends with the card open: the card shows it ended and still closes;
//   7. "Abrir nesta mesa": the card closes and the slot is in a tab of the desk, same PID, output still flowing;
//   8. captures (PEEK_SHOTS_DIR, default C:/atrium/.tmp/tether-agents/onda-3/espiar): e1a-cartao.png and two variants.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type Hooks = {
  panelIds(): string[]
  slots(): SlotState[]
  applyState(slot: SlotState): void
  connection(): { connected: boolean; pid?: number } | undefined
  text(slotId: string): string
  peek(slotId: string): void
  peekState(): { open: boolean; slotId?: string; routed: boolean }
  runCommand(id: string): Promise<'ran' | 'unknown' | 'unavailable'>
  openDrawer(): void
  inDrawer(slotId: string): boolean
  freeze(): { reasons: string[] }
}
type El = { id: string; tagName: string; hasAttribute(n: string): boolean; closest(s: string): (El & { dataset: Record<string, string> }) | null; dataset: Record<string, string> }
declare const window: { __tether: Hooks; tether: { request(body: unknown): Promise<unknown> } }
declare const document: { querySelectorAll(selector: string): { length: number }; querySelector(selector: string): { textContent: string | null } | null; getElementById(id: string): El | null; activeElement: El | null }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const shots = process.env.PEEK_SHOTS_DIR ?? 'C:/atrium/.tmp/tether-agents/onda-3/espiar'
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-peek-${process.pid}`

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

async function launch(home: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_') && !k.toUpperCase().startsWith('CLAUDE')) env[k] = v
  env.TETHER_PIPE = pipe
  env.TETHER_HOME = home
  env.TETHER_E2E_HIDDEN = '1'
  delete env.TETHER_CLAUDE_ARGS
  delete env.NODE_TEST_CONTEXT
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10_000)
  page.on('pageerror', e => console.error(`renderer error: ${e.message}`))
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  return { app, page }
}

const slotsOf = (page: Page): Promise<SlotState[]> => page.evaluate(() => window.__tether.slots())
const idsOf = (page: Page): Promise<string[]> => page.evaluate(() => window.__tether.panelIds())
const state = (page: Page) => page.evaluate(() => window.__tether.peekState())
const textOf = (page: Page, id: string): Promise<string> => page.evaluate(id => window.__tether.text(id), id)

/** A PowerShell in the visible desk through the chooser; returns its slot id once it runs. */
async function createShell(page: Page, cwd: string): Promise<string> {
  const before = await idsOf(page)
  await page.click('#btn-new')
  await page.waitForSelector('#dlg-new[open]')
  await page.fill('#dlg-new .ch-path-input', cwd)
  await page.click('#dlg-new .ch-item[data-id="powershell"]')
  await page.click('#dlg-new .btn.primary.go')
  await page.waitForFunction(() => document.querySelectorAll('#dlg-new[open]').length === 0)
  await page.waitForFunction(n => window.__tether.panelIds().length === n, before.length + 1)
  const id = (await idsOf(page)).find(x => !before.includes(x))!
  await page.waitForFunction(id => window.__tether.slots().find(s => s.slotId === id)?.status === 'running', id, { timeout: 20_000 })
  await page.waitForFunction(id => /PS .*>/.test(window.__tether.text(id)), id, { timeout: 30_000 })
  return id
}

/** Closes the pane through its tab's close button keeping the process ("só fechar"). */
async function detachPane(page: Page, slotId: string): Promise<void> {
  const tab = page.locator(`.tether-tab[data-slot="${slotId}"]`)
  await tab.hover()
  await tab.locator('.close').click()
  await page.locator('dialog[open] button.choice[data-choice="detach"]').click()
  await page.waitForFunction(id => !window.__tether.panelIds().includes(id), slotId)
}

/** Which element has the keyboard: the slot of the terminal it sits in (if any) and whether it is inside the drawer / the card. */
const focusIs = (page: Page) => page.evaluate(() => {
  const a = document.activeElement
  return { slot: a?.closest('.panel')?.dataset.slotId, xterm: !!a?.closest('.xterm'), drawer: !!a?.closest('#drawer'), peek: !!a?.closest('#peek') }
})

async function openPeek(page: Page, slotId: string): Promise<void> {
  await page.evaluate(id => window.__tether.peek(id), slotId)
  await page.waitForSelector('#peek[data-open="true"]')
  await page.waitForFunction(id => { const s = window.__tether.peekState(); return s.open && s.slotId === id && s.routed }, slotId)
  await page.waitForFunction(() => !!document.activeElement?.closest('#peek .xterm'))
}
const waitClosed = (page: Page): Promise<unknown> => page.waitForSelector('#peek', { state: 'hidden' })

test('cartão de espiar: slot sem guia, terminal vivo, Esc, fechar e foco, gaveta, troca, encerrado, Abrir nesta mesa', { timeout: 480_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(shots, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-peek-'))
  const cwd = home
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    daemons.push(await claim((await page.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800))
    const pidOf = async (id: string): Promise<number> => (await slotsOf(page)).find(s => s.slotId === id)!.pid!

    // ---- 1. a slot without a tab, in the card ----
    console.log('step 1')
    const keep = await createShell(page, cwd) // stays in a tab: the keyboard's home
    const b = await createShell(page, cwd)
    const c = await createShell(page, cwd)
    const pidB = await pidOf(b)
    await detachPane(page, b)
    await detachPane(page, c)
    assert.ok(pidAlive(pidB), 'the shell runs on without a tab')
    await page.locator(`.panel[data-slot-id="${keep}"] .xterm`).click()
    await page.waitForFunction(id => document.activeElement?.closest('.panel')?.dataset.slotId === id, keep)
    assert.equal((await page.evaluate(() => window.__tether.runCommand('peek.close'))), 'unavailable', 'nothing to close yet')

    await openPeek(page, b)
    assert.deepEqual(await idsOf(page), [keep], 'peeking gives the slot no tab')
    await page.waitForFunction(id => /PS .*>/.test(window.__tether.text(id)), b, { timeout: 15_000 })
    await page.keyboard.type("Write-Output ('pk-' + (6*7))")
    await page.keyboard.press('Enter')
    await page.waitForFunction(id => /^pk-42$/m.test(window.__tether.text(id)), b, { timeout: 15_000 })
    const head = page.locator('#peek .peek-head')
    assert.equal(await head.locator('.peek-title').textContent(), cwd.split(/[\\/]/).pop())
    assert.match((await head.locator('.peek-state').textContent())!, /^(ocioso|trabalhando)/)
    assert.equal(await page.locator('#peek .peek-close').getAttribute('title'), 'Fechar (Ctrl+Shift+O)')
    assert.equal(await page.locator('#peek .peek-card').getAttribute('aria-label'), `Espiando ${cwd.split(/[\\/]/).pop()}`)
    assert.match((await page.locator('#peek .peek-foot').textContent())!, /Esc duas vezes/)
    assert.equal(await page.evaluate(() => document.getElementById('dock')!.hasAttribute('inert')), true, 'the desks behind are inert')
    assert.equal(await page.evaluate(() => document.getElementById('toolbar')!.hasAttribute('inert')), true, 'the toolbar behind is inert')
    assert.ok((await page.evaluate(() => window.__tether.freeze().reasons)).includes('peek'), 'the card holds the freeze')
    const box = (await page.locator('#peek .peek-card').boundingBox())!
    assert.deepEqual([Math.round(box.x), Math.round(box.y)], [16, 16], 'the card sits 16 px from the edges')
    await page.screenshot({ path: join(shots, 'e1a-cartao.png') })

    // ---- 2. Esc ----
    console.log('step 2')
    const shellState = (await slotsOf(page)).find(s => s.slotId === b)!
    await page.evaluate(s => window.__tether.applyState({ ...s, kind: 'claude' }), shellState)
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await sleep(300)
    assert.equal((await state(page)).open, true, "an agent's terminal keeps Esc, even twice")
    assert.match((await page.locator('#peek .peek-foot').textContent())!, /Esc fica com o agente/, 'the screen says Esc is the agent\'s')
    await page.evaluate(s => window.__tether.applyState(s), shellState)
    await sleep(700) // past the double-Esc window of the presses above
    await page.keyboard.press('Escape')
    await sleep(100)
    assert.equal((await state(page)).open, true, 'a shell: the first Esc reaches the shell')
    await page.keyboard.press('Escape')
    await waitClosed(page)
    assert.deepEqual(await focusIs(page), { slot: keep, xterm: true, drawer: false, peek: false }, 'the keyboard is back where it was')
    assert.equal(await page.evaluate(() => document.getElementById('dock')!.hasAttribute('inert')), false, 'the desks come back')
    assert.ok(!(await page.evaluate(() => window.__tether.freeze().reasons)).includes('peek'), 'the freeze is let go')
    assert.equal((await state(page)).routed, false)
    assert.ok(pidAlive(pidB), 'closing the card ends nothing')

    // ---- 3. ✕, margin, chord, palette command ----
    console.log('step 3')
    await openPeek(page, b)
    await page.click('#peek .peek-close')
    await waitClosed(page)
    assert.equal((await focusIs(page)).slot, keep, '✕: the keyboard goes back')
    await openPeek(page, b)
    await page.mouse.click(8, 400)
    await waitClosed(page)
    assert.equal((await focusIs(page)).slot, keep, 'margin: the keyboard goes back')
    await openPeek(page, b)
    await page.keyboard.press('Control+Shift+KeyO')
    await waitClosed(page)
    assert.equal((await focusIs(page)).slot, keep, 'chord: the keyboard goes back')
    await openPeek(page, b)
    assert.equal(await page.evaluate(() => window.__tether.runCommand('peek.close')), 'ran')
    await waitClosed(page)
    assert.ok(pidAlive(pidB))

    // ---- 4. over the open drawer ----
    console.log('step 4')
    const known = (await slotsOf(page)).map(s => s.slotId)
    await page.evaluate(() => window.__tether.openDrawer())
    await page.waitForSelector('#drawer[data-open="true"]')
    await page.waitForFunction(ids => window.__tether.slots().some(s => !ids.includes(s.slotId) && window.__tether.inDrawer(s.slotId)), known, { timeout: 20_000 })
    const quick = (await slotsOf(page)).find(s => !known.includes(s.slotId))!.slotId
    await page.waitForFunction(id => document.activeElement?.closest('.panel')?.dataset.slotId === id, quick, { timeout: 15_000 })
    await openPeek(page, b)
    assert.equal(await page.getAttribute('#drawer', 'data-open'), 'true', 'the drawer stays open under the card')
    assert.equal(await page.evaluate(() => document.getElementById('drawer')!.hasAttribute('inert')), true, 'the drawer is inert behind the card')
    await page.screenshot({ path: join(shots, 'e1a-cartao-gaveta.png') })
    await page.click('#peek .peek-close')
    await waitClosed(page)
    assert.deepEqual(await focusIs(page), { slot: quick, xterm: true, drawer: true, peek: false }, 'the keyboard is back in the drawer')
    assert.equal(await page.evaluate(() => document.getElementById('drawer')!.hasAttribute('inert')), false, 'the drawer is live again')
    assert.equal(await page.evaluate(() => document.getElementById('dock')!.hasAttribute('inert')), true, 'the desks stay behind the open drawer')
    await page.keyboard.press('Control+Backquote')
    await page.waitForSelector('#drawer[data-open="false"]')

    // ---- 5. another slot swaps the content ----
    console.log('step 5')
    await openPeek(page, b)
    await openPeek(page, c)
    await page.waitForFunction(id => /PS .*>/.test(window.__tether.text(id)), c, { timeout: 15_000 })
    assert.equal(await page.evaluate(() => document.querySelectorAll('#peek .panel').length), 1, 'one terminal in the card')
    assert.equal(await page.evaluate(id => window.__tether.text(id), b), '', 'the first slot is out of the routing')

    // ---- 6. the slot ends with the card open ----
    console.log('step 6')
    await page.evaluate(id => window.tether.request({ t: 'stop', slotId: id }), c)
    await page.waitForFunction(id => window.__tether.slots().find(s => s.slotId === id)?.status === 'exited', c, { timeout: 20_000 })
    await page.waitForFunction(() => /^encerrada/.test(document.querySelector('#peek .peek-state')?.textContent ?? ''))
    assert.equal((await state(page)).open, true, 'the card stays, showing the end')
    assert.equal(await page.locator('#peek .peek-open').isDisabled(), true)
    assert.match((await page.locator('#peek .peek-foot').textContent())!, /^Sessão encerrada/)
    await page.click('#peek .peek-close')
    await waitClosed(page)
    assert.equal((await focusIs(page)).slot, keep)

    // ---- 7. Abrir nesta mesa ----
    console.log('step 7')
    await openPeek(page, b)
    await page.click('#peek .peek-open')
    await waitClosed(page)
    await page.waitForFunction(id => window.__tether.panelIds().includes(id), b)
    assert.equal(await pidOf(b), pidB, 'same process in the tab')
    await page.waitForFunction(id => /^pk-42$/m.test(window.__tether.text(id)), b, { timeout: 15_000 })
    await page.waitForFunction(id => document.activeElement?.closest('.panel')?.dataset.slotId === id, b)
    await page.keyboard.type("Write-Output ('tab-' + (7*6))")
    await page.keyboard.press('Enter')
    await page.waitForFunction(id => /^tab-42$/m.test(window.__tether.text(id)), b, { timeout: 15_000 })

    // ---- 8. a small window (6 px margin, the open button as an icon) ----
    console.log('step 8')
    await detachPane(page, b)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(400, 640))
    await openPeek(page, b)
    await sleep(300)
    const small = (await page.locator('#peek .peek-card').boundingBox())!
    assert.deepEqual([Math.round(small.x), Math.round(small.y)], [6, 6], 'a small window: 6 px')
    assert.equal(await page.locator('#peek .peek-open .label').isVisible(), false, 'the open button is an icon')
    await page.screenshot({ path: join(shots, 'e1a-cartao-estreito.png') })
    await page.click('#peek .peek-close')
    await waitClosed(page)
  } finally {
    console.log('teardown')
    if (app) await killElectron(app, root).catch(() => {})
    for (const d of daemons) await killOwned(d, { tree: true })
    for (let i = 0; i < 20 && daemons.some(d => pidAlive(d.pid)); i++) await sleep(500)
    for (let i = 0; i < 5; i++) {
      try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
  }
})
