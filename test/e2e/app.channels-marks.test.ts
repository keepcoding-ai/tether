// E2E of the channel marks and the top bar icon (slice U3): a tetherd in this process on a private home and pipe, with the channels
// extension's record and requests on its door and two fake `claude` agents (test/fixtures/channels/agent.cjs, no LLM); the real app
// on the same pipe, hidden window. Nothing touches the person's tether.
//   1. A line for everyone, with the pane closed: it counts as unread in the icon's popover, with no orange (the icon stays `normal`,
//      no badge, no seal); the person's own line counts for nothing.
//   2. A line to her, pane closed: the icon turns `warn` (badge 1) and the popover row says "para você"; a click on the row opens the pane.
//      Opening the pane (the end in front of her) is seeing: what was held goes.
//   3. Pane open but covered by another tab: a line for everyone is the quiet ring on the tab (no orange); a line to her lights the
//      orange dot on the tab and the sticky seal; the tab of whoever spoke carries nothing; the other tabs' orange does not change; the
//      pane in front sees everything at once and carries no mark.
//   4. The person comes back to the tab (end in view): every mark goes and `seen` reaches the daemon.
//   5. Reading above the end: a line to her makes the bar "N novas para você" (orange), a click goes to it, and the end clears it.
// Run alone: node --test test/e2e/app.channels-marks.test.ts   (one E2E at a time: the build is remade)
// Every kill goes through test/kill.ts (pid + creation time); the daemon here is closed in-process.
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
import { DoorHost } from '../../src/daemon/door/host.ts'
import { fsIo } from '../../src/daemon/ext-io.ts'
import { startDaemon } from '../../src/daemon/server.ts'
import { createChannels, type Channels, type ChannelsApi } from '../../extensions/channels/daemon/fanout.ts'
import { MODERATOR_NAME } from '../../extensions/channels/daemon/notices.ts'
import { registerChannelRequests } from '../../extensions/channels/daemon/requests.ts'
import { openStore } from '../../extensions/channels/daemon/store.ts'
import type { ChannelMarks } from '../../extensions/channels/renderer/marks.ts'
import type { PaneSnapshot } from '../../extensions/channels/renderer/channel-pane.ts'
import { USER } from '../../extensions/channels/rules.ts'
import { removeHome, tempHome, uniquePipe, waitUntil } from '../unit/daemon.helpers.ts'
import { killElectron } from './electron.ts'

type StatusView = { state: string; title: string; badge: number | undefined; unread: number; toMe: number; rows: Array<{ id: string; name: string; text: string; toMe: number }> }
type Hooks = {
  panelIds(): string[]
  ext: {
    channels: {
      open(id: string, name?: string): void
      view(id: string): PaneSnapshot | undefined
      marks(id: string): ChannelMarks & { seal: boolean }
      status(): StatusView
      scrollTo(id: string, top: number): void
    }
  }
}
declare const window: { __tether: Hooks }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const AGENT = fileURLToPath(new URL('../fixtures/channels/agent.cjs', import.meta.url))
const SHOTS = 'C:/atrium/.tmp/tether-agents/onda-3/u3'

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
  page.on('console', m => { if (m.type() === 'error') console.error(`renderer ${m.type()}: ${m.text()}`) })
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  return { app, page }
}

test('channel marks: unread, "to you", the top bar icon and what makes them go', { timeout: 420_000 }, async () => {
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
    const running = async (name: string): Promise<string> => {
      const id = (await doorApi.slots.create({ kind: 'claude', cwd: home, name, desk: 'desk-1' })).slotId
      await waitUntil(() => doorApi.slots.get(id)?.status === 'running' && doorApi.slots.readScreen(id).data.includes('READY'), 30_000, `${name} running`)
      await waitUntil(() => doorApi.delivery.pathOf(id) === 'inside', 30_000, `${name} opened its stream`)
      return id
    }
    const a = await running('conferente')
    const b = await running('bancada')

    const made = await ch.create(USER, { name: 'conferencia', title: 'Conferência' })
    assert.ok(made.ok)
    const conf = made.channel.id
    assert.ok((await ch.join(USER, conf, a)).ok)
    assert.ok((await ch.join(USER, conf, b)).ok)
    const other = await ch.create(USER, { name: 'extra' })
    assert.ok(other.ok)
    const extra = other.channel.id
    assert.ok((await ch.join(USER, extra, b)).ok)

    let page: Page
    ;({ app, page } = await launch(home, pipe))
    await page.waitForFunction(() => typeof window.__tether.ext?.channels?.status === 'function')
    for (const id of [a, b]) await page.waitForFunction(p => window.__tether.panelIds().includes(p), id)

    const speak = async (who: string, channel: string, body: string, to?: string[]): Promise<number> => {
      const r = await ch.say(who, channel, { body, ...(to ? { to } : {}) })
      assert.ok(r.ok, `say refused: ${JSON.stringify(r)}`)
      return r.line.seq
    }
    const status = (): Promise<StatusView> => page.evaluate(() => window.__tether.ext.channels.status())
    const marks = (id: string): Promise<ChannelMarks & { seal: boolean }> => page.evaluate(i => window.__tether.ext.channels.marks(i), id)
    const view = (id: string): Promise<PaneSnapshot | undefined> => page.evaluate(i => window.__tether.ext.channels.view(i), id)
    const until = async (what: string, fn: () => Promise<boolean>): Promise<void> => {
      const end = Date.now() + 15_000
      while (Date.now() < end) { if (await fn()) return; await page.waitForTimeout(100) }
      throw new Error(`timeout: ${what}`)
    }
    const tab = (id: string) => page.locator(`.ch-tab[data-channel="${id}"]`)
    const statusBtn = page.locator('.status-wrap[data-status="channels.status"] .status-btn')
    const orangeOf = (): Promise<number> => page.locator('.tether-tab .attn:is(.attention, .done, .waiting)').count()

    // Nothing for the person yet: the icon is grey and has no number.
    await until('the icon is drawn grey', async () => (await statusBtn.count()) === 1 && (await statusBtn.getAttribute('data-state')) === 'idle')
    assert.equal(await page.locator('.status-wrap[data-status="channels.status"] .status-badge:not([hidden])').count(), 0)
    const orange0 = await orangeOf()

    // ---- 1. a line for everyone, pane closed: unread in the popover, no orange; her own line counts for nothing ----
    console.log('step 1')
    await speak(a, conf, 'bom dia a todos')
    await until('the line counts', async () => (await status()).unread === 1)
    let s = await status()
    assert.equal(s.toMe, 0)
    assert.equal(s.state, 'normal', 'unread is not orange')
    assert.equal(s.badge, undefined, 'no number for lines to everyone')
    assert.equal(await statusBtn.getAttribute('data-state'), 'normal')
    assert.equal(await page.locator('.status-wrap[data-status="channels.status"] .status-badge:not([hidden])').count(), 0)
    assert.equal((await marks(conf)).seal, false)
    await speak(USER, conf, 'obrigada')
    await page.waitForTimeout(300)
    assert.equal((await status()).unread, 1, 'the person\'s own line is not unread')
    await statusBtn.click()
    const pop = page.locator('.status-wrap[data-status="channels.status"] .ch-pop')
    await pop.waitFor()
    const row = pop.locator(`.ch-pop-row[data-channel="${conf}"]`)
    assert.match(await row.innerText(), /#conferencia[\s\S]*2 membros[\s\S]*1 fala nova/)
    assert.equal(await pop.locator('.ch-pop-row.to-me').count(), 0, 'no row is orange')
    assert.equal(await pop.locator(`.ch-pop-row[data-channel="${extra}"]`).count(), 1, 'a quiet channel is listed too')
    await page.screenshot({ path: join(SHOTS, 'popover-nao-lidas.png') })
    await page.keyboard.press('Escape')
    await pop.waitFor({ state: 'hidden' })

    // ---- 2. a line to her, pane closed: the icon's state, the popover row; a click on the row opens the pane ----
    console.log('step 2')
    await speak(a, conf, 'posso seguir com a migração?', [MODERATOR_NAME])
    await until('the icon turns warn', async () => (await status()).state === 'warn')
    s = await status()
    assert.equal(s.toMe, 1)
    assert.equal(s.badge, 1)
    assert.equal(s.unread, 2)
    assert.equal(await statusBtn.getAttribute('data-state'), 'warn')
    assert.equal((await marks(conf)).seal, false, 'no pane, no seal: the icon says it')
    assert.equal(await orangeOf(), orange0, 'the agents\' tabs did not change')
    await statusBtn.click()
    await pop.waitFor()
    assert.equal(await row.getAttribute('class').then(c => c?.includes('to-me')), true)
    assert.match(await row.innerText(), /para você/)
    assert.equal(await pop.locator(`.ch-pop-row[data-channel="${extra}"]`).evaluate(e => e.classList.contains('to-me')), false, 'the other channel stays quiet')
    await page.screenshot({ path: join(SHOTS, 'popover-para-voce.png') })
    await row.click()
    await page.waitForFunction(p => window.__tether.panelIds().includes(p), `channel:${conf}`)
    await pop.waitFor({ state: 'hidden' })
    await until('the pane loaded', async () => (await view(conf))?.loaded === true)

    // Opening the pane puts the end of the conversation in front of her (the hidden window counts as in front): what was held goes.
    await until('opening the pane is seeing', async () => { const m = await marks(conf); return m.unread === 0 && m.toMe === 0 })
    assert.equal((await status()).state, 'idle', 'the icon is grey again')
    assert.equal(await statusBtn.getAttribute('data-state'), 'idle')
    assert.equal((await marks(conf)).seal, false)

    // ---- 3. the pane is open but not in front (another tab covers it): the ring, the dot and the seal; nothing on the speaker's tab ----
    console.log('step 3')
    await page.evaluate(([i, n]) => window.__tether.ext.channels.open(i!, n), [extra, 'extra'] as const)
    await page.waitForFunction(p => window.__tether.panelIds().includes(p), `channel:${extra}`)
    await until('the other pane loaded', async () => (await view(extra))?.loaded === true)
    await until('the conferencia is covered', async () => (await view(conf))!.scroll.client === 0)
    await speak(a, conf, 'mais um comentário')
    await until('the ring is on the tab', async () => (await tab(conf).getAttribute('data-mark')) === 'plain')
    assert.equal(await tab(conf).locator('.ch-att:not([hidden])').count(), 0, 'a line for everyone has no orange')
    assert.equal(await tab(conf).locator('.ch-ring:not([hidden])').count(), 1)
    assert.equal((await marks(conf)).seal, false)
    assert.equal((await status()).state, 'normal')
    await page.screenshot({ path: join(SHOTS, 'aba-nao-lidas.png') })
    await speak(b, conf, 'e outra')
    await speak(a, conf, 'pode aprovar?', [MODERATOR_NAME])
    await until('the dot and the seal are on the tab', async () => (await marks(conf)).seal && (await tab(conf).getAttribute('data-mark')) === 'me')
    assert.equal(await tab(conf).locator('.ch-att:not([hidden])').count(), 1, 'the dot is the line to her')
    assert.equal(await tab(conf).locator('.ch-ring:not([hidden])').count(), 1, 'and the ring is for the others')
    assert.equal((await marks(conf)).unread, 3)
    assert.equal((await status()).state, 'warn', 'the icon follows too')
    await page.screenshot({ path: join(SHOTS, 'aba-para-voce.png') })
    assert.equal(await orangeOf(), orange0, 'the speaker\'s and the others\' tabs carry no orange')
    for (const id of [a, b]) assert.equal(await page.locator(`.tether-tab[data-slot="${id}"] .ext-emblem`).count(), 0, 'no mark on the tab of an agent')
    // The pane in front sees what comes at once: no mark, no seal, however it is addressed.
    await speak(b, extra, 'só para constar')
    await speak(b, extra, 'e para você', [MODERATOR_NAME])
    await page.waitForTimeout(600)
    assert.equal(await tab(extra).getAttribute('data-mark'), '', 'what the pane in front shows is already seen')
    assert.equal((await marks(extra)).seal, false)
    assert.equal(await tab(conf).getAttribute('data-mark'), 'me', 'the other channel did not change')

    // ---- 4. the person comes back to the tab: the end is in view, every mark goes and `seen` reaches the daemon ----
    console.log('step 4')
    await page.evaluate(([i, n]) => window.__tether.ext.channels.open(i!, n), [conf, 'conferencia'] as const)
    await until('the conferencia is seen', async () => { const m = await marks(conf); return m.unread === 0 && !m.seal })
    assert.equal(await tab(conf).getAttribute('data-mark'), '')
    assert.equal((await status()).state, 'idle')
    assert.equal(await statusBtn.getAttribute('data-state'), 'idle')
    const last = (await view(conf))!.last
    await waitUntil(() => ch.store.get(conf)!.seenByUser === last, 10_000, 'the daemon heard `seen`')

    // ---- 5. reading above the end: the bar "novas para você" ----
    console.log('step 5')
    for (let i = 0; i < 40; i++) await speak(b, conf, `linha de histórico ${i + 1} com um texto um pouco mais comprido para ocupar a tela`)
    await until('the 40 lines are in the pane', async () => (await view(conf))!.rows.filter(r => r.kind === 'say').length >= 40)
    assert.equal((await marks(conf)).unread, 0, 'seen as they came: the end is in view')
    await page.evaluate(i => window.__tether.ext.channels.scrollTo(i, 0), conf)
    await until('reading the top', async () => (await view(conf))!.scroll.stick === false)
    await speak(b, conf, 'uma fala para todos')
    await until('the plain bar', async () => (await view(conf))!.bar === '1 fala nova')
    assert.equal((await view(conf))!.barMe, false)
    const toMe = await speak(a, conf, 'preciso de um OK seu', [MODERATOR_NAME])
    await until('the bar for her', async () => (await view(conf))!.bar === '1 nova para você')
    assert.equal((await view(conf))!.barMe, true)
    assert.equal(await tab(conf).locator('.ch-att:not([hidden])').count(), 1)
    assert.equal((await marks(conf)).firstToMe, toMe)
    assert.equal(await page.locator(`.ch-pane[data-channel="${conf}"] .ch-msg[data-seq="${toMe}"]`).evaluate(e => e.classList.contains('to-me')), true)
    await page.screenshot({ path: join(SHOTS, 'barra-novas-para-voce.png') })
    await page.locator(`.ch-pane[data-channel="${conf}"] .ch-newbar`).click()
    await until('the click brings the line into view', () => page.locator(`.ch-pane[data-channel="${conf}"] .ch-msg[data-seq="${toMe}"]`).evaluate(e => {
      const r = e.getBoundingClientRect(), v = e.closest('.ch-msgs')!.getBoundingClientRect()
      return r.top >= v.top - 1 && r.bottom <= v.bottom + 1
    }))
    await page.evaluate(i => window.__tether.ext.channels.scrollTo(i, 1e9), conf)
    await until('the end clears everything', async () => { const m = await marks(conf); return m.toMe === 0 && m.unread === 0 && !m.seal })
    assert.equal((await view(conf))!.bar, '')
    assert.equal(await tab(conf).locator('.ch-att:not([hidden])').count(), 0)
    assert.equal((await status()).state, 'idle')
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
