// E2E of "Emblema…" in the "⋯" of the peek card (app/renderer/peek.ts, peek-rules.ts peekMenuPlan), shells only (hidden window,
// private home/pipe, real tetherd, CLAUDE* stripped):
//   1. a slot WITH a tab (its terminal lent to the card): the "⋯" has "Ir para a guia", "Emblema…", "Copiar link do painel", "Fechar";
//   2. "Emblema…" opens the tab's own popover over the card (it is the topmost thing at its centre); the pick puts the chip on the
//      tab, the card stays open and the keyboard is still inside the card;
//   3. "Gerenciar emblemas…" opens the editor dialog over the card; Esc closes it and the keyboard is back in the card;
//   4. a slot WITHOUT a tab (peeked in its own card): the "⋯" has no "Emblema…" (the emblem is the tab's).
//   capture: PEEK_SHOTS_DIR (default C:/atrium/.tmp/tether-agents/onda-3/espiar)/emblema-menu-cartao.png
// Run alone: node --test test/e2e/app.peek-emblem.test.ts   (one E2E at a time: the build is remade)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
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
  closePanel(slotId: string): void
  peek(slotId: string): void
  peekState(): { open: boolean; slotId?: string; routed: boolean; lent: boolean }
  createDesk(side: 'before' | 'after', relativeTo?: string): string
  switchDesk(id: string): void
  movePaneToDesk(slotId: string, deskId: string): void
}
type El = { closest(s: string): El | null; matches(s: string): boolean }
declare const window: { __tether: Hooks }
declare const document: { querySelectorAll(s: string): { length: number }; activeElement: El | null; elementFromPoint(x: number, y: number): El | null }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const shots = process.env.PEEK_SHOTS_DIR ?? 'C:/atrium/.tmp/tether-agents/onda-3/espiar'
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-peek-emblem-${process.pid}`

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

const menuRows = async (page: Page): Promise<string[]> => (await page.locator('#ctx-menu li').allInnerTexts()).map(t => t.replace(/\s+/g, ' ').trim()).filter(t => t !== '')
const inCard = (page: Page): Promise<boolean> => page.evaluate(() => !!document.activeElement?.closest('#peek'))

test('espiar: "Emblema…" no ⋯ do cartão (por cima do cartão, foco de volta) e ausente sem guia', { timeout: 300_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(shots, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-peek-emblem-'))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    daemons.push(await claim((await page.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800))

    // g's tab goes to another desk, so the card lends its terminal; the keyboard lives on desk B.
    const g = await createShell(page, home)
    const deskB = await page.evaluate(() => window.__tether.createDesk('after'))
    await page.evaluate(id => window.__tether.switchDesk(id), deskB)
    const keep = await createShell(page, home)
    await page.locator(`.panel[data-slot-id="${keep}"] .xterm`).click()
    await new Promise(r => setTimeout(r, 500))

    // ---- 1. the menu of a card with a tab ----
    console.log('step 1')
    await page.evaluate(id => window.__tether.peek(id), g)
    await page.waitForFunction(id => { const s = window.__tether.peekState(); return s.open && s.slotId === id && s.lent }, g)
    await page.waitForFunction(() => !!document.activeElement?.closest('#peek .xterm'))
    await page.click('#peek .peek-menu')
    await page.waitForSelector('#ctx-menu li')
    assert.deepEqual(await menuRows(page), ['Ir para a guia', 'Emblema…', 'Copiar link do painel', 'Fechar Ctrl+Shift+O'])

    // ---- 2. the popover opens over the card; the pick shows on the tab; the keyboard stays in the card ----
    console.log('step 2')
    await page.locator('#ctx-menu li[role^=menuitem]', { hasText: 'Emblema…' }).click()
    await page.waitForSelector('#ctx-menu.emb-menu')
    const onTop = await page.evaluate(() => {
      const m = (document as unknown as { getElementById(id: string): { getBoundingClientRect(): { left: number; top: number; width: number; height: number } } }).getElementById('ctx-menu')
      const r = m.getBoundingClientRect()
      return document.elementFromPoint(r.left + r.width / 2, r.top + 20)?.closest('#ctx-menu') !== null
    })
    assert.equal(onTop, true, 'the emblem popover is the topmost thing at its centre, over the card')
    assert.equal((await page.evaluate(() => window.__tether.peekState())).open, true, 'the card stays open')
    await page.screenshot({ path: join(shots, 'emblema-menu-cartao.png') })
    await page.locator('#ctx-menu.emb-menu li[role=menuitemradio]', { hasText: 'Cliente' }).click()
    await page.waitForSelector(`.tether-tab[data-slot="${g}"] .emb-chip:not([hidden])`, { state: 'attached' })
    assert.equal(await page.locator(`.tether-tab[data-slot="${g}"] .emb-chip`).first().getAttribute('title'), 'Cliente')
    await page.waitForFunction(() => !!document.activeElement?.closest('#peek'))
    assert.equal(await inCard(page), true, 'the keyboard is back in the card after the pick')

    // ---- 3. the editor over the card; Esc gives the keyboard back to the card ----
    console.log('step 3')
    await page.click('#peek .peek-menu')
    await page.locator('#ctx-menu li[role^=menuitem]', { hasText: 'Emblema…' }).click()
    await page.locator('#ctx-menu.emb-menu li', { hasText: 'Gerenciar emblemas…' }).click()
    await page.waitForSelector('dialog.emb-dlg[open]')
    assert.equal((await page.evaluate(() => window.__tether.peekState())).open, true, 'the card stays open under the editor')
    await page.keyboard.press('Escape')
    await page.waitForSelector('dialog.emb-dlg[open]', { state: 'detached' })
    await page.waitForFunction(() => !!document.activeElement?.closest('#peek'))
    assert.equal((await page.evaluate(() => window.__tether.peekState())).open, true, 'Esc closed the editor only')
    await page.click('#peek .peek-close')
    await page.waitForSelector('#peek', { state: 'hidden' })

    // ---- 4. a slot without a tab: no "Emblema…" ----
    console.log('step 4')
    await page.evaluate(id => window.__tether.closePanel(id), g)
    await page.locator('dialog[open] button.choice[data-choice="detach"]').click()
    await page.waitForFunction(id => !window.__tether.panelIds().includes(id), g)
    await page.evaluate(id => window.__tether.peek(id), g)
    await page.waitForFunction(id => { const s = window.__tether.peekState(); return s.open && s.slotId === id && !s.lent }, g)
    await page.click('#peek .peek-menu')
    await page.waitForSelector('#ctx-menu li')
    const noTab = await menuRows(page)
    assert.ok(noTab.includes('Abrir nesta mesa') && noTab.includes('Copiar link do painel'), `the menu of a card with no tab: ${noTab.join(' | ')}`)
    assert.equal(noTab.includes('Emblema…'), false, 'no tab, no emblem')
    await page.keyboard.press('Escape')
  } finally {
    if (app) await killElectron(app, root).catch(() => {})
    for (const d of daemons) await killOwned(d, { tree: true }).catch(() => {})
  }
})
