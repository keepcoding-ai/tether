// E2E of the poll's card on the channel's pane (slice E3): a tetherd in this process on a private home and pipe, with the channels
// extension's record and requests on its door and three fake `claude` agents (no LLM); the real app on the same pipe, hidden window.
//   1. a poll that was open before the pane: its card comes from the history, with the vote and the reason, and who is missing;
//   2. an agent opens a poll that calls the person: the card shows live; an agent votes: bar, count and name update, with no
//      catch-up of the conversation (`last` does not move) and the tab's marks and the "novas" bar untouched;
//   3. the person (called) votes "não ok": the reason's field asks for it; she sends it, then changes her vote;
//   4. the last vote closes it: the card turns to the result (winner, "todos votaram"), no button left;
//   5. a poll closes by its deadline (fake clock): "sem resposta" with the reason of each;
//   6. the person closes one from the card's menu (right click) after a confirmation: "encerrada por você" and who did not answer;
//   7. a closed channel: the open poll closes with it; the card stays, read only, with no vote and no close.
// Run alone: node --test test/e2e/app.channels-poll.test.ts   (one E2E at a time: the build is remade)
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
    marks(channelId: string): { unread: number; toMe: number; seen: number; seal: boolean }
  } }
}
declare const window: { __tether: Hooks }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const AGENT = fileURLToPath(new URL('../fixtures/channels/agent.cjs', import.meta.url))
const SHOTS = 'C:/atrium/.tmp/tether-agents/onda-3/poll/e3'

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

test('channel pane: the poll card (history, live votes, her vote with reason, results, menu close, closed channel)', { timeout: 480_000 }, async () => {
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
  // A fake clock for the deadlines: it starts at the real time (the card's countdown reads the real one) and moves when the test says.
  const base = Date.now()
  let offset = 0
  let ring: (() => void) | undefined
  const clock: PollClock = {
    now: () => base + offset,
    set: fn => { ring = fn; return fn },
    clear: () => { ring = undefined },
  }
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
    const nameA = ch.nameOf(a)
    const nameB = ch.nameOf(b)
    assert.ok((await ch.say(a, id, { body: 'Começando a revisão.' })).ok)

    // poll0: opened by c before the pane exists; b voted with a reason; a has not.
    const p0r = await ch.poll(c, id, { question: 'Posso subir a ata?', to: [a, b], timeoutMs: 600_000 })
    assert.ok(p0r.ok)
    const p0 = p0r.line.seq
    assert.ok((await ch.vote(b, id, { poll: p0, vote: 1, reason: 'visto' })).ok)

    let page: Page
    ;({ app, page } = await launch(home, pipe))
    await page.waitForFunction(() => typeof window.__tether.ext?.channels?.open === 'function')
    const view = (): Promise<PaneSnapshot | undefined> => page.evaluate(i => window.__tether.ext.channels.view(i), id)
    const marks = (): Promise<{ unread: number; toMe: number; seen: number; seal: boolean }> => page.evaluate(i => window.__tether.ext.channels.marks(i), id)
    const waitView = async (what: string, fn: (v: PaneSnapshot) => boolean, ms = 15_000): Promise<PaneSnapshot> => {
      const end = Date.now() + ms
      for (;;) {
        const s = await view()
        if (s !== undefined && fn(s)) return s
        if (Date.now() > end) throw new Error(`timeout: ${what}\n${JSON.stringify(s ? { loaded: s.loaded, last: s.last, polls: s.polls.map(p => [p.seq, p.state, p.progressText, p.clock]) } : s)}`)
        await new Promise(r => setTimeout(r, 100))
      }
    }
    const cardOf = (v: PaneSnapshot, seq: number) => v.polls.find(p => p.seq === seq)
    const pane = page.locator(`.ch-pane[data-channel="${id}"]`)
    const card = (seq: number) => pane.locator(`.ch-poll[data-seq="${seq}"]`)
    const opt = (seq: number, n: number) => card(seq).locator(`.ch-opt[data-n="${n}"]`)
    const votes = (seq: number): Record<string, { option: number; reason?: string }> => ch.store.get(id)!.polls?.[String(seq)]?.votes ?? {}

    // ---- 1. a poll from before the pane: its card comes from the history ----
    console.log('step 1')
    await page.evaluate(([i, n]) => window.__tether.ext.channels.open(i!, n), [id, 'obra'] as const)
    let v = await waitView('pane with the card', x => x.loaded && cardOf(x, p0) !== undefined)
    assert.equal(v.rows.filter(r => r.kind === 'poll').length, 1)
    let c0 = cardOf(v, p0)!
    assert.deepEqual([c0.state, c0.options[0]!.count, c0.progressText], ['open', 1, '1 de 2 votaram'])
    assert.deepEqual(c0.missing.map(m => m.name), [nameA])
    assert.match(c0.clock, /^fecha em \d+ min$/)
    assert.equal(c0.canVote, false, 'she was not called: she sees, she does not vote')
    assert.equal(await card(p0).locator('button.ch-opt').count(), 0, 'no button on the options')
    assert.match(await card(p0).locator('.ch-why').innerText(), new RegExp(`${nameB} \\(ok\\): "visto"`))
    assert.equal(await card(p0).locator('.ch-opt[data-n="1"] .ch-face').count(), 1, 'the voter shows')
    await page.screenshot({ path: join(SHOTS, 'larga-cartao-historia.png') })

    // ---- 2. a poll that calls her, live; an agent votes ----
    console.log('step 2')
    const p1r = await ch.poll(b, id, { question: 'Qual dia para a revisão?', options: ['terça', 'quarta', 'sexta'], to: [USER, a, c], timeoutMs: 600_000 })
    assert.ok(p1r.ok)
    const p1 = p1r.line.seq
    v = await waitView('the card live', x => cardOf(x, p1) !== undefined && x.last === p1)
    assert.equal(cardOf(v, p1)!.canVote, true)
    assert.equal(cardOf(v, p1)!.waitsYou, true)
    assert.ok(await card(p1).locator('button.ch-opt').count() === 3, 'she was called: three buttons')
    const rows0 = v.rows.length
    await new Promise(r => setTimeout(r, 400))
    const m1 = await marks()
    const v1 = (await view())!
    assert.ok((await ch.vote(a, id, { poll: p1, vote: 'quarta' })).ok)
    v = await waitView('a vote live', x => cardOf(x, p1)!.options[1]!.count === 1)
    assert.equal(cardOf(v, p1)!.progressText, '1 de 3 votaram')
    assert.equal(await opt(p1, 2).locator('.ch-face').first().getAttribute('title'), nameA)
    assert.equal(v.last, p1, 'a vote is no hole in the conversation: no catch-up, `last` did not move')
    assert.equal(v.rows.length, rows0)
    assert.deepEqual([v.unread, v.bar], [v1.unread, v1.bar])
    const m2 = await marks()
    assert.deepEqual([m2.unread, m2.toMe, m2.seal], [m1.unread, m1.toMe, m1.seal], 'the tab\'s marks did not move with a vote')
    await page.screenshot({ path: join(SHOTS, 'larga-cartao-ao-vivo.png') })

    // ---- 3. her vote: "terça" would be option 1; she picks the last, asked for a reason, then changes ----
    console.log('step 3')
    await opt(p1, 3).click()
    await waitView('her vote is in', x => cardOf(x, p1)!.mineOption === 3 && cardOf(x, p1)!.options[2]!.count === 1)
    assert.equal(votes(p1)[USER]?.option, 3)
    assert.equal(await card(p1).locator('.ch-reason').count(), 0, 'only the "não ok" asks its reason at once')
    // The menu has the vote with the reason; use it: "Votar com motivo…".
    await card(p1).locator('.q').click({ button: 'right' })
    const menu = page.locator('#ctx-menu')
    await menu.waitFor({ state: 'visible' })
    const labels = (await menu.locator('li[role^="menuitem"]').allTextContents()).map(t => t.replace(/\s+/g, ' ').trim())
    assert.ok(labels.some(t => t.startsWith('Votar "terça"')) && labels.some(t => t.startsWith('Votar com motivo')) && labels.some(t => t.startsWith('Encerrar agora')) && labels.some(t => t.startsWith('Copiar pergunta')), JSON.stringify(labels))
    assert.equal(await menu.locator('li[aria-checked="true"]').count(), 1, 'the menu marks her vote')
    await page.screenshot({ path: join(SHOTS, 'larga-cartao-menu.png') })
    await menu.locator('li', { hasText: 'Votar com motivo' }).click()
    const field = card(p1).locator('.ch-pr-in')
    await field.waitFor({ state: 'visible' })
    await field.fill('sexta é o dia que cabe')
    // An agent votes while she types: the field and its text stay.
    assert.ok((await ch.vote(a, id, { poll: p1, vote: 'terça' })).ok)
    await waitView('a changed its vote', x => cardOf(x, p1)!.options[0]!.count === 1 && cardOf(x, p1)!.options[1]!.count === 0)
    assert.equal(await field.inputValue(), 'sexta é o dia que cabe', 'the text typed survives a repaint of the card')
    await card(p1).locator('.ch-reason button').click()
    await waitView('reason sent', x => cardOf(x, p1)!.mineReason === 'sexta é o dia que cabe')
    assert.deepEqual([votes(p1)[USER]?.option, votes(p1)[USER]?.reason], [3, 'sexta é o dia que cabe'])
    assert.match(await card(p1).locator('.ch-why').innerText(), /Você \(sexta\): "sexta é o dia que cabe"/)
    await opt(p1, 1).click() // changes the vote
    await waitView('vote changed', x => cardOf(x, p1)!.mineOption === 1)
    assert.equal(votes(p1)[USER]?.option, 1)
    assert.equal(cardOf((await view())!, p1)!.options[2]!.count, 0, 'the old option lost her vote')
    await page.screenshot({ path: join(SHOTS, 'larga-voto-com-motivo.png') })

    // The "não ok": a yes/no poll that calls her asks the reason with emphasis, optional.
    // (poll0 is not hers; this is checked on the next poll below.)

    // ---- 4. the last vote closes it: the result ----
    console.log('step 4')
    const afterC = await ch.vote(c, id, { poll: p1, vote: 'terça', reason: 'terça é melhor' })
    assert.ok(afterC.ok, JSON.stringify(afterC))
    v = await waitView('result', x => cardOf(x, p1)!.state === 'closed')
    const r1 = cardOf(v, p1)!
    assert.deepEqual(r1.options.map(o => [o.count, o.winner]), [[3, true], [0, false], [0, false]])
    assert.match(r1.clock, /^todos votaram às \d\d:\d\d$/)
    assert.equal(await card(p1).locator('button.ch-opt').count(), 0, 'closed: no button')
    assert.equal(await card(p1).locator('.ch-opt.win').count(), 1)
    assert.equal(await card(p1).locator('.ch-pmore').count(), 1, 'the menu stays (copy)')
    const m3 = await marks()
    // The seal of m1 was lit because the poll waited for her vote (E5); she voted in step 3, so it is out now. Unread and toMe: no news.
    assert.deepEqual([m3.unread, m3.toMe, m3.seal], [m1.unread, m1.toMe, false], 'the close does not count as news')
    assert.equal((await view())!.last, p1, 'the close is no line either')
    await page.screenshot({ path: join(SHOTS, 'larga-resultado-todos-votaram.png') })

    // ---- 5. a poll that closes by its deadline: "sem resposta" ----
    console.log('step 5')
    const p2r = await ch.poll(b, id, { question: 'Fechamos o seminário?', to: [USER, a, c], timeoutMs: 60_000 })
    assert.ok(p2r.ok)
    const p2 = p2r.line.seq
    v = await waitView('the yes/no card', x => cardOf(x, p2) !== undefined)
    assert.equal(cardOf(v, p2)!.kindLabel, 'ok / não ok')
    assert.match(cardOf(v, p2)!.clock, /^fecha em (1 min|0:\d\d)$/)
    // Her "não ok": the field shows highlighted and may stay empty.
    await opt(p2, 2).click()
    await card(p2).locator('.ch-reason.ask').waitFor()
    assert.match((await card(p2).locator('.ch-pr-in').getAttribute('placeholder'))!, /Por que não/)
    await waitView('no vote written', x => cardOf(x, p2)!.mineOption === 2)
    assert.equal(votes(p2)[USER]?.option, 2)
    await page.screenshot({ path: join(SHOTS, 'larga-nao-ok-pede-motivo.png') })
    assert.ok((await ch.vote(c, id, { poll: p2, vote: 1 })).ok)
    // a does not answer: the clock rings.
    offset += 61_000
    ring?.()
    v = await waitView('closed by the deadline', x => cardOf(x, p2)!.state === 'closed')
    const r2 = cardOf(v, p2)!
    assert.deepEqual(r2.missing.map(m => [m.name, m.why]), [[nameA, 'não respondeu']])
    assert.match(r2.clock, /^o prazo venceu às \d\d:\d\d$/)
    assert.equal(r2.tie, true, 'one against one: a tie, no winner')
    assert.match(await card(p2).locator('.ch-pmiss').innerText(), new RegExp(`Sem resposta: ${nameA} \\(não respondeu\\)`))
    assert.equal(await card(p2).locator('.ch-reason').count(), 0, 'closed: the field is gone')
    await page.screenshot({ path: join(SHOTS, 'larga-resultado-prazo.png') })

    // ---- 6. the person closes poll0 from the menu, after the confirmation ----
    console.log('step 6')
    await card(p0).locator('.q').click({ button: 'right' })
    await menu.waitFor({ state: 'visible' })
    const l0 = (await menu.locator('li[role^="menuitem"]').allTextContents()).map(t => t.replace(/\s+/g, ' ').trim())
    assert.ok(!l0.some(t => t.startsWith('Votar')), 'not called: no vote in the menu')
    assert.ok(l0.some(t => t.startsWith('Encerrar agora')))
    await menu.locator('li', { hasText: 'Encerrar agora' }).click()
    const ask = page.locator('dialog.ask[data-dialog="channels.poll-close"]')
    await ask.waitFor()
    assert.match(await ask.innerText(), new RegExp(`Faltam 1 voto \\(${nameA}\\)`))
    await ask.locator('button.choice[data-choice="close"]').click()
    v = await waitView('closed from the menu', x => cardOf(x, p0)!.state === 'closed')
    assert.equal(cardOf(v, p0)!.clock, 'encerrada por você')
    assert.deepEqual(cardOf(v, p0)!.missing.map(m => m.name), [nameA])
    // The button of the card opens the same menu.
    await card(p0).locator('.ch-pmore').click()
    await menu.waitFor({ state: 'visible' })
    const l0b = (await menu.locator('li[role^="menuitem"]').allTextContents()).map(t => t.replace(/\s+/g, ' ').trim())
    assert.deepEqual(l0b.map(t => t.replace(/\s.*$/, '')), ['Copiar', 'Copiar'], 'a closed card keeps only copy')
    await page.keyboard.press('Escape')
    await page.screenshot({ path: join(SHOTS, 'larga-encerrada-pelo-menu.png') })

    // ---- 7. the narrow pane, then a closed channel ----
    console.log('step 7')
    const p3r = await ch.poll(a, id, { question: 'Podemos encerrar o canal?', options: ['sim', 'não', 'depois'], to: [USER, b], timeoutMs: 600_000 })
    assert.ok(p3r.ok)
    const p3 = p3r.line.seq
    await waitView('last card', x => cardOf(x, p3) !== undefined)
    await pane.evaluate(e => { e.style.width = '340px'; e.style.maxWidth = '340px' })
    await page.waitForFunction(i => document.querySelector(`.ch-pane[data-channel="${i}"]`)?.classList.contains('narrow'), id)
    await pane.screenshot({ path: join(SHOTS, 'estreita-cartao.png') })
    await pane.evaluate(e => { e.style.width = ''; e.style.maxWidth = '' })
    assert.ok((await ch.close(USER, id)).ok)
    v = await waitView('closed channel', x => x.closed && cardOf(x, p3)!.state === 'closed')
    assert.equal(cardOf(v, p3)!.clock, 'o canal foi encerrado')
    assert.deepEqual([cardOf(v, p3)!.canVote, cardOf(v, p3)!.canClose], [false, false])
    assert.equal(await pane.locator('button.ch-opt').count(), 0, 'no card has a button')
    assert.equal(await pane.locator('.ch-poll').count(), 4, 'the four cards stay, for reading')
    await card(p3).locator('.q').click({ button: 'right' })
    await menu.waitFor({ state: 'visible' })
    assert.deepEqual((await menu.locator('li[role^="menuitem"]').allTextContents()).map(t => t.trim().replace(/\s.*$/, '')), ['Copiar', 'Copiar'])
    await page.keyboard.press('Escape')
    const refused = await ch.vote(USER, id, { poll: p3, vote: 1 })
    assert.deepEqual([refused.ok, !refused.ok && refused.error], [false, 'closed'])
    await page.screenshot({ path: join(SHOTS, 'larga-canal-encerrado.png') })
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
