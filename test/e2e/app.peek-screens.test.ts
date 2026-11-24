// E2E of the system screens in the peek card (hidden window, private home/pipe/user dir, real tetherd, shells only,
// CLAUDE* stripped):
//   1. Configurações (Ctrl+,) opens in the card, not as a tab; a switch in it is written to settings.json; Esc in the search
//      clears it and never closes the card (nor does Esc again in the empty field); the chord closes it and no tab is left;
//   2. Extensões opens in the card; "Abrir nesta mesa" makes it a tab and closes the card; the command again goes to the tab;
//   3. Atalhos de teclado opens in the card; its own chord (Ctrl+K Ctrl+K) records the selected row there; recording
//      Ctrl+` and then Ctrl+Shift+O (the card's own keys) never closes the card; the recorded key is written to
//      keybindings.json (and given back with ↺);
//   4. an agent peeked (its tab's terminal lent) -> Atalhos de teclado: the card shows the screen with "← <agent>"; closing the
//      screen goes back to the agent with its terminal alive; closing again closes the card and the tab has its terminal
//      back; the back button does the same.
// Run alone: node --test test/e2e/app.peek-screens.test.ts   (one E2E at a time: the build is remade)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { claim, killOwned, killTestPtyd, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type PeekState = { open: boolean; slotId?: string; routed: boolean; lent: boolean; screen?: string; screenType?: string; under?: string; underRouted?: boolean }
type Hooks = {
  panelIds(): string[]
  activeId(): string | undefined
  activate(id: string): void
  palette(): { open: boolean }
  slots(): SlotState[]
  connection(): { connected: boolean; pid?: number } | undefined
  text(slotId: string): string
  peek(slotId: string): void
  peekState(): PeekState
  activeDesk(): string
  createDesk(side: 'before' | 'after', relativeTo?: string): string
  switchDesk(id: string): void
  runCommand(id: string): Promise<string>
  settingsScreen(): { id: string; query: string; rows: { key: string; visible: boolean }[] }[]
  keybindings(): { id: string; query: string; selected?: string; dialog?: { command: string; keys: string } }[]
  keyTable(): { keys: string; command: string }[]
}
declare const window: { __tether: Hooks }
declare const document: { querySelectorAll(selector: string): { length: number }; activeElement: { closest(s: string): unknown } | null }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const shots = process.env.PEEK_SHOTS_DIR ?? 'C:/atrium/.tmp/tether-agents/onda-3/espiar'
const pipe = `\\\\.\\pipe\\tether-pscreens-${process.pid}`

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const stripComments = (s: string): string => s.replace(/\/\/.*$/gm, '')

async function launch(home: string, userDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_') && !k.toUpperCase().startsWith('CLAUDE')) env[k] = v
  env.TETHER_PIPE = pipe
  env.TETHER_HOME = home
  env.TETHER_USER_DIR = userDir
  env.TETHER_E2E_HIDDEN = '1'
  delete env.TETHER_CLAUDE_ARGS
  delete env.NODE_TEST_CONTEXT
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10_000)
  page.on('pageerror', e => console.error(`renderer error: ${e.message}`))
  page.on('console', m => { if (m.type() === 'error') console.error(`renderer console: ${m.text()}`) })
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  return { app, page }
}

const idsOf = (page: Page): Promise<string[]> => page.evaluate(() => window.__tether.panelIds())
const state = (page: Page): Promise<PeekState> => page.evaluate(() => window.__tether.peekState())
const waitClosed = (page: Page): Promise<unknown> => page.waitForSelector('#peek', { state: 'hidden' })
const waitScreen = (page: Page, type: string): Promise<unknown> => page.waitForFunction(t => window.__tether.peekState().screenType === t, type)
const keysOf = async (page: Page, command: string): Promise<string[]> => (await page.evaluate(() => window.__tether.keyTable())).filter(b => b.command === command).map(b => b.keys)
const kb = async (page: Page) => (await page.evaluate(() => window.__tether.keybindings()))[0]

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

test('telas do sistema no cartão de espiar: abrir, mudar, gravar atalho, Esc, abrir nesta mesa, guia única, voltar ao agente', { timeout: 600_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  await mkdir(tmpdir(), { recursive: true })
  // Straight in the temp dir with a `tether-` name: test/kill.ts knows it as a test home (killTestPtyd).
  const home = mkdtempSync(join(tmpdir(), 'tether-pscreens-home-'))
  const userDir = mkdtempSync(join(tmpdir(), 'tether-pscreens-user-'))
  const settingsFile = join(userDir, 'settings.json')
  writeFileSync(settingsFile, '{\n  "theme": "dark"\n}\n')
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home, userDir))
    daemons.push(await claim((await page.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800))
    await mkdir(shots, { recursive: true })

    const deskOne = await page.evaluate(() => window.__tether.activeDesk())
    const a = await createShell(page, home)
    await page.locator(`.panel[data-slot-id="${a}"] .xterm`).click()

    // ---- 1. Configurações in the card ----
    console.log('step 1')
    await page.keyboard.press('Control+Comma')
    await waitScreen(page, 'settings')
    await page.waitForSelector('#peek .st-pane .st-item[data-key="ui.deskLine"]')
    assert.equal((await idsOf(page)).some(id => id.startsWith('settings:')), false, 'no tab: the page is in the card')
    assert.equal((await page.locator('#peek .peek-title').textContent())?.trim(), 'Configurações')
    assert.equal(await page.locator('#peek .peek-state').isVisible(), false, 'a screen has no state')
    assert.equal(await page.locator('#peek .peek-back').isVisible(), false, 'nothing under it: no back button')
    assert.equal((await page.locator('#peek .peek-open').textContent())?.trim(), 'Abrir nesta mesa')
    assert.equal(await page.locator('#peek .peek-open-more').isVisible(), true, 'the ▾ of the other desks')
    await page.waitForFunction(() => !!document.activeElement?.closest('#peek .st-pane'))
    await sleep(300)
    await page.screenshot({ path: join(shots, 'tela-config-cartao.png') })
    // a switch is written as always
    await page.click('#peek .st-item[data-key="ui.deskLine"] .st-switch')
    const deskLine = (): unknown => (JSON.parse(stripComments(readFileSync(settingsFile, 'utf8'))) as Record<string, unknown>)['ui.deskLine']
    for (let i = 0; i < 50 && deskLine() !== false; i++) await sleep(100)
    assert.equal(deskLine(), false, 'settings.json got ui.deskLine false')
    // Esc in the search clears it and does not close; Esc in the empty field does not close either
    await page.fill('#peek .st-q', 'minimapa')
    await page.waitForFunction(() => window.__tether.settingsScreen()[0]?.query === 'minimapa')
    await page.focus('#peek .st-q')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => window.__tether.settingsScreen()[0]?.query === '')
    assert.equal((await state(page)).open, true, 'Esc cleared the search and left the card open')
    await page.keyboard.press('Escape')
    await sleep(300)
    assert.equal((await state(page)).open, true, 'Esc in the content never closes the card')
    await page.keyboard.press('Control+Shift+O')
    await waitClosed(page)
    assert.equal((await idsOf(page)).some(id => id.startsWith('settings:')), false, 'closed: no tab left behind')
    assert.deepEqual(await page.evaluate(() => window.__tether.settingsScreen()), [], 'the card\'s page is gone')

    // ---- 2. Extensões: "Abrir nesta mesa" makes it a tab; the command again goes to the tab ----
    console.log('step 2')
    await page.evaluate(() => window.__tether.runCommand('extensions.show'))
    await waitScreen(page, 'extensions')
    await page.waitForSelector('#peek .ext-pane')
    await page.click('#peek .peek-open')
    await waitClosed(page)
    await page.waitForFunction(() => window.__tether.panelIds().some(id => id.startsWith('extensions:')))
    const extTab = (await idsOf(page)).find(id => id.startsWith('extensions:'))!
    assert.equal(await page.evaluate(() => window.__tether.activeId()), extTab, 'the tab is the active pane')
    await page.evaluate(id => window.__tether.activate(id), a)
    await page.waitForFunction(id => window.__tether.activeId() === id, a)
    await page.evaluate(() => window.__tether.runCommand('extensions.show'))
    await page.waitForFunction(id => window.__tether.activeId() === id, extTab)
    assert.equal((await state(page)).open, false, 'with a tab open the command goes to the tab, never the card')
    assert.equal((await idsOf(page)).filter(id => id.startsWith('extensions:')).length, 1, 'one screen')
    await page.evaluate(id => window.__tether.activate(id), a)
    await page.locator(`.panel[data-slot-id="${a}"] .xterm`).click()

    // ---- 3. Atalhos de teclado: its own chord, recording the card's keys ----
    console.log('step 3')
    await page.evaluate(() => window.__tether.runCommand('keybindings.show'))
    await waitScreen(page, 'keybindings')
    await page.waitForSelector('#peek .kb-pane')
    await page.waitForFunction(() => !!document.activeElement?.closest('#peek .kb-list'))
    await page.fill('#peek .kb-q', 'fechar mesa')
    await page.waitForFunction(() => window.__tether.keybindings()[0]?.selected === 'desk.close')
    await page.focus('#peek .kb-list')
    // the screen's own Ctrl+K Ctrl+K works in the card (its context flag counts there)
    await page.keyboard.press('Control+K')
    await page.keyboard.press('Control+K')
    await page.waitForFunction(() => window.__tether.keybindings()[0]?.dialog?.command === 'desk.close')
    await page.waitForFunction(() => !!document.activeElement?.closest('#peek .kb-veil'))
    await page.keyboard.press('Control+Backquote')
    await sleep(300)
    assert.equal((await state(page)).open, true, 'Ctrl+` while recording does not close the card')
    assert.match((await kb(page))!.dialog!.keys, /^Ctrl\+/, 'Ctrl+` was recorded')
    await page.keyboard.press('Backspace')
    await page.keyboard.press('Control+Shift+O')
    await page.waitForFunction(() => window.__tether.keybindings()[0]?.dialog?.keys === 'Ctrl+Shift+O')
    assert.equal((await state(page)).open, true, 'Ctrl+Shift+O while recording does not close the card')
    await page.keyboard.press('Control+Shift+P')
    await page.waitForFunction(() => window.__tether.keybindings()[0]?.dialog?.keys === 'Ctrl+Shift+O Ctrl+Shift+P')
    assert.equal((await page.evaluate(() => window.__tether.palette())).open, false, 'the palette does not open while recording')
    await page.keyboard.press('Backspace')
    await page.waitForFunction(() => window.__tether.keybindings()[0]?.dialog?.keys === 'Ctrl+Shift+O')
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => !window.__tether.keybindings()[0]?.dialog)
    assert.equal((await state(page)).open, true, 'committing the key leaves the card open')
    await page.waitForFunction(() => window.__tether.keyTable().some(b => b.command === 'desk.close' && b.keys === 'ctrl+shift+o'))
    const kbFile = join(userDir, 'keybindings.json')
    for (let i = 0; i < 50 && !/ctrl\+shift\+o/.test((() => { try { return readFileSync(kbFile, 'utf8') } catch { return '' } })()); i++) await sleep(100)
    assert.match(readFileSync(kbFile, 'utf8'), /"ctrl\+shift\+o"[^\n]*"desk\.close"/, 'keybindings.json written')
    // give both keys back (↺) so the card's chord is Ctrl+Shift+O again
    await page.click('#peek tr.r[data-command="desk.close"] button[data-a="reset"]')
    await page.fill('#peek .kb-q', 'fechar o cartão de espiar')
    await page.waitForSelector('#peek tr.r[data-command="peek.close"] button[data-a="reset"]')
    await page.click('#peek tr.r[data-command="peek.close"] button[data-a="reset"]')
    await page.waitForFunction(() => window.__tether.keyTable().some(b => b.command === 'peek.close' && b.keys === 'ctrl+shift+o'))
    assert.deepEqual(await keysOf(page, 'desk.close'), ['ctrl+k f'])
    await page.click('#peek .peek-close')
    await waitClosed(page)
    assert.equal((await idsOf(page)).some(id => id.startsWith('keybindings:')), false, 'no tab left behind')

    // ---- 4. agent peeked -> Atalhos -> back to the agent ----
    console.log('step 4')
    const b = await createShell(page, home)
    const deskTwo = await page.evaluate(() => window.__tether.createDesk('after'))
    await page.evaluate(id => window.__tether.switchDesk(id), deskTwo)
    await page.waitForFunction(id => window.__tether.activeDesk() === id, deskTwo)
    await page.evaluate(id => window.__tether.peek(id), b)
    await page.waitForFunction(id => { const s = window.__tether.peekState(); return s.open && s.slotId === id && s.routed && s.lent }, b)
    await page.evaluate(() => window.__tether.runCommand('keybindings.show'))
    await waitScreen(page, 'keybindings')
    let s = await state(page)
    assert.equal(s.under, b, 'the agent is under the screen')
    assert.equal(s.lent, true, 'its tab\'s terminal is still lent (the tab keeps "sendo espiado")')
    assert.equal(s.underRouted, true)
    assert.equal(await page.locator('#peek .peek-back').isVisible(), true, 'the back button')
    const agentName = (await page.locator('#peek .peek-back .label').textContent())!.trim()
    assert.ok(agentName.length > 0, 'the back button names the agent')
    assert.match((await page.locator('#peek .peek-foot').textContent())!, new RegExp(`para voltar a ${agentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.$`))
    await page.waitForFunction(() => !!document.activeElement?.closest('#peek .kb-pane'))
    await sleep(300)
    await page.screenshot({ path: join(shots, 'tela-atalhos-voltar.png') })
    // closing the screen (the chord) goes back to the agent, its terminal alive
    await page.keyboard.press('Control+Shift+O')
    await page.waitForFunction(id => { const s = window.__tether.peekState(); return s.open && s.slotId === id && !s.screen && s.routed && s.lent }, b)
    assert.equal(await page.locator('#peek .peek-back').isVisible(), false)
    await page.waitForFunction(() => !!document.activeElement?.closest('#peek .xterm'))
    await page.keyboard.type('Write-Host vivo-no-cartao')
    await page.keyboard.press('Enter')
    await page.waitForFunction(id => window.__tether.text(id).split('\n').some(l => l.trim() === 'vivo-no-cartao'), b)
    // the back button does the same
    await page.evaluate(() => window.__tether.runCommand('settings.show'))
    await waitScreen(page, 'settings')
    await page.click('#peek .peek-back')
    await page.waitForFunction(id => { const s = window.__tether.peekState(); return s.open && s.slotId === id && !s.screen && s.lent }, b)
    // closing again closes the card; the tab has its terminal back
    await page.keyboard.press('Control+Shift+O')
    await waitClosed(page)
    s = await state(page)
    assert.equal(s.lent, false)
    await page.evaluate(id => window.__tether.switchDesk(id), deskOne)
    await page.waitForFunction(id => window.__tether.activeDesk() === id, deskOne)
    await page.evaluate(id => window.__tether.activate(id), b)
    await page.waitForSelector(`.panel[data-slot-id="${b}"] .xterm`)
    assert.equal(await page.locator(`.panel[data-slot-id="${b}"] .peek-lent`).count(), 0, 'no "sendo espiado" left on the tab')
    await page.locator(`.panel[data-slot-id="${b}"] .xterm`).click()
    await page.keyboard.type('Write-Host de-volta-na-guia')
    await page.keyboard.press('Enter')
    await page.waitForFunction(id => window.__tether.text(id).split('\n').some(l => l.trim() === 'de-volta-na-guia'), b)
  } finally {
    console.log('teardown')
    if (app) await killElectron(app, root).catch(() => {})
    for (const dm of daemons) await killOwned(dm, { tree: true })
    await killTestPtyd(home).catch(() => [])
    for (const dir of [home, userDir]) for (let i = 0; i < 5; i++) {
      try { rmSync(dir, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
  }
})
