// E2E of the Regency's tablet and TV designs (slice R6e): a tetherd in this process on a private home and pipe (two fake
// `claude` agents, test/fixtures/channels/agent.cjs, no LLM), the channels' record and requests on its door, a REAL
// tether-procd with two harmless processes (for the TV's rail of "Sistema"), and the real app on the same pipe, hidden window.
// Nothing touches the person's tether.
//   1. tablet (window ~1024): two columns (one side column + the conversation) and the rail at the right edge; the switch
//      on top of the side column turns it between "Esperam você" and "Tether" (kept in the layout); the other place comes as a
//      panel over the conversation (it does not push it), closed by Esc with the keyboard back on its button; 44 px targets;
//      "Sistema" enters by the side column; the quick view docks over the conversation, and a pick in the panel closes it;
//   2. TV (window 2560+): five columns side by side with no gap (who waits, the conversation at a reading measure, the quick
//      view's column, the tree, the rail of "Sistema"); the rail's summary lists the processes; a heading opens its section
//      below; the quick view's card fills its column;
//   3. back to the desktop: three columns, the TV's columns and the tablet's switch out of the layout.
// Captures go to C:/atrium/.tmp/tether-agents/onda-3/mesa-regencia/capturas/r6/{tablet,tv}-*.png.
// Run alone: npm run app:build && node --test --test-force-exit --test-concurrency=1 test/e2e/app.regency-tiers.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
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
import type { ProcState } from '../../src/daemon/procs.ts'
import { startDaemon } from '../../src/daemon/server.ts'
import { createChannels, type Channels, type ChannelsApi } from '../../extensions/channels/daemon/fanout.ts'
import { MODERATOR_NAME } from '../../extensions/channels/daemon/notices.ts'
import { registerChannelRequests } from '../../extensions/channels/daemon/requests.ts'
import { openStore } from '../../extensions/channels/daemon/store.ts'
import { USER } from '../../extensions/channels/rules.ts'
import type { RegencyLayout } from '../../extensions/regency/renderer/layout-rules.ts'
import { claim, killOwned, type Owned } from '../kill.ts'
import { removeHome, tempHome, uniquePipe, waitUntil } from '../unit/daemon.helpers.ts'
import { killElectron } from './electron.ts'

type SysSnap = { column: string; section: string; view: { section: string } }
type TierSnap = { tier: string; step?: string; side: 'waiting' | 'tether'; sheet: boolean; quickOpen: boolean }
type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number }
type Hooks = {
  panelIds(): string[]
  activeDesk(): string
  runCommand(id: string): Promise<string>
  peekState(): { open: boolean; pane?: string; mode?: 'modal' | 'docked' }
  ext: {
    regency: {
      layout(): RegencyLayout | undefined
      select(channelId: string): void
      tier(): string | undefined
      tiers(): TierSnap | undefined
      system(): SysSnap | undefined
      openSystem(section?: string | false): void
    }
  }
}
declare const window: { __tether: Hooks }
declare const document: { querySelector(s: string): { getBoundingClientRect(): Rect } | null; activeElement: { dataset?: Record<string, string> } | null }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const AGENT = fileURLToPath(new URL('../fixtures/channels/agent.cjs', import.meta.url))
const CLI = join(root, 'bin', 'tether.mjs')
const SHOTS = 'C:/atrium/.tmp/tether-agents/onda-3/mesa-regencia/capturas/r6'
const DESK = 'regency.main'
const PANE = 'regency:main'

const FIXTURE = `
console.log('pronto ' + process.pid)
let n = 0
setInterval(() => console.log('tick ' + n++), 300)
`

async function launch(home: string, pipe: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_') && !k.toUpperCase().startsWith('CLAUDE')) env[k] = v
  env.TETHER_PIPE = pipe
  env.TETHER_HOME = home
  env.TETHER_E2E_HIDDEN = '1'
  delete env.NODE_TEST_CONTEXT
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  page.on('pageerror', e => console.error(`renderer error: ${e.stack}`))
  page.on('console', m => { if (m.type() === 'error') console.error(`renderer console: ${m.text()}`) })
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(1500, 900) })
  await page.waitForFunction(() => typeof window.__tether.ext?.regency?.tiers === 'function')
  return { app, page }
}

test('regency tiers: the tablet and the TV designs, and back to the desktop', { timeout: 600_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(SHOTS, { recursive: true })
  const home = tempHome()
  const pipe = uniquePipe(home)
  const work = join(home, 'work')
  mkdirSync(work, { recursive: true })
  const fixture = join(work, 'tick.cjs')
  writeFileSync(fixture, FIXTURE)
  const logs: string[] = []
  const door = new DoorHost({ log: m => logs.push(m) })
  const own = new DisposableStore()
  const testContext = process.env.NODE_TEST_CONTEXT
  delete process.env.NODE_TEST_CONTEXT
  const owned: Owned[] = []

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
    home, pipe, memoryIntervalMs: 0, readyFallbackMs: 300, minAgentAgeMs: 0, adapters: { claude: fake }, door,
    channelOf: agent => (agent === 'claude' ? { args: [], inject: p => p } : undefined),
    log: m => logs.push(m),
  })
  const doorApi = door.apiFor('channels', own)
  own.add(doorApi.delivery.enable())
  const api: ChannelsApi = { slots: doorApi.slots, attention: doorApi.attention, delivery: doorApi.delivery, events: doorApi.events, settings: { get: () => undefined }, log: m => logs.push(m) }
  const ch: Channels = createChannels(api, await openStore(fsIo, home))
  for (const d of registerChannelRequests(doorApi, Promise.resolve(ch))) own.add(d)

  const cli = (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
    const env: NodeJS.ProcessEnv = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.toUpperCase().startsWith('CLAUDE')) env[k] = v
    for (const k of ['NODE_TEST_CONTEXT', 'TETHER_SLOT_ID', 'TETHER_PROCD_PIPE', 'TETHER_CLAUDE_ARGS']) delete env[k]
    env.TETHER_HOME = home
    env.TETHER_PIPE = pipe
    return new Promise(res => execFile(process.execPath, [CLI, ...args], { env, cwd: work, windowsHide: true, encoding: 'utf8', timeout: 60_000 },
      (err, stdout, stderr) => res({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr })))
  }
  const ok = async (args: string[]): Promise<string> => { const r = await cli(args); assert.equal(r.code, 0, `${args.join(' ')}: ${r.stderr}${r.stdout}`); return r.stdout }
  const proc = async (name: string): Promise<ProcState | undefined> => (JSON.parse(await ok(['proc', 'ls', '--json'])) as ProcState[]).find(p => p.name === name)
  const track = async (name: string): Promise<void> => {
    const p = (await proc(name))!
    if (p.pid) { const o = await claim(p.pid, { cmdIncludes: fixture, what: `${name} fixture` }).catch(() => undefined); if (o) owned.push(o) }
  }

  let app: ElectronApplication | undefined
  try {
    const running = async (name: string): Promise<string> => {
      const id = (await doorApi.slots.create({ kind: 'claude', cwd: home, name, desk: 'desk-1' })).slotId
      await waitUntil(() => doorApi.slots.get(id)?.status === 'running' && doorApi.slots.readScreen(id).data.includes('READY'), 30_000, `${name} running`)
      return id
    }
    const a = await running('conferente')
    const b = await running('bancada')
    await ok(['proc', 'start', 'web', '--', 'node', fixture])
    await ok(['proc', 'start', 'worker', '--', 'node', fixture])
    for (let i = 0; i < 100; i++) {
      if ((await proc('web'))?.status === 'running' && (await proc('worker'))?.status === 'running') break
      await new Promise(r => setTimeout(r, 300))
    }
    await track('web')
    await track('worker')

    let page: Page
    ;({ app, page } = await launch(home, pipe))
    for (const id of [a, b]) await page.waitForFunction(p => window.__tether.panelIds().includes(p), id)
    const until = async (what: string, fn: () => Promise<unknown>, ms = 15_000): Promise<void> => {
      const end = Date.now() + ms
      let last: unknown
      while (Date.now() < end) { try { if (await fn()) return } catch (e) { last = e } await page.waitForTimeout(120) }
      throw new Error(`timeout: ${what}${last ? ` (${(last as Error).message})` : ''}`)
    }
    const tiers = async (): Promise<TierSnap> => (await page.evaluate(() => window.__tether.ext.regency.tiers()))!
    const sys = async (): Promise<SysSnap> => (await page.evaluate(() => window.__tether.ext.regency.system()))!
    const layout = (): Promise<RegencyLayout | undefined> => page.evaluate(() => window.__tether.ext.regency.layout())
    const desk = (): Promise<string> => page.evaluate(() => window.__tether.activeDesk())
    const peek = (): Promise<{ open: boolean; pane?: string; mode?: string }> => page.evaluate(() => window.__tether.peekState())
    const rect = (sel: string): Promise<Rect | undefined> => page.evaluate(s => {
      const r = document.querySelector(s)?.getBoundingClientRect()
      return r ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height } : undefined
    }, sel)
    const shown = (sel: string): Promise<boolean> => page.locator(sel).first().isVisible()
    const frames = (): Promise<void> => page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
    const focusedAction = (): Promise<string | undefined> => page.evaluate(() => document.activeElement?.dataset?.action)
    /**
     * The window's content is `width` CSS px wide. A hidden window may grow past the screen; when the system clamps it, the
     * zoom halves the device pixels per CSS px (the layout is the same; the capture is then at half scale).
     */
    const widen = async (width: number, height = 900): Promise<void> => {
      await app!.evaluate(({ BrowserWindow }, [w, h]) => {
        const win = BrowserWindow.getAllWindows()[0]!
        win.webContents.setZoomFactor(1)
        win.setContentSize(w, h)
      }, [width, height] as const)
      await page.waitForTimeout(200)
      const got = await page.evaluate(() => (globalThis as unknown as { innerWidth: number }).innerWidth)
      if (got >= width - 2) return
      console.log(`the window was clamped to ${got} px: zoom 0.5`)
      await app!.evaluate(({ BrowserWindow }, [w, h]) => {
        const win = BrowserWindow.getAllWindows()[0]!
        win.webContents.setZoomFactor(0.5)
        win.setContentSize(Math.round(w / 2), Math.round(h / 2))
      }, [width, height] as const)
    }
    const closeCard = async (): Promise<void> => {
      await page.click('#peek .qv-close')
      await until('the card closed', async () => !(await peek()).open)
    }

    // Into the Regency, with a conversation in the centre and someone waiting for the person.
    await page.evaluate(d => window.__tether.runCommand(`desk.system.${d}`), DESK)
    await page.waitForFunction(d => window.__tether.activeDesk() === d, DESK)
    await page.waitForFunction(p => window.__tether.panelIds().includes(p), PANE)
    const made = await ch.create(USER, { name: 'obra', title: 'Obra' })
    assert.ok(made.ok)
    const obra = made.channel.id
    for (const who of [a, b]) assert.ok((await ch.join(USER, obra, who)).ok)
    assert.ok((await ch.say(a, obra, { body: 'O índice paginado está pronto.' })).ok)
    await until('the conversation listed', async () => (await page.locator('.rg-conv').count()) === 1)
    await page.evaluate(i => window.__tether.ext.regency.select(i), obra)
    await until('the conversation in the centre', async () => page.locator('.rg-embed:not([hidden])').isVisible())
    // Another channel calls the person (the one in the centre is read as it comes).
    const other = await ch.create(USER, { name: 'migra', title: 'Migração' })
    assert.ok(other.ok)
    assert.ok((await ch.join(USER, other.channel.id, b)).ok)
    assert.ok((await ch.say(b, other.channel.id, { body: 'Posso seguir com a migração?', to: [MODERATOR_NAME] })).ok)

    // ---- 1. the tablet ----
    console.log('step 1: tablet')
    await widen(1024)
    await until('the tablet', async () => (await tiers()).tier === 'tablet')
    await frames()
    const t1 = await tiers()
    assert.ok(t1.step === 'sm' || t1.step === 'lg', `the tablet has a step (${t1.step})`)
    assert.equal(t1.side, 'waiting', 'the side column opens on who waits')
    assert.equal(await shown('.rg > .rg-side-seg'), true, 'the switch on top of the side column')
    assert.equal(await shown('.rg > .rg-trail'), true, 'the rail at the right edge')
    assert.equal(await shown('.rg > .rg-left'), true, '"Esperam você" in the side column')
    assert.equal(await shown('.rg > .rg-right'), false, 'the tree is not a third column')
    assert.equal(await shown('.rg > .rg-qcol'), false)
    assert.equal(await shown('.rg > .rg-srail'), false)
    assert.equal(await shown('.rg > .rg-tabbar'), false, 'no bottom bar')
    const tl = (await rect('.rg > .rg-left'))!
    const tc = (await rect('.rg > .rg-center'))!
    const tr = (await rect('.rg > .rg-trail'))!
    assert.ok(Math.abs(tl.right - tc.left) < 2 && Math.abs(tc.right - tr.left) < 2, `side, conversation, rail side by side: ${JSON.stringify({ tl, tc, tr })}`)
    assert.ok(tc.width > tl.width, 'the conversation is the widest')
    for (const sel of ['.rg-side-b[data-side="waiting"]', '.rg-side-b[data-side="tether"]', '.rg-trail-b']) {
      const box = (await rect(sel))!
      assert.ok(box.height >= 44 && box.width >= 44, `${sel} is a 44 px target (${box.width}x${box.height})`)
    }
    await until('the count of who waits on the switch', async () => page.locator('.rg-side-b[data-side="waiting"] .rg-side-cnt:not([hidden])').isVisible())
    await page.screenshot({ path: join(SHOTS, 'tablet-principal.png') })

    // The other place as a panel over the conversation: the conversation keeps its width; Esc closes, back on the button.
    await page.click('.rg-trail-b')
    await until('the panel up', async () => (await tiers()).sheet)
    await page.waitForTimeout(300) // its slide in (.16 s) ends
    await frames()
    assert.equal(await shown('.rg > .rg-right'), true, 'the tree in the panel')
    const sheet = (await rect('.rg > .rg-right'))!
    const tc2 = (await rect('.rg > .rg-center'))!
    assert.deepEqual([Math.round(tc2.left), Math.round(tc2.width)], [Math.round(tc.left), Math.round(tc.width)], 'the panel does not push the conversation')
    assert.ok(sheet.left > tc.left && sheet.right <= tr.left + 1, `the panel sits over the conversation's right side: ${JSON.stringify({ sheet, tc, tr })}`)
    await page.screenshot({ path: join(SHOTS, 'tablet-painel.png') })
    await page.keyboard.press('Escape')
    await until('the panel closed by Esc', async () => !(await tiers()).sheet)
    assert.equal(await focusedAction(), 'sheet', 'the keyboard is back on the button')

    // A quick view picked in the panel: the panel steps away, the card docks over the conversation.
    await page.click('.rg-trail-b')
    await until('the panel up again', async () => (await tiers()).sheet)
    const aKey = `pane:agent:${a}`
    await page.locator(`.rg-tree [data-key="${aKey}"]`).focus()
    await page.keyboard.press(' ')
    await page.waitForSelector('#peek[data-open="true"][data-mode="docked"]')
    await until('the panel stepped away', async () => !(await tiers()).sheet)
    await frames()
    const card1 = (await rect('#peek .peek-card'))!
    const tc3 = (await rect('.rg > .rg-center'))!
    assert.ok(card1.left >= tc3.left - 0.5 && card1.right <= tc3.right + 0.5, `the card sits over the conversation: ${JSON.stringify({ card1, tc3 })}`)
    await page.screenshot({ path: join(SHOTS, 'tablet-cartao.png') })
    await closeCard()

    // The switch turns the side column to "Tether" (kept in the layout).
    await page.click('.rg-side-b[data-side="tether"]')
    await until('the side shows the tree', async () => (await tiers()).side === 'tether')
    assert.equal((await layout())?.side, 'tether')
    assert.equal(await shown('.rg > .rg-right'), true)
    assert.equal(await shown('.rg > .rg-left'), false)
    assert.equal(await page.locator('.rg-side-b[data-side="tether"]').getAttribute('aria-checked'), 'true')
    assert.equal(await page.locator('.rg-trail-b').getAttribute('data-other'), 'waiting', 'the rail brings who waits now')

    // "Sistema" enters by the side column.
    await page.click('.rg-side-b[data-side="waiting"]')
    await until('back on who waits', async () => (await tiers()).side === 'waiting')
    await page.evaluate(() => window.__tether.ext.regency.openSystem('processes'))
    await until('"Sistema" in the side column', async () => (await sys()).column === 'system' && (await tiers()).side === 'tether')
    await frames()
    assert.equal(await shown('.rg-right .rg-sys'), true)
    const sysBox = (await rect('.rg-right .rg-sys'))!
    assert.ok(sysBox.right <= tc.left + 2, '"Sistema" is the side column, left of the conversation')
    for (const sel of ['.rg-sys-back', '.rg-sys-tab[data-section="ronda"]']) {
      const box = (await rect(sel))!
      assert.ok(box.height >= 44, `${sel} is 44 px (${box.height})`)
    }
    // A process row in the narrow column: the name is whole and the buttons take their own line under it.
    await until('the web row', async () => (await page.locator('.rg-sr[data-key="proc:web"]').count()) === 1)
    const nameFits = await page.locator('.rg-sr[data-key="proc:web"] .rg-sr-n').evaluate(e => { const n = e as unknown as { scrollWidth: number; clientWidth: number }; return n.scrollWidth <= n.clientWidth })
    assert.equal(nameFits, true, 'the process name is not cut')
    const nameBox = (await rect('.rg-sr[data-key="proc:web"] .rg-sr-n'))!
    const actsBox = (await rect('.rg-sr[data-key="proc:web"] .rg-sr-a'))!
    assert.ok(actsBox.top >= nameBox.bottom - 1, `the buttons under the name: ${JSON.stringify({ nameBox, actsBox })}`)
    await page.screenshot({ path: join(SHOTS, 'tablet-sistema.png') })
    await page.evaluate(() => window.__tether.ext.regency.openSystem(false))
    await until('the tree again', async () => (await sys()).column === 'tether')
    assert.equal(await desk(), DESK, 'nothing came forward')

    // ---- 2. the TV ----
    console.log('step 2: tv')
    await widen(2700, 1300)
    await until('the TV', async () => (await tiers()).tier === 'wide', 20_000)
    await frames()
    for (const sel of ['.rg-left', '.rg-center', '.rg-qcol', '.rg-right', '.rg-srail']) assert.equal(await shown(`.rg > ${sel}`), true, `${sel} in view`)
    for (const sel of ['.rg-side-seg', '.rg-trail', '.rg-tabbar']) assert.equal(await shown(`.rg > ${sel}`), false, `${sel} out of the layout`)
    const cols = await Promise.all(['.rg-left', '.rg-center', '.rg-qcol', '.rg-right', '.rg-srail'].map(async s => (await rect(`.rg > ${s}`))!))
    const pane = (await rect('.rg:not(.off)'))!
    for (let i = 1; i < cols.length; i++) assert.ok(Math.abs(cols[i]!.left - cols[i - 1]!.right) < 2, `column ${i} follows column ${i - 1} with no gap: ${JSON.stringify(cols)}`)
    assert.ok(Math.abs(cols[0]!.left - pane.left) < 2 && Math.abs(cols[4]!.right - pane.right) < 2, 'the columns fill the pane')
    assert.ok(cols[1]!.width <= 800, `the conversation at a reading measure (${cols[1]!.width})`)
    assert.equal(await shown('.rg-right .rg-tree'), true, 'the tree keeps its column')
    assert.equal(await shown('.rg-right .rg-reserved'), false, 'the tree\'s foot does not carry "Sistema"')
    assert.equal((await sys()).column, 'rail')
    await until('the rail lists the processes', async () => (await page.locator('.rg-srail .rg-sum-r[data-proc="web"]').count()) === 1 && (await page.locator('.rg-srail .rg-sum-r[data-proc="worker"]').count()) === 1)
    assert.equal(await page.locator('.rg-srail .rg-sum-r[data-proc="web"]').getAttribute('class'), 'rg-sum-r ok', 'running reads ok')
    assert.equal(await shown('.rg-srail .rg-sys'), true, 'the sections under the summary')
    assert.equal(await shown('.rg-srail .rg-sys-back'), false, 'no way back: the rail is always there')
    assert.equal((await tiers()).quickOpen, false)
    assert.equal(await shown('.rg-qcol-empty'), true, 'the quick column says how to fill it')
    await page.screenshot({ path: join(SHOTS, 'tv-principal.png') })

    // A heading of the summary opens its section below it.
    await page.click('.rg-srail .rg-sum-h[data-action="sys:ronda"]')
    await until('ronda in the rail', async () => (await sys()).section === 'ronda' && (await sys()).view.section === 'ronda')
    assert.equal(rightColumnIsTree(await layout()), true, 'the tree keeps its column on the TV')
    await page.screenshot({ path: join(SHOTS, 'tv-sistema.png') })

    // The quick view's card fills its column.
    await page.locator(`.rg-tree [data-key="${aKey}"]`).focus()
    await page.keyboard.press(' ')
    await page.waitForSelector('#peek[data-open="true"][data-mode="docked"]')
    await until('the column open', async () => (await tiers()).quickOpen)
    await frames()
    const qcol = (await rect('.rg > .rg-qcol'))!
    const card2 = (await rect('#peek .peek-card'))!
    assert.ok(card2.left >= qcol.left - 1 && card2.right <= qcol.right + 1 && card2.top >= qcol.top - 1 && card2.bottom <= qcol.bottom + 1, `the card fills the quick column: ${JSON.stringify({ card2, qcol })}`)
    assert.ok(card2.width > qcol.width * 0.8, 'the card takes the column\'s width')
    const tvCentre = (await rect('.rg > .rg-center'))!
    assert.ok(card2.left >= tvCentre.right - 1, 'the conversation stays uncovered')
    await page.screenshot({ path: join(SHOTS, 'tv-cartao.png') })
    await closeCard()
    await until('the column empty again', async () => !(await tiers()).quickOpen)

    // ---- 3. back to the desktop ----
    console.log('step 3: desktop')
    await widen(1500)
    await until('the desktop', async () => (await tiers()).tier === 'desktop', 20_000)
    await frames()
    for (const sel of ['.rg-left', '.rg-center', '.rg-right']) assert.equal(await shown(`.rg > ${sel}`), true, `${sel} in view`)
    for (const sel of ['.rg-side-seg', '.rg-trail', '.rg-qcol', '.rg-srail', '.rg-tabbar']) assert.equal(await shown(`.rg > ${sel}`), false, `${sel} out of the layout`)
    assert.equal(await shown('.rg-right .rg-reserved .rg-sys-open'), true, 'the foot carries "Sistema" again')
    assert.equal(await desk(), DESK, 'nothing came forward')
  } finally {
    contribution.channels = savedChannels
    if (app) await killElectron(app, root).catch(() => {})
    try {
      const h = await cli(['proc', 'host', '--json'])
      const host = h.code === 0 ? JSON.parse(h.stdout) as { pid: number } | null : null
      if (host?.pid) { const o = await claim(host.pid, { cmdIncludes: home, what: 'tether-procd' }).catch(() => undefined); if (o) owned.push(o) }
      await cli(['proc', 'host', 'stop', '--force'])
    } catch { /* the host goes with its processes below */ }
    for (const o of owned) await killOwned(o, { tree: true }).catch(() => {})
    ch.dispose()
    await door.delivery.flush().catch(() => {})
    own.dispose()
    door.delivery.dispose()
    await daemon.close()
    await door.mcp.close()
    if (testContext !== undefined) process.env.NODE_TEST_CONTEXT = testContext
    await removeHome(home)
  }
})

function rightColumnIsTree(l: RegencyLayout | undefined): boolean { return l?.column !== 'system' }
