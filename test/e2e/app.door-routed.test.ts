// E2E of the extensions' object data and of the mark of an attention routed to an agent owner (agent door, slice R6), with the
// door-probe extension (TETHER_TEST_EXTENSIONS=1): a tetherd in this process on a private home and pipe, the real app on the
// same pipe, hidden window. No LLM: the "agents" are `soul` slots whose adapter is a fake that only stays alive (its turns come
// from events the test appends, as in test/unit/daemon.door-attention.test.ts).
//   1. objects: a `set` in the renderer reaches tetherd and comes back to Electron main; a `set` in the daemon reaches both
//      mirrors; a delete goes the same way;
//   2. a tab whose attention was routed to an owner shows the diamond in the owner's colour, apart from the common attention tab
//      (the orange dot); the pill counts only the common one and the bell (the attention history main keeps) hears only it;
//   3. looking at the routed pane does not send `seen` to the daemon (the attention for the owner stays), looking at the common
//      one does. With TETHER_ROUTED_PRINTS set to a folder, two prints (light and dark theme) go there.
// Every kill goes through test/kill.ts (pid + creation time); the daemon here is closed in-process.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { agentHue } from '../../app/shared/agent-color.ts'
import { DisposableStore } from '../../app/shared/vscode-lifecycle.ts'
import type { AgentAdapter, LaunchPlan } from '../../src/agents/types.ts'
import { slotEventsPath } from '../../src/core/paths.ts'
import { DoorHost } from '../../src/daemon/door/host.ts'
import { startDaemon } from '../../src/daemon/server.ts'
import { removeHome, tempHome, uniquePipe, waitUntil } from '../unit/daemon.helpers.ts'
import { killElectron } from './electron.ts'

type Hooks = {
  activeDesk(): string
  switchDesk(id: string): void
  openSlot(id: string): void
  activate(id: string): void
  ext: Record<string, Record<string, unknown>>
}
type Heard = { kind: string; id: string; key: string; value?: unknown }
type AttentionItem = { slotId: string; kind: string }
type Probe = { main: { objects: { get(kind: string, id: string, key: string): unknown; entries(kind: string, key: string): [string, unknown][] } }; heard: Heard[] }
declare const window: { __tether: Hooks; tether: { attentionGet(): Promise<{ items: AttentionItem[] }> }; dispatchEvent(e: unknown): void }
declare const document: { hasFocus: () => boolean; documentElement: { dataset: Record<string, string> } }
declare const Event: new (type: string) => unknown

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const STAY = ["process.stdout.write('READY\\r\\n')", 'setInterval(() => {}, 1000)'].join('\n')

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

const probe = <T>(page: Page, name: string, ...args: unknown[]): Promise<T> =>
  page.evaluate(({ name, args }) => (window.__tether.ext['door-probe']![name] as unknown as (...a: unknown[]) => unknown)(...args) as never, { name, args })
const mainObj = <T>(app: ElectronApplication, kind: string, id: string, key: string): Promise<T> =>
  app.evaluate((_e, a) => (globalThis as unknown as { __doorProbe?: Probe }).__doorProbe!.main.objects.get(a.kind, a.id, a.key) as never, { kind, id, key })
const mainEntries = <T>(app: ElectronApplication, kind: string, key: string): Promise<[string, T][]> =>
  app.evaluate((_e, a) => (globalThis as unknown as { __doorProbe?: Probe }).__doorProbe!.main.objects.entries(a.kind, a.key) as never, { kind, key })
const tabOf = (page: Page, id: string) => page.locator(`.tether-tab[data-slot="${id}"]`)
const pill = (page: Page, desk: string) => page.locator(`#desk-switch .seg[data-desk="${desk}"]`)
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
/** waitUntil for a condition that is asked asynchronously (the app's side). */
async function until(cond: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const end = Date.now() + timeoutMs
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timeout: ${what}`)
    await sleep(100)
  }
}

test('door routed: object data in both hosts and the mark of an attention for the owner', { timeout: 420_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit', env: { ...process.env, TETHER_TEST_EXTENSIONS: '1' } })
  assert.equal(build.status, 0, 'app build failed')
  const home = tempHome()
  const pipe = uniquePipe(home)
  const logs: string[] = [] // the daemon's log lines, kept to read when a step fails
  writeFileSync(join(home, 'stay.cjs'), STAY)
  const fake: AgentAdapter = {
    name: 'soul',
    plan: (input): LaunchPlan => {
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
      delete env.NODE_TEST_CONTEXT
      return { command: process.execPath, args: [join(home, 'stay.cjs')], cwd: input.resume?.cwd ?? input.slot.cwd, env }
    },
    sessionExists: async () => 'unknown',
    title: async b => b.title,
  }
  const door = new DoorHost({ log: m => logs.push(m) })
  const own = new DisposableStore()
  const daemon = await startDaemon({ home, pipe, memoryIntervalMs: 0, readyFallbackMs: 60_000, minAgentAgeMs: 0, adapters: { soul: fake }, door, log: m => logs.push(m) })
  const api = door.apiFor('door-probe', own)
  const turn = (id: string, state: 'busy' | 'idle'): void =>
    appendFileSync(slotEventsPath(home, id), JSON.stringify({ v: 1, ts: new Date().toISOString(), slotId: id, agent: 'soul', kind: 'turn', source: 'turn', state, sessionId: 'sess-1', cwd: home }) + '\n')
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home, pipe))
    page.on('console', m => { if (m.type() === 'error') console.error(`renderer console: ${m.text()}`) })

    // ---- 1. objects: renderer -> daemon -> main, and daemon -> both ----
    await until(async () => (await app!.evaluate(() => !!(globalThis as unknown as { __doorProbe?: Probe }).__doorProbe)) === true, 20_000, 'the probe is active in main')
    await probe(page, 'objSet', 'pane', 'claude-9', 'dono', { slot: 'claude-1', n: 1 })
    assert.deepEqual(api.objects.get('pane', 'claude-9', 'dono'), { slot: 'claude-1', n: 1 }, 'the renderer set reached tetherd')
    await until(async () => JSON.stringify(await mainObj(app!, 'pane', 'claude-9', 'dono')) === JSON.stringify({ slot: 'claude-1', n: 1 }), 10_000, 'the value came back to main')
    assert.deepEqual(await probe(page, 'objGet', 'pane', 'claude-9', 'dono'), { slot: 'claude-1', n: 1 }, 'and the renderer mirror has it')

    await api.objects.set('desk', 'desk-1', 'canal', 'obras')
    await until(async () => (await mainObj(app!, 'desk', 'desk-1', 'canal')) === 'obras', 10_000, 'the daemon set reached main')
    await until(async () => (await probe(page, 'objGet', 'desk', 'desk-1', 'canal')) === 'obras', 10_000, 'the daemon set reached the renderer')
    assert.deepEqual(await probe(page, 'objEntries', 'desk', 'canal'), [['desk-1', 'obras']])
    assert.deepEqual(await mainEntries(app, 'desk', 'canal'), [['desk-1', 'obras']])

    await probe(page, 'objSet', 'desk', 'desk-1', 'canal', undefined)
    assert.equal(api.objects.get('desk', 'desk-1', 'canal'), undefined, 'the delete reached tetherd')
    await until(async () => (await mainObj(app!, 'desk', 'desk-1', 'canal')) === undefined, 10_000, 'the delete reached main')
    assert.deepEqual(await mainEntries(app, 'desk', 'canal'), [])
    const heard = await probe<Heard[]>(page, 'objHeard')
    assert.ok(heard.some(e => e.kind === 'desk' && e.key === 'canal' && e.value === undefined), 'the renderer heard the removal')
    const heardMain = await app.evaluate(() => (globalThis as unknown as { __doorProbe?: Probe }).__doorProbe!.heard)
    assert.ok(heardMain.some(e => e.kind === 'desk' && e.key === 'canal' && e.value === 'obras'), 'main heard the change')

    // ---- 2. the routed tab, the common attention tab, the pill and the bell ----
    await page.keyboard.press('Control+Shift+N') // a second desk: the pill strip shows
    await page.waitForFunction(() => window.__tether.activeDesk() === 'desk-2')
    await page.evaluate(() => window.__tether.switchDesk('desk-1'))
    await page.waitForFunction(() => window.__tether.activeDesk() === 'desk-1')
    const ownerId = (await api.slots.create({ kind: 'soul', cwd: home, name: 'Atrium' })).slotId
    const workerId = (await api.slots.create({ kind: 'soul', cwd: home, name: 'soul testes' })).slotId
    const commonId = (await api.slots.create({ kind: 'soul', cwd: home, name: 'soul comum' })).slotId
    for (const id of [ownerId, workerId, commonId]) await waitUntil(() => api.slots.readScreen(id).data.includes('READY'), 30_000, `READY in ${id}`)

    await api.attention.route(workerId, ownerId)
    turn(workerId, 'busy'); turn(commonId, 'busy')
    await waitUntil(() => api.slots.get(workerId)?.turn === 'busy' && api.slots.get(commonId)?.turn === 'busy', 15_000, 'both are busy')
    await sleep(1500)
    turn(workerId, 'idle'); turn(commonId, 'idle')
    await waitUntil(() => api.slots.get(workerId)?.attentionFor !== undefined && api.slots.get(commonId)?.attention === 'done', 15_000, `attentionFor and attention show (worker ${JSON.stringify(api.slots.get(workerId))}, common ${JSON.stringify(api.slots.get(commonId))})`)
    assert.equal(api.slots.get(workerId)!.attention, undefined, 'a routed slot has no attention for the person')

    // The panes open now: the app learns the states from the daemon (a turn report the daemon gets after the app attached to a
    // soul slot is not applied in this setup, so the turns come first).
    // Nobody is looking until step 3 (the page says its window has no focus): no attention is seen while the panes open.
    await page.evaluate(() => { document.hasFocus = () => false })
    for (const id of [commonId, ownerId, workerId]) await page.evaluate(id => window.__tether.openSlot(id), id)
    for (const id of [ownerId, workerId, commonId]) await tabOf(page, id).waitFor()

    const hue = agentHue(ownerId)
    await tabOf(page, workerId).locator('.attn.routed').waitFor()
    await tabOf(page, commonId).locator('.attn.done').waitFor()
    const routed = tabOf(page, workerId).locator('.attn')
    assert.equal(await routed.evaluate(el => (el as HTMLElement).style.getPropertyValue('--attn-hue')), String(hue), 'the diamond takes the hue of the owner')
    assert.match((await routed.getAttribute('title')) ?? '', /^Terminou, para Atrium/, 'the tooltip names the owner')
    assert.ok(await routed.evaluate(el => getComputedStyle(el).transform !== 'none'), 'the mark is a rotated square: a diamond, not a dot')
    assert.equal(await routed.evaluate(el => (el as HTMLElement).dataset.mark), 'routed')
    assert.equal(await tabOf(page, workerId).locator('.attn.done, .attn.waiting, .attn.attention').count(), 0, 'not the orange mark')
    assert.equal(await tabOf(page, commonId).locator('.attn.routed').count(), 0, 'the common attention keeps the orange dot')
    const orange = await tabOf(page, commonId).locator('.attn').evaluate(el => getComputedStyle(el).backgroundColor)
    const diamond = await routed.evaluate(el => getComputedStyle(el).backgroundColor)
    assert.notEqual(orange, diamond, 'the two marks do not share a colour')

    // The panel's status bar: the diamond and the bell in the owner's colour, not the orange.
    const headBell = page.locator('.status-bar .bell.routed')
    await headBell.waitFor({ state: 'attached' })
    assert.equal(await headBell.count(), 1, 'only the routed panel has the owner-coloured bell')
    assert.equal(await headBell.evaluate(el => (el as HTMLElement).style.getPropertyValue('--attn-hue')), String(hue), 'the bell takes the hue of the owner')
    assert.match((await headBell.getAttribute('title')) ?? '', /^Terminou, para Atrium/, 'the bell names the owner')
    assert.ok(await headBell.locator('.diamond').evaluate(el => getComputedStyle(el).transform !== 'none'), 'the status bar shows the diamond')
    assert.equal(await headBell.evaluate(el => el.classList.contains('done') || el.classList.contains('waiting')), false, 'not the orange bell')

    // The pill counts the common one only.
    await pill(page, 'desk-1').locator('.desk-badge').waitFor()
    assert.equal(await pill(page, 'desk-1').locator('.desk-badge').innerText(), '1', 'the orange count is 1: the routed attention is not counted')

    // The bell: the history of attention main keeps hears the common slot (the control), never the routed one.
    const bell = (): Promise<AttentionItem[]> => page.evaluate(() => window.tether.attentionGet().then(s => s.items))
    await until(async () => (await bell()).some(i => i.slotId === commonId), 15_000, 'the common attention reached the bell')
    await sleep(1500)
    assert.deepEqual((await bell()).map(i => i.slotId), [commonId], 'the bell heard the common attention only')

    // ---- the prints: the strip and the tabs, in both themes ----
    const dir = process.env.TETHER_ROUTED_PRINTS
    if (dir) {
      mkdirSync(dir, { recursive: true })
      for (const scheme of ['light', 'dark'] as const) {
        await page.evaluate(s => { document.documentElement.dataset.theme = s }, scheme)
        await sleep(300)
        const strip = (await page.locator('#desk-switch').boundingBox())!
        const tabs = await Promise.all([ownerId, workerId, commonId].map(id => tabOf(page, id).boundingBox()))
        const bottom = Math.max(...tabs.map(t => t!.y + t!.height)) + 12
        const top = Math.max(0, Math.min(strip.y, ...tabs.map(t => t!.y)) - 8)
        await page.screenshot({ path: join(dir, `r6-atencao-desviada-${scheme}.png`), clip: { x: 0, y: top, width: 1100, height: bottom - top } })
      }
    }

    // ---- 3. looking at the pane: `seen` goes for the common attention, not for the one that waits for the owner ----
    // The person looks: the page says its window has the focus, and the window "comes back" as the user's focus would.
    await page.evaluate(() => { document.hasFocus = () => true })
    await page.evaluate(id => window.__tether.activate(id), workerId)
    await page.evaluate(() => { window.dispatchEvent(new Event('focus')) })
    await sleep(1500)
    assert.equal(api.slots.get(workerId)!.attentionFor?.slotId, ownerId, 'looking at the routed pane did not send `seen`: the attention still waits for the owner')
    assert.equal(api.slots.get(commonId)!.attention, 'done', 'the common attention is still there (its pane was not looked at)')
    await page.evaluate(id => window.__tether.activate(id), commonId)
    await page.evaluate(() => { window.dispatchEvent(new Event('focus')) })
    await waitUntil(() => api.slots.get(commonId)!.attention === undefined, 15_000, 'looking at the common pane sent `seen` (the control)')
    assert.equal(api.slots.get(workerId)!.attentionFor?.slotId, ownerId, 'the routed attention is untouched')
  } finally {
    own.dispose()
    if (app) await killElectron(app, root).catch(() => {})
    await daemon.close()
    await removeHome(home)
  }
})
