// E2E of the peek card for a slot WITH a tab (app/renderer/peek.ts lends the tab's terminal; panel.ts TerminalPanel.lend /
// takeBack), with shells only (hidden window, private home/pipe, real tetherd, CLAUDE* stripped):
//   1. the tab on ANOTHER desk: `peek` opens the card with the tab's own terminal (the same xterm moves: a marker echoed
//      before is in it, the tab keeps no xterm), typing in the card works (output flows while lent), the pty takes the
//      card's size; the tab shows "sendo espiado" and its tab an eye;
//   2. the window shrinks with the card open (card smaller than the tab), the card closes, the window grows back: the tab,
//      visited, has its terminal alive with what was typed in the card, and the pty's cols/rows equal the tab's view;
//   3. the inverse (tab narrower than the card: split beside another pane): same check;
//   4. the tab IN VIEW: `peek` only moves the keyboard to it, no card;
//   5. the tab moved, then closed ("só fechar"), with the card open: never a tab without a terminal, nothing breaks;
//   6. the session ends with the card open: the terminal goes back, the tab shows the end;
//   captures (PEEK_SHOTS_DIR, default C:/atrium/.tmp/tether-agents/onda-3/espiar): e2-cartao-emprestado.png, e2-guia-sendo-espiada.png.
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
  connection(): { connected: boolean; pid?: number } | undefined
  text(slotId: string): string
  termSize(slotId: string): { cols: number; rows: number } | undefined
  peek(slotId: string): void
  peekState(): { open: boolean; slotId?: string; routed: boolean; lent: boolean }
  createDesk(side: 'before' | 'after', relativeTo?: string): string
  switchDesk(id: string): void
  activeDesk(): string
  deskOf(slotId: string): string | undefined
  movePaneToDesk(slotId: string, deskId: string): void
  duplicate(slotId: string, direction: string): void
  closePanel(slotId: string): void
}
type El = { hidden: boolean; style: Record<string, string>; closest(s: string): (El & { dataset: Record<string, string> }) | null; querySelector(s: string): El | null; textContent: string | null }
declare const window: { __tether: Hooks; tether: { request(body: unknown): Promise<unknown> } }
declare const document: { querySelectorAll(selector: string): { length: number }; querySelector(selector: string): El | null; getElementById(id: string): El | null; activeElement: El | null }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const shots = process.env.PEEK_SHOTS_DIR ?? 'C:/atrium/.tmp/tether-agents/onda-3/espiar'
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-peek-lend-${process.pid}`

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
const sizeOf = async (page: Page, id: string): Promise<{ cols: number; rows: number }> => (await page.evaluate(id => window.__tether.termSize(id), id))!

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

/** Types a line into the terminal that has the keyboard and waits for `expect` in the slot's screen. */
async function run(page: Page, id: string, line: string, expect: RegExp): Promise<void> {
  await page.keyboard.type(line)
  await page.keyboard.press('Enter')
  await page.waitForFunction(([id, src]) => new RegExp(src, 'm').test(window.__tether.text(id)), [id, expect.source] as const, { timeout: 15_000 })
}

let sizeTag = 0
/** The pty's size as the shell reads it (the console window = the pty), typed into the terminal that has the keyboard. */
async function ptySize(page: Page, id: string): Promise<{ cols: number; rows: number }> {
  const tag = `sz${++sizeTag}`
  const re = new RegExp(`^${tag}-(\\d+)x(\\d+)\\s*$`, 'm')
  await run(page, id, `Write-Output ("${tag}-" + $Host.UI.RawUI.WindowSize.Width + "x" + $Host.UI.RawUI.WindowSize.Height)`, re)
  const m = re.exec(await textOf(page, id))!
  return { cols: Number(m[1]), rows: Number(m[2]) }
}

/** Where the slot's xterm lives now: in the card, in its tab, or nowhere; and whether its tab shows the "sendo espiado" notice. */
const whereIs = (page: Page, id: string) => page.evaluate(id => {
  const tab = document.querySelector(`.panel[data-slot-id="${id}"]`)
  return {
    inCard: document.querySelectorAll('#peek .peek-body > .panel-body .xterm').length,
    inTab: !!tab?.querySelector('.xterm'),
    notice: !!tab?.querySelector('.peek-lent'),
    eye: document.querySelector(`.tether-tab[data-slot="${id}"] .peek-mark`)?.hidden === false,
  }
}, id)

async function openLent(page: Page, slotId: string): Promise<void> {
  await page.evaluate(id => window.__tether.peek(id), slotId)
  await page.waitForSelector('#peek[data-open="true"]')
  await page.waitForFunction(id => { const s = window.__tether.peekState(); return s.open && s.slotId === id && s.routed && s.lent }, slotId)
  await page.waitForFunction(() => !!document.activeElement?.closest('#peek .xterm'))
}
const waitClosed = (page: Page): Promise<unknown> => page.waitForSelector('#peek', { state: 'hidden' })

/** Goes to the tab (its desk), gives its terminal the keyboard and waits until it fitted the view (the size settles). */
async function visitTab(page: Page, deskId: string, slotId: string): Promise<void> {
  await page.evaluate(id => window.__tether.switchDesk(id), deskId)
  await page.locator(`.panel[data-slot-id="${slotId}"] .xterm`).click()
  await page.waitForFunction(id => document.activeElement?.closest('.panel')?.dataset.slotId === id, slotId)
  await sleep(400) // the 40 ms fit debounce and the resize round trip
}

test('espiar quem tem guia: empréstimo do terminal, aviso na guia, devolução com o tamanho certo, guia à vista, mover, fechar, encerrar', { timeout: 480_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(shots, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-peek-lend-'))
  const cwd = home
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    daemons.push(await claim((await page.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    const setWindow = (w: number, h: number): Promise<void> => app!.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0]?.setContentSize(w!, h!), [w, h])
    await setWindow(1280, 800)
    const pidOf = async (id: string): Promise<number> => (await slotsOf(page)).find(s => s.slotId === id)!.pid!

    // ---- 1. the tab on another desk: the card borrows its terminal ----
    console.log('step 1')
    const deskA = await page.evaluate(() => window.__tether.activeDesk())
    const g = await createShell(page, cwd)
    const pidG = await pidOf(g)
    await page.locator(`.panel[data-slot-id="${g}"] .xterm`).click()
    await run(page, g, "Write-Output ('mk-' + (5*5))", /^mk-25$/)
    const deskB = await page.evaluate(() => window.__tether.createDesk('after'))
    await page.evaluate(id => window.__tether.switchDesk(id), deskB)
    const keep = await createShell(page, cwd) // the keyboard's home on desk B
    await page.locator(`.panel[data-slot-id="${keep}"] .xterm`).click()
    await page.waitForFunction(id => document.activeElement?.closest('.panel')?.dataset.slotId === id, keep)
    await sleep(500) // the tab on desk A has been off screen past HIDE_DELAY_MS: its output would be paused
    const keepSize = await sizeOf(page, keep)

    await openLent(page, g)
    await sleep(300)
    assert.deepEqual(await sizeOf(page, keep), keepSize, 'the pane behind the card keeps its size (the window behind is not laid out again)')
    assert.deepEqual(await whereIs(page, g), { inCard: 1, inTab: false, notice: true, eye: true }, 'the same xterm moved to the card; the tab shows the notice and an eye')
    assert.match(await textOf(page, g), /^mk-25$/m, 'what the tab showed is in the card')
    await run(page, g, "Write-Output ('pk-' + (6*7))", /^pk-42$/m) // typing in the card works; the output flows while lent
    assert.equal(await page.locator('#peek .peek-open .label').textContent(), 'Ir para a guia')
    assert.equal(await page.locator('#peek .peek-open-more').isHidden(), true, 'no ▾ for a slot with a tab')
    assert.match((await page.locator('#peek .peek-foot').textContent())!, /^Fechar: ✕/)
    const cardWide = await sizeOf(page, g)
    assert.deepEqual(await ptySize(page, g), cardWide, 'the pty takes the card\'s size')
    await page.screenshot({ path: join(shots, 'e2-cartao-emprestado.png') })

    // The tab, seen while the card is open (the card hidden for the picture only).
    const lent = page.locator(`.panel[data-slot-id="${g}"] .peek-lent`)
    assert.equal(await lent.locator('p.t').textContent(), `${cwd.split(/[\\/]/).pop()} está sendo espiado`)
    assert.equal(await lent.locator('p.mut').textContent(), 'O terminal dele está no cartão aberto na tela. Quando você fechar o cartão, ele volta para cá.')
    assert.equal(await lent.locator('button').count(), 0, 'no buttons: they would be out of reach behind the card')
    await page.evaluate(id => window.__tether.switchDesk(id), deskA)
    await page.evaluate(() => { document.getElementById('peek')!.style.visibility = 'hidden' })
    await sleep(600)
    const noticeBox = await page.evaluate(id => {
      type Box = { getBoundingClientRect(): { width: number; height: number }; checkVisibility(o: object): boolean }
      const e = document.querySelector(`.panel[data-slot-id="${id}"] .peek-lent`) as unknown as Box | null
      const r = e?.getBoundingClientRect()
      return { w: r?.width ?? 0, h: r?.height ?? 0, shown: !!e?.checkVisibility({ visibilityProperty: true }) }
    }, g)
    assert.ok(noticeBox.shown && noticeBox.w > 600 && noticeBox.h > 400, `the notice fills the tab (${JSON.stringify(noticeBox)})`)
    await page.screenshot({ path: join(shots, 'e2-guia-sendo-espiada.png') })
    await page.evaluate(() => { document.getElementById('peek')!.style.visibility = '' })
    await page.evaluate(id => window.__tether.switchDesk(id), deskB)
    assert.equal((await state(page)).lent, true, 'still lent')
    await page.locator('#peek .xterm').click() // the desk switches above moved the keyboard
    await page.waitForFunction(() => !!document.activeElement?.closest('#peek .xterm'))

    // ---- 2. card smaller than the tab: the window shrinks with the card open, then grows back with the card closed ----
    console.log('step 2')
    await setWindow(900, 600)
    await page.waitForFunction(([id, cols]) => window.__tether.termSize(id)!.cols < cols, [g, cardWide.cols] as const)
    await sleep(300)
    const cardSmall = await sizeOf(page, g)
    assert.deepEqual(await ptySize(page, g), cardSmall, 'the pty follows the card')
    await page.click('#peek .peek-close')
    await waitClosed(page)
    assert.equal((await page.evaluate(() => document.activeElement?.closest('.panel')?.dataset.slotId)), keep, 'the keyboard is back where it was')
    await setWindow(1280, 800)
    await visitTab(page, deskA, g)
    assert.deepEqual(await whereIs(page, g), { inCard: 0, inTab: true, notice: false, eye: false }, 'the terminal is back in the tab')
    assert.match(await textOf(page, g), /^pk-42$/m, 'what was typed in the card is in the tab')
    const tabWide = await sizeOf(page, g)
    assert.ok(tabWide.cols > cardSmall.cols, `the tab is wider than the card was (${tabWide.cols} > ${cardSmall.cols})`)
    assert.deepEqual(await ptySize(page, g), tabWide, 'the pty is back at the tab\'s size')
    assert.equal(await pidOf(g), pidG, 'same process')

    // ---- 3. the inverse: the tab narrower than the card (split beside another pane) ----
    console.log('step 3')
    const before = await idsOf(page)
    await page.evaluate(id => window.__tether.duplicate(id, 'right'), g)
    await page.waitForFunction(n => window.__tether.panelIds().length === n, before.length + 1, { timeout: 20_000 })
    const dup = (await idsOf(page)).find(x => !before.includes(x))!
    await page.waitForFunction(id => /PS .*>/.test(window.__tether.text(id)), dup, { timeout: 30_000 })
    await visitTab(page, deskA, g)
    const tabNarrow = await sizeOf(page, g)
    assert.deepEqual(await ptySize(page, g), tabNarrow)
    await visitTab(page, deskB, keep)
    await openLent(page, g)
    await sleep(300)
    const cardBig = await sizeOf(page, g)
    assert.ok(cardBig.cols > tabNarrow.cols, `the card is wider than the tab (${cardBig.cols} > ${tabNarrow.cols})`)
    assert.deepEqual(await ptySize(page, g), cardBig, 'the pty takes the card\'s size')
    await page.keyboard.press('Control+Shift+KeyO')
    await waitClosed(page)
    await visitTab(page, deskA, g)
    assert.deepEqual(await whereIs(page, g), { inCard: 0, inTab: true, notice: false, eye: false })
    assert.deepEqual(await sizeOf(page, g), tabNarrow, 'the tab fits its view again')
    assert.deepEqual(await ptySize(page, g), tabNarrow, 'the pty is back at the narrow tab\'s size')

    // ---- 4. the tab in view: peek only moves the keyboard ----
    console.log('step 4')
    await page.locator(`.panel[data-slot-id="${dup}"] .xterm`).click()
    await page.waitForFunction(id => document.activeElement?.closest('.panel')?.dataset.slotId === id, dup)
    await page.evaluate(id => window.__tether.peek(id), g)
    await page.waitForFunction(id => document.activeElement?.closest('.panel')?.dataset.slotId === id, g)
    await sleep(300)
    assert.equal((await state(page)).open, false, 'no card for a tab in view')
    assert.deepEqual(await whereIs(page, g), { inCard: 0, inTab: true, notice: false, eye: false })

    // ---- 5. the tab moved, then closed, with the card open ----
    console.log('step 5')
    await visitTab(page, deskB, keep)
    await openLent(page, g)
    await page.evaluate(([id, desk]) => window.__tether.movePaneToDesk(id, desk), [g, deskB] as const)
    await page.waitForFunction(([id, desk]) => window.__tether.deskOf(id) === desk, [g, deskB] as const)
    await sleep(500)
    {
      const s = await state(page)
      const w = await whereIs(page, g)
      console.log(`after the move: card ${s.open ? (s.lent ? 'open, lent' : 'open') : 'closed'}; ${JSON.stringify(w)}`)
      assert.ok((s.open && s.lent && w.notice && w.inCard === 1) || (!s.open && w.inTab && !w.notice), 'never a tab without a terminal')
      if (s.open) { await page.click('#peek .peek-close'); await waitClosed(page) }
    }
    await page.locator(`.panel[data-slot-id="${g}"] .xterm`).click()
    await run(page, g, "Write-Output ('mv-' + (8*8))", /^mv-64$/m)
    await page.evaluate(([id, desk]) => window.__tether.movePaneToDesk(id, desk), [g, deskA] as const)
    await page.waitForFunction(([id, desk]) => window.__tether.deskOf(id) === desk, [g, deskA] as const)
    await page.locator(`.panel[data-slot-id="${keep}"] .xterm`).click()
    await openLent(page, g)
    await page.evaluate(id => window.__tether.closePanel(id), g)
    await page.locator('dialog[open] button.choice[data-choice="detach"]').click()
    await page.waitForFunction(id => !window.__tether.panelIds().includes(id), g)
    await waitClosed(page)
    assert.ok(pidAlive(pidG), 'closing the tab ("só fechar") ends nothing')
    assert.equal(await page.evaluate(() => document.querySelectorAll('#peek .xterm').length), 0, 'nothing left in the card')
    // Now without a tab, the slot opens in the card with a terminal of its own.
    await page.evaluate(id => window.__tether.peek(id), g)
    await page.waitForFunction(id => { const s = window.__tether.peekState(); return s.open && s.slotId === id && s.routed && !s.lent }, g)
    await page.waitForFunction(id => /^mv-64$/m.test(window.__tether.text(id)), g, { timeout: 15_000 })

    // ---- 6. the session ends with the card open: the terminal goes back, the tab shows the end ----
    console.log('step 6')
    await page.click('#peek .peek-open') // "Abrir nesta mesa": a tab on desk B
    await waitClosed(page)
    await page.waitForFunction(id => window.__tether.panelIds().includes(id), g)
    await page.evaluate(([id, desk]) => window.__tether.movePaneToDesk(id, desk), [g, deskA] as const)
    await page.waitForFunction(([id, desk]) => window.__tether.deskOf(id) === desk, [g, deskA] as const)
    await page.locator(`.panel[data-slot-id="${keep}"] .xterm`).click()
    await openLent(page, g)
    await page.evaluate(id => window.tether.request({ t: 'stop', slotId: id }), g)
    await page.waitForFunction(id => window.__tether.slots().find(s => s.slotId === id)?.status === 'exited', g, { timeout: 20_000 })
    await waitClosed(page)
    const ended = await whereIs(page, g)
    assert.deepEqual(ended, { inCard: 0, inTab: true, notice: false, eye: false }, 'the terminal is back in the tab')
    await page.evaluate(id => window.__tether.switchDesk(id), deskA)
    await page.waitForFunction(id => document.querySelector(`.panel[data-slot-id="${id}"]`)?.closest('.panel')?.dataset.status === 'exited', g)
    assert.equal(await page.locator(`.panel[data-slot-id="${g}"] .panel-overlay`).isVisible(), true, 'the tab shows the end')
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
