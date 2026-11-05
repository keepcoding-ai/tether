// E2E of the in-app dialogs (no OS message box anywhere), against the real tetherd on a private home/pipe,
// hidden windows, shell slots only:
//   1. closing a panel with a live process shows the in-app dialog with the right cards (safe default "só
//      fechar", destructive "encerrar"); Esc cancels; Enter only closes the panel (the slot keeps running);
//      "Encerrar" stops the slot; a Claude-like state (fed through the test hook) gets the Claude copy;
//   2. "Não perguntar de novo" lands in settings.json, the next close asks nothing, and the menu item
//      "Voltar a perguntar…" restores the question;
//   3. "Sair e encerrar tudo…" from the menu shows the in-app dialog; Esc keeps the app; "Encerrar tudo e
//      sair" stops the slots, shuts the daemon down and quits;
//   4. a launch that finds the single-instance lock stuck shows the "ainda está fechando" dialog in its own
//      window; "Tentar de novo" brings the main window up once the lock frees; "Fechar" quits.
// Screenshots (light and dark) of every dialog land in test/e2e/artifacts.
// Every kill goes through test/kill.ts (identity).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  text(id: string): string
  connection(): { connected: boolean; pid?: number } | undefined
  activate(id: string): void
  openSlot(id: string): void
  applyState(slot: SlotState): void
  confirmations(): Record<string, string>
  closePanel(id: string): void
}
declare const window: { __tether: Hooks; tether: { request(body: unknown): Promise<unknown> } }
declare const document: { querySelectorAll(selector: string): { length: number }; querySelector(selector: string): unknown }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const artifacts = join(root, 'test', 'e2e', 'artifacts')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-dialogs-${process.pid}`
const LOCK_RETRY_MS = 12_000

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

function appEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_')) env[k] = v
  env.TETHER_PIPE = pipe
  env.TETHER_HOME = home
  env.TETHER_E2E_HIDDEN = '1'
  return env
}

async function launch(home: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env: appEnv(home) })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10_000)
  // Renderer errors are the first thing to read when a dialog does not show up.
  page.on('pageerror', e => console.error(`renderer error: ${e.message}`))
  page.on('console', m => { if (m.type() === 'error') console.error(`renderer console: ${m.text()}`) })
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  return { app, page }
}

async function createShellPanel(page: Page, cwd: string): Promise<string> {
  const before = await page.evaluate(() => window.__tether.panelIds())
  await page.click('#btn-new')
  await page.waitForSelector('#dlg-new[open]')
  await page.fill('#dlg-new .ch-path-input', cwd)
  await page.click('#dlg-new .ch-item[data-id=\"powershell\"]')
  await page.waitForFunction(() => document.querySelectorAll('#dlg-new[open]').length === 0)
  await page.waitForFunction(n => document.querySelectorAll('.tether-tab').length === n, before.length + 1)
  const ids = await page.evaluate(() => window.__tether.panelIds())
  const id = ids.find(i => !before.includes(i))!
  await page.waitForFunction(id => /PS.*>/.test(window.__tether.text(id).replace(/\s+/g, '')), id, { timeout: 20_000 })
  return id
}

const hooks = {
  ids: (page: Page) => page.evaluate(() => window.__tether.panelIds()),
  slots: (page: Page) => page.evaluate(() => window.__tether.slots()),
  slot: async (page: Page, id: string) => (await hooks.slots(page)).find(s => s.slotId === id),
  daemonPid: async (page: Page) => (await page.evaluate(() => window.__tether.connection()))?.pid,
  confirmations: (page: Page) => page.evaluate(() => window.__tether.confirmations()),
  closePanel: (page: Page, id: string) => page.evaluate(id => window.__tether.closePanel(id), id),
  openSlot: (page: Page, id: string) => page.evaluate(id => window.__tether.openSlot(id), id),
  applyState: (page: Page, s: SlotState) => page.evaluate(s => window.__tether.applyState(s), s),
  clickMenu: (app: ElectronApplication, id: string) => app.evaluate(({ Menu }, id) => { Menu.getApplicationMenu()?.getMenuItemById(id)?.click() }, id),
  /** Electron's own count of native message boxes is not observable; the proof is the grep gate + this DOM dialog. */
  dialog: (page: Page, situation: string) => page.locator(`dialog.ask[data-dialog="${situation}"][open]`),
}

function settings(home: string): { theme?: string; confirmations?: Record<string, string> } {
  try { return JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')) } catch { return {} }
}

async function waitPanelGone(page: Page, id: string): Promise<void> {
  await page.waitForFunction(id => !window.__tether.panelIds().includes(id), id)
}

async function waitSlotStatus(page: Page, id: string, status: string): Promise<void> {
  await page.waitForFunction(([id, st]) => window.__tether.slots().find(s => s.slotId === id)?.status === st, [id, status] as const, { timeout: 15_000 })
}

/** Opens the close dialog for a panel and checks its fixed structure: title, context, cards by tone, default. */
async function openCloseDialog(page: Page, id: string, situation: string): Promise<ReturnType<typeof hooks.dialog>> {
  await hooks.closePanel(page, id)
  const dlg = hooks.dialog(page, situation)
  try {
    await dlg.waitFor()
  } catch (e) {
    const slots = (await hooks.slots(page)).map(s => `${s.slotId}:${s.kind}:${s.status}`).join(' ')
    const open = await page.evaluate(() => [...(document as unknown as { querySelectorAll(s: string): Iterable<{ outerHTML: string }> }).querySelectorAll('dialog')].map(d => d.outerHTML.slice(0, 160)))
    throw new Error(`no "${situation}" dialog for ${id}; slots: ${slots}; panels: ${(await hooks.ids(page)).join(',')}; dialogs: ${JSON.stringify(open)}; confirmations: ${JSON.stringify(await hooks.confirmations(page))}`, { cause: e })
  }
  assert.equal(await dlg.getAttribute('aria-labelledby'), await dlg.locator('h2').getAttribute('id'), 'aria-labelledby points at the title')
  assert.ok(await dlg.locator('.context .ctx-name').textContent(), 'context names the panel')
  assert.equal(await dlg.locator('button.choice').count(), 2, 'two cards')
  assert.ok(await dlg.locator('button.choice.safe.default[data-choice="detach"]').count() === 1, 'the safe card is the default')
  assert.ok(await dlg.locator('button.choice.destructive').count() === 1, 'one destructive card')
  const order = await dlg.locator('button.choice').evaluateAll(els => els.map(e => (e as { dataset: { choice?: string } }).dataset.choice))
  assert.equal(order[0], 'detach', 'the safe card comes first')
  assert.equal(await dlg.locator('button.choice.default').evaluate(el => el === (el as { ownerDocument: { activeElement: unknown } }).ownerDocument.activeElement), true, 'focus starts on the default card')
  for (const c of await dlg.locator('.choice-consequence').allTextContents()) assert.ok(c.length > 20, `every card has a consequence: ${c}`)
  return dlg
}

async function shoot(page: Page, name: string): Promise<void> {
  await sleep(250)
  await page.screenshot({ path: join(artifacts, `${name}.png`) })
}

function holdLock(home: string): () => void {
  const dir = join(home, 'electron')
  mkdirSync(dir, { recursive: true })
  const fd = openSync(join(dir, 'lockfile'), 'w')
  return () => closeSync(fd)
}

test('in-app dialogs: close panel, remember, quit all, still closing (no native message box)', async t => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(artifacts, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-dialogs-'))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    const daemonPid = (await hooks.daemonPid(page))!
    assert.ok(daemonPid && pidAlive(daemonPid), 'the app spawned a tetherd')
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))

    const a = await createShellPanel(page, root)
    const b = await createShellPanel(page, root)
    await page.keyboard.press('Control+Backslash') // a third panel, side by side: the screenshots show toolbar + tabs + split
    await page.waitForFunction(() => document.querySelectorAll('.tether-tab').length === 3)
    const c = (await hooks.ids(page)).find(i => i !== a && i !== b)!
    await page.waitForFunction(id => /PS.*>/.test(window.__tether.text(id).replace(/\s+/g, '')), c, { timeout: 20_000 })

    for (const scheme of ['dark', 'light'] as const) {
      await hooks.clickMenu(app, `theme-${scheme}`)
      await page.waitForFunction(s => (document.querySelector('html') as { dataset: { theme?: string } }).dataset.theme === s, scheme)
      // The previous pass leaves b exited (step 1d): the live steps need it running again.
      if ((await hooks.slot(page, b))?.status !== 'running') {
        await page.evaluate(id => window.tether.request({ t: 'start', slotId: id }), b)
        await waitSlotStatus(page, b, 'running')
      }

      // ---- 1a. a Claude-like running slot (state fed through the hook): Claude copy, session id, "rodando agora" ----
      const real = (await hooks.slot(page, a))!
      await hooks.applyState(page, {
        ...real, kind: 'claude', title: 'Refatorar os diálogos do app',
        binding: { slotId: a, agent: 'claude', sessionId: '7f3c9a2e-5b1d-4e8a-9c6f-2d4b8e1a7c35', cwd: real.cwd, since: new Date().toISOString(), confirmed: true, ended: false, title: 'Refatorar os diálogos do app' },
      })
      let dlg = await openCloseDialog(page, a, 'close-panel-live')
      assert.match((await dlg.locator('h2').textContent())!, /o Claude rodando/)
      assert.match((await dlg.locator('.ctx-status').textContent())!, /rodando agora/)
      assert.match((await dlg.locator('.ctx-line').allTextContents()).join('\n'), /sessão 7f3c9a2e/)
      assert.match((await dlg.locator('button.choice.destructive .choice-label').textContent())!, /Encerrar o Claude/)
      assert.match((await dlg.locator('button.choice.safe .choice-consequence').textContent())!, /continua rodando em segundo plano/)
      await shoot(page, `dialog-close-claude-${scheme}`)
      await page.keyboard.press('Escape')
      await dlg.waitFor({ state: 'detached' })
      assert.ok((await hooks.ids(page)).includes(a), 'Esc: the panel stays')
      await hooks.applyState(page, real)

      // ---- 1b. the real shell: shell copy ("não tem sessão"); arrows move between cards; Enter = só fechar ----
      dlg = await openCloseDialog(page, b, 'close-panel-live')
      assert.match((await dlg.locator('h2').textContent())!, /shell aberto/)
      assert.match((await dlg.locator('button.choice.destructive .choice-consequence').textContent())!, /não tem sessão/)
      await shoot(page, `dialog-close-shell-${scheme}`)
      await page.keyboard.press('ArrowDown')
      assert.equal(await dlg.locator('button.choice.destructive').evaluate(el => el === (el as { ownerDocument: { activeElement: unknown } }).ownerDocument.activeElement), true, 'ArrowDown moves to the next card')
      await page.keyboard.press('ArrowDown')
      assert.equal(await dlg.locator('button.choice.default').evaluate(el => el === (el as { ownerDocument: { activeElement: unknown } }).ownerDocument.activeElement), true, 'arrows wrap')
      await page.keyboard.press('Enter')
      await dlg.waitFor({ state: 'detached' })
      await waitPanelGone(page, b)
      assert.equal((await hooks.slot(page, b))?.status, 'running', 'só fechar: the slot keeps running')

      // ---- 1c. "Encerrar o shell" stops the slot ----
      await hooks.openSlot(page, b)
      await page.waitForFunction(id => window.__tether.panelIds().includes(id), b)
      dlg = await openCloseDialog(page, b, 'close-panel-live')
      await dlg.locator('button.choice[data-choice="stop"]').click()
      await dlg.waitFor({ state: 'detached' })
      await waitPanelGone(page, b)
      await waitSlotStatus(page, b, 'exited')

      // ---- 1d. nothing running: the idle dialog (keep the slot / forget it) ----
      await hooks.openSlot(page, b) // openSlot starts an exited slot: wait for it, stop it through the daemon, then close the idle panel
      await page.waitForFunction(id => window.__tether.panelIds().includes(id), b)
      await waitSlotStatus(page, b, 'running')
      await page.evaluate(id => window.tether.request({ t: 'stop', slotId: id }), b)
      await waitSlotStatus(page, b, 'exited')
      dlg = await openCloseDialog(page, b, 'close-panel-idle')
      assert.match((await dlg.locator('h2').textContent())!, /Nenhum shell aberto/)
      assert.equal(await dlg.locator('button.choice.destructive[data-choice="forget"]').count(), 1)
      await shoot(page, `dialog-close-idle-${scheme}`)
      await page.keyboard.press('Escape')
      await dlg.waitFor({ state: 'detached' })

      // ---- 3a. quit all from the menu: in-app dialog; Esc keeps everything ----
      await hooks.clickMenu(app, 'quit-all')
      const quit = hooks.dialog(page, 'quit-all')
      await quit.waitFor()
      assert.equal(await quit.locator('button.choice.safe.default[data-choice="close-window"]').count(), 1, 'the safe default is closing the window')
      assert.equal(await quit.locator('button.choice.destructive[data-choice="quit"]').count(), 1)
      assert.match((await quit.locator('.ctx-name').textContent())!, /2 agentes rodando agora/)
      await shoot(page, `dialog-quit-all-${scheme}`)
      await page.keyboard.press('Escape')
      await quit.waitFor({ state: 'detached' })
      assert.equal((await hooks.ids(page)).length, 3, 'Esc: nothing happened')
      t.diagnostic(`${scheme}: close-panel (claude/shell/idle) and quit-all dialogs shot`)
    }

    // ---- 2. "Não perguntar de novo": settings.json, no dialog next time, restored from the menu ----
    let dlg = await openCloseDialog(page, a, 'close-panel-live')
    await dlg.locator('input[name=remember]').check()
    await page.keyboard.press('Enter')
    await dlg.waitFor({ state: 'detached' })
    await waitPanelGone(page, a)
    await page.waitForFunction(() => window.__tether.confirmations()['close-panel-live'] === 'detach')
    assert.deepEqual(settings(home).confirmations, { 'close-panel-live': 'detach' }, 'settings.json remembers the answer')
    await hooks.openSlot(page, a)
    await page.waitForFunction(id => window.__tether.panelIds().includes(id), a)
    await hooks.closePanel(page, a)
    await waitPanelGone(page, a)
    assert.equal(await page.locator('dialog.ask[open]').count(), 0, 'remembered: no dialog')
    assert.equal((await hooks.slot(page, a))?.status, 'running', 'remembered answer is "só fechar": the slot keeps running')
    await hooks.clickMenu(app, 'restore-confirmations')
    await page.waitForFunction(() => Object.keys(window.__tether.confirmations()).length === 0)
    assert.deepEqual(settings(home).confirmations, {}, 'menu: confirmations restored')
    await hooks.openSlot(page, a)
    await page.waitForFunction(id => window.__tether.panelIds().includes(id), a)
    dlg = await openCloseDialog(page, a, 'close-panel-live')
    await page.keyboard.press('Escape')
    await dlg.waitFor({ state: 'detached' })
    t.diagnostic('"não perguntar de novo" persisted and restored')

    // ---- 3b. "Encerrar tudo e sair": slots stopped, daemon down, app gone ----
    await hooks.clickMenu(app, 'quit-all')
    const quit = hooks.dialog(page, 'quit-all')
    await quit.waitFor()
    const idsBeforeQuit = [...(await hooks.ids(page))].sort()
    const closed = app.waitForEvent('close', { timeout: 30_000 })
    await quit.locator('button.choice[data-choice="quit"]').click()
    await closed
    app = undefined
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline && pidAlive(daemonPid)) await sleep(200)
    assert.equal(pidAlive(daemonPid), false, 'quit all: the tetherd is gone')
    t.diagnostic('quit all: app and tetherd gone')

    // ---- 4. still closing: the dialog in its own window; retry brings the app up; close quits ----
    await sleep(3000) // let the old helpers release the lock, so the held file is the only obstacle
    for (const [scheme, choice] of [['dark', 'retry'], ['light', 'close']] as const) {
      writeFileSync(join(home, 'settings.json'), JSON.stringify({ theme: scheme }))
      const release = holdLock(home)
      const t0 = Date.now()
      const second = await _electron.launch({ executablePath: electronPath, args: [mainPath], env: appEnv(home) })
      app = second
      let stderr = ''
      second.process().stderr?.on('data', d => { stderr += d })
      const win = await second.firstWindow({ timeout: LOCK_RETRY_MS + 20_000 })
      const still = win.locator('dialog.ask[data-dialog="still-closing"][open]')
      await still.waitFor({ timeout: 10_000 })
      assert.ok(Date.now() - t0 >= LOCK_RETRY_MS, 'the dialog comes only after the retry window')
      assert.equal(await win.evaluate(() => (document.querySelector('html') as { dataset: { theme?: string } }).dataset.theme), scheme, 'the standalone window follows the theme')
      assert.equal(await still.locator('button.choice.safe.default[data-choice="retry"]').count(), 1)
      assert.equal(await still.locator('button.choice.esc[data-choice="close"] .choice-key').textContent(), 'Esc', '"Fechar" is the Esc choice and says so')
      await sleep(300)
      await win.screenshot({ path: join(artifacts, `dialog-still-closing-${scheme}.png`) })
      release()
      if (choice === 'retry') {
        const mainWin = second.waitForEvent('window', { timeout: 30_000 })
        await still.locator('button.choice[data-choice="retry"]').click()
        const page2 = await mainWin
        await page2.waitForSelector('#conn.on', { timeout: 30_000 })
        const pid2 = (await hooks.daemonPid(page2))!
        daemons.push(await claim(pid2, { cmdIncludes: daemonMain, what: 'tetherd' }))
        await page2.waitForFunction(n => document.querySelectorAll('.tether-tab').length === n, idsBeforeQuit.length, { timeout: 15_000 })
        assert.deepEqual([...(await hooks.ids(page2))].sort(), idsBeforeQuit, 'the layout saved before "encerrar tudo" is back')
        t.diagnostic(`still closing (${scheme}): retry brought the window up with the layout`)
        await killElectron(second, root)
        app = undefined
        await sleep(3000)
      } else {
        const closed = second.waitForEvent('close', { timeout: 15_000 })
        await still.locator('button.choice[data-choice="close"]').click()
        await closed
        app = undefined
        assert.match(stderr, /o tether ainda está fechando/)
        t.diagnostic(`still closing (${scheme}): close quit the app`)
      }
    }
  } finally {
    if (app) await killElectron(app, root).catch(e => console.error(String(e)))
    for (const d of daemons) {
      const r = await killOwned(d, { tree: true })
      if (r === 'not-ours') console.error(`tetherd cleanup: pid ${d.pid} is no longer ours; not killed`)
    }
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && daemons.some(d => pidAlive(d.pid))) await sleep(200)
    for (let i = 0; i < 5; i++) {
      try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
  }
})
