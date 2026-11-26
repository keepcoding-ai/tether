// E2E of lending ANY live pane out of its tab (quick view V1: app/renderer/pane-shell.ts, main.ts lendPane), through the
// test hook that lends into a host fixed over the window (no card yet). A tetherd in this process on a private home and
// pipe, one fake `claude` agent (test/fixtures/channels/agent.cjs, no LLM, member of a channel so the composer is on), the
// real app on the same pipe, hidden window. Nothing touches the person's tether.
//   1. a NOTE on another desk is lent: its editor sits in the host and the tab shows "sendo espiada"; lending it twice is
//      refused; what is typed in the host is in the note; activating the lent tab through dockview does not take it back;
//   2. given back, the tab holds the editor again, at the size it had, with the text, and takes typing;
//   3. the note's tab closed while lent: the borrower hears it, nothing is left (host, notice, editor);
//   4. a CHANNEL pane on another desk, lent: a line said meanwhile shows in the host, a speech typed there is sent, the desk
//      hibernating keeps the loan; given back with the draft and at its size; closed while lent leaves nothing;
//   5. a TERMINAL (the type's own hooks: only its body moves, the status bar stays in the tab), lent and given back at the
//      size it had; the peek card is never involved.
// The quick view's card (V2, peekPane), modal outside the Regency:
//   6. a NOTE in the card: the window behind inert, the tab with the notice and the eye; the header (title, "nota", "em
//      <mesa>") and the foot (the tab's menu, "Ir até a guia"); typed in the card; Esc in the editor stays the editor's; the
//      menu at the foot is the manager's ("Ir até a guia" last); Esc on the foot closes, the note back whole;
//   7. a CHANNEL and a MARKDOWN PREVIEW: the same header and foot; a line shows alive; another pane takes the card's place
//      and the first goes back to its tab (screenshot r3-cartao-modal-canal);
//   8. a pane of a SLEEPING desk: "hibernando" and "Despertar", the desk not woken by the peek; "Despertar" wakes it (r3-cartao-dormindo);
//   9. the pane CLOSED while in the card: the card closes, nothing left;
//  10. a tab IN VIEW only gets the keyboard (no card).
// The keyboard in the card (V3): the card's tab is the target of its commands and chords:
//   6b. modal, a note in the card and another note active on the desk below: the command target is the card's note; Ctrl+S
//       writes the card's note to disk (typing on holds the autosave off, so the write is the chord's) and leaves the other
//       alone; Ctrl+N (new tab), Ctrl+W and Ctrl+F4 (close the panel) are quiet; Ctrl+F opens the editor's find in the card;
//  6c. docked over a pane: the keyboard in the card aims at the card's note, out of it (on the pane below) back at the desk.
// Run alone: node --test --test-force-exit --test-concurrency=1 test/e2e/app.peek-any.test.ts   (the build is remade)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
import { channelPaneId } from '../../extensions/channels/manifest.ts'
import { USER } from '../../extensions/channels/rules.ts'
import { removeHome, tempHome, uniquePipe, waitUntil } from '../unit/daemon.helpers.ts'
import { killElectron } from './electron.ts'

type Loan = { state?: string; held: boolean; lost: number }
type Hooks = {
  panelIds(): string[]
  activeDesk(): string
  createDesk(side: 'before' | 'after', relativeTo?: string): string
  switchDesk(id: string): void
  activatePanel(id: string): void
  closePanel(id: string): void
  termSize(slotId: string): { cols: number; rows: number } | undefined
  peekState(): { open: boolean; lent: boolean }
  currentPane(): string | undefined
  commandPane(): string | undefined
  peekPane(id: string, over?: string): void
  lendPane(id: string): string
  giveBackPane(id: string): boolean
  paneLoan(id: string): Loan
  hibernateDesk(id: string): Promise<void>
  wakeDesk(id: string): string[]
  desks(): { id: string; name: string; asleep?: boolean }[]
  openNote(path: string): Promise<void>
  notes(): { id: string; path: string; text: string; dirty: boolean; viewport: { width: number; height: number } }[]
  note(id: string): { text: string; dirty: boolean; viewport: { width: number; height: number } } | undefined
  ext: {
    channels: { run(id: string, arg?: unknown): void; view(id: string): { loaded: boolean; rows: { text: string }[]; composer?: { text: string; enabled: boolean } } | undefined }
    note: { openPreview(side: boolean): string | undefined }
  }
}
type PeekState = { open: boolean; routed?: boolean; lent?: boolean; pane?: string; paneLent?: boolean; refusal?: string; mode?: string }
type Box = { width: number; height: number }
declare const window: { __tether: Hooks }
declare const document: {
  querySelector(s: string): { getBoundingClientRect(): Box; textContent: string | null } | null
  querySelectorAll(s: string): ArrayLike<{ className: string }>
  activeElement: unknown
}

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const AGENT = fileURLToPath(new URL('../fixtures/channels/agent.cjs', import.meta.url))
const SHOTS = 'C:/atrium/.tmp/tether-agents/onda-3/mesa-regencia/capturas/v1'

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

test('quick view V1: any live pane is lent out of its tab and given back whole', { timeout: 420_000 }, async () => {
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
    const a = (await doorApi.slots.create({ kind: 'claude', cwd: home, name: 'conferente', desk: 'desk-1' })).slotId
    await waitUntil(() => doorApi.slots.get(a)?.status === 'running' && doorApi.slots.readScreen(a).data.includes('READY'), 30_000, 'agent running')
    await waitUntil(() => doorApi.delivery.pathOf(a) === 'inside', 30_000, 'agent opened its stream')
    const made = await ch.create(USER, { name: 'vitrine' })
    assert.ok(made.ok)
    const vit = made.channel.id
    assert.ok((await ch.join(USER, vit, a)).ok)
    assert.ok((await ch.say(a, vit, { body: 'primeira fala' })).ok)
    const notePath = join(home, 'espiar.md')
    writeFileSync(notePath, '# Espiar\n\nlinha de antes\n')

    let page: Page
    ;({ app, page } = await launch(home, pipe))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1600, 900))
    await page.waitForFunction(() => typeof window.__tether.ext?.channels?.run === 'function' && typeof window.__tether.openNote === 'function')
    await page.waitForFunction(p => window.__tether.panelIds().includes(p), a)

    const homeDesk = await page.evaluate(() => window.__tether.activeDesk())
    const otherDesk = await page.evaluate(() => window.__tether.createDesk('after'))
    const shellOf = (id: string): string => `.pane-shell[data-pane="${id}"]`
    const HOST = '.pane-loan-test-host'
    const frames = (): Promise<void> => page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
    const box = (sel: string): Promise<Box | undefined> => page.evaluate(s => { const r = document.querySelector(s)?.getBoundingClientRect(); return r ? { width: r.width, height: r.height } : undefined }, sel)
    const count = (sel: string): Promise<number> => page.evaluate(s => document.querySelectorAll(s).length, sel)
    const loan = (id: string): Promise<Loan> => page.evaluate(id => window.__tether.paneLoan(id), id)
    const lend = (id: string): Promise<string> => page.evaluate(id => window.__tether.lendPane(id), id)
    const giveBack = (id: string): Promise<boolean> => page.evaluate(id => window.__tether.giveBackPane(id), id)
    const switchTo = async (desk: string): Promise<void> => { await page.evaluate(d => window.__tether.switchDesk(d), desk); await frames() }
    const sameBox = (got: Box | undefined, want: Box | undefined, what: string): void => {
      assert.ok(got && want, `${what}: measured`)
      assert.ok(Math.abs(got.width - want.width) <= 1 && Math.abs(got.height - want.height) <= 1, `${what}: ${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`)
    }

    // ---- 1. a note on another desk, lent ----
    console.log('step 1')
    await switchTo(otherDesk)
    await page.evaluate(p => window.__tether.openNote(p), notePath)
    await page.waitForFunction(() => window.__tether.notes().length === 1)
    const noteId = await page.evaluate(() => window.__tether.notes()[0]!.id)
    await page.waitForSelector(`${shellOf(noteId)} > .note-panel .monaco-editor`)
    await frames()
    const noteBox = await box(`${shellOf(noteId)} > .note-panel`)
    const noteView = (await page.evaluate(id => window.__tether.note(id), noteId))!.viewport
    await switchTo(homeDesk)

    assert.equal(await lend(noteId), 'ok')
    await page.waitForSelector(`${HOST} > .note-panel .monaco-editor`)
    assert.equal(await count(`${shellOf(noteId)} > .note-panel`), 0, 'the editor left the tab')
    assert.equal(await count(`${shellOf(noteId)} > .peek-lent`), 1, 'the tab shows the notice')
    assert.equal(await page.evaluate(s => document.querySelector(s)?.textContent ?? '', `${shellOf(noteId)} > .peek-lent .t`), 'Esta guia está sendo espiada')
    assert.deepEqual(await loan(noteId), { state: 'lent', held: true, lost: 0 })
    assert.equal(await lend(noteId), 'lent', 'lending twice is refused')
    assert.equal(await count(HOST), 1, 'the refused lend leaves no second host')
    // Monaco follows the host's size (automaticLayout).
    await page.waitForFunction(id => (window.__tether.note(id)?.viewport.width ?? 9999) <= 640, noteId)

    await page.locator(`${HOST} .monaco-editor .view-lines`).click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type('\nescrito no cartão')
    await page.waitForFunction(id => window.__tether.note(id)?.text.includes('escrito no cartão') === true, noteId)
    await page.screenshot({ path: join(SHOTS, 'v1-nota-emprestada.png') })

    // dockview activating the lent tab re-appends only the shell: the editor stays in the host.
    await switchTo(otherDesk)
    await page.evaluate(id => window.__tether.activatePanel(id), noteId)
    await frames()
    assert.equal(await count(`${HOST} > .note-panel`), 1, 'activating the tab does not take the editor back')
    assert.equal(await count(`${shellOf(noteId)} > .peek-lent`), 1)
    await switchTo(homeDesk)

    // ---- 2. given back: whole, at its size, with the text, and it takes typing ----
    console.log('step 2')
    assert.equal(await giveBack(noteId), true)
    assert.equal(await count(HOST), 0, 'the host is gone')
    assert.equal(await count(`${shellOf(noteId)} > .note-panel`), 1, 'the editor is back in its tab')
    assert.equal(await count(`${shellOf(noteId)} > .peek-lent`), 0, 'the notice is gone')
    assert.deepEqual(await loan(noteId), { state: 'home', held: false, lost: 0 })
    await switchTo(otherDesk)
    await page.waitForFunction(([id, w]) => window.__tether.note(id)?.viewport.width === w, [noteId, noteView.width] as const)
    sameBox(await box(`${shellOf(noteId)} > .note-panel`), noteBox, 'the note at its size')
    assert.deepEqual((await page.evaluate(id => window.__tether.note(id), noteId))!.viewport, noteView, 'the editor at its size')
    await page.locator(`${shellOf(noteId)} .monaco-editor .view-lines`).click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type(' e na guia')
    await page.waitForFunction(id => window.__tether.note(id)?.text.includes('escrito no cartão e na guia') === true, noteId)
    await page.waitForFunction(id => window.__tether.note(id)?.dirty === false, noteId, { timeout: 10_000 })

    // ---- 3. the note's tab closed while lent: nothing left ----
    console.log('step 3')
    await switchTo(homeDesk)
    assert.equal(await lend(noteId), 'ok')
    await page.waitForSelector(`${HOST} > .note-panel`)
    await page.evaluate(id => window.__tether.closePanel(id), noteId)
    await page.waitForFunction(id => !window.__tether.panelIds().includes(id), noteId)
    assert.deepEqual(await loan(noteId), { held: false, lost: 1 }, 'the borrower heard it once; the shell is gone')
    assert.equal(await count(HOST), 0, 'no host left')
    assert.equal(await count('.peek-lent'), 0, 'no notice left')
    assert.equal(await count('.note-panel'), 0, 'no editor left')
    assert.equal(await page.evaluate(() => window.__tether.notes().length), 0)

    // ---- 4. a channel pane on another desk ----
    console.log('step 4')
    const chPane = channelPaneId(vit)
    const CH = (scope: string): string => `${scope} > .ch-pane[data-channel="${vit}"]`
    await switchTo(otherDesk)
    await page.evaluate(id => window.__tether.ext.channels.run('channels.open', { channel: id }), vit)
    await page.waitForSelector(CH(shellOf(chPane)))
    await page.waitForFunction(id => window.__tether.ext.channels.view(id)?.loaded === true && window.__tether.ext.channels.view(id)?.composer?.enabled === true, vit)
    await frames()
    const chBox = await box(CH(shellOf(chPane)))
    await switchTo(homeDesk)

    assert.equal(await lend(chPane), 'ok')
    await page.waitForSelector(CH(HOST))
    assert.equal(await count(`${shellOf(chPane)} > .peek-lent`), 1)
    // Alive: a line said meanwhile shows in the host.
    assert.ok((await ch.say(a, vit, { body: 'fala durante a espiada' })).ok)
    await page.locator(`${HOST} .ch-msg`, { hasText: 'fala durante a espiada' }).waitFor()
    // Editable: a speech typed in the host is sent.
    await page.locator(`${HOST} .ch-field`).click()
    await page.keyboard.type('da pessoa no cartão')
    await page.keyboard.press('Enter')
    for (let t = Date.now(); !(await ch.store.history(vit, undefined, 50)).some(l => l.body === 'da pessoa no cartão'); await frames()) {
      assert.ok(Date.now() - t < 10_000, 'the speech reached the channel')
    }
    await page.locator(`${HOST} .ch-msg`, { hasText: 'da pessoa no cartão' }).waitFor()
    await page.keyboard.type('rascunho guardado')
    await page.screenshot({ path: join(SHOTS, 'v1-canal-emprestado.png') })

    // The desk hibernates with its pane lent: its panes stay mounted, the loan goes on and stays alive.
    await page.evaluate(d => window.__tether.hibernateDesk(d), otherDesk)
    await page.waitForFunction(d => window.__tether.desks().find(x => x.id === d)?.asleep === true, otherDesk)
    assert.equal((await loan(chPane)).state, 'lent', 'the loan goes on while the desk sleeps')
    assert.ok((await ch.say(a, vit, { body: 'fala com a mesa dormindo' })).ok)
    await page.locator(`${HOST} .ch-msg`, { hasText: 'fala com a mesa dormindo' }).waitFor()
    await page.evaluate(d => window.__tether.wakeDesk(d), otherDesk)
    await page.waitForFunction(d => window.__tether.desks().find(x => x.id === d)?.asleep !== true, otherDesk)

    assert.equal(await giveBack(chPane), true)
    assert.equal(await count(HOST), 0)
    assert.equal(await count(CH(shellOf(chPane))), 1, 'the channel is back in its tab')
    assert.equal(await count(`${shellOf(chPane)} > .peek-lent`), 0)
    assert.equal((await page.evaluate(id => window.__tether.ext.channels.view(id), vit))?.composer?.text, 'rascunho guardado', 'the draft came back with it')
    await switchTo(otherDesk)
    await frames()
    sameBox(await box(CH(shellOf(chPane))), chBox, 'the channel at its size')
    await switchTo(homeDesk)

    // Closed while lent: nothing left.
    assert.equal(await lend(chPane), 'ok')
    await page.waitForSelector(CH(HOST))
    await page.evaluate(id => window.__tether.closePanel(id), chPane)
    await page.waitForFunction(id => !window.__tether.panelIds().includes(id), chPane)
    assert.deepEqual(await loan(chPane), { held: false, lost: 1 })
    assert.equal(await count(HOST), 0)
    assert.equal(await count('.peek-lent'), 0)
    assert.equal(await count(`.ch-pane[data-channel="${vit}"]`), 0)

    // ---- 5. a terminal: its own hooks, only the body moves ----
    console.log('step 5')
    await frames()
    const before = await page.evaluate(id => window.__tether.termSize(id), a)
    assert.ok(before)
    assert.equal(await lend(a), 'ok')
    await page.waitForSelector(`${HOST} > .panel-body .xterm`)
    assert.equal(await count(`${shellOf(a)} > .panel > .panel-details .status-bar`), 1, 'the status bar stays in the tab')
    assert.equal(await count(`${shellOf(a)} > .panel > .peek-lent`), 1, 'the notice stands where the body was')
    assert.equal((await page.evaluate(() => window.__tether.peekState())).lent, false, 'the peek card is not involved')
    assert.equal(await giveBack(a), true)
    assert.equal(await count(`${shellOf(a)} > .panel > .panel-body .xterm`), 1)
    assert.equal(await count('.peek-lent'), 0)
    await page.waitForFunction(([id, s]) => { const t = window.__tether.termSize(id); return t?.cols === s.cols && t.rows === s.rows }, [a, before] as const)

    // ---- 6. the quick view's card (V2), modal outside the Regency: a note ----
    console.log('step 6')
    const CARD = '#peek[data-open="true"]'
    const PANE = '#peek .peek-pane'
    const peekPane = (id: string): Promise<void> => page.evaluate(id => window.__tether.peekPane(id), id)
    const peekState = (): Promise<PeekState> => page.evaluate(() => window.__tether.peekState() as PeekState)
    const text = (sel: string): Promise<string> => page.evaluate(s => document.querySelector(s)?.textContent ?? '', sel)
    // The chrome of the card as a list of its parts: the same for every type.
    const chrome = (): Promise<string[]> => page.evaluate(() => Array.from(document.querySelectorAll('#peek .qv-head > *, #peek .qv-head .peek-id > *, #peek .qv-foot > *')).map(e => e.className))
    const closeCard = async (): Promise<void> => { await page.click('#peek .peek-close'); await page.waitForSelector('#peek', { state: 'hidden' }) }
    const otherName = (await page.evaluate(d => window.__tether.desks().find(x => x.id === d)?.name, otherDesk))!
    await switchTo(otherDesk)
    await page.evaluate(p => window.__tether.openNote(p), notePath)
    await page.waitForFunction(() => window.__tether.notes().length === 1)
    const note2 = await page.evaluate(() => window.__tether.notes()[0]!.id)
    await page.waitForSelector(`${shellOf(note2)} > .note-panel .monaco-editor`)
    const preview = (await page.evaluate(() => window.__tether.ext.note.openPreview(true)))!
    assert.ok(preview, 'the markdown preview opened beside the note')
    await page.waitForSelector(`${shellOf(preview)} > .preview-panel`)
    await page.evaluate(id => window.__tether.ext.channels.run('channels.open', { channel: id }), vit)
    await page.waitForSelector(CH(shellOf(chPane)))
    await page.waitForFunction(id => window.__tether.ext.channels.view(id)?.loaded === true, vit)
    await switchTo(homeDesk)
    // Another note, the home desk's active tab under the card (6b: Ctrl+S must not aim at it).
    const belowPath = join(home, 'de-baixo.md')
    writeFileSync(belowPath, '# De baixo\n')
    await page.evaluate(p => window.__tether.openNote(p), belowPath)
    await page.waitForFunction(() => window.__tether.notes().length === 2)
    const below = await page.evaluate(p => window.__tether.notes().find(n => n.path.endsWith(p))!.id, 'de-baixo.md')
    await page.waitForSelector(`${shellOf(below)} > .note-panel .monaco-editor`)
    assert.equal(await page.evaluate(() => window.__tether.currentPane()), below)
    assert.equal(await page.evaluate(() => window.__tether.commandPane()), below, 'no card: the target is the desk\'s active tab')

    await peekPane(note2)
    await page.waitForSelector(`${CARD}[data-mode="modal"] .peek-card[data-content="pane"]`)
    await page.waitForSelector(`${PANE} > .note-panel .monaco-editor`)
    assert.deepEqual(await peekState(), { open: true, routed: false, lent: false, pane: note2, paneLent: true, mode: 'modal' })
    // (The note is a background tab of its frame now, the channel opened over it: dockview keeps its shell out of the DOM.)
    assert.equal((await loan(note2)).state, 'lent', 'the tab holds "sendo espiada" in its place')
    assert.equal(await count(`.peek-tab-eye`), 1, 'the tab shows the eye')
    assert.ok((await count('[data-inert-onscreen]')) > 0, 'modal: the window behind is inert')
    assert.match(await text('#peek .qv-head .peek-title'), /espiar/)
    assert.equal(await text('#peek .qv-head .qv-type'), 'nota')
    assert.equal(await text('#peek .qv-head .qv-where-t'), `em ${otherName}`)
    assert.equal(await text('#peek .qv-foot .qv-go'), 'Ir até a guia')
    assert.equal(await page.locator('#peek .qv-wake').isVisible(), false, 'awake: no "Despertar"')
    assert.equal(await page.locator('#peek .qv-band').isVisible(), false, 'awake: no strip')
    assert.equal(await page.locator('#peek .qv-foot .qv-menu').isVisible(), true, 'the tab\'s menu at the foot')
    assert.equal(await count('#peek .peek-head:not(.qv-head)'), 0, 'the slot\'s header is not in the card')
    const noteChrome = await chrome()
    // Alive and editable; Esc in the editor is the editor's.
    await page.locator(`${PANE} .monaco-editor .view-lines`).click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type('\nescrito na visão rápida')
    await page.waitForFunction(id => window.__tether.note(id)?.text.includes('escrito na visão rápida') === true, note2)
    await page.keyboard.press('Escape')
    await frames()
    assert.equal((await peekState()).open, true, 'Esc in the content does not close')

    // ---- 6b (V3). the keys aim at the note in the card, never at the desk's tab below ----
    console.log('step 6b')
    assert.equal(await page.evaluate(() => window.__tether.commandPane()), note2, 'the keyboard in the card: the card\'s note is the target')
    assert.equal(await page.evaluate(() => window.__tether.currentPane()), below, 'the desk\'s active tab is still the other note')
    // Ctrl+S writes at once. Typing on every 60 ms keeps the 300 ms autosave from firing (NOTE_SAVE_DEBOUNCE_MS), so the
    // file holding the text of the instant of the chord is the chord's doing.
    await page.waitForFunction(id => window.__tether.note(id)?.dirty === false, note2, { timeout: 10_000 })
    await page.keyboard.type(' salvo-pelo-ctrl-s')
    const atSave = (await page.evaluate(id => window.__tether.note(id)!.text, note2))
    assert.notEqual(readFileSync(notePath, 'utf8'), atSave, 'not on disk yet')
    await page.keyboard.press('Control+s')
    let saved = false
    for (let i = 0; i < 30 && !saved; i++) {
      saved = readFileSync(notePath, 'utf8') === atSave
      if (!saved) { await page.keyboard.type('.'); await page.waitForTimeout(60) }
    }
    assert.ok(saved, 'Ctrl+S in the card wrote the card\'s note to disk')
    assert.equal(readFileSync(belowPath, 'utf8'), '# De baixo\n', 'the note below untouched')
    assert.equal((await page.evaluate(id => window.__tether.note(id), below))?.dirty, false)
    // The structure is quiet with the keyboard in the modal card: no new tab, no panel closed.
    const panes = (await page.evaluate(() => window.__tether.panelIds())).sort()
    for (const k of ['Control+n', 'Control+w', 'Control+F4']) {
      await page.keyboard.press(k)
      await frames()
      await page.waitForTimeout(200)
      assert.deepEqual((await page.evaluate(() => window.__tether.panelIds())).sort(), panes, `${k}: the panes as they were`)
      assert.equal((await peekState()).pane, note2, `${k}: the card still shows the note`)
      assert.equal(await count('dialog[open]'), 0, `${k}: no dialog`)
    }
    // Find in the tab: the editor's own find opens inside the card.
    await page.keyboard.press('Control+f')
    await page.waitForSelector(`${PANE} .monaco-editor .find-widget.visible`)
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('#peek .peek-pane .monaco-editor .find-widget.visible'))
    assert.equal((await peekState()).open, true, 'Esc closed the find only')
    await page.locator(`${PANE} .monaco-editor .view-lines`).click()

    // The tab's menu at the foot: the manager's menu aimed at the pane, "Ir até a guia" last; Esc closes the menu, then (on the foot) the card.
    await page.click('#peek .qv-menu')
    await page.locator('#ctx-menu').waitFor()
    const rows = await page.locator('#ctx-menu [role="menuitem"]').allTextContents()
    console.log(`card menu: ${JSON.stringify(rows)}`)
    assert.match(rows.at(-1) ?? '', /Ir até a guia/)
    await page.keyboard.press('Escape')
    await page.locator('#ctx-menu').waitFor({ state: 'detached' })
    assert.equal((await peekState()).open, true, 'Esc closed the menu only')
    await page.locator('#peek .qv-menu').focus()
    await page.keyboard.press('Escape')
    await page.waitForSelector('#peek', { state: 'hidden' })
    assert.equal((await loan(note2)).state, 'home', 'the note is back in its tab')
    assert.equal(await count('.peek-lent'), 0)
    assert.equal(await count('.peek-tab-eye'), 0, 'the eye went')
    assert.equal(await count('[data-inert-onscreen]'), 0, 'the window is back')

    // ---- 6c (V3). docked: the target follows the keyboard in and out of the card ----
    console.log('step 6c')
    await page.evaluate(([id, over]) => window.__tether.peekPane(id, over), [note2, shellOf(below)] as const)
    await page.waitForSelector(`${CARD}[data-mode="docked"] .peek-pane > .note-panel .monaco-editor`)
    await page.locator(`${PANE} .monaco-editor .view-lines`).click()
    assert.equal(await page.evaluate(() => window.__tether.commandPane()), note2, 'docked, the keyboard in the card: the card\'s note')
    // Out of the card, on the note below (the part the card leaves uncovered): the desk's tab again.
    const belowBox = (await page.evaluate(s => { const r = document.querySelector(s)!.getBoundingClientRect() as unknown as { left: number; top: number; height: number }; return { left: r.left, top: r.top, height: r.height } }, shellOf(below)))
    await page.mouse.click(belowBox.left + 40, belowBox.top + belowBox.height - 30)
    await page.waitForFunction(b => window.__tether.commandPane() === b, below)
    assert.equal((await peekState()).open, true, 'the docked card stays')
    await page.locator(`${PANE} .monaco-editor .view-lines`).click()
    await page.waitForFunction(n => window.__tether.commandPane() === n, note2)
    await closeCard()
    assert.equal((await loan(note2)).state, 'home')
    assert.equal(await page.evaluate(() => window.__tether.commandPane()), below, 'card closed: the desk\'s tab')
    await page.evaluate(id => window.__tether.closePanel(id), below)
    await page.waitForFunction(id => !window.__tether.panelIds().includes(id), below)

    // ---- 7. a channel in the same card: same header and foot ----
    console.log('step 7')
    await peekPane(chPane)
    await page.waitForSelector(`${PANE} > .ch-pane[data-channel="${vit}"]`)
    assert.equal(await text('#peek .qv-head .qv-type'), 'canal')
    assert.deepEqual(await chrome(), noteChrome, 'the same chrome for a channel')
    assert.ok((await ch.say(a, vit, { body: 'fala vista no cartão' })).ok)
    await page.locator(`${PANE} .ch-msg`, { hasText: 'fala vista no cartão' }).waitFor()
    assert.equal(await page.locator(`${PANE} .ch-head`).isVisible(), false, 'only the body: the channel\'s own bar is the card header\'s job')
    assert.ok(await page.evaluate(() => !!(document.activeElement as unknown as { closest(s: string): unknown } | null)?.closest('#peek .peek-card')), 'modal: the keyboard is in the card')
    // (The pointer off the buttons it last pressed: the capture shows no hover.)
    await page.mouse.move(700, 420)
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(SHOTS, '..', 'r3-cartao-modal-canal.png') })
    // Another pane takes the card's place: the channel goes back to its tab whole.
    await peekPane(preview)
    await page.waitForSelector(`${PANE} > .preview-panel`)
    assert.equal(await count(CH(shellOf(chPane))), 1, 'the channel is back in its tab')
    assert.equal(await count(`${shellOf(chPane)} > .peek-lent`), 0)
    assert.equal(await text('#peek .qv-head .qv-type'), 'prévia')
    assert.deepEqual(await chrome(), noteChrome, 'the same chrome for a markdown preview')
    assert.equal(await count('.peek-lent'), 1, 'one card, one pane lent')
    await closeCard()
    assert.equal(await count(`${shellOf(preview)} > .preview-panel`), 1, 'the preview is back in its tab')

    // ---- 8. a pane of a sleeping desk: "hibernando" and "Despertar", never woken by the peek ----
    console.log('step 8')
    await page.evaluate(d => window.__tether.hibernateDesk(d), otherDesk)
    await page.waitForFunction(d => window.__tether.desks().find(x => x.id === d)?.asleep === true, otherDesk)
    await peekPane(note2)
    await page.waitForSelector(`${PANE} > .note-panel`)
    assert.equal(await text('#peek .qv-head .peek-state'), 'hibernando')
    // The strip under the header: what is shown is not running, and "Despertar" beside the sentence.
    await page.locator('#peek .qv-band .qv-wake').waitFor()
    assert.equal(await text('#peek .qv-band .qv-band-t'), 'Mesa hibernando: o que você vê não está rodando')
    assert.equal(await text('#peek .qv-band .qv-wake'), 'Despertar')
    await page.waitForTimeout(400)
    assert.equal(await page.evaluate(d => window.__tether.desks().find(x => x.id === d)?.asleep, otherDesk), true, 'the peek did not wake the desk')
    await page.mouse.move(700, 420)
    await page.screenshot({ path: join(SHOTS, '..', 'r6', 'cartao-dormindo.png') })
    await page.click('#peek .qv-band .qv-wake')
    await page.waitForFunction(d => window.__tether.desks().find(x => x.id === d)?.asleep !== true, otherDesk)
    await page.locator('#peek .qv-band').waitFor({ state: 'hidden' })
    assert.equal(await page.locator('#peek .qv-head .peek-state').isVisible(), false, 'awake, a note has no state')

    // ---- 9. the pane closed while in the card: the card closes clean ----
    console.log('step 9')
    await page.evaluate(id => window.__tether.closePanel(id), note2)
    await page.waitForSelector('#peek', { state: 'hidden' })
    await page.waitForFunction(id => !window.__tether.panelIds().includes(id), note2)
    assert.equal(await count('.peek-lent'), 0)
    assert.equal(await count('.peek-tab-eye'), 0)
    assert.equal(await count('#peek .peek-pane'), 0, 'nothing left in the card')
    assert.equal(await count('[data-inert-onscreen]'), 0)

    // ---- 10. a tab in view only gets the keyboard ----
    console.log('step 10')
    await page.evaluate(id => window.__tether.activatePanel(id), a)
    await frames()
    await peekPane(a)
    await frames()
    assert.equal((await peekState()).open, false, 'in view: no card')
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
