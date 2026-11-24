// E2E of the "@" autocomplete in the channel's speaking box: a tetherd in this process on a private home and pipe, three fake `claude`
// agents (test/fixtures/channels/agent.cjs, no LLM; one muted, one that does not hear now), the real app on the same pipe, hidden window.
// Nothing touches the person's tether.
//   1. "@" opens the list (todos first, then the members, with the discreet mark of the muted and of the one that does not hear);
//   2. the term filters; Enter picks and does NOT send; the text gets "@name " and the line goes out with the member in `to`;
//   3. arrows and the aria-activedescendant; a click picks; Esc closes only the list (it does not reach the page) and keeps the text;
//   4. erasing the mention before sending takes the recipient away; "@todos" addresses nobody; the speech shows the mention highlighted.
// Run alone: node --test test/e2e/app.channels-mention.test.ts   (one E2E at a time: the build is remade)
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

type Mention = { open: boolean; rows: Array<{ name: string; mark: string }>; active: number }
type Snap = { composer?: { enabled: boolean; text: string; mention: Mention } }
type Hooks = {
  panelIds(): string[]
  ext: { channels: { run(id: string, arg?: unknown): void; view(id: string): Snap | undefined } }
}
declare const window: { __tether: Hooks; escapes?: number; addEventListener(type: 'keydown', fn: (e: { key: string }) => void): void }

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

test('channel pane: "@" in the speaking box opens the members list and addresses the line', { timeout: 420_000 }, async () => {
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
      // "surdo" never opens the stream: the person's pane holds it, so the member is on the `wait` route ("não ouve agora").
      env.OPEN_STREAM = input.slot.name === 'surdo' ? '0' : '1'
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
      if (name !== 'surdo') await waitUntil(() => doorApi.delivery.pathOf(id) === 'inside', 30_000, `${name} opened its stream`)
      return id
    }
    const a = await running('conferente')
    const b = await running('bancada')
    const s = await running('surdo')
    const nameA = ch.nameOf(a)
    const nameB = ch.nameOf(b)
    const nameS = ch.nameOf(s)
    // What the list inserts for the first member: the segment of its name that is its alone.
    const token = mentionToken(nameA, [nameA, nameB, nameS])

    const made = await ch.create(USER, { name: 'mencao' })
    assert.ok(made.ok)
    const hz = made.channel.id
    for (const id of [a, b, s]) assert.ok((await ch.join(USER, hz, id)).ok)
    assert.ok((await ch.mute(USER, hz, b)).ok)

    let page: Page
    ;({ app, page } = await launch(home, pipe))
    await page.waitForFunction(() => typeof window.__tether.ext?.channels?.run === 'function')
    for (const id of [a, b, s]) await page.waitForFunction(p => window.__tether.panelIds().includes(p), id)
    await page.evaluate(([i, x]) => window.__tether.ext.channels.run(i as string, x), ['channels.open', { channel: hz }] as const)
    const pane = page.locator(`.ch-pane[data-channel="${hz}"]`)
    const field = pane.locator('.ch-field')
    const list = pane.locator('.ch-mention-list')
    await page.waitForFunction(id => window.__tether.ext.channels.view(id)?.composer?.enabled === true, hz)
    const view = async (): Promise<NonNullable<Snap['composer']>> => (await page.evaluate(i => window.__tether.ext.channels.view(i), hz))!.composer!
    const lines = async () => (await ch.store.history(hz)).filter(l => l.kind === 'message')
    // Counts the Escapes that reach the page (a bubble listener on the window): the list must keep its own.
    await page.evaluate(() => { window.escapes = 0; window.addEventListener('keydown', e => { if (e.key === 'Escape') window.escapes = (window.escapes ?? 0) + 1 }) })

    // ---- 1. "@" opens the list: todos first, then the members; the discreet marks ----
    await field.click()
    await page.keyboard.type('@')
    await list.waitFor({ state: 'visible' })
    let m = (await view()).mention
    assert.equal(m.open, true)
    assert.equal(m.rows[0]!.name, 'todos')
    assert.deepEqual(m.rows.slice(1).map(r => r.name).sort(), [nameA, nameB, nameS].sort())
    assert.equal(m.rows.find(r => r.name === nameB)!.mark, 'calado')
    assert.equal(m.rows.find(r => r.name === nameS)!.mark, 'não ouve agora')
    assert.equal(m.rows.find(r => r.name === nameA)!.mark, '')
    assert.equal(await list.getAttribute('role'), 'listbox')
    assert.equal(await list.locator('[role="option"]').count(), 4)
    const activeId = await field.getAttribute('aria-activedescendant')
    assert.equal(activeId, await list.locator('[role="option"]').first().getAttribute('id'))
    assert.equal(await field.getAttribute('aria-controls'), await list.getAttribute('id'))
    // The list floats over the box, above the caret, inside the pane.
    const lb = (await list.boundingBox())!
    const fb = (await field.boundingBox())!
    assert.ok(lb.y + lb.height <= fb.y + fb.height, 'above the end of the field')
    await pane.screenshot({ path: join(SHOTS, 'mencao-lista.png') })

    // ---- 2. filter, Enter picks and does not send ----
    await page.keyboard.type('confer')
    await page.waitForFunction(id => window.__tether.ext.channels.view(id)?.composer?.mention.rows.length === 1, hz)
    m = (await view()).mention
    assert.deepEqual(m.rows.map(r => r.name), [nameA])
    await page.keyboard.press('Enter')
    await list.waitFor({ state: 'hidden' })
    assert.equal((await view()).text, `@${token} `)
    assert.equal((await lines()).length, 0, 'Enter with the list open picks; it does not send')
    await page.keyboard.type('pode subir?')
    await page.keyboard.press('Enter')
    await page.waitForFunction(id => window.__tether.ext.channels.view(id)?.composer?.text === '', hz)
    const sent = await lines()
    assert.equal(sent.length, 1)
    assert.equal(sent[0]!.body, `@${token} pode subir?`)
    assert.deepEqual(sent[0]!.to, [nameA], 'the mention became the recipient')
    // The mention is highlighted in the speech, as text of the app (no link).
    const mention = pane.locator('.ch-msgs .ch-mention')
    await mention.first().waitFor()
    assert.equal(await mention.first().innerText(), `@${token}`)
    assert.equal(await mention.first().evaluate(e => e.tagName), 'SPAN')

    // ---- 3. arrows, click, Esc ----
    await page.keyboard.type('@')
    await list.waitFor({ state: 'visible' })
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    m = (await view()).mention
    assert.equal(m.active, 2)
    assert.equal(await field.getAttribute('aria-activedescendant'), await list.locator('[role="option"]').nth(2).getAttribute('id'))
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('ArrowUp')
    assert.equal((await view()).mention.active, 3, 'the list wraps')
    // Esc closes the list only: the text stays and the page never sees the key.
    const before = await page.evaluate(() => window.escapes)
    await page.keyboard.press('Escape')
    await list.waitFor({ state: 'hidden' })
    assert.equal((await view()).text, '@')
    assert.equal(await page.evaluate(() => window.escapes), before, 'Esc with the list open does not propagate')
    // Another Esc, with no list, is the page's again.
    await page.keyboard.press('Escape')
    assert.equal(await page.evaluate(() => window.escapes), (before ?? 0) + 1)
    // Typing on in the same mention does not reopen what was dismissed; a new "@" does.
    await page.keyboard.type('b')
    assert.equal(await list.isHidden(), true)
    await page.keyboard.press('Backspace')
    await page.keyboard.press('Backspace')
    await page.keyboard.type('@')
    await list.waitFor({ state: 'visible' })
    // No match: the list goes away.
    await page.keyboard.type('zzz')
    await list.waitFor({ state: 'hidden' })
    for (let i = 0; i < 3; i++) await page.keyboard.press('Backspace')
    await list.waitFor({ state: 'visible' })
    // A click on a row picks it.
    await list.locator('[role="option"]', { hasText: 'todos' }).click()
    await list.waitFor({ state: 'hidden' })
    assert.equal((await view()).text, '@todos ')

    // ---- 4. "@todos" addresses nobody; erasing a mention takes the recipient away ----
    await page.keyboard.type('oi')
    await page.keyboard.press('Enter')
    await page.waitForFunction(id => window.__tether.ext.channels.view(id)?.composer?.text === '', hz)
    assert.deepEqual((await lines())[1]!.to ?? [], [])
    await field.fill(`@${token} ola`)
    await field.fill('ola')
    await page.keyboard.press('Enter')
    await page.waitForFunction(id => window.__tether.ext.channels.view(id)?.composer?.text === '', hz)
    assert.deepEqual((await lines())[2]!.to ?? [], [], 'a mention erased before sending is not a recipient')
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
