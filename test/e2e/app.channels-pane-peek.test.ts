// E2E of the agent's name in the channel's pane as a way to its guia (slice E3): a tetherd in this process on a private home and pipe,
// two fake `claude` agents (test/fixtures/channels/agent.cjs, no LLM), the real app on the same pipe, hidden window. Nothing touches the
// person's tether.
//   1. the person's name is not clickable (a plain span), the agents' names are buttons;
//   2. right-click on the author of a speech opens the member's menu with "Ir para a guia" [Clique] and "Espiar" [Alt+clique] on top,
//      then the member's rows (capture e3-menu-nome.png);
//   3. Alt+click on the name of a member whose guia is on another desk opens the peek card (and nothing else moves);
//   4. a plain click on a member's name in the column brings that member's tab forward;
//   5. an author that is no longer a member has only "Ir para a guia", "Espiar" and "Copiar link".
// Run alone: node --test test/e2e/app.channels-pane-peek.test.ts   (one E2E at a time: the build is remade)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
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
  peekState(): { open: boolean; slotId?: string; routed: boolean; lent: boolean; pane?: string }
  openNote(path: string): Promise<void>
  ext: { channels: { run(id: string, arg?: unknown): void } }
}
declare const window: { __tether: Hooks }
declare const document: { querySelector(s: string): { clientWidth: number; closest(s: string): { classList: { contains(c: string): boolean }; getAttribute(n: string): string | null } | null } | null }

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

test('channel pane: the agent name goes to the guia, peeks, and has the menu of the member', { timeout: 420_000 }, async () => {
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
    const nameA = ch.nameOf(a)
    const nameB = ch.nameOf(b)

    const made = await ch.create(USER, { name: 'horizontes' })
    assert.ok(made.ok)
    const hz = made.channel.id
    assert.ok((await ch.join(USER, hz, a)).ok)
    assert.ok((await ch.join(USER, hz, b)).ok)
    assert.ok((await ch.say(a, hz, { body: 'fala do A' })).ok)
    assert.ok((await ch.say(b, hz, { body: 'fala do B' })).ok)
    assert.ok((await ch.say(USER, hz, { body: 'fala da pessoa' })).ok)

    let page: Page
    ;({ app, page } = await launch(home, pipe))
    await page.waitForFunction(() => typeof window.__tether.ext?.channels?.run === 'function')
    for (const id of [a, b]) await page.waitForFunction(p => window.__tether.panelIds().includes(p), id)
    const pane = (id: string) => page.locator(`.ch-pane[data-channel="${id}"]`)
    const isActiveTab = (id: string): Promise<boolean> =>
      page.evaluate(id => document.querySelector(`.tether-tab[data-slot="${id}"]`)?.closest('.dv-tab')?.classList.contains('dv-active-tab') === true, id)
    const menuRows = async (): Promise<string[]> => (await page.locator('#ctx-menu li').allInnerTexts()).map(t => t.replace(/\s+/g, ' ').trim()).filter(t => t !== '')

    // b's guia goes to another desk; the channel stays where it is.
    const home1 = await page.evaluate(() => window.__tether.activeDesk())
    const deskB = await page.evaluate(() => window.__tether.createDesk('after'))
    await page.evaluate(([id, desk]) => window.__tether.movePaneToDesk(id, desk), [b, deskB] as const)
    await page.evaluate(id => window.__tether.switchDesk(id), home1)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1900, 760))
    await page.evaluate(id => window.__tether.ext.channels.run('channels.open', { channel: id }), hz)
    await pane(hz).waitFor()
    await page.waitForFunction(id => (document.querySelector(`.ch-pane[data-channel="${id}"]`)?.clientWidth ?? 0) >= 560, hz)
    await pane(hz).locator('.ch-members').waitFor()
    await pane(hz).locator('.ch-msg', { hasText: 'fala do B' }).waitFor()

    // ---- 1. who is clickable ----
    console.log('step 1')
    const person = pane(hz).locator('.ch-msg.mod .ch-author').first()
    assert.equal(await person.evaluate(e => e.tagName), 'SPAN', 'the person is a plain name')
    assert.equal(await pane(hz).locator('.ch-msg.mod .ch-who button.ch-agent').count(), 0)
    const authorA = pane(hz).locator('.ch-msg:not(.mod) .ch-who button.ch-agent', { hasText: nameA }).first()
    const authorB = pane(hz).locator('.ch-msg:not(.mod) .ch-who button.ch-agent', { hasText: nameB }).first()
    assert.equal(await authorA.getAttribute('title'), 'Clique: ir para a guia · Alt+clique ou botão direito: espiar')
    assert.equal(await authorA.evaluate(e => getComputedStyle(e).textDecorationLine), 'none', 'the name does not look like a link')
    assert.equal(await pane(hz).locator(`.ch-mrow[data-member="${a}"] button.ch-agent`).count(), 1, 'the member row name is a button')
    assert.equal(await pane(hz).locator('.ch-sub button.ch-agent').count() <= 1, true)

    // ---- 2. the menu of the name (right click on the author) ----
    console.log('step 2')
    await authorA.click({ button: 'right' })
    await page.waitForSelector('#ctx-menu li')
    assert.deepEqual(await menuRows(), [
      `${nameA} · membro`, 'Ir para a guia Clique', 'Espiar Alt+clique', 'Emblema…', `Falar com ${nameA}`, 'Calar', 'Tirar do canal',
    ])
    await page.screenshot({ path: join(SHOTS, 'e3-menu-nome.png') })
    await page.keyboard.press('Escape')
    await page.waitForSelector('#ctx-menu li', { state: 'detached' })
    // The member's row opens the very same menu from its name.
    await pane(hz).locator(`.ch-mrow[data-member="${a}"] button.ch-agent`).click({ button: 'right' })
    await page.waitForSelector('#ctx-menu li')
    assert.deepEqual((await menuRows()).slice(0, 4), [`${nameA} · membro`, 'Ir para a guia Clique', 'Espiar Alt+clique', 'Emblema…'])
    await page.keyboard.press('Escape')
    await page.waitForSelector('#ctx-menu li', { state: 'detached' })

    // ---- 3. Alt+click on the name of a member whose guia is on another desk: the card ----
    console.log('step 3')
    await pane(hz).locator(`.ch-mrow[data-member="${b}"] button.ch-agent`).click({ modifiers: ['Alt'] })
    await page.waitForSelector('#peek[data-open="true"]')
    // (b has a tab, on another desk: the card is the quick view's card of that tab, not the agent's own.)
    await page.waitForFunction(id => window.__tether.peekState().pane === id, b)
    assert.equal(await page.evaluate(() => window.__tether.activeDesk()), home1, 'the person stays on the desk she was on')
    await page.screenshot({ path: join(SHOTS, 'e3-alt-clique-nome.png') })
    await page.click('#peek .peek-close')
    await page.waitForSelector('#peek', { state: 'hidden' })

    // ---- 4. a plain click on the name in the column brings the member's tab forward ----
    console.log('step 4')
    await pane(hz).locator(`.ch-mrow[data-member="${a}"] button.ch-agent`).click()
    await page.waitForFunction(id => document.querySelector(`.tether-tab[data-slot="${id}"]`)?.closest('.dv-tab')?.classList.contains('dv-active-tab') === true, a)
    assert.equal(await isActiveTab(a), true)
    assert.equal((await page.evaluate(() => window.__tether.peekState())).open, false, 'a plain click opens no card')

    // ---- 4b. Alt+click on the CHANNEL's own tab (a tab of any type), now in the background: the card holds the live channel ----
    console.log('step 4b')
    // The channel sits in a group of its own: a note opened after a click on its tab joins that group and takes the front.
    const chTab = page.locator(`.ch-tab[data-channel="${hz}"]`)
    const chPane = await page.evaluate(id => window.__tether.panelIds().find(p => p.includes(id))!, hz)
    await chTab.click()
    const notePath = join(home, 'canal-espiar.md')
    writeFileSync(notePath, '# Nota\n')
    await page.evaluate(p => window.__tether.openNote(p), notePath)
    await page.waitForFunction(id => document.querySelector(`.ch-tab[data-channel="${id}"]`)?.closest('.dv-tab')?.classList.contains('dv-active-tab') === false, hz)
    await chTab.click({ modifiers: ['Alt'] })
    await page.waitForSelector('#peek[data-open="true"]')
    await page.waitForFunction(id => window.__tether.peekState().pane === id, chPane)
    await page.waitForSelector(`#peek .ch-pane[data-channel="${hz}"]`)
    await page.click('#peek .peek-close')
    await page.waitForSelector('#peek', { state: 'hidden' })
    await page.evaluate(id => window.__tether.ext.channels.run('channels.open', { channel: id }), hz) // the later steps start from the channel in front

    // ---- 5. an author that left the channel keeps the way and the link only ----
    console.log('step 5')
    assert.ok((await ch.remove(USER, hz, b)).ok)
    await page.evaluate(id => window.__tether.ext.channels.run('channels.open', { channel: id }), hz)
    await pane(hz).waitFor()
    await waitUntil(() => !(b in ch.store.get(hz)!.members), 10_000, 'b removed')
    await pane(hz).locator(`.ch-mrow[data-member="${b}"]`).waitFor({ state: 'detached' })
    const oldB = pane(hz).locator('.ch-msg:not(.mod) .ch-who button.ch-agent', { hasText: nameB }).first()
    await oldB.click({ button: 'right' })
    await page.waitForSelector('#ctx-menu li')
    assert.deepEqual(await menuRows(), [nameB, 'Ir para a guia Clique', 'Espiar Alt+clique', 'Emblema…', 'Copiar link'])
    await page.keyboard.press('Escape')

    // ---- 6. "Emblema…" in the name's menu is the tab's own popover: the pick shows on the tab and on the member's row ----
    console.log('step 6')
    const rowChip = pane(hz).locator(`.ch-mrow[data-member="${a}"] .ch-emblem`)
    assert.equal(await rowChip.count(), 0, 'no emblem yet')
    await authorA.click({ button: 'right' })
    await page.waitForSelector('#ctx-menu li')
    await page.locator('#ctx-menu li[role^=menuitem]', { hasText: 'Emblema…' }).click()
    await page.waitForSelector('#ctx-menu.emb-menu')
    await page.screenshot({ path: join(SHOTS, 'emblema-menu-canal.png') })
    await page.locator('#ctx-menu.emb-menu li[role=menuitemradio]', { hasText: 'Cliente' }).click()
    await page.waitForSelector(`.tether-tab[data-slot="${a}"] .emb-chip:not([hidden])`)
    await rowChip.waitFor()
    assert.equal(await rowChip.getAttribute('aria-label'), 'Cliente', 'the member\'s row shows the emblem at once')
    // The same popover, from the "⋯" of the row: back to "Nenhum" clears the row.
    await pane(hz).locator(`.ch-mrow[data-member="${a}"]`).hover()
    await pane(hz).locator(`.ch-mrow[data-member="${a}"] .ch-mmore`).click()
    await page.locator('#ctx-menu li[role^=menuitem]', { hasText: 'Emblema…' }).click()
    assert.equal(await page.locator('#ctx-menu.emb-menu li[aria-checked="true"]').innerText(), 'Cliente')
    await page.locator('#ctx-menu.emb-menu li[role=menuitemradio]', { hasText: 'Nenhum' }).click()
    await rowChip.waitFor({ state: 'detached' })
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
