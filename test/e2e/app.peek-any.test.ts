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
// Run alone: node --test --test-force-exit --test-concurrency=1 test/e2e/app.peek-any.test.ts   (the build is remade)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
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
  lendPane(id: string): string
  giveBackPane(id: string): boolean
  paneLoan(id: string): Loan
  hibernateDesk(id: string): Promise<void>
  wakeDesk(id: string): string[]
  desks(): { id: string; asleep?: boolean }[]
  openNote(path: string): Promise<void>
  notes(): { id: string; path: string; text: string; dirty: boolean; viewport: { width: number; height: number } }[]
  note(id: string): { text: string; dirty: boolean; viewport: { width: number; height: number } } | undefined
  ext: { channels: { run(id: string, arg?: unknown): void; view(id: string): { loaded: boolean; rows: { text: string }[]; composer?: { text: string; enabled: boolean } } | undefined } }
}
type Box = { width: number; height: number }
declare const window: { __tether: Hooks }
declare const document: {
  querySelector(s: string): { getBoundingClientRect(): Box; textContent: string | null } | null
  querySelectorAll(s: string): { length: number }
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
