// E2E of the channel commands, the picker and the menus (slice U2): a tetherd in this process on a private home and pipe, with the
// channels extension's record and requests on its door and three fake `claude` agents (test/fixtures/channels/agent.cjs, no LLM);
// the real app on the same pipe, hidden window. Nothing touches the person's tether.
//   1. "Abrir canal…" without an argument opens the picker: the active desk's channel featured, the others with the members' count;
//      Enter opens the pane; the same command with an argument skips the picker; opening again brings the same pane forward;
//   2. "Juntar" in two steps (channel, then the agents outside it); with an argument it acts at once;
//   3. "Calar" and "Tirar" ask first and say the consequence; cancelling changes nothing; "Devolver a voz" acts at once;
//   4. "Juntar a um canal…" in the tab menu of an agent; "Abrir o canal da mesa" in the pill's menu of the desk that has one
//      (and not in the other's); "Encerrar canal…" in the channel's tab (not in the desk channel's); "Reabrir canal" after.
// Run alone: node --test test/e2e/app.channels-commands.test.ts   (one E2E at a time: the build is remade)
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
import { USER } from '../../extensions/channels/rules.ts'
import { removeHome, tempHome, uniquePipe, waitUntil } from '../unit/daemon.helpers.ts'
import { killElectron } from './electron.ts'

type Hooks = {
  panelIds(): string[]
  activate(slotId: string): void
  activeDesk(): string
  switchDesk(id: string): void
  ext: { channels: { run(id: string, arg?: unknown): void } }
}
declare const window: { __tether: Hooks }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const AGENT = fileURLToPath(new URL('../fixtures/channels/agent.cjs', import.meta.url))
const SHOTS = 'C:/atrium/.tmp/tether-agents/onda-3/u2'

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

test('channel commands: picker, two steps, confirmations and menus', { timeout: 420_000 }, async () => {
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
    const c = await running('extra')
    const nameA = ch.nameOf(a), nameB = ch.nameOf(b), nameC = ch.nameOf(c)

    // The record: the desk's channel (desk-1, owner a), a common channel with b, and a closed one.
    const desk = await ch.desk.open('desk-1', { name: 'obra', title: 'Obra', owner: a, panes: [a, b] })
    assert.ok(desk.ok)
    const deskId = desk.channel.id
    const made = await ch.create(USER, { name: 'conferencia', title: 'Conferência' })
    assert.ok(made.ok)
    const conf = made.channel.id
    assert.ok((await ch.join(USER, conf, b)).ok)
    const old = await ch.create(USER, { name: 'revisao' })
    assert.ok(old.ok)
    assert.ok((await ch.close(USER, old.channel.id)).ok)

    let page: Page
    ;({ app, page } = await launch(home, pipe))
    await page.waitForFunction(() => typeof window.__tether.ext?.channels?.run === 'function')
    for (const id of [a, b, c]) await page.waitForFunction(p => window.__tether.panelIds().includes(p), id)
    const run = (id: string, arg?: unknown): Promise<void> => page.evaluate(([i, x]) => window.__tether.ext.channels.run(i as string, x), [id, arg] as const)
    const picker = page.locator('dialog.picker[open]')
    const rows = page.locator('dialog.picker li.pk-item')
    const title = (): Promise<string> => page.locator('dialog.picker .pk-title').innerText()
    const noPicker = async (): Promise<void> => { assert.equal(await picker.count(), 0, 'no picker') }
    const ask = (situation: string) => page.locator(`dialog.ask[data-dialog="${situation}"]`)
    const members = (id: string) => ch.store.get(id)!.members
    const closeMenu = async (): Promise<void> => { await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.getElementById('ctx-menu')) }
    const menuLabels = (): Promise<string[]> => page.locator('#ctx-menu li').allInnerTexts().then(ts => ts.map(t => t.trim()))

    // ---- 1. open: the picker (the desk's channel featured, the count of members), then the argument skips it ----
    console.log('step 1')
    await run('channels.open')
    await picker.waitFor()
    assert.equal(await title(), 'Abrir canal')
    assert.equal(await page.locator('dialog.picker li.pk-sep').count(), 1, 'a rule sets the featured row apart')
    const texts = await rows.allInnerTexts()
    assert.match(texts[0]!, /#obra/, 'the desk\'s channel is on top')
    assert.match(texts[0]!, /canal da mesa · \d+ membros? · dono: /)
    const conferencia = texts.find(t => t.includes('#conferencia'))!
    assert.match(conferencia, /1 membro · dono: Você/)
    assert.ok(texts.find(t => t.includes('#revisao'))?.includes('encerrado'), 'the closed one is listed apart in "Abrir canal…"')
    assert.equal(await page.locator('dialog.picker li.pk-item.selected').innerText().then(t => t.includes('#obra')), true, 'the featured row is the selected one')
    await page.screenshot({ path: join(SHOTS, 'seletor-abrir.png') })
    await page.keyboard.press('Enter')
    await page.waitForFunction(p => window.__tether.panelIds().includes(p), `channel:${deskId}`)
    await picker.waitFor({ state: 'detached' })
    await run('channels.open', { channel: 'conferencia' })
    await page.waitForFunction(p => window.__tether.panelIds().includes(p), `channel:${conf}`)
    await noPicker()
    const panesBefore = (await page.evaluate(() => window.__tether.panelIds())).filter(p => p.startsWith('channel:')).length
    await run('channels.open', { channel: deskId })
    await page.waitForTimeout(400)
    assert.equal((await page.evaluate(() => window.__tether.panelIds())).filter(p => p.startsWith('channel:')).length, panesBefore, 'one channel, one pane (P3)')

    // ---- 2. join: two steps; with an argument it acts at once ----
    console.log('step 2')
    // An agent's pane is the active one: no channel pane, so the command asks which channel (with a channel pane active it would not).
    await page.evaluate(p => window.__tether.activate(p), a)
    await run('channels.join')
    await picker.waitFor()
    assert.equal(await title(), 'Chamar agente a que canal?')
    assert.match((await rows.allInnerTexts())[0]!, /#obra/, 'the desk\'s channel on top')
    assert.equal((await rows.allInnerTexts()).some(t => t.includes('#revisao')), false, 'closed channels are not offered to join')
    await page.locator('dialog.picker li.pk-item', { hasText: '#conferencia' }).click()
    await page.waitForFunction(() => document.querySelector('dialog.picker .pk-title')?.textContent === 'Chamar para #conferencia')
    const second = await rows.allInnerTexts()
    assert.equal(second.length, 2, 'only the agents outside the channel')
    assert.ok(second.every(t => !t.includes('bancada')), 'bancada is in already')
    await page.locator('dialog.picker li.pk-item', { hasText: nameA }).click() // in the many box a click marks
    await page.keyboard.press('Enter')
    await waitUntil(() => a in members(conf), 10_000, 'a joined by the picker')
    await run('channels.join', { channel: conf, agent: c })
    await waitUntil(() => c in members(conf), 10_000, 'c joined by the argument')
    await noPicker()

    // ---- 3. mute and remove ask first; unmute acts at once ----
    console.log('step 3')
    await run('channels.mute', { channel: conf, agent: b })
    await ask('channels.mute').waitFor()
    assert.match(await ask('channels.mute').innerText(), /continua ouvindo tudo/)
    await page.screenshot({ path: join(SHOTS, 'confirmacao-calar.png') })
    await page.keyboard.press('Escape')
    await ask('channels.mute').waitFor({ state: 'detached' })
    assert.equal(members(conf)[b]!.muted, undefined, 'cancelled: nothing changed')
    await run('channels.mute', { channel: conf, agent: b })
    await ask('channels.mute').waitFor()
    await ask('channels.mute').locator('button.choice[data-choice="mute"]').click()
    await waitUntil(() => members(conf)[b]?.muted !== undefined, 10_000, 'b muted')
    await run('channels.unmute', { channel: conf, agent: b })
    await waitUntil(() => members(conf)[b]?.muted === undefined, 10_000, 'b has the voice back')
    await noPicker()
    assert.equal(await ask('channels.unmute').count(), 0)

    await run('channels.remove')
    await picker.waitFor() // (the agent's pane is still the active one)
    await page.locator('dialog.picker li.pk-item', { hasText: '#conferencia' }).click()
    await page.waitForFunction(() => document.querySelector('dialog.picker .pk-title')?.textContent === 'Tirar de #conferencia')
    assert.equal((await rows.allInnerTexts()).length, 3, 'every member of the channel')
    await page.locator('dialog.picker li.pk-item', { hasText: nameC }).click()
    await ask('channels.remove').waitFor()
    assert.match(await ask('channels.remove').innerText(), new RegExp(`Tirar ${nameC.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} de #conferencia\\?`))
    assert.match(await ask('channels.remove').innerText(), /recebe um aviso da sala/)
    await page.screenshot({ path: join(SHOTS, 'confirmacao-tirar.png') })
    await ask('channels.remove').locator('button.choice[data-choice="remove"]').click()
    await waitUntil(() => !(c in members(conf)) && (ch.store.get(conf)!.removed ?? []).includes(c), 10_000, 'c removed')

    // ---- 4. the menus ----
    console.log('step 4')
    await page.keyboard.press('Control+Shift+N')
    await page.waitForFunction(() => window.__tether.activeDesk() === 'desk-2')
    await page.evaluate(() => window.__tether.switchDesk('desk-1'))
    await page.waitForFunction(() => window.__tether.activeDesk() === 'desk-1')

    // ---- 4a. G5: the join's list in groups: the active desk, the other desk, "tirado deste canal" on the one taken out ----
    console.log('step 4a')
    // The daemon learns the new desk from the app's map a moment after the keystroke.
    let d = ''
    for (let i = 0; d === '' && i < 40; i++) {
      try { d = (await doorApi.slots.create({ kind: 'claude', cwd: home, name: 'pesquisa', desk: 'desk-2' })).slotId } catch { await page.waitForTimeout(250) }
    }
    assert.notEqual(d, '', 'the daemon knows desk-2')
    // A pane of a desk out of view is not drawn yet: look at the desk until the agent runs, then come back.
    await page.evaluate(() => window.__tether.switchDesk('desk-2'))
    await page.waitForFunction(() => window.__tether.activeDesk() === 'desk-2')
    await waitUntil(() => doorApi.slots.get(d)?.status === 'running', 30_000, `pesquisa running (now ${doorApi.slots.get(d)?.status}; panels ${d})`)
    await page.evaluate(() => window.__tether.switchDesk('desk-1'))
    await page.waitForFunction(() => window.__tether.activeDesk() === 'desk-1')
    await run('channels.join', { channel: conf })
    await picker.waitFor()
    await page.waitForFunction(() => document.querySelectorAll('dialog.picker li.pk-item').length >= 2, undefined, { timeout: 10_000 })
    assert.equal(await title(), 'Chamar para #conferencia')
    const groups = await page.locator('dialog.picker li.pk-group').allInnerTexts()
    assert.match(groups[0]!, /^nesta mesa · /i, `the active desk first: ${groups.join(' | ')}`)
    assert.match(groups[1]!, /^mesa · /i, `then the other desk: ${groups.join(' | ')}`)
    const joinRows = await rows.allInnerTexts()
    assert.ok(joinRows[0]!.includes('tirado deste canal'), `the one taken out is marked: ${joinRows.join(' | ')}`)
    await page.waitForTimeout(400) // the picker's opening fade
    await page.screenshot({ path: 'C:/atrium/.tmp/tether-agents/onda-3/gestao/g5-juntar.png' })

    // ---- 4a2. G6: mark two with Space and join both at once; one request each, no dialog when all go through ----
    console.log('step 4a2')
    const outsiders = joinRows.length
    assert.ok(outsiders >= 2, 'two agents outside the channel')
    await page.keyboard.press('Space')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Space')
    assert.equal(await page.locator('dialog.picker li.pk-item.marked').count(), 2, 'two rows marked')
    await page.screenshot({ path: 'C:/atrium/.tmp/tether-agents/onda-3/gestao/g6-juntar-varios.png' })
    const before = Object.keys(members(conf)).length
    await page.keyboard.press('Enter')
    await picker.waitFor({ state: 'detached' })
    await waitUntil(() => Object.keys(members(conf)).length === before + 2, 10_000, 'two joined at once')
    await noPicker()

    const tabOf =(id: string) => page.locator(`.tether-tab[data-slot="${id}"]`)
    await tabOf(b).waitFor()
    await tabOf(b).click({ button: 'right' })
    await page.waitForSelector('#ctx-menu li')
    assert.ok((await menuLabels()).includes('Chamar para um canal…'), `the agent's tab menu: ${(await menuLabels()).join(' | ')}`)
    await page.screenshot({ path: join(SHOTS, 'menu-aba-agente.png') })
    await page.locator('#ctx-menu li', { hasText: 'Chamar para um canal…' }).click()
    await picker.waitFor()
    assert.equal(await title(), 'Chamar agente a que canal?')
    await page.keyboard.press('Escape')
    await picker.waitFor({ state: 'detached' })

    await page.click('#desk-switch .seg[data-desk="desk-1"]', { button: 'right' })
    await page.waitForSelector('#ctx-menu li')
    assert.ok((await menuLabels()).includes('Abrir o canal da mesa (#obra)'), `the pill menu of the desk with a channel: ${(await menuLabels()).join(' | ')}`)
    await page.screenshot({ path: join(SHOTS, 'menu-pilula.png') })
    await closeMenu()
    await page.click('#desk-switch .seg[data-desk="desk-2"]', { button: 'right' })
    await page.waitForSelector('#ctx-menu li')
    assert.ok(!(await menuLabels()).some(l => l.startsWith('Abrir o canal da mesa')), 'a desk without a channel has no such row')
    await closeMenu()

    // The channel's own tab: close it (with a dialog), reopen it; the desk's channel has neither.
    const chanTab = (id: string) => page.locator('.ch-tab', { hasText: id === deskId ? '#obra' : '#conferencia' }).first()
    await chanTab(deskId).click({ button: 'right' })
    await page.waitForSelector('#ctx-menu li')
    assert.ok(!(await menuLabels()).some(l => l.startsWith('Encerrar canal') || l.startsWith('Reabrir canal')), 'the desk channel is never closed by hand')
    await closeMenu()
    await chanTab(conf).click({ button: 'right' })
    await page.waitForSelector('#ctx-menu li')
    assert.ok((await menuLabels()).includes('Encerrar canal…'))
    await page.locator('#ctx-menu li', { hasText: 'Encerrar canal…' }).click()
    await ask('channels.close').waitFor()
    assert.match(await ask('channels.close').innerText(), /fica só para leitura/)
    await ask('channels.close').locator('button.choice[data-choice="close"]').click()
    await waitUntil(() => ch.store.get(conf)!.closed !== undefined, 10_000, 'conferencia closed')
    await chanTab(conf).click({ button: 'right' })
    await page.waitForSelector('#ctx-menu li')
    assert.ok((await menuLabels()).includes('Reabrir canal'))
    await closeMenu()
    await run('channels.reopen', { channel: conf })
    await ask('channels.reopen').waitFor()
    assert.match(await ask('channels.reopen').innerText(), /volta a aceitar falas/)
    await ask('channels.reopen').locator('button.choice[data-choice="reopen"]').click()
    await waitUntil(() => ch.store.get(conf)!.closed === undefined, 10_000, 'conferencia reopened')
    // Without an argument "Reabrir" lists the closed ones (the desk's never).
    await page.evaluate(p => window.__tether.activate(p), a)
    await run('channels.reopen')
    await picker.waitFor()
    assert.deepEqual((await page.locator('dialog.picker li.pk-item .pk-label').allInnerTexts()).map(t => t.trim()), ['#revisao'])
    await page.keyboard.press('Escape')
    await picker.waitFor({ state: 'detached' })

    // With the channel's pane active, a command without `channel` skips the channel step: "Calar em #conferencia" at once (G8).
    await run('channels.open', { channel: 'conferencia' })
    await page.waitForFunction(p => window.__tether.panelIds().includes(p), `channel:${conf}`)
    await run('channels.mute')
    await picker.waitFor()
    assert.equal(await title(), 'Calar em #conferencia')
    await page.keyboard.press('Escape')
    await picker.waitFor({ state: 'detached' })

    // ---- 5. create without an argument: the picker asks for the name ----
    console.log('step 5')
    await run('channels.create')
    await picker.waitFor()
    assert.equal(await title(), 'Criar canal')
    assert.equal(await page.locator('dialog.picker .pk-empty').innerText(), 'Digite o nome do novo canal.')
    await page.keyboard.type('Nova Sala!')
    assert.equal(await page.locator('dialog.picker li.pk-item .pk-label').innerText(), 'Criar #Nova Sala!')
    assert.match(await page.locator('dialog.picker li.pk-item .pk-detail').innerText(), /minúsculas, números e hífen/)
    await page.screenshot({ path: join(SHOTS, 'seletor-criar.png') })
    await page.keyboard.press('Enter')
    await ask('channels.failed').waitFor()
    assert.match(await ask('channels.failed').innerText(), /O tetherd respondeu: .*bad-name/)
    await page.screenshot({ path: join(SHOTS, 'criar-recusado.png') })
    await ask('channels.failed').locator('button.choice[data-choice="ok"]').click()
    assert.equal(ch.store.channels().some(x => x.name === 'Nova Sala!'), false)
    await run('channels.create')
    await picker.waitFor()
    await page.keyboard.type('sala-nova')
    await page.keyboard.press('Enter')
    await waitUntil(() => ch.store.channels().some(x => x.name === 'sala-nova'), 10_000, 'sala-nova created')
    const novo = ch.store.channels().find(x => x.name === 'sala-nova')!
    assert.equal(novo.owner.kind, 'user')
    await page.waitForFunction(p => window.__tether.panelIds().includes(p), `channel:${novo.id}`)
    // Esc leaves it as it was.
    await run('channels.create')
    await picker.waitFor()
    await page.keyboard.type('outra')
    await page.keyboard.press('Escape')
    await picker.waitFor({ state: 'detached' })
    assert.equal(ch.store.channels().some(x => x.name === 'outra'), false)
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
