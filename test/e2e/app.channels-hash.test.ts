// E2E of the "#" autocomplete and the clickable channel reference: a tetherd in this process on a private home and pipe, one fake `claude`
// agent (test/fixtures/channels/agent.cjs, no LLM), the real app on the same pipe, hidden window. Nothing touches the person's tether.
//   1. "#" opens the list of open channels (the current one last, marked "este canal"; a closed channel is not offered);
//   2. the term filters; Enter picks and does NOT send; the line goes out with "#name" and an empty `to`;
//   3. the speech shows "#name" as a button; a click brings the other channel's pane forward; unknown and closed names stay text;
//   4. "@" still works in the same box.
// Run alone: node --test test/e2e/app.channels-hash.test.ts   (one E2E at a time: the build is remade)
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
import { mentionToken } from '../../extensions/channels/renderer/mentions.ts'
import { USER } from '../../extensions/channels/rules.ts'
import { removeHome, tempHome, uniquePipe, waitUntil } from '../unit/daemon.helpers.ts'
import { killElectron } from './electron.ts'

type Mention = { open: boolean; mark: string; rows: Array<{ name: string; mark: string }>; active: number }
type Snap = { composer?: { enabled: boolean; text: string; mention: Mention } }
type Hooks = {
  panelIds(): string[]
  ext: { channels: { run(id: string, arg?: unknown): void; view(id: string): Snap | undefined } }
}
declare const window: { __tether: Hooks }

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

test('channel pane: "#" lists the open channels and a "#name" in a speech opens that channel', { timeout: 420_000 }, async () => {
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
    const id = (await doorApi.slots.create({ kind: 'claude', cwd: home, name: 'conferente', desk: 'desk-1' })).slotId
    await waitUntil(() => doorApi.slots.get(id)?.status === 'running' && doorApi.slots.readScreen(id).data.includes('READY'), 30_000, 'agent running')
    await waitUntil(() => doorApi.delivery.pathOf(id) === 'inside', 30_000, 'agent opened its stream')
    const nameA = ch.nameOf(id)
    const token = mentionToken(nameA, [nameA])

    const made = await ch.create(USER, { name: 'obra' })
    const other = await ch.create(USER, { name: 'conferencia' })
    const old = await ch.create(USER, { name: 'velho' })
    assert.ok(made.ok && other.ok && old.ok)
    const hz = made.channel.id
    const oz = other.channel.id
    for (const c of [hz, oz, old.channel.id]) assert.ok((await ch.join(USER, c, id)).ok)
    assert.ok((await ch.close(USER, old.channel.id)).ok)

    let page: Page
    ;({ app, page } = await launch(home, pipe))
    await page.waitForFunction(() => typeof window.__tether.ext?.channels?.run === 'function')
    await page.waitForFunction(p => window.__tether.panelIds().includes(p), id)
    const open = (c: string): Promise<void> => page.evaluate(([i, x]) => window.__tether.ext.channels.run(i as string, x), ['channels.open', { channel: c }] as const)
    await open(oz)
    await page.locator(`.ch-pane[data-channel="${oz}"]`).waitFor()
    await open(hz)
    const pane = page.locator(`.ch-pane[data-channel="${hz}"]`)
    const otherPane = page.locator(`.ch-pane[data-channel="${oz}"]`)
    const field = pane.locator('.ch-field')
    const list = pane.locator('.ch-mention-list')
    await page.waitForFunction(c => window.__tether.ext.channels.view(c)?.composer?.enabled === true, hz)
    const view = async (): Promise<NonNullable<Snap['composer']>> => (await page.evaluate(i => window.__tether.ext.channels.view(i), hz))!.composer!
    const lines = async () => (await ch.store.history(hz)).filter(l => l.kind === 'message')

    // ---- 1. "#" opens the list of open channels ----
    await field.click()
    await page.keyboard.type('#')
    await list.waitFor({ state: 'visible' })
    let m = (await view()).mention
    assert.equal(m.open, true)
    assert.equal(m.mark, '#')
    assert.deepEqual(m.rows, [{ name: '#conferencia', mark: '' }, { name: '#obra', mark: 'este canal' }], 'open channels only, the current one last')
    assert.equal(await list.getAttribute('role'), 'listbox')
    assert.equal(await list.getAttribute('aria-label'), 'Canais abertos')
    assert.equal(await field.getAttribute('aria-activedescendant'), await list.locator('[role="option"]').first().getAttribute('id'))
    await pane.screenshot({ path: join(SHOTS, 'hash-lista.png') })

    // ---- 2. filter; Enter picks and does not send; the line carries "#name" and no recipient ----
    await page.keyboard.type('CONFER')
    await page.waitForFunction(c => window.__tether.ext.channels.view(c)?.composer?.mention.rows.length === 1, hz)
    await page.keyboard.press('Enter')
    await list.waitFor({ state: 'hidden' })
    assert.equal((await view()).text, '#conferencia ')
    assert.equal((await lines()).length, 0, 'Enter with the list open picks; it does not send')
    await page.keyboard.type('continua la, ver #nada e #velho')
    await page.keyboard.press('Enter')
    await page.waitForFunction(c => window.__tether.ext.channels.view(c)?.composer?.text === '', hz)
    const sent = await lines()
    assert.equal(sent.length, 1)
    assert.equal(sent[0]!.body, '#conferencia continua la, ver #nada e #velho', 'agents get the plain text with the #name')
    assert.deepEqual(sent[0]!.to ?? [], [], '"#" does not touch the recipients')

    // ---- 3. the reference is a button; unknown and closed names stay text; a click brings the other pane forward ----
    const refs = pane.locator('.ch-msgs .ch-chanref')
    await refs.first().waitFor()
    assert.equal(await refs.count(), 1, 'only the open, known channel is a reference')
    assert.equal(await refs.first().innerText(), '#conferencia')
    assert.equal(await refs.first().evaluate(e => e.tagName), 'BUTTON')
    assert.equal(await refs.first().getAttribute('type'), 'button')
    assert.equal(await refs.first().evaluate(e => getComputedStyle(e).cursor), 'pointer')
    assert.equal(await refs.first().evaluate(e => getComputedStyle(e).textDecorationLine), 'none')
    assert.equal(await otherPane.isVisible(), false, 'the other channel is behind')
    await refs.first().focus()
    await page.keyboard.press('Enter')
    await otherPane.waitFor({ state: 'visible' })
    assert.equal(await pane.isVisible(), false, 'the other channel came forward')

    // ---- 4. "@" still works in the same box ----
    await open(hz)
    await pane.waitFor({ state: 'visible' })
    await field.click()
    await page.keyboard.type('@confer')
    await page.waitForFunction(c => window.__tether.ext.channels.view(c)?.composer?.mention.mark === '@', hz)
    await page.keyboard.press('Enter')
    await list.waitFor({ state: 'hidden' })
    assert.equal((await view()).text, `@${token} `)
    await page.keyboard.type('oi')
    await page.keyboard.press('Enter')
    await page.waitForFunction(c => window.__tether.ext.channels.view(c)?.composer?.text === '', hz)
    const all = await lines()
    assert.deepEqual(all[1]!.to, [nameA], 'the mention still addresses the member')
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
