// E2E of the reactions on the channel's pane (slice R2): a tetherd in this process on a private home and pipe, with the channels
// extension's record and requests on its door and two fake `claude` agents (no LLM); the real app on the same pipe, hidden window.
//   1. an agent reacts (the verb's own path): the pill appears live, with who and the count, no blank line, no "new line", the
//      tab's marks and the end of the conversation untouched;
//   2. a click on a pill puts the person's reaction on (marked, counted) and a click on it again takes it back;
//   3. the hover bar reacts (and marks what is given); the right-click menu reacts (and marks what is given);
//   4. the person's reaction is in `channels read` of an agent;
//   5. a refusal (the 4th emoji of the person on one message) undoes the pill and shows the short notice;
//   6. a closed channel: the pills stay, as plain text, with no bar and no menu of reactions.
// Run alone: node --test test/e2e/app.channels-reactions.test.ts   (one E2E at a time: the build is remade)
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
import { readVerb } from '../../extensions/channels/daemon/verbs/read.ts'
import type { VerbDeps } from '../../extensions/channels/daemon/verbs/common.ts'
import type { VerbCaller } from '../../src/daemon/ext-api.ts'
import { openStore } from '../../extensions/channels/daemon/store.ts'
import { sumReactions, USER } from '../../extensions/channels/rules.ts'
import type { PaneSnapshot } from '../../extensions/channels/renderer/channel-pane.ts'
import { removeHome, tempHome, uniquePipe, waitUntil } from '../unit/daemon.helpers.ts'
import { killElectron } from './electron.ts'

type Hooks = {
  panelIds(): string[]
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
const SHOTS = 'C:/atrium/.tmp/tether-agents/onda-3/reacoes/r2'

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

test('channel pane: reactions (pills, click, bar, menu, refusal, closed)', { timeout: 420_000 }, async () => {
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
      const id = (await doorApi.slots.create({ kind: 'claude', cwd: home, name })).slotId
      await waitUntil(() => doorApi.slots.get(id)?.status === 'running' && doorApi.slots.readScreen(id).data.includes('READY'), 30_000, `${name} running`)
      await waitUntil(() => doorApi.delivery.pathOf(id) === 'inside', 30_000, `${name} opened its stream`)
      return id
    }
    const a = await running('conferente')
    const b = await running('bancada')
    const made = await ch.create(USER, { name: 'obra', title: 'Obra' })
    assert.ok(made.ok)
    const id = made.channel.id
    assert.ok((await ch.join(USER, id, a)).ok)
    assert.ok((await ch.join(USER, id, b)).ok)
    const nameA = ch.nameOf(a)
    const nameB = ch.nameOf(b)
    const m1 = await ch.say(a, id, { body: 'Terminei a revisão. Posso subir?' })
    const m2 = await ch.say(b, id, { body: 'Os testes passam: 42 de 42.' })
    const m3 = await ch.say(USER, id, { body: 'Sobe depois do almoço.' })
    assert.ok(m1.ok && m2.ok && m3.ok)
    const [s1, s2, s3] = [m1.line.seq, m2.line.seq, m3.line.seq]

    let page: Page
    ;({ app, page } = await launch(home, pipe))
    await page.waitForFunction(() => typeof window.__tether.ext?.channels?.open === 'function')
    const view = (): Promise<PaneSnapshot | undefined> => page.evaluate(i => window.__tether.ext.channels.view(i), id)
    const marks = (): Promise<{ unread: number; toMe: number; seen: number; seal: boolean }> => page.evaluate(i => window.__tether.ext.channels.marks(i), id)
    const waitView = async (what: string, fn: (v: PaneSnapshot) => boolean, ms = 15_000): Promise<void> => {
      const end = Date.now() + ms
      for (;;) {
        const s = await view()
        if (s !== undefined && fn(s)) return
        if (Date.now() > end) throw new Error(`timeout: ${what}\n${JSON.stringify(s ? { loaded: s.loaded, toast: s.toast, last: s.last, unread: s.unread } : s)}`)
        await new Promise(r => setTimeout(r, 100))
      }
    }
    const pane = page.locator(`.ch-pane[data-channel="${id}"]`)
    const msg = (seq: number) => pane.locator(`.ch-msg[data-seq="${seq}"]`)
    const pill = (seq: number, emoji: string) => msg(seq).locator(`.ch-pill[data-emoji="${emoji}"]`)
    /** Waits for the pill's count (0 = no pill) and, when given, its mark. */
    const pillIs = async (seq: number, emoji: string, count: number, mine?: boolean): Promise<void> => {
      await page.waitForFunction(([i, s, e, c, m]) => {
        const p = document.querySelector(`.ch-pane[data-channel="${i}"] .ch-msg[data-seq="${s}"] .ch-pill[data-emoji="${e}"]`)
        if (c === 0) return p === null
        return p !== null && p.getAttribute('data-count') === String(c) && !p.classList.contains('pend') && (m === undefined || p.classList.contains('mine') === m)
      }, [id, seq, emoji, count, mine] as const).catch(async (e: unknown) => {
        throw new Error(`pill ${emoji} on ${seq} never became ${count}/${mine}: ${(e as Error).message}\n${await msg(seq).innerHTML()}`)
      })
    }
    const personReactions = async (seq: number): Promise<string[]> =>
      (sumReactions(await ch.store.since(id, 0, 1000)).get(seq) ?? []).filter(t => t.by.some(x => x.id === USER)).map(t => t.emoji)

    await page.evaluate(([i, n]) => window.__tether.ext.channels.open(i!, n), [id, 'obra'] as const)
    await waitView('pane loaded', v => v.loaded && v.rows.filter(r => r.kind === 'say').length === 3)
    assert.equal(await pane.locator('.ch-rx').count(), 0, 'a speech with no reaction takes no room')
    assert.equal(await pane.locator('.ch-hb').count(), 0, 'the bar is not there until the mouse is')
    const base = (await view())!
    const baseMarks = await marks()

    // ---- 1. an agent reacts: the pill comes live, nothing else moves ----
    console.log('step 1')
    assert.ok((await ch.react(b, id, { seq: s1, reaction: 'agree' })).ok)
    await pillIs(s1, '👍', 1, false)
    assert.ok((await ch.react(a, id, { seq: s3, reaction: 'question' })).ok)
    await pillIs(s3, '❓', 1, false)
    assert.match((await pill(s1, '👍').getAttribute('title'))!, new RegExp(`^${nameB}: concordo$`))
    const after = (await view())!
    assert.equal(after.rows.length, base.rows.length, 'no blank speech and no new row for a reaction')
    assert.deepEqual([after.unread, after.bar, after.last], [base.unread, base.bar, base.last], 'the "novas" count, bar and last line did not move')
    assert.deepEqual(await marks(), baseMarks, 'the tab\'s marks did not move')
    assert.equal(await pane.locator('.ch-unseen').count(), 0, 'no "novas para você" separator')
    // A line right after: not a hole (no catch-up), so it is just a new line.
    assert.ok((await ch.say(a, id, { body: 'depois da reação' })).ok)
    await waitView('line after a reaction', v => v.rows.some(r => r.text === 'depois da reação'))
    assert.equal((await view())!.unread, 0)
    await page.screenshot({ path: join(SHOTS, 'guia-larga-pilulas.png') })

    // ---- 2. a click on a pill puts and takes the person's reaction ----
    console.log('step 2')
    await pill(s1, '👍').click()
    await pillIs(s1, '👍', 2, true)
    assert.deepEqual(await personReactions(s1), ['👍'])
    assert.match((await pill(s1, '👍').getAttribute('title'))!, /^Você e /)
    await pill(s1, '👍').click()
    await pillIs(s1, '👍', 1, false)
    assert.deepEqual(await personReactions(s1), [])

    // ---- 3. the hover bar and the right-click menu ----
    console.log('step 3')
    await msg(s2).hover()
    const bar = msg(s2).locator('.ch-hb')
    await bar.waitFor({ state: 'visible' })
    assert.equal(await bar.locator('.ch-hb-b[data-key]').count(), 5, 'the five agreed reactions')
    await page.screenshot({ path: join(SHOTS, 'guia-larga-barra.png') })
    await bar.locator('.ch-hb-b[data-key="✅"]').click()
    await pillIs(s2, '✅', 1, true)
    assert.deepEqual(await personReactions(s2), ['✅'])
    assert.equal(await bar.locator('.ch-hb-b[data-key="✅"]').getAttribute('class').then(c => c!.includes('on')), true, 'the bar marks what is given')
    await bar.locator('.ch-hb-b[data-key="✅"]').click() // again: takes it back
    await pillIs(s2, '✅', 0)
    assert.deepEqual(await personReactions(s2), [])
    assert.equal(await msg(s2).locator('.ch-rx').count(), 0, 'no reaction left: no room taken')

    await msg(s2).locator('p').click({ button: 'right' })
    const menu = page.locator('#ctx-menu')
    await menu.waitFor({ state: 'visible' })
    const labels = await menu.locator('li[role^="menuitem"]').allTextContents()
    assert.deepEqual(labels.slice(0, 5).map(t => t.replace(/\s+/g, ' ').trim()), ['👀 Vi', '👍 Concordo', '✅ Feito', '❌ Discordo', '❓ Dúvida'])
    assert.ok(labels.some(t => t.includes('Copiar texto')) && labels.some(t => t.includes('Copiar referência')))
    await page.screenshot({ path: join(SHOTS, 'guia-larga-menu.png') })
    await menu.locator('li', { hasText: 'Dúvida' }).click()
    await pillIs(s2, '❓', 1, true)
    assert.deepEqual(await personReactions(s2), ['❓'])
    await msg(s2).locator('p').click({ button: 'right' })
    await menu.waitFor({ state: 'visible' })
    assert.equal(await menu.locator('li[aria-checked="true"]').count(), 1, 'the menu marks what is given')
    assert.match((await menu.locator('li[aria-checked="true"]').textContent())!, /Dúvida/)
    await menu.locator('li', { hasText: 'Dúvida' }).click() // takes it back
    await pillIs(s2, '❓', 0)
    // The menu of a pill.
    await pill(s1, '👍').click({ button: 'right' })
    await menu.waitFor({ state: 'visible' })
    const pillMenu = (await menu.locator('li').allTextContents()).map(t => t.trim())
    assert.ok(pillMenu.includes('Reagir com 👍 também') && pillMenu.includes('Quem reagiu') && pillMenu.includes(nameB), JSON.stringify(pillMenu))
    await page.keyboard.press('Escape')

    // ---- 4. the person's reaction is what an agent reads ----
    console.log('step 4')
    await pill(s1, '👍').click()
    await pillIs(s1, '👍', 2, true)
    const deps = { api: undefined, channels: ch } as unknown as VerbDeps
    const read = await readVerb.run(deps, { slotId: b } as unknown as VerbCaller, { canal: 'obra', limit: 20 })
    assert.match(read.text, new RegExp(`${s1} ${nameA}: Terminei a revisão\\. Posso subir\\?  \\[👍 ${nameB}, ${ch.nameOf(USER)}\\]`), read.text)

    // ---- 5. a refusal: a 4th emoji of hers on one message ----
    console.log('step 5')
    for (const e of ['✅', '🎉']) assert.ok((await ch.react(USER, id, { seq: s1, reaction: e })).ok)
    await pillIs(s1, '🎉', 1, true)
    await msg(s1).hover()
    await msg(s1).locator('.ch-hb-b[data-key="❌"]').click()
    await waitView('the refusal notice', v => v.toast !== '')
    assert.equal((await view())!.toast, 'Você já tem 3 reações nesta fala: tire uma para pôr outra.')
    await pillIs(s1, '❌', 0)
    assert.deepEqual((await personReactions(s1)).sort(), ['✅', '👍', '🎉'].sort(), 'nothing of the refused one was written')
    await page.screenshot({ path: join(SHOTS, 'guia-larga-recusa.png') })

    // ---- the narrow composition ----
    await pane.evaluate(e => { e.style.width = '340px'; e.style.maxWidth = '340px' })
    await page.waitForFunction(i => document.querySelector(`.ch-pane[data-channel="${i}"]`)?.classList.contains('narrow'), id)
    await pane.screenshot({ path: join(SHOTS, 'guia-estreita.png') })
    await pane.evaluate(e => { e.style.width = ''; e.style.maxWidth = '' })

    // ---- 6. closed: the pills stay, read only ----
    console.log('step 6')
    assert.ok((await ch.close(USER, id)).ok)
    await waitView('closed', v => v.closed)
    await page.waitForFunction(i => document.querySelector(`.ch-pane[data-channel="${i}"] .ch-pill.ro`) !== null, id)
    assert.equal(await pane.locator('button.ch-pill').count(), 0, 'no button on a pill of a closed channel')
    assert.ok(await pane.locator('.ch-pill.ro').count() >= 3)
    assert.equal(await pane.locator('.ch-pill.ro[data-emoji="👍"]').first().getAttribute('data-count'), '2')
    await msg(s1).hover()
    assert.equal(await msg(s1).locator('.ch-hb').isVisible().catch(() => false), false, 'no bar')
    await msg(s1).locator('p').click({ button: 'right' })
    await menu.waitFor({ state: 'visible' })
    const closedLabels = (await menu.locator('li[role^="menuitem"]').allTextContents()).map(t => t.trim())
    assert.deepEqual(closedLabels.map(t => t.replace(/\s.*$/, '')), ['Copiar', 'Copiar'], 'only copy is left')
    await page.keyboard.press('Escape')
    const before = (await ch.store.lastSeq(id))
    const refused = await ch.react(USER, id, { seq: s1, reaction: 'seen' })
    assert.deepEqual([refused.ok, !refused.ok && refused.error], [false, 'closed'])
    assert.equal(await ch.store.lastSeq(id), before, 'nothing written')
    await page.screenshot({ path: join(SHOTS, 'guia-encerrada.png') })
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
