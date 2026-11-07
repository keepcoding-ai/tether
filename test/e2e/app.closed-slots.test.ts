// E2E of the "Slots fechados" menu, with shells only (hidden window, private home/pipe, real tetherd, CLAUDE* stripped):
//   1. a pane closed with "só fechar" while its shell keeps running shows under "Rodando sem painel" (badge, tooltip, header);
//   2. "Abrir" brings it back to a pane with the same PID;
//   3. the trash on a running slot asks inline ("Encerra o processo. Esquecer?"): Cancelar keeps it, Esquecer kills it (by PID);
//   4. an ended slot shows "Reabrir" (resumes it in a pane) and its trash forgets without asking;
//   5. "Esquecer todos os encerrados" asks once with the app dialog; running slots are untouched;
//   6. screenshots of the menu, light and dark (test/e2e/artifacts/closed-slots-*.png).
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

type Hooks = { panelIds(): string[]; slots(): SlotState[]; connection(): { connected: boolean; pid?: number } | undefined }
declare const window: { __tether: Hooks }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const artifacts = join(root, 'test', 'e2e', 'artifacts')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-closed-${process.pid}`

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

async function launch(home: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_') && !/^(CLAUDE|TETHER_|ATRIUM_)/i.test(k)) env[k] = v
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
  if (await page.locator('#closed-list').isHidden()) await page.click('#btn-closed')
  await page.waitForSelector('#closed-list:not([hidden])')
}
const row = (page: Page, slotId: string) => page.locator(`#closed-list .cl-row[data-slot="${slotId}"]`)
const badge = (page: Page): Promise<[string, string]> => page.evaluate(() => [document.getElementById('closed-count-run')!.textContent!, document.getElementById('closed-count-end')!.textContent!] as [string, string])

async function setTheme(page: Page, scheme: 'dark' | 'light'): Promise<void> {
  await page.evaluate(() => { document.getElementById('closed-list')!.hidden = true })
  await page.click('#btn-theme')
  await page.click(`#theme-menu li[data-theme="${scheme}"]`)
  await page.waitForFunction(s => document.documentElement.dataset.theme === s, scheme)
}

test('closed slots: running without a pane, open, forget with confirmation, ended, forget all', { timeout: 420_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(artifacts, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-closed-'))
  const cwd = home
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    daemons.push(await claim((await page.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    const pidOf = async (id: string): Promise<number> => (await slotsOf(page)).find(s => s.slotId === id)!.pid!

    // ---- 0. nothing closed yet ----
    assert.deepEqual(await badge(page), ['', ''])
    assert.equal(await page.getAttribute('#btn-closed', 'title'), 'Slots fechados: nenhum')

    // ---- 1. a pane closed while its shell runs: "Rodando sem painel" ----
    console.log('step 1')
    const a = await createShell(page, cwd)
    const keep = await createShell(page, cwd) // stays in a pane the whole test
    const pidA = await pidOf(a)
    await closePane(page, a, 'detach')
    assert.ok(pidAlive(pidA), 'the shell runs on after the pane closes')
    assert.deepEqual(await badge(page), ['1', ''])
    assert.equal(await page.getAttribute('#btn-closed', 'title'), 'Slots fechados: 1 rodando sem painel')
    await openMenu(page)
    assert.equal(await page.locator('#closed-list .cl-run .cl-gt span').first().textContent(), 'Rodando sem painel')
    assert.equal(await page.locator('#closed-list .cl-ended').count(), 0, 'no ended group yet')
    assert.equal((await page.locator('#closed-list .cl-hd').textContent())!.trim(), '1 rodando')
    assert.equal(await page.locator('#closed-list .cl-run .cl-row').count(), 1)
    assert.equal(await row(page, a).locator('button.open').textContent(), 'Abrir')

    // ---- 2. Abrir: back in a pane, same PID ----
    console.log('step 2')
    await row(page, a).locator('button.open').click()
    await page.waitForFunction(id => window.__tether.panelIds().includes(id), a)
    assert.equal(await pidOf(a), pidA, 'same process')
    assert.equal(await page.locator('#closed-list').isHidden(), true, 'the menu closes after opening')
    assert.deepEqual(await badge(page), ['', ''])

    // ---- 3. the trash on a running slot: inline confirmation, then kills ----
    console.log('step 3')
    await closePane(page, a, 'detach')
    await openMenu(page)
    await row(page, a).locator('button.forget').click()
    assert.equal(await row(page, a).evaluate(el => el.classList.contains('asking')), true)
    assert.equal(await row(page, a).locator('.cf .m').textContent(), 'Encerra o processo. Esquecer?')
    assert.equal(await row(page, a).locator('.cf button').first().textContent(), 'Cancelar')
    await row(page, a).locator('.cf button.cancel').click()
    assert.equal(await row(page, a).evaluate(el => el.classList.contains('asking')), false)
    assert.ok(pidAlive(pidA), 'Cancelar kills nothing')
    await row(page, a).locator('button.forget').click()
    await row(page, a).locator('.cf button.confirm').click()
    await page.waitForFunction(id => !window.__tether.slots().some(s => s.slotId === id), a)
    for (let i = 0; i < 30 && pidAlive(pidA); i++) await sleep(300)
    assert.equal(pidAlive(pidA), false, 'Esquecer killed the process (by PID)')
    assert.equal(await row(page, a).count(), 0)
    assert.equal((await page.locator('#closed-list .cl-hd').textContent())!.trim(), 'Nenhum slot fechado')

    // ---- 4. ended slots: Reabrir resumes, the trash forgets without asking ----
    console.log('step 4')
    await page.click('#btn-closed') // close the menu
    const b = await createShell(page, cwd)
    const pidB = await pidOf(b)
    await closePane(page, b, 'stop')
    await page.waitForFunction(id => window.__tether.slots().find(s => s.slotId === id)?.status === 'exited', b)
    for (let i = 0; i < 30 && pidAlive(pidB); i++) await sleep(300)
    assert.deepEqual(await badge(page), ['', '1'])
    await openMenu(page)
    assert.equal(await page.locator('#closed-list .cl-run').count(), 0)
    assert.equal(await row(page, b).evaluate(el => el.classList.contains('ended')), true)
    await row(page, b).hover()
    assert.equal(await row(page, b).locator('button.open').textContent(), 'Reabrir')
    assert.equal(await row(page, b).locator('button.open').isVisible(), true)
    await row(page, b).locator('button.open').click()
    await page.waitForFunction(id => window.__tether.panelIds().includes(id) && window.__tether.slots().find(s => s.slotId === id)?.status === 'running', b, { timeout: 20_000 })
    await closePane(page, b, 'stop')
    await page.waitForFunction(id => window.__tether.slots().find(s => s.slotId === id)?.status === 'exited', b)
    await openMenu(page)
    await row(page, b).locator('button.forget').click() // no confirmation for an ended slot
    await page.waitForFunction(id => !window.__tether.slots().some(s => s.slotId === id), b)
    assert.deepEqual(await badge(page), ['', ''])

    // ---- 5. screenshots + forget all ----
    console.log('step 5')
    await page.click('#btn-closed')
    const ended: string[] = []
    for (let i = 0; i < 3; i++) {
      const id = await createShell(page, cwd)
      await closePane(page, id, 'stop')
      await page.waitForFunction(id => window.__tether.slots().find(s => s.slotId === id)?.status === 'exited', id)
      ended.push(id)
    }
    const running: string[] = []
    for (let i = 0; i < 2; i++) {
      const id = await createShell(page, cwd)
      running.push(id)
      await closePane(page, id, 'detach')
    }
    const pids = await Promise.all(running.map(pidOf))
    assert.deepEqual(await badge(page), ['2', '3'])
    assert.equal(await page.getAttribute('#btn-closed', 'title'), 'Slots fechados: 2 rodando sem painel · 3 encerrados')
    await openMenu(page)
    assert.equal((await page.locator('#closed-list .cl-hd').textContent())!.replace(/\s+/g, ' ').trim(), '2 rodando · 3 encerrados')
    const clip = { x: 0, y: 0, width: 580, height: 400 }
    for (const scheme of ['dark', 'light'] as const) {
      await setTheme(page, scheme)
      await openMenu(page)
      await row(page, ended[0]!).hover()
      await page.screenshot({ path: join(artifacts, `closed-slots-${scheme}.png`), clip })
      await row(page, running[0]!).locator('button.forget').click()
      await page.screenshot({ path: join(artifacts, `closed-slots-ask-${scheme}.png`), clip })
      await row(page, running[0]!).locator('.cf button.cancel').click()
    }
    // Esquecer todos os encerrados: asked once; cancelling keeps everything.
    await page.locator('#closed-list .cl-ft button.forget-all').click()
    const dlg = page.locator('dialog[open][data-dialog="forget-ended"]')
    await dlg.waitFor()
    assert.match((await dlg.locator('h2').textContent())!, /3 slots encerrados/)
    await page.keyboard.press('Escape')
    await dlg.waitFor({ state: 'detached' })
    assert.equal((await slotsOf(page)).length, 2 + 3 + 1)
    await openMenu(page)
    await page.locator('#closed-list .cl-ft button.forget-all').click()
    await dlg.waitFor()
    await dlg.locator('button.choice[data-choice="forget"]').click()
    await page.waitForFunction(ids => ids.every(id => !window.__tether.slots().some(s => s.slotId === id)), ended)
    assert.deepEqual(await badge(page), ['2', ''])
    assert.equal(await page.locator('#closed-list .cl-ended').count(), 0)
    for (const pid of pids) assert.ok(pidAlive(pid), 'running slots are untouched by "forget all"')
    assert.ok((await slotsOf(page)).some(s => s.slotId === keep && s.status === 'running'))
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
