// E2E of the channel's pane, reading only (slice U1a): a tetherd in this process on a private home and pipe, with the channels
// extension's record and requests on its door and two fake `claude` agents (test/fixtures/channels/agent.cjs, no LLM); the real app
// on the same pipe, hidden window. Nothing touches the person's tether.
//   1. the pane opens (id channel:<id>) with the newest page of the history and the members, each with its state, the muted marked;
//      a system line is drawn apart from a say; the speaking box is not there (its place is);
//   2. older pages come by `history before`, never a repeat, the place the person reads stays;
//   3. a new line reaches a pane that is NOT the active one: nothing activates, no desk switches, the pane follows the end when shown;
//   4. a new line while the person reads above: the view does not move, a bar counts them, a click goes to the end;
//   5. the pane moved to another desk is rebuilt and keeps its place (lines held, where it was reading).
// Run alone: node --test test/e2e/app.channels-pane.test.ts   (one E2E at a time: the build is remade)
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
import type { PaneSnapshot } from '../../extensions/channels/renderer/channel-pane.ts'
import { removeHome, tempHome, uniquePipe, waitUntil } from '../unit/daemon.helpers.ts'
import { killElectron } from './electron.ts'

type Hooks = {
  panelIds(): string[]
  activeId(): string | undefined
  currentPane(): string | undefined
  activeDesk(): string
  deskOf(slotId: string): string | undefined
  switchDesk(id: string): void
  activate(slotId: string): void
  openMove(slotId: string): void
  ext: { channels: {
    open(channelId: string, name?: string): void
    view(channelId: string): PaneSnapshot | undefined
    kept(channelId: string): boolean
    scrollTo(channelId: string, top: number): void
    loadOlder(channelId: string): Promise<void>
  } }
}
declare const window: { __tether: Hooks }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const AGENT = fileURLToPath(new URL('../fixtures/channels/agent.cjs', import.meta.url))
const SHOTS = 'C:/atrium/.tmp/tether-agents/onda-3/u1a'
const SHOTS_B = 'C:/atrium/.tmp/tether-agents/onda-3/u1b'
/** Lines seeded straight into the record (more than two pages of 50). */
const SEEDED = 120

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
  return { app, page }
}

test('channel pane: history, members, new lines, the place kept', { timeout: 420_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(SHOTS, { recursive: true })
  mkdirSync(SHOTS_B, { recursive: true })
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

    // The record: a channel of the person, two members, one muted (real gestures: they leave system lines), then a long history.
    const made = await ch.create(USER, { name: 'obra', title: 'Obra' })
    assert.ok(made.ok)
    const id = made.channel.id
    assert.ok((await ch.join(USER, id, a)).ok)
    assert.ok((await ch.join(USER, id, b)).ok)
    assert.ok((await ch.mute(USER, id, b)).ok)
    const nameA = ch.nameOf(a)
    const nameB = ch.nameOf(b)
    for (let i = 1; i <= SEEDED; i++) {
      const from = i % 2 === 0 ? { id: a, name: nameA } : { id: b, name: nameB }
      await ch.store.append(id, { kind: 'message', from: { ...from, role: 'member' }, body: `fala ${i}`, ...(i % 10 === 0 ? { to: [nameA] } : {}) })
    }
    const total = (await ch.store.lastSeq(id))

    let page: Page
    ;({ app, page } = await launch(home, pipe))
    await page.waitForFunction(() => typeof window.__tether.ext?.channels?.open === 'function').catch(async (e: unknown) => {
      const seen = await page.evaluate(() => Object.keys(window.__tether.ext ?? {}))
      throw new Error(`the channels hooks never came (extensions with hooks: ${seen.join(', ')}); ${(e as Error).message}`)
    })
    const view = (): Promise<PaneSnapshot | undefined> => page.evaluate(i => window.__tether.ext.channels.view(i), id)
    const state = (): Promise<{ desk: string; active: string | undefined; current: string | undefined }> =>
      page.evaluate(() => ({ desk: window.__tether.activeDesk(), active: window.__tether.activeId(), current: window.__tether.currentPane() }))
    const paneId = `channel:${id}`
    const msgs = page.locator(`.ch-pane[data-channel="${id}"] .ch-msgs`)
    const atEnd = async (): Promise<boolean> => { const s = (await view())!.scroll; return s.height - (s.top + s.client) <= 24 }
    // The page forbids eval (CSP): the test polls the snapshot and judges it here.
    const waitView = async (what: string, fn: (v: PaneSnapshot) => boolean, ms = 15_000): Promise<void> => {
      const end = Date.now() + ms
      for (;;) {
        const s = await view()
        if (s !== undefined && fn(s)) return
        if (Date.now() > end) throw new Error(`timeout: ${what}\n${JSON.stringify(s ? { loaded: s.loaded, scroll: s.scroll, unread: s.unread, last: s.last, tail: s.rows.slice(-4).map(r => r.text) } : s)}`)
        await new Promise(r => setTimeout(r, 100))
      }
    }

    // ---- 1. open: the newest page, the members and the state of each ----
    console.log('step 1')
    await page.evaluate(([i, n]) => window.__tether.ext.channels.open(i!, n), [id, 'obra'] as const)
    await page.waitForFunction(p => window.__tether.panelIds().includes(p), paneId)
    await waitView('pane loaded', v => v.loaded)
    let v = (await view())!
    assert.equal(v.title, '#obra')
    assert.match(v.sub, /^2 membros · dono: Você$/)
    assert.equal(v.last, total)
    assert.equal(v.more, true, 'older lines exist')
    const says = v.rows.filter(r => r.kind === 'say')
    assert.equal(says.length, 50, 'the first page is 50 lines')
    assert.equal(says.at(-1)!.text, `fala ${SEEDED}`)
    assert.ok(v.rows.every(r => r.kind !== 'notice') || v.rows.some(r => r.kind === 'notice'))
    assert.deepEqual(v.members.map(m => [m.name, m.role, m.muted]).sort(), [[nameA, 'membro', false], [nameB, 'membro', true]].sort())
    assert.ok(v.members.every(m => m.tone === 'on' && m.state === 'ouvindo'), 'both hear from inside')
    assert.match(v.muteBar, /1 calado neste canal/)
    assert.equal(v.hasComposerSlot, true)
    assert.equal(await page.locator(`.ch-pane[data-channel="${id}"] .ch-composer-slot textarea`).count(), 1, 'the speaking box is in its slot')
    assert.equal(v.composer?.options[0], '', 'todos first')
    assert.deepEqual(new Set(v.composer?.options.slice(1)), new Set([nameA, nameB]))
    await page.waitForFunction(i => { const s = window.__tether.ext.channels.view(i)!.scroll; return s.client > 0 && s.height - (s.top + s.client) <= 24 }, id).catch(async () => { throw new Error(`does not open at the end: ${JSON.stringify((await view())!.scroll)}`) })
    await page.screenshot({ path: join(SHOTS, 'guia-aberta.png') })

    // ---- 2. older pages: by `before`, no repeat, the place stays ----
    console.log('step 2')
    await page.evaluate(i => window.__tether.ext.channels.scrollTo(i, 300), id)
    const before = (await view())!
    await page.evaluate(i => window.__tether.ext.channels.loadOlder(i), id)
    await waitView('second page', x => x.rows.filter(r => r.kind === 'say').length === 100)
    v = (await view())!
    const seqs = await page.locator(`.ch-pane[data-channel="${id}"] .ch-msg`).evaluateAll(es => es.map(e => Number((e as HTMLElement).dataset.seq)))
    assert.equal(new Set(seqs).size, seqs.length, 'no line repeated')
    assert.deepEqual([...seqs].sort((x, y) => x - y), seqs, 'ascending')
    assert.ok(v.scroll.top > before.scroll.top, 'the older lines went on top and the view moved down with them')
    await page.evaluate(i => window.__tether.ext.channels.loadOlder(i), id)
    await waitView('third page', x => x.more === false)
    v = (await view())!
    const bodies = v.rows.filter(r => r.kind === 'say').map(r => r.text)
    assert.equal(bodies.length, SEEDED, 'every seeded line, once')
    assert.equal(v.rows.filter(r => r.kind === 'notice').length >= 3, true, 'the gestures left system lines (create, joins, mute)')
    assert.equal(v.rows.findIndex(r => r.kind === 'notice') < v.rows.findIndex(r => r.kind === 'say'), true, 'notices come first, in order')
    assert.equal(await page.locator(`.ch-pane[data-channel="${id}"] .ch-sys`).count() >= 3, true)
    assert.equal(await page.locator(`.ch-pane[data-channel="${id}"] .ch-older`).count(), 0, 'no "Ver anteriores" once everything is loaded')
    const addressed = v.rows.filter(r => r.kind === 'say' && (r.to?.length ?? 0) > 0)
    assert.equal(addressed.length, SEEDED / 10)
    assert.deepEqual(addressed[0]!.to, [nameA])
    await page.evaluate(i => window.__tether.ext.channels.scrollTo(i, 1e9), id)
    assert.equal(await atEnd(), true)

    // ---- 3. a new line reaches a pane that is not the active one ----
    console.log('step 3')
    // Another pane in the same desk (a shell the daemon asks for, not active): the person goes to it, the channel's pane is behind.
    await waitUntil(() => (door.desks.map()?.desks.length ?? 0) >= 1, 20_000, 'the desk map reached the daemon')
    const shell = (await doorApi.slots.create({ kind: 'shell', cwd: home, desk: 'desk-1' })).slotId
    await page.waitForFunction(p => window.__tether.panelIds().includes(p), shell)
    await page.evaluate(p => window.__tether.activate(p), shell)
    await page.waitForFunction(p => window.__tether.currentPane() === p, shell)
    const still = await state()
    const said = await ch.say(a, id, { body: 'nova 1' })
    assert.ok(said.ok)
    await waitView('line while another pane is active', x => x.rows.some(r => r.text === 'nova 1'))
    assert.deepEqual(await state(), still, 'no desk, no active pane changed')
    await page.evaluate(p => window.__tether.activate(p), paneId)
    await page.waitForFunction(p => window.__tether.currentPane() === p, paneId)
    await page.waitForFunction(i => { const s = window.__tether.ext.channels.view(i)!.scroll; return s.client > 0 && s.height - (s.top + s.client) <= 24 }, id)
      .catch(async () => { throw new Error(`the pane did not follow the end when shown: ${JSON.stringify((await view())!.scroll)}`) })
    assert.equal((await view())!.unread, 0)

    // ---- 4. a new line while the person reads above: the view does not move ----
    console.log('step 4')
    await page.evaluate(i => window.__tether.ext.channels.scrollTo(i, 200), id)
    const reading = (await view())!
    assert.equal(reading.scroll.stick, false)
    const at0 = reading.scroll.top
    const topBefore = await state()
    assert.ok((await ch.say(a, id, { body: 'nova 2' })).ok)
    assert.ok((await ch.say(b, id, { body: 'nova 3 (calado)' })).ok === false, 'a muted member does not speak')
    assert.ok((await ch.say(a, id, { body: 'nova 4', to: [nameB] })).ok)
    await waitView('two new lines counted', x => x.unread === 2)
    v = (await view())!
    assert.ok(Math.abs(v.scroll.top - at0) <= 1, `the view stayed (${at0} -> ${v.scroll.top})`)
    assert.deepEqual(await state(), topBefore)
    const bar = page.locator(`.ch-pane[data-channel="${id}"] .ch-newbar`)
    assert.equal(await bar.isVisible(), true)
    assert.equal((await bar.textContent())!.trim(), '2 falas novas')
    await page.screenshot({ path: join(SHOTS, 'guia-lendo-acima.png') })
    await bar.click()
    await page.waitForFunction(i => { const s = window.__tether.ext.channels.view(i)!.scroll; return s.height - (s.top + s.client) <= 24 }, id)
    v = (await view())!
    assert.equal(v.unread, 0)
    assert.equal(await bar.isVisible(), false)
    assert.equal(v.rows.at(-1)!.text, 'nova 4')

    // ---- 5. moved to another desk: the place is kept ----
    console.log('step 5')
    await page.keyboard.press('Control+Shift+N')
    await page.waitForFunction(() => window.__tether.activeDesk() === 'desk-2')
    await page.evaluate(() => window.__tether.switchDesk('desk-1'))
    await page.waitForFunction(() => window.__tether.activeDesk() === 'desk-1')
    await page.evaluate(p => window.__tether.activate(p), paneId)
    await page.evaluate(i => window.__tether.ext.channels.scrollTo(i, 500), id)
    const mid = (await view())!
    assert.equal(mid.scroll.stick, false)
    const midSays = mid.rows.filter(r => r.kind === 'say').length
    await page.evaluate(p => window.__tether.openMove(p), paneId)
    await page.waitForSelector('dialog.move[open]')
    await page.click('dialog.move .mv-row.f[data-scope="desk-2"]')
    await page.hover('dialog.move .mv-pn .z-right')
    await page.waitForSelector('dialog.move .mv-pn[data-pv="right"]')
    await page.click('dialog.move .mv-pn .z-right')
    await page.click('#mv-go')
    await page.waitForFunction(p => window.__tether.deskOf(p) === 'desk-2', paneId)
    // A line while the pane sits on a desk that is not shown: it is heard all the same.
    assert.ok((await ch.say(a, id, { body: 'nova 5' })).ok)
    await page.evaluate(() => window.__tether.switchDesk('desk-2'))
    await page.waitForFunction(() => window.__tether.activeDesk() === 'desk-2')
    await waitView('rebuilt pane back with its lines', x => x.loaded && x.rows.some(r => r.text === 'nova 5') && x.scroll.client > 0)
    v = (await view())!
    assert.equal(v.rows.filter(r => r.kind === 'say').length, midSays + 1, 'the lines it held stayed (and the new one came)')
    assert.equal(v.scroll.stick, false, 'it was reading above, it still is')
    assert.ok(Math.abs(v.scroll.top - mid.scroll.top) <= 2, `the place was kept (${mid.scroll.top} -> ${v.scroll.top})`)
    assert.equal(await msgs.count(), 1, 'one pane, one channel')
    await page.screenshot({ path: join(SHOTS, 'guia-movida.png') })

    // ---- 6. speaking (U1b): Enter sends, Shift+Enter breaks the line, @name becomes `to`, a closed channel has no box ----
    console.log('step 6')
    const box = page.locator(`.ch-pane[data-channel="${id}"] .ch-composer-slot textarea`)
    const lastSay = async (): Promise<NonNullable<PaneSnapshot['rows'][number]>> => (await view())!.rows.filter(r => r.kind === 'say').at(-1)!
    await box.click()
    await box.fill('primeira')
    await page.keyboard.press('Shift+Enter')
    await page.keyboard.type('segunda')
    assert.equal((await view())!.composer!.text, 'primeira\nsegunda', 'Shift+Enter breaks the line and sends nothing')
    assert.notEqual((await lastSay()).text, 'primeira\nsegunda')
    await page.keyboard.press('Enter')
    await waitView('the moderator line came back', x => x.rows.some(r => r.text === 'primeira\nsegunda'))
    let mine = await lastSay()
    assert.equal(mine.mine, true)
    assert.equal(mine.role, 'moderador')
    assert.deepEqual(mine.to, [], 'no recipient: for everyone')
    assert.equal((await view())!.composer!.text, '', 'the box emptied')
    const seg = nameA.split(/[^\p{L}\p{N}_-]+/u).filter(Boolean).at(-1)!
    await box.fill(`@${seg.toUpperCase()} confere o log`)
    await page.keyboard.press('Enter')
    await waitView('the mention line came back', x => x.rows.some(r => r.text === `@${seg.toUpperCase()} confere o log`))
    mine = await lastSay()
    assert.deepEqual(mine.to, [nameA], '@name became `to`, by the name of the member')
    assert.equal(mine.mine, true)
    await box.fill('@ninguem oi')
    await page.keyboard.press('Enter')
    await waitView('the unmatched mention stays text', x => x.rows.some(r => r.text === '@ninguem oi'))
    mine = await lastSay()
    assert.deepEqual(mine.to, [], 'no member by that name: text only')
    // The recipient picked in the box is the address too.
    await page.selectOption(`.ch-pane[data-channel="${id}"] .ch-dsel`, nameB)
    await box.fill('para a bancada')
    await page.keyboard.press('Enter')
    await waitView('the picked recipient line', x => x.rows.some(r => r.text === 'para a bancada'))
    assert.deepEqual((await lastSay()).to, [nameB])
    assert.equal((await view())!.composer!.picked, '', 'after a send the recipient is back to "todos"')
    await box.fill('de novo, sem escolher')
    await page.keyboard.press('Enter')
    await waitView('the next line is for everyone', x => x.rows.some(r => r.text === 'de novo, sem escolher'))
    assert.deepEqual((await lastSay()).to, [])
    await page.screenshot({ path: join(SHOTS_B, 'guia-caixa.png') })
    // Closed: the box is gone, the closed notice is there.
    assert.ok((await ch.close(USER, id)).ok)
    await waitView('closed channel has no box', x => x.closed && x.composer === undefined)
    assert.equal(await box.count(), 0)
    await page.screenshot({ path: join(SHOTS_B, 'guia-encerrada.png') })
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
