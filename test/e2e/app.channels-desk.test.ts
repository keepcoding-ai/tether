// E2E of the desk's channel on the screen (slice F2): a tetherd in this process on a private home and pipe with the real for-agents
// and channels daemon sides on one extension host (no one lists the other), fake `claude` agents (test/fixtures/channels/agent.cjs, no
// LLM) and a shell guia; the real app on the same pipe, hidden window. Nothing touches the person's tether.
// The desk is given by the real gesture (the pill menu, "Dar a mesa a um agente…"), never by `ch.desk.open`:
//   1. before the gift there is no desk channel; after it the channel is featured in the picker and "Abrir o canal da mesa" is in the pill menu;
//   2. its pane: the owner as owner, the agent guias of the desk as members, the shell guia is not one;
//   3. an agent guia that enters the desk becomes a member, one that leaves stops being one;
//   4. the desk's channel is never closed or reopened by hand (the tab menu has neither);
//   5. revoking the desk closes the channel (readable, no speaking box); giving it again reopens the same history.
// Run alone: node --test test/e2e/app.channels-desk.test.ts   (one E2E at a time: the build is remade)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { DisposableStore } from '../../app/shared/vscode-lifecycle.ts'
import { manifest as forAgents, EXT_ID as FOR_AGENTS_ID } from '../../extensions/for-agents/manifest.ts'
import { wire } from '../../extensions/for-agents/daemon.ts'
import * as channels from '../../extensions/channels/daemon.ts'
import type { ExtensionEntry } from '../../extensions/types.ts'
import '../../src/agents/load.ts'
import { agentRegistry, type AgentContribution } from '../../src/agents/registry.ts'
import type { AgentAdapter, LaunchPlan } from '../../src/agents/types.ts'
import type { Profile } from '../../src/core/profile.ts'
import { writeProfiles } from '../../src/core/profile-sync.ts'
import { DoorHost } from '../../src/daemon/door/host.ts'
import { DaemonExtensionHost } from '../../src/daemon/ext-host.ts'
import type { TetherDaemon } from '../../src/daemon/ext-api.ts'
import { startDaemon } from '../../src/daemon/server.ts'
import { removeHome, tempHome, uniquePipe, waitUntil } from '../unit/daemon.helpers.ts'
import { killElectron } from './electron.ts'

interface Snap { loaded: boolean; closed: boolean; title: string; members: { name: string; role: string }[]; hasComposerSlot: boolean; composer?: unknown }
type Hooks = {
  panelIds(): string[]
  activeDesk(): string
  switchDesk(id: string): void
  deskOf(id: string): string | undefined
  openMove(id: string): void
  ext: { channels: { run(id: string, arg?: unknown): void; view(channelId: string): Snap | undefined } }
}
declare const window: { __tether: Hooks }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const AGENT = fileURLToPath(new URL('../fixtures/channels/agent.cjs', import.meta.url))
const SHOTS = 'C:/atrium/.tmp/tether-agents/onda-3/f2'

async function launch(home: string, pipe: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_') && !k.toUpperCase().startsWith('CLAUDE')) env[k] = v
  env.TETHER_PIPE = pipe
  env.TETHER_HOME = home
  env.TETHER_E2E_HIDDEN = '1'
  env.TETHER_TEST_EXTENSIONS = '1'
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  page.on('pageerror', e => console.error(`renderer error: ${e.stack}`))
  page.on('console', m => { if (m.type() === 'error') console.error(`renderer ${m.type()}: ${m.text()}`) })
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  return { app, page }
}

test('desk channel on the screen: given by the gesture, followed by the desk, closed by the revoke', { timeout: 420_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit', env: { ...process.env, TETHER_TEST_EXTENSIONS: '1' } })
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
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^CLAUDE/i.test(k)) env[k] = v
      delete env.NODE_TEST_CONTEXT
      env.ECHO_LOG = join(home, `echo-${input.slot.slotId}.log`)
      env.CHAN_LOG = join(home, `chan-${input.slot.slotId}.log`)
      return { command: process.execPath, args: [AGENT], cwd: input.slot.cwd, env }
    },
    sessionExists: async () => 'unknown',
    title: async b => b.title,
  }
  const contribution = agentRegistry.get('claude')! as { channels?: AgentContribution['channels'] }
  const savedChannels = contribution.channels
  contribution.channels = () => []

  const profiles: Profile[] = [{ id: 'claude', name: 'claude', agent: 'claude', args: [], default: true }]
  writeProfiles(home, profiles)
  const entries: ExtensionEntry<TetherDaemon>[] = [
    { manifest: forAgents, activate: api => wire(api).disposables },
    { manifest: channels.manifest, activate: api => channels.activate(api) },
  ]
  const host = new DaemonExtensionHost({ home, log: m => logs.push(m), door, extensions: entries, profileStore: { profiles: () => profiles } })
  host.activate()
  const daemon = await startDaemon({
    home, pipe, memoryIntervalMs: 0, readyFallbackMs: 300, minAgentAgeMs: 0, adapters: { claude: fake }, channelOf: () => undefined, door,
    transformPlan: host.transformPlan, onSlot: host.emitSlot, log: m => logs.push(m),
  })
  await door.releaseInactive(host.activated)
  host.emitStarted()
  const api = door.apiFor(FOR_AGENTS_ID, own)

  let app: ElectronApplication | undefined
  try {
    const agent = async (name: string): Promise<string> => {
      const id = (await api.slots.create({ kind: 'claude', cwd: home, name, desk: 'desk-1' })).slotId
      await waitUntil(() => api.slots.get(id)?.status === 'running' && api.slots.readScreen(id).data.includes('READY'), 30_000, `${name} running`)
      return id
    }
    const owner = await agent('dona')
    const b = await agent('conferente')
    const c = await agent('bancada')
    const sh = (await api.slots.create({ kind: 'shell', cwd: home, name: 'prompt', desk: 'desk-1' })).slotId

    let page: Page
    ;({ app, page } = await launch(home, pipe))
    page.on('pageerror', () => {})
    await page.waitForFunction(() => typeof window.__tether.ext?.channels?.run === 'function')
    for (const id of [owner, b, c, sh]) await page.waitForFunction(p => window.__tether.panelIds().includes(p), id)
    await waitUntil(() => (api.desks.map()?.desks.length ?? 0) >= 1, 20_000, 'desk map')
    const run = (id: string, arg?: unknown): Promise<void> => page.evaluate(([i, x]) => window.__tether.ext.channels.run(i as string, x), [id, arg] as const)
    const picker = page.locator('dialog.picker[open]')
    const menuLabels = (): Promise<string[]> => page.locator('#ctx-menu li').allInnerTexts().then(ts => ts.map(t => t.trim()))
    const closeMenu = async (): Promise<void> => { await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.getElementById('ctx-menu')) }
    const pill = async (): Promise<string[]> => {
      await page.click('#desk-switch .seg[data-desk="desk-1"]', { button: 'right' })
      await page.waitForSelector('#ctx-menu li')
      return menuLabels()
    }
    const view = (id: string): Promise<Snap | undefined> => page.evaluate(i => window.__tether.ext.channels.view(i), id)
    const poll = async (fn: () => Promise<boolean>, ms: number, what: string): Promise<void> => {
      const end = Date.now() + ms
      while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 200)) }
      assert.fail(`timeout: ${what}`)
    }
    const names = (s: Snap | undefined): string => (s?.members ?? []).map(m => `${m.name}:${m.role}`).join(' | ')

    // ---- 1. before the gift: no channel, no row ----
    console.log('step 1')
    await run('channels.open')
    await picker.waitFor()
    assert.equal(await page.locator('dialog.picker li.pk-item').count(), 0, 'no channel before the desk has an owner')
    await page.keyboard.press('Escape')
    await picker.waitFor({ state: 'detached' })
    assert.ok(!(await pill()).some(l => l.startsWith('Abrir o canal da mesa')), 'no row before the gift')
    await closeMenu()

    // The gift, by the real gesture.
    const give = async (): Promise<void> => {
      await page.click('#desk-switch .seg[data-desk="desk-1"]', { button: 'right' })
      await page.waitForSelector('#ctx-menu li')
      await page.locator('#ctx-menu > li', { hasText: /^\s*Dar a mesa a um agente…\s*$/ }).click()
      await page.locator('dialog.picker input').waitFor({ state: 'visible' })
      await page.locator('dialog.picker li.pk-item').filter({ has: page.locator('.pk-label', { hasText: /^dona$/ }) }).click()
      await page.locator('dialog.ask[data-dialog="for-agents.give-desk"]').waitFor()
      await page.locator('dialog.ask[data-dialog="for-agents.give-desk"] button.choice[data-choice="give"]').click()
    }
    await give()
    await waitUntil(() => api.objects.get('desk', 'desk-1', 'owner') !== undefined, 20_000, 'the desk owner written')

    // ---- 2. the channel is there: featured in the picker, in the pill menu ----
    console.log('step 2')
    await poll(async () => { await run('channels.open'); await picker.waitFor(); const n = await page.locator('dialog.picker li.pk-item').count(); await page.keyboard.press('Escape'); await picker.waitFor({ state: 'detached' }); return n > 0 }, 30_000, 'the desk channel offered')
    await run('channels.open')
    await picker.waitFor()
    const texts = await page.locator('dialog.picker li.pk-item').allInnerTexts()
    assert.equal(texts.length, 1, texts.join(' | '))
    assert.match(texts[0]!, /canal da mesa · \d+ membros? · dono: dona/, 'featured, with its owner')
    assert.equal(await page.locator('dialog.picker li.pk-item.selected').count(), 1)
    const label = await page.locator('dialog.picker li.pk-item .pk-label').first().innerText()
    const slug = label.trim().replace(/^#/, '')
    await page.keyboard.press('Escape')
    await picker.waitFor({ state: 'detached' })
    const labels = await pill()
    const row = labels.find(l => l.startsWith('Abrir o canal da mesa'))
    assert.ok(row, `the pill menu: ${labels.join(' | ')}`)
    await page.locator('#ctx-menu li', { hasText: 'Abrir o canal da mesa' }).click()
    const paneOf = async (): Promise<string> => {
      await page.waitForFunction(() => window.__tether.panelIds().some(p => p.startsWith('channel:')))
      return (await page.evaluate(() => window.__tether.panelIds().find(p => p.startsWith('channel:'))))!
    }
    const pane = await paneOf()
    const chId = pane.slice('channel:'.length)

    // ---- 3. its members: the owner as owner, the agent guias of the desk, never the shell ----
    console.log('step 3')
    const until = async (what: string, ok: (s: Snap) => boolean): Promise<Snap> => {
      let last: Snap | undefined
      await poll(async () => { last = await view(chId); return !!last && last.loaded && ok(last) }, 20_000, `${what}`)
      void last
      return last!
    }
    let s = await until('members of the desk', x => x.members.length >= 3)
    assert.match(names(s), /dona:dono/, names(s))
    assert.match(names(s), /conferente:( \||$)/, names(s))
    assert.match(names(s), /bancada:( \||$)/, names(s))
    assert.ok(!/prompt/.test(names(s)), `the shell guia is not a member: ${names(s)}`)
    assert.equal(s.members.length, 3, names(s))
    assert.equal(s.closed, false)
    await page.screenshot({ path: join(SHOTS, 'canal-da-mesa.png') })

    // ---- 4. an agent guia that enters the desk becomes a member, one that leaves stops being one ----
    console.log('step 4')
    const d = await agent('entrante')
    await page.waitForFunction(p => window.__tether.panelIds().includes(p), d)
    s = await until('entrante joined', x => /entrante:( \||$)/.test(names(x)))
    assert.equal(s.members.length, 4)
    await page.keyboard.press('Control+Shift+N')
    await page.waitForFunction(() => window.__tether.activeDesk() === 'desk-2')
    await page.evaluate(() => window.__tether.switchDesk('desk-1'))
    await page.waitForFunction(() => window.__tether.activeDesk() === 'desk-1')
    await page.evaluate(p => window.__tether.openMove(p), d)
    await page.waitForSelector('dialog.move[open]')
    await page.click('dialog.move .mv-row.f[data-scope="desk-2"]')
    await page.hover('dialog.move .mv-pn .z-right')
    await page.waitForSelector('dialog.move .mv-pn[data-pv="right"]')
    await page.click('dialog.move .mv-pn .z-right')
    await page.click('#mv-go')
    await page.waitForFunction(p => window.__tether.deskOf(p) === 'desk-2', d)
    s = await until('entrante left', x => !/entrante/.test(names(x)))
    assert.equal(s.members.length, 3, names(s))

    // ---- 5. the desk's channel is never closed or reopened by hand ----
    console.log('step 5')
    await page.locator('.ch-tab', { hasText: `#${slug}` }).first().click({ button: 'right' })
    await page.waitForSelector('#ctx-menu li')
    assert.ok(!(await menuLabels()).some(l => l.startsWith('Encerrar canal') || l.startsWith('Reabrir canal')), (await menuLabels()).join(' | '))
    await closeMenu()

    // ---- 6. revoke: the channel closes, readable, no speaking box; giving again reopens the same history ----
    console.log('step 6')
    const before = await view(chId)
    await page.click('#desk-switch .seg[data-desk="desk-1"]', { button: 'right' })
    await page.waitForSelector('#ctx-menu li')
    await page.locator('#ctx-menu > li', { hasText: /^\s*Tirar a mesa de .+…\s*$/ }).click()
    await page.locator('dialog.ask[data-dialog="for-agents.revoke-desk"]').waitFor()
    await page.locator('dialog.ask[data-dialog="for-agents.revoke-desk"] button.choice[data-choice="revoke"]').click()
    s = await until('closed by the revoke', x => x.closed)
    assert.equal(s.composer, undefined, 'a closed channel has no speaking box')
    await page.screenshot({ path: join(SHOTS, 'canal-da-mesa-encerrado.png') })
    assert.ok(s.members.length > 0, 'still readable: the members stay on the record')
    await page.locator('.ch-tab', { hasText: `#${slug}` }).first().click({ button: 'right' })
    await page.waitForSelector('#ctx-menu li')
    assert.ok(!(await menuLabels()).some(l => l.startsWith('Reabrir canal')), 'no hand reopen for the desk channel')
    await closeMenu()

    await give()
    s = await until('reopened by the new gift', x => !x.closed)
    assert.equal(await page.evaluate(() => window.__tether.panelIds().filter(p => p.startsWith('channel:')).length), 1, 'the same channel, one pane')
    assert.equal((await view(chId))!.title, before!.title)
    assert.match(names(s), /dona:dono/, names(s))
    await page.screenshot({ path: join(SHOTS, 'canal-da-mesa-reaberto.png') })
  } finally {
    contribution.channels = savedChannels
    if (app) await killElectron(app, root).catch(() => {})
    own.dispose()
    host.dispose?.()
    await door.delivery.flush().catch(() => {})
    door.delivery.dispose()
    await daemon.close()
    await door.mcp.close()
    await removeHome(home)
  }
})
