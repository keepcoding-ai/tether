// E2E: a live agent with NO guia ("Sem mesa") as a member of a channel. A tetherd in this process on a private home and pipe, the real
// channels daemon side, two fake `claude` agents (test/fixtures/channels/agent.cjs, no LLM), the real app on the same pipe, hidden window.
// Nothing touches the person's tether. It proves:
//   1. "Juntar agente…" lists the agents with no guia under "Sem mesa", marked "sem mesa" (capture semmesa-juntar.png);
//   2. joining one works: it shows in the member list, and a plain click on its name opens the peek card (no "guia fechada" dialog);
//   3. its menu has "Espiar" first and no "Ir para a guia";
//   4. the Sessões panel spares it in the bulk close (hint) and the ✕ of its row asks first ("membro de 1 canal").
// Run alone: node --test test/e2e/app.channels-nodesk.test.ts   (one E2E at a time: the build is remade)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { DisposableStore } from '../../app/shared/vscode-lifecycle.ts'
import '../../src/agents/load.ts'
import { agentRegistry, type AgentContribution } from '../../src/agents/registry.ts'
import type { AgentAdapter, LaunchPlan } from '../../src/agents/types.ts'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { DoorHost } from '../../src/daemon/door/host.ts'
import { fsIo } from '../../src/daemon/ext-io.ts'
import { startDaemon } from '../../src/daemon/server.ts'
import { createChannels, type Channels, type ChannelsApi } from '../../extensions/channels/daemon/fanout.ts'
import { registerChannelRequests } from '../../extensions/channels/daemon/requests.ts'
import { openStore } from '../../extensions/channels/daemon/store.ts'
import { USER } from '../../extensions/channels/rules.ts'
import { removeHome, tempHome, uniquePipe, waitUntil } from '../unit/daemon.helpers.ts'
import { killElectron } from './electron.ts'

type Hooks = {
  panelIds(): string[]
  slots(): SlotState[]
  applyState(s: SlotState): void
  peekState(): { open: boolean; slotId?: string; routed: boolean }
  ext: { channels: { run(id: string, arg?: unknown): void } }
}
declare const window: { __tether: Hooks; innerWidth: number }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const AGENT = fileURLToPath(new URL('../fixtures/channels/agent.cjs', import.meta.url))
const SHOTS = 'C:/atrium/.tmp/tether-agents/onda-3/espiar'

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

test('channels: an agent with no guia joins a channel (picker "Sem mesa", name peeks, Sessões spares it)', { timeout: 420_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(SHOTS, { recursive: true })
  const home = tempHome()
  const pipe = uniquePipe(home)
  const logs: string[] = []
  const door = new DoorHost({ log: m => logs.push(m) })
  const own = new DisposableStore()

  const fake: AgentAdapter = {
    name: 'claude',
    plan: (input): LaunchPlan => {
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
      delete env.NODE_TEST_CONTEXT
      env.ECHO_LOG = join(home, `echo-${input.slot.slotId}.log`)
      env.CHAN_LOG = join(home, `chan-${input.slot.slotId}.log`)
      env.OPEN_STREAM = '1'
      return { command: process.execPath, args: [AGENT], cwd: input.slot.cwd, env }
    },
    sessionExists: async () => 'unknown',
    title: async b => b.title,
  }
  const contribution = agentRegistry.get('claude')! as { channels?: AgentContribution['channels'] }
  const savedChannels = contribution.channels
  contribution.channels = () => []

  const daemon = await startDaemon({
    home, pipe, memoryIntervalMs: 0, readyFallbackMs: 300, minAgentAgeMs: 0, adapters: { claude: fake }, channelOf: () => undefined, door,
    log: m => logs.push(m),
  })
  const doorApi = door.apiFor('channels', own)
  own.add(doorApi.delivery.enable())
  const api: ChannelsApi = { slots: doorApi.slots, attention: doorApi.attention, delivery: doorApi.delivery, events: doorApi.events, settings: { get: () => undefined }, log: m => logs.push(m) }
  const ch: Channels = createChannels(api, await openStore(fsIo, home))
  for (const d of registerChannelRequests(doorApi, Promise.resolve(ch))) own.add(d)

  let app: ElectronApplication | undefined
  try {
    const running = async (name: string, desk?: string): Promise<string> => {
      const id = (await doorApi.slots.create({ kind: 'claude', cwd: home, name, ...(desk ? { desk } : {}) })).slotId
      await waitUntil(() => doorApi.slots.get(id)?.status === 'running' && doorApi.slots.readScreen(id).data.includes('READY'), 30_000, `${name} running`)
      return id
    }
    const a = await running('conferente', 'desk-1')
    const n = await running('solto')
    const m = await running('ocioso')
    const nameN = ch.nameOf(n)

    const made = await ch.create(USER, { name: 'horizontes' })
    assert.ok(made.ok)
    const hz = made.channel.id
    assert.ok((await ch.join(USER, hz, a)).ok)

    let page: Page
    ;({ app, page } = await launch(home, pipe))
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(1700, 900) })
    await page.waitForFunction(() => window.innerWidth >= 1500 && typeof window.__tether.ext?.channels?.run === 'function')
    await page.waitForFunction(p => window.__tether.panelIds().includes(p), a)
    assert.equal(await page.locator(`.tether-tab[data-slot="${n}"]`).count(), 0, 'n has no guia')
    const pane = page.locator(`.ch-pane[data-channel="${hz}"]`)
    const picker = page.locator('dialog.picker[open]')
    const menuRows = async (): Promise<string[]> => (await page.locator('#ctx-menu li').allInnerTexts()).map(t => t.replace(/\s+/g, ' ').trim()).filter(t => t !== '')
    await page.evaluate(id => window.__tether.ext.channels.run('channels.open', { channel: id }), hz)
    await pane.waitFor()
    await pane.locator('.ch-members').waitFor()

    // ---- 1. the picker lists the loose agents under "Sem mesa" ----
    console.log('step 1')
    await pane.locator('.ch-bar .ch-join').click()
    await picker.waitFor()
    assert.deepEqual(await page.locator('dialog.picker li.pk-group').allTextContents(), ['Sem mesa'])
    const nRow = page.locator('dialog.picker li.pk-item', { hasText: 'solto' })
    assert.match(await nRow.innerText(), /sem mesa/, 'the row says "sem mesa"')
    assert.equal(await page.locator('dialog.picker li.pk-item').count(), 2, 'solto and ocioso, not the member')
    const box = (await page.locator('dialog.picker').boundingBox())!
    await page.screenshot({ path: join(SHOTS, 'semmesa-juntar.png'), clip: { x: Math.max(0, box.x - 10), y: Math.max(0, box.y - 10), width: box.width + 20, height: box.height + 20 } })

    // ---- 2. joining works ----
    console.log('step 2')
    await nRow.click() // a click marks in the many box
    await page.keyboard.press('Enter')
    await waitUntil(() => n in ch.store.get(hz)!.members, 10_000, 'n joined')
    await pane.locator(`.ch-mrow[data-member="${n}"]`).waitFor()
    assert.equal(await pane.locator(`.ch-mrow[data-member="${n}"] button.ch-agent`).getAttribute('title'), 'Sem mesa. Clique ou botão direito: espiar')

    // ---- 3. the name peeks; the menu has "Espiar" and no "Ir para a guia" ----
    console.log('step 3')
    await pane.locator(`.ch-mrow[data-member="${n}"] button.ch-agent`).click({ button: 'right' })
    await page.waitForSelector('#ctx-menu li')
    assert.deepEqual(await menuRows(), [`${nameN} · membro`, 'Espiar Clique', `Falar com ${nameN}`, 'Calar', 'Tirar do canal'])
    await page.keyboard.press('Escape')
    await page.waitForSelector('#ctx-menu li', { state: 'detached' })
    await pane.locator(`.ch-mrow[data-member="${n}"] button.ch-agent`).click()
    await page.waitForFunction(id => { const s = window.__tether.peekState(); return s.open && s.slotId === id }, n)
    assert.equal(await page.locator('dialog.ask[open]').count(), 0, 'no "guia fechada" dialog')
    assert.equal(await page.locator(`.tether-tab[data-slot="${n}"]`).count(), 0, 'peeking opens no guia')
    await page.click('#peek .peek-close')
    await page.waitForSelector('#peek', { state: 'hidden' })

    // ---- 4. Sessões spares the member ----
    console.log('step 4')
    await page.waitForTimeout(800) // the directory re-reads the members after the join
    const idle = async (id: string): Promise<void> => page.evaluate(i => {
      const s = window.__tether.slots().find(x => x.slotId === i)!
      window.__tether.applyState({ ...s, turn: 'idle', idleSince: new Date(Date.now() - 3 * 3_600_000).toISOString() } as unknown as SlotState)
    }, id)
    await page.click('#btn-sessions')
    await page.waitForSelector('#sessions-list:not([hidden])')
    await idle(n); await idle(m)
    await page.waitForFunction(() => document.getElementById('sessions-bulk-close')?.textContent?.includes('Encerrar o ocioso sem guia'))
    assert.equal(await page.locator('#sessions-bulk-hint').innerText(), '1 poupado: é dono ou membro de canal')
    await page.locator(`#sessions-list .sx-row[data-slot="${n}"] button.stop`).click()
    const held = page.locator('dialog.ask[data-dialog="stop-held"]')
    await held.waitFor()
    assert.match(await held.innerText(), /é membro de 1 canal\. Encerrar mesmo assim\?/)
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('dialog.ask[open]'))
    assert.equal(doorApi.slots.get(n)?.status, 'running', 'cancel keeps it alive')
    await page.locator('#sessions-bulk-close').click()
    const bulk = page.locator('dialog.ask[data-dialog="bulk-close"]')
    await bulk.waitFor()
    assert.match(await bulk.innerText(), /ocioso/)
    assert.doesNotMatch(await bulk.innerText(), /solto/)
    await page.locator('dialog.ask[data-dialog="bulk-close"] button.choice[data-choice="close"]').click()
    await waitUntil(() => doorApi.slots.get(m)?.status !== 'running', 15_000, 'the idle non-member stopped')
    assert.equal(doorApi.slots.get(n)?.status, 'running', 'the member was spared')
  } catch (e) {
    console.error(`daemon log:\n${logs.slice(-25).join('\n')}`)
    throw e
  } finally {
    contribution.channels = savedChannels
    if (app) await killElectron(app, root).catch(() => {})
    ch.dispose()
    await door.delivery.flush().catch(() => {})
    own.dispose()
    door.delivery.dispose()
    await daemon.close()
    await door.mcp.close()
    await removeHome(home)
  }
})
