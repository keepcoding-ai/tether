// E2E of the Regency desk (slice R1e-1, desktop): a tetherd in this process on a private home and pipe, with the channels
// extension's record and requests on its door and two fake `claude` agents (test/fixtures/channels/agent.cjs, no LLM); the real
// app on the same pipe, hidden window at 1500 px. Nothing touches the person's tether.
//   0. empty: no channel, nobody waiting ("Ninguém espera você"), the centre says how to start (screenshot r1-vazio);
//   1. the pill "Regência" comes after Browser; "Ir para Regência" goes in and back;
//   2. the desk has one pane, regency:main; closed, it comes back; its layout survives restarting the app (layout.json);
//   3. a channel chosen in the centre: a line comes, the box speaks, and the same channel opened as a tab on another desk does not collide;
//   4. a line to the person shows in "Esperam você"; a click there puts that channel in the centre and, read, it goes;
//   5. an agent with attention `waiting` shows in "Esperam você" and in the tree with its state;
//   6. the tree lists the queue desks, Browser and the drawer with the panes, names and identity; a folded desk hides its panes;
//   7. "Neste canal" starts folded, faces only; open, the channel's members' column;
//   8. immersion (Ctrl+Shift+\, the switch, the palette): the side columns become thin edges, the left keeps the count; a click on an edge goes back;
//   9. the phone (pane under 768 px): "Chama você", "Conversa", "Tether" at the bottom, one at a time, 44 px; it opens on "Chama você"
//      when someone waits; choosing a conversation goes to it; the box sits above the bar; the place is kept;
//  10. nothing comes forward: no desk switch, no focus change by an event (checked at each event above).
// Run alone: node --test --test-force-exit --test-concurrency=1 test/e2e/app.regency.test.ts   (one E2E at a time: the build is remade)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync } from 'node:fs'
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
import { USER } from '../../extensions/channels/rules.ts'
import type { PaneSnapshot } from '../../extensions/channels/renderer/channel-pane.ts'
import type { RegencyModel } from '../../extensions/regency/model.ts'
import type { RegencyLayout } from '../../extensions/regency/renderer/layout-rules.ts'
import { removeHome, tempHome, uniquePipe, waitUntil } from '../unit/daemon.helpers.ts'
import { killElectron } from './electron.ts'

type Hooks = {
  panelIds(): string[]
  activeId(): string | undefined
  currentPane(): string | undefined
  activeDesk(): string
  deskOf(slotId: string): string | undefined
  switchDesk(id: string): void
  createDesk(side: 'before' | 'after', relativeTo?: string): string
  movePaneToDesk(slotId: string, deskId: string): void
  systemDesks(): { id: string; name: string; panes: string[]; active: boolean }[]
  commands(): { id: string; title: string }[]
  runCommand(id: string): Promise<string>
  ext: {
    channels: {
      open(channelId: string, name?: string): void
      view(channelId: string): PaneSnapshot | undefined
      embedView(channelId: string): PaneSnapshot | undefined
    }
    regency: {
      model(): RegencyModel
      layout(): RegencyLayout | undefined
      select(channelId: string): void
      close(): void
      mode(): string | undefined
      tier(): string | undefined
    }
  }
}
declare const window: { __tether: Hooks }
type El = { textContent: string | null; getAttribute(n: string): string | null; previousElementSibling: El | null }
declare const document: { querySelector(s: string): El | null; activeElement: El | null }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const AGENT = fileURLToPath(new URL('../fixtures/channels/agent.cjs', import.meta.url))
const SHOTS = 'C:/atrium/.tmp/tether-agents/onda-3/mesa-regencia/capturas'
const DESK = 'regency.main'
const PANE = 'regency:main'

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
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.error(`renderer ${m.type()}: ${m.text()}`) })
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(1500, 900) })
  await page.waitForFunction(() => typeof window.__tether.ext?.regency?.model === 'function')
  return { app, page }
}

test('regency: the desk, its three columns, its layout kept', { timeout: 480_000 }, async () => {
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

    let page: Page
    ;({ app, page } = await launch(home, pipe))
    for (const id of [a, b]) await page.waitForFunction(p => window.__tether.panelIds().includes(p), id)
    const model = (): Promise<RegencyModel> => page.evaluate(() => window.__tether.ext.regency.model())
    const layout = (): Promise<RegencyLayout | undefined> => page.evaluate(() => window.__tether.ext.regency.layout())
    const embed = (id: string): Promise<PaneSnapshot | undefined> => page.evaluate(i => window.__tether.ext.channels.embedView(i), id)
    const state = (): Promise<{ desk: string; active: string | undefined; current: string | undefined }> =>
      page.evaluate(() => ({ desk: window.__tether.activeDesk(), active: window.__tether.activeId(), current: window.__tether.currentPane() }))
    const until = async (what: string, fn: () => Promise<boolean>, ms = 15_000): Promise<void> => {
      const end = Date.now() + ms
      while (Date.now() < end) { if (await fn()) return; await page.waitForTimeout(100) }
      throw new Error(`timeout: ${what}`)
    }
    const enter = async (): Promise<void> => {
      if ((await page.evaluate(() => window.__tether.activeDesk())) !== DESK) await page.evaluate(d => window.__tether.runCommand(`desk.system.${d}`), DESK)
      await page.waitForFunction(d => window.__tether.activeDesk() === d, DESK)
      await page.waitForFunction(p => window.__tether.panelIds().includes(p), PANE)
    }
    const queueDesk = await page.evaluate(() => window.__tether.activeDesk())

    // ---- 0. empty: no channel, nobody waits ----
    console.log('step 0')
    await enter()
    await page.waitForSelector('.rg .rg-void:not([hidden])')
    await until('the conversations came (empty)', async () => (await page.locator('.rg-convs .rg-empty').textContent()) === 'Nenhuma conversa aberta')
    assert.equal(await page.locator('.rg-waiting .rg-empty').textContent(), 'Ninguém espera você')
    assert.equal(await page.locator('.rg-void .rg-void-t').textContent(), 'Nenhuma conversa ainda.')
    assert.equal(await page.locator('.rg-members').isVisible(), false, 'no channel, no "Neste canal"')
    assert.equal(await page.locator('.rg-reserved-row[aria-disabled="true"]').count(), 2, '"Fechadas" and "Sistema" are there, off')
    await page.screenshot({ path: join(SHOTS, 'r1-vazio.png') })

    // The record: two channels with both agents, a few lines.
    const made = await ch.create(USER, { name: 'obra', title: 'Obra' })
    assert.ok(made.ok)
    const obra = made.channel.id
    const madeX = await ch.create(USER, { name: 'extra' })
    assert.ok(madeX.ok)
    const extra = madeX.channel.id
    for (const id of [obra, extra]) for (const who of [a, b]) assert.ok((await ch.join(USER, id, who)).ok)
    assert.ok((await ch.say(a, obra, { body: 'O índice paginado está pronto; 18 testes verdes.' })).ok)
    assert.ok((await ch.say(b, obra, { body: 'Confiro a tela e volto.' })).ok)
    await until('both conversations listed', async () => (await page.locator('.rg-conv').count()) === 2)

    // ---- 1. the pill after Browser; "Ir para Regência" goes in and back ----
    console.log('step 1')
    const pill = await page.evaluate(d => {
      const p = document.querySelector(`#desk-switch .seg.sys[data-system="${d}"]`)
      return p ? { text: p.textContent, prev: p.previousElementSibling?.getAttribute('data-system') ?? null } : undefined
    }, DESK)
    assert.ok(pill, 'the pill is in the capsule')
    assert.match(pill.text ?? '', /Regência/)
    assert.equal(pill.prev, 'browser.desk', 'right after Browser')
    assert.ok(await page.evaluate(d => window.__tether.commands().some(c => c.id === `desk.system.${d}` && c.title === 'Ir para Regência'), DESK))
    await page.evaluate(d => window.__tether.runCommand(`desk.system.${d}`), DESK)
    await page.waitForFunction(q => window.__tether.activeDesk() === q, queueDesk)
    await page.evaluate(d => window.__tether.runCommand(`desk.system.${d}`), DESK)
    await page.waitForFunction(d => window.__tether.activeDesk() === d, DESK)

    // ---- 2. one pane; closed it comes back; its layout survives a restart ----
    console.log('step 2')
    assert.deepEqual((await page.evaluate(() => window.__tether.systemDesks())).find(d => d.id === DESK)!.panes, [PANE])
    await page.evaluate(() => window.__tether.ext.regency.close())
    await page.waitForFunction(p => window.__tether.panelIds().includes(p), PANE)
    assert.deepEqual((await page.evaluate(() => window.__tether.systemDesks())).find(d => d.id === DESK)!.panes, [PANE], 'back, and still alone')
    await page.evaluate(i => window.__tether.ext.regency.select(i), obra)
    assert.equal((await layout())?.channelId, obra)
    const saved = (): string => { try { return JSON.stringify(JSON.parse(readFileSync(join(home, 'layout.json'), 'utf8')).systemDesks?.[DESK] ?? null) } catch { return '' } }
    await waitUntil(() => saved().includes(obra), 10_000, 'the layout reached layout.json')
    await killElectron(app, root)
    app = undefined
    ;({ app, page } = await launch(home, pipe))
    await enter()
    await until('the chosen channel came back from layout.json', async () => (await layout())?.channelId === obra)
    await until('the centre shows it', async () => (await embed(obra))?.loaded === true)

    // ---- 3. the centre: a line comes, the box speaks, the same channel as a tab elsewhere does not collide ----
    console.log('step 3')
    let before = await state()
    assert.ok((await ch.say(a, obra, { body: 'Uma fala nova no centro.' })).ok)
    await until('the line reached the centre', async () => (await embed(obra))?.rows.some(r => r.text === 'Uma fala nova no centro.') === true)
    assert.deepEqual(await state(), before, 'a line moves nothing')
    const box = page.locator(`.rg-center .ch-pane[data-channel="${obra}"] .ch-composer-slot textarea`)
    await box.click()
    await box.fill('Falo pela Regência.')
    await page.keyboard.press('Enter')
    await until('the moderator line came back', async () => (await embed(obra))?.rows.some(r => r.text === 'Falo pela Regência.' && r.mine) === true)
    await page.evaluate(q => window.__tether.switchDesk(q), queueDesk)
    await page.waitForFunction(q => window.__tether.activeDesk() === q, queueDesk)
    await page.evaluate(i => window.__tether.ext.channels.open(i, 'obra'), obra)
    await page.waitForFunction(p => window.__tether.panelIds().includes(p), `channel:${obra}`)
    assert.equal(await page.evaluate(p => window.__tether.deskOf(p), `channel:${obra}`), queueDesk, 'the tab is on the queue desk')
    await until('the tab loaded', async () => (await page.evaluate(i => window.__tether.ext.channels.view(i), obra))?.loaded === true)
    assert.ok((await ch.say(b, obra, { body: 'Para as duas vistas.' })).ok)
    await until('both views heard it', async () => {
      const t = await page.evaluate(i => window.__tether.ext.channels.view(i), obra)
      const e = await embed(obra)
      return !!t && !!e && t.last === e.last && t.rows.some(r => r.text === 'Para as duas vistas.') && e.rows.some(r => r.text === 'Para as duas vistas.')
    })
    assert.equal(await page.locator(`.ch-pane[data-channel="${obra}"]`).count(), 2, 'one tab and one embedded view')
    assert.deepEqual((await page.evaluate(() => window.__tether.systemDesks())).find(d => d.id === DESK)!.panes, [PANE], 'the tab did not land in the Regency')

    // A tab dropped on the Regency's desk goes back to the desk it came from; the Regency stays alone.
    await page.evaluate(([p, d]) => window.__tether.movePaneToDesk(p!, d!), [`channel:${obra}`, DESK] as const)
    await page.waitForFunction(([p, d]) => window.__tether.deskOf(p!) !== d, [`channel:${obra}`, DESK] as const)
    assert.equal(await page.evaluate(p => window.__tether.deskOf(p), `channel:${obra}`), queueDesk, 'the tab went back to its desk')
    assert.deepEqual((await page.evaluate(() => window.__tether.systemDesks())).find(d => d.id === DESK)!.panes, [PANE], 'the Regency is alone again')

    // A second queue desk with the other agent: the tree shows two desks with agents.
    const desk2 = await page.evaluate(q => window.__tether.createDesk('after', q), queueDesk)
    await page.evaluate(([p, d]) => window.__tether.movePaneToDesk(p!, d!), [b, desk2] as const)
    await page.waitForFunction(([p, d]) => window.__tether.deskOf(p!) === d, [b, desk2] as const)
    await enter()

    // ---- 4. a line to the person: in "Esperam você"; a click puts it in the centre and, read, it goes ----
    console.log('step 4')
    before = await state()
    assert.ok((await ch.say(a, extra, { body: 'Posso seguir com a migração?', to: [MODERATOR_NAME] })).ok)
    const waitRow = page.locator(`.rg-wait[data-target="channel:${extra}"]`)
    await waitRow.waitFor()
    assert.equal(await waitRow.getAttribute('data-reason'), 'to-you')
    assert.match((await waitRow.textContent()) ?? '', /1 fala para você/)
    assert.ok((await model()).waiting.some(w => w.key === `channel:${extra}:to-you`))
    assert.equal(await page.locator(`.rg-conv[data-target="channel:${extra}"] .rg-tome`).count(), 1, 'the conversation says "para você"')
    assert.deepEqual(await state(), before, 'the line to her moves nothing')

    // ---- 5. an agent waiting: in "Esperam você" and in the tree, with its state ----
    console.log('step 5')
    doorApi.attention.signal(a, 'waiting')
    const agentWait = page.locator(`.rg-wait[data-target="agent:${a}"]`)
    await agentWait.waitFor()
    assert.equal(await agentWait.getAttribute('data-reason'), 'agent-waiting')
    assert.equal((await page.locator(`.rg-pane[data-target="agent:${a}"] .rg-st`).textContent()), 'espera você')
    assert.equal(await page.locator(`.rg-group[data-desk="${queueDesk}"] .rg-attn`).count(), 1, 'its desk says someone waits')
    assert.deepEqual(await state(), before, 'the attention moves nothing')
    const w = (await model()).waiting.map(x => x.key)
    assert.deepEqual(w, [`channel:${extra}:to-you`, `agent:${a}:agent-waiting`], 'who waits longest comes first')
    assert.equal(await page.locator('.rg-waiting .cnt').textContent(), '2')
    await page.screenshot({ path: join(SHOTS, 'r1-tres-colunas.png') })

    // The click on the channel's call: it goes to the centre and, seen there, the call goes.
    await waitRow.click()
    assert.equal((await layout())?.channelId, extra)
    await until('the centre shows the called channel', async () => (await embed(extra))?.loaded === true)
    await until('read, the call went', async () => (await waitRow.count()) === 0 && !(await model()).waiting.some(x => x.target.id === extra))
    assert.equal(await page.evaluate(() => window.__tether.activeDesk()), DESK, 'choosing a conversation stays in the Regency')

    // ---- 6. the tree: queue desks, Browser, the drawer; names and identity; a folded desk hides its panes ----
    console.log('step 6')
    const tree = (await model()).tree
    assert.ok(!tree.some(d => d.target.id === DESK), 'the Regency is not in its own tree')
    const kinds = tree.map(d => d.kind)
    assert.deepEqual(kinds.filter(k => k === 'queue').length, 2)
    assert.ok(tree.some(d => d.kind === 'system' && d.target.id === 'browser.desk'), 'Browser is a desk of the tree')
    assert.equal(kinds.at(-1), 'drawer', 'the drawer comes last')
    assert.ok(kinds.indexOf('system') > kinds.lastIndexOf('queue'), 'queue, then system, then drawer')
    const q1 = tree.find(d => d.target.id === queueDesk)!
    const ra = q1.panes.find(p => p.target.id === a)!
    assert.deepEqual(ra.target, { kind: 'agent', id: a })
    assert.equal(ra.identity?.kind, 'claude')
    assert.equal(tree.find(d => d.target.id === desk2)!.panes.find(p => p.target.id === b)?.identity?.kind, 'claude')
    assert.equal(await page.locator(`.rg-group[data-desk="browser.desk"]`).count(), 1)
    assert.equal(await page.locator(`.rg-group[data-kind="drawer"]`).count(), 1)
    assert.equal(await page.locator(`.rg-pane[data-target="agent:${a}"] .aid`).count(), 1, 'an agent row draws its identity')
    assert.equal(await page.locator(`.rg-pane[data-target="agent:${b}"]`).getAttribute('tabindex'), '0')
    assert.equal(await page.locator(`.rg-pane[data-target="agent:${b}"] .rg-acts`).count(), 1, 'the place for the next slice\'s actions')
    await page.click(`.rg-desk[data-target="desk:${queueDesk}"]`)
    await until('folded', async () => (await layout())?.collapsed.includes(queueDesk) === true)
    assert.equal(await page.locator(`.rg-group[data-desk="${queueDesk}"] .rg-pane`).count(), 0, 'a folded desk hides its panes')
    assert.equal(await page.locator(`.rg-group[data-desk="${queueDesk}"] .rg-attn`).count(), 1, 'folded, it still says someone waits')
    assert.equal(await page.locator(`.rg-desk[data-target="desk:${queueDesk}"]`).getAttribute('aria-expanded'), 'false')
    await page.click(`.rg-desk[data-target="desk:${queueDesk}"]`)
    await until('unfolded', async () => (await page.locator(`.rg-group[data-desk="${queueDesk}"] .rg-pane`).count()) > 0)
    assert.equal(await page.evaluate(() => window.__tether.activeDesk()), DESK, 'folding stays in the Regency')

    // ---- 7. "Neste canal": folded, the faces; open, the members' column ----
    console.log('step 7')
    const members = page.locator('.rg-members')
    assert.equal(await members.getAttribute('data-open'), 'false', 'it starts folded')
    await until('the faces came', async () => (await page.locator('.rg-faces .rg-face').count()) === 2)
    assert.equal(await page.locator('.rg-members-host').isVisible(), false)
    assert.match((await page.locator('.rg-members-tg').textContent()) ?? '', /Neste canal · 2/)
    await page.click('.rg-members-tg')
    assert.equal(await members.getAttribute('data-open'), 'true')
    assert.equal((await layout())?.membersOpen, true)
    await page.locator('.rg-members-host').waitFor()
    assert.ok((await page.locator('.rg-members-host .ch-mrow[data-member]').count()) >= 2, 'the channel\'s members, with their gestures')
    await page.click('.rg-members-tg')
    assert.equal(await members.getAttribute('data-open'), 'false')

    // ---- 8. immersion: the side columns become thin edges, and back ----
    console.log('step 8')
    before = await state()
    const mode = (): Promise<string | undefined> => page.evaluate(() => window.__tether.ext.regency.mode())
    assert.ok(await page.evaluate(() => window.__tether.commands().some(c => c.id === 'regency.immersion')), 'the command is in the palette')
    assert.match((await page.locator('.rg-mode').getAttribute('title')) ?? '', /Imersão.*Ctrl\+Shift\+\\/, 'the switch says its key')
    await page.keyboard.press('Control+Shift+Backslash')
    await until('immersion by the key', async () => (await mode()) === 'immersion')
    assert.equal(await page.locator('.rg-left').isVisible(), false, 'the left column folded')
    assert.equal(await page.locator('.rg-right').isVisible(), false, 'the right column folded')
    assert.equal(await page.locator('.rg-edge-l').isVisible(), true)
    assert.equal(await page.locator('.rg-edge-r').isVisible(), true)
    assert.ok(((await page.locator('.rg-edge-l').boundingBox())?.width ?? 99) <= 44, 'a thin edge')
    const waitingNow = (await model()).waiting.length
    assert.ok(waitingNow > 0)
    assert.equal(await page.locator('.rg-edge-cnt').textContent(), String(waitingNow), 'the left edge keeps the count')
    assert.match((await page.locator('.rg-edge-l').getAttribute('class')) ?? '', /\blit\b/, 'and lights: someone waits')
    assert.equal(await page.locator(`.rg-center .ch-pane[data-channel="${extra}"]`).isVisible(), true, 'the conversation stays')
    await waitUntil(() => saved().includes('"mode":"immersion"'), 10_000, 'the mode reached layout.json')
    await page.screenshot({ path: join(SHOTS, 'r1-imersao.png') })
    await page.click('.rg-edge-l')
    await until('a click on the left edge goes back', async () => (await mode()) === 'manage')
    assert.equal(await page.locator('.rg-left').isVisible(), true)
    assert.equal(await page.locator('.rg-edge-l').isVisible(), false)
    await page.click('.rg-mode')
    await until('the visible switch', async () => (await mode()) === 'immersion')
    await page.click('.rg-edge-r [data-action="manage-tether"]')
    await until('the right edge goes back', async () => (await mode()) === 'manage')
    assert.equal((await state()).desk, before.desk, 'immersion stays on the Regency')

    // ---- 9. the phone (pane under 768 px): three places at the bottom, one at a time ----
    console.log('step 9')
    const tier = (): Promise<string | undefined> => page.evaluate(() => window.__tether.ext.regency.tier())
    const tab = (): Promise<string | null> => page.locator('.rg').getAttribute('data-tab')
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(500, 860) })
    await until('the phone tier', async () => (await tier()) === 'mobile')
    console.log(`pane width at the phone: ${await page.locator('.rg').evaluate(e => (e as unknown as { clientWidth: number }).clientWidth)}`)
    const places = page.locator('.rg-tabbar .rg-tab')
    assert.equal(await places.count(), 3)
    assert.deepEqual((await page.locator('.rg-tabbar .rg-tab-t').allTextContents()), ['Chama você', 'Conversa', 'Tether'])
    for (let i = 0; i < 3; i++) assert.ok(((await places.nth(i).boundingBox())?.height ?? 0) >= 44, 'a 44 px touch target')
    assert.equal(await page.locator('.rg-tab[data-tab="waiting"] .rg-tab-cnt').textContent(), String(waitingNow), '"Chama você" counts')
    assert.equal(await page.locator('.rg-edge-l').isVisible(), false)
    // Reopened with someone waiting, it opens on "Chama você".
    await page.evaluate(() => window.__tether.ext.regency.close())
    await page.waitForFunction(p => window.__tether.panelIds().includes(p), PANE)
    await until('opens on "Chama você"', async () => (await tab()) === 'waiting')
    await until('the phone tier again', async () => (await tier()) === 'mobile')
    assert.equal(await page.locator('.rg-left').isVisible(), true)
    assert.equal(await page.locator('.rg-center').isVisible(), false, 'one thing at a time')
    assert.equal(await page.locator('.rg-right').isVisible(), false)
    assert.equal(await page.locator('.rg-wait').first().isVisible(), true, '"Esperam você" is here')
    assert.ok((await page.locator('.rg-conv').count()) >= 2, 'and the conversations')
    await page.screenshot({ path: join(SHOTS, 'r1-celular-chama.png') })
    // Choosing a conversation takes the person to it; the box sits right above the bar.
    await page.click(`.rg-conv[data-target="channel:${obra}"]`)
    await until('to the conversation', async () => (await tab()) === 'conversation')
    assert.equal((await layout())?.channelId, obra)
    assert.equal(await page.locator('.rg-center').isVisible(), true)
    assert.equal(await page.locator('.rg-left').isVisible(), false)
    await until('the centre shows it', async () => (await embed(obra))?.loaded === true)
    const boxAt = await page.locator(`.rg-center .ch-pane[data-channel="${obra}"] .ch-composer-slot textarea`).boundingBox()
    const barAt = await page.locator('.rg-tabbar').boundingBox()
    assert.ok(boxAt && barAt && boxAt.y + boxAt.height <= barAt.y && barAt.y - (boxAt.y + boxAt.height) < 80, `the box sits above the bar (${JSON.stringify({ boxAt, barAt })})`)
    await page.screenshot({ path: join(SHOTS, 'r1-celular-conversa.png') })
    await page.click('.rg-tab[data-tab="tether"]')
    await until('to the tether', async () => (await tab()) === 'tether')
    assert.equal(await page.locator('.rg-right').isVisible(), true)
    assert.equal(await page.locator('.rg-members').isVisible(), true, '"Neste canal" is in "Tether"')
    assert.ok((await page.locator('.rg-right .rg-desk').count()) >= 2, 'and the tree')
    assert.equal((await layout())?.narrowTab, 'tether', 'the place is kept')
    await page.screenshot({ path: join(SHOTS, 'r1-celular-tether.png') })
    // Back to the desktop: the three columns, no bar.
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(1500, 900) })
    await until('the desktop tier', async () => (await tier()) === 'desktop')
    assert.equal(await page.locator('.rg-tabbar').isVisible(), false)
    assert.equal(await page.locator('.rg-left').isVisible(), true)
    assert.equal(await page.locator('.rg-right').isVisible(), true)
    await page.evaluate(i => window.__tether.ext.regency.select(i), extra)

    // ---- 10. nothing comes forward: the Regency hidden, events do not bring it ----
    console.log('step 10')
    // On the first desk (the waiting agent b sits on the other one and #extra only in the hidden Regency: out of sight, the calls stay).
    await page.evaluate(d => window.__tether.switchDesk(d), queueDesk)
    await page.waitForFunction(d => window.__tether.activeDesk() === d, queueDesk)
    before = await state()
    assert.ok((await ch.say(b, extra, { body: 'Mais uma para você.', to: [MODERATOR_NAME] })).ok)
    doorApi.attention.signal(b, 'waiting')
    let keys: string[] = []
    await until('the Regency knows it, hidden', async () => {
      keys = (await model()).waiting.map(x => x.key)
      return keys.includes(`channel:${extra}:to-you`) && keys.includes(`agent:${b}:agent-waiting`)
    }).catch(e => { throw new Error(`${(e as Error).message}: ${JSON.stringify(keys)}`) })
    assert.deepEqual(await state(), before, 'no desk, no pane, no focus changed')
    // Back in the Regency, the channel in the centre is in front of her: its call goes.
    await enter()
    await until('shown again, the line is read', async () => !(await model()).waiting.some(x => x.target.id === extra))
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
