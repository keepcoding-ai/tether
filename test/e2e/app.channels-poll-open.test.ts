// E2E of opening a poll from the screen (slice E4): a tetherd in this process on a private home and pipe, with the channels extension's
// record and requests on its door and three fake `claude` agents (no LLM); the real app on the same pipe, hidden window.
//   1. the "Enquete" button opens the form above the box; the defaults (ok / não ok, every agent, 10 min, nobody else); the draft of the
//      box stays; an empty question is told before asking; Enter opens: the poll is the person's, the three fake agents get the request,
//      the form goes and the focus is back in the box with the draft; Esc cancels and gives the focus back;
//   2. `/enquete` typed in the box opens the same form (and is not a speech); a choice of 3 options, a deadline of 1 minute, one agent
//      taken out, "incluir você": the poll has those, the one left out gets no request, she votes by the card (E3), the agents vote: it closes;
//   3. the palette's command opens it too; the tether refuses (she owes a vote: `vote-first`): the warning shows in the form, nothing typed
//      is lost, and after she votes the same form opens the poll;
//   4. the channel's "⋯" menu has "Abrir enquete…".
// Run alone: node --test test/e2e/app.channels-poll-open.test.ts   (one E2E at a time: the build is remade)
// Every kill goes through test/kill.ts (pid + creation time); the daemon here is closed in-process.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
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
import { createChannels, type Channels, type ChannelsApi, type PollClock } from '../../extensions/channels/daemon/fanout.ts'
import { registerChannelRequests } from '../../extensions/channels/daemon/requests.ts'
import { openStore } from '../../extensions/channels/daemon/store.ts'
import { USER } from '../../extensions/channels/rules.ts'
import type { PaneSnapshot } from '../../extensions/channels/renderer/channel-pane.ts'
import { removeHome, tempHome, uniquePipe, waitUntil } from '../unit/daemon.helpers.ts'
import { killElectron } from './electron.ts'

type Hooks = {
  ext: { channels: {
    open(channelId: string, name?: string): void
    view(channelId: string): PaneSnapshot | undefined
    run(id: string, arg?: unknown): void
  } }
}
declare const window: { __tether: Hooks }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const AGENT = fileURLToPath(new URL('../fixtures/channels/agent.cjs', import.meta.url))
const SHOTS = 'C:/atrium/.tmp/tether-agents/onda-3/poll/e4'

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

test('channel pane: opening a poll from the screen (button, /enquete, palette, menu; defaults; choice; refusal; focus)', { timeout: 480_000 }, async () => {
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
  // The clock of the deadlines starts at the real time; the poll's `closesAt` is read against it.
  const base = Date.now()
  const clock: PollClock = { now: () => Date.now(), set: fn => fn, clear: () => undefined }
  const ch: Channels = createChannels(api, await openStore(fsIo, home), clock)
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
    const c = await running('conferencia')
    const made = await ch.create(USER, { name: 'obra', title: 'Obra' })
    assert.ok(made.ok)
    const id = made.channel.id
    for (const m of [a, b, c]) assert.ok((await ch.join(USER, id, m)).ok)
    const nameA = ch.nameOf(a), nameB = ch.nameOf(b), nameC = ch.nameOf(c)
    assert.ok((await ch.say(a, id, { body: 'Começando a revisão.' })).ok)

    /** The requests of a poll that reached a fake agent (what its stream logged). */
    const requestsOf = (slot: string, seq: number): Array<{ content: string; meta: Record<string, string> }> => {
      const f = join(home, `chan-${slot}.log`)
      if (!existsSync(f)) return []
      return readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as { method?: string; params?: { content: string; meta: Record<string, string> } })
        .filter(n => n.method === 'notifications/claude/channel' && n.params?.meta.kind === 'request' && n.params.meta.ref === `obra#${seq}`).map(n => n.params!)
    }
    const polls = (): Record<string, { type: string; options: string[]; to: Array<{ id: string }>; closesAt: string; author: { id: string }; question: string }> =>
      (ch.store.get(id)!.polls ?? {}) as never

    let page: Page
    ;({ app, page } = await launch(home, pipe))
    await page.waitForFunction(() => typeof window.__tether.ext?.channels?.open === 'function')
    const view = (): Promise<PaneSnapshot | undefined> => page.evaluate(i => window.__tether.ext.channels.view(i), id)
    const waitView = async (what: string, fn: (v: PaneSnapshot) => boolean, ms = 15_000): Promise<PaneSnapshot> => {
      const end = Date.now() + ms
      for (;;) {
        const s = await view()
        if (s !== undefined && fn(s)) return s
        if (Date.now() > end) throw new Error(`timeout: ${what}\n${JSON.stringify(s?.composer?.poll)}`)
        await new Promise(r => setTimeout(r, 100))
      }
    }
    const run = (cmd: string): Promise<void> => page.evaluate(i => window.__tether.ext.channels.run(i), cmd)
    const pane = page.locator(`.ch-pane[data-channel="${id}"]`)
    const form = pane.locator('.ch-pf')
    const field = pane.locator('.ch-field')
    const focused = (): Promise<string> => page.evaluate(() => (document.activeElement as HTMLElement | null)?.className ?? '')
    const card = (seq: number) => pane.locator(`.ch-poll[data-seq="${seq}"]`)

    await page.evaluate(([i, n]) => window.__tether.ext.channels.open(i!, n), [id, 'obra'] as const)
    let v = await waitView('pane with the box', x => x.loaded && x.composer?.enabled === true)
    assert.equal(v.composer!.poll.open, false, 'the form is shut at first')

    // ---- 1. the button: defaults, the draft stays, validation, Enter opens, Esc cancels ----
    console.log('step 1')
    await field.fill('rascunho que não pode sumir')
    await pane.locator('.ch-pollbtn').click()
    await form.waitFor({ state: 'visible' })
    v = (await view())!
    const f0 = v.composer!.poll
    assert.deepEqual([f0.open, f0.kind, f0.includeYou, f0.deadline, f0.question], [true, 'ok', false, '10', ''])
    assert.deepEqual([...f0.called].sort(), [nameA, nameB, nameC].sort(), 'every agent member is called by default')
    assert.match(f0.foot, /^Fecha às \d\d:\d\d ou quando os 3 votarem$/)
    assert.match(f0.focus, /ch-pf-q/, 'the focus goes to the question')
    assert.equal(v.composer!.text, 'rascunho que não pode sumir')
    await pane.locator('.ch-pf').screenshot({ path: join(SHOTS, 'formulario-ok-padrao.png') })
    await pane.screenshot({ path: join(SHOTS, 'larga-formulario-botao.png') })
    // An empty question is told before asking: no poll, the form stays.
    await page.keyboard.press('Enter')
    await form.locator('.ch-pf-fe', { hasText: 'Escreva a pergunta.' }).waitFor()
    assert.deepEqual(Object.keys(polls()), [], 'nothing was asked')
    // Esc cancels, the focus goes back to the box, the draft is still there.
    await page.keyboard.press('Escape')
    await form.waitFor({ state: 'hidden' })
    assert.match(await focused(), /ch-field/, 'Esc gives the focus back to the box')
    assert.equal(await field.inputValue(), 'rascunho que não pode sumir')
    // Open again and ask: Enter in the question.
    await pane.locator('.ch-pollbtn').click()
    await form.locator('.ch-pf-q').fill('Posso fechar o seminário e subir a ata?')
    await page.keyboard.press('Enter')
    await form.waitFor({ state: 'hidden' })
    const open1 = Object.entries(polls())
    assert.equal(open1.length, 1)
    const [seq1s, p1] = open1[0]!
    const seq1 = Number(seq1s)
    assert.deepEqual([p1.type, p1.options, p1.author.id, p1.question], ['ok', ['ok', 'não ok'], USER, 'Posso fechar o seminário e subir a ata?'])
    assert.deepEqual(p1.to.map(t => t.id).sort(), [a, b, c].sort())
    const ms1 = Date.parse(p1.closesAt) - Date.now()
    assert.ok(ms1 > 9 * 60_000 && ms1 <= 10 * 60_000, `the default deadline is 10 min (${ms1})`)
    for (const s of [a, b, c]) await waitUntil(() => requestsOf(s, seq1).length === 1, 15_000, `a fake agent got the request of obra#${seq1}`)
    assert.match(requestsOf(a, seq1)[0]!.meta.poll ?? '', /ok/)
    assert.match(await focused(), /ch-field/, 'the focus is back in the box')
    assert.equal(await field.inputValue(), 'rascunho que não pode sumir', 'the draft survives opening and closing the form')
    await card(seq1).waitFor()
    assert.equal(await card(seq1).locator('button.ch-opt').count(), 0, 'she was not called: she sees, she does not vote')
    await page.screenshot({ path: join(SHOTS, 'larga-enquete-aberta-pela-pessoa.png') })
    assert.ok((await ch.pollClose(USER, id, seq1)).ok)

    // ---- 2. `/enquete`: a choice of 3, 1 minute, one agent out, "incluir você"; she votes by the card ----
    console.log('step 2')
    await field.fill('/enquete')
    await page.keyboard.press('Enter')
    await form.waitFor({ state: 'visible' })
    assert.equal(await field.inputValue(), '', '/enquete is consumed: it is no speech and the box is empty')
    assert.equal((await ch.store.since(id, 0, 100)).filter(l => l.kind === 'message' && l.body === '/enquete').length, 0, '/enquete was not said')
    await form.locator('.ch-pf-q').fill('Qual dia para a revisão?')
    await form.locator('[data-kind="choice"]').click()
    const inputs = form.locator('.ch-pf-opt')
    assert.equal(await inputs.count(), 2)
    await form.locator('.ch-pf-add').click()
    assert.equal(await inputs.count(), 3)
    await inputs.nth(0).fill('terça')
    await inputs.nth(1).fill('quarta')
    await inputs.nth(2).fill('sexta')
    await form.locator('[data-dl="other"]').click()
    await form.locator('.ch-pf-other').fill('1')
    await form.locator(`[data-who="${c}"]`).click()
    await form.locator('[data-who="you"]').click()
    v = (await view())!
    const f2 = v.composer!.poll
    assert.deepEqual([f2.kind, f2.deadline, f2.other, f2.includeYou, [...f2.called].sort()], ['choice', 'other', '1', true, [nameA, nameB].sort()])
    assert.deepEqual(f2.options, ['terça', 'quarta', 'sexta'])
    assert.match(f2.foot, /^Fecha às \d\d:\d\d ou quando os 3 votarem$/)
    await pane.screenshot({ path: join(SHOTS, 'larga-formulario-escolha.png') })
    await form.locator('.ch-pf-go').click()
    await form.waitFor({ state: 'hidden' })
    const seq2 = Math.max(...Object.keys(polls()).map(Number))
    const p2 = polls()[String(seq2)]!
    assert.deepEqual([p2.type, p2.options, p2.question], ['choice', ['terça', 'quarta', 'sexta'], 'Qual dia para a revisão?'])
    assert.deepEqual(p2.to.map(t => t.id).sort(), [a, b, USER].sort(), 'a and b and herself; c was taken out')
    const ms2 = Date.parse(p2.closesAt) - Date.now()
    assert.ok(ms2 > 50_000 && ms2 <= 60_000, `the deadline is 1 minute (${ms2})`)
    for (const s of [a, b]) await waitUntil(() => requestsOf(s, seq2).length === 1, 15_000, `a fake agent got the request of obra#${seq2}`)
    assert.match(requestsOf(a, seq2)[0]!.meta.options ?? '', /1 terça \| 2 quarta \| 3 sexta/)
    await new Promise(r => setTimeout(r, 1500))
    assert.equal(requestsOf(c, seq2).length, 0, 'the one taken out got no request')
    // She is called: the card has buttons; she votes by it.
    await card(seq2).locator('.ch-opt[data-n="2"]').waitFor()
    assert.equal(await card(seq2).locator('button.ch-opt').count(), 3, 'she is called: three buttons')
    await card(seq2).locator('.ch-opt[data-n="2"]').click()
    await waitUntil(() => ch.store.get(id)!.polls?.[String(seq2)]?.votes[USER]?.option === 2, 15_000, 'her vote is in')
    assert.ok((await ch.vote(a, id, { poll: seq2, vote: 'quarta' })).ok)
    const last = await ch.vote(b, id, { poll: seq2, vote: 'terça' })
    assert.ok(last.ok && last.closed !== undefined, 'the last vote closes it: she counted for "todos votaram"')
    await waitView('result', x => x.polls.find(p => p.seq === seq2)?.state === 'closed')
    assert.match(await card(seq2).locator('.ch-ph').innerText(), /todos votaram/)
    await page.screenshot({ path: join(SHOTS, 'larga-escolha-votada-pela-pessoa.png') })

    // ---- 3. the palette's command; Esc; the tether's refusal keeps what was typed; after she votes the same form opens ----
    console.log('step 3')
    await run('channels.poll')
    await form.waitFor({ state: 'visible' })
    await page.keyboard.press('Escape')
    await form.waitFor({ state: 'hidden' })
    assert.match(await focused(), /ch-field/)
    // b opens a poll that calls her: she owes a vote, so she may not open another (`vote-first`).
    const owed = await ch.poll(b, id, { question: 'Posso seguir?', to: [USER, a], timeoutMs: 600_000 })
    assert.ok(owed.ok)
    await run('channels.poll')
    await form.waitFor({ state: 'visible' })
    await form.locator('.ch-pf-q').fill('Fechamos hoje?')
    await form.locator('[data-kind="choice"]').click()
    await form.locator('.ch-pf-opt').nth(0).fill('sim')
    await form.locator('.ch-pf-opt').nth(1).fill('não')
    await form.locator('.ch-pf-go').click()
    await form.locator('.ch-pf-err').waitFor({ state: 'visible' })
    assert.match(await form.locator('.ch-pf-err').innerText(), /vote nela antes de abrir outra/)
    v = (await view())!
    assert.deepEqual([v.composer!.poll.open, v.composer!.poll.question, v.composer!.poll.kind, v.composer!.poll.options], [true, 'Fechamos hoje?', 'choice', ['sim', 'não']], 'nothing typed was lost')
    await pane.screenshot({ path: join(SHOTS, 'larga-recusa-vote-first.png') })
    // She votes by the card (the poll closes: she and a... a has not voted, so it stays open; she only owes no more).
    await card(owed.line.seq).locator('.ch-opt[data-n="1"]').click()
    await waitUntil(() => ch.store.get(id)!.polls?.[String(owed.line.seq)]?.votes[USER]?.option === 1, 15_000, 'her vote on the owed poll')
    // Her own poll is limited to one open at a time: none is open, so the same form now opens it.
    await form.locator('.ch-pf-go').click()
    await form.waitFor({ state: 'hidden' })
    const seq3 = Math.max(...Object.keys(polls()).map(Number))
    assert.equal(polls()[String(seq3)]!.question, 'Fechamos hoje?')
    assert.deepEqual(polls()[String(seq3)]!.options, ['sim', 'não'])
    assert.ok((await ch.pollClose(USER, id, seq3)).ok)

    // ---- 4. the channel's "⋯" menu ----
    console.log('step 4')
    await pane.locator('.ch-more').click()
    const menu = page.locator('#ctx-menu')
    await menu.waitFor({ state: 'visible' })
    const labels = (await menu.locator('li[role^="menuitem"]').allTextContents()).map(t => t.replace(/\s+/g, ' ').trim())
    assert.ok(labels.some(t => t.startsWith('Abrir enquete')), JSON.stringify(labels))
    await page.screenshot({ path: join(SHOTS, 'larga-menu-mais.png') })
    await menu.locator('li', { hasText: 'Abrir enquete' }).click()
    await form.waitFor({ state: 'visible' })
    await page.keyboard.press('Escape')
    await form.waitFor({ state: 'hidden' })

    // ---- 5. the narrow pane ----
    await pane.evaluate(e => { e.style.width = '340px'; e.style.maxWidth = '340px' })
    await page.waitForFunction(i => document.querySelector(`.ch-pane[data-channel="${i}"]`)?.classList.contains('narrow'), id)
    await pane.locator('.ch-pollbtn').click()
    await form.waitFor({ state: 'visible' })
    await pane.screenshot({ path: join(SHOTS, 'estreita-formulario.png') })
    assert.ok(await form.evaluate(e => e.scrollWidth <= e.clientWidth + 1), 'the form has no sideways scroll in a narrow pane')
    await page.keyboard.press('Escape')
    void base; void nameB
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
