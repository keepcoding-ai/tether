// E2E of where the keyboard goes back to when the peek card closes, from the channel's pane (slice E4): a tetherd in this process on a
// private home and pipe, two fake `claude` agents (test/fixtures/channels/agent.cjs, no LLM), the real app on the same pipe, hidden
// window. Nothing touches the person's tether.
//   1. the keyboard was in the channel's speech box when the card opened (a peek asked from outside the box: the hook): the chord
//      Ctrl+Shift+O closes the card and the speech box has the keyboard again;
//   2. a member's name menu (right click), its "Espiar" row picked by keys: the card opens over the pane, and on close the keyboard is
//      back inside the channel's pane (where the menu was opened from), not lost on the body.
// Run alone: node --test test/e2e/app.peek-keys-channel.test.ts   (one E2E at a time: the build is remade)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
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
import { USER } from '../../extensions/channels/rules.ts'
import { removeHome, tempHome, uniquePipe, waitUntil } from '../unit/daemon.helpers.ts'
import { killElectron } from './electron.ts'

type Hooks = {
  panelIds(): string[]
  activeDesk(): string
  createDesk(side: 'before' | 'after', relativeTo?: string): string
  switchDesk(id: string): void
  movePaneToDesk(slotId: string, deskId: string): void
  peek(slotId: string): void
  peekState(): { open: boolean; slotId?: string; routed: boolean; lent: boolean }
  ext: { channels: { run(id: string, arg?: unknown): void } }
}
declare const window: { __tether: Hooks }
declare const document: { activeElement: { className: string; closest(s: string): { getAttribute(n: string): string | null } | null } | null }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const AGENT = fileURLToPath(new URL('../fixtures/channels/agent.cjs', import.meta.url))

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

test('cartão de espiar: o foco volta à caixa de fala do canal e a quem abriu o menu', { timeout: 420_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
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
    const made = await ch.create(USER, { name: 'horizontes' })
    assert.ok(made.ok)
    const hz = made.channel.id
    assert.ok((await ch.join(USER, hz, a)).ok)
    assert.ok((await ch.join(USER, hz, b)).ok)
    assert.ok((await ch.say(b, hz, { body: 'fala do B' })).ok)

    let page: Page
    ;({ app, page } = await launch(home, pipe))
    await page.waitForFunction(() => typeof window.__tether.ext?.channels?.run === 'function')
    for (const id of [a, b]) await page.waitForFunction(p => window.__tether.panelIds().includes(p), id)
    const pane = (id: string) => page.locator(`.ch-pane[data-channel="${id}"]`)
    const waitPeek = (id: string): Promise<unknown> => page.waitForFunction(s => { const p = window.__tether.peekState(); return p.open && p.slotId === s }, id)
    const waitClosed = (): Promise<unknown> => page.waitForSelector('#peek', { state: 'hidden' })

    // b's guia goes to another desk (so peeking at it opens the card); the channel stays where it is.
    const home1 = await page.evaluate(() => window.__tether.activeDesk())
    const deskB = await page.evaluate(() => window.__tether.createDesk('after'))
    await page.evaluate(([id, desk]) => window.__tether.movePaneToDesk(id, desk), [b, deskB] as const)
    await page.evaluate(id => window.__tether.switchDesk(id), home1)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1900, 760))
    await page.evaluate(id => window.__tether.ext.channels.run('channels.open', { channel: id }), hz)
    await pane(hz).waitFor()
    await pane(hz).locator('.ch-msg', { hasText: 'fala do B' }).waitFor()
    const field = pane(hz).locator('.ch-field')
    const inField = (): Promise<boolean> => page.evaluate(() => document.activeElement?.className === 'ch-field')
    const inPane = (): Promise<boolean> => page.evaluate(() => !!document.activeElement?.closest('.ch-pane'))

    // ---- 1. the speech box ----
    console.log('step 1')
    await field.focus()
    assert.equal(await inField(), true)
    await page.evaluate(id => window.__tether.peek(id), b)
    await waitPeek(b)
    assert.equal(await inField(), false, 'the keyboard went into the card')
    await page.keyboard.press('Control+Shift+O')
    await waitClosed()
    assert.equal(await inField(), true, 'the keyboard is back in the speech box')

    // ---- 2. a context menu item ----
    console.log('step 2')
    await pane(hz).locator(`.ch-mrow[data-member="${b}"] button.ch-agent`).click({ button: 'right' })
    await page.waitForSelector('#ctx-menu li')
    await page.locator('#ctx-menu li[role^=menuitem]', { hasText: /^\s*Espiar/ }).first().focus()
    await page.keyboard.press('Enter')
    await waitPeek(b)
    await page.keyboard.press('Control+Shift+O')
    await waitClosed()
    assert.equal(await inPane(), true, 'the keyboard is back in the channel\'s pane, where the menu was opened from')
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
