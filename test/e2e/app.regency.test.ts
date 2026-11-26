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
//   9. the phone (pane under 768 px): "Esperam você", "Conversa", "Tether" at the bottom, one at a time, 44 px; it opens on "Esperam você"
//      when someone waits; choosing a conversation goes to it; the box sits above the bar; the place is kept;
//  10. nothing comes forward: no desk switch, no focus change by an event (checked at each event above).
//  11. "Por mesa · Por agente": the switch changes the view; each pane once, under its owner, with the desk's badge; the view is
//      kept in layout.json and survives reopening the pane (screenshots r2-por-agente, r2-por-mesa);
//  12. the state chips count as the model; a filter and the search narrow the tree, empty desks go, "Nada com esse filtro" offers
//      the way out; Esc clears the search, a second Esc the filter; the field keeps its text, caret and focus through a repaint
//      by an event (screenshot r2-filtro-busca);
//  13. the tree's keyboard: arrows walk, Home/End, Left/Right fold, Space peeks without leaving, Shift+F10 and the Menu key ask
//      the row's menu, Enter goes to the pane; the focused row and the column's scroll survive a repaint by an event; one roving
//      tab stop; the phone's "Tether" holds the tools as 44 px targets (screenshot r2-celular-tether).
//  14. a desk's menu (right click, the Menu key, Shift+F10, the row's "⋯"): the pill's rows aimed at it, "Ir até a mesa" last;
//      rename in the row (it survives a repaint by an event; Enter keeps, Esc does not), sleep and wake (menu, moon, sun),
//      "Nova mesa depois"; Browser's short menu; the Regency stays in view with the keyboard (r2-menu-mesa, r2-renomear).
//  15. a pane's and an agent's menu: "Ir até a guia" last, no "Focar guia"; rename the slot in the row, sleep and wake,
//      "Emblema…", "Falar com" (the peek, keyboard in the terminal; the row's button too), "O que <nome> tem" (the view by
//      agent, its group focused), "Duplicar" on the original's desk, "Mover…" to another desk, "Fechar guia" with the
//      keyboard going to the row in its place; nothing comes forward (r2-menu-agente, r2-menu-guia, r2-por-agente again).
//  16. "Fechadas": ended sessions fold into the tree's last section (folded by default, with the count, kept in the layout);
//      each line is the agent, how long ago it ended; the search filters it (and opens it), a state filter empties it; Space
//      does nothing on it; "Reabrir em…" lists the awake desks and "Nova mesa", puts the session there without changing desk,
//      and the new row glows; "Esquecer…" asks first (r2-fechadas, r2-fechadas-reabrir).
//  17. the quick view docked over the conversation: Space on an agent's row shows its live terminal in a card over the
//      centre, no veil, nothing inert, the keyboard on the row; the box of speech takes text and sends with it open (Esc
//      there is the box's); Space on another row swaps the pane (the first back whole); Esc on the row closes; a note by
//      Space, closed by ✕ (r3-cartao-regencia-terminal, r3-cartao-regencia-nota).
// Run alone: node --test --test-force-exit --test-concurrency=1 test/e2e/app.regency.test.ts   (one E2E at a time: the build is remade)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
import type { RegencyModel, StateCounts, TreeFilter } from '../../extensions/regency/model.ts'
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
  peekState(): unknown
  paneLoan(id: string): { state?: string }
  openNote(path: string): Promise<void>
  notes(): { id: string }[]
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
      shown(): { model: RegencyModel; counts: StateCounts } | undefined
      view(v: 'desk' | 'agent'): void
      filter(f: TreeFilter): void
      search(q: string): void
      paints(): number
      menuAsks(): { target: { kind: string; id: string }; anchor: string }[]
      menu(key: string): boolean
      renaming(): string | undefined
      create(draft: { what: string; kind?: string; deskId?: string; cwd?: string }): Promise<{ ok: boolean; text?: string }>
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
const SHOTS = 'C:/atrium/.tmp/tether-agents/onda-3/mesa-regencia/capturas/r6'
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
    // A desk switch hands the keyboard to the desk's active pane one animation frame later (focusActivePane): a test that
    // focuses a row right after the switch must wait that frame out, or the shell takes the keyboard from the row.
    const frames = (): Promise<void> => page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
    const enter = async (): Promise<void> => {
      if ((await page.evaluate(() => window.__tether.activeDesk())) !== DESK) await page.evaluate(d => window.__tether.runCommand(`desk.system.${d}`), DESK)
      await page.waitForFunction(d => window.__tether.activeDesk() === d, DESK)
      await page.waitForFunction(p => window.__tether.panelIds().includes(p), PANE)
      await frames()
    }
    const queueDesk = await page.evaluate(() => window.__tether.activeDesk())

    // ---- 0. empty: no channel, nobody waits ----
    console.log('step 0')
    await enter()
    await page.waitForSelector('.rg .rg-void:not([hidden])')
    await until('the conversations came (empty)', async () => (await page.locator('.rg-convs .rg-empty').textContent()) === 'Nenhum canal aberto')
    assert.equal(await page.locator('.rg-waiting .rg-empty').textContent(), 'Ninguém espera você')
    assert.equal(await page.locator('.rg-void .rg-void-t').textContent(), 'Nenhum canal ainda.')
    assert.equal(await page.locator('.rg-members').isVisible(), false, 'no channel, no "Neste canal"')
    assert.equal(await page.locator('.rg-reserved .rg-sys-open[data-action="system"]').count(), 1, '"Sistema" is at the column\'s foot (on since R5d)')
    assert.equal(await page.locator('.rg-cl-head').count(), 1, '"Fechadas" is at the tree\'s foot')
    assert.equal(await page.locator('.rg-cl-empty').textContent(), 'Nenhuma sessão fechada')
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
    // R6, L: the card shows what is asked (who and the first line), the count of the kind in the tooltip.
    await until('the card says what is asked', async () => (await waitRow.locator('.rg-w2').textContent()) === 'conferente: Posso seguir com a migração?')
    assert.match((await waitRow.locator('.rg-w2').getAttribute('title')) ?? '', /^conferente: Posso seguir com a migração\? · 1 fala para você$/)
    assert.equal(await waitRow.locator('.rg-w1').textContent(), `#${(await model()).conversations.open.find(c => c.target.id === extra)?.name ?? ''}`)
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
    await page.screenshot({ path: join(SHOTS, 'tres-colunas.png') })
    await page.locator('.rg-left').screenshot({ path: join(SHOTS, 'esperam-o-que-pede.png') })

    // The click on the channel's call: it goes to the centre and, seen there, the call goes.
    await waitRow.click()
    assert.equal((await layout())?.channelId, extra)
    await until('the centre shows the called channel', async () => (await embed(extra))?.loaded === true)
    await until('read, the call went', async () => (await waitRow.count()) === 0 && !(await model()).waiting.some(x => x.target.id === extra))
    assert.equal(await page.evaluate(() => window.__tether.activeDesk()), DESK, 'choosing a conversation stays in the Regency')

    // ---- 6. the tree: queue desks, Browser, the drawer; names and identity; a folded desk hides its panes ----
    console.log('step 6')
    const { tree, shelf } = await model()
    assert.ok(!tree.some(d => d.target.id === DESK), 'the Regency is not in its own tree')
    const kinds = tree.map(d => d.kind)
    assert.deepEqual(kinds.filter(k => k === 'queue').length, 2)
    // Empty, Browser and the drawer fold into the shelf at the tree's foot (queue first, then system, then drawer).
    assert.deepEqual(shelf.map(s => [s.target.id, s.kind]), [['browser.desk', 'system'], [shelf.at(-1)!.target.id, 'drawer']], 'the empty Browser and drawer are on the shelf')
    assert.ok(!tree.some(d => d.kind !== 'queue'), 'not desk rows')
    assert.deepEqual(await page.locator('.rg-shelf .rg-shelf-b span:not(.rg-ic)').allTextContents(), ['Browser', 'Gaveta'])
    const q1 = tree.find(d => d.target.id === queueDesk)!
    const ra = q1.panes.find(p => p.target.id === a)!
    assert.deepEqual(ra.target, { kind: 'agent', id: a })
    assert.equal(ra.identity?.kind, 'claude')
    assert.equal(tree.find(d => d.target.id === desk2)!.panes.find(p => p.target.id === b)?.identity?.kind, 'claude')
    assert.equal(await page.locator(`.rg-group[data-desk="browser.desk"]`).count(), 0)
    assert.equal(await page.locator(`.rg-shelf-b[data-target="desk:browser.desk"]`).count(), 1)
    assert.equal(await page.locator(`.rg-pane[data-target="agent:${a}"] .aid`).count(), 1, 'an agent row draws its identity')
    assert.equal(await page.locator(`.rg-pane[data-target="agent:${b}"]`).getAttribute('role'), 'treeitem')
    assert.equal(await page.locator('.rg-tree [data-key][tabindex="0"]').count(), 1, 'the tree is one tab stop (roving tabindex)')
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
    // R6, Q: the bell and the number; the words are the tooltip's, never vertical text on the edge.
    assert.equal((await page.locator('.rg-edge-l').innerText()).trim(), String(waitingNow), 'only the number on the edge')
    assert.match((await page.locator('.rg-edge-l').getAttribute('title')) ?? '', /esperam? você · voltar a Gerir$/)
    await page.screenshot({ path: join(SHOTS, 'imersao.png') })
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
    assert.deepEqual((await page.locator('.rg-tabbar .rg-tab-t').allTextContents()), ['Esperam você', 'Canal', 'Mesas'])
    for (let i = 0; i < 3; i++) assert.ok(((await places.nth(i).boundingBox())?.height ?? 0) >= 44, 'a 44 px touch target')
    assert.equal(await page.locator('.rg-tab[data-tab="waiting"] .rg-tab-cnt').textContent(), String(waitingNow), '"Esperam você" counts')
    assert.equal(await page.locator('.rg-edge-l').isVisible(), false)
    // Reopened with someone waiting, it opens on "Esperam você".
    await page.evaluate(() => window.__tether.ext.regency.close())
    await page.waitForFunction(p => window.__tether.panelIds().includes(p), PANE)
    await until('opens on "Esperam você"', async () => (await tab()) === 'waiting')
    await until('the phone tier again', async () => (await tier()) === 'mobile')
    assert.equal(await page.locator('.rg-left').isVisible(), true)
    assert.equal(await page.locator('.rg-center').isVisible(), false, 'one thing at a time')
    assert.equal(await page.locator('.rg-right').isVisible(), false)
    assert.equal(await page.locator('.rg-wait').first().isVisible(), true, '"Esperam você" is here')
    assert.equal(await page.locator('.rg-left .rg-conv').count(), 0, 'only who waits: the conversations live in "Conversa"')
    await page.screenshot({ path: join(SHOTS, 'celular-esperam.png') })
    // "Conversa": the list over the conversation; choosing one folds the list into a line that names it.
    await page.click('.rg-tab[data-tab="conversation"]')
    await until('to the conversation tab', async () => (await tab()) === 'conversation')
    await until('the list over the conversation', async () => (await page.locator('.rg-center .rg-convs .rg-conv').count()) >= 2)
    for (const r of await page.locator('.rg-center .rg-convs .rg-conv').all()) assert.ok(((await r.boundingBox())?.height ?? 0) >= 44, 'a 44 px conversation row')
    await page.click(`.rg-conv[data-target="channel:${obra}"]`)
    assert.equal((await layout())?.channelId, obra)
    assert.equal(await page.locator('.rg-center').isVisible(), true)
    assert.equal(await page.locator('.rg-left').isVisible(), false)
    await until('the list folded, naming the conversation', async () => (await page.locator('.rg-convs-tg').getAttribute('aria-expanded')) === 'false'
      && (await page.locator('.rg-convs-now').textContent()) === '#obra')
    await until('the centre shows it', async () => (await embed(obra))?.loaded === true)
    const boxAt = await page.locator(`.rg-center .ch-pane[data-channel="${obra}"] .ch-composer-slot textarea`).boundingBox()
    const barAt = await page.locator('.rg-tabbar').boundingBox()
    assert.ok(boxAt && barAt && boxAt.y + boxAt.height <= barAt.y && barAt.y - (boxAt.y + boxAt.height) < 80, `the box sits above the bar (${JSON.stringify({ boxAt, barAt })})`)
    const listAt = await page.locator('.rg-center .rg-convs').boundingBox()
    const logAt = await page.locator(`.rg-center .ch-pane[data-channel="${obra}"]`).boundingBox()
    assert.ok(listAt && logAt && listAt.y + listAt.height <= logAt.y + 1, `the folded list sits above the channel (${JSON.stringify({ listAt, logAt })})`)
    await page.screenshot({ path: join(SHOTS, 'celular-conversa.png') })
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

    const shown = async (): Promise<{ model: RegencyModel; counts: StateCounts }> => (await page.evaluate(() => window.__tether.ext.regency.shown()))!
    const paints = (): Promise<number> => page.evaluate(() => window.__tether.ext.regency.paints())
    const focusedKey = (): Promise<string | null> => page.evaluate(() => document.activeElement?.getAttribute('data-key') ?? null)
    const treeKeys = (): Promise<string[]> => page.locator('.rg-tree [data-key]').evaluateAll(es => es.map(e => (e as unknown as { dataset: { key: string } }).dataset.key))
    const reopen = async (): Promise<void> => {
      await page.locator('.rg').evaluate(e => (e as unknown as { dataset: Record<string, string> }).dataset.old = '1')
      await page.evaluate(() => window.__tether.ext.regency.close())
      await page.waitForFunction(p => window.__tether.panelIds().includes(p), PANE)
      await page.locator('.rg:not([data-old]) .rg-chip[data-filter="all"] .rg-chip-n:not(:empty)').waitFor()
      assert.equal(await page.locator('.rg[data-old]').count(), 0, 'the old pane went')
    }
    const desk2Name = (await model()).tree.find(d => d.target.id === desk2)!.name

    // ---- 11. "Por mesa · Por agente" ----
    console.log('step 11')
    // desk2 is given to a (the for-agents owner record): b's pane belongs to a by its desk.
    const forAgents = door.apiFor('for-agents', own)
    await forAgents.objects.ready
    await forAgents.objects.set('desk', desk2, 'owner', { owner: a, since: new Date().toISOString(), givenBy: 'user' })
    await until('the owner reached the Regency', async () => (await model()).tree.find(d => d.target.id === desk2)?.owner !== undefined)
    // a also has one pane of its own, so its group has something to fold.
    await forAgents.objects.set('pane', `channel:${obra}`, 'owner', { owner: a, since: new Date().toISOString(), givenBy: 'user' })
    await until('the pane owner reached the Regency', async () => ((await model()).byAgent.find(g => g.target.id === a)?.paneCount ?? 0) > 0)
    before = await state()
    assert.equal(await page.locator('.rg-seg-b[data-view="desk"]').getAttribute('aria-checked'), 'true')
    await page.click('.rg-seg-b[data-view="agent"]')
    await until('by agent', async () => (await layout())?.view === 'agent')
    const headA = `.rg-agent[data-key="pane:agent:${a}"]`
    const headB = `.rg-agent[data-key="pane:agent:${b}"]`
    await page.locator(headA).waitFor()
    assert.equal(await page.locator('.rg-desk').count(), 0, 'no desk rows by agent')
    const byAgent = (await shown()).model.byAgent
    const placed = byAgent.flatMap(g => [...(g.self ? [g.self.target.id] : []), ...g.panes.map(p => p.target.id)])
    assert.equal(new Set(placed).size, placed.length, 'each pane once')
    assert.equal(placed.length, (await shown()).model.tree.reduce((n, d) => n + d.panes.length, 0), 'every pane of the tree')
    assert.equal(byAgent[byAgent.length - 1]!.you, true, '"Você" last')
    assert.ok(byAgent.slice(0, -1).every(g => g.self !== undefined), 'every group before it is an agent\'s own pane')
    const ga = byAgent.find(g => g.target.id === a)!
    const gb = byAgent.find(g => g.target.id === b)!
    assert.deepEqual(ga.self?.target, { kind: 'agent', id: a })
    assert.equal(gb.inDeskOf, ga.name, 'b is a group of its own, in a desk of a')
    assert.ok(!ga.panes.some(p => p.target.id === b), 'and not a child of a')
    assert.ok(byAgent[byAgent.length - 1]!.panes.every(p => p.target.kind !== 'agent'), 'no agent under "Você"')
    assert.match((await page.locator(`${headB} .rg-dsk`).textContent()) ?? '', new RegExp(desk2Name), 'the head carries the desk\'s badge')
    assert.equal(await page.locator(`${headB} .rg-own`).textContent(), ga.name, 'and says whose desk (the crown)')
    assert.equal(await page.locator(`${headB} .rg-own`).getAttribute('title'), `Esta guia está numa mesa de ${ga.name}`, 'whole in the tooltip')
    assert.equal(await page.locator(`${headA} .aid`).count(), 1, 'the head draws its identity')
    assert.match((await page.locator('.rg-agent[data-key="group:you"]').textContent()) ?? '', /Você/)
    assert.equal(await page.locator(`.rg-tree [data-target="agent:${a}"]`).count(), 1, 'the group is the pane: one row, one key')
    assert.equal(await page.locator(`.rg-tree [data-key="pane:agent:${a}"]`).count(), 1)
    const kids = page.locator(`.rg-group[data-agent="${a}"] .rg-pane:not(.rg-agent)`)
    assert.ok((await kids.count()) > 0, 'a has what it has')
    await page.click(`${headA} .rg-caret`)
    await until('the group folds', async () => (await layout())?.collapsed.includes(a) === true)
    assert.equal(await kids.count(), 0)
    await page.click(`${headA} .rg-caret`)
    await until('and opens', async () => (await kids.count()) > 0)
    assert.deepEqual(await state(), before, 'switching and folding stay in the Regency')
    await waitUntil(() => saved().includes('"view":"agent"'), 10_000, 'the view reached layout.json')
    await page.screenshot({ path: join(SHOTS, 'por-agente.png') })
    await reopen()
    assert.equal((await layout())?.view, 'agent', 'the view survives reopening')
    assert.equal(await page.locator('.rg-seg-b[data-view="agent"]').getAttribute('aria-checked'), 'true')
    await page.click('.rg-seg-b[data-view="desk"]')
    await until('by desk again', async () => (await layout())?.view === 'desk' && (await page.locator('.rg-desk').count()) > 0)
    assert.equal(await page.locator('.rg-agent').count(), 0)
    await page.screenshot({ path: join(SHOTS, 'r2-por-mesa.png') })

    // ---- 12. filters and search ----
    console.log('step 12')
    const chipN = (f: TreeFilter): Promise<string | null> => page.locator(`.rg-chip[data-filter="${f}"] .rg-chip-n`).textContent()
    const chipsMatch = async (): Promise<boolean> => {
      const c = (await shown()).counts
      for (const f of ['all', 'waiting', 'busy', 'idle', 'asleep'] as const) if ((await chipN(f)) !== String(c[f])) return false
      return true
    }
    await until('the chips count as the model', chipsMatch)
    const counts0 = (await shown()).counts
    assert.ok(counts0.waiting >= 2, `a and b wait (${JSON.stringify(counts0)})`)
    assert.equal(counts0.waiting + counts0.busy + counts0.idle + counts0.asleep, counts0.all, 'the four chips cover every pane, each once')
    assert.deepEqual(await page.locator('.rg-chip .rg-chip-t').allTextContents(), ['Todos', 'Esperam você', 'Trabalhando', 'Livre', 'Hibernando'])
    assert.match((await page.locator('.rg-chip[data-filter="waiting"]').getAttribute('class')) ?? '', /\bal\b/, 'orange: someone waits')
    assert.doesNotMatch((await page.locator('.rg-chip[data-filter="busy"]').getAttribute('class')) ?? '', /\bal\b/, 'the orange only on "Esperam você"')
    await page.click('.rg-chip[data-filter="waiting"]')
    await until('filtered', async () => (await layout())?.filter === 'waiting')
    await until('only who waits', async () => (await page.locator('.rg-tree .rg-pane').count()) === counts0.waiting)
    assert.deepEqual([...new Set(await page.locator('.rg-tree .rg-pane').evaluateAll(es => es.map(e => (e as unknown as { dataset: { state: string } }).dataset.state)))], ['wait'])
    assert.ok(!(await shown()).model.tree.some(d => d.panes.length === 0), 'desks with nobody waiting are gone')
    assert.equal(await page.locator('.rg-tree .rg-group[data-kind="drawer"]').count(), 0, 'the empty drawer is gone')
    // The search lives behind the heading's icon; Ctrl+F in the tree opens it with the keyboard.
    const field = page.locator('.rg-search-in')
    assert.equal(await page.locator('.rg-search').isVisible(), false, 'folded into its icon')
    assert.equal(await field.getAttribute('placeholder'), 'Filtrar mesas e guias…')
    await page.locator('.rg-tree [data-key][tabindex="0"]').focus()
    await page.keyboard.press('Control+f')
    await until('Ctrl+F opened the field with the keyboard', async () => (await page.locator('.rg-search').isVisible()) && await field.evaluate(e => (e as unknown as { ownerDocument: { activeElement: unknown } }).ownerDocument.activeElement === e))
    // The search, typed by the person, over the filter: only a.
    await page.keyboard.type('confer')
    await until('the search narrows', async () => {
      const t = (await shown()).model.tree
      return t.length === 1 && t[0]!.panes.length === 1 && t[0]!.panes[0]!.target.id === a
    })
    await until('drawn', async () => (await page.locator('.rg-tree .rg-pane').count()) === 1)
    assert.equal(await page.locator('.rg-search-x').isVisible(), true, 'the clear button shows')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowLeft')
    await page.screenshot({ path: join(SHOTS, 'filtros.png') })
    // A repaint by an event (a stops waiting): the tree empties, the field keeps its text, caret and focus.
    let p0 = await paints()
    doorApi.attention.signal(a, 'done')
    await until('repainted by the event', async () => (await paints()) > p0 && (await page.locator('.rg-none').count()) === 1)
    assert.equal(await page.locator('.rg-none .rg-empty').textContent(), 'Nada com esse filtro')
    const fieldState = (): Promise<{ value: string; caret: number | null; focused: boolean }> => field.evaluate(e => {
      const i = e as unknown as { value: string; selectionStart: number | null; ownerDocument: { activeElement: unknown } }
      return { value: i.value, caret: i.selectionStart, focused: i.ownerDocument.activeElement === e }
    })
    assert.deepEqual(await fieldState(), { value: 'confer', caret: 4, focused: true }, 'the field survived the repaint')
    await until('the chips follow in place', chipsMatch)
    assert.equal((await shown()).counts.waiting, counts0.waiting - 1)
    // Esc clears the search; a second Esc folds the field into its icon; Esc in the tree clears the filter.
    await page.keyboard.press('Escape')
    await until('the search cleared', async () => (await fieldState()).value === '' && (await page.locator('.rg-tree .rg-pane').count()) === counts0.waiting - 1)
    assert.equal((await layout())?.filter, 'waiting', 'the filter stays')
    await page.keyboard.press('Escape')
    await until('the field folded', async () => !(await page.locator('.rg-search').isVisible()))
    assert.equal((await layout())?.filter, 'waiting', 'the filter still stays')
    await page.locator('.rg-tree [data-key][tabindex="0"]').focus()
    await page.keyboard.press('Escape')
    await until('the filter back to "Todos"', async () => (await layout())?.filter === 'all')
    assert.equal(await page.locator('.rg-chip[data-filter="all"]').getAttribute('aria-checked'), 'true')
    // A desk's name shows all its panes.
    await page.evaluate(q => window.__tether.ext.regency.search(q), desk2Name)
    await until('the desk by its name', async () => {
      const t = (await shown()).model.tree
      return t.some(d => d.target.id === desk2 && d.panes.some(p => p.target.id === b))
    })
    // Nothing found: the sentence and the way out.
    await page.evaluate(() => window.__tether.ext.regency.search('zzz-nada-assim'))
    await page.locator('.rg-none').waitFor()
    await page.click('.rg-none [data-action="clear-narrow"]')
    await until('cleared by the button', async () => (await fieldState()).value === '' && (await page.locator('.rg-tree .rg-desk').count()) >= 2)
    // The filter is kept with the pane; the search is not.
    await page.click('.rg-chip[data-filter="busy"]')
    await page.evaluate(() => window.__tether.ext.regency.search('confer'))
    await until('busy kept', async () => (await layout())?.filter === 'busy')
    await reopen()
    assert.equal((await layout())?.filter, 'busy', 'the filter survives reopening')
    assert.equal(await page.locator('.rg-search-in').inputValue(), '', 'the search does not')
    await page.click('.rg-chip[data-filter="all"]')
    await until('all', async () => (await layout())?.filter === 'all')
    assert.deepEqual((await state()).desk, DESK)

    // ---- 13. the tree's keyboard ----
    console.log('step 13')
    for (const id of [queueDesk, desk2]) assert.ok(!(await layout())!.collapsed.includes(id))
    await page.locator('.rg-tree [data-key][tabindex="0"]').focus()
    let rowKeys = await treeKeys()
    assert.equal(await focusedKey(), rowKeys[0])
    await page.keyboard.press('ArrowDown')
    assert.equal(await focusedKey(), rowKeys[1])
    assert.equal(await page.locator('.rg-tree [data-key][tabindex="0"]').getAttribute('data-key'), rowKeys[1], 'the tab stop follows')
    await page.keyboard.press('ArrowUp')
    assert.equal(await focusedKey(), rowKeys[0])
    await page.keyboard.press('End')
    assert.equal(await focusedKey(), rowKeys.at(-1))
    await page.keyboard.press('Home')
    assert.equal(await focusedKey(), rowKeys[0])
    // Left folds the desk, Right opens it, Right again enters it, Left climbs.
    const dk = `desk:${queueDesk}`
    await page.locator(`.rg-tree [data-key="${dk}"]`).focus()
    await page.keyboard.press('ArrowLeft')
    await until('folded by the key', async () => (await layout())?.collapsed.includes(queueDesk) === true)
    assert.equal(await focusedKey(), dk, 'the keyboard stays on the desk through the repaint')
    assert.equal(await page.locator(`.rg-tree [data-key="${dk}"]`).getAttribute('aria-expanded'), 'false')
    await page.keyboard.press('ArrowRight')
    await until('opened by the key', async () => (await layout())?.collapsed.includes(queueDesk) === false)
    await page.keyboard.press('ArrowRight')
    rowKeys = await treeKeys()
    assert.equal(await focusedKey(), rowKeys[rowKeys.indexOf(dk) + 1], 'Right enters the desk')
    assert.match((await focusedKey()) ?? '', /^pane:/)
    await page.keyboard.press('ArrowLeft')
    assert.equal(await focusedKey(), dk, 'Left climbs to the desk')
    // Space on a's pane: the quick view, the Regency stays.
    const ak = `pane:agent:${a}`
    await page.locator(`.rg-tree [data-key="${ak}"]`).focus()
    await page.keyboard.press(' ')
    await page.waitForSelector('#peek[data-open="true"]')
    assert.equal((await state()).desk, DESK, 'peeking does not leave the Regency')
    await page.click('#peek .peek-close')
    await page.waitForSelector('#peek', { state: 'hidden' })
    // Shift+F10 and the Menu key open the row's menu, anchored on the row; Esc gives the keyboard back to the row.
    await page.locator(`.rg-tree [data-key="${ak}"]`).focus()
    const asks = (): Promise<{ target: { kind: string; id: string }; anchor: string }[]> => page.evaluate(() => window.__tether.ext.regency.menuAsks())
    const menu = page.locator('#ctx-menu')
    const asked0 = (await asks()).length
    await page.keyboard.press('Shift+F10')
    await menu.waitFor()
    assert.equal((await asks()).length, asked0 + 1)
    assert.deepEqual((await asks()).at(-1), { target: { kind: 'agent', id: a }, anchor: ak })
    await page.keyboard.press('Escape')
    await menu.waitFor({ state: 'detached' })
    assert.equal(await focusedKey(), ak, 'Esc gives the keyboard back to the row')
    await page.keyboard.press('ContextMenu')
    await menu.waitFor()
    assert.deepEqual((await asks()).at(-1), { target: { kind: 'agent', id: a }, anchor: ak })
    await page.keyboard.press('Escape')
    await menu.waitFor({ state: 'detached' })
    assert.equal(await focusedKey(), ak, 'the row keeps the keyboard')
    // The focused row survives a repaint by an event, and so does the column's scroll.
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(1500, 400) })
    const right = page.locator('.rg-right')
    await until('the column scrolls', async () => right.evaluate(e => { const r = e as unknown as { scrollHeight: number; clientHeight: number }; return r.scrollHeight > r.clientHeight + 40 }))
    const bk = `pane:agent:${b}`
    await page.locator(`.rg-tree [data-key="${bk}"]`).focus()
    await right.evaluate(e => { (e as unknown as { scrollTop: number }).scrollTop = 40 })
    const top0 = await right.evaluate(e => (e as unknown as { scrollTop: number }).scrollTop)
    p0 = await paints()
    doorApi.attention.signal(a, 'waiting')
    await until('repainted by the event', async () => (await paints()) > p0)
    assert.equal(await focusedKey(), bk, 'the focused row survived the repaint')
    assert.equal(await right.evaluate(e => (e as unknown as { scrollTop: number }).scrollTop), top0, 'the scroll survived the repaint')
    assert.equal((await state()).desk, DESK, 'the event moved nothing')
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(1500, 900) })
    // A click on a row is the quick view (the default way to look); a second click on it closes the card; another row swaps it.
    const rowA = page.locator(`.rg-tree [data-key="${ak}"]`)
    const rowB = page.locator(`.rg-tree [data-key="${bk}"]`)
    const peekPaneOf = async (): Promise<unknown> => (await page.evaluate(() => window.__tether.peekState() as { pane?: string })).pane
    await rowA.click()
    await page.waitForSelector('#peek[data-open="true"]')
    await until('the card shows a', async () => (await peekPaneOf()) === a)
    assert.equal((await state()).desk, DESK, 'a click peeks, it does not go')
    assert.equal(await rowA.getAttribute('aria-current'), 'true', 'the row in the card is marked')
    assert.ok(await rowA.evaluate(e => e.classList.contains('rg-peeked')))
    assert.equal(await rowB.getAttribute('aria-current'), null, 'only that row')
    await rowB.click()
    await until('the card changes to b', async () => (await peekPaneOf()) === b)
    await until('the mark follows', async () => (await rowB.getAttribute('aria-current')) === 'true' && (await rowA.getAttribute('aria-current')) === null)
    assert.equal(await page.locator('#peek[data-open="true"]').count(), 1, 'one card')
    await rowB.click()
    await page.waitForSelector('#peek', { state: 'hidden' })
    await until('the mark goes with the card', async () => (await page.locator('.rg-tree [aria-current="true"]').count()) === 0)
    // The row's buttons and the double click: a button never opens the card; a double click goes to the tab.
    await rowA.hover()
    await rowA.locator('[data-action="row-menu"]').click()
    await page.locator('#ctx-menu').waitFor()
    await page.keyboard.press('Escape')
    await page.locator('#ctx-menu').waitFor({ state: 'detached' })
    assert.equal(await page.locator('#peek[data-open="true"]').count(), 0, 'the row\'s button does not open the card')
    await rowB.dblclick()
    await page.waitForFunction(d => window.__tether.activeDesk() === d, desk2)
    assert.equal(await page.locator('#peek[data-open="true"]').count(), 0, 'the double click leaves no card')
    await enter()
    // Enter goes to the pane: its desk comes forward.
    await page.locator(`.rg-tree [data-key="${bk}"]`).focus()
    await page.keyboard.press('Enter')
    await page.waitForFunction(d => window.__tether.activeDesk() === d, desk2)
    await enter()

    // The phone: the tools fit "Tether" as 44 px targets; the chips scroll sideways.
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(500, 860) })
    await until('the phone tier', async () => (await tier()) === 'mobile')
    await page.click('.rg-tab[data-tab="tether"]')
    await until('on "Tether"', async () => (await tab()) === 'tether')
    const heights = (sel: string): Promise<number[]> => page.locator(sel).evaluateAll(es => es.map(e => (e as unknown as { getBoundingClientRect(): { height: number } }).getBoundingClientRect().height))
    for (const sel of ['.rg-seg-b', '.rg-chip', '.rg-search-open', '.rg-tree .rg-act[data-action="row-menu"]']) {
      const boxes = await heights(sel)
      assert.ok(boxes.length > 0 && boxes.every(h => h >= 44), `${sel} is a 44 px target (${boxes.join(', ')})`)
    }
    // A row has one button on the phone, its "⋯": the rest are in its menu.
    assert.deepEqual([...new Set(await page.locator('.rg-tree .rg-act').evaluateAll(es => es.filter(e => (e as unknown as { getClientRects(): ArrayLike<unknown> }).getClientRects().length > 0)
      .map(e => (e as unknown as { dataset: { action: string } }).dataset.action)))], ['row-menu'], 'only the "⋯" shows on a row')
    // The chips: one line that scrolls sideways, its scrollbar shown; the last one ("Hibernando") is reached whole.
    const chipsBox = page.locator('.rg-chips')
    const chipsStyle = await chipsBox.evaluate(e => { const s = (globalThis as unknown as { getComputedStyle(x: unknown): { overflowX: string; scrollbarWidth: string } }).getComputedStyle(e); return [s.overflowX, s.scrollbarWidth] })
    assert.deepEqual(chipsStyle, ['auto', 'thin'], 'scrolls sideways with a visible scrollbar')
    await page.locator('.rg-chip[data-filter="asleep"]').scrollIntoViewIfNeeded()
    const lastAt = await page.locator('.rg-chip[data-filter="asleep"]').boundingBox()
    const rowAt = await chipsBox.boundingBox()
    assert.ok(lastAt && rowAt && lastAt.x + lastAt.width <= rowAt.x + rowAt.width + 1, `"Hibernando" whole once scrolled to (${JSON.stringify({ lastAt, rowAt })})`)
    await chipsBox.evaluate(e => { (e as unknown as { scrollLeft: number }).scrollLeft = 0 })
    assert.ok(await right.evaluate(e => { const r = e as unknown as { scrollWidth: number; clientWidth: number }; return r.scrollWidth <= r.clientWidth }), 'no sideways scroll of the column')
    await page.screenshot({ path: join(SHOTS, 'celular-tether.png') })
    // The search opens from its icon, a 44 px field.
    await page.click('.rg-search-open')
    await page.locator('.rg-search').waitFor()
    assert.ok((await heights('.rg-search')).every(h => h >= 44), 'the field is a 44 px target')
    await page.keyboard.press('Escape')
    await page.locator('.rg-search').waitFor({ state: 'hidden' })
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(1500, 900) })
    await until('the desktop tier', async () => (await tier()) === 'desktop')

    // Menu helpers: the open menu's own labels (a row's text without its kbd hint or its submenu), a pick by label.
    const items = menu.locator(':scope > li[role^=menuitem]')
    const labels = (): Promise<string[]> => items.evaluateAll(es => es.map(e => Array.from((e as unknown as { childNodes: ArrayLike<{ nodeType: number; textContent: string | null }> }).childNodes)
      .filter(n => n.nodeType === 3).map(n => n.textContent ?? '').join('').trim()))
    /** `opens`: the row opens another menu in the same place (the emblem's popover), so this one is not waited out. */
    const pick = async (label: string, opens = false): Promise<void> => {
      const i = (await labels()).indexOf(label)
      assert.ok(i >= 0, `"${label}" is in the menu: ${JSON.stringify(await labels())}`)
      await items.nth(i).click()
      if (!opens) await page.locator('#ctx-menu:not(.emb-menu)').waitFor({ state: 'detached' })
    }
    const closeMenu = async (): Promise<void> => { await page.keyboard.press('Escape'); await menu.waitFor({ state: 'detached' }) }
    /** The keyboard is in the Regency (nothing took it away), and the Regency is the desk in view. */
    const stays = async (what: string): Promise<void> => {
      assert.equal((await state()).desk, DESK, `${what}: the Regency stays in view`)
      // The repaint the gesture caused gives the keyboard back to the row on the next frame: allow it a moment.
      const where = async () => page.evaluate(() => {
        const e = document.activeElement as unknown as { closest(s: string): unknown; tagName: string; id: string; className: string } | null
        return { inside: !!e?.closest('.rg'), what: e ? `${e.tagName}#${e.id}.${String(e.className)}` : 'none' }
      })
      await until(`${what}: the keyboard in the Regency`, async () => (await where()).inside, 2_000)
        .catch(async () => { assert.fail(`${what}: the keyboard stays in the Regency (it is on ${(await where()).what})`) })
    }
    const treeDesk = async (id: string) => (await model()).tree.find(d => d.target.id === id)
    const treePaneOf = async (id: string) => (await model()).tree.flatMap(d => d.panes).find(p => p.target.id === id)
    const paneCount = async (): Promise<number> => (await model()).tree.reduce((n, d) => n + d.panes.length, 0)

    // ---- 14. the desk's menu: aimed at the row's desk, the Regency stays ----
    console.log('step 14')
    const dk2 = `desk:${desk2}`
    const desk2Row = page.locator(`.rg-tree [data-key="${dk2}"]`)
    // The right click.
    await desk2Row.click({ button: 'right' })
    await menu.waitFor()
    const deskLabels = await labels()
    console.log(`desk menu: ${JSON.stringify(deskLabels)}`)
    assert.equal(deskLabels.at(-1), 'Ir até a mesa', '"Ir até a mesa" last')
    for (const l of ['Renomear', 'Cor…', 'Mudar de lugar', 'Nova mesa antes', 'Nova mesa depois', 'Hibernar mesa', 'Fechar mesa…']) assert.ok(deskLabels.includes(l), `"${l}" in the desk menu`)
    assert.ok(deskLabels.some(l => /^(Dar|Assumir|Tirar a mesa|Revogar|Pausar)/.test(l)), 'the for-agents rows come along')
    await page.screenshot({ path: join(SHOTS, 'menu-mesa.png') })
    assert.equal(await focusedKey(), null, 'the menu has the keyboard')
    await page.screenshot({ path: join(SHOTS, 'r2-menu-mesa.png') })
    // "Renomear": a field in the row; a repaint by an event keeps it; Enter keeps the name; the keyboard back on the row.
    await pick('Renomear')
    const field2 = desk2Row.locator('.rg-rename')
    await field2.waitFor()
    assert.ok(await field2.evaluate(e => (e as unknown as { ownerDocument: { activeElement: unknown } }).ownerDocument.activeElement === e), 'the field has the keyboard')
    assert.equal(await page.evaluate(() => window.__tether.ext.regency.renaming()), dk2)
    await page.keyboard.press('Control+A')
    await page.keyboard.type('Obra nova')
    p0 = await paints()
    doorApi.attention.signal(a, 'done')
    await until('repainted by the event while renaming', async () => (await paints()) > p0)
    assert.equal(await field2.inputValue(), 'Obra nova', 'the field survived the repaint')
    await page.screenshot({ path: join(SHOTS, 'r2-renomear.png') })
    await page.keyboard.press('Enter')
    await until('the desk renamed', async () => (await treeDesk(desk2))?.name === 'Obra nova')
    assert.equal(await page.locator('.rg-rename').count(), 0)
    assert.equal(await focusedKey(), dk2, 'the keyboard back on the desk')
    await stays('rename')
    // Esc in the field keeps the old name.
    await desk2Row.click({ button: 'right' })
    await pick('Renomear')
    await field2.waitFor()
    await page.keyboard.type('zzz')
    await page.keyboard.press('Escape')
    await until('the field went', async () => (await page.locator('.rg-rename').count()) === 0)
    assert.equal((await treeDesk(desk2))?.name, 'Obra nova', 'Esc keeps the name')
    assert.equal(await focusedKey(), dk2)
    // "Nova mesa depois" (by the row's "⋯") creates without switching.
    const queueIds = async (): Promise<string[]> => (await model()).tree.filter(d => d.kind === 'queue').map(d => d.target.id)
    const q0 = await queueIds()
    await desk2Row.hover()
    await desk2Row.locator('[data-action="row-menu"]').click()
    await menu.waitFor()
    await pick('Nova mesa depois')
    await until('a new desk', async () => (await queueIds()).length === q0.length + 1)
    await stays('new desk')
    // Sleep and wake on the new desk (the fake agents never report their session: woken they would wait for the person's
    // choice, which is the tether's own question, out of this test). By the keyboard: the Menu key, "Hibernar mesa".
    const desk3 = (await queueIds()).find(id => !q0.includes(id))!
    const dk3 = `desk:${desk3}`
    const desk3Row = page.locator(`.rg-tree [data-key="${dk3}"]`)
    // A new desk holds only the core's empty placeholder: no pane line, a quiet "mesa vazia" with "+ nova guia".
    const desk3Group = page.locator(`.rg-group[data-desk="${desk3}"]`)
    await desk3Group.locator('.rg-vazia').waitFor()
    assert.equal(await desk3Group.locator('.rg-vazia-t').textContent(), 'mesa vazia')
    assert.equal(await desk3Group.locator('.rg-pane').count(), 0, 'the placeholder is not a pane')
    assert.equal((await treeDesk(desk3))?.paneCount, 0)
    assert.equal(await desk3Group.locator(`.rg-vazia-b[data-action="new-in:${desk3}"]`).count(), 1, '"+ nova guia" at its right')
    await page.screenshot({ path: join(SHOTS, 'mesa-vazia.png') })
    await desk3Row.focus()
    await page.keyboard.press('ContextMenu')
    await menu.waitFor()
    await pick('Hibernar mesa')
    await until('desk3 asleep', async () => (await treeDesk(desk3))?.asleep === true)
    await stays('sleep')
    await desk3Row.focus()
    await page.keyboard.press('Shift+F10')
    await menu.waitFor()
    assert.ok((await labels()).includes('Despertar mesa') && !(await labels()).includes('Hibernar mesa'), '"Despertar mesa" in place of "Hibernar mesa"')
    await pick('Despertar mesa')
    await until('desk3 awake by the menu', async () => (await treeDesk(desk3))?.asleep === false)
    await stays('wake by the menu')
    // The moon and the sun of the row (the buttons follow the state).
    await desk3Row.hover()
    await desk3Row.locator('[data-action="row-sleep"]').click()
    await until('asleep by the moon', async () => (await treeDesk(desk3))?.asleep === true)
    await desk3Row.hover()
    const sun = desk3Row.locator('[data-action="row-wake"]')
    assert.equal(await sun.isVisible(), true, 'the sun shows on hover')
    assert.match((await sun.getAttribute('aria-label')) ?? '', /^Despertar a mesa /)
    await sun.click()
    await until('awake by the sun', async () => (await treeDesk(desk3))?.asleep === false)
    await stays('wake by the sun')
    assert.equal(await focusedKey(), dk3, 'the button left the keyboard on its row')
    // Browser (empty, on the shelf) has the short menu.
    await page.locator('.rg-shelf-b[data-target="desk:browser.desk"]').click()
    await menu.waitFor()
    assert.deepEqual(await labels(), ['Ir até a mesa'])
    await closeMenu()
    await stays('Browser menu')

    // ---- 15. the pane's and the agent's menus ----
    console.log('step 15')
    // The agent's pane: the tab's menu, "Ir até a guia" last, no "Focar guia" on top, the agent's rows.
    const bk2 = `pane:agent:${b}`
    const bRow = page.locator(`.rg-tree [data-key="${bk2}"]`)
    await bRow.hover()
    assert.equal(await bRow.locator('[data-action="row-talk"]').isVisible(), true, '"Falar com" shows on an agent\'s row')
    await bRow.locator('[data-action="row-menu"]').click()
    await menu.waitFor()
    const agentLabels = await labels()
    console.log(`agent menu: ${JSON.stringify(agentLabels)}`)
    assert.equal(agentLabels.at(-1), 'Ir até a guia')
    assert.ok(!agentLabels.includes('Focar guia'), 'no "Focar guia" on top')
    for (const l of ['Renomear…', 'Hibernar guia', 'Fechar guia', 'Emblema…', 'Falar com bancada', 'O que bancada tem', 'Chamar para um canal…']) assert.ok(agentLabels.includes(l), `"${l}" in the agent's menu`)
    // R6, E: in blocks with a title; one close; Space beside "Espiar", nothing beside "Falar com".
    const heads = await menu.locator(':scope > li.hd').allTextContents()
    assert.equal(heads[0], 'O agente bancada')
    assert.ok(heads.includes('Esta guia'), JSON.stringify(heads))
    assert.ok(heads.some(h => h.startsWith('Quem manda aqui: ')), JSON.stringify(heads))
    assert.equal(agentLabels.filter(l => /^Fechar/.test(l)).length, 1, 'one close: "Fechar guia"')
    assert.equal(await items.filter({ hasText: /^Espiar/ }).locator('kbd').textContent(), 'Espaço')
    assert.equal(await items.filter({ hasText: /^Falar com bancada/ }).locator('kbd').count(), 0)
    const order = (l: string): number => agentLabels.indexOf(l)
    assert.ok(order('Falar com bancada') < order('Espiar') && order('Espiar') < order('Fechar guia') && order('Fechar guia') < order('Ir até a guia'), 'agent, then this tab, "Ir até a guia" last')
    await page.screenshot({ path: join(SHOTS, 'r2-menu-agente.png') })
    await page.screenshot({ path: join(SHOTS, 'menu-agente.png') })
    // "Renomear…" in the row: the slot's name.
    await pick('Renomear…')
    const bField = bRow.locator('.rg-rename')
    await bField.waitFor()
    await page.keyboard.press('Control+A')
    await page.keyboard.type('revisora')
    await page.keyboard.press('Enter')
    await until('the slot renamed', async () => {
      const p = await treePaneOf(b)
      return p?.title === 'revisora' || p?.identity?.name === 'revisora'
    })
    await stays('pane rename')
    // "Emblema…" opens the tab's popover.
    await bRow.click({ button: 'right' })
    await menu.waitFor()
    await pick('Emblema…', true)
    await page.waitForSelector('#ctx-menu.emb-menu')
    await closeMenu()
    await stays('emblem')
    // The agent a: "Falar com" peeks with the keyboard in its terminal; "O que conferente tem" turns the view.
    const aRow = page.locator(`.rg-tree [data-key="${ak}"]`)
    await aRow.click({ button: 'right' })
    await menu.waitFor()
    await pick('Falar com conferente')
    await page.waitForSelector('#peek[data-open="true"]')
    assert.equal((await state()).desk, DESK, 'talking does not leave the Regency')
    await page.waitForFunction(() => !!(document.activeElement as unknown as { closest(s: string): unknown } | null)?.closest('#peek .xterm'))
    await page.click('#peek .peek-close')
    await page.waitForSelector('#peek', { state: 'hidden' })
    // The row's "Falar com" button does the same.
    await aRow.hover()
    await aRow.locator('[data-action="row-talk"]').click()
    await page.waitForSelector('#peek[data-open="true"]')
    await page.click('#peek .peek-close')
    await page.waitForSelector('#peek', { state: 'hidden' })
    await aRow.click({ button: 'right' })
    await menu.waitFor()
    await pick('O que conferente tem')
    await until('by agent', async () => (await layout())?.view === 'agent')
    assert.equal(await focusedKey(), ak, 'the agent\'s group has the keyboard')
    assert.ok(!(await layout())!.collapsed.includes(a), 'its group is open')
    assert.equal(await page.locator(`.rg-agent[data-key="${bk2}"] .rg-own`).getAttribute('title'), 'Esta guia está numa mesa de conferente', 'the seal\'s tooltip has the whole text')
    await page.screenshot({ path: join(SHOTS, 'r2-por-agente.png') })
    await stays('what it has')
    await page.click('.rg-seg-b[data-view="desk"]')
    await until('by desk', async () => (await layout())?.view === 'desk')
    // The channel's tab (a pane without a slot): its menu, "Duplicar" of the agent b lands on its desk, nothing comes forward.
    const ck = `pane:pane:channel:${obra}`
    const cRow = page.locator(`.rg-tree [data-key="${ck}"]`)
    await cRow.click({ button: 'right' })
    await menu.waitFor()
    const paneLabels = await labels()
    console.log(`pane menu: ${JSON.stringify(paneLabels)}`)
    assert.equal(paneLabels.at(-1), 'Ir até a guia')
    assert.ok(!paneLabels.includes('Focar guia'))
    assert.ok(!paneLabels.includes('Fechar painel') && !paneLabels.includes('Fechar painel…'), 'no "Fechar painel" in the Regency')
    assert.equal(paneLabels.filter(l => l === 'Fechar guia').length, 1)
    assert.equal((await menu.locator(':scope > li.hd').allTextContents()).includes('Esta guia'), true)
    await page.screenshot({ path: join(SHOTS, 'r2-menu-guia.png') })
    await page.screenshot({ path: join(SHOTS, 'menu-guia.png') })
    await closeMenu()
    const n0 = await paneCount()
    const ids0 = await page.evaluate(() => window.__tether.panelIds())
    // The frame's gestures are the tab's, not the Regency's (R6, E): no "Duplicar", "Novo quadro" nor the status bar here.
    await bRow.click({ button: 'right' })
    await menu.waitFor()
    const frameless = await labels()
    for (const l of ['Duplicar painel à direita', 'Duplicar painel abaixo', 'Novo quadro…', 'Novo painel…', 'Mostrar barra de status', 'Fechar painel…']) assert.ok(!frameless.includes(l), `"${l}" is not in the Regency's menu`)
    await closeMenu()
    // A second pane on b's desk to close below ("+ Novo" makes it, as the person would now).
    const second = await page.evaluate(([d, cwd]) => window.__tether.ext.regency.create({ what: 'terminal', kind: 'shell', deskId: d!, cwd: cwd! }), [desk2, home] as const)
    assert.ok(second.ok, `the second pane was made (${second.text ?? ''})`)
    await until('the copy came', async () => (await paneCount()) === n0 + 1)
    const copy = (await page.evaluate(() => window.__tether.panelIds())).find(id => !ids0.includes(id))!
    assert.equal(await page.evaluate(p => window.__tether.deskOf(p), copy), desk2, 'on b\'s desk')
    await page.waitForTimeout(400)
    await stays('second pane')
    // "Mover…" the channel's tab to desk2.
    await cRow.click({ button: 'right' })
    await menu.waitFor()
    await pick('Mover…')
    await page.click(`dialog.move .mv-row.f[data-scope="${desk2}"]`)
    await page.locator('dialog.move .mv-pn .z-tab:not([aria-disabled="true"])').first().click()
    await page.click('#mv-go')
    await page.waitForFunction(([p, d]) => window.__tether.deskOf(p!) === d, [`channel:${obra}`, desk2] as const)
    assert.equal((await state()).desk, DESK, 'moving stays in the Regency')
    // "Hibernar guia", then "Despertar guia"; asleep, "Falar com" is off and says why, and the row has no "Falar com" button.
    await bRow.click({ button: 'right' })
    await menu.waitFor()
    await pick('Hibernar guia')
    await until('b asleep', async () => (await treePaneOf(b))?.asleep === true)
    await stays('pane sleep')
    await until('asleep, no "Falar com" button', async () => (await bRow.locator('[data-action="row-talk"]').count()) === 0)
    await bRow.click({ button: 'right' })
    await menu.waitFor()
    const asleepLabels = await labels()
    assert.ok(asleepLabels.includes('Despertar guia') && !asleepLabels.includes('Hibernar guia'), '"Despertar guia" in place of "Hibernar guia"')
    assert.ok(asleepLabels.some(l => /^Falar com .* \(hibernando\)$/.test(l)), 'asleep, "Falar com" says why')
    // The fake agent never reports its session: the start is refused 'unconfirmed' and the pane asks the person (the
    // tether's own question, the same as for-agents-flow step 9 meets). The refusal is not silent: the Regency says it in
    // a notice, and "Ir até a guia" takes the person to the pane, where the choice is asked.
    await pick('Despertar guia')
    const wakeNotice = page.locator('dialog[open]', { hasText: 'Esta guia precisa da sua escolha (retomar ou começar de novo) na própria guia.' })
    await wakeNotice.waitFor({ timeout: 10_000 })
    assert.equal((await state()).desk, DESK, 'pane wake: the Regency stays in view while the notice asks')
    await wakeNotice.locator('button.choice[data-choice="go"]').click()
    await until('"Ir até a guia" took the person to the pane', async () => (await state()).active === b)
    // Back to the Regency for the rest of the gestures.
    await page.evaluate(d => window.__tether.switchDesk(d), DESK)
    await page.waitForFunction(d => window.__tether.activeDesk() === d, DESK)
    await frames()
    // "Fechar guia" on the copy: its row goes, the keyboard goes to the row now in its place.
    const copyKey = (await treeKeys()).find(k => k.endsWith(`:${copy}`))!
    const copyRow = page.locator(`.rg-tree [data-key="${copyKey}"]`)
    await copyRow.focus()
    await page.keyboard.press('Shift+F10')
    await menu.waitFor()
    await pick('Fechar guia')
    // The process question of the pane: stop it (a duplicate of a fake agent).
    const stop = page.locator('dialog[open] button.choice[data-choice="stop"]')
    await stop.waitFor({ timeout: 5_000 }).then(() => stop.click(), () => {})
    await until('the copy\'s row went', async () => !(await treeKeys()).includes(copyKey))
    await until('the keyboard on the row in its place', async () => { const k = await focusedKey(); return k !== null && (await treeKeys()).includes(k) })
    await stays('close')

    // ---- 16. "Fechadas" ----
    console.log('step 16')
    await page.evaluate(() => { window.__tether.ext.regency.search(''); window.__tether.ext.regency.filter('all'); window.__tether.ext.regency.view('desk') })
    const closedCount = async (): Promise<number> => (await model()).closed.count
    const closedIds = (): Promise<string[]> => page.locator('.rg-cl[data-session]').evaluateAll(es => es.map(e => (e as unknown as { dataset: { session: string } }).dataset.session))
    const head = page.locator('.rg-cl-head')
    // Three fake agents end the way a person ends them: "Fechar guia" and stop the process, so the session has no tab.
    const ended: string[] = []
    for (const name of ['fechada-um', 'fechada-dois', 'fechada-tres']) {
      const id = await running(name)
      await page.waitForFunction(p => window.__tether.panelIds().includes(p), id)
      const row = page.locator(`.rg-tree [data-key="pane:agent:${id}"]`)
      await until(`${name} in the tree`, async () => (await row.count()) === 1)
      await row.focus()
      await page.keyboard.press('Shift+F10')
      await menu.waitFor()
      await pick('Fechar guia')
      const stopBtn = page.locator('dialog[open] button.choice[data-choice="stop"]')
      await stopBtn.waitFor({ timeout: 5_000 }).then(() => stopBtn.click(), () => {})
      await until(`${name}'s row went`, async () => (await row.count()) === 0)
      ended.push(id)
    }
    const [x1, x2, x3] = ended as [string, string, string]
    await until('the ended sessions are in "Fechadas"', async () => { const m = (await model()).closed; return m.count >= 3 })
    // Folded by default, with the count; nothing of it in the layout until the person opens it.
    assert.equal(await head.getAttribute('aria-expanded'), 'false')
    assert.equal(await page.locator('.rg-cl').count(), 0, 'folded: no lines')
    assert.ok(!(await layout())!.collapsed.includes('closed:open'))
    assert.match((await head.getAttribute('aria-label')) ?? '', /^Fechadas, \d+ sessões$/)
    await head.click()
    await until('opened', async () => (await head.getAttribute('aria-expanded')) === 'true')
    assert.ok((await layout())!.collapsed.includes('closed:open'), 'the open state is in the layout')
    await until('the lines', async () => (await page.locator('.rg-cl').count()) === (await closedCount()))
    // Each line: the agent's identity and how long ago it ended.
    const line = page.locator(`.rg-cl[data-session="${x1}"]`)
    assert.ok((await line.locator('.aid-name').textContent())?.includes('fechada-um'))
    assert.match((await line.locator('.rg-ago').textContent()) ?? '', /^(agora|há \d+ min)$/)
    // The ones that are not the test's are forgotten with the real gesture: "Esquecer…" asks first (and "Cancelar" keeps it).
    const forget = async (id: string, confirm: boolean): Promise<void> => {
      const r = page.locator(`.rg-cl[data-session="${id}"]`)
      await r.click({ button: 'right' })
      await menu.waitFor()
      assert.deepEqual((await labels()).filter(l => l !== ''), ['Reabrir em…', 'Esquecer…'])
      await pick('Esquecer…')
      const dlg = page.locator('dialog[open]', { hasText: 'Esquecer a sessão de' })
      await dlg.waitFor()
      if (!confirm) { await dlg.locator('button.cancel, button[data-choice="cancel"]').first().click(); await dlg.waitFor({ state: 'detached' }); return }
      await dlg.locator('button.choice[data-choice="forget"]').click()
      await until('forgotten', async () => !(await closedIds()).includes(id))
    }
    await forget(x3, false)
    assert.ok((await closedIds()).includes(x3), 'cancelled: still there')
    for (const id of (await closedIds()).filter(i => i !== x1 && i !== x2)) await forget(id, true)
    assert.deepEqual((await closedIds()).sort(), [x1, x2].sort())
    assert.equal(await closedCount(), 2)
    await page.locator(`.rg-tree [data-key="pane:agent:${a}"]`).scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(SHOTS, 'r2-fechadas.png') })
    // The search filters "Fechadas" and opens it by itself; a state filter empties it.
    await head.click()
    await until('folded', async () => (await head.getAttribute('aria-expanded')) === 'false')
    await page.evaluate(() => window.__tether.ext.regency.search('fechada-um'))
    await until('the search opened it with its match', async () => (await closedIds()).join() === x1)
    assert.match((await head.getAttribute('aria-label')) ?? '', /^Fechadas, 1 sessão$/)
    await page.evaluate(() => window.__tether.ext.regency.search(''))
    await until('the search ended: folded again', async () => (await page.locator('.rg-cl').count()) === 0)
    await page.evaluate(() => window.__tether.ext.regency.filter('busy'))
    await until('the filter empties it', async () => (await shown()).model.closed.count === 0)
    assert.equal(await page.locator('.rg-cl').count(), 0)
    assert.equal(await page.locator('.rg-cl-head.rg-cl-off').count(), 1)
    await page.evaluate(() => window.__tether.ext.regency.filter('all'))
    await until('back', async () => (await shown()).model.closed.count === 2)
    await head.click()
    await until('opened again', async () => (await page.locator('.rg-cl').count()) === 2)
    // Space on a line does nothing (no quick view of an ended session); the keyboard keeps its row through a repaint.
    const k1 = `closed:${x1}`
    await page.locator(`.rg-tree [data-key="${k1}"]`).focus()
    await page.keyboard.press(' ')
    await page.waitForTimeout(400)
    assert.equal(await page.locator('#peek[data-open="true"]').count(), 0, 'no peek of an ended session')
    assert.equal((await state()).desk, DESK)
    p0 = await paints()
    await page.evaluate(() => window.__tether.ext.regency.view('agent'))
    await until('repainted', async () => (await paints()) > p0)
    assert.equal(await focusedKey(), k1, 'the keyboard stayed on the line through the repaint')
    await page.evaluate(() => window.__tether.ext.regency.view('desk'))
    // "Reabrir em…" by Enter: the awake desks of the queue and "Nova mesa", nothing else.
    await page.locator(`.rg-tree [data-key="${k1}"]`).focus()
    await page.keyboard.press('Enter')
    await menu.waitFor()
    await pick('Reabrir em…')
    const pk = page.locator('.pk-list li.pk-item')
    await pk.first().waitFor()
    const tree0 = (await model()).tree.filter(d => d.kind === 'queue')
    const awake = tree0.filter(d => !d.asleep)
    const offered = await page.locator('.pk-list li.pk-item .pk-label').allTextContents()
    assert.deepEqual(offered.sort(), [...awake.map(d => d.name), 'Nova mesa'].sort(), 'awake desks, then "Nova mesa"')
    await page.screenshot({ path: join(SHOTS, 'r2-fechadas-reabrir.png') })
    // R6: the box is opaque with a shadow; the see-through look of r2-fechadas-reabrir was the 160 ms fade-in (pk-in) caught
    // mid-way: once it ends, the computed opacity is 1 and the background has no transparency.
    await page.waitForTimeout(400)
    const look = await page.evaluate(() => {
      const s = (globalThis as unknown as { getComputedStyle(e: unknown): { opacity: string; backgroundColor: string; boxShadow: string } }).getComputedStyle(document.querySelector('dialog.picker[open]'))
      return { opacity: s.opacity, bg: s.backgroundColor, shadow: s.boxShadow }
    })
    assert.equal(look.opacity, '1', JSON.stringify(look))
    assert.match(look.bg, /^rgb\(/, `an opaque background (${look.bg})`)
    assert.notEqual(look.shadow, 'none')
    await page.screenshot({ path: join(SHOTS, 'reabrir-em.png') })
    const target = awake.find(d => d.target.id !== queueDesk)!
    await pk.filter({ has: page.locator('.pk-label', { hasText: new RegExp(`^${target.name}$`) }) }).click()
    await until('reopened on the chosen desk', async () => (await page.evaluate(i => window.__tether.deskOf(i), x1)) === target.target.id)
    assert.equal((await state()).desk, DESK, 'reopening does not change desk')
    await until('the line left "Fechadas"', async () => !(await closedIds()).includes(x1))
    await until('its row is in the tree', async () => (await page.locator(`.rg-tree [data-key="pane:agent:${x1}"]`).count()) === 1)
    assert.equal(await page.locator(`.rg-tree [data-key="pane:agent:${x1}"]`).locator('xpath=ancestor::*[contains(@class,"rg-group")]').getAttribute('data-desk'), target.target.id, 'under the chosen desk')
    // "Nova mesa": the desk is made after the last one, the session goes there, the person stays.
    const desks0 = (await model()).tree.length
    await page.locator(`.rg-tree [data-key="closed:${x2}"]`).click({ button: 'right' })
    await menu.waitFor()
    await pick('Reabrir em…')
    await pk.first().waitFor()
    await pk.filter({ has: page.locator('.pk-label', { hasText: /^Nova mesa$/ }) }).click()
    await until('reopened on a new desk', async () => { const d = await page.evaluate(i => window.__tether.deskOf(i), x2); return d !== undefined && !tree0.some(t => t.target.id === d) })
    assert.equal((await state()).desk, DESK, 'the new desk did not take the person')
    await until('the desk is in the tree', async () => (await model()).tree.length === desks0 + 1)
    await until('"Fechadas" is empty', async () => (await closedCount()) === 0)
    assert.equal(await page.locator('.rg-cl-empty').textContent(), 'Nenhuma sessão fechada')
    await stays('reopen')

    // ---- 17. the quick view docked over the conversation (V2) ----
    console.log('step 17')
    type Peek = { open: boolean; pane?: string; paneLent?: boolean; mode?: string }
    const peekState = (): Promise<Peek> => page.evaluate(() => window.__tether.peekState() as Peek)
    const loanOf = (id: string): Promise<string | undefined> => page.evaluate(i => window.__tether.paneLoan(i).state, id)
    const rectOf = (sel: string): Promise<{ left: number; top: number; right: number; bottom: number } | undefined> => page.evaluate(s => {
      const r = (document.querySelector(s) as unknown as { getBoundingClientRect(): { left: number; top: number; right: number; bottom: number } } | null)?.getBoundingClientRect()
      return r ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : undefined
    }, sel)
    const countOf = (sel: string): Promise<number> => page.locator(sel).count()
    await page.evaluate(() => { window.__tether.ext.regency.search(''); window.__tether.ext.regency.filter('all'); window.__tether.ext.regency.view('desk') })
    await page.evaluate(i => window.__tether.ext.regency.select(i), obra)
    await until('the centre shows obra', async () => (await embed(obra))?.loaded === true)
    // Space on a's row: the card docks over the conversation, a's live terminal in it; the keyboard stays on the row.
    const aKey = `pane:agent:${a}`
    await page.locator(`.rg-tree [data-key="${aKey}"]`).focus()
    await page.keyboard.press(' ')
    await page.waitForSelector('#peek[data-open="true"][data-mode="docked"]')
    await page.waitForSelector('#peek .peek-pane > .panel-body .xterm')
    const p17 = await peekState()
    assert.deepEqual({ open: p17.open, pane: p17.pane, paneLent: p17.paneLent, mode: p17.mode }, { open: true, pane: a, paneLent: true, mode: 'docked' })
    assert.equal(await focusedKey(), aKey, 'the keyboard stays on the row')
    assert.equal((await state()).desk, DESK, 'the Regency stays')
    assert.equal(await countOf('[data-inert-onscreen]'), 0, 'docked: nothing behind is inert')
    const centre = (await rectOf('.rg-center'))!
    const card = (await rectOf('#peek .peek-card'))!
    assert.ok(card.left >= centre.left && card.right <= centre.right + 0.5 && card.top >= centre.top && card.bottom <= centre.bottom, `the card sits over the conversation: ${JSON.stringify({ card, centre })}`)
    assert.equal(await page.locator('#peek .qv-head .qv-type').textContent(), 'agente')
    assert.equal(await page.locator('#peek .qv-foot .qv-go').textContent(), 'Ir até a guia')
    // One state: the card's header says what a's line in the tree says (and "Esperam você" lists a exactly when it waits).
    const cardState = (): Promise<string> => page.locator('#peek .qv-head .peek-state').evaluate(e => (e as unknown as { hidden: boolean; textContent: string | null }).hidden ? '' : (e as unknown as { textContent: string | null }).textContent ?? '')
    const lineState = async (): Promise<string> => (await page.locator(`.rg-tree [data-key="${aKey}"] .rg-st`).count()) ? (await page.locator(`.rg-tree [data-key="${aKey}"] .rg-st`).textContent()) ?? '' : ''
    doorApi.attention.signal(a, 'waiting')
    await until('card and line both say "espera você"', async () => (await cardState()) === 'espera você' && (await lineState()) === 'espera você')
    assert.ok((await model()).waiting.some(x => x.target.id === a), '"Esperam você" lists it')
    // A turn done (the card said "pede atenção" here): the card and the line agree, and nothing waits. (A pane in view may
    // clear its "done" at once: then both say "livre"; the point is that they say the same.)
    doorApi.attention.signal(a, 'done')
    await until('card and line agree on the turn done', async () => {
      const c = await cardState()
      return c !== 'espera você' && c === (await lineState()) && ['terminou', 'livre'].includes(c)
    })
    assert.ok(!(await model()).waiting.some(x => x.target.id === a), 'and "Esperam você" does not list it')
    await page.screenshot({ path: join(SHOTS, 'r3-cartao-regencia-terminal.png') })
    // The conversation stays usable: the box takes text and sends with the card open; Esc there is the box's.
    const box17 = page.locator(`.rg-center .ch-pane[data-channel="${obra}"] .ch-composer-slot textarea`)
    await box17.click()
    await box17.fill('Falo com o cartão aberto.')
    await page.keyboard.press('Enter')
    await until('the line went with the card open', async () => (await embed(obra))?.rows.some(r => r.text === 'Falo com o cartão aberto.' && r.mine) === true)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
    assert.equal((await peekState()).open, true, 'Esc in the box does not close the card')
    // Space on b's row: the card shows b, a goes back to its tab whole.
    const bKey = `pane:agent:${b}`
    await page.locator(`.rg-tree [data-key="${bKey}"]`).focus()
    await page.keyboard.press(' ')
    await until('the card shows b', async () => (await peekState()).pane === b)
    assert.equal(await loanOf(a), 'home', 'a is back in its tab')
    // (b may be a background tab of its frame, its shell out of the DOM: the loan is read off the shell.)
    assert.equal(await loanOf(b), 'lent', 'b in the card')
    assert.equal(await countOf('#peek[data-open="true"]'), 1, 'one card')

    // ---- 17b. "Ampliar" / "Reduzir" and moving the docked card (R7b) ----
    console.log('step 17b')
    await page.waitForSelector('#peek .peek-pane .xterm')
    const R7 = join(SHOTS, '..', 'r7')
    mkdirSync(R7, { recursive: true })
    const card17 = async (): Promise<{ left: number; top: number; right: number; bottom: number }> => (await rectOf('#peek .peek-card'))!
    const sizeOf = (): Promise<string | null> => page.evaluate(() => document.querySelector('#peek')!.getAttribute('data-size'))
    const near = (a: number, b: number, what: string): void => assert.ok(Math.abs(a - b) <= 1.5, `${what}: ${a} vs ${b}`)
    const sizeBtn = page.locator('#peek .qv-head .qv-size')
    assert.equal(await sizeBtn.isVisible(), true, 'desktop: the card has "Ampliar"')
    assert.equal(await sizeBtn.getAttribute('aria-label'), 'Ampliar')
    assert.match((await sizeBtn.getAttribute('title')) ?? '', /^Ampliar/)
    assert.equal(await sizeBtn.getAttribute('aria-pressed'), 'false')
    assert.equal(await page.locator('#peek .peek-card').getAttribute('data-movable'), 'true', 'the docked card moves on the desktop')
    // The live terminal is marked: the same node, and the loan never given back, through every size and every drag.
    await page.evaluate(() => { (document.querySelector('#peek .peek-pane .xterm') as unknown as Record<string, unknown>).r7mark = 'b' })
    const sameTerm = (): Promise<boolean> => page.evaluate(() => (document.querySelector('#peek .peek-pane .xterm') as unknown as Record<string, unknown> | null)?.r7mark === 'b')
    const lendEvents = await countOf('.peek-lent')
    const docked17 = await card17()
    await page.screenshot({ path: join(R7, 'cartao-ancorado.png') })
    // Ampliar: the modal card's box inside the Regency (16 px), over the conversation, no veil.
    await sizeBtn.click()
    await until('the card is large', async () => (await sizeOf()) === 'large')
    const rg = (await rectOf('.rg'))!
    const large17 = await card17()
    near(large17.left, rg.left + 16, 'large left'); near(large17.top, rg.top + 16, 'large top')
    near(large17.right, rg.right - 16, 'large right'); near(large17.bottom, rg.bottom - 16, 'large bottom')
    assert.equal(await countOf('[data-inert-onscreen]'), 0, 'large: nothing behind is inert')
    assert.equal(await sizeBtn.getAttribute('aria-label'), 'Reduzir')
    assert.equal(await sizeBtn.getAttribute('aria-pressed'), 'true')
    assert.equal(await page.locator('#peek .peek-card').getAttribute('data-movable'), 'false', 'the large card does not move')
    assert.ok(await sameTerm(), 'large: the same live terminal (not remounted)')
    assert.equal(await loanOf(b), 'lent', 'large: b still lent')
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(R7, 'cartao-ampliado.png') })
    // No moving the large card: a drag on its header leaves it where it is.
    const title17 = async (): Promise<{ x: number; y: number }> => { const r = (await page.locator('#peek .qv-head .peek-title').boundingBox())!; return { x: r.x + Math.min(20, r.width / 2), y: r.y + r.height / 2 } }
    const dragBy = async (dx: number, dy: number): Promise<void> => {
      const p = await title17()
      await page.mouse.move(p.x, p.y)
      await page.mouse.down()
      await page.mouse.move(p.x + Math.sign(dx) * 2, p.y, { steps: 2 })
      await page.mouse.move(p.x + dx, p.y + dy, { steps: 10 })
      await page.mouse.up()
    }
    await dragBy(-200, 80)
    assert.deepEqual(await card17(), large17, 'the large card did not move')
    // Reduzir by the button: back to the docked box, the same terminal.
    await sizeBtn.click()
    await until('the card is docked again', async () => (await sizeOf()) === 'docked')
    assert.deepEqual(await card17(), docked17, 'reduced: back to its place')
    assert.ok(await sameTerm(), 'reduced: the same live terminal')
    // Esc in the large card's header reduces (it does not close); Esc again closes nothing yet: we keep it open below.
    await sizeBtn.click()
    await until('large again', async () => (await sizeOf()) === 'large')
    await sizeBtn.focus()
    await page.keyboard.press('Escape')
    await until('Esc reduced the large card', async () => (await sizeOf()) === 'docked')
    assert.equal((await peekState()).open, true, 'Esc on the large card reduces, it does not close')
    assert.deepEqual(await card17(), docked17)
    // Esc in the terminal is the agent's: the large card stays large.
    await sizeBtn.click()
    await until('large for the terminal Esc', async () => (await sizeOf()) === 'large')
    await page.locator('#peek .peek-pane textarea.xterm-helper-textarea').focus()
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
    assert.equal(await sizeOf(), 'large', 'Esc in the terminal is the content\'s')
    await sizeBtn.click()
    await until('docked before the drag', async () => (await sizeOf()) === 'docked')
    // A press that travels less than the threshold is not a drag: nothing moves.
    const press0 = await title17()
    await page.mouse.move(press0.x, press0.y); await page.mouse.down(); await page.mouse.move(press0.x + 2, press0.y + 1); await page.mouse.up()
    assert.deepEqual(await card17(), docked17, 'under the threshold nothing moves')
    // The drag: the card follows the pointer, the click that ends it does not reach anything.
    await dragBy(-300, 120)
    const moved17 = await card17()
    near(moved17.left, docked17.left - 300, 'moved left'); near(moved17.top, docked17.top + 120, 'moved top')
    assert.equal((await peekState()).open, true, 'the drag did not close the card')
    assert.ok(await sameTerm(), 'moved: the same live terminal')
    assert.equal(await page.locator('#peek .peek-card').getAttribute('data-dragging'), null, 'the drag ended')
    await page.waitForTimeout(200)
    await page.screenshot({ path: join(R7, 'cartao-movido.png') })
    // Held inside the Regency: a drag far past its edge stops at the margin.
    await dragBy(-3000, 3000)
    const held = await card17()
    assert.ok(held.left >= rg.left + 11.5 && held.bottom <= rg.bottom - 11.5, `the card stays in the Regency: ${JSON.stringify({ held, rg })}`)
    // A double click on the header puts it back.
    const pd = await title17()
    await page.mouse.dblclick(pd.x, pd.y)
    await until('back in its place', async () => JSON.stringify(await card17()) === JSON.stringify(docked17))
    // Ampliar and Reduzir after a drag: back in its place too.
    await dragBy(-150, 60)
    assert.notDeepEqual(await card17(), docked17)
    await sizeBtn.click()
    await until('large after a drag', async () => (await sizeOf()) === 'large')
    await sizeBtn.click()
    await until('docked after a drag', async () => (await sizeOf()) === 'docked')
    assert.deepEqual(await card17(), docked17, 'a size change undoes the drag')
    // Large, then closed by ✕ and opened again: small and in its place (nothing persists between openings).
    await dragBy(-150, 60)
    await sizeBtn.click()
    await until('large before closing', async () => (await sizeOf()) === 'large')
    await page.click('#peek .qv-close')
    await page.waitForSelector('#peek', { state: 'hidden' })
    assert.equal(await loanOf(b), 'home', 'b went home on close')
    await page.locator(`.rg-tree [data-key="${bKey}"]`).focus()
    await page.keyboard.press(' ')
    await until('b in the card again', async () => (await peekState()).pane === b && (await sizeOf()) === 'docked')
    // (the card opens with a short scale-in: read its box once it has settled)
    await until('reopened: small and in its place', async () => JSON.stringify(await card17()) === JSON.stringify(docked17))
    assert.equal(await countOf('.peek-lent'), lendEvents, 'one notice in b\'s tab, as before')
    // Moved, then another pane swapped in: the card goes back to its place (a's card).
    await dragBy(-150, 60)
    await page.locator(`.rg-tree [data-key="${aKey}"]`).focus()
    await page.keyboard.press(' ')
    await until('a in the card', async () => (await peekState()).pane === a)
    assert.deepEqual(await card17(), docked17, 'a swap puts the card back in its place')
    await page.locator(`.rg-tree [data-key="${bKey}"]`).focus()
    await page.keyboard.press(' ')
    await until('b in the card for the close', async () => (await peekState()).pane === b)
    await page.locator(`.rg-tree [data-key="${bKey}"]`).focus()

    // Esc on the row that opened it closes; b goes back whole.
    await page.keyboard.press('Escape')
    await page.waitForSelector('#peek', { state: 'hidden' })
    assert.equal(await loanOf(b), 'home', 'b is back in its tab')
    assert.equal(await countOf('.peek-lent'), 0)
    assert.equal(await countOf('.peek-tab-eye'), 0)
    assert.equal(await focusedKey(), bKey, 'the keyboard on the row')
    // A note of a queue desk, by Space; closed by its ✕.
    const notePath = join(home, 'regencia.md')
    writeFileSync(notePath, '# Regência\n\n- [x] árvore\n- [ ] visão rápida em toda guia\n')
    await page.evaluate(q => window.__tether.switchDesk(q), queueDesk)
    await page.waitForFunction(q => window.__tether.activeDesk() === q, queueDesk)
    await page.evaluate(p => window.__tether.openNote(p), notePath)
    await page.waitForFunction(() => window.__tether.notes().length === 1)
    const noteId = await page.evaluate(() => window.__tether.notes()[0]!.id)
    await enter()
    const nKey = `pane:pane:${noteId}`
    await until('the note in the tree', async () => (await countOf(`.rg-tree [data-key="${nKey}"]`)) === 1)
    await page.locator(`.rg-tree [data-key="${nKey}"]`).focus()
    await page.keyboard.press(' ')
    await page.waitForSelector('#peek[data-mode="docked"] .peek-pane > .note-panel .monaco-editor')
    assert.equal(await page.locator('#peek .qv-head .qv-type').textContent(), 'nota')
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(SHOTS, 'r3-cartao-regencia-nota.png') })
    await page.click('#peek .peek-close')
    await page.waitForSelector('#peek', { state: 'hidden' })
    assert.equal(await loanOf(noteId), 'home', 'the note is back in its tab')
    await stays('quick view')
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
