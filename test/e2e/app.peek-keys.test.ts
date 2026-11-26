// E2E of the peek card's keyboard side (slice E4), all by keys where a key exists (hidden window, private home/pipe, real tetherd,
// shells only, CLAUDE* stripped):
//   1. the palette offers "Espiar guia…" (Ctrl+Shift+P): the picker lists every tab and the live sessions with none, Enter opens the card;
//      "Fechar o cartão de espiar" is in the palette only with the card open;
//   2. with the card open an app chord (Ctrl+Tab, which switches desks) does nothing; the palette still opens and its
//      "Fechar o cartão de espiar" closes the card; the chord Ctrl+Shift+O closes it too;
//   3. the card is a modal dialog named after the agent, its buttons have names, the state is a polite live region; the focus starts
//      in the terminal and Tab / Shift+Tab never leave the card;
//   4. the keyboard goes back to where it was: a sessions panel row -> the bar's sessions button (the panel hid itself). (The
//      channel's speech box and a context menu item are in app.peek-keys-channel.test.ts.)
// Run alone: node --test test/e2e/app.peek-keys.test.ts   (one E2E at a time: the build is remade)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
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
  peek(slotId: string): void
  peekState(): { open: boolean; slotId?: string; routed: boolean; lent: boolean }
  activeDesk(): string
  createDesk(side: 'before' | 'after', relativeTo?: string): string
  switchDesk(id: string): void
  palette(): { open: boolean; shown: string[]; input: string }
  drawer(): { open: boolean }
  openDrawer(): void
}
declare const window: { __tether: Hooks }
type El = { id: string; closest(s: string): unknown; getAttribute(n: string): string | null }
declare const document: { querySelectorAll(selector: string): { length: number }; activeElement: El | null }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const shots = process.env.PEEK_SHOTS_DIR ?? 'C:/atrium/.tmp/tether-agents/onda-3/espiar'
const pipe = `\\\\.\\pipe\\tether-pkeys-${process.pid}`

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

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

const idsOf = (page: Page): Promise<string[]> => page.evaluate(() => window.__tether.panelIds())

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

async function detachPane(page: Page, slotId: string): Promise<void> {
  const tab = page.locator(`.tether-tab[data-slot="${slotId}"]`)
  await tab.hover()
  await tab.locator('.close').click()
  await page.locator('dialog[open] button.choice[data-choice="detach"]').click()
  await page.waitForFunction(id => !window.__tether.panelIds().includes(id), slotId)
}

/** Where the keyboard is: inside the card, in its terminal, and the id of the element (for the bar's buttons). */
const focusIs = (page: Page) => page.evaluate(() => {
  const a = document.activeElement
  return { peek: !!a?.closest('#peek'), xterm: !!a?.closest('.xterm'), id: a?.id ?? '' }
})
const peekOpen = async (page: Page): Promise<boolean> => (await page.evaluate(() => window.__tether.peekState())).open
const waitClosed = (page: Page): Promise<unknown> => page.waitForSelector('#peek', { state: 'hidden' })
const waitPeek = (page: Page, slotId: string): Promise<unknown> =>
  page.waitForFunction(id => { const s = window.__tether.peekState(); return s.open && s.slotId === id && s.routed }, slotId)

/** Ctrl+Shift+P, then the text, then waits for the row the text finds. */
async function paletteFind(page: Page, text: string, command: string): Promise<void> {
  await page.keyboard.press('Control+Shift+P')
  await page.waitForFunction(() => window.__tether.palette().open)
  await page.keyboard.type(text)
  await page.waitForFunction(c => window.__tether.palette().shown.includes(c), command)
}

test('cartão de espiar pelo teclado: comandos, chords quietas, foco preso, foco de volta', { timeout: 480_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  const home = mkdtempSync(join(tmpdir(), 'tether-pkeys-'))
  const cwd = home
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    daemons.push(await claim((await page.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800))

    // setup: `keep` stays in a tab, `b` runs without one, a second desk exists (Ctrl+Tab would go there)
    const keep = await createShell(page, cwd)
    const b = await createShell(page, cwd)
    await detachPane(page, b)
    const deskOne = await page.evaluate(() => window.__tether.activeDesk())
    await page.evaluate(() => { window.__tether.createDesk('after') })
    await page.evaluate(id => window.__tether.switchDesk(id), deskOne)
    await page.waitForFunction(id => window.__tether.activeDesk() === id, deskOne)
    await page.locator(`.panel[data-slot-id="${keep}"] .xterm`).click()

    // ---- 1. the palette: "Espiar agente…" and the picker ----
    console.log('step 1')
    await paletteFind(page, 'cartão de espiar', 'peek.pick').catch(() => {}) // "Fechar…" must NOT be there, so this never finds peek.close
    assert.equal(await page.evaluate(() => window.__tether.palette().shown.includes('peek.close')), false, '"Fechar o cartão de espiar" is not offered with the card closed')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !window.__tether.palette().open)
    await paletteFind(page, 'Espiar guia', 'peek.pick')
    assert.equal(await page.evaluate(() => window.__tether.palette().shown.includes('peek.close')), false)
    await page.keyboard.press('Enter')
    await page.waitForSelector('dialog.picker[open]')
    // "Espiar guia…" lists every tab (the one in view too) and, last, in "Sem guia", the session no tab shows.
    const rows = await page.locator('dialog.picker .pk-item').count()
    assert.equal(rows, 2, 'the tab in view and the session no tab shows are listed')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await waitPeek(page, b)
    await page.waitForFunction(() => !!document.activeElement?.closest('#peek .xterm'))
    const first = await focusIs(page)
    assert.deepEqual([first.peek, first.xterm], [true, true], 'the card opens with the keyboard in its terminal')

    // ---- 2. quiet chords; the palette and the close stay ----
    console.log('step 2')
    const ids = await idsOf(page)
    await page.keyboard.press('Control+Tab')
    await sleep(500)
    assert.equal(await page.evaluate(() => window.__tether.activeDesk()), deskOne, 'Ctrl+Tab does not switch desks behind the card')
    assert.equal(await peekOpen(page), true)
    await page.keyboard.press('Control+Shift+T')
    await sleep(300)
    assert.deepEqual(await idsOf(page), ids, 'no new tab behind the card')
    await paletteFind(page, 'Fechar o cartão de espiar', 'peek.close')
    await page.keyboard.press('Enter')
    await waitClosed(page)
    assert.equal(await peekOpen(page), false, 'the palette closed the card')
    assert.equal(await page.evaluate(() => window.__tether.activeDesk()), deskOne)
    await page.evaluate(id => window.__tether.peek(id), b)
    await waitPeek(page, b)
    await page.keyboard.press('Control+Shift+O')
    await waitClosed(page)

    // ---- 2b. the drawer's key closes the card (and only the card) ----
    console.log('step 2b')
    await page.evaluate(id => window.__tether.peek(id), b)
    await waitPeek(page, b)
    await page.keyboard.press('Control+Backquote')
    await waitClosed(page)
    assert.equal((await page.evaluate(() => window.__tether.drawer())).open, false, 'no drawer behind: the key closes the card and opens nothing')
    await page.evaluate(() => window.__tether.openDrawer())
    await page.waitForFunction(() => window.__tether.drawer().open)
    await page.evaluate(id => window.__tether.peek(id), b)
    await waitPeek(page, b)
    await page.keyboard.press('Control+Backquote')
    await waitClosed(page)
    assert.equal((await page.evaluate(() => window.__tether.drawer())).open, true, 'the drawer under the card stays open')
    await page.keyboard.press('Control+Backquote')
    await page.waitForFunction(() => !window.__tether.drawer().open)
    await page.locator(`.panel[data-slot-id="${keep}"] .xterm`).click()

    // ---- 3. dialog, names, live region, Tab stays inside ----
    console.log('step 3')
    await page.evaluate(id => window.__tether.peek(id), b)
    await waitPeek(page, b)
    await page.waitForFunction(() => !!document.activeElement?.closest('#peek .xterm'))
    const card = page.locator('#peek .peek-card')
    assert.equal(await card.getAttribute('role'), 'dialog')
    assert.equal(await card.getAttribute('aria-modal'), 'true')
    assert.match((await card.getAttribute('aria-label'))!, /^Espiando .+/)
    for (const sel of ['.peek-close', '.peek-open-more', '.peek-menu']) assert.ok(((await page.locator(`#peek ${sel}`).getAttribute('aria-label')) ?? '').length > 0, `${sel} has a name`)
    assert.equal(await page.locator('#peek .peek-state').getAttribute('aria-live'), 'polite')
    // the top: "Fechar" is the accent button at the right end, the ways of opening are neutral
    assert.equal((await page.locator('#peek .peek-close').textContent())!.trim(), 'Fechar')
    assert.match((await page.locator('#peek .peek-close').getAttribute('class'))!, /primary/)
    assert.doesNotMatch((await page.locator('#peek .peek-open').getAttribute('class'))!, /primary/)
    assert.match((await page.locator('#peek .peek-close').getAttribute('title'))!, /^Fechar \(Ctrl\+` ou Ctrl\+Shift\+O\)$/)
    assert.match((await page.locator('#peek .peek-foot').textContent())!, /^Feche pelo botão, pela margem ou por Ctrl\+` ou Ctrl\+Shift\+O\. O Esc fica com o terminal\.$/)
    const closeBox = (await page.locator('#peek .peek-close').boundingBox())!
    const menuBox = (await page.locator('#peek .peek-menu').boundingBox())!
    assert.ok(menuBox.x < closeBox.x, '"⋯" sits left of "Fechar"')
    await mkdir(shots, { recursive: true })
    await page.screenshot({ path: join(shots, 'e4-cartao-topo.png') })
    await page.focus('#peek .peek-open')
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Tab')
      assert.equal((await focusIs(page)).peek, true, `Tab ${i + 1} stays in the card`)
    }
    await page.focus('#peek .peek-open')
    await page.keyboard.press('Shift+Tab')
    assert.deepEqual([(await focusIs(page)).peek, (await focusIs(page)).xterm], [true, true], 'Shift+Tab from the first button wraps to the terminal')
    await page.focus('#peek .peek-close')
    await page.keyboard.press('Tab')
    assert.deepEqual([(await focusIs(page)).peek, (await focusIs(page)).xterm], [true, true], 'Tab from the last button goes to the terminal')
    await page.keyboard.press('Control+Shift+O')
    await waitClosed(page)

    // ---- 4a. from a row of the sessions panel: back to the bar's sessions button ----
    console.log('step 4a')
    await page.locator(`.panel[data-slot-id="${keep}"] .xterm`).click()
    await page.focus('#btn-sessions')
    await page.keyboard.press('Enter')
    await page.waitForSelector('#sessions-list:not([hidden])')
    await page.locator(`#sessions-list .sx-row[data-slot="${b}"] button.peek`).focus()
    await page.keyboard.press('Enter')
    await waitPeek(page, b)
    await page.keyboard.press('Control+Shift+O')
    await waitClosed(page)
    assert.equal((await focusIs(page)).id, 'btn-sessions', 'the keyboard is back on the sessions button')

    // (the speech box and the context-menu item are in app.peek-keys-channel.test.ts: they need the channel's pane)
  } finally {
    console.log('teardown')
    if (app) await killElectron(app, root).catch(() => {})
    for (const dm of daemons) await killOwned(dm, { tree: true })
    for (let i = 0; i < 5; i++) {
      try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
  }
})
