// E2E of the sessions menu feeding the peek card (hidden window, private home/pipe, real tetherd, shells only, CLAUDE* stripped):
//   1. "Sem guia": "Espiar" is the main button, "Abrir" a named secondary one with its ▾, "Encerrar" an icon; "Espiar" closes
//      the panel and opens the card; a click on the row does NOT peek; the "⋯" at the row's end lists every act;
//   2. "Abrir" puts the session in a tab of the current desk, the card stays closed;
//   3. the ▾ list "Abrir em outra mesa": the desks (the current one checked), a separator, "Escolher o lugar…"; a desk picked
//      opens the tab THERE and the active desk does not change; "Escolher o lugar…" opens the tab here and the move screen;
//   4. "Reabrir" revives an ended session without a tab: it runs, the card opens with it, and it is in "Sem guia" after;
//   5. the right-click menus of both kinds of row (labels, the "Reabrir nesta mesa" way, the submenu);
//   6. the card's ▾ list and "⋯" (labels, the chord at the right of "Fechar", the pick opens on the other desk).
//   Captures (SESSIONS_PEEK_SHOTS_DIR, default C:/atrium/.tmp/tether-agents/onda-3/espiar): e1b-painel.png, e1b-lista-mesas.png.
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
  peek(slotId: string): void
  peekState(): { open: boolean; slotId?: string; routed: boolean }
  desks(): { id: string; name: string }[]
  activeDesk(): string
  deskOf(slotId: string): string | undefined
  createDesk(side: 'before' | 'after', relativeTo?: string): string
  renameDesk(id: string, name: string): void
  switchDesk(id: string): void
}
declare const window: { __tether: Hooks; tether: { request(body: unknown): Promise<unknown> } }
declare const document: { querySelectorAll(selector: string): { length: number }; getElementById(id: string): { hidden: boolean } | null }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const shots = process.env.SESSIONS_PEEK_SHOTS_DIR ?? 'C:/atrium/.tmp/tether-agents/onda-3/espiar'
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-sxpeek-${process.pid}`

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

const slotsOf = (page: Page): Promise<SlotState[]> => page.evaluate(() => window.__tether.slots())
const idsOf = (page: Page): Promise<string[]> => page.evaluate(() => window.__tether.panelIds())
const row = (page: Page, slotId: string) => page.locator(`#sessions-list .sx-row[data-slot="${slotId}"]`)

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

const openMenu = async (page: Page): Promise<void> => {
  if (await page.locator('#sessions-list').isHidden()) await page.click('#btn-sessions')
  await page.waitForSelector('#sessions-list:not([hidden])')
}
const peekOpenOn = (page: Page, slotId: string): Promise<unknown> =>
  page.waitForFunction(id => { const s = window.__tether.peekState(); return s.open && s.slotId === id && s.routed }, slotId)
const closeCard = async (page: Page): Promise<void> => {
  await page.click('#peek .peek-close')
  await page.waitForSelector('#peek', { state: 'hidden' })
}
const ctxLabels = (page: Page): Promise<string[]> => page.locator('#ctx-menu > li[role^=menuitem]').evaluateAll(els => els.map(e => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent ?? '').join('').trim()))
const ctxPick = (page: Page, label: string) => page.locator('#ctx-menu li[role^=menuitem]', { hasText: label }).first()

test('painel de sessões e cartão: espiar, abrir, abrir em outra mesa, reabrir sem guia, menus de botão direito', { timeout: 480_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(shots, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-sxpeek-'))
  const cwd = home
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    daemons.push(await claim((await page.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800))

    // ---- setup: one tab kept, five shells without a tab, a second desk "obra" (the person stays on the first) ----
    console.log('setup')
    await createShell(page, cwd)
    const s: string[] = []
    for (let i = 0; i < 5; i++) s.push(await createShell(page, cwd))
    for (const id of s) await detachPane(page, id)
    const [a, b, c, d, e] = s as [string, string, string, string, string]
    const deskOne = await page.evaluate(() => window.__tether.activeDesk())
    const deskTwo = await page.evaluate(() => { const id = window.__tether.createDesk('after'); window.__tether.renameDesk(id, 'obra'); return id })
    await page.evaluate(id => window.__tether.switchDesk(id), deskOne)
    await page.waitForFunction(id => window.__tether.activeDesk() === id, deskOne)
    // `e` ends: it will be in "Encerradas".
    await page.evaluate(id => window.tether.request({ t: 'stop', slotId: id }), e)
    await page.waitForFunction(id => window.__tether.slots().find(x => x.slotId === id)?.status === 'exited', e, { timeout: 20_000 })

    // ---- 1. the row: Espiar (main), Abrir + ▾, ✕; the button and the row both peek ----
    console.log('step 1')
    await openMenu(page)
    const ra = row(page, a)
    assert.equal(await ra.locator('button.peek').textContent(), 'Espiar')
    assert.match((await ra.locator('button.peek').getAttribute('class'))!, /primary/, 'Espiar is the main button')
    assert.equal(await ra.locator('button.open').textContent(), 'Abrir')
    assert.equal(await ra.locator('button.open').getAttribute('title'), 'Abrir nesta mesa')
    assert.equal(await ra.locator('button.open-more').getAttribute('aria-label'), 'Abrir em outra mesa')
    assert.equal(await ra.locator('button.stop').textContent(), '', 'Encerrar is only an icon')
    assert.equal(await ra.locator('button.stop').getAttribute('aria-label'), 'Encerrar a sessão')
    assert.ok((await ra.locator('button.stop').getAttribute('title'))!.startsWith('Encerrar'), 'with a tip')
    await page.screenshot({ path: join(shots, 'e1b-painel.png') })
    await ra.locator('button.peek').click()
    await peekOpenOn(page, a)
    assert.equal(await page.locator('#sessions-list').isHidden(), true, 'Espiar closes the panel')
    assert.equal((await idsOf(page)).includes(a), false, 'peeking gives no tab')
    await closeCard(page)
    await openMenu(page)
    await row(page, b).locator('.tt').click()
    await sleep(500)
    assert.equal((await page.evaluate(() => window.__tether.peekState())).open, false, 'a click on the row does not peek')
    assert.equal(await page.locator('#sessions-list').isHidden(), false, 'the panel stays open')
    // the "⋯" at the end of the row lists every act, same as the right-click menu
    await row(page, b).locator('button.more').click()
    await page.waitForSelector('#ctx-menu')
    const moreLabels = await ctxLabels(page)
    for (const l of ['Espiar', 'Abrir nesta mesa', 'Abrir em outra mesa', 'Encerrar…']) assert.ok(moreLabels.includes(l), `"⋯" lists ${l}: ${moreLabels.join(' | ')}`)
    await ctxPick(page, 'Espiar').click()
    await peekOpenOn(page, b)
    assert.equal(await page.locator('#sessions-list').isHidden(), true, '"Espiar" from the "⋯" closes the panel')
    await closeCard(page)

    // ---- 2. Abrir: a tab on the current desk, no card ----
    console.log('step 2')
    await openMenu(page)
    await row(page, c).locator('button.open').click()
    await page.waitForFunction(id => window.__tether.panelIds().includes(id), c)
    assert.equal(await page.evaluate(id => window.__tether.deskOf(id), c), deskOne)
    assert.equal((await page.evaluate(() => window.__tether.peekState())).open, false)

    // ---- 3. the ▾ list: another desk, the active desk stays; "Escolher o lugar…" ----
    console.log('step 3')
    await openMenu(page)
    await row(page, d).locator('button.open-more').click()
    await page.waitForSelector('#ctx-menu')
    const labels = await ctxLabels(page)
    assert.equal(labels.at(-1), 'Escolher o lugar…', 'the list ends in "Escolher o lugar…"')
    assert.ok(labels.includes('obra') && labels.length === 3, `the desks then the place: ${labels.join(' | ')}`)
    assert.equal(await page.locator('#ctx-menu li.sep').count(), 1, 'a separator before it')
    assert.equal(await page.locator('#ctx-menu li[aria-checked="true"]').count(), 1, 'the current desk is marked')
    assert.equal(await ctxPick(page, labels[0]!).getAttribute('aria-checked'), 'true')
    await page.screenshot({ path: join(shots, 'e1b-lista-mesas.png') })
    await ctxPick(page, 'obra').click()
    await page.waitForFunction(id => window.__tether.panelIds().includes(id), d)
    assert.equal(await page.evaluate(id => window.__tether.deskOf(id), d), deskTwo, 'the tab is on the other desk')
    assert.equal(await page.evaluate(() => window.__tether.activeDesk()), deskOne, 'the active desk did not change')
    await page.waitForFunction(id => window.__tether.slots().find(x => x.slotId === id)?.status === 'running', d)

    await openMenu(page)
    await row(page, b).locator('button.open-more').click()
    await ctxPick(page, 'Escolher o lugar…').click()
    await page.waitForSelector('dialog.move[open]')
    assert.equal(await page.evaluate(id => window.__tether.deskOf(id), b), deskOne, 'the tab was born on the current desk for the move screen')
    await page.keyboard.press('Escape')
    await page.waitForSelector('dialog.move[open]', { state: 'detached' })

    // ---- 4. Reabrir: alive without a tab, the card opens with it, then it is in "Sem guia" ----
    console.log('step 4')
    await openMenu(page)
    const re = row(page, e)
    assert.equal(await re.locator('button.open').textContent(), 'Reabrir')
    assert.equal(await re.locator('button.open-more').getAttribute('aria-label'), 'Reabrir em outra mesa')
    await page.waitForSelector('#sessions-list .sx-ended')
    await re.locator('button.open').click()
    await peekOpenOn(page, e)
    assert.equal((await slotsOf(page)).find(x => x.slotId === e)!.status === 'running' || (await slotsOf(page)).find(x => x.slotId === e)!.status === 'starting', true)
    assert.equal((await idsOf(page)).includes(e), false, 'no tab was made')
    await closeCard(page)
    await openMenu(page)
    await page.waitForSelector(`#sessions-list .sx-free .sx-row[data-slot="${e}"]`)
    assert.equal(await page.locator(`#sessions-list .sx-ended .sx-row[data-slot="${e}"]`).count(), 0)

    // ---- 5. the right-click menus ----
    console.log('step 5')
    await row(page, a).click({ button: 'right' })
    await page.waitForSelector('#ctx-menu')
    assert.deepEqual(await ctxLabels(page), ['Espiar', 'Abrir nesta mesa', 'Abrir em outra mesa', 'Renomear…', 'Encerrar…'])
    assert.equal(await page.locator('#ctx-menu li.sub').count(), 1, 'one submenu')
    await page.locator('#ctx-menu li.sub').click()
    const sub = (await page.locator('#ctx-menu .submenu li[role^=menuitem]').allTextContents()).map(x => x.trim())
    assert.equal(sub.at(-1), 'Escolher o lugar…')
    assert.ok(sub.includes('obra'))
    await page.keyboard.press('Escape')
    await page.waitForSelector('#ctx-menu', { state: 'detached' })
    await row(page, a).click({ button: 'right' })
    await ctxPick(page, 'Espiar').click()
    await peekOpenOn(page, a)
    await closeCard(page)

    // a second ended session to read the other row's menu (e is alive again)
    await page.evaluate(id => window.tether.request({ t: 'stop', slotId: id }), e)
    await page.waitForFunction(id => window.__tether.slots().find(x => x.slotId === id)?.status === 'exited', e, { timeout: 20_000 })
    await openMenu(page)
    await page.waitForSelector(`#sessions-list .sx-ended .sx-row[data-slot="${e}"]`)
    await row(page, e).click({ button: 'right' })
    await page.waitForSelector('#ctx-menu')
    assert.deepEqual(await ctxLabels(page), ['Reabrir', 'Reabrir nesta mesa', 'Reabrir em outra mesa', 'Esquecer'])
    await ctxPick(page, 'Reabrir nesta mesa').click()
    await page.waitForFunction(id => window.__tether.panelIds().includes(id), e)
    assert.equal(await page.evaluate(id => window.__tether.deskOf(id), e), deskOne, 'the old way: revives and makes a tab here')
    assert.equal((await page.evaluate(() => window.__tether.peekState())).open, false)

    // ---- 6. the card: ▾ list and "⋯" ----
    console.log('step 6')
    await page.evaluate(id => window.__tether.peek(id), a)
    await peekOpenOn(page, a)
    assert.equal(await page.locator('#peek .peek-open').textContent(), 'Abrir nesta mesa')
    assert.equal(await page.locator('#peek .peek-open-more').getAttribute('aria-label'), 'Abrir em outra mesa')
    await page.click('#peek .peek-menu')
    await page.waitForSelector('#ctx-menu')
    assert.deepEqual(await ctxLabels(page), ['Abrir nesta mesa', 'Abrir em outra mesa', 'Copiar link do painel', 'Fechar'])
    assert.equal(await page.locator('#ctx-menu li', { hasText: 'Fechar' }).locator('kbd').textContent(), 'Ctrl+Shift+O')
    await page.keyboard.press('Escape')
    await page.waitForSelector('#ctx-menu', { state: 'detached' })
    assert.equal((await page.evaluate(() => window.__tether.peekState())).open, true, 'Esc closed only the menu')
    await page.click('#peek .peek-open-more')
    await page.waitForSelector('#ctx-menu')
    await ctxPick(page, 'obra').click()
    await page.waitForSelector('#peek', { state: 'hidden' })
    await page.waitForFunction(id => window.__tether.panelIds().includes(id), a)
    assert.equal(await page.evaluate(id => window.__tether.deskOf(id), a), deskTwo)
    assert.equal(await page.evaluate(() => window.__tether.activeDesk()), deskOne, 'the person stayed on their desk')
  } finally {
    console.log('teardown')
    if (app) await killElectron(app, root).catch(() => {})
    for (const dm of daemons) await killOwned(dm, { tree: true })
    for (let i = 0; i < 5; i++) {
      try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
  }
})
