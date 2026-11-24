// E2E of the attention of the reactions (slice R5): a tetherd in this process on a private home and pipe, with the channels
// extension's record and requests on its door and two fake `claude` agents (no LLM); the real app on the same pipe, hidden window.
//   1. 👍, 👀 and ❓ on a speech of an AGENT (and a 🎉) light nothing: no seal, no orange on the tab, an idle icon;
//   2. an agent's ❓ on a speech of the person, the pane covered by another tab: the seal, the orange counter on the tab, the icon;
//      taken back, everything goes;
//   3. an agent's ❌ on it: lit again; the pane in front at the end with the speech out of view: the bar "1 reação pede você"; its
//      click goes to the speech, marks it, and that is seeing it: the bar, the seal and the icon go and `seen` reaches the daemon;
//   4. the person's own ❓ on an agent's speech wakes nobody and says, in the pill's hint, who reads it next;
//   5. the app restarted: what was seen stays quiet, what was not comes back lit (the mark lives in the record's `seenByUser`).
// Run alone: node --test test/e2e/app.channels-reactions-attention.test.ts   (one E2E at a time: the build is remade)
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
import { registerChannelRequests } from '../../extensions/channels/daemon/requests.ts'
import { openStore } from '../../extensions/channels/daemon/store.ts'
import type { ChannelMarks } from '../../extensions/channels/renderer/marks.ts'
import type { PaneSnapshot } from '../../extensions/channels/renderer/channel-pane.ts'
import type { Ask } from '../../extensions/channels/rules.ts'
import { USER } from '../../extensions/channels/rules.ts'
import { removeHome, tempHome, uniquePipe, waitUntil } from '../unit/daemon.helpers.ts'
import { killElectron } from './electron.ts'

type StatusView = { state: string; title: string; badge: number | undefined; unread: number; toMe: number; rows: Array<{ id: string }> }
type Marked = ChannelMarks & { seal: boolean; asks: Ask[] }
type Hooks = {
  panelIds(): string[]
  ext: { channels: {
    open(channelId: string, name?: string): void
    view(channelId: string): PaneSnapshot | undefined
    marks(channelId: string): Marked
    status(): StatusView
  } }
}
declare const window: { __tether: Hooks }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const AGENT = fileURLToPath(new URL('../fixtures/channels/agent.cjs', import.meta.url))
const SHOTS = 'C:/atrium/.tmp/tether-agents/onda-3/reacoes/r5'

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

test('channel pane: a ❓ or ❌ of an agent on her speech asks her (seal, bar), and goes when she sees it', { timeout: 420_000 }, async () => {
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
      const id = (await doorApi.slots.create({ kind: 'claude', cwd: home, name })).slotId
      await waitUntil(() => doorApi.slots.get(id)?.status === 'running' && doorApi.slots.readScreen(id).data.includes('READY'), 30_000, `${name} running`)
      await waitUntil(() => doorApi.delivery.pathOf(id) === 'inside', 30_000, `${name} opened its stream`)
      return id
    }
    const a = await running('conferente')
    const b = await running('bancada')
    const made = await ch.create(USER, { name: 'obra', title: 'Obra' })
    assert.ok(made.ok)
    const id = made.channel.id
    assert.ok((await ch.join(USER, id, a)).ok)
    assert.ok((await ch.join(USER, id, b)).ok)
    const other = await ch.create(USER, { name: 'extra' })
    assert.ok(other.ok)
    const extra = other.channel.id
    const nameA = ch.nameOf(a)

    const speak = async (who: string, body: string): Promise<number> => {
      const r = await ch.say(who, id, { body })
      assert.ok(r.ok, `say refused: ${JSON.stringify(r)}`)
      return r.line.seq
    }
    const hers = await speak(USER, 'Sobe depois do almoço, e confira o relatório inteiro antes.')
    for (let i = 0; i < 30; i++) await speak(i % 2 ? a : b, `linha de histórico ${i + 1}, com um texto um pouco mais comprido para ocupar a tela da conversa`)
    const theirs = await speak(a, 'Terminei a revisão. Posso subir?')
    const react = async (who: string, seq: number, reaction: string, remove = false): Promise<number> => {
      const r = await ch.react(who, id, { seq, reaction, ...(remove ? { remove: true } : {}) })
      assert.ok(r.ok && r.changed && r.line, `react refused: ${JSON.stringify(r)}`)
      return r.line.seq
    }

    let page: Page
    ;({ app, page } = await launch(home, pipe))
    await page.waitForFunction(() => typeof window.__tether.ext?.channels?.status === 'function')
    const view = (i = id): Promise<PaneSnapshot | undefined> => page.evaluate(c => window.__tether.ext.channels.view(c), i)
    const marks = (i = id): Promise<Marked> => page.evaluate(c => window.__tether.ext.channels.marks(c), i)
    const status = (): Promise<StatusView> => page.evaluate(() => window.__tether.ext.channels.status())
    const until = async (what: string, fn: () => Promise<boolean>, ms = 15_000): Promise<void> => {
      const end = Date.now() + ms
      while (Date.now() < end) { if (await fn()) return; await page.waitForTimeout(100) }
      throw new Error(`timeout: ${what}\n${JSON.stringify(await marks().catch(() => undefined))}`)
    }
    const tab = page.locator(`.ch-tab[data-channel="${id}"]`)
    const pane = page.locator(`.ch-pane[data-channel="${id}"]`)
    const statusBtn = page.locator('.status-wrap[data-status="channels.status"] .status-btn')
    const openObra = (): Promise<void> => page.evaluate(([i, n]) => window.__tether.ext.channels.open(i!, n), [id, 'obra'] as const)
    const inView = (seq: number): Promise<boolean> => pane.locator(`.ch-msg[data-seq="${seq}"]`).evaluate(e => {
      const r = e.getBoundingClientRect(), v = e.closest('.ch-msgs')!.getBoundingClientRect()
      return r.top < v.bottom && r.bottom > v.top
    })

    // The pane open and seen, then another tab covers it.
    await openObra()
    await until('the pane loaded and its end seen', async () => { const v = await view(); return v?.loaded === true && (await marks()).seen >= theirs })
    await page.evaluate(([i, n]) => window.__tether.ext.channels.open(i!, n), [extra, 'extra'] as const)
    await until('the obra is covered', async () => (await view())!.scroll.client === 0)
    await until('the directory knows the channels', async () => (await status()).rows.length === 2)
    assert.equal((await status()).state, 'idle')

    // ---- 1. nothing else lights anything ----
    console.log('step 1')
    await react(b, hers, 'agree')
    await react(a, hers, 'seen')
    await react(a, hers, 'done')
    await react(b, hers, '🎉')
    await react(b, theirs, 'question') // ❓ of an agent on another agent's speech
    await react(b, theirs, 'disagree')
    await react(USER, theirs, 'question') // hers, on an agent's speech
    await page.waitForTimeout(800)
    let m = await marks()
    assert.deepEqual([m.asks.length, m.toMe, m.unread, m.seal], [0, 0, 0, false])
    assert.equal(await tab.getAttribute('data-mark'), '')
    assert.equal((await status()).state, 'idle')
    assert.equal(await statusBtn.getAttribute('data-state'), 'idle')

    // ---- 2. an agent's ❓ on her speech, the pane covered: seal, counter, icon; taken back, all goes ----
    console.log('step 2')
    await react(a, hers, 'question')
    await until('the seal is lit', async () => (await marks()).seal)
    m = await marks()
    assert.equal(m.asks.length, 1)
    assert.deepEqual([m.asks[0]!.on, m.asks[0]!.emoji, m.toMe, m.unread], [hers, '❓', 0, 0], 'a reaction is no line: nothing unread')
    assert.equal(await tab.getAttribute('data-mark'), 'me')
    assert.equal(await tab.locator('.ch-att:not([hidden])').textContent(), '1')
    assert.equal(await tab.locator('.ch-att').getAttribute('title'), '1 reação pede você')
    const s2 = await status()
    assert.deepEqual([s2.state, s2.badge], ['warn', 1], JSON.stringify([s2, m]))
    assert.equal(await statusBtn.getAttribute('data-state'), 'warn')
    await page.screenshot({ path: join(SHOTS, 'aba-selo-reacao.png') })
    await react(a, hers, 'question', true)
    await until('taking it back clears it', async () => { const x = await marks(); return !x.seal && x.asks.length === 0 })
    assert.equal(await tab.getAttribute('data-mark'), '')
    assert.equal((await status()).state, 'idle')

    // ---- 3. an agent's ❌: lit again; the pane in front at the end, her speech out of view: the bar; its click is seeing it ----
    console.log('step 3')
    const ask = await react(b, hers, 'disagree')
    await until('lit again', async () => (await marks()).seal)
    assert.equal((await marks()).asks[0]!.seq, ask)
    await openObra()
    await until('the bar asks her', async () => (await view())!.bar === '1 reação pede você')
    let v = (await view())!
    assert.equal(v.barMe, true, 'the orange bar')
    assert.equal(v.asks, 1)
    assert.equal(await inView(hers), false, 'her speech is far above')
    assert.equal(await inView(theirs), true)
    assert.equal((await marks()).seal, true, 'the end in view does not see an ask whose speech is not')
    await page.screenshot({ path: join(SHOTS, 'barra-reacao-pede-voce.png') })
    await pane.locator('.ch-newbar').click()
    await until('the click brought her speech into view', () => inView(hers))
    assert.equal(await pane.locator(`.ch-msg[data-seq="${hers}"]`).evaluate(e => e.classList.contains('ch-flash')), true, 'the speech is marked for a moment')
    await page.screenshot({ path: join(SHOTS, 'fala-destacada.png') })
    await until('seeing the speech clears the ask', async () => { const x = await marks(); return !x.seal && x.asks.length === 0 })
    assert.equal((await view())!.bar, '')
    assert.equal(await tab.getAttribute('data-mark'), '')
    assert.equal((await status()).state, 'idle')
    await waitUntil(() => ch.store.get(id)!.seenByUser >= ask, 10_000, 'the daemon heard `seen` up to the reaction')

    // ---- 4. her own ❓ on an agent's speech wakes nobody and says who reads it next ----
    console.log('step 4')
    const pill = pane.locator(`.ch-msg[data-seq="${theirs}"] .ch-pill[data-emoji="❓"]`)
    await pill.waitFor()
    assert.match((await pill.getAttribute('title'))!, new RegExp(`${nameA} vê isto na próxima mensagem do canal`))
    assert.equal((await marks()).asks.length, 0)
    assert.equal(await pane.locator(`.ch-msg[data-seq="${theirs}"] .ch-pill[data-emoji="❌"]`).getAttribute('title').then(t => t!.includes('vê isto')), false, 'an agent\'s ❌ carries no such hint')
    await page.screenshot({ path: join(SHOTS, 'dica-da-pilula.png') })

    // ---- 5. the app restarted: what was seen stays quiet; an ask not seen comes back lit ----
    console.log('step 5')
    await ch.store.flush()
    assert.ok(((await openStore(fsIo, home)).get(id)?.seenByUser ?? 0) >= ask, 'seenByUser reached the disk: the record reopened has it')
    await killElectron(app, root)
    ;({ app, page } = await launch(home, pipe))
    await page.waitForFunction(() => typeof window.__tether.ext?.channels?.status === 'function')
    await page.waitForFunction(i => window.__tether.ext.channels.status().rows.some((r: { id: string }) => r.id === i), id)
    await page.waitForTimeout(1500)
    assert.equal((await marks()).asks.length, 0, 'reloading does not relight what she saw')
    assert.equal((await status()).state, 'idle')
    // Her speech must not be in front when the reaction comes (a restored pane may be scrolled to the top, where she would see it).
    await page.evaluate(([i, n]) => window.__tether.ext.channels.open(i!, n), [extra, 'extra'] as const)
    await until('the obra is covered (or not restored)', async () => { const x = await view(); return x === undefined || x.scroll.client === 0 })
    const again = await react(a, hers, 'question')
    await until('a new ❓ lights the icon with no pane open', async () => (await status()).state === 'warn')
    assert.equal((await status()).badge, 1)
    await killElectron(app, root)
    ;({ app, page } = await launch(home, pipe))
    await page.waitForFunction(() => typeof window.__tether.ext?.channels?.status === 'function')
    await until('what she has not seen comes back lit after a restart', async () => (await status()).state === 'warn')
    assert.equal((await marks()).asks[0]?.seq, again)
    await page.screenshot({ path: join(SHOTS, 'icone-apos-reiniciar.png') })
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
