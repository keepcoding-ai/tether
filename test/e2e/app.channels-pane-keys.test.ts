// E2E of G9, the channel's pane read and run by the keyboard alone: a tetherd in this process on a private home and pipe, two fake
// `claude` agents (test/fixtures/channels/agent.cjs, no LLM), the real app on the same pipe, hidden window. Nothing touches the person's tether.
//   1. the attributes of the plan's section 3 (toolbar, "Membros" pressed, list and listitem names, log, the box off and why);
//   2. the five gestures with KEYS ONLY, no click: juntar, calar, devolver a voz, tirar, encerrar (and reabrir), with the focus going back
//      to who opened the picker, the menu or the dialog (to the neighbour row when the member is gone);
//   3. the Tab order (bar, members, conversation, box) and Shift+F10 / the menu key on a member's row;
//   4. the narrow strip open: a member that does not hear says "não ouve" beside its dot (picture in onda-3/gestao).
// The only thing done without keys is to put the focus at the start of the pane (the person arrives there by its tab or the palette).
// Run alone: node --test test/e2e/app.channels-pane-keys.test.ts   (one E2E at a time: the build is remade)
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

type Aria = {
  toolbar: { role: string; label: string }
  membersBtn: { pressed: string; controls: string; hidden: boolean }
  fold: { expanded: string; label: string; controls: string }
  list: { role: string; label: string; items: Array<{ role: string; label: string }> }
  log: { role: string; live: string; label: string; relevant: string; tabindex: string }
  moreMenu: string
  tabs: string[]
}
type Snap = {
  closed: boolean
  composer?: { enabled: boolean; placeholder: string; label: string; note: string }
  members: Array<{ name: string; muted: boolean }>
  column: { shown: boolean }
  fold: { open: boolean }
  aria: Aria
}
type Hooks = {
  panelIds(): string[]
  ext: { channels: { run(id: string, arg?: unknown): void; view(id: string): Snap | undefined } }
}
declare const window: { __tether: Hooks }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const AGENT = fileURLToPath(new URL('../fixtures/channels/agent.cjs', import.meta.url))
const SHOTS = 'C:/atrium/.tmp/tether-agents/onda-3/gestao'

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
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  return { app, page }
}

test('channel pane: the whole management by keyboard, with the attributes of the plan', { timeout: 420_000 }, async () => {
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
      const id = (await doorApi.slots.create({ kind: 'claude', cwd: home, name, desk: 'desk-1' })).slotId
      await waitUntil(() => doorApi.slots.get(id)?.status === 'running' && doorApi.slots.readScreen(id).data.includes('READY'), 30_000, `${name} running`)
      if (name !== 'surdo') await waitUntil(() => doorApi.delivery.pathOf(id) === 'inside', 30_000, `${name} opened its stream`)
      return id
    }
    const a = await running('conferente')
    const b = await running('bancada')
    const nameA = ch.nameOf(a)
    const nameB = ch.nameOf(b)

    const made = await ch.create(USER, { name: 'teclado' })
    assert.ok(made.ok)
    const hz = made.channel.id

    let page: Page
    ;({ app, page } = await launch(home, pipe))
    await page.waitForFunction(() => typeof window.__tether.ext?.channels?.run === 'function')
    for (const id of [a, b]) await page.waitForFunction(p => window.__tether.panelIds().includes(p), id)
    const run = (id: string, arg?: unknown): Promise<void> => page.evaluate(([i, x]) => window.__tether.ext.channels.run(i as string, x), [id, arg] as const)
    const pane = (id: string) => page.locator(`.ch-pane[data-channel="${id}"]`)
    const ask = (situation: string) => page.locator(`dialog.ask[data-dialog="${situation}"]`)
    const picker = page.locator('dialog.picker[open]')
    const members = (id: string) => ch.store.get(id)!.members
    const view = async (id: string): Promise<Snap> => (await page.evaluate(i => window.__tether.ext.channels.view(i), id))!
    const resize = async (w: number, h: number): Promise<void> => {
      await app!.evaluate(({ BrowserWindow }, [ww, hh]) => { BrowserWindow.getAllWindows()[0]!.setSize(ww!, hh!) }, [w, h])
    }
    /** Where the focus is: its region, the member's row, the stop and the text, as the plan's attributes say them. */
    const where = () => page.evaluate(() => {
      const e = document.activeElement as HTMLElement | null
      const region = e === null ? '' : e.closest('dialog.ask') ? 'dialog' : e.closest('#ctx-menu') ? 'menu' : e.closest('dialog.picker') ? 'picker'
        : e.closest('.ch-bar') ? 'toolbar' : e.closest('.ch-fold') ? 'strip' : e.closest('.ch-members') ? 'members' : e.closest('.ch-msgs') ? 'log'
        : e.closest('.ch-say') ? 'composer' : e === document.body ? 'body' : 'other'
      return {
        region, cls: e?.className ?? '', act: e?.dataset?.act ?? '', choice: e?.dataset?.choice ?? '',
        member: e?.closest<HTMLElement>('.ch-mrow')?.dataset.member ?? '', text: (e?.textContent ?? '').trim(),
        label: e?.getAttribute('aria-label') ?? '', tag: e?.tagName ?? '',
      }
    })
    type Where = Awaited<ReturnType<typeof where>>
    /** Tab (forward or back, as the person knows where it is) until the stop is reached: the person walking to a button. */
    const tabTo = async (what: string, is: (w: Where) => boolean, key: 'Tab' | 'Shift+Tab' = 'Tab'): Promise<void> => {
      for (let i = 0; i < 40; i++) {
        if (is(await where())) return
        await page.keyboard.press(key)
      }
      assert.fail(`${what}: the keyboard did not reach it (focus is ${JSON.stringify(await where())})`)
    }
    /** Which way the member's row lies from where the focus is now (the list's order is the daemon's). */
    const dirTo = async (id: string): Promise<'Tab' | 'Shift+Tab'> => {
      const order = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.ch-mrow[data-member]')].map(r => r.dataset.member!))
      const here = order.indexOf((await where()).member)
      return here < 0 || order.indexOf(id) >= here ? 'Tab' : 'Shift+Tab'
    }
    const menuItem = async (text: string): Promise<void> => {
      for (let i = 0; i < 30; i++) {
        if ((await where()).text === text) return
        await page.keyboard.press('ArrowDown')
      }
      assert.fail(`menu row ${text} not reached`)
    }
    const mrow = (id: string) => `.ch-mrow[data-member="${id}"]`

    // ---- 1. the empty channel: attributes, the box off and why ----
    console.log('step 1')
    await resize(1900, 760)
    await run('channels.open', { channel: hz })
    await pane(hz).locator('.ch-nobody').waitFor()
    await page.waitForFunction(id => (document.querySelector(`.ch-pane[data-channel="${id}"]`)?.clientWidth ?? 0) >= 560, hz)
    const v0 = await view(hz)
    assert.deepEqual(v0.aria.toolbar, { role: 'toolbar', label: 'Ações do canal' })
    assert.deepEqual(v0.aria.log, { role: 'log', live: 'polite', label: 'Conversa do canal', relevant: 'additions', tabindex: '0' })
    assert.equal(v0.aria.moreMenu, 'menu')
    assert.equal(v0.aria.membersBtn.hidden, true, 'no members, no "Membros" button')
    // The box that is off says it: its name carries the reason and a live note announces the switch (a disabled field cannot take the focus to say it).
    assert.equal(v0.composer?.enabled, false)
    assert.equal(v0.composer?.label, 'Mensagem para o canal, desligada: ninguém ouve ainda')
    assert.equal(v0.composer?.note, 'A caixa de fala está desligada: ninguém ouve ainda. Junte um agente para falar.')
    // The slot also holds the poll form's own (hidden) warning region; the box's note is the one that announces the switch.
    assert.equal(await pane(hz).locator('.ch-composer-slot .ch-sr[role="status"]').count(), 1)
    assert.equal(await pane(hz).locator('.ch-composer-slot .ch-send').getAttribute('title'), 'Ninguém ouve ainda')

    // ---- 2. juntar, by keys ----
    console.log('step 2: juntar')
    await pane(hz).locator('.ch-bar .ch-join').evaluate(e => (e as HTMLElement).focus()) // arriving at the pane: the only thing not done by a key
    assert.equal((await where()).cls.includes('ch-join'), true)
    await page.keyboard.press('Enter')
    await picker.waitFor()
    // The box is a "many": Space marks the row, the filter keeps the marks, Enter joins the marked.
    await page.keyboard.type('conferente')
    await page.keyboard.press('Space')
    await page.keyboard.press('Control+A')
    await page.keyboard.type('bancada')
    await page.keyboard.press('Space')
    await page.keyboard.press('Enter')
    await waitUntil(() => a in members(hz) && b in members(hz), 15_000, 'both joined by keys')
    await picker.waitFor({ state: 'detached' })
    await page.waitForFunction(id => window.__tether.ext.channels.view(id)?.composer?.enabled === true, hz)
    // The focus is back where the picker was opened from.
    await page.waitForFunction(() => document.activeElement?.classList.contains('ch-join') === true)
    await pane(hz).locator(mrow(a)).waitFor()
    await pane(hz).locator('.ch-sys', { hasText: /entrou em #teclado/ }).first().waitFor()

    // ---- 3. the attributes with two members, and the Tab order ----
    console.log('step 3: atributos e ordem do Tab')
    const v1 = await view(hz)
    assert.deepEqual(v1.aria.membersBtn, { pressed: 'true', controls: `ch-members-${hz}`, hidden: false })
    assert.equal(await pane(hz).locator('.ch-members').getAttribute('id'), `ch-members-${hz}`)
    assert.equal(v1.aria.list.role, 'list')
    assert.equal(v1.aria.list.label, 'Membros')
    assert.deepEqual(v1.aria.list.items.map(i => i.role), ['listitem', 'listitem', 'listitem'])
    const labels = v1.aria.list.items.map(i => i.label)
    assert.ok(labels.includes(`${nameA}, membro, ouvindo`), labels.join(' | '))
    assert.ok(labels.includes(`${nameB}, membro, ouvindo`), labels.join(' | '))
    assert.ok(labels.includes('Você, moderador, lê tudo e fala em qualquer canal'), labels.join(' | '))
    assert.equal(v1.composer?.label, 'Mensagem para o canal')
    assert.equal(v1.composer?.note, '')
    assert.deepEqual(v1.aria.tabs, ['toolbar', 'members', 'log', 'composer'], 'the DOM order is the Tab order')
    // The same, walked with the real Tab from the accent to the box.
    const walked: string[] = []
    for (let i = 0; i < 40; i++) {
      const w = await where()
      if (walked.at(-1) !== w.region) walked.push(w.region)
      if (w.region === 'composer' && w.tag === 'TEXTAREA') break
      await page.keyboard.press('Tab')
    }
    assert.deepEqual(walked, ['toolbar', 'members', 'log', 'composer'])
    // "Membros" is a toggle with its state said.
    await tabTo('Membros', w => w.cls.includes('ch-act') && w.label === 'Membros', 'Shift+Tab')
    await page.keyboard.press('Enter')
    await page.waitForFunction(id => window.__tether.ext.channels.view(id)?.aria.membersBtn.pressed === 'false', hz)
    assert.equal((await view(hz)).column.shown, false)
    await page.keyboard.press('Enter')
    await page.waitForFunction(id => window.__tether.ext.channels.view(id)?.aria.membersBtn.pressed === 'true', hz)
    await pane(hz).locator(mrow(a)).waitFor()

    // ---- 4. Shift+F10 and the menu key on a member's row; Esc gives the focus back ----
    console.log('step 4: Shift+F10 e tecla de menu')
    await tabTo('name of A', w => w.region === 'members' && w.member === a && w.cls.includes('ch-link'))
    await page.keyboard.press('Shift+F10')
    await page.waitForSelector('#ctx-menu li')
    assert.match((await page.locator('#ctx-menu li').first().innerText()).trim(), /membro/)
    assert.equal((await where()).region, 'menu')
    await page.keyboard.press('Escape')
    await page.waitForSelector('#ctx-menu li', { state: 'detached' })
    let w = await where()
    assert.equal(w.region === 'members' && w.member === a && w.cls.includes('ch-link'), true, `focus back on the name: ${JSON.stringify(w)}`)
    await page.keyboard.press('ContextMenu')
    await page.waitForSelector('#ctx-menu li')
    await page.keyboard.press('Escape')
    await page.waitForSelector('#ctx-menu li', { state: 'detached' })
    w = await where()
    assert.equal(w.region === 'members' && w.member === a && w.cls.includes('ch-link'), true, `focus back on the name after the menu key: ${JSON.stringify(w)}`)
    // The "⋯" of the row: Enter opens the menu, Esc gives the focus back to it (the plan's pending item).
    await tabTo('⋯ of B', x => x.region === 'members' && x.member === b && x.act === 'more', await dirTo(b))
    assert.equal(await pane(hz).locator(`${mrow(b)} .ch-mmore`).getAttribute('aria-expanded'), 'false')
    await page.keyboard.press('Enter')
    await page.waitForSelector('#ctx-menu li')
    assert.equal(await pane(hz).locator(`${mrow(b)} .ch-mmore`).getAttribute('aria-expanded'), 'true')
    await page.keyboard.press('Escape')
    await page.waitForSelector('#ctx-menu li', { state: 'detached' })
    w = await where()
    assert.equal(w.region === 'members' && w.member === b && w.act === 'more', true, `focus back on the ⋯: ${JSON.stringify(w)}`)
    assert.equal(await pane(hz).locator(`${mrow(b)} .ch-mmore`).getAttribute('aria-expanded'), 'false')

    // ---- 5. calar (asks), by keys; the focus stays on the row's button ----
    console.log('step 5: calar')
    await tabTo('Calar B', x => x.region === 'members' && x.member === b && x.act === 'mute', 'Shift+Tab')
    assert.equal((await where()).label, `Calar ${nameB}`)
    await page.keyboard.press('Enter')
    await ask('channels.mute').waitFor()
    // The dialog takes the focus on its one choice: Enter confirms.
    w = await where()
    assert.deepEqual([w.region, w.choice], ['dialog', 'mute'])
    await page.keyboard.press('Enter')
    await waitUntil(() => members(hz)[b]?.muted !== undefined, 10_000, 'b muted')
    await ask('channels.mute').waitFor({ state: 'detached' })
    await pane(hz).locator(`${mrow(b)} [data-act="unmute"]`).waitFor()
    await pane(hz).locator('.ch-sys', { hasText: /foi calado em #teclado/ }).first().waitFor()
    // The row was redrawn (a muted chip, the other icon): the focus is on the same stop, now "Devolver a voz".
    await page.waitForFunction(([id]) => {
      const e = document.activeElement as HTMLElement | null
      return e?.dataset.act === 'unmute' && e.closest<HTMLElement>('.ch-mrow')?.dataset.member === id
    }, [b])
    assert.equal((await view(hz)).aria.list.items.some(i => i.label === `${nameB}, membro, calado, ouvindo`), true)

    // ---- 6. devolver a voz (no question), by keys ----
    console.log('step 6: devolver a voz')
    assert.equal((await where()).label, `Devolver a voz ${nameB}`)
    await page.keyboard.press('Enter')
    await waitUntil(() => members(hz)[b]?.muted === undefined, 10_000, 'b has the voice back')
    await page.waitForFunction(([id]) => {
      const e = document.activeElement as HTMLElement | null
      return e?.dataset.act === 'mute' && e.closest<HTMLElement>('.ch-mrow')?.dataset.member === id
    }, [b])

    // ---- 7. tirar (asks): the focus goes to the neighbour row ----
    console.log('step 7: tirar')
    await page.keyboard.press('Tab')
    w = await where()
    assert.deepEqual([w.member, w.act], [b, 'remove'])
    await page.keyboard.press('Enter')
    await ask('channels.remove').waitFor()
    assert.equal((await where()).choice, 'remove')
    await page.keyboard.press('Enter')
    await waitUntil(() => !(b in members(hz)), 10_000, 'b removed')
    await ask('channels.remove').waitFor({ state: 'detached' })
    await pane(hz).locator(mrow(b)).waitFor({ state: 'detached' })
    await page.waitForFunction(([id]) => {
      const e = document.activeElement as HTMLElement | null
      return e?.dataset.act === 'more' && e.closest<HTMLElement>('.ch-mrow')?.dataset.member === id
    }, [a])
    await pane(hz).locator('.ch-sys', { hasText: /foi tirado de #teclado/ }).first().waitFor()

    // ---- 8. encerrar (from the bar's "⋯"), by keys; the focus returns to the "⋯" ----
    console.log('step 8: encerrar')
    await tabTo('⋯ of the bar', x => x.region === 'toolbar' && x.cls.includes('ch-more'), 'Shift+Tab')
    await page.keyboard.press('Enter')
    await page.waitForSelector('#ctx-menu li')
    assert.equal(await pane(hz).locator('.ch-bar .ch-more').getAttribute('aria-expanded'), 'true')
    await menuItem('Encerrar canal…')
    await page.keyboard.press('Enter')
    await ask('channels.close').waitFor()
    assert.equal((await where()).choice, 'close')
    await page.keyboard.press('Enter')
    await waitUntil(() => ch.store.get(hz)!.closed !== undefined, 10_000, 'closed')
    await ask('channels.close').waitFor({ state: 'detached' })
    await pane(hz).locator('.ch-closed').waitFor()
    await page.waitForFunction(() => document.activeElement?.classList.contains('ch-more') === true)
    assert.equal(await pane(hz).locator('.ch-bar .ch-more').getAttribute('aria-expanded'), 'false')
    assert.equal((await view(hz)).closed, true)

    // ---- 9. reabrir, by keys: the accent swaps its face and the focus follows it ----
    console.log('step 9: reabrir')
    await tabTo('Reabrir', x => x.region === 'toolbar' && x.cls.includes('ch-reopen'), 'Shift+Tab')
    await page.keyboard.press('Enter')
    await ask('channels.reopen').waitFor()
    assert.equal((await where()).choice, 'reopen')
    await page.keyboard.press('Enter')
    await waitUntil(() => ch.store.get(hz)!.closed === undefined, 10_000, 'reopened')
    await pane(hz).locator('.ch-closed').waitFor({ state: 'detached' })
    await page.waitForFunction(() => document.activeElement?.classList.contains('ch-join') === true)

    // ---- 10. the narrow strip open: "não ouve" beside the dot (G9's addition) ----
    console.log('step 10: faixa estreita')
    const s = await running('surdo')
    assert.ok((await ch.join(USER, hz, s)).ok)
    await resize(1650, 760)
    await page.waitForFunction(id => document.querySelector(`.ch-pane[data-channel="${id}"]`)?.classList.contains('narrow') === true, hz)
    await pane(hz).locator('.ch-fold').waitFor()
    await page.waitForFunction(id => window.__tether.ext.channels.view(id)?.members.length === 2, hz)
    // The strip is a button of the Tab order, before the members and the conversation.
    await tabTo('the strip', x => x.region === 'strip')
    // (The person opened the column earlier in this pane, so the strip may come down already: fold it first, by key.)
    if ((await view(hz)).aria.fold.expanded === 'true') await page.keyboard.press('Enter')
    await page.waitForFunction(id => window.__tether.ext.channels.view(id)?.aria.fold.expanded === 'false', hz)
    const nv = await view(hz)
    assert.match(nv.aria.fold.label, /1 não ouve agora\. Mostrar membros$/)
    assert.equal(nv.aria.fold.controls, `ch-members-${hz}`)
    await page.keyboard.press('Enter')
    await pane(hz).locator(mrow(s)).waitFor()
    const open = await view(hz)
    assert.equal(open.aria.fold.expanded, 'true')
    assert.match(open.aria.fold.label, /Recolher membros$/)
    assert.deepEqual(open.aria.tabs, ['toolbar', 'strip', 'members', 'log', 'composer'])
    const deafRow = pane(hz).locator(mrow(s))
    const lbl = deafRow.locator('.ch-warnlbl')
    assert.equal(await lbl.isVisible(), true)
    assert.equal(await lbl.innerText(), 'não ouve')
    assert.equal(await lbl.getAttribute('aria-hidden'), 'true')
    assert.equal(await deafRow.getAttribute('aria-label'), `${ch.nameOf(s)}, membro, não ouve agora · falas em espera`)
    // On one line, in the warning tone, beside the dot; the row of a member that hears has no label.
    assert.ok((await deafRow.boundingBox())!.height < 36, 'one-line row')
    const dotBox = (await deafRow.locator('.ch-dot').boundingBox())!
    const lblBox = (await lbl.boundingBox())!
    assert.ok(lblBox.x >= dotBox.x + dotBox.width - 1 && Math.abs((lblBox.y + lblBox.height / 2) - (dotBox.y + dotBox.height / 2)) < 8, 'the words sit beside the dot')
    const dotColor = await deafRow.locator('.ch-dot').evaluate(e => getComputedStyle(e).backgroundColor)
    assert.equal(await lbl.evaluate(e => getComputedStyle(e).color), dotColor, 'the label is in the dot\'s warning tone')
    assert.equal(await pane(hz).locator(`${mrow(a)} .ch-warnlbl`).isVisible(), false)
    await pane(hz).screenshot({ path: join(SHOTS, 'g9-nao-ouve-estreita.png') })
    await page.keyboard.press('Enter') // back on the strip: it folds again
    await page.waitForFunction(id => window.__tether.ext.channels.view(id)?.fold.open === false, hz)
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
