// E2E of the Regency's "+ Novo" (slice R4f): a tetherd in this process on a private home and pipe, with the channels
// extension's record and requests on its door and two fake `claude` agents (test/fixtures/channels/agent.cjs, no LLM); the real
// app on the same pipe, hidden window at 1500 px. Nothing touches the person's tether. In every case the person stays on the
// Regency (the visible desk never changes) and the new row glows and takes the keyboard.
//   1. a terminal by "+ Novo" in a desk chosen in "Onde" (r4-novo-o-que, r4-novo-onde, r4-depois-de-criar);
//   2. an agent (fake claude) in "Mesa nova…", joining a channel, all by the keyboard (r4-novo-detalhes-agente); Esc goes back
//      a step and, on the first, closes, the keyboard back on "+ Novo";
//   3. the desk row's "+" (and "Nova guia nesta mesa" in its menu): "Onde" is skipped; a note is born on that desk;
//   4. a channel with an agent: it opens in the centre, no channel tab is born; with the quick view open, "+ Novo" closes it first;
//   5. a browser tab for an agent on a desk: born the agent's, the shield up (the agent holds it);
//   6. "Dar uma mesa nova…" in an agent's menu: one step, the desk made and given (the owner's seal), the agent's tab not moved
//      (r4-dar-mesa-nova);
//   7. a failure in the middle (a folder that does not exist): the card says what was made and what not, "Entendi" closes;
//   8. at 420 px the card is a sheet from the bottom, 44 px targets (r4-novo-celular).
// Run alone: node --test --test-force-exit --test-concurrency=1 test/e2e/app.regency-create.test.ts   (one E2E at a time: the build is remade)
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
import { USER } from '../../extensions/channels/rules.ts'
import type { RegencyModel } from '../../extensions/regency/model.ts'
import type { RegencyLayout } from '../../extensions/regency/renderer/layout-rules.ts'
import type { CreateViewSnapshot } from '../../extensions/regency/renderer/create-view.ts'
import { removeHome, tempHome, uniquePipe, waitUntil } from '../unit/daemon.helpers.ts'
import { killElectron } from './electron.ts'

type Hooks = {
  panelIds(): string[]
  activeDesk(): string
  deskOf(id: string): string | undefined
  createDesk(side: 'before' | 'after', relativeTo?: string): string
  runCommand(id: string): Promise<string>
  desks(): { id: string; name: string; panes: string[] }[]
  notes(): { id: string }[]
  browserPanes(): { id: string; tabId?: string; owner?: string; control: string }[]
  ext: {
    regency: {
      model(): RegencyModel
      layout(): RegencyLayout | undefined
      tier(): string | undefined
      quickView(t: { kind: string; id: string }): void
      menu(key: string): boolean
      createView(): CreateViewSnapshot
      lastRun(): { acts: string[]; ok: boolean; done: number; text?: string; made: { deskId?: string; paneId?: string; channelId?: string } } | undefined
    }
  }
}
declare const window: { __tether: Hooks; innerWidth: number; innerHeight: number }
type El = { dataset: Record<string, string | undefined>; getBoundingClientRect(): { left: number; right: number; top: number; bottom: number; width: number; height: number }; classList: { contains(c: string): boolean } }
declare const document: { activeElement: El | null; querySelector(s: string): El | null; querySelectorAll(s: string): El[] }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const AGENT = fileURLToPath(new URL('../fixtures/channels/agent.cjs', import.meta.url))
const SHOTS = 'C:/atrium/.tmp/tether-agents/onda-3/mesa-regencia/capturas'
const DESK = 'regency.main'
const PANE = 'regency:main'
const CARD = 'dialog.rg-cr[open]'

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
  await page.waitForFunction(() => typeof window.__tether.ext?.regency?.createView === 'function')
  return { app, page }
}

test('regency: "+ Novo" creates without leaving the Regency', { timeout: 480_000 }, async () => {
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
      return id
    }
    const a = await running('conferente')
    const b = await running('bancada')
    const made = await ch.create(USER, { name: 'obra', title: 'Obra' })
    assert.ok(made.ok)
    const obra = made.channel.id

    let page: Page
    ;({ app, page } = await launch(home, pipe))
    for (const id of [a, b]) await page.waitForFunction(p => window.__tether.panelIds().includes(p), id)
    const model = (): Promise<RegencyModel> => page.evaluate(() => window.__tether.ext.regency.model())
    const view = (): Promise<CreateViewSnapshot> => page.evaluate(() => window.__tether.ext.regency.createView())
    const lastRun = () => page.evaluate(() => window.__tether.ext.regency.lastRun())
    const deskOf = (id: string): Promise<string | undefined> => page.evaluate(i => window.__tether.deskOf(i), id)
    const until = async (what: string, fn: () => Promise<boolean>, ms = 15_000): Promise<void> => {
      const end = Date.now() + ms
      while (Date.now() < end) { if (await fn()) return; await page.waitForTimeout(100) }
      throw new Error(`timeout: ${what}`)
    }
    const queueDesk = await page.evaluate(() => window.__tether.activeDesk())
    const desk2 = await page.evaluate(q => window.__tether.createDesk('after', q), queueDesk)
    await page.evaluate(d => window.__tether.runCommand(`desk.system.${d}`), DESK)
    await page.waitForFunction(d => window.__tether.activeDesk() === d, DESK)
    await page.waitForFunction(p => window.__tether.panelIds().includes(p), PANE)
    await until('the tree shows desk 2', async () => (await model()).tree.some(d => d.target.id === desk2))

    /** The Regency stays the visible desk and the keyboard is inside it (or in the card). */
    const stays = async (what: string): Promise<void> => {
      assert.equal(await page.evaluate(() => window.__tether.activeDesk()), DESK, `${what}: the visible desk did not change`)
    }
    /** The row of `id` glows and has the keyboard. */
    const lit = async (target: string, what: string): Promise<void> => {
      await until(`${what}: the new row has the keyboard`, async () => (await page.evaluate(() => document.activeElement?.dataset.target ?? '')) === target)
      assert.equal(await page.locator(`.rg-tree [data-target="${target}"]`).first().evaluate(e => (e as unknown as El).classList.contains('rg-fresh')), true, `${what}: the new row glows`)
    }
    const rowTarget = async (paneId: string): Promise<string> => {
      const m = await model()
      for (const d of m.tree) for (const p of d.panes) if (p.target.id === paneId) return `${p.target.kind}:${p.target.id}`
      return `pane:${paneId}`
    }
    const next = (): Promise<void> => page.click(`${CARD} [data-do="next"]`)
    /** The card closed after "Criar" (a sentence told instead fails with the sentence). */
    const closedOk = async (what: string): Promise<void> => {
      await until(`${what}: the card closed or told`, async () => { const v = await view(); return !v.open || v.phase === 'told' }, 30_000)
      const v = await view()
      assert.equal(v.open, false, `${what}: the card told "${v.told ?? ''}"`)
    }

    // ---- 1. a terminal in desk 2, chosen in "Onde" ----
    console.log('step 1')
    await page.click('.rg-new')
    await page.waitForSelector(CARD)
    assert.deepEqual((await view()).steps, ['what', 'where', 'details'])
    assert.equal(await page.locator(`${CARD} [data-do="tile"]`).count(), 6, 'six tiles: four in a desk, two in the tether')
    await page.waitForTimeout(250)
    await page.screenshot({ path: join(SHOTS, 'r4-novo-o-que.png') })
    await page.click(`${CARD} [data-do="tile"][data-arg="terminal"]`)
    await until('on "Onde"', async () => (await view()).step === 'where')
    await next()
    await until('"Escolha a mesa." beside the list', async () => (await page.locator(`${CARD} [data-field="desk"] .rg-cr-err`).textContent()) === 'Escolha a mesa.')
    await page.check(`${CARD} input[data-f="desk"][value="${desk2}"]`)
    await page.screenshot({ path: join(SHOTS, 'r4-novo-onde.png') })
    await next()
    await until('on "Detalhes"', async () => (await view()).step === 'details')
    const norm = (p: string | undefined): string => (p ?? '').replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()
    assert.equal(norm((await view()).draft.cwd), norm(home), 'the folder comes ready (the project of the agents)')
    await next()
    await page.waitForSelector(CARD, { state: 'detached' })
    let run = await lastRun()
    assert.ok(run?.ok, `the terminal was made (${run?.text ?? ''})`)
    const term = run!.made.paneId!
    assert.equal(await deskOf(term), desk2, 'born in desk 2')
    await stays('terminal')
    await lit(await rowTarget(term), 'terminal')
    await page.screenshot({ path: join(SHOTS, 'r4-depois-de-criar.png') })

    // ---- 2. an agent in "Mesa nova…", joining #obra, all by the keyboard; Esc goes back ----
    console.log('step 2')
    await page.locator('.rg-new').focus()
    await page.keyboard.press('Enter')
    await page.waitForSelector(CARD)
    // Esc: from "Onde" back to "O quê", then closed, the keyboard back on "+ Novo".
    await page.keyboard.press('Tab')
    await until('the terminal tile has the keyboard', async () => (await page.evaluate(() => document.activeElement?.dataset.arg ?? '')) === 'terminal')
    await page.keyboard.press('Enter')
    await until('on "Onde"', async () => (await view()).step === 'where')
    await page.keyboard.press('Escape')
    await until('back on "O quê"', async () => (await view()).step === 'what')
    await page.keyboard.press('Escape')
    await page.waitForSelector(CARD, { state: 'detached' })
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.action ?? ''), 'new', 'the keyboard is back on "+ Novo"')
    await page.keyboard.press('Enter')
    await page.waitForSelector(CARD)
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.arg ?? ''), 'agent', 'the first tile has the keyboard')
    await page.keyboard.press('Enter')
    await page.waitForSelector('dialog.picker[open]')
    await page.keyboard.type('claude')
    await page.keyboard.press('Enter')
    await page.waitForSelector('dialog.picker[open]', { state: 'detached' })
    await until('on "Onde" with the agent chosen', async () => { const v = await view(); return v.step === 'where' && v.draft.kind === 'claude' })
    const radios = await page.locator(`${CARD} input[data-f="desk"]`).count()
    for (let i = 1; i < radios; i++) await page.keyboard.press('ArrowDown')
    await until('"Mesa nova…" chosen', async () => (await view()).draft.deskId === 'new')
    await page.keyboard.press('Tab')
    await page.keyboard.type('Prova')
    await page.keyboard.press('Enter')
    await until('on "Detalhes"', async () => (await view()).step === 'details')
    await page.keyboard.press('ArrowDown')
    await until('#obra chosen', async () => (await view()).draft.joinChannel === obra)
    await page.screenshot({ path: join(SHOTS, 'r4-novo-detalhes-agente.png') })
    await page.keyboard.press('Enter')
    await page.waitForSelector(CARD, { state: 'detached' })
    run = await lastRun()
    assert.ok(run?.ok, `the agent was made (${run?.text ?? ''})`)
    assert.deepEqual(run!.acts, ['desk', 'slot', 'join'])
    const agent = run!.made.paneId!
    const prova = run!.made.deskId!
    assert.equal((await model()).tree.find(d => d.target.id === prova)?.name, 'Prova', 'the new desk has its name')
    assert.equal(await deskOf(agent), prova, 'the agent is in the new desk')
    await until('the agent is a member of #obra', async () => ch.store.get(obra)?.members[agent] !== undefined)
    await stays('agent')
    await lit(`agent:${agent}`, 'agent')

    // ---- 3. the desk row's "+": "Onde" is skipped; a note in that desk ----
    console.log('step 3')
    const deskRow = page.locator(`.rg-tree [data-key="desk:${desk2}"]`)
    await deskRow.hover()
    await deskRow.locator('[data-action="row-new"]').click()
    await page.waitForSelector(CARD)
    assert.deepEqual((await view()).steps, ['what', 'details'], 'no "Onde"')
    assert.equal(await page.locator(`${CARD} [data-do="tile"]`).count(), 4, 'only what lives in a desk')
    assert.match(await page.locator(`${CARD} .rg-cr-title`).textContent() ?? '', /Nova guia em/)
    await page.click(`${CARD} [data-do="tile"][data-arg="note"]`)
    await until('on "Detalhes"', async () => (await view()).step === 'details')
    const notesBefore = (await page.evaluate(() => window.__tether.notes())).length
    await next()
    await page.waitForSelector(CARD, { state: 'detached' })
    run = await lastRun()
    assert.ok(run?.ok, `the note was made (${run?.text ?? ''})`)
    const note = run!.made.paneId!
    assert.equal((await page.evaluate(() => window.__tether.notes())).length, notesBefore + 1)
    assert.equal(await deskOf(note), desk2, 'the note is in that desk')
    await stays('note')
    await lit(await rowTarget(note), 'note')
    // The same card from the desk's menu.
    assert.ok(await page.evaluate(k => window.__tether.ext.regency.menu(k), `desk:${desk2}`))
    await page.locator('#ctx-menu').waitFor()
    await page.locator('#ctx-menu').getByText('Nova guia nesta mesa', { exact: true }).click()
    await page.waitForSelector(CARD)
    assert.deepEqual((await view()).steps, ['what', 'details'])
    await page.keyboard.press('Escape')
    await page.waitForSelector(CARD, { state: 'detached' })

    // ---- 4. a channel with an agent: the centre; the quick view closes first ----
    console.log('step 4')
    await page.evaluate(id => window.__tether.ext.regency.quickView({ kind: 'agent', id }), a)
    await page.waitForSelector('#peek[data-open="true"]')
    await page.click('.rg-new')
    await page.waitForSelector(CARD)
    await page.waitForSelector('#peek[data-open="true"]', { state: 'detached' }).catch(async () => {
      assert.equal(await page.locator('#peek[data-open="true"]').count(), 0, 'the quick view closed before the card')
    })
    await page.click(`${CARD} [data-do="tile"][data-arg="channel"]`)
    await until('on "Detalhes"', async () => (await view()).step === 'details')
    await next()
    await until('"Dê um nome ao canal." beside the name', async () => (await page.locator(`${CARD} [data-field="channel-name"] .rg-cr-err`).textContent()) === 'Dê um nome ao canal.')
    await page.fill(`${CARD} input[data-f="channel-name"]`, 'revisao')
    await page.click(`${CARD} [data-do="members"]`)
    await page.waitForSelector('dialog.picker[open]')
    await page.keyboard.type('conferente')
    await page.keyboard.press('Enter')
    await page.waitForSelector('dialog.picker[open]', { state: 'detached' })
    await until('conferente chosen', async () => (await view()).draft.channel?.members?.includes(a) === true)
    await next()
    await page.waitForSelector(CARD, { state: 'detached' })
    run = await lastRun()
    assert.ok(run?.ok, `the channel was made (${run?.text ?? ''})`)
    const revisao = run!.made.channelId!
    await until('the centre shows #revisao', async () => (await page.evaluate(() => window.__tether.ext.regency.layout()))?.channelId === revisao)
    assert.ok(!(await page.evaluate(() => window.__tether.panelIds())).includes(`channel:${revisao}`), 'no channel tab was born')
    assert.ok(ch.store.get(revisao)?.members[a] !== undefined, 'conferente is in it')
    await stays('channel')

    // ---- 5. a browser tab for an agent, on desk 2: born the agent's, shield up ----
    console.log('step 5')
    await page.click('.rg-new')
    await page.waitForSelector(CARD)
    await page.click(`${CARD} [data-do="tile"][data-arg="browser"]`)
    await page.check(`${CARD} input[data-f="desk"][value="${desk2}"]`)
    await next()
    await until('on "Detalhes"', async () => (await view()).step === 'details')
    await page.check(`${CARD} input[data-f="for"][value="${a}"]`)
    await next()
    await closedOk('browser')
    run = await lastRun()
    assert.ok(run?.ok, `the tab was made (${run?.text ?? ''})`)
    const web = run!.made.paneId!
    assert.match(web, /^web:/)
    assert.equal(await deskOf(web), desk2, 'on desk 2, not on Browser')
    await until('born the agent\'s, the agent holds it (shield up)', async () => {
      const p = (await page.evaluate(() => window.__tether.browserPanes())).find(x => x.id === web)
      return p?.owner === a && p.control === 'agent'
    })
    await stays('browser')

    // ---- 6. "Dar uma mesa nova…" in an agent's menu ----
    console.log('step 6')
    const bKey = `pane:agent:${b}`
    await until('b in the tree', async () => (await page.locator(`.rg-tree [data-key="${bKey}"]`).count()) === 1)
    assert.ok(await page.evaluate(k => window.__tether.ext.regency.menu(k), bKey))
    await page.locator('#ctx-menu').waitFor()
    await page.locator('#ctx-menu').getByText('Dar uma mesa nova…', { exact: true }).click()
    await page.waitForSelector(CARD)
    let v = await view()
    assert.deepEqual(v.steps, ['details'], 'one step')
    assert.equal(v.draft.movePane, false, '"Levar a guia" unticked (P6)')
    assert.equal(await page.locator(`${CARD} input[data-f="move"]`).isChecked(), false)
    assert.equal(await page.locator(`${CARD} input[data-f="give"]`).isChecked(), true)
    await page.fill(`${CARD} input[data-f="desk-name"]`, 'Prova-web')
    await page.click(`${CARD} [data-do="color"][data-arg="teal"]`)
    await page.screenshot({ path: join(SHOTS, 'r4-dar-mesa-nova.png') })
    const bDesk = await deskOf(b)
    await next()
    await page.waitForSelector(CARD, { state: 'detached' })
    run = await lastRun()
    assert.ok(run?.ok, `the desk was made and given (${run?.text ?? ''})`)
    const pw = run!.made.deskId!
    await until('the owner\'s seal on the new desk', async () => (await page.locator(`.rg-tree [data-key="desk:${pw}"] .rg-own`).count()) === 1)
    assert.equal((await model()).tree.find(d => d.target.id === pw)?.owner, 'bancada')
    assert.equal(await deskOf(b), bDesk, 'the agent\'s tab stayed where it was')
    await stays('give a desk')
    await lit(`desk:${pw}`, 'give a desk')

    // ---- 7. a failure in the middle: a folder that does not exist ----
    console.log('step 7')
    await page.click('.rg-new')
    await page.waitForSelector(CARD)
    await page.click(`${CARD} [data-do="tile"][data-arg="terminal"]`)
    await page.check(`${CARD} input[data-f="desk"][value="new"]`)
    await page.fill(`${CARD} input[data-f="desk-name"]`, 'Falha')
    await next()
    await until('on "Detalhes"', async () => (await view()).step === 'details')
    await page.click(`${CARD} [data-do="folder"]`)
    await page.waitForSelector('dialog.picker[open]')
    const missing = join(home, 'nao-existe', 'mesmo')
    await page.keyboard.type(missing)
    await page.keyboard.press('Enter')
    await page.waitForSelector('dialog.picker[open]', { state: 'detached' })
    await until('the folder typed', async () => (await view()).draft.cwd === missing)
    await next()
    await until('the card tells', async () => (await view()).phase === 'told')
    v = await view()
    assert.match(v.told ?? '', /^Criei a mesa «Falha»\. Mas não consegui criar o terminal: .+ O que já foi feito ficou\.$/)
    assert.equal(await page.locator(`${CARD} .rg-cr-told[role="alert"]`).count(), 1)
    await page.keyboard.press('Enter')
    await page.waitForSelector(CARD, { state: 'detached' })
    const falha = (await lastRun())!.made.deskId!
    assert.equal((await model()).tree.find(d => d.target.id === falha)?.name, 'Falha', 'the desk made stays')
    await stays('failure')

    // ---- 8. the phone: a sheet from the bottom ----
    console.log('step 8')
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(420, 820) })
    await until('the phone tier', async () => (await page.evaluate(() => window.__tether.ext.regency.tier())) === 'mobile')
    await page.click('.rg-tab[data-tab="tether"]')
    await page.click('.rg-new')
    await page.waitForSelector(`${CARD}[data-tier="mobile"]`)
    await page.waitForTimeout(300)
    const geo = await page.evaluate(() => {
      const r = document.querySelector('dialog.rg-cr[open]')!.getBoundingClientRect()
      const tile = document.querySelector('dialog.rg-cr[open] [data-do="tile"]')!.getBoundingClientRect()
      const btn = document.querySelector('dialog.rg-cr[open] [data-do="next"]')!.getBoundingClientRect()
      return { left: r.left, right: r.right, bottom: r.bottom, w: window.innerWidth, h: window.innerHeight, tile: tile.height, btn: btn.height }
    })
    assert.ok(Math.abs(geo.bottom - geo.h) <= 1, `the sheet sits on the bottom (${geo.bottom} of ${geo.h})`)
    assert.ok(geo.left <= 1 && Math.abs(geo.right - geo.w) <= 1, 'the whole width')
    assert.ok(geo.tile >= 44 && geo.btn >= 44, `44 px targets (${geo.tile}, ${geo.btn})`)
    await page.screenshot({ path: join(SHOTS, 'r4-novo-celular.png') })
    await page.click(`${CARD} [data-do="tile"][data-arg="desk"]`)
    await until('on "Detalhes"', async () => (await view()).step === 'details')
    assert.equal(await page.locator(`${CARD} .rg-cr-up`).isVisible(), true, 'the "‹" on top')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await page.waitForSelector(CARD, { state: 'detached' })
    await stays('phone')
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
