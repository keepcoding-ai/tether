// E2E of the poll without the mouse (slice E5): a tetherd in this process on a private home and pipe, with the channels extension's
// record and requests on its door and three fake `claude` agents (one never opens its stream: "surdo", it does not hear now); the real
// app on the same pipe, hidden window. Nothing here is a click: only keys (the one thing not done by a key is the first focus).
//   1. `/enquete` in the box opens the form; the question, "incluir você" and "Abrir enquete" by Tab, Space and Enter; the warning of who
//      does not hear now shows in the form; the poll is hers;
//   2. the arrows reach the card; its name is a sentence (question, state, tally, who is missing and why, clock); `1` votes, `2` changes
//      the vote and asks its reason, Enter sends it, `M` opens the field and Esc gives the focus back to the card; another voter is
//      announced in one sentence; the menu key opens the menu (the votes with their numbers, the reason, close, copy), a vote from the
//      menu changes the vote, "Encerrar agora" by the menu and the dialog by keys; the focus is on the card at the end;
//   3. an agent's poll that calls her, with the pane covered: the seal, the counter on the tab, the icon; with her speech's ❓ too the
//      bar says both in one text; the bar by Tab and Enter leads to the card; `1` votes and everything goes; the app restarted keeps it
//      lit; the poll closed by its author puts it out;
//   4. the 360 px pane: the form and a card of six long options have no sideways scroll.
// Run alone: node --test test/e2e/app.channels-poll-keys.test.ts   (one E2E at a time: the build is remade)
// Every kill goes through test/kill.ts (pid + creation time); the daemon here is closed in-process.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron, type ElectronApplication, type Locator, type Page } from 'playwright-core'
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
import type { ChannelMarks } from '../../extensions/channels/renderer/marks.ts'
import type { PaneSnapshot } from '../../extensions/channels/renderer/channel-pane.ts'
import type { Ask } from '../../extensions/channels/rules.ts'
import { USER } from '../../extensions/channels/rules.ts'
import { removeHome, tempHome, uniquePipe, waitUntil } from '../unit/daemon.helpers.ts'
import { killElectron } from './electron.ts'

type StatusView = { state: string; title: string; badge: number | undefined; unread: number; toMe: number; rows: Array<{ id: string }> }
type Marked = ChannelMarks & { seal: boolean; asks: Ask[]; owed: Array<{ seq: number }> }
type Hooks = {
  ext: { channels: {
    open(channelId: string, name?: string): void
    view(channelId: string): PaneSnapshot | undefined
    marks(channelId: string): Marked
    status(): StatusView
  } }
}
declare const window: { __tether: Hooks }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const AGENT = fileURLToPath(new URL('../fixtures/channels/agent.cjs', import.meta.url))
const SHOTS = 'C:/atrium/.tmp/tether-agents/onda-3/poll/e5'

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

test('channel pane: the poll by keyboard (form, card, vote, reason, menu, close), the seal and the bar, the narrow pane', { timeout: 540_000 }, async () => {
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
      const id = (await doorApi.slots.create({ kind: 'claude', cwd: home, name })).slotId
      await waitUntil(() => doorApi.slots.get(id)?.status === 'running' && doorApi.slots.readScreen(id).data.includes('READY'), 30_000, `${name} running`)
      if (name !== 'surdo') await waitUntil(() => doorApi.delivery.pathOf(id) === 'inside', 30_000, `${name} opened its stream`)
      return id
    }
    const a = await running('conferente')
    const b = await running('bancada')
    const s = await running('surdo')
    const made = await ch.create(USER, { name: 'obra', title: 'Obra' })
    assert.ok(made.ok)
    const id = made.channel.id
    for (const m of [a, b, s]) assert.ok((await ch.join(USER, id, m)).ok)
    const other = await ch.create(USER, { name: 'extra' })
    assert.ok(other.ok)
    const extra = other.channel.id
    const nameA = ch.nameOf(a), nameS = ch.nameOf(s)

    const speak = async (who: string, body: string): Promise<number> => {
      const r = await ch.say(who, id, { body })
      assert.ok(r.ok, `say refused: ${JSON.stringify(r)}`)
      return r.line.seq
    }
    const hers = await speak(USER, 'Sobe depois do almoço, e confira o relatório inteiro antes.')
    for (let i = 0; i < 30; i++) await speak(i % 2 ? a : b, `linha de histórico ${i + 1}, com um texto um pouco mais comprido para ocupar a tela da conversa`)
    const theirs = await speak(a, 'Terminei a revisão. Posso subir?')
    const polls = (): Record<string, { votes: Record<string, { option: number; reason?: string }>; closesAt: string }> => (ch.store.get(id)!.polls ?? {}) as never

    let page: Page
    ;({ app, page } = await launch(home, pipe))
    await page.waitForFunction(() => typeof window.__tether.ext?.channels?.status === 'function')
    const view = (i = id): Promise<PaneSnapshot | undefined> => page.evaluate(c => window.__tether.ext.channels.view(c), i)
    const marks = (i = id): Promise<Marked> => page.evaluate(c => window.__tether.ext.channels.marks(c), i)
    const status = (): Promise<StatusView> => page.evaluate(() => window.__tether.ext.channels.status())
    const until = async (what: string, fn: () => Promise<boolean>, ms = 15_000): Promise<void> => {
      const end = Date.now() + ms
      for (;;) {
        if (await fn()) return
        if (Date.now() > end) throw new Error(`timeout: ${what}\nmarks: ${JSON.stringify(await marks().catch(() => undefined))}\nfocus: ${JSON.stringify(await where().catch(() => undefined))}`)
        await page.waitForTimeout(80)
      }
    }
    // The locators belong to the page: they are made again when the app is restarted.
    let pane!: Locator, tab!: Locator, form!: Locator, field!: Locator, menu!: Locator, statusBtn!: Locator
    const bind = (): void => {
      pane = page.locator(`.ch-pane[data-channel="${id}"]`)
      tab = page.locator(`.ch-tab[data-channel="${id}"]`)
      form = pane.locator('.ch-pf')
      field = pane.locator('.ch-field')
      menu = page.locator('#ctx-menu')
      statusBtn = page.locator('.status-wrap[data-status="channels.status"] .status-btn')
    }
    bind()
    const card = (seq: number) => pane.locator(`.ch-prow[data-seq="${seq}"]`)
    const openPane = (i = id, n = 'obra'): Promise<void> => page.evaluate(([c, nm]) => window.__tether.ext.channels.open(c!, nm), [i, n] as const)
    const key = (k: string): Promise<void> => page.keyboard.press(k)
    /** Where the keyboard is, as a person would say it. */
    const where = () => page.evaluate(() => {
      const e = document.activeElement as HTMLElement | null
      return {
        cls: e?.className ?? '', prow: e?.closest<HTMLElement>('.ch-prow')?.dataset.seq ?? '', onCard: e?.classList.contains('ch-prow') ?? false,
        who: e?.dataset?.who ?? '', choice: e?.dataset?.choice ?? '', kind: e?.dataset?.kind ?? '', menu: !!e?.closest('#ctx-menu'),
        text: (e?.textContent ?? '').replace(/\s+/g, ' ').trim(), log: e?.classList.contains('ch-msgs') ?? false,
      }
    })
    const tabTo = async (what: string, is: (w: Awaited<ReturnType<typeof where>>) => boolean, k = 'Tab'): Promise<void> => {
      for (let i = 0; i < 40; i++) {
        if (is(await where())) return
        await key(k)
      }
      assert.fail(`${what}: the keyboard did not reach it (${JSON.stringify(await where())})`)
    }
    const onCard = (seq: number) => until(`focus on the card ${seq}`, async () => { const w = await where(); return w.onCard && w.prow === String(seq) })
    const resize = (w: number, h: number): Promise<void> => app!.evaluate(({ BrowserWindow }, [ww, hh]) => { BrowserWindow.getAllWindows()[0]!.setSize(ww!, hh!) }, [w, h])
    const inView = (seq: number): Promise<boolean> => card(seq).evaluate(e => {
      const r = e.getBoundingClientRect(), v = e.closest('.ch-msgs')!.getBoundingClientRect()
      return r.top < v.bottom && r.bottom > v.top
    })
    const react = async (who: string, seq: number, reaction: string, remove = false): Promise<void> => {
      const r = await ch.react(who, id, { seq, reaction, ...(remove ? { remove: true } : {}) })
      assert.ok(r.ok && r.changed, `react refused: ${JSON.stringify(r)}`)
    }

    await resize(1900, 760)
    await openPane()
    await until('the pane loaded and its end seen', async () => { const v = await view(); return v?.loaded === true && v.composer?.enabled === true && (await marks()).seen >= theirs })
    await page.waitForFunction(i => (document.querySelector(`.ch-pane[data-channel="${i}"]`)?.clientWidth ?? 0) >= 560, id)

    // ---- 1. the form by keys: /enquete, the question, "incluir você", the warning of who does not hear, Enter on "Abrir enquete" ----
    console.log('step 1: formulário pelo teclado')
    await field.focus() // arriving at the box: the only thing not done by a key
    await page.keyboard.type('/enquete')
    await key('Enter')
    await form.waitFor({ state: 'visible' })
    assert.match((await view())!.composer!.poll.focus, /ch-pf-q/, 'the focus is on the question')
    await page.keyboard.type('Posso subir a ata?')
    await tabTo('"incluir você"', w => w.who === 'you')
    await key('Space')
    let f = (await view())!.composer!.poll
    assert.equal(f.includeYou, true)
    assert.match(f.deaf, new RegExp(`^${nameS} não ouve agora: recebe se voltar antes de \\d\\d:\\d\\d\\.$`), 'the warning of who does not hear shows on the screen')
    assert.equal(await form.locator('.ch-pf-warn').isVisible(), true)
    // The kind is a radio group: arrows move and pick; back again.
    await tabTo('the kind', w => w.kind === 'ok', 'Shift+Tab')
    await key('ArrowRight')
    assert.equal((await view())!.composer!.poll.kind, 'choice', 'the arrow picked the neighbour')
    await tabTo('the kind again', w => w.kind === 'choice', 'Shift+Tab')
    await key('ArrowLeft')
    await until('back to ok / não ok', async () => (await view())!.composer!.poll.kind === 'ok')
    await pane.locator('.ch-pf').screenshot({ path: join(SHOTS, 'larga-formulario-aviso-de-quem-nao-ouve.png') })
    await tabTo('"Abrir enquete"', w => w.cls.includes('ch-pf-go'))
    await key('Enter')
    await form.waitFor({ state: 'hidden' })
    const seq1 = Math.max(...Object.keys(polls()).map(Number))
    const p1 = ch.store.get(id)!.polls![String(seq1)]!
    assert.deepEqual([p1.question, p1.author.id, p1.to.map(t => t.id).sort()], ['Posso subir a ata?', USER, [a, b, s, USER].sort()])
    await until('the card is drawn', async () => (await view())!.polls.some(p => p.seq === seq1))
    await until('the box has the focus back', async () => (await view())!.composer!.poll.open === false && (await where()).cls.includes('ch-field'))
    // ---- 2. the card by keys ----
    console.log('step 2: cartão pelo teclado')
    // Shift+Tab from the box would walk back through every author name of the conversation: arrive from the bar of the pane, as a person does.
    await pane.locator('.ch-bar .ch-more').evaluate(e => (e as HTMLElement).focus())
    await tabTo('the conversation', w => w.log)
    await key('ArrowUp')
    await onCard(seq1)
    let v = (await view())!
    const named = v.pollNames.find(p => p.seq === seq1)!
    assert.equal(named.role, 'group')
    assert.match(named.label, /^Enquete de Você: Posso subir a ata\? Aberta\. 0 de 4 votaram\. Placar: ok 0, não ok 0\. Faltam: .*\. fecha em \d+ min\. Espera o seu voto\. Teclas 1 a 2 votam, M abre o motivo\.$/, named.label)
    assert.ok(named.label.includes(`${nameS} (com a pessoa)`), `who is missing, and why when the tether knows: ${named.label}`)
    assert.ok(named.label.includes('você'), 'she is among who is missing')
    assert.equal(v.pollFocus, seq1)
    await page.screenshot({ path: join(SHOTS, 'larga-cartao-focado.png') })
    // `1` votes in the first option and the focus stays on the card.
    await key('1')
    await until('her vote 1 is in', async () => polls()[String(seq1)]?.votes[USER]?.option === 1)
    await until('the card shows it', async () => (await view())!.polls.find(p => p.seq === seq1)?.mineOption === 1)
    assert.equal((await view())!.pollFocus, seq1)
    assert.equal((await where()).onCard, true, 'the focus stays on the card, not on an option')
    await until('her own vote is said aloud', async () => (await view())!.announce === 'Você votou em ok.')
    assert.match((await view())!.pollNames.find(p => p.seq === seq1)!.label, /Seu voto: ok\./)
    // `2` changes it and opens the reason (the "não ok" asks for it); typed, Enter sends it and the card takes the focus back.
    await key('2')
    await until('her vote 2 is in', async () => polls()[String(seq1)]?.votes[USER]?.option === 2)
    await until('the reason field has the focus', async () => (await where()).cls.includes('ch-pr-in'))
    assert.equal(await card(seq1).locator('.ch-reason.ask').count(), 1, 'the "não ok" asks its reason with emphasis')
    await page.keyboard.type('a ata ainda não tem os riscos')
    await key('Enter')
    await until('the reason is in', async () => polls()[String(seq1)]?.votes[USER]?.reason === 'a ata ainda não tem os riscos')
    await onCard(seq1)
    assert.equal(polls()[String(seq1)]!.votes[USER]!.option, 2)
    // `M` opens the field on her vote, with the reason she gave; Esc closes it and the card has the focus.
    await until('the card holds her reason', async () => (await view())!.polls.find(p => p.seq === seq1)?.mineReason === 'a ata ainda não tem os riscos')
    await key('m')
    await until('M opens the reason', async () => (await where()).cls.includes('ch-pr-in'))
    assert.equal(await card(seq1).locator('.ch-pr-in').inputValue(), 'a ata ainda não tem os riscos')
    await key('Escape')
    await onCard(seq1)
    assert.equal(await card(seq1).locator('.ch-pr-in').count(), 0)
    // Another voter is said in one sentence, without reading the conversation again.
    assert.ok((await ch.vote(a, id, { poll: seq1, vote: 'ok' })).ok)
    await until('the other voter is announced', async () => (await view())!.announce === `${nameA} votou ok.`)
    await until('the card counts it', async () => (await view())!.polls.find(p => p.seq === seq1)?.voted === 2)
    // Esc from inside the card (an option) gives the focus back to the card.
    await key('Tab')
    assert.equal((await where()).onCard, false)
    assert.equal((await where()).prow, String(seq1), 'the Tab went into the card')
    await key('Escape')
    await onCard(seq1)
    // The menu key: the votes with their numbers, the reason, close and copy; a vote from the menu changes the vote.
    await key('ContextMenu')
    await menu.waitFor({ state: 'visible' })
    const labels = (await menu.locator('li[role^="menuitem"]').allTextContents()).map(t => t.replace(/\s+/g, ' ').trim())
    assert.equal(labels.length, 6, JSON.stringify(labels))
    ;['Votar "ok"', 'Votar "não ok"', 'Votar com motivo', 'Encerrar agora', 'Copiar pergunta', 'Copiar referência'].forEach((t, i) => assert.ok(labels[i]!.startsWith(t), `${labels[i]} should start with ${t}`))
    assert.ok(labels[0]!.endsWith('1') && labels[1]!.endsWith('2') && labels[2]!.endsWith('M'), `the menu names the keys: ${JSON.stringify(labels)}`)
    assert.equal((await where()).menu, true, 'the focus is in the menu')
    await page.screenshot({ path: join(SHOTS, 'larga-menu-do-cartao.png') })
    await tabTo('Votar "ok"', w => w.menu && w.text.startsWith('Votar "ok"'), 'ArrowDown')
    await key('Enter')
    await menu.waitFor({ state: 'detached' })
    await until('the vote from the menu is in', async () => polls()[String(seq1)]?.votes[USER]?.option === 1)
    await onCard(seq1)
    // Close by the menu and the dialog by keys; the focus ends on the card.
    await key('Shift+F10')
    await menu.waitFor({ state: 'visible' })
    await tabTo('Encerrar agora', w => w.menu && w.text.startsWith('Encerrar agora'), 'ArrowDown')
    await key('Enter')
    const ask = page.locator('dialog.ask[data-dialog="channels.poll-close"]')
    await ask.waitFor()
    assert.match(await ask.innerText(), new RegExp(`Faltam 2 votos \\(`))
    await tabTo('the close choice', w => w.choice === 'close')
    await key('Enter')
    await until('the card closed', async () => (await view())!.polls.find(p => p.seq === seq1)?.state === 'closed')
    await onCard(seq1)
    v = (await view())!
    assert.equal(v.polls.find(p => p.seq === seq1)!.clock, 'encerrada por você')
    assert.match(v.pollNames.find(p => p.seq === seq1)!.label, /Fechada\. 1 de 4 votaram|Fechada\. 2 de 4 votaram/)
    assert.match(v.pollNames.find(p => p.seq === seq1)!.label, /Sem resposta: /)
    await page.screenshot({ path: join(SHOTS, 'larga-encerrada-pelo-menu-teclado.png') })

    // ---- 3. the seal and the bar: an agent's poll that calls her, the pane covered ----
    console.log('step 3: selo e barra')
    await openPane(extra, 'extra')
    await until('the obra is covered', async () => (await view())!.scroll.client === 0)
    await until('the directory knows the channels', async () => (await status()).rows.length === 2)
    assert.notEqual((await status()).state, 'warn')
    // A poll of an agent that does not call her lights no seal (the line is news like any speech: only the quiet ring).
    const quiet = await ch.poll(b, id, { question: 'Segue o plano?', to: [a], timeoutMs: 600_000 })
    assert.ok(quiet.ok)
    await page.waitForTimeout(700)
    let m = await marks()
    assert.deepEqual([m.owed.length, m.seal, (await status()).state === 'warn'], [0, false, false], 'a poll that does not call her lights nothing')
    assert.ok((await ch.pollClose(b, id, quiet.line.seq)).ok)
    // A poll that calls her lights the seal; her speech's ❓ comes after it (a reaction newer than the last line stays until the speech is seen).
    const call = await ch.poll(b, id, { question: 'Fechamos hoje?', to: [USER, a], timeoutMs: 600_000 })
    assert.ok(call.ok)
    const seq2 = call.line.seq
    await until('the poll lights the seal', async () => { const x = await marks(); return x.seal && x.owed.length === 1 })
    assert.equal((await status()).badge, 1)
    await react(a, hers, 'question')
    await until('the ask joins it', async () => (await marks()).asks.length === 1)
    m = await marks()
    assert.deepEqual([m.seal, m.asks.length, m.owed[0]!.seq], [true, 1, seq2])
    assert.equal(await tab.getAttribute('data-mark'), 'me')
    assert.equal(await tab.locator('.ch-att:not([hidden])').textContent(), '2')
    assert.equal(await tab.locator('.ch-att').getAttribute('title'), '1 reação pede você · 1 enquete espera o seu voto')
    const s3 = await status()
    assert.deepEqual([s3.state, s3.badge], ['warn', 2], JSON.stringify(s3))
    assert.equal(await statusBtn.getAttribute('data-state'), 'warn')
    await page.screenshot({ path: join(SHOTS, 'aba-selo-enquete-e-reacao.png') })
    // Open the pane: one bar, one text, for both.
    await openPane()
    await until('the bar says both', async () => (await view())!.bar === '1 reação pede você · 1 enquete espera o seu voto')
    v = (await view())!
    assert.equal(v.barMe, true)
    assert.equal(await inView(seq2), true, 'the poll is at the foot, in view; her speech is far above')
    await page.screenshot({ path: join(SHOTS, 'barra-reacao-e-enquete.png') })
    // The bar by keys: Tab to it, Enter; it leads to the card (the card takes the focus).
    await field.focus()
    await tabTo('the bar', w => w.cls.includes('ch-newbar'), 'Shift+Tab')
    await key('Enter')
    await onCard(seq2)
    assert.equal(await card(seq2).evaluate(e => e.classList.contains('ch-flash')), true, 'the card is marked for a moment')
    // The reaction taken back: the bar says only the poll; the seal stays (the vote is owed).
    await react(a, hers, 'question', true)
    await until('the bar says only the poll', async () => (await view())!.bar === '1 enquete espera o seu voto')
    assert.equal((await marks()).seal, true)
    await page.screenshot({ path: join(SHOTS, 'barra-enquete-espera-o-voto.png') })
    // She votes by the key: the seal, the tab, the bar and the icon go.
    await key('1')
    await until('everything goes', async () => { const x = await marks(); return !x.seal && x.owed.length === 0 })
    assert.notEqual(await tab.getAttribute('data-mark'), 'me')
    assert.equal((await view())!.bar, '')
    assert.notEqual((await status()).state, 'warn')
    assert.equal(polls()[String(seq2)]?.votes[USER]?.option, 1)

    // A poll that calls her survives the app restarted: lit again; the author closing it puts it out.
    assert.ok((await ch.vote(a, id, { poll: seq2, vote: 'ok' })).ok, 'the last vote closes the poll')
    const call2 = await ch.poll(a, id, { question: 'Posso começar a segunda parte?', to: [USER], timeoutMs: 600_000 })
    assert.ok(call2.ok)
    await openPane(extra, 'extra')
    await until('lit with no pane in front', async () => (await status()).state === 'warn')
    assert.equal((await status()).badge, 1)
    await killElectron(app, root)
    ;({ app, page } = await launch(home, pipe))
    bind()
    await page.waitForFunction(() => typeof window.__tether.ext?.channels?.status === 'function')
    await until('what she owes comes back lit after a restart', async () => (await status()).state === 'warn')
    assert.equal((await marks()).owed[0]?.seq, call2.line.seq)
    await page.screenshot({ path: join(SHOTS, 'icone-apos-reiniciar.png') })
    assert.ok((await ch.pollClose(a, id, call2.line.seq)).ok)
    await until('the close puts it out', async () => (await status()).state !== 'warn' && (await marks()).owed.length === 0)

    // ---- 4. the narrow pane (360 px): a card of six long options and the form, no sideways scroll ----
    console.log('step 4: guia estreita')
    const longs = ['terça-feira de manhã, antes da reunião geral', 'quarta-feira à tarde, depois do almoço', 'quinta-feira, o dia inteiro', 'sexta-feira cedo, sem reunião', 'segunda-feira da semana que vem', 'só no mês que vem, com calma']
    const wide = await ch.poll(b, id, { question: 'Qual é o melhor dia para a revisão final da ata, considerando que a conferência só volta na quinta?', options: longs, to: [USER, a], timeoutMs: 600_000 })
    assert.ok(wide.ok)
    await openPane()
    await resize(1900, 760)
    await pane.evaluate(e => { e.style.width = '360px'; e.style.maxWidth = '360px' })
    await page.waitForFunction(i => document.querySelector(`.ch-pane[data-channel="${i}"]`)?.classList.contains('narrow'), id)
    await until('the wide card is drawn', async () => (await view())!.polls.some(p => p.seq === wide.line.seq))
    const noSideScroll = async (what: string, sel: string): Promise<void> => {
      const r = await pane.locator(sel).first().evaluate(e => ({ sw: e.scrollWidth, cw: e.clientWidth }))
      assert.ok(r.sw <= r.cw + 1, `${what} scrolls sideways at 360 px (${r.sw} > ${r.cw})`)
    }
    await card(wide.line.seq).scrollIntoViewIfNeeded()
    await noSideScroll('the conversation', '.ch-msgs')
    await noSideScroll('the pane', '.ch-conv')
    await noSideScroll('the card', `.ch-prow[data-seq="${wide.line.seq}"]`)
    assert.equal(await card(wide.line.seq).locator('.ch-opt').count(), 6)
    await page.screenshot({ path: join(SHOTS, 'estreita-cartao-seis-opcoes.png') })
    // The card by keys also here: the arrows reach it, the menu key opens its menu with the six votes.
    await pane.locator('.ch-bar .ch-more').evaluate(e => (e as HTMLElement).focus())
    await tabTo('the conversation', w => w.log)
    await key('ArrowUp')
    await onCard(wide.line.seq)
    await key('ContextMenu')
    await menu.waitFor({ state: 'visible' })
    assert.equal((await menu.locator('li[role^="menuitem"]').allTextContents()).filter(t => t.trim().startsWith('Votar "')).length, 6)
    await page.screenshot({ path: join(SHOTS, 'estreita-menu-do-cartao.png') })
    await key('Escape')
    await menu.waitFor({ state: 'detached' })
    // The form: /enquete, the kind "escolha" by the arrow, six options by Tab and typing.
    await field.focus()
    await page.keyboard.type('/enquete')
    await key('Enter')
    await form.waitFor({ state: 'visible' })
    await tabTo('the kind', w => w.kind === 'ok')
    await key('ArrowRight')
    await until('the options show', async () => (await view())!.composer!.poll.kind === 'choice')
    await page.keyboard.type('uma opção bem comprida para conferir que o campo não estoura a largura da guia estreita')
    await noSideScroll('the form', '.ch-pf')
    await noSideScroll('the form box', '.ch-pf-body')
    await pane.locator('.ch-pf').screenshot({ path: join(SHOTS, 'estreita-formulario-escolha.png') })
    await page.screenshot({ path: join(SHOTS, 'estreita-formulario-pagina.png') })
    await key('Escape')
    await form.waitFor({ state: 'hidden' })
    assert.match((await where()).cls, /ch-field/, 'Esc gives the focus back to the box')
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
