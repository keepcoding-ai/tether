// E2E of the management gestures in the channel's own pane: a tetherd in this process on a private home and pipe, two fake `claude`
// agents (test/fixtures/channels/agent.cjs, no LLM), the real app on the same pipe, hidden window. Nothing touches the person's tether.
//   1. an empty channel shows "Ninguém no canal ainda." with a "Juntar agente" button, and the header has the same gesture;
//   2. the header button opens the agent picker of THIS channel; picking joins the agent and the empty state goes;
//   3. the column has no "+"; the "⋯" opens the tab's menu; a closed channel has no join button nor empty state, a common one has
//      "Reabrir canal" as its accent and a desk one has no accent;
//   4. the member's row has "calar" / "devolver a voz" and "tirar do canal": both ask first (the commands' dialogs), unmute acts at once.
// Run alone: node --test test/e2e/app.channels-pane-manage.test.ts   (one E2E at a time: the build is remade)
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

type Snap = {
  actions: { primary: string; labeled: boolean; more: boolean; toEnd: boolean }
  empty: boolean
  column: { shown: boolean; button: boolean }
  composer?: { enabled: boolean; placeholder: string; picked: string }
  members: Array<{ name: string; role: string; muted: boolean; state: string; tone: string; hint: string; acts: string[] }>
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

test('channel pane: join, mute and remove from the pane itself', { timeout: 420_000 }, async () => {
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
      // "surdo" never opens the stream: the person's pane holds it, so the member is on the `wait` route (G3's "não ouve agora").
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

    const made = await ch.create(USER, { name: 'horizontes' })
    assert.ok(made.ok)
    const hz = made.channel.id
    const old = await ch.create(USER, { name: 'velho' })
    assert.ok(old.ok)
    assert.ok((await ch.close(USER, old.channel.id)).ok)

    let page: Page
    ;({ app, page } = await launch(home, pipe))
    await page.waitForFunction(() => typeof window.__tether.ext?.channels?.run === 'function')
    for (const id of [a, b]) await page.waitForFunction(p => window.__tether.panelIds().includes(p), id)
    const run = (id: string, arg?: unknown): Promise<void> => page.evaluate(([i, x]) => window.__tether.ext.channels.run(i as string, x), [id, arg] as const)
    const pane = (id: string) => page.locator(`.ch-pane[data-channel="${id}"]`)
    const picker = page.locator('dialog.picker[open]')
    const ask = (situation: string) => page.locator(`dialog.ask[data-dialog="${situation}"]`)
    const members = (id: string) => ch.store.get(id)!.members
    const view = (id: string) => page.evaluate(i => window.__tether.ext.channels.view(i), id)
    const isNarrow = (id: string): Promise<boolean> => pane(id).evaluate(e => e.classList.contains('narrow'))
    const pickTitle =(): Promise<string> => page.locator('dialog.picker .pk-title').innerText()

    // ---- 1. the empty channel ----
    console.log('step 1')
    await run('channels.open', { channel: hz })
    await pane(hz).waitFor()
    await pane(hz).locator('.ch-nobody').waitFor()
    assert.match(await pane(hz).locator('.ch-nobody').innerText(), /Ninguém aqui ainda\./)
    assert.match(await pane(hz).locator('.ch-nobody').innerText(), /Junte um agente para a conversa começar/)
    // G2: no members, no column and no "Membros" button; the speaking box is off with its own words until someone hears.
    const empty = (await view(hz))!
    assert.equal(empty.empty, true)
    assert.deepEqual(empty.column, { shown: false, button: false })
    assert.equal(empty.composer?.enabled, false)
    assert.equal(empty.composer?.placeholder, 'Escreva para o canal… ninguém ouve ainda')
    assert.equal(await pane(hz).locator('.ch-composer-slot textarea').isDisabled(), true)
    assert.equal(await pane(hz).locator('.ch-composer-slot .ch-send').isDisabled(), true)
    assert.equal(await pane(hz).locator('.ch-bar button[aria-label="Membros"]').isVisible(), false)
    assert.equal(await pane(hz).locator('.ch-bar .ch-join').getAttribute('aria-label'), 'Juntar agente…')
    assert.equal(await pane(hz).locator('.ch-bar .ch-join').getAttribute('title'), 'Juntar agente…')
    // The empty state says the words once, in the body: the accent of the bar is only an icon here, and the column has no "+".
    assert.deepEqual((await view(hz))!.actions, { primary: 'join', labeled: false, more: true, toEnd: !(await isNarrow(hz)) })
    assert.equal(await pane(hz).locator('.ch-bar .ch-join .ch-lbl').isVisible(), false)
    assert.equal(await pane(hz).locator('.ch-sec-add').count(), 0)
    await page.screenshot({ path: join(SHOTS, 'canal-vazio.png') })

    // ---- 2. the empty state's button opens the agent picker of this channel ----
    console.log('step 2')
    await pane(hz).locator('.ch-join-empty').click()
    await picker.waitFor()
    assert.equal(await pickTitle(), 'Juntar a #horizontes')
    await page.keyboard.press('Escape')
    await picker.waitFor({ state: 'detached' })
    await pane(hz).locator('.ch-bar .ch-join').click()
    await picker.waitFor()
    assert.equal(await pickTitle(), 'Juntar a #horizontes')
    await page.locator('dialog.picker li.pk-item', { hasText: nameA }).click()
    await waitUntil(() => a in members(hz), 10_000, 'a joined by the header button')
    await pane(hz).locator('.ch-nobody').waitFor({ state: 'detached' })
    // A member came: the box is on again and the "Membros" button is back (the column itself follows the width).
    await page.waitForFunction(id => window.__tether.ext.channels.view(id)?.composer?.enabled === true, hz)
    assert.equal((await view(hz))!.composer?.placeholder, 'Escreva para o canal…')
    assert.equal(await pane(hz).locator('.ch-composer-slot textarea').isDisabled(), false)
    assert.equal((await view(hz))!.column.button, true)
    // A narrow pane folds the members away: the person opens the column.
    if (!(await pane(hz).locator('.ch-members').isVisible())) await pane(hz).locator('.ch-bar button[aria-label="Membros"]').click()
    await pane(hz).locator(`.ch-mrow[data-member="${a}"]`).waitFor()
    await page.screenshot({ path: join(SHOTS, 'canal-com-membro.png') })

    // With a member the accent carries its text in the wide composition and only the icon in the narrow one; the column has no "+".
    const narrow = await isNarrow(hz)
    assert.deepEqual((await view(hz))!.actions, { primary: 'join', labeled: !narrow, more: true, toEnd: !narrow })
    assert.equal(await pane(hz).locator('.ch-bar .ch-join .ch-lbl').isVisible(), !narrow)
    assert.equal(await pane(hz).locator('.ch-sec-add').count(), 0)

    // The "⋯" opens the tab's menu: the same rows, with "Ir para o fim" (the narrow bar drops its own button).
    await pane(hz).locator('.ch-bar .ch-more').click()
    await page.waitForSelector('#ctx-menu li')
    const moreLabels = (await page.locator('#ctx-menu li').allInnerTexts()).map(t => t.trim())
    // G4: the plan's rows in the plan's order (two lines of information first; nobody is muted yet, so no "Devolver a voz…").
    const MENU_ROWS = ['Juntar agente…', 'Membros', 'Ir para o fim', 'Calar agente…', 'Tirar agente…', 'Copiar link do painel', 'Mover…', 'Fechar painel', 'Encerrar canal…']
    // (The rows other extensions and the core add, "Dar esta guia a um agente…" and "Emblema…", are not the channel's.)
    const own = moreLabels.filter(t => t !== '' && t !== 'Dar esta guia a um agente…' && t !== 'Emblema…')
    assert.match(own[0]!, /^Dono: .+ · 1 membro$/)
    assert.equal(own[1], 'canal avulso')
    assert.deepEqual(own.slice(2), MENU_ROWS, `more menu: ${moreLabels.join(' | ')}`)
    await page.keyboard.press('Escape')
    await page.waitForSelector('#ctx-menu li', { state: 'detached' })
    // The tab's right click draws the very same rows (one place builds both).
    await page.locator('.ch-tab', { hasText: '#horizontes' }).first().click({ button: 'right' })
    await page.waitForSelector('#ctx-menu li')
    assert.deepEqual((await page.locator('#ctx-menu li').allInnerTexts()).map(t => t.trim()), moreLabels)
    await page.keyboard.press('Escape')
    await page.waitForSelector('#ctx-menu li', { state: 'detached' })

    // ---- 3. the member's row: mute (asks), unmute (at once), remove (asks) ----
    console.log('step 3')
    const row = pane(hz).locator(`.ch-mrow[data-member="${a}"]`)
    // G3: the "⋯" is on the row all the time (no hover needed); Calar and Tirar come with the hover.
    await page.mouse.move(2, 2)
    assert.equal(await row.locator('.ch-mmore').isVisible(), true)
    assert.equal(await row.locator('.ch-mmore').getAttribute('aria-haspopup'), 'menu')
    assert.equal(await row.locator('.ch-macts').evaluate(e => getComputedStyle(e).opacity), '0')
    assert.deepEqual((await view(hz))!.members.find(m => m.name === nameA)!.acts, ['mute', 'remove', 'more'])
    await row.hover()
    assert.equal(await row.locator('.ch-macts').evaluate(e => getComputedStyle(e).opacity), '1')
    await pane(hz).screenshot({ path: join(SHOTS, 'g3-linha.png') })
    // The menu of the member from the "⋯": who it is, then the rows of plan 2.6; Calar goes through its dialog.
    await row.locator('.ch-mmore').click()
    await page.waitForSelector('#ctx-menu li')
    const memberLabels = (await page.locator('#ctx-menu li').allInnerTexts()).map(t => t.trim()).filter(t => t !== '')
    assert.deepEqual(memberLabels, [`${nameA} · membro`, 'Calar', 'Tirar do canal', `Falar com ${nameA}`, 'Ir para a guia do agente'])
    await page.screenshot({ path: join(SHOTS, 'g3-menu.png') })
    await page.locator('#ctx-menu li', { hasText: /^Calar$/ }).click()
    await ask('channels.mute').waitFor()
    await ask('channels.mute').locator('button.choice[data-choice="mute"]').click()
    await waitUntil(() => members(hz)[a]?.muted !== undefined, 10_000, 'a muted')
    const unmute = row.locator('.ch-mact[data-act="unmute"]')
    await unmute.waitFor()
    assert.equal(await unmute.getAttribute('title'), `Devolver a voz ${nameA}`)
    // The mute shows in the line of the conversation and in the chip of the row.
    await pane(hz).locator('.ch-sys', { hasText: /calou|calad/i }).first().waitFor()
    assert.equal((await view(hz))!.members.find(m => m.name === nameA)!.muted, true)
    // G4: with somebody muted the menu counts it and offers "Devolver a voz…" right after "Calar agente…".
    await pane(hz).locator('.ch-bar .ch-more').click()
    await page.waitForSelector('#ctx-menu li')
    const mutedMenu = (await page.locator('#ctx-menu li').allInnerTexts()).map(t => t.trim()).filter(t => t !== '' && t !== 'Dar esta guia a um agente…')
    assert.match(mutedMenu[0]!, /^Dono: .+ · 1 membro · 1 calado$/)
    assert.deepEqual(mutedMenu.slice(2, 8), ['Juntar agente…', 'Membros', 'Ir para o fim', 'Calar agente…', 'Devolver a voz…', 'Tirar agente…'])
    await page.screenshot({ path: join(SHOTS, 'g4-menu.png') })
    await page.keyboard.press('Escape')
    await page.waitForSelector('#ctx-menu li', { state: 'detached' })
    await unmute.click()
    await waitUntil(() => members(hz)[a]?.muted === undefined, 10_000, 'a has the voice back')
    // "Falar com" puts the member in the box ("para …") and focuses it; no request goes out.
    await row.locator('.ch-mmore').click()
    await page.locator('#ctx-menu li', { hasText: `Falar com ${nameA}` }).click()
    assert.equal((await view(hz))!.composer?.picked, nameA)
    assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'TEXTAREA')
    await row.hover()
    await row.locator('.ch-mact[data-act="remove"]').click()
    await ask('channels.remove').waitFor()
    await ask('channels.remove').locator('button.choice[data-choice="remove"]').click()
    await waitUntil(() => !(a in members(hz)), 10_000, 'a removed')
    await pane(hz).locator('.ch-nobody').waitFor()
    // Back to nobody: the box goes off again (the whole way back).
    await page.waitForFunction(id => window.__tether.ext.channels.view(id)?.composer?.enabled === false, hz)
    // The row that held the focus is gone: the focus is on the accent "Juntar agente…".
    await page.waitForFunction(() => document.activeElement?.classList.contains('ch-join') === true)

    // The channel's tab menu has the gesture, and closing (from the menus hook).
    await page.locator('.ch-tab', { hasText: '#horizontes' }).first().click({ button: 'right' })
    await page.waitForSelector('#ctx-menu li')
    const labels = (await page.locator('#ctx-menu li').allInnerTexts()).map(t => t.trim())
    assert.ok(labels.includes('Juntar agente…') && labels.includes('Encerrar canal…'), `tab menu: ${labels.join(' | ')}`)
    await page.locator('#ctx-menu li', { hasText: 'Juntar agente…' }).click()
    await picker.waitFor()
    assert.equal(await pickTitle(), 'Juntar a #horizontes')
    await page.keyboard.press('Escape')
    await picker.waitFor({ state: 'detached' })

    // ---- 4. a closed channel offers none of it ----
    console.log('step 4')
    await run('channels.open', { channel: old.channel.id })
    await pane(old.channel.id).waitFor()
    await pane(old.channel.id).locator('.ch-closed').waitFor()
    assert.equal(await pane(old.channel.id).locator('.ch-bar .ch-join').isHidden(), true)
    assert.equal(await pane(old.channel.id).locator('.ch-nobody').count(), 0)
    assert.equal(await pane(old.channel.id).locator('.ch-sec-add').count(), 0)
    // A closed common channel has "Reabrir canal" as its accent, with text; the "⋯" stays.
    assert.deepEqual((await view(old.channel.id))!.actions, { primary: 'reopen', labeled: true, more: true, toEnd: !(await isNarrow(old.channel.id)) })
    assert.equal((await pane(old.channel.id).locator('.ch-bar .ch-reopen').innerText()).trim(), 'Reabrir canal')
    // (No confirmation yet: the dialog of reopening is the G8's.) The click reopens it and the accent turns into "Juntar agente…".
    await pane(old.channel.id).locator('.ch-bar .ch-reopen').click()
    await waitUntil(() => ch.store.get(old.channel.id)!.closed === undefined, 10_000, 'old reopened')
    await pane(old.channel.id).locator('.ch-closed').waitFor({ state: 'detached' })
    assert.equal((await view(old.channel.id))!.actions.primary, 'join')

    // ---- 5. a closed desk channel has no accent at all (it follows the desk), only the "⋯" ----
    console.log('step 5')
    const mesa = await ch.desk.open('desk-1', { name: 'obra', title: 'obra', owner: a, panes: [a] })
    assert.ok(mesa.ok)
    assert.ok((await ch.desk.close(mesa.channel.id, 'revoked')).ok)
    await run('channels.open', { channel: mesa.channel.id })
    await pane(mesa.channel.id).waitFor()
    await pane(mesa.channel.id).locator('.ch-closed').waitFor()
    assert.deepEqual((await view(mesa.channel.id))!.actions, { primary: 'none', labeled: false, more: true, toEnd: !(await isNarrow(mesa.channel.id)) })
    assert.equal(await pane(mesa.channel.id).locator('.ch-bar .ch-join').isHidden(), true)
    assert.equal(await pane(mesa.channel.id).locator('.ch-bar .ch-reopen').isHidden(), true)

    // ---- 6. the wide and the narrow composition (the pictures of the slice) ----
    console.log('step 6')
    assert.ok((await ch.join(USER, hz, a)).ok)
    const resize = async (w: number, h: number): Promise<void> => {
      await app!.evaluate(({ BrowserWindow }, [ww, hh]) => { BrowserWindow.getAllWindows()[0]!.setSize(ww!, hh!) }, [w, h])
    }
    await run('channels.open', { channel: hz })
    await pane(hz).locator(`.ch-mrow[data-member="${a}"]`).waitFor()
    // The desk holds three columns (the channel and the two agents): the window sizes put the channel's own pane above 560 px and at ~520.
    await resize(1900, 760)
    await page.waitForFunction(id => (document.querySelector(`.ch-pane[data-channel="${id}"]`)?.clientWidth ?? 0) >= 560, hz)
    assert.equal((await view(hz))!.actions.labeled, true)
    await pane(hz).screenshot({ path: join(SHOTS, 'g1-larga.png') })
    await resize(1650, 760)
    await page.waitForFunction(id => document.querySelector(`.ch-pane[data-channel="${id}"]`)?.classList.contains('narrow') === true, hz)
    assert.deepEqual((await view(hz))!.actions, { primary: 'join', labeled: false, more: true, toEnd: false })
    assert.equal(await pane(hz).locator('.ch-bar .ch-end').isVisible(), false)
    await pane(hz).screenshot({ path: join(SHOTS, 'g1-estreita.png') })

    // ---- 7. the empty channel, wide and narrow (the pictures of G2) ----
    console.log('step 7')
    const vazio = await ch.create(USER, { name: 'vazio' })
    assert.ok(vazio.ok)
    const vz = vazio.channel.id
    await run('channels.open', { channel: vz })
    await pane(vz).locator('.ch-nobody').waitFor()
    await resize(1900, 760)
    await page.waitForFunction(id => (document.querySelector(`.ch-pane[data-channel="${id}"]`)?.clientWidth ?? 0) >= 560, vz)
    const wide = (await view(vz))!
    assert.deepEqual(wide.column, { shown: false, button: false })
    assert.equal(wide.actions.labeled, false, 'the words live in the body once')
    await pane(vz).screenshot({ path: join(SHOTS, 'g2-vazio-larga.png') })
    await resize(1650, 760)
    await page.waitForFunction(id => document.querySelector(`.ch-pane[data-channel="${id}"]`)?.classList.contains('narrow') === true, vz)
    assert.deepEqual((await view(vz))!.column, { shown: false, button: false })
    await pane(vz).screenshot({ path: join(SHOTS, 'g2-vazio-estreita.png') })

    // ---- 8. the owner's row has only the "⋯"; a member that does not hear now is marked (G3) ----
    console.log('step 8')
    const s = await running('surdo')
    const mesa2 = await ch.desk.open('desk-2', { name: 'oficina', title: 'oficina', owner: a, panes: [a, s] })
    assert.ok(mesa2.ok)
    const of = mesa2.channel.id
    await run('channels.open', { channel: of })
    await pane(of).locator(`.ch-mrow[data-member="${s}"]`).waitFor({ state: 'attached' })
    await resize(1900, 760)
    await page.waitForFunction(id => (document.querySelector(`.ch-pane[data-channel="${id}"]`)?.clientWidth ?? 0) >= 560, of)
    await pane(of).locator(`.ch-mrow[data-member="${s}"]`).waitFor()
    const v8 = (await view(of))!
    const owner = v8.members.find(m => m.role === 'dono')!
    assert.deepEqual(owner.acts, ['more'], 'the owner has only the "⋯"')
    const deaf = v8.members.find(m => m.name.endsWith('surdo'))!
    assert.equal(deaf.state, 'não ouve agora · falas em espera')
    assert.equal(deaf.tone, 'wait')
    assert.equal(deaf.hint, 'A guia deste agente está com você e ele não recebe falas por dentro. As falas ficam na fila até a guia ser dada a um agente.')
    assert.equal(await pane(of).locator(`.ch-mrow[data-member="${s}"] .ch-state`).getAttribute('title'), deaf.hint)
    // The owner's menu: the dialog of taking him out tells that he gives up the desk's channel.
    await pane(of).locator(`.ch-mrow[data-member="${a}"] .ch-mmore`).click()
    await page.locator('#ctx-menu li', { hasText: 'Tirar do canal' }).click()
    await ask('channels.remove').waitFor()
    assert.match(await ask('channels.remove').innerText(), /Ele é o dono da mesa\. O canal segue com você até a mesa trocar de dono\./)
    await page.keyboard.press('Escape')
    await ask('channels.remove').waitFor({ state: 'detached' })
    await pane(of).screenshot({ path: join(SHOTS, 'g3-nao-ouve.png') })
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
