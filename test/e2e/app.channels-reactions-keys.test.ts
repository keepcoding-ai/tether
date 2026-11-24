// E2E of the reactions by keyboard (slice R4): a tetherd in this process on a private home and pipe, with the channels extension's
// record and requests on its door and two fake `claude` agents (no LLM); the real app on the same pipe, hidden window.
// NOTHING IS CLICKED: every gesture is a key (the only thing not done by a key is to put the focus at the start of the pane, as the
// person arrives there by its tab or the palette).
//   1. the arrows walk the speeches (one Tab stop for the log), the focused speech reads as a whole (author, time, to whom, text, reactions);
//   2. `2` reacts and, again, takes it back; the pill's name says the meaning, how many, who and whether it is hers; a reaction of an
//      agent is said aloud in one sentence (the live region), the conversation is not read again;
//   3. `R` opens the picker (the five, the recents, the "outro emoji" field with its hint); another emoji typed; a text is refused;
//      a recent chosen and taken back; Esc closes and the focus goes back to the speech;
//   4. the menu key (and Shift+F10) opens the speech's menu, the pill's menu; Esc gives the focus back; a row of the menu reacts;
//   5. the palette's rows react to the focused speech;
//   6. "+N" when the pills do not fit, its list; the narrow pane: the "⋯" in the speech, no hover bar, the picker at its foot;
//   7. scrolling back over more than a page of nothing but reactions does not ask the same page again.
// Run alone: node --test test/e2e/app.channels-reactions-keys.test.ts   (one E2E at a time: the build is remade)
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
import { sumReactions, USER } from '../../extensions/channels/rules.ts'
import type { PaneSnapshot } from '../../extensions/channels/renderer/channel-pane.ts'
import { removeHome, tempHome, uniquePipe, waitUntil } from '../unit/daemon.helpers.ts'
import { killElectron } from './electron.ts'

type Hooks = {
  panelIds(): string[]
  ext: { channels: {
    open(channelId: string, name?: string): void
    view(channelId: string): PaneSnapshot | undefined
    loadOlder(channelId: string): Promise<void>
  } }
}
declare const window: { __tether: Hooks }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const AGENT = fileURLToPath(new URL('../fixtures/channels/agent.cjs', import.meta.url))
const SHOTS = 'C:/atrium/.tmp/tether-agents/onda-3/reacoes/r4'

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

test('channel pane: reactions by keyboard (arrows, 1-5, R, picker, menu key, palette, "+N", narrow)', { timeout: 480_000 }, async () => {
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
    const m2 = await ch.say(b, id, { body: 'Os testes passam: 42 de 42' })
    const m3 = await ch.say(USER, id, { body: 'Sobe depois do almoço.' })
    assert.ok(m1.ok && m2.ok && m3.ok)
    const [s1, s2, s3] = [m1.line.seq, m2.line.seq, m3.line.seq]

    let page: Page
    ;({ app, page } = await launch(home, pipe))
    await page.waitForFunction(() => typeof window.__tether.ext?.channels?.open === 'function')
    const view = (cid = id): Promise<PaneSnapshot | undefined> => page.evaluate(i => window.__tether.ext.channels.view(i), cid)
    const until = async (what: string, fn: () => Promise<boolean>, ms = 15_000): Promise<void> => {
      const end = Date.now() + ms
      for (;;) {
        if (await fn()) return
        if (Date.now() > end) throw new Error(`timeout: ${what}\nfocus: ${JSON.stringify(await where())}`)
        await new Promise(r => setTimeout(r, 80))
      }
    }
    const waitView = (what: string, fn: (v: PaneSnapshot) => boolean, cid = id): Promise<void> => until(what, async () => { const v = await view(cid); return v !== undefined && fn(v) })
    const pane = page.locator(`.ch-pane[data-channel="${id}"]`)
    const msg = (seq: number) => pane.locator(`.ch-msg[data-seq="${seq}"]`)
    const pill = (seq: number, emoji: string) => msg(seq).locator(`.ch-pill[data-emoji="${emoji}"]`)
    const menu = page.locator('#ctx-menu')
    /** Where the keyboard is, as a person would say it. */
    const where = () => page.evaluate(() => {
      const e = document.activeElement as HTMLElement | null
      return {
        tag: e?.tagName ?? '', cls: e?.className ?? '', seq: e?.closest<HTMLElement>('.ch-msg')?.dataset.seq ?? '', onMsg: e?.classList.contains('ch-msg') ?? false,
        key: e?.dataset?.key ?? '', picker: !!e?.closest('.ch-pick'), menu: !!e?.closest('#ctx-menu'), text: (e?.textContent ?? '').replace(/\s+/g, ' ').trim(),
        log: e?.classList.contains('ch-msgs') ?? false,
      }
    })
    const onMsg = (seq: number) => until(`focus on speech ${seq}`, async () => { const w = await where(); return w.onMsg && w.seq === String(seq) })
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
    const key = (k: string): Promise<void> => page.keyboard.press(k)
    const tabTo = async (what: string, is: (w: Awaited<ReturnType<typeof where>>) => boolean, k = 'Tab'): Promise<void> => {
      for (let i = 0; i < 40; i++) {
        if (is(await where())) return
        await key(k)
      }
      assert.fail(`${what}: the keyboard did not reach it (${JSON.stringify(await where())})`)
    }
    const resize = async (w: number, h: number): Promise<void> => {
      await app!.evaluate(({ BrowserWindow }, [ww, hh]) => { BrowserWindow.getAllWindows()[0]!.setSize(ww!, hh!) }, [w, h])
    }

    await resize(1900, 760)
    await page.evaluate(([i, n]) => window.__tether.ext.channels.open(i!, n), [id, 'obra'] as const)
    await waitView('pane loaded', v => v.loaded && v.rows.filter(r => r.kind === 'say').length === 3)
    await page.waitForFunction(i => (document.querySelector(`.ch-pane[data-channel="${i}"]`)?.clientWidth ?? 0) >= 560, id)

    // ---- 1. the arrows walk the speeches; the focused speech reads whole ----
    console.log('step 1: setas e nome da fala')
    await pane.locator('.ch-bar .ch-more').evaluate(e => (e as HTMLElement).focus()) // arriving at the pane: the only thing not done by a key
    await tabTo('the conversation', w => w.log)
    assert.equal((await view())!.aria.log.tabindex, '0', 'the log is the one Tab stop of the conversation')
    await key('ArrowUp')
    await onMsg(s3)
    await key('ArrowUp')
    await onMsg(s2)
    await key('ArrowUp')
    await onMsg(s1)
    await key('ArrowDown')
    await onMsg(s2)
    assert.equal((await view())!.focusSeq, s2)
    const label2 = (await msg(s2).getAttribute('aria-label'))!
    assert.match(label2, new RegExp(`^${nameB}, \\d\\d:\\d\\d, para todos\\. Os testes passam: 42 de 42\\.$`), label2)
    assert.equal(await msg(s2).getAttribute('role'), 'article')
    assert.equal(await msg(s3).getAttribute('aria-label').then(t => /^Você, \d\d:\d\d, para todos\. Sobe depois do almoço\.$/.test(t!)), true)

    // ---- 2. 1-5 react (and take back); the names of the pills; what is said aloud ----
    console.log('step 2: 2 reage, de novo tira, nomes das pílulas, anúncio')
    await key('2')
    await pillIs(s2, '👍', 1, true)
    assert.deepEqual(await personReactions(s2), ['👍'])
    assert.equal((await where()).seq, String(s2), 'the focus stays on the speech')
    assert.equal(await pill(s2, '👍').getAttribute('aria-label'), 'concordo, 1 reação: Você. Você reagiu. Clique para tirar.')
    assert.equal(await pill(s2, '👍').getAttribute('aria-pressed'), 'true')
    assert.match((await msg(s2).getAttribute('aria-label'))!, /Reações: concordo, 1\.$/)
    await waitView('said aloud: own reaction', v => v.announce === `Você reagiu com concordo à fala de ${nameB}.`)
    await key('2')
    await pillIs(s2, '👍', 0)
    assert.deepEqual(await personReactions(s2), [])
    await waitView('said aloud: own reaction taken back', v => v.announce === `Você tirou concordo da fala de ${nameB}.`)
    assert.equal(await msg(s2).locator('.ch-rx').count(), 0, 'no reaction: no room taken')
    assert.doesNotMatch((await msg(s2).getAttribute('aria-label'))!, /Reações/)
    // An agent reacts: one short sentence, the pill appears, the focus does not move.
    assert.ok((await ch.react(a, id, { seq: s2, reaction: 'agree' })).ok)
    await pillIs(s2, '👍', 1, false)
    await waitView('said aloud: the agent', v => v.announce === `${nameA} reagiu com concordo à fala de ${nameB}.`)
    assert.equal(await pane.locator('.ch-announce').getAttribute('aria-live'), 'polite')
    assert.equal(await msg(s2).locator('.ch-rx').getAttribute('aria-live'), 'off', 'the group of pills is not re-read by the log')
    assert.equal((await where()).seq, String(s2))
    await key('2')
    await pillIs(s2, '👍', 2, true)
    assert.equal(await pill(s2, '👍').getAttribute('aria-label'), `concordo, 2 reações: Você e ${nameA}. Você reagiu. Clique para tirar.`)
    assert.match((await msg(s2).getAttribute('aria-label'))!, /Reações: concordo, 2\.$/)
    await page.screenshot({ path: join(SHOTS, 'guia-larga-foco-pilulas.png') })

    // ---- 3. R opens the picker; a recent; another emoji; a refusal; Esc ----
    console.log('step 3: R e o seletor')
    await key('ArrowUp')
    await onMsg(s1)
    await key('r')
    await waitView('picker open', v => v.picker.open && v.picker.seq === s1)
    assert.equal((await where()).picker, true, 'the focus is in the picker')
    assert.deepEqual(await pane.locator('.ch-pick .ch-pk-five .ch-pk-b').evaluateAll(bs => bs.map(b => (b as HTMLElement).dataset.key)), ['👀', '👍', '✅', '❌', '❓'], 'the five agreed ones')
    assert.equal(await pane.locator('.ch-pick .ch-pk-five .ch-pk-b').nth(1).textContent().then(t => /concordo/.test(t!)), true, 'with the meaning written')
    assert.equal(await pane.locator('.ch-pick .ch-pk-rec').count(), 0, 'no recents yet')
    assert.match((await view())!.picker.hint, /Win \+ \./, 'the hint of the system picker (Windows)')
    await page.screenshot({ path: join(SHOTS, 'guia-larga-seletor.png') })
    await tabTo('the "outro emoji" field', w => w.cls.includes('ch-pk-in'))
    // A text is refused, in words, and the picker stays.
    await page.keyboard.insertText('abc')
    await key('Enter')
    await waitView('refusal in the field', v => v.picker.open && v.picker.error === 'Use um emoji só.')
    await key('Control+A')
    await page.keyboard.insertText('🎉🔥')
    await key('Enter')
    await waitView('two emojis refused', v => v.picker.open && v.picker.error === 'Use um emoji só.')
    await page.screenshot({ path: join(SHOTS, 'guia-larga-seletor-recusa.png') })
    await key('Control+A')
    await page.keyboard.insertText('🎉')
    await key('Enter')
    await pillIs(s1, '🎉', 1, true)
    assert.deepEqual(await personReactions(s1), ['🎉'])
    await onMsg(s1) // the focus went back to the speech
    assert.equal((await view())!.picker.open, false)
    // Esc closes it and the focus goes back to the speech.
    await key('r')
    await waitView('picker open again', v => v.picker.open)
    assert.deepEqual((await view())!.picker.recents, ['🎉'], 'the emoji she gave is a recent now')
    assert.equal(await pane.locator('.ch-pick .ch-pk-recent').count(), 1)
    await key('Escape')
    await waitView('picker closed by Esc', v => !v.picker.open)
    await onMsg(s1)
    // A recent: on the last speech, R, then the arrows walk the five and reach the recent (6th stop), Enter reacts; again takes it back.
    await key('ArrowDown'); await onMsg(s2)
    await key('ArrowDown'); await onMsg(s3)
    await key('r')
    await waitView('picker on the last speech', v => v.picker.open && v.picker.seq === s3)
    await tabTo('the recent', w => w.cls.includes('ch-pk-recent'), 'ArrowRight')
    await key('Enter')
    await pillIs(s3, '🎉', 1, true)
    await onMsg(s3)
    await key('r')
    await waitView('picker again', v => v.picker.open)
    assert.equal(await pane.locator('.ch-pick .ch-pk-recent').getAttribute('aria-pressed'), 'true', 'the picker marks what is given')
    await tabTo('the recent', w => w.cls.includes('ch-pk-recent'), 'ArrowRight')
    await key('Enter')
    await pillIs(s3, '🎉', 0)
    assert.deepEqual(await personReactions(s3), [])
    await onMsg(s3)

    // ---- 4. the menu key: the speech's menu and the pill's menu; the focus goes back ----
    console.log('step 4: tecla de menu')
    await key('ArrowUp'); await onMsg(s2)
    await key('ContextMenu')
    await menu.waitFor({ state: 'visible' })
    const labels = (await menu.locator('li[role^="menuitem"]').allTextContents()).map(t => t.replace(/\s+/g, ' ').trim())
    assert.deepEqual(labels.slice(0, 5), ['👀 Vi', '👍 Concordo', '✅ Feito', '❌ Discordo', '❓ Dúvida'])
    assert.ok(labels.some(t => t.startsWith('🙂 Outro emoji…') && t.endsWith('R')), `the menu names the picker's key: ${JSON.stringify(labels)}`)
    assert.ok(labels.some(t => t.includes('Copiar texto')) && labels.some(t => t.includes('Copiar referência')))
    assert.equal((await where()).menu, true, 'the focus is in the menu')
    assert.equal(await menu.locator('li[aria-checked="true"]').count(), 1, 'the menu marks what is given')
    await key('Escape')
    await menu.waitFor({ state: 'detached' })
    await onMsg(s2)
    await key('Shift+F10')
    await menu.waitFor({ state: 'visible' })
    await key('Escape')
    await menu.waitFor({ state: 'detached' })
    await onMsg(s2)
    // A row of the menu reacts: walk to "Dúvida" with the arrows, Enter.
    await key('ContextMenu')
    await menu.waitFor({ state: 'visible' })
    await tabTo('Dúvida', w => w.menu && w.text.includes('Dúvida'), 'ArrowDown')
    await key('Enter')
    await pillIs(s2, '❓', 1, true)
    await onMsg(s2)
    // The pill's menu: Tab walks into the speech's pills, the menu key opens the pill's, Esc gives the pill the focus back.
    await tabTo('the first pill', w => w.cls.includes('ch-pill')) // the author's name is a stop too, then the pills
    assert.equal((await where()).key, '👍')
    await key('ContextMenu')
    await menu.waitFor({ state: 'visible' })
    const pillMenu = (await menu.locator('li').allTextContents()).map(t => t.trim())
    assert.ok(pillMenu.includes('Tirar minha reação') && pillMenu.includes('Quem reagiu') && pillMenu.includes(nameA), JSON.stringify(pillMenu))
    await key('Escape')
    await menu.waitFor({ state: 'detached' })
    await until('the pill has the focus back', async () => { const w = await where(); return w.cls.includes('ch-pill') && w.key === '👍' })
    await key('Escape') // Esc on a pill: back to the speech
    await onMsg(s2)

    // ---- 5. the palette's rows ----
    console.log('step 5: paleta')
    await key('Control+Shift+P')
    await page.locator('#palette-input').waitFor({ state: 'visible' })
    await page.keyboard.type('Reagir')
    const items = await page.locator('#palette-list .pal-item').evaluateAll(l => l.map(i => (i as HTMLElement).dataset.command))
    for (const c of ['channels.react', 'channels.react.last', 'channels.react.seen', 'channels.react.agree', 'channels.react.done', 'channels.react.disagree', 'channels.react.question']) {
      assert.ok(items.includes(c), `the palette lists ${c}: ${JSON.stringify(items)}`)
    }
    await page.screenshot({ path: join(SHOTS, 'paleta.png') })
    for (let i = 0; i < 12; i++) {
      if (await page.locator('#palette-list .pal-item.selected').getAttribute('data-command') === 'channels.react.done') break
      await key('ArrowDown')
    }
    assert.equal(await page.locator('#palette-list .pal-item.selected').getAttribute('data-command'), 'channels.react.done')
    await key('Enter')
    await pillIs(s2, '✅', 1, true)
    assert.deepEqual((await personReactions(s2)).sort(), ['✅', '❓', '👍'].sort(), 'the three of the speech (the limit)')

    // ---- 6. "+N" when the pills do not fit; the narrow pane ----
    console.log('step 6: +N e guia estreita')
    for (const r of ['seen', 'agree', 'done']) assert.ok((await ch.react(a, id, { seq: s1, reaction: r })).ok)
    for (const r of ['question', 'disagree', '🔥']) assert.ok((await ch.react(b, id, { seq: s1, reaction: r })).ok)
    await pillIs(s1, '❌', 1, false)
    await msg(s1).locator('.ch-pill-more').waitFor() // the 7th (🔥) is behind "+1"
    await onMsg(s2) // the palette gave the focus back to the speech it acted on
    await key('ArrowUp'); await onMsg(s1)
    assert.equal(await msg(s1).locator('.ch-pill:not(.ch-pill-more):not(.ch-pill-add)').count(), 6, 'six pills fit in a wide pane')
    assert.equal(await msg(s1).locator('.ch-pill-more').textContent(), '+1')
    assert.equal(await msg(s1).locator('.ch-pill-add').getAttribute('aria-label'), 'Reagir com outro emoji')
    await tabTo('the "+N"', w => w.cls.includes('ch-pill-more'))
    await key('Enter')
    await menu.waitFor({ state: 'visible' })
    const more = (await menu.locator('li').allTextContents()).map(t => t.replace(/\s+/g, ' ').trim())
    assert.ok(more.includes('Outras reações') && more.some(t => t.startsWith('🔥 1') && t.includes(nameB)), JSON.stringify(more))
    await key('Escape')
    await menu.waitFor({ state: 'detached' })
    await until('the "+N" has the focus back', async () => (await where()).cls.includes('ch-pill-more'))
    await tabTo('the "+"', w => w.cls.includes('ch-pill-add'))
    await key('Enter') // the "+" opens the picker
    await waitView('picker from the "+"', v => v.picker.open && v.picker.seq === s1)
    await key('Escape')
    await waitView('closed', v => !v.picker.open)
    await onMsg(s1) // Esc gave the focus back to the speech
    await page.screenshot({ path: join(SHOTS, 'guia-larga-mais-n.png') })

    // The narrow pane: no hover bar, a "⋯" in the speech, fewer pills, the picker at the foot.
    await pane.evaluate(e => { e.style.width = '340px'; e.style.maxWidth = '340px' })
    await page.waitForFunction(i => document.querySelector(`.ch-pane[data-channel="${i}"]`)?.classList.contains('narrow'), id)
    await until('narrow redraw keeps the focus', async () => (await where()).onMsg && (await where()).seq === String(s1))
    assert.equal(await msg(s1).locator('.ch-pill:not(.ch-pill-more):not(.ch-pill-add)').count(), 4, 'four pills fit in a narrow pane')
    assert.equal(await msg(s1).locator('.ch-pill-more').textContent(), '+3')
    assert.equal(await msg(s2).locator('.ch-msg-more').isVisible(), true, 'the "⋯" is always there')
    assert.equal(await msg(s2).locator('.ch-msg-more').getAttribute('aria-label'), 'Reagir e mais ações da fala')
    assert.equal(await msg(s1).locator('.ch-hb').count() > 0 ? await msg(s1).locator('.ch-hb').isVisible() : false, false, 'no floating bar, even on the focused speech')
    const sizes = await msg(s1).evaluate(m => ({ row: m.getBoundingClientRect().width, scroll: (m.closest('.ch-msgs') as HTMLElement).scrollWidth, client: (m.closest('.ch-msgs') as HTMLElement).clientWidth }))
    assert.ok(sizes.scroll <= sizes.client + 1, `no sideways scroll in the narrow pane ${JSON.stringify(sizes)}`)
    await msg(s2).locator('.ch-msg-more').focus()
    await key('Enter') // the "⋯" opens the same menu
    await menu.waitFor({ state: 'visible' })
    assert.ok((await menu.locator('li').allTextContents()).some(t => t.includes('Concordo')))
    await key('Escape')
    await menu.waitFor({ state: 'detached' })
    await msg(s1).focus()
    await key('r')
    await waitView('narrow picker', v => v.picker.open)
    const geo = await page.evaluate(i => {
      const p = document.querySelector(`.ch-pane[data-channel="${i}"]`)!.getBoundingClientRect()
      const k = document.querySelector(`.ch-pane[data-channel="${i}"] .ch-pick`)!.getBoundingClientRect()
      return { pw: p.width, kw: k.width, kl: k.left - p.left }
    }, id)
    assert.ok(geo.kw >= geo.pw - 20 && geo.kw <= geo.pw, `the picker takes the width of the pane ${JSON.stringify(geo)}`)
    await pane.screenshot({ path: join(SHOTS, 'guia-estreita-seletor.png') })
    await key('Escape')
    await waitView('narrow picker closed', v => !v.picker.open)
    await pane.screenshot({ path: join(SHOTS, 'guia-estreita.png') })
    await pane.evaluate(e => { e.style.width = ''; e.style.maxWidth = '' })

    // ---- 7. a closed channel: the keys do nothing but the menu (copy) ----
    console.log('step 7: encerrado')
    assert.ok((await ch.close(USER, id)).ok)
    await waitView('closed', v => v.closed)
    await page.waitForFunction(i => document.querySelector(`.ch-pane[data-channel="${i}"] .ch-pill.ro`) !== null, id)
    assert.equal(await pane.locator('.ch-pill-add').count(), 0, 'no "+" in a closed channel')
    await msg(s3).focus()
    const rxBefore = await ch.store.lastSeq(id)
    await key('3'); await key('r')
    assert.equal((await view())!.picker.open, false)
    await key('ContextMenu')
    await menu.waitFor({ state: 'visible' })
    assert.deepEqual((await menu.locator('li[role^="menuitem"]').allTextContents()).map(t => t.replace(/\s.*$/, '')), ['Copiar', 'Copiar'])
    await key('Escape')
    assert.equal(await ch.store.lastSeq(id), rxBefore, 'nothing was written')

    // ---- 8. scrolling back over more than a page of nothing but reactions ----
    console.log('step 8: rolar para trás sobre uma página só de reações')
    const lm = await ch.create(USER, { name: 'longa' })
    assert.ok(lm.ok)
    const lid = lm.channel.id
    assert.ok((await ch.join(USER, lid, a)).ok)
    const old = await ch.say(a, lid, { body: 'a fala antiga' })
    assert.ok(old.ok)
    for (let i = 0; i < 120; i++) {
      await ch.store.append(lid, { kind: 'reaction', from: { id: a, name: nameA, role: 'member' }, body: '', react: { seq: old.line.seq, emoji: '👀', op: 'add' } })
    }
    assert.ok((await ch.say(a, lid, { body: 'a fala recente' })).ok)
    await page.evaluate(([i, n]) => window.__tether.ext.channels.open(i!, n), [lid, 'longa'] as const)
    await waitView('long pane loaded', v => v.loaded && v.rows.some(r => r.text === 'a fala recente'), lid)
    assert.equal((await view(lid))!.rows.some(r => r.text === 'a fala antiga'), false, 'the old speech is more than a page back')
    assert.equal((await view(lid))!.more, true)
    await page.evaluate(i => window.__tether.ext.channels.loadOlder(i), lid)
    await waitView('the old speech is reached', v => v.rows.some(r => r.text === 'a fala antiga'), lid)
    assert.equal(await page.locator(`.ch-pane[data-channel="${lid}"] .ch-msg[data-seq="${old.line.seq}"] .ch-pill[data-emoji="👀"]`).count(), 1, 'with its pill')
    assert.equal((await view(lid))!.more, false)
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
