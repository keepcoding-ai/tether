// E2E: a live agent with NO guia ("Sem guia" in the sessions menu) can own desks and guias. A tetherd in this process on a
// private home and pipe, with the real for-agents daemon side; the real app on the same pipe, hidden window. Fake agents in a
// .cjs that only stay alive: no LLM. It proves: the agent appears in the picker "Dar a mesa … a…" under "Sem mesa" and marked
// "sem mesa"; giving the desk to it shows its NAME as the owner (pill menu, tab menu), not an id; "Ir para" it opens the peek
// card; the bulk close of the idle ones without a guia spares it (hint) and the ✕ of its row asks first.
// Every kill goes through test/kill.ts (pid + creation time); the daemon here is closed in-process.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { DisposableStore } from '../../app/shared/vscode-lifecycle.ts'
import { wire } from '../../extensions/for-agents/daemon.ts'
import { EXT_ID, manifest } from '../../extensions/for-agents/manifest.ts'
import type { ExtensionEntry } from '../../extensions/types.ts'
import type { AgentAdapter, LaunchPlan } from '../../src/agents/types.ts'
import type { TetherDaemon } from '../../src/daemon/ext-api.ts'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { DaemonExtensionHost } from '../../src/daemon/ext-host.ts'
import { DoorHost } from '../../src/daemon/door/host.ts'
import { startDaemon } from '../../src/daemon/server.ts'
import { removeHome, tempHome, uniquePipe, waitUntil } from '../unit/daemon.helpers.ts'
import { killElectron } from './electron.ts'

type Hooks = {
  activeDesk(): string
  renameDesk(id: string, name: string): void
  openSlot(id: string): Promise<void>
  slots(): SlotState[]
  applyState(s: SlotState): void
  peekState(): { open: boolean; slotId?: string; routed: boolean }
}
declare const window: { __tether: Hooks; innerWidth: number }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const STAY = ["process.stdout.write('READY\\r\\n')", 'setInterval(() => {}, 1000)'].join('\n')
const SHOT = 'C:/atrium/.tmp/tether-agents/onda-3/espiar/semmesa-seletor.png'

async function launch(home: string, pipe: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_') && !k.toUpperCase().startsWith('CLAUDE')) env[k] = v
  env.TETHER_PIPE = pipe
  env.TETHER_HOME = home
  env.TETHER_E2E_HIDDEN = '1'
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  page.on('pageerror', e => console.error(`renderer error: ${e.stack}`))
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  return { app, page }
}

const rowsOf = (page: Page): Promise<string[]> => page.locator('#ctx-menu > li').evaluateAll(lis => lis.map(li => {
  if (li.classList.contains('sep')) return '—'
  if (li.classList.contains('hd')) return `# ${li.textContent ?? ''}`
  return [...li.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent ?? '').join('').trim()
}))

test('for-agents: an agent with no guia owns a desk (picker "Sem mesa", name as owner, click opens the peek card, bulk close spares it)', { timeout: 600_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit', env: { ...process.env, TETHER_TEST_EXTENSIONS: '1' } })
  assert.equal(build.status, 0, 'app build failed')
  const home = tempHome()
  const pipe = uniquePipe(home)
  const logs: string[] = []
  writeFileSync(join(home, 'stay.cjs'), STAY)
  const fake: AgentAdapter = {
    name: 'soul',
    plan: (input): LaunchPlan => {
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
      delete env.NODE_TEST_CONTEXT
      return { command: process.execPath, args: [join(home, 'stay.cjs')], cwd: input.resume?.cwd ?? input.slot.cwd, env }
    },
    sessionExists: async () => 'unknown',
    title: async b => b.title,
  }
  const door = new DoorHost({ log: m => logs.push(m) })
  const entry: ExtensionEntry<TetherDaemon> = { manifest, activate: api => wire(api).disposables }
  const host = new DaemonExtensionHost({ home, log: m => logs.push(m), door, extensions: [entry] })
  host.activate()
  const daemon = await startDaemon({
    home, pipe, memoryIntervalMs: 0, readyFallbackMs: 500, minAgentAgeMs: 0, adapters: { soul: fake }, door,
    transformPlan: host.transformPlan, onSlot: host.emitSlot, log: m => logs.push(m),
  })
  await door.releaseInactive(host.activated)
  host.emitStarted()
  const api = door.apiFor(EXT_ID, new DisposableStore())
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home, pipe))
    page.on('console', m => { if (m.type() === 'error') console.log(m.type(), m.text()) })
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(1600, 900) })
    await page.waitForFunction(() => window.innerWidth >= 1500)
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light' })

    const D1 = 'desk-1'
    await page.evaluate(() => { window.__tether.renameDesk('desk-1', 'obra') })
    const slot = async (name: string): Promise<string> => (await api.slots.create({ kind: 'soul', cwd: home, name })).slotId
    const P = await slot('soul · bancada')
    const N = await slot('Dona sem mesa')
    const M = await slot('Ocioso livre')
    await page.evaluate(id => window.__tether.openSlot(id), P)
    await page.locator(`.tether-tab[data-slot="${P}"]`).waitFor()
    await waitUntil(() => (api.desks.map()?.desks.length ?? 0) >= 1, 20_000, 'desk map')
    assert.equal(await page.locator(`.tether-tab[data-slot="${N}"]`).count(), 0, 'N has no guia')

    const picker = page.locator('dialog.picker')
    const askDialog = (situation: string) => page.locator(`dialog.ask[data-dialog="${situation}"]`)
    const pill = page.locator(`#desk-switch .seg[data-desk="${D1}"]`)
    const openPill = async (): Promise<string[]> => { await pill.click({ button: 'right' }); await page.waitForSelector('#ctx-menu li'); return rowsOf(page) }
    const choose = async (label: string): Promise<void> => {
      await page.locator('#ctx-menu > li', { hasText: new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`) }).click()
    }

    // ---- 1. the picker offers the agent with no guia, under "Sem mesa" ----
    await openPill()
    await choose('Dar a mesa a um agente…')
    await picker.locator('input').waitFor({ state: 'visible' })
    assert.equal(await picker.locator('.pk-title').innerText(), 'Dar a mesa obra a…')
    assert.deepEqual((await picker.locator('li.pk-item .pk-label').allInnerTexts()).sort(), ['Dona sem mesa', 'Ocioso livre', 'soul · bancada'])
    assert.deepEqual(await picker.locator('li.pk-group').allTextContents(), ['Nesta mesa', 'Sem mesa'])
    const nRow = picker.locator('li.pk-item').filter({ has: page.locator('.pk-label', { hasText: /^Dona sem mesa$/ }) })
    assert.match(await nRow.innerText(), /sem mesa/, 'the row says "sem mesa" instead of "mora em"')
    assert.doesNotMatch(await nRow.innerText(), /mora em/)
    mkdirSync(join(SHOT, '..'), { recursive: true })
    const box = (await picker.boundingBox())!
    await page.screenshot({ path: SHOT, clip: { x: Math.max(0, box.x - 10), y: Math.max(0, box.y - 10), width: box.width + 20, height: box.height + 20 } })

    // ---- 2. give the desk to it: the owner shows by name, not by id ----
    await nRow.click()
    await askDialog('for-agents.give-desk').waitFor()
    assert.equal(await askDialog('for-agents.give-desk').locator('h2, .ask-title').first().innerText(), 'Dar a mesa obra a Dona sem mesa')
    await page.locator('dialog.ask[data-dialog="for-agents.give-desk"] button.choice[data-choice="give"]').click()
    await waitUntil(() => api.objects.get<{ owner: string }>('desk', D1, 'owner')?.owner === N, 15_000, 'desk owner written')
    await waitUntil(() => api.slots.get(P)?.held !== undefined, 15_000, 'the guia is held by the owner')
    const menu = await openPill()
    assert.ok(menu.some(l => l.startsWith('# Dono: Dona sem mesa')), `the pill menu names the owner (${menu.join(' | ')})`)
    assert.ok(!menu.some(l => l.includes(N)), 'no id in the pill menu')
    assert.ok(menu.includes('Ir para Dona sem mesa'), 'and "Ir para" names it')

    // ---- 3. "Ir para" the owner with no guia opens the peek card ----
    await choose('Ir para Dona sem mesa')
    await page.waitForFunction(id => { const s = window.__tether.peekState(); return s.open && s.slotId === id }, N)
    assert.equal(await page.locator(`.tether-tab[data-slot="${N}"]`).count(), 0, 'peeking opens no guia')
    await page.click('#peek .peek-close')
    await page.waitForSelector('#peek', { state: 'hidden' })
    // The tab of the commanded guia names the owner too.
    await page.locator(`.tether-tab[data-slot="${P}"]`).click({ button: 'right' })
    await page.waitForSelector('#ctx-menu li')
    assert.equal((await rowsOf(page))[0], '# Comandada por Dona sem mesa, pela mesa')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.getElementById('ctx-menu'))

    // ---- 4. the bulk close spares the owner; the ✕ of its row asks first ----
    const idle = async (id: string): Promise<void> => page.evaluate(i => {
      const s = window.__tether.slots().find(x => x.slotId === i)!
      window.__tether.applyState({ ...s, turn: 'idle', idleSince: new Date(Date.now() - 3 * 3_600_000).toISOString() } as unknown as SlotState)
    }, id)
    await page.click('#btn-sessions')
    await page.waitForSelector('#sessions-list:not([hidden])')
    await idle(N); await idle(M)
    await page.waitForFunction(() => document.getElementById('sessions-bulk-close')?.textContent?.includes('Encerrar o ocioso sem guia'))
    assert.equal(await page.locator('#sessions-bulk-hint').innerText(), '1 poupado: é dono ou membro de canal')
    await page.locator(`#sessions-list .sx-row[data-slot="${N}"] button.stop`).click()
    const held = askDialog('stop-held')
    await held.waitFor()
    assert.match(await held.innerText(), /Dona sem mesa é dono de 1 mesa\. Encerrar mesmo assim\?/)
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('dialog.ask[open]'))
    assert.equal(api.slots.get(N)?.status, 'running', 'cancel keeps it alive')
    await page.locator('#sessions-bulk-close').click()
    await askDialog('bulk-close').waitFor()
    assert.match(await askDialog('bulk-close').innerText(), /Ocioso livre/)
    assert.doesNotMatch(await askDialog('bulk-close').innerText(), /Dona sem mesa/)
    await page.locator('dialog.ask[data-dialog="bulk-close"] button.choice[data-choice="close"]').click()
    await waitUntil(() => api.slots.get(M)?.status !== 'running', 15_000, 'the idle one stopped')
    assert.equal(api.slots.get(N)?.status, 'running', 'the owner was spared')
  } catch (e) {
    console.error(`daemon log:\n${logs.slice(-25).join('\n')}`)
    throw e
  } finally {
    if (app) await killElectron(app, root).catch(() => {})
    await daemon.close()
    await removeHome(home)
  }
})
