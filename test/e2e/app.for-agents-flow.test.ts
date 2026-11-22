// V1: the scene of section 8 of the contract (tether for agents) with FAKE agents and the owner driven by the real CLI, no LLM.
// A tetherd in this process on a private home and pipe, with the real for-agents daemon side (ownership, verbs, notices, watch);
// the real app on the same pipe, hidden window. The owner ("Atrium") is a fake agent whose process runs the CLI (`node "$TETHER_CLI"
// agents ...`) for each command the test appends to a file, with the slot's own environment; what the delivery types into it (the
// notices) is logged. The three guias of `cena` are fake agents in .cjs files (test/fixtures/for-agents) under a FAKE conductor:
// the engines' conductors read real screens, which a fake has not. The engine's own report of the end of a turn (Stop, notify) is
// played by the test with `attention.signal(slot, 'done')`.
// In every step: the visible desk and the active pane are the same before and after the owner's gesture, and the bell (the history
// of attention main keeps) has no line for a commanded guia.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { DisposableStore } from '../../app/shared/vscode-lifecycle.ts'
import { conductorRegistry, type Conductor, type Detected } from '../../extensions/for-agents/conductor-api.ts'
import { wire } from '../../extensions/for-agents/daemon.ts'
import { EXT_ID, manifest } from '../../extensions/for-agents/manifest.ts'
import type { ExtensionEntry } from '../../extensions/types.ts'
import '../../src/agents/load.ts'
import { agentRegistry } from '../../src/agents/registry.ts'
import type { AgentAdapter, LaunchPlan } from '../../src/agents/types.ts'
import type { Profile } from '../../src/core/profile.ts'
import { writeProfiles } from '../../src/core/profile-sync.ts'
import { DoorHost } from '../../src/daemon/door/host.ts'
import { DaemonExtensionHost } from '../../src/daemon/ext-host.ts'
import type { TetherDaemon } from '../../src/daemon/ext-api.ts'
import { startDaemon } from '../../src/daemon/server.ts'
import { removeHome, sleep, tempHome, uniquePipe, waitUntil } from '../unit/daemon.helpers.ts'
import { killElectron } from './electron.ts'

type Hooks = {
  activeDesk(): string
  activeId(): string | undefined
  currentPane(): string | undefined
  switchDesk(id: string): void
  renameDesk(id: string, name: string): void
  openSlot(id: string): Promise<void>
  panelIds(): string[]
}
declare const window: { __tether: Hooks; tether: { attentionGet(): Promise<{ items: { slotId: string }[] }> }; innerWidth: number }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const FIXTURES = join(root, 'test', 'fixtures', 'for-agents')

// The owner: runs each command of cmd.jsonl as `tether agents ...` and appends the outcome to out.jsonl; what is typed into it goes to told.log.
const ownerScript = (dir: string): string => String.raw`
const fs = require('node:fs'), path = require('node:path')
const { spawnSync } = require('node:child_process')
const dir = ${JSON.stringify(dir)}
const cmdFile = path.join(dir, 'cmd.jsonl'), outFile = path.join(dir, 'out.jsonl'), toldFile = path.join(dir, 'told.log')
let offset = 0
process.stdout.write('OWNER READY\r\n')
if (process.stdin.setRawMode) process.stdin.setRawMode(true)
process.stdin.on('data', (d) => fs.appendFileSync(toldFile, d.toString().replace(/\r/g, '\n')))
setInterval(() => {
  let size = 0
  try { size = fs.statSync(cmdFile).size } catch { return }
  if (size <= offset) return
  const chunk = fs.readFileSync(cmdFile).subarray(offset, size).toString('utf8'); offset = size
  for (const line of chunk.split('\n').filter(Boolean)) {
    const { id, argv } = JSON.parse(line)
    const r = spawnSync(process.execPath, [process.env.TETHER_CLI, 'agents', ...argv, '--json'], { encoding: 'utf8', env: process.env, timeout: 120000 })
    fs.appendFileSync(outFile, JSON.stringify({ id, argv, status: r.status, stdout: r.stdout, stderr: r.stderr }) + '\n')
  }
}, 150)
`

/** The fake conductor: the engine of the fake agents. The card is on the screen from "PERMISSION CARD" until "CARD CLOSED". */
function fakeConductor(): Conductor {
  const textOf = async (ctx: Parameters<NonNullable<Conductor['detect']>>[0]): Promise<string> => { const t = await ctx.screen(); return [...t.history, ...t.screen].join('\n') }
  return {
    id: 'fake-flow',
    match: t => (t.type === 'terminal' && t.slot?.kind === 'soul' ? 10 : undefined),
    capabilities: [{ id: 'send', label: 'Enviar' }, { id: 'interrupt', label: 'Interromper' }, { id: 'answer', label: 'Responder' }, { id: 'command', label: 'Comandos' }],
    watch: true,
    send: async (ctx, text) => {
      // A paste (the text may have lines), then the Enter apart, as the engines' conductors do.
      await ctx.write([{ data: `\x1b[200~${text}\x1b[201~` }, { data: '\r', waitMs: 100 }])
      return { value: undefined, proven: true }
    },
    detect: async (ctx): Promise<Detected> => {
      const text = await textOf(ctx)
      const open = text.lastIndexOf('PERMISSION CARD')
      if (open >= 0 && open > text.lastIndexOf('CARD CLOSED')) {
        return { state: 'permission', card: { title: 'PERMISSION CARD', text: text.slice(open), options: [{ id: 'yes', label: 'yes' }, { id: 'always', label: 'always' }, { id: 'no', label: 'no' }] } }
      }
      return { state: ctx.slot()?.turn === 'busy' ? 'busy' : 'idle' }
    },
    answer: async (ctx, choice) => { await ctx.write([{ data: ({ yes: '1', always: '2', no: '3' } as Record<string, string>)[choice] ?? choice }]); return { value: undefined, proven: true } },
    read: async (ctx, opts) => {
      const t = await ctx.screen()
      const lines = t.screen.join('\n').trimEnd().split('\n')
      return { text: (opts.lines ? lines.slice(-opts.lines) : lines).join('\n'), meta: { cols: t.cols, rows: t.rows, end: t.end } }
    },
    lastAnswer: async ctx => {
      const lines = (await textOf(ctx)).split('\n').filter(l => /^RESP/.test(l))
      const last = lines.at(-1)
      return last ? { value: { text: last, at: new Date().toISOString(), source: 'hook' }, proven: true } : undefined
    },
  }
}

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

interface Verb { ok: boolean; data: Record<string, any>; err: string }

test('for-agents flow: the scene of section 8 with fake agents and the owner driven by the CLI', { timeout: 300_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'ignore', env: { ...process.env, TETHER_TEST_EXTENSIONS: '1' } })
  assert.equal(build.status, 0, 'app build failed')
  const home = tempHome()
  const pipe = uniquePipe(home)
  const work = join(home, 'owner'); mkdirSync(work)
  const bench = join(home, 'bench'); mkdirSync(bench)
  const logs: string[] = []
  writeFileSync(join(home, 'owner.cjs'), ownerScript(work))
  const fake: AgentAdapter = {
    name: 'soul',
    plan: (input): LaunchPlan => {
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^CLAUDE/i.test(k)) env[k] = v
      delete env.NODE_TEST_CONTEXT
      env.TETHER_HOME = home
      env.TETHER_PIPE = pipe
      const script = input.slot.name === 'Atrium' ? join(home, 'owner.cjs') : join(FIXTURES, /cartão/.test(input.slot.name ?? '') ? 'card.cjs' : 'turn.cjs')
      return { command: process.execPath, args: [script], cwd: input.resume?.cwd ?? input.slot.cwd, env }
    },
    sessionExists: async () => 'unknown',
    title: async b => b.title,
  }
  const door = new DoorHost({ log: m => logs.push(m) })
  const entry: ExtensionEntry<TetherDaemon> = { manifest, activate: api => wire(api).disposables }
  const profiles: Profile[] = [{ id: 'soul', name: 'soul', agent: 'soul', args: ['-g'], default: true }]
  writeProfiles(home, profiles)
  const host = new DaemonExtensionHost({ home, log: m => logs.push(m), door, extensions: [entry], profileStore: { profiles: () => profiles } })
  host.activate()
  const daemon = await startDaemon({
    home, pipe, memoryIntervalMs: 0, readyFallbackMs: 500, minAgentAgeMs: 0, adapters: { soul: fake }, door,
    transformPlan: host.transformPlan, onSlot: host.emitSlot, log: m => logs.push(m),
  })
  await door.releaseInactive(host.activated)
  host.emitStarted()
  // The real conductors load lazily and would answer for a fake soul: force the load, then leave only the fake one.
  agentRegistry.names()
  const list = (conductorRegistry as unknown as { list: Conductor[] }).list
  const setAside = list.slice()
  list.splice(0, list.length, fakeConductor())
  const probe = new DisposableStore()
  const api = door.apiFor(EXT_ID, probe)
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home, pipe))
    page.on('console', m => { if (m.type() === 'error') console.log(m.type(), m.text()) })
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(1600, 900) })
    await page.waitForFunction(() => window.innerWidth >= 1500)

    // ---- the layout: `atrium` (visible, with the owner) and `cena` (empty, hidden) ----
    await page.keyboard.press('Control+Shift+N')
    await page.waitForFunction(() => window.__tether.activeDesk() === 'desk-2')
    const D1 = 'desk-1', D2 = 'desk-2'
    await page.evaluate(() => { window.__tether.renameDesk('desk-1', 'atrium'); window.__tether.renameDesk('desk-2', 'cena') })
    await page.evaluate(id => window.__tether.switchDesk(id), D1)
    await page.waitForFunction(() => window.__tether.activeDesk() === 'desk-1')
    const A = (await api.slots.create({ kind: 'soul', cwd: work, name: 'Atrium' })).slotId
    await page.evaluate(id => window.__tether.openSlot(id), A)
    await page.locator(`.tether-tab[data-slot="${A}"]`).waitFor()
    await page.locator(`.tether-tab[data-slot="${A}"]`).click()
    await waitUntil(() => (api.desks.map()?.desks.length ?? 0) >= 2, 20_000, 'desk map')
    await waitUntil(() => api.slots.get(A)?.status === 'running', 30_000, 'the owner runs')

    // ---- probes ----
    const view = () => page.evaluate(() => ({ desk: window.__tether.activeDesk(), active: window.__tether.activeId(), current: window.__tether.currentPane() }))
    const bell = (): Promise<string[]> => page.evaluate(() => window.tether.attentionGet().then(s => s.items.map(i => i.slotId)))
    const commanded = new Set<string>()
    const told = (): string => { const f = join(work, 'told.log'); return existsSync(f) ? readFileSync(f, 'utf8').replace(/\u001b?\[20[01]~/g, '') : '' }
    const count = (re: RegExp): number => (told().match(re) ?? []).length
    const until = (fn: () => boolean, what: string, ms = 30_000): Promise<void> => waitUntil(fn, ms, what)
    let nextId = 1
    const outcomes = (): { id: number; status: number | null; stdout: string; stderr: string }[] => {
      const f = join(work, 'out.jsonl')
      return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
    }
    /** `tether agents <argv>` as the owner. The visible desk, the active pane and the bell are the same before and after. */
    const verb = async (...argv: string[]): Promise<Verb> => {
      const before = await view()
      const id = nextId++
      appendFileSync(join(work, 'cmd.jsonl'), JSON.stringify({ id, argv }) + '\n')
      let out: ReturnType<typeof outcomes>[number] | undefined
      await until(() => (out = outcomes().find(o => o.id === id)) !== undefined, `the owner's outcome of agents ${argv[0]}`, 60_000)
      assert.deepEqual(await view(), before, `agents ${argv[0]} changed neither the visible desk nor the active pane`)
      const parse = (s: string): Record<string, any> => { try { return JSON.parse(s) } catch { return {} } }
      return { ok: out!.status === 0, data: parse(out!.status === 0 ? out!.stdout : out!.stderr), err: out!.stderr.trim() }
    }
    const bellClean = async (what: string): Promise<void> => {
      const items = await bell()
      assert.deepEqual(items.filter(s => commanded.has(s)), [], `the bell has no line for a commanded guia (${what})`)
    }
    const screenOf = (id: string): string => api.slots.readScreen(id).data
    /** The engine's report of the end of a turn (a fake has none): the same signal the engines' reports give. */
    const endTurn = (id: string): void => api.attention.signal(id, 'done')

    /** The owner is a fake with no report of its own: a notice typed into it opens its turn, and the next one waits for that turn to end. The test ends it, as the engine's report would. */
    const noticed = (re: RegExp, what: string, ms = 30_000): Promise<void> => until(() => {
      if (re.test(told())) return true
      if (api.slots.get(A)?.turn === 'busy') endTurn(A)
      return false
    }, what, ms)

    // ---- 1. give the desk `cena` to Atrium: the gesture of the pill menu ----
    const startView = await view()
    await page.locator(`#desk-switch .seg[data-desk="${D2}"]`).click({ button: 'right' })
    await page.waitForSelector('#ctx-menu li')
    await page.locator('#ctx-menu > li', { hasText: /^\s*Dar a mesa a um agente…\s*$/ }).click()
    await page.locator('dialog.picker input').waitFor({ state: 'visible' })
    await page.locator('dialog.picker li.pk-item').filter({ has: page.locator('.pk-label', { hasText: /^Atrium$/ }) }).click()
    await page.locator('dialog.ask[data-dialog="for-agents.give-desk"]').waitFor()
    await page.locator('dialog.ask[data-dialog="for-agents.give-desk"] button.choice[data-choice="give"]').click()
    await until(() => api.objects.get('desk', D2, 'owner') !== undefined, 'the desk owner written')
    assert.deepEqual(api.objects.get<{ owner: string; givenBy: string }>('desk', D2, 'owner')!.owner, A)
    assert.deepEqual(await view(), startView, 'giving the desk changed neither the visible desk nor the active pane')
    // The notices reach the owner by its own pane ("de si").
    await api.objects.set('pane', A, 'owner', { owner: A, since: new Date().toISOString(), givenBy: 'user' })
    await noticed(/você recebeu a mesa/, 'the owner told it received the desk')
    await bellClean('1')

    // ---- 2. list: the desk is there, with no guias yet ----
    const first = await verb('list')
    assert.ok(first.ok, first.err)
    const desks = (first.data.desks as { id: string; panes: { type: string }[] }[]).map(d => ({ ...d, panes: d.panes.filter(p => p.type !== 'empty') }))
    assert.equal(desks.find(d => d.id === D2)?.panes.length, 0, `cena has no guias: ${JSON.stringify(first.data)}`)

    // ---- 3. open three guias ----
    const open = async (name: string, dir: string): Promise<string> => {
      mkdirSync(join(bench, dir), { recursive: true })
      const r = await verb('open', 'soul', join(bench, dir), '--name', name)
      assert.ok(r.ok, `open ${name}: ${r.err}`)
      const id = String(r.data.pane)
      commanded.add(id)
      await page.waitForFunction(p => window.__tether.panelIds().includes(p), id)
      await until(() => screenOf(id).includes('READY'), `READY in ${name}`)
      return id
    }
    const P1 = await open('fake · conferente', 'c1')
    const P2 = await open('fake · bancada', 'c2')
    const P3 = await open('fake · cartão', 'c3')
    assert.deepEqual(await view(), startView, 'opening three guias changed neither the visible desk nor the active pane')
    await bellClean('3')

    // ---- 4. send and the finish notice ----
    const s1 = await verb('send', P1, 'pedido um')
    assert.ok(s1.ok, s1.err)
    assert.ok(['typed', 'inside'].includes(String(s1.data.state)), `state ${JSON.stringify(s1.data)}`)
    await until(() => /RESP 1: .*pedido um/.test(screenOf(P1)), 'the fake answered')
    assert.match(screenOf(P1), /de Atrium \(owner\)|pedido um/, 'the request reached the guia')
    endTurn(P1)
    await noticed(new RegExp(`terminou · guia ${P1}`), 'the finish notice at the owner')
    await bellClean('4')

    // ---- 5. last-answer and read-screen ----
    const la = await verb('last-answer', P1)
    assert.ok(la.ok, la.err)
    assert.match(String(la.data.text), /RESP 1/)
    assert.equal(la.data.source, 'hook')
    const rs = await verb('read-screen', P1)
    assert.ok(rs.ok, rs.err)
    assert.match(JSON.stringify(rs.data), /RESP 1/)
    await bellClean('5')

    // ---- 6. the permission card: the owner is told, answers ----
    const s3 = await verb('send', P3, 'cria o arquivo')
    assert.ok(s3.ok, s3.err)
    await noticed(new RegExp(`pede permissão · guia ${P3}`), 'the permission request at the owner', 45_000)
    assert.match(told(), /Opções: yes · always · no/)
    const card = await verb('read-screen', P3)
    assert.equal(card.data.state, 'permission')
    const yes = await verb('answer', P3, 'yes')
    assert.ok(yes.ok, yes.err)
    await until(() => /CARD CLOSED: yes/.test(screenOf(P3)), 'the card closed by the answer')
    endTurn(P3)
    await noticed(new RegExp(`terminou · guia ${P3}`), 'the finish notice of the card guia')
    await bellClean('6')

    // ---- 7. the person takes `fake · bancada` by typing; the owner's send is queued; she gives it back ----
    await page.evaluate(id => window.__tether.switchDesk(id), D2)
    await page.waitForFunction(() => window.__tether.activeDesk() === 'desk-2')
    const tab = page.locator(`.tether-tab[data-slot="${P2}"]`)
    await tab.click()
    const term = page.locator(`.panel[data-slot-id="${P2}"] .panel-term`)
    for (let i = 1; api.objects.get('pane', P2, 'hand') === undefined; i++) {
      await term.click()
      await page.keyboard.type('x')
      try { await until(() => api.objects.get('pane', P2, 'hand') !== undefined, 'the hand with the user', 4_000) } catch (e) { if (i === 3) throw e }
    }
    await until(() => (api.objects.get<{ with: string; by: string }>('pane', P2, 'hand')?.with) === 'user', 'the hand with the user')
    assert.equal(api.objects.get<{ by: string }>('pane', P2, 'hand')!.by, 'typing')
    await noticed(/o usuário tomou a guia fake · bancada/, 'the owner told the guia was taken')
    const taken = await view()
    const offset = screenOf(P2).length
    const q = await verb('send', P2, 'pedido depois')
    assert.ok(q.ok, q.err)
    assert.deepEqual([q.data.state, q.data.why], ['queued', 'with-user'])
    const barrier = await verb('list') // a round trip through the owner and the daemon after the send
    assert.ok(barrier.ok, barrier.err)
    assert.equal(screenOf(P2).length, offset, 'the guia got no byte from the tether while with the user')
    assert.doesNotMatch(screenOf(P2), /pedido depois/)
    assert.deepEqual(await view(), taken)
    await page.keyboard.press('Backspace')
    await tab.click({ button: 'right' })
    await page.waitForSelector('#ctx-menu li')
    await page.locator('#ctx-menu > li', { hasText: /^\s*Devolver a Atrium\s*$/ }).click()
    await until(() => api.objects.get('pane', P2, 'hand') === undefined, 'the hand given back')
    await noticed(/o usuário devolveu a guia fake · bancada/, 'the owner told the guia was given back')
    await until(() => /RESP 1: pedido depois|pedido depois/.test(screenOf(P2)), 'the queued message typed after the give back', 45_000)
    await until(() => /RESP 1: .*pedido depois/.test(screenOf(P2)), 'the fake answered the message that waited')
    endTurn(P2)
    await noticed(new RegExp(`terminou · guia ${P2}`), 'the finish notice of the guia that waited')
    await page.evaluate(id => window.__tether.switchDesk(id), D1)
    await bellClean('7')

    // ---- 8. list at the end: three guias commanded, nothing pending ----
    const last = await verb('list')
    const panes = (last.data.desks as { id: string; panes: { id: string; relation: string }[] }[]).find(d => d.id === D2)!.panes
    assert.deepEqual(panes.map(p => p.relation).sort(), ['command', 'command', 'command'])
    assert.deepEqual([...last.data.panes ?? []].filter((p: any) => p.pending), [])
    await sleep(0)
  } finally {
    if (app) await killElectron(app, root).catch(() => {})
    list.splice(0, list.length, ...setAside)
    probe.dispose()
    await daemon.close().catch(() => {})
    await removeHome(home)
  }
})
