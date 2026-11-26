// E2E of the Regency's "Sistema" (slice R5d): a tetherd in this process on a private home and pipe (two fake `claude` agents,
// test/fixtures/channels/agent.cjs, no LLM; the ronda's channel offered with no flag, so a ronda is accepted and shows "sem
// canal"), the channels' record and requests on its door, a REAL tether-procd with two harmless processes (a .cjs that ticks),
// and the real app on the same pipe, hidden window at 1500 px. Nothing touches the person's tether.
//   1. the foot "Sistema" swaps the right column ("voltar ao tether" on top); the conversation in the centre does not move;
//   2. the open section and the column are kept in the layout and survive reopening the pane;
//   3. processes: stop, start, restart by the row's buttons;
//   4. the record: a click on the row peeks it (lines arriving, no tab); "Abrir o registro numa mesa…" opens it as a tab on
//      the awake desk without switching desk;
//   5. in use by another: the refusal says who, until when and what for, with wait, force (a reason required) and cancel;
//   6. a process that falls lights the red dot on the foot and on the immersion's edge (never on the pill); it goes when the
//      process runs again;
//   7. ronda: on (interval, criterion), remount (a repaint by an event keeps the open field), off with a criterion asks first;
//   8. profiles: the list (env names, never a value); "Editar" opens the core's manager;
//   9. projects: "Agente aqui…" and "Terminal aqui…" open "+ Novo" with the folder;
//  10. ajustes: Configurações opens in the quick view; Bridge and Sync say their state;
//  11. the phone: "Sistema" lives in "Tether", 44 px targets.
// Captures go to C:/atrium/.tmp/tether-agents/onda-3/mesa-regencia/capturas/r5-*.png.
// Run alone: npm run app:build && node --test --test-force-exit --test-concurrency=1 test/e2e/app.regency-system.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { DisposableStore } from '../../app/shared/vscode-lifecycle.ts'
import '../../src/agents/load.ts'
import { agentRegistry, type AgentContribution } from '../../src/agents/registry.ts'
import type { AgentAdapter, LaunchPlan } from '../../src/agents/types.ts'
import { DoorHost } from '../../src/daemon/door/host.ts'
import { fsIo } from '../../src/daemon/ext-io.ts'
import type { ProcEvent, ProcState } from '../../src/daemon/procs.ts'
import type { Reply } from '../../src/daemon/protocol.ts'
import { startDaemon } from '../../src/daemon/server.ts'
import { createChannels, type Channels, type ChannelsApi } from '../../extensions/channels/daemon/fanout.ts'
import { registerChannelRequests } from '../../extensions/channels/daemon/requests.ts'
import { openStore } from '../../extensions/channels/daemon/store.ts'
import { USER } from '../../extensions/channels/rules.ts'
import type { RegencyLayout } from '../../extensions/regency/renderer/layout-rules.ts'
import { claim, killOwned, type Owned } from '../kill.ts'
import { removeHome, tempHome, uniquePipe, waitUntil } from '../unit/daemon.helpers.ts'
import { killElectron } from './electron.ts'

type SysRow = { key: string; text: string; state?: string; acts: string[]; panel?: string }
type SysSnap = { column: string; section: string; dot: { foot: boolean; edge: boolean; tip: string }; view: { section: string; paints: number; rows: SysRow[]; empty?: string; foot: string } }
type CreateSnap = { open: boolean; step: string; draft: { what?: string; cwd?: string } }
type OutSnap = { text: string }
type Hooks = {
  panelIds(): string[]
  activeDesk(): string
  runCommand(id: string): Promise<string>
  peekState(): { open: boolean; screen?: string; screenType?: string; mode?: 'modal' | 'docked' }
  desks(): { id: string; panes: string[] }[]
  processesOutput(name: string): OutSnap | null
  processesEmbed(op: string, name?: string, arg?: Record<string, unknown>): Promise<{ ok?: true; refusal?: string }>
  ext: {
    channels: { embedView(channelId: string): unknown }
    regency: {
      layout(): RegencyLayout | undefined
      select(channelId: string): void
      close(): void
      tier(): string | undefined
      system(): SysSnap | undefined
      openSystem(section?: string | false): void
      createView(): CreateSnap
    }
  }
}
declare const window: { __tether: Hooks; tether: { request(body: unknown): Promise<Reply> } }
declare const document: { querySelector(s: string): { textContent: string | null } | null; activeElement: { dataset?: Record<string, string>; value?: string } | null; body: { innerText: string } }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const AGENT = fileURLToPath(new URL('../fixtures/channels/agent.cjs', import.meta.url))
const CLI = join(root, 'bin', 'tether.mjs')
const SHOTS = 'C:/atrium/.tmp/tether-agents/onda-3/mesa-regencia/capturas'
const DESK = 'regency.main'
const PANE = 'regency:main'
const SECRET = 'valor-secreto-r5d'

/** A harmless process: prints "pronto", a tick every 300 ms, listens on a port when given one. */
const FIXTURE = `
const http = require('node:http')
const port = Number(process.argv[2] || 0)
if (port) http.createServer((q, s) => s.end('ok')).listen(port, 'localhost')
console.log('pronto ' + process.pid)
let n = 0
setInterval(() => console.log('tick ' + n++), 300)
`

function freePort(): Promise<number> {
  return new Promise(res => { const s = createServer().listen(0, 'localhost', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)) }) })
}

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
  await page.waitForFunction(() => typeof window.__tether.ext?.regency?.system === 'function')
  return { app, page }
}

test('regency system: the column, processes, record, in use, red dot, ronda, profiles, projects, ajustes, phone', { timeout: 600_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(join(SHOTS, 'r6'), { recursive: true })
  const home = tempHome()
  const pipe = uniquePipe(home)
  const work = join(home, 'work')
  mkdirSync(work, { recursive: true })
  const fixture = join(work, 'tick.cjs')
  writeFileSync(fixture, FIXTURE)
  const webPort = await freePort()
  const logs: string[] = []
  const door = new DoorHost({ log: m => logs.push(m) })
  const own = new DisposableStore()
  // The process host (tether-procd) inherits this process' env: it must not look like a test child.
  const testContext = process.env.NODE_TEST_CONTEXT
  delete process.env.NODE_TEST_CONTEXT
  /** The test's processes and host, claimed while known to be its own: what is left of them at the end is killed. */
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
    // The ronda's channel is offered with no flag: the fake agent never listens, so a ronda shows "sem canal".
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
  const history = async (name: string): Promise<ProcEvent[]> => JSON.parse(await ok(['proc', 'history', name, '--json'])) as ProcEvent[]
  /** Claimed while it is known to be the test's (its command line holds the fixture's path): only these are ever killed. */
  const track = async (name: string): Promise<ProcState> => {
    const p = (await proc(name))!
    if (p.pid) { const o = await claim(p.pid, { cmdIncludes: fixture, what: `${name} fixture` }).catch(() => undefined); if (o) owned.push(o) }
    return p
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
    await ok(['proc', 'start', 'web', '--port', String(webPort), '--desc', 'servidor de teste', '--', 'node', fixture, String(webPort)])
    await ok(['proc', 'start', 'worker', '--', 'node', fixture])
    for (let i = 0; i < 100; i++) {
      if ((await proc('web'))?.status === 'running' && (await proc('worker'))?.status === 'running') break
      await new Promise(r => setTimeout(r, 300))
    }
    assert.equal((await proc('web'))?.status, 'running', 'web running')
    assert.equal((await proc('worker'))?.status, 'running', 'worker running')
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
    const sys = async (): Promise<SysSnap> => (await page.evaluate(() => window.__tether.ext.regency.system()))!
    const rowOf = async (key: string): Promise<SysRow | undefined> => (await sys()).view.rows.find(r => r.key === key)
    const layout = (): Promise<RegencyLayout | undefined> => page.evaluate(() => window.__tether.ext.regency.layout())
    const desk = (): Promise<string> => page.evaluate(() => window.__tether.activeDesk())
    const row = (key: string) => page.locator(`.rg-sr[data-key="${key}"]`)
    const act = (key: string, sysAct: string) => row(key).locator(`.rg-sr-h button[data-sys="${sysAct}"]`)
    const inPanel = (key: string, sysAct: string) => row(key).locator(`.rg-sr-x button[data-sys="${sysAct}"]`)
    const frames = (): Promise<void> => page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
    const ticks = (t: string): number => (t.match(/tick \d+/g) ?? []).length
    const closePeek = async (): Promise<void> => {
      await page.click('#peek .peek-close')
      await page.waitForFunction(() => !window.__tether.peekState().open)
    }

    // Into the Regency, with a conversation in the centre.
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
    const centre = async (): Promise<string> => (await page.locator('.rg-embed').innerText()).slice(0, 400)
    const centreBefore = await centre()

    // ---- 1. the foot swaps the column; the conversation stays ----
    console.log('step 1')
    const foot = page.locator('.rg-reserved .rg-sys-open')
    assert.equal(await foot.isVisible(), true)
    assert.match((await foot.getAttribute('title')) ?? '', /^Sistema/)
    await foot.click()
    await until('the column is "Sistema"', async () => (await sys()).column === 'system')
    assert.equal(await page.locator('.rg-right .rg-sys').isVisible(), true)
    assert.equal(await page.locator('.rg-right .rg-tree').isVisible(), false, 'the tree steps out')
    assert.equal(await page.locator('.rg-sys-back').innerText(), 'voltar às mesas')
    assert.equal((await sys()).section, 'processes', 'the first section by default')
    assert.equal((await layout())?.channelId, obra, 'the centre keeps its conversation')
    assert.equal(await centre(), centreBefore, 'the conversation did not move')
    assert.equal(await desk(), DESK)
    await page.click('.rg-sys-back')
    await until('back to the tree', async () => (await sys()).column === 'tether')
    assert.equal(await page.locator('.rg-right .rg-tree').isVisible(), true)
    assert.equal(await page.evaluate(() => (document.activeElement as { dataset?: Record<string, string> } | null)?.dataset?.action), 'system', 'the keyboard is on the foot again')
    assert.equal(await centre(), centreBefore)

    // ---- 2. the section and the column are kept, across reopening the pane ----
    console.log('step 2')
    await foot.click()
    await page.click('.rg-sys-tab[data-section="ronda"]')
    await until('ronda open', async () => (await sys()).section === 'ronda')
    await page.click('.rg-sys-back')
    await foot.click()
    await until('ronda again', async () => (await sys()).column === 'system' && (await sys()).section === 'ronda')
    assert.equal((await layout())?.system, 'ronda')
    assert.equal((await layout())?.column, 'system')
    await page.evaluate(() => window.__tether.ext.regency.close())
    await page.waitForFunction(p => window.__tether.panelIds().includes(p), PANE)
    await until('the new pane opens on "Sistema" › Ronda', async () => { const s = await sys(); return s?.column === 'system' && s.section === 'ronda' })
    await page.click('.rg-sys-tab[data-section="processes"]')
    await until('processes open', async () => (await sys()).view.section === 'processes')

    // ---- 3. processes: stop, start, restart ----
    console.log('step 3')
    await until('both rows', async () => !!(await rowOf('proc:web')) && !!(await rowOf('proc:worker')))
    const web = (await rowOf('proc:web'))!
    assert.equal(web.state, 'ok')
    assert.match(web.text, /Rodando/)
    assert.match(web.text, new RegExp(`porta ${webPort}`))
    assert.doesNotMatch(web.text, /parada|ouvindo/, 'a port never reads as a state beside "Rodando"')
    assert.ok(web.acts.includes('stop') && web.acts.includes('restart') && web.acts.includes('hold') && web.acts.includes('log'))
    assert.match((await sys()).view.foot, /^.*Processos novos se criam pela linha de comando\.$/s)
    assert.doesNotMatch((await sys()).view.foot, /tether proc/, 'no command on the foot')
    // R6, M: every act of a process says its verb first, to the eye (tooltip) and to the screen reader (aria-label).
    const tips = await row('proc:web').locator('.rg-sr-h .rg-sr-a button').evaluateAll(es => es.map(e => [(e as unknown as { dataset: { sys: string } }).dataset.sys, (e as unknown as { title: string }).title, (e as unknown as { getAttribute(n: string): string | null }).getAttribute('aria-label')]))
    const verb: Record<string, string> = { stop: 'Parar', start: 'Iniciar', restart: 'Reiniciar', hold: 'Segurar', release: 'Soltar', log: 'Espiar o registro', more: 'Mais ações' }
    for (const [id, title, aria] of tips) {
      assert.ok(verb[id!] && title!.startsWith(verb[id!]!), `"${id}" has the tooltip "${verb[id!]}…" (${title})`)
      assert.equal(aria, title, `"${id}" says the same to a screen reader`)
    }
    assert.equal(await act('proc:web', 'hold').locator('svg').count(), 1)
    assert.equal(await act('proc:web', 'hold').getAttribute('aria-pressed'), 'false', '"Segurar" is a toggle (a lock)')
    assert.doesNotMatch(await page.locator('.rg-sys').innerText(), /Novo processo/)
    await act('proc:worker', 'stop').click()
    await until('worker stopped', async () => (await proc('worker'))?.status === 'stopped')
    await until('the row says stopped', async () => { const r = await rowOf('proc:worker'); return r?.state === 'off' && r.acts.includes('start') })
    assert.equal((await history('worker')).filter(e => e.kind === 'stop-requested').at(-1)?.by?.kind, 'app')
    await act('proc:worker', 'start').click()
    await until('worker running', async () => (await proc('worker'))?.status === 'running')
    await until('the row says running', async () => (await rowOf('proc:worker'))?.state === 'ok')
    const runBefore = (await proc('worker'))!.run!
    await act('proc:worker', 'restart').click()
    await until('worker restarted', async () => { const p = await proc('worker'); return p?.status === 'running' && p.run === runBefore + 1 })
    await track('worker')
    await until('the row is running again', async () => (await rowOf('proc:worker'))?.state === 'ok')
    await page.screenshot({ path: join(SHOTS, 'r5-processos.png') })
    await act('proc:web', 'stop').hover()
    await page.waitForTimeout(900)
    await page.screenshot({ path: join(SHOTS, 'r6', 'sistema-processos.png') })

    // ---- 4. the record: a peek with lines arriving; on a desk without switching ----
    console.log('step 4')
    await row('proc:web').locator('.rg-sr-n').click()
    await until('the card is the record', async () => { const s = await page.evaluate(() => window.__tether.peekState()); return s.open && s.screenType === 'process' })
    // R6: docked over the conversation like every other quick view of the Regency, not the modal card.
    assert.equal((await page.evaluate(() => window.__tether.peekState())).mode, 'docked', 'the record is docked over the conversation')
    let first: OutSnap | null = null
    await until('lines in the card', async () => { first = await page.evaluate(() => window.__tether.processesOutput('web')); return first && /tick \d+/.test(first.text) })
    await until('lines keep arriving', async () => ticks((await page.evaluate(() => window.__tether.processesOutput('web')))?.text ?? '') > ticks(first!.text) + 2)
    assert.ok(!(await page.evaluate(() => window.__tether.panelIds())).includes('process:web'), 'no tab for a peek')
    await page.screenshot({ path: join(SHOTS, 'r6', 'registro-ancorado.png') })
    await closePeek()
    await act('proc:web', 'more').click()
    await page.locator('#ctx-menu li', { hasText: 'Abrir o registro numa mesa…' }).click()
    await page.locator('.pk-list li.pk-item').first().waitFor()
    await page.locator('.pk-list li.pk-item').first().click()
    await until('the record is a tab on the queue desk', async () => (await page.evaluate(() => window.__tether.desks())).some(d => d.id !== 'regency.main' && d.panes.includes('process:web')))
    assert.equal(await desk(), DESK, 'the person stayed on the Regency')

    // ---- 5. in use by another: who, until when, what for; wait, force with a reason, cancel ----
    console.log('step 5')
    await ok(['proc', 'use', 'web', '10m', 'e2e do checkout', '--as', 'kai'])
    await until('the row says who uses it', async () => /kai usa até daqui a/.test((await rowOf('proc:web'))?.text ?? ''))
    await act('proc:web', 'stop').click()
    await until('the refusal under the row', async () => /em uso|outro o usa/.test((await rowOf('proc:web'))?.panel ?? ''))
    const panel = (await rowOf('proc:web'))!.panel!
    assert.match(panel, /Não dá para parar "web" agora/)
    assert.match(panel, /kai usa até daqui a .*e2e do checkout/)
    for (const x of ['inuse-wait', 'inuse-force', 'inuse-cancel']) assert.equal(await inPanel('proc:web', x).count(), 1, x)
    assert.equal((await proc('web'))!.status, 'running', 'the refusal stopped nothing')
    await page.screenshot({ path: join(SHOTS, 'r5-processo-em-uso.png') })
    await inPanel('proc:web', 'inuse-cancel').click()
    await until('cancel closes the panel', async () => (await rowOf('proc:web'))?.panel === undefined)
    await act('proc:web', 'stop').click()
    await until('the refusal again', async () => !!(await rowOf('proc:web'))?.panel)
    await inPanel('proc:web', 'inuse-force').click()
    await inPanel('proc:web', 'inuse-force-go').click()
    await until('a reason is required', async () => /Diga o motivo/.test((await rowOf('proc:web'))?.panel ?? ''))
    assert.equal((await proc('web'))!.status, 'running')
    await row('proc:web').locator('[data-field="reason"]').fill('e2e da tela de sistema')
    await inPanel('proc:web', 'inuse-force-go').click()
    await until('web stopped over the use', async () => (await proc('web'))?.status === 'stopped')
    assert.equal((await history('web')).filter(e => e.kind === 'forced').at(-1)?.reason, 'e2e da tela de sistema')
    await ok(['proc', 'release', 'web', '--as', 'kai'])
    await until('the panel went', async () => (await rowOf('proc:web'))?.panel === undefined)
    await act('proc:web', 'start').click()
    await until('web running again', async () => (await proc('web'))?.status === 'running')
    await track('web')

    // ---- 6. the red dot: a process that falls lights the foot and the edge, never the pill; it goes when it runs again ----
    console.log('step 6')
    await page.click('.rg-sys-back')
    await until('the tree', async () => (await sys()).column === 'tether')
    const worker = (await proc('worker'))!
    assert.equal(await killOwned(await claim(worker.pid!, { cmdIncludes: fixture, what: 'worker fixture' }), { tree: true }), 'killed')
    await until('the dot on the foot', async () => (await sys()).dot.foot, 20_000)
    assert.match((await sys()).dot.tip, /O processo "worker" caiu/)
    assert.equal(await page.locator('.rg-reserved .rg-sys-dot:not([hidden])').isVisible(), true)
    // R6, N: the dot comes with its words, in the same red.
    assert.equal(await page.locator('.rg-reserved .rg-sys-dot-t').innerText(), '1 processo caiu')
    const reds = await page.evaluate(() => {
      const css = (s: string): string => (globalThis as unknown as { getComputedStyle(e: unknown): { color: string; backgroundColor: string } }).getComputedStyle(document.querySelector(s)).color
      const bg = (s: string): string => (globalThis as unknown as { getComputedStyle(e: unknown): { backgroundColor: string } }).getComputedStyle(document.querySelector(s)).backgroundColor
      return [css('.rg-reserved .rg-sys-dot-t'), bg('.rg-reserved .rg-sys-dot')]
    })
    assert.equal(reds[0], reds[1], 'the words are the dot\'s red')
    await page.screenshot({ path: join(SHOTS, 'r6', 'processo-caiu.png') })
    assert.equal(await page.locator(`#desk-switch .seg.sys[data-system="${DESK}"] .rg-sys-dot`).count(), 0, 'not on the pill')
    await page.screenshot({ path: join(SHOTS, 'r5-ponto-vermelho.png') })
    await page.click('.rg-mode')
    await until('immersion', async () => page.locator('.rg-edge-r').isVisible())
    assert.equal(await page.locator('.rg-edge-r .rg-edge-sys .rg-sys-dot:not([hidden])').isVisible(), true, 'the dot on the edge')
    assert.match((await page.locator('.rg-edge-r .rg-edge-sys').getAttribute('title')) ?? '', /worker/)
    await page.screenshot({ path: join(SHOTS, 'r5-ponto-vermelho-imersao.png') })
    await page.click('.rg-edge-r .rg-edge-sys')
    await until('back to manage, on "Sistema"', async () => (await sys()).column === 'system' && page.locator('.rg-right').isVisible())
    await page.click('.rg-sys-back')
    // Not seen yet (it was seen only if Processos was on screen): start it again by the feed, and the dot goes.
    assert.deepEqual(await page.evaluate(() => window.__tether.processesEmbed('start', 'worker')), { ok: true })
    await until('worker running', async () => (await proc('worker'))?.status === 'running')
    await track('worker')
    await until('the dot went', async () => !(await sys()).dot.foot && !(await sys()).dot.edge)

    // ---- 7. ronda: on, remount (a repaint keeps the field), off asking with the criterion ----
    console.log('step 7')
    await foot.click()
    await page.click('.rg-sys-tab[data-section="ronda"]')
    await until('two agents, no ronda', async () => { const s = await sys(); return s.view.rows.filter(r => r.key.startsWith('ronda:') && /sem ronda/.test(r.text)).length === 2 })
    await act(`ronda:${a}`, 'ronda-on').click()
    await row(`ronda:${a}`).locator('[data-field="interval"]').selectOption('10m')
    await row(`ronda:${a}`).locator('[data-field="criterion"]').fill('bateria verde')
    await inPanel(`ronda:${a}`, 'ronda-go').click()
    await until('ronda on', async () => { const r = await rowOf(`ronda:${a}`); return /a cada 10 min/.test(r?.text ?? '') && /até "bateria verde"/.test(r?.text ?? '') && !r?.panel })
    // The fake agent never listens on the ronda's channel: "sem canal" in place of the next time.
    assert.match((await rowOf(`ronda:${a}`))!.text, /sem canal/)
    assert.doesNotMatch((await rowOf(`ronda:${a}`))!.text, /próxima/)
    await act(`ronda:${a}`, 'ronda-remount').click()
    const nudge = row(`ronda:${a}`).locator('[data-field="nudge"]')
    await nudge.click()
    await page.keyboard.type('olhe a fila')
    const paints = (await sys()).view.paints
    // An event repaints the section (the other agent's ronda goes on): the open field keeps its text and the keyboard.
    const other = await page.evaluate(s => window.tether.request({ t: 'ronda-set', slotId: s, interval: '20m' }), b)
    assert.equal(other.t, 'ok', JSON.stringify(other))
    await until('repainted', async () => (await sys()).view.paints > paints && /a cada 20 min/.test((await rowOf(`ronda:${b}`))?.text ?? ''))
    assert.equal(await page.evaluate(() => (document.activeElement as { dataset?: Record<string, string> } | null)?.dataset?.field), 'nudge', 'the field keeps the keyboard')
    assert.equal(await nudge.inputValue(), 'olhe a fila', 'and its text')
    await page.keyboard.type(' de novo')
    await row(`ronda:${a}`).locator('[data-field="interval"]').selectOption('30m')
    await inPanel(`ronda:${a}`, 'ronda-go').click()
    await until('remounted', async () => /a cada 30 min/.test((await rowOf(`ronda:${a}`))?.text ?? ''))
    const slotRonda = await page.evaluate(s => window.tether.request({ t: 'ronda-get', slotId: s }), a) as { ronda?: { nudge?: string; criterion?: string } }
    assert.equal(slotRonda.ronda?.nudge, 'olhe a fila de novo')
    assert.equal(slotRonda.ronda?.criterion, 'bateria verde')
    await page.screenshot({ path: join(SHOTS, 'r5-ronda.png') })
    await act(`ronda:${a}`, 'ronda-off').click()
    await until('off asks, with the criterion', async () => /critério de parada: "bateria verde".*Desligar assim mesmo/.test((await rowOf(`ronda:${a}`))?.panel ?? ''))
    assert.match((await rowOf(`ronda:${a}`))!.text, /a cada 30 min/, 'still on while it asks')
    await inPanel(`ronda:${a}`, 'ronda-force').click()
    await until('a is off', async () => /sem ronda/.test((await rowOf(`ronda:${a}`))?.text ?? ''))
    await act(`ronda:${b}`, 'ronda-off').click()
    await until('b is off with no question (no criterion)', async () => /sem ronda/.test((await rowOf(`ronda:${b}`))?.text ?? ''))

    // ---- 8. profiles: names of the variables, never a value; "Editar" opens the manager ----
    console.log('step 8')
    const saved = await page.evaluate(s => window.tether.request({ t: 'profile-save', profile: { name: 'Sonda R5d', agent: 'claude', args: [], env: { SONDA_TOKEN: s } } }), SECRET)
    assert.equal(saved.t, 'ok', JSON.stringify(saved))
    const pid = (saved as { profile: { id: string } }).profile.id
    await page.click('.rg-sys-tab[data-section="profiles"]')
    await until('the profile listed', async () => /SONDA_TOKEN/.test((await rowOf(`profile:${pid}`))?.text ?? ''))
    assert.match((await rowOf(`profile:${pid}`))!.text, /Claude/)
    assert.equal((await page.evaluate(() => document.body.innerText)).includes(SECRET), false, 'no value on screen')
    assert.equal(JSON.stringify(await sys()).includes(SECRET), false)
    assert.match((await sys()).view.foot, /Novo perfil/)
    await page.screenshot({ path: join(SHOTS, 'r5-perfis-projetos.png') })
    await act(`profile:${pid}`, 'profile-edit').click()
    await page.waitForSelector('#dlg-profiles[open]')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => document.querySelector('#dlg-profiles[open]') === null)

    // ---- 9. projects: "Agente aqui…" and "Terminal aqui…" open "+ Novo" with the folder ----
    console.log('step 9')
    await page.click('.rg-sys-tab[data-section="projects"]')
    const projectKey = async (): Promise<string | undefined> => (await sys()).view.rows.find(r => r.key.startsWith('project:'))?.key
    await until('a project', async () => !!(await projectKey()))
    const pkey = (await projectKey())!
    const folder = pkey.slice('project:'.length)
    assert.match((await rowOf(pkey))!.text, /2 guias/)
    await page.screenshot({ path: join(SHOTS, 'r5-perfis-projetos-2.png') })
    const card = (): Promise<CreateSnap> => page.evaluate(() => window.__tether.ext.regency.createView())
    const closeCard = async (): Promise<void> => {
      for (let i = 0; i < 6 && (await card()).open; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150) }
      assert.equal((await card()).open, false, 'the card closed')
    }
    // The key holds a Windows path (backslashes): the row is found by its class, not by a selector on the key.
    const projectAct = (x: string) => page.locator('.rg-sr.project').first().locator(`.rg-sr-h button[data-sys="${x}"]`)
    await projectAct('agent-here').click()
    await until('the card with the folder, the profile picker over it', async () => { const c = await card(); return c.open && c.draft.cwd === folder })
    await page.locator('.pk-list').waitFor()
    await page.keyboard.press('Escape')
    await until('the picker closed, the folder kept', async () => { const c = await card(); return c.open && c.draft.cwd === folder && !(await page.locator('.pk-list').isVisible()) })
    await closeCard()
    await projectAct('terminal-here').click()
    await until('the terminal card asks where, with the folder', async () => { const c = await card(); return c.open && c.step === 'where' && c.draft.what === 'terminal' && c.draft.cwd === folder })
    await closeCard()
    assert.equal(await desk(), DESK)

    // ---- 10. ajustes ----
    console.log('step 10')
    await page.click('.rg-sys-tab[data-section="settings"]')
    await until('the five items', async () => (await sys()).view.rows.filter(r => r.key.startsWith('settings:')).length === 5)
    assert.ok((await rowOf('settings:bridge'))!.text.length > 'Bridge'.length, 'Bridge says its state')
    assert.ok((await rowOf('settings:sync'))!.text.length > 'Sync'.length, 'Sync says its state')
    await page.screenshot({ path: join(SHOTS, 'r5-ajustes.png') })
    await act('settings:settings', 'screen').click()
    await until('Configurações in the quick view', async () => { const s = await page.evaluate(() => window.__tether.peekState()); return s.open && s.screenType === 'settings' })
    await closePeek()
    assert.equal(await desk(), DESK)

    // ---- 11. the phone: "Sistema" in "Tether", 44 px ----
    console.log('step 11')
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(560, 900) })
    await until('the phone', async () => (await page.evaluate(() => window.__tether.ext.regency.tier())) === 'mobile')
    await page.click('.rg-tabbar [data-tab="tether"]')
    await page.click('.rg-sys-tab[data-section="processes"]')
    await frames()
    assert.equal(await page.locator('.rg-right .rg-sys').isVisible(), true, '"Sistema" inside "Tether"')
    for (const sel of ['.rg-sys-back', '.rg-sys-tab[data-section="ronda"]', `.rg-sr[data-key="proc:web"] .rg-sys-ib[data-sys="stop"]`]) {
      const box = (await page.locator(sel).boundingBox())!
      assert.ok(box.height >= 44, `${sel} is 44 px (${box.height})`)
    }
    await page.screenshot({ path: join(SHOTS, 'r5-celular-sistema.png') })
    await page.click('.rg-sys-back')
    await until('the tree in "Tether"', async () => page.locator('.rg-right .rg-tree').isVisible())
    assert.equal(await page.locator('.rg-reserved .rg-sys-open').isVisible(), true, 'the same foot')
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
