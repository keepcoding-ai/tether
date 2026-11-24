// E2E of the "Sessões" menu (one icon, one menu), with shells only (hidden window, private home/pipe, real tetherd, CLAUDE* stripped):
//   1. a pane closed with "só fechar" while its shell keeps running shows under "Sem guia" (summary, tooltip, no counter);
//   2. "Abrir" brings it back to a pane with the same PID;
//   3. "Encerrar" on a session without a tab asks nothing, ends the process and KEEPS the conversation: it moves to "Encerradas";
//   4. an ended session shows "Reabrir" (resumes it in a pane) and its trash asks first (2 clicks);
//   5. "Esquecer todas as encerradas" asks once with the app dialog; sessions without a tab are untouched;
//   6. the icon and Enter do nothing (only a labelled button inside the menu has an effect);
//   7. "Encerrar os N ociosos sem guia": one confirmation listing the names, then all of them end and show under "Encerradas";
//   8. screenshots of the menu, light and dark, at 1280 and 400 px (SESSIONS_SHOTS_DIR, default C:/atrium/.tmp/sessions-proof).
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
  peekState(): { open: boolean; slotId?: string; routed: boolean }
}
declare const window: { __tether: Hooks; tether: { request(body: unknown): Promise<unknown> } }
declare const document: { querySelectorAll(selector: string): { length: number }; getElementById(id: string): { hidden: boolean; textContent: string | null } | null; documentElement: { dataset: Record<string, string> }; activeElement: { id: string } | null }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const shots = process.env.SESSIONS_SHOTS_DIR ?? 'C:/atrium/.tmp/sessions-proof'
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-sessions-${process.pid}`

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
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10_000)
  page.on('pageerror', e => console.error(`renderer error: ${e.message}`))
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  return { app, page }
}

const slotsOf = (page: Page): Promise<SlotState[]> => page.evaluate(() => window.__tether.slots())
const idsOf = (page: Page): Promise<string[]> => page.evaluate(() => window.__tether.panelIds())

/** A PowerShell in the visible desk through the chooser; returns its slot id once it runs. */
async function createShell(page: Page, cwd: string): Promise<string> {
  const before = await idsOf(page)
  await page.click('#btn-new')
  await page.waitForSelector('#dlg-new[open]')
  await page.fill('#dlg-new .ch-path-input', cwd)
  await page.click('#dlg-new .ch-item[data-id=\"powershell\"]')
  await page.click('#dlg-new .btn.primary.go') // two steps: the click selects, the button opens
  await page.waitForFunction(() => document.querySelectorAll('#dlg-new[open]').length === 0)
  await page.waitForFunction(n => window.__tether.panelIds().length === n, before.length + 1)
  const id = (await idsOf(page)).find(x => !before.includes(x))!
  await page.waitForFunction(id => window.__tether.slots().find(s => s.slotId === id)?.status === 'running', id, { timeout: 20_000 })
  return id
}

/** Closes the pane through its tab's close button and picks `choice` in the dialog ('detach' keeps the process, 'stop' ends it). */
async function closePane(page: Page, slotId: string, choice: 'detach' | 'stop'): Promise<void> {
  const tab = page.locator(`.tether-tab[data-slot="${slotId}"]`)
  await tab.hover()
  await tab.locator('.close').click()
  await page.locator(`dialog[open] button.choice[data-choice="${choice}"]`).click()
  await page.waitForFunction(id => !window.__tether.panelIds().includes(id), slotId)
}

const openMenu = async (page: Page): Promise<void> => {
  if (await page.locator('#sessions-list').isHidden()) await toggle(page)
  await page.waitForSelector('#sessions-list:not([hidden])')
}
// At 400 px the toolbar's left icons run under the desk switch (existing layout), so the narrow capture toggles by script.
const toggle = (page: Page): Promise<void> => page.evaluate(() => (document.getElementById('btn-sessions') as unknown as { click(): void }).click())
const closeMenu = async (page: Page): Promise<void> => {
  if (await page.locator('#sessions-list').isVisible()) await toggle(page)
  await page.waitForSelector('#sessions-list', { state: 'hidden' })
}
const row = (page: Page, slotId: string) => page.locator(`#sessions-list .sx-row[data-slot="${slotId}"]`)
const counter = (page: Page): Promise<string> => page.evaluate(() => { const c = document.getElementById('sessions-count')!; return c.hidden ? '' : c.textContent! })
const header = async (page: Page): Promise<string> => (await page.locator('#sessions-list .sx-hd').textContent())!.replace(/\s+/g, ' ').trim()
const title = (page: Page): Promise<string | null> => page.getAttribute('#btn-sessions', 'title')
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString()

/** Feeds the renderer the slot as the daemon would report it: idle for hours (no waiting 10 minutes), busy, or asking attention. */
async function inject(page: Page, slotId: string, patch: Partial<SlotState>): Promise<void> {
  await page.evaluate(([id, p]) => {
    const s = window.__tether.slots().find(x => x.slotId === id)!
    const next = { ...s } as Record<string, unknown>
    delete next.idleSince; delete next.turn; delete next.attention
    window.__tether.applyState({ ...next, ...(p as object) } as unknown as SlotState)
  }, [slotId, patch] as const)
}

async function setTheme(page: Page, scheme: 'dark' | 'light'): Promise<void> {
  await closeMenu(page)
  await page.click('#btn-theme')
  await page.click(`#theme-menu li[data-theme="${scheme}"]`)
  await page.waitForFunction(s => document.documentElement.dataset.theme === s, scheme)
}

test('sessões: sem guia, abrir, encerrar guarda a conversa, encerradas, esquecer, lote de ociosos, ícone sem efeito', { timeout: 480_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(shots, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-sessions-'))
  const cwd = home
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    daemons.push(await claim((await page.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800))
    const pidOf = async (id: string): Promise<number> => (await slotsOf(page)).find(s => s.slotId === id)!.pid!
    const exited = (id: string) => page.waitForFunction(id => window.__tether.slots().find(s => s.slotId === id)?.status === 'exited', id)

    // ---- 0. nothing yet; one icon, not two ----
    assert.equal(await page.locator('#btn-closed, #btn-pause').count(), 0, 'the two old icons are gone')
    assert.equal(await counter(page), '')
    assert.equal(await title(page), 'Sessões: Nenhuma sessão')

    // ---- 1. a pane closed while its shell runs: "Sem guia" ----
    console.log('step 1')
    const a = await createShell(page, cwd)
    const keep = await createShell(page, cwd) // stays in a pane the whole test
    const pidA = await pidOf(a)
    await closePane(page, a, 'detach')
    assert.ok(pidAlive(pidA), 'the shell runs on after the pane closes')
    assert.equal(await title(page), 'Sessões: 1 sem guia')
    assert.equal(await counter(page), '1', 'an idle session without a tab shows the neutral total')
    await openMenu(page)
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'sessions-list', 'the focus lands on the container')
    assert.equal(await header(page), '1 sem guia')
    assert.equal(await page.locator('#sessions-list .sx-free .sx-gt span').first().textContent(), 'Sem guia')
    assert.equal(await page.locator('#sessions-list .sx-ended').count(), 0, 'no ended section yet')
    assert.equal(await page.locator('#sessions-list .sx-free .sx-row').count(), 1)
    assert.match((await row(page, a).locator('.cw').textContent())!, /^ocioso/)
    assert.equal(await row(page, a).locator('button.open').textContent(), 'Abrir')
    assert.equal(await row(page, a).locator('button.stop').getAttribute('aria-label'), 'Encerrar a sessão', 'Encerrar is an icon with a tip')
    assert.equal(await page.locator('#pause-start').isDisabled(), true, 'nobody is working: the pause button is off')
    assert.equal(await page.locator('#pause-start').textContent(), 'Ninguém em andamento agora')

    // ---- 2. Abrir: back in a pane, same PID ----
    console.log('step 2')
    await row(page, a).locator('button.open').click()
    await page.waitForFunction(id => window.__tether.panelIds().includes(id), a)
    assert.equal(await pidOf(a), pidA, 'same process')
    assert.equal(await page.locator('#sessions-list').isHidden(), true, 'the menu closes after opening')
    assert.equal(await title(page), 'Sessões: Nenhuma sessão')

    // ---- 3. Encerrar: no confirmation, the conversation is kept under "Encerradas" ----
    console.log('step 3')
    await closePane(page, a, 'detach')
    await openMenu(page)
    await row(page, a).locator('button.stop').click()
    assert.equal(await page.locator('dialog[open]').count(), 0, 'stopping one session asks nothing')
    await exited(a)
    for (let i = 0; i < 30 && pidAlive(pidA); i++) await sleep(300)
    assert.equal(pidAlive(pidA), false, 'Encerrar ended the process')
    assert.ok((await slotsOf(page)).some(s => s.slotId === a), 'the session is kept, not forgotten')
    await page.waitForSelector(`#sessions-list .sx-ended .sx-row[data-slot="${a}"]`)
    assert.equal(await page.locator('#sessions-list .sx-free').count(), 0)
    assert.equal(await header(page), '1 encerrada')

    // ---- 4. ended: Reabrir resumes, the trash forgets after a confirmation ----
    console.log('step 4')
    await row(page, a).hover()
    assert.equal(await row(page, a).locator('button.open').textContent(), 'Reabrir')
    await row(page, a).locator('button.forget').click() // forgetting cannot be undone: the row asks first
    assert.match((await row(page, a).locator('.sx-ask').textContent())!, /Esquecer esta sessão?/)
    await row(page, a).locator('button.forget-no').click()
    assert.equal(await row(page, a).locator('button.forget').count(), 1, 'Não: the row is as before')
    await row(page, a).locator('button.forget').click()
    await page.keyboard.press('Escape')
    assert.equal(await row(page, a).locator('button.forget').count(), 1, 'Esc cancels only the question')
    await row(page, a).locator('button.forget').click()
    await row(page, a).locator('button.forget-yes').click()
    await page.waitForFunction(id => !window.__tether.slots().some(s => s.slotId === id), a)
    assert.equal(await header(page), 'Nenhuma sessão')
    await closeMenu(page)
    const b = await createShell(page, cwd)
    await closePane(page, b, 'stop')
    await exited(b)
    await openMenu(page)
    assert.equal(await row(page, b).evaluate(el => el.classList.contains('ended')), true)
    await row(page, b).hover()
    await row(page, b).locator('button.open').click()
    // "Reabrir" revives the session WITHOUT a tab: it runs, the peek card opens with it, no pane is born.
    await page.waitForFunction(id => window.__tether.slots().find(s => s.slotId === id)?.status === 'running' && window.__tether.peekState().slotId === id, b, { timeout: 20_000 })
    assert.equal((await page.evaluate(() => window.__tether.panelIds())).includes(b), false, 'reopening gives the session no tab')
    await page.click('#peek .peek-close')
    await page.evaluate(id => window.tether.request({ t: 'stop', slotId: id }), b)
    await exited(b)
    await openMenu(page)
    await row(page, b).locator('button.forget').click()
    await row(page, b).locator('button.forget-yes').click()
    await page.waitForFunction(id => !window.__tether.slots().some(s => s.slotId === id), b)
    await closeMenu(page)

    // ---- 5. forget all ----
    console.log('step 5')
    const ended: string[] = []
    for (let i = 0; i < 3; i++) {
      const id = await createShell(page, cwd)
      await closePane(page, id, 'stop')
      await exited(id)
      ended.push(id)
    }
    const running: string[] = []
    for (let i = 0; i < 3; i++) {
      const id = await createShell(page, cwd)
      running.push(id)
      await closePane(page, id, 'detach')
    }
    const pids = await Promise.all(running.map(pidOf))
    assert.equal(await title(page), 'Sessões: 3 sem guia · 3 encerradas')
    await openMenu(page)
    assert.equal(await header(page), '3 sem guia · 3 encerradas')
    const dlg = page.locator('dialog[open][data-dialog="forget-ended"]')
    await page.locator('#sessions-forget-all').click()
    await dlg.waitFor()
    assert.match((await dlg.locator('h2').textContent())!, /3 sessões encerradas/)
    await page.keyboard.press('Escape')
    await dlg.waitFor({ state: 'detached' })
    assert.equal((await slotsOf(page)).length, 3 + 3 + 1)
    await openMenu(page)
    await page.locator('#sessions-forget-all').click()
    await dlg.waitFor()
    await dlg.locator('button.choice[data-choice="forget"]').click()
    await page.waitForFunction(ids => ids.every(id => !window.__tether.slots().some(s => s.slotId === id)), ended)
    for (const pid of pids) assert.ok(pidAlive(pid), 'sessions without a tab are untouched by "forget all"')
    assert.ok((await slotsOf(page)).some(s => s.slotId === keep && s.status === 'running'))
    await closeMenu(page)

    // ---- 6. the icon and Enter do nothing ----
    console.log('step 6')
    for (const id of running) await inject(page, id, { idleSince: ago(3 * 3_600_000) })
    const before = JSON.stringify((await slotsOf(page)).map(s => [s.slotId, s.status]))
    await page.click('#btn-sessions')
    await page.waitForSelector('#sessions-list:not([hidden])')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Space')
    await sleep(500)
    assert.equal(await page.locator('#sessions-list').isHidden(), false, 'Enter on the container does not close or act')
    assert.equal(await page.locator('dialog[open]').count(), 0)
    await page.click('#btn-sessions')
    await page.waitForSelector('#sessions-list', { state: 'hidden' })
    await page.click('#btn-sessions')
    await page.waitForSelector('#sessions-list:not([hidden])')
    await sleep(500)
    assert.equal(JSON.stringify((await slotsOf(page)).map(s => [s.slotId, s.status])), before, 'opening and closing changed nothing')
    for (const pid of pids) assert.ok(pidAlive(pid))
    assert.equal(await page.locator('dialog[open]').count(), 0)

    // ---- 8. screenshots: attention (orange), working (green), idle; light/dark at 1280 and 400 ----
    console.log('step 8')
    await inject(page, running[0]!, { attention: 'waiting', idleSince: ago(3_600_000) })
    await inject(page, running[1]!, { turn: 'busy' })
    await inject(page, running[2]!, { idleSince: ago(3 * 3_600_000) })
    for (let i = 0; i < 2; i++) {
      const id = await createShell(page, cwd)
      await closePane(page, id, 'stop')
      await exited(id)
    }
    await closeMenu(page)
    assert.equal(await counter(page), '3', 'the orange 3: the total of live sessions without a tab, toned by the one asking attention')
    assert.equal(await page.locator('#sessions-count .c-attention').count(), 1)
    for (const width of [1280, 400]) {
      await app.evaluate(({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0]?.setContentSize(w, 800), width)
      await sleep(300)
      for (const scheme of ['light', 'dark'] as const) {
        await setTheme(page, scheme)
        await openMenu(page)
        await sleep(200)
        await page.screenshot({ path: join(shots, `sessions-menu-${width}-${scheme}.png`) })
      }
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800))
    await closeMenu(page)

    // ---- 7. Encerrar os N ociosos sem guia: one confirmation with the names ----
    console.log('step 7')
    for (const id of running) await inject(page, id, { idleSince: ago(2 * 3_600_000) }) // back to plain idle
    await openMenu(page)
    const bulk = page.locator('#sessions-bulk-close')
    assert.equal(await bulk.textContent(), 'Encerrar os 3 ociosos sem guia')
    assert.equal(await bulk.isDisabled(), false)
    const bdlg = page.locator('dialog[open][data-dialog="bulk-close"]')
    const names = await page.locator('#sessions-list .sx-free .tt').allTextContents()
    assert.equal(names.length, 3)
    await bulk.click()
    await bdlg.waitFor()
    const text = (await bdlg.textContent())!
    assert.match((await bdlg.locator('h2').textContent())!, /3 sessões ociosas sem guia/)
    assert.ok(text.includes(cwd.split(/[\\/]/).pop()!), 'the names are listed')
    await page.keyboard.press('Escape')
    await bdlg.waitFor({ state: 'detached' })
    await sleep(500)
    for (const pid of pids) assert.ok(pidAlive(pid), 'cancelling the confirmation stops nothing')
    await openMenu(page)
    await bulk.click()
    await bdlg.waitFor()
    await bdlg.locator('button.choice[data-choice="close"]').click()
    await page.waitForFunction(ids => ids.every(id => window.__tether.slots().find(s => s.slotId === id)?.status === 'exited'), running, { timeout: 30_000 })
    for (const pid of pids) for (let i = 0; i < 30 && pidAlive(pid); i++) await sleep(300)
    for (const pid of pids) assert.equal(pidAlive(pid), false, 'every idle session was ended')
    await openMenu(page)
    for (const id of running) await page.waitForSelector(`#sessions-list .sx-ended .sx-row[data-slot="${id}"]`)
    assert.equal(await page.locator('#sessions-list .sx-free').count(), 0)
    assert.ok((await slotsOf(page)).some(s => s.slotId === keep && s.status === 'running'), 'the session with a tab is untouched')
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
