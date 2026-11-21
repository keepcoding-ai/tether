// E2E of the marks of ownership (tether for agents, slice U1): the for-agents extension draws what `objects` says. A tetherd in
// this process on a private home and pipe (a DoorHost: the test writes the extension's data through the door, as the daemon
// side does), the real app on the same pipe, hidden window. No agent process, no LLM: the agent slots are created without
// starting. Each state of the approved preview is written as data and read back from the screen:
//   - the four pills (section 1): common desk, desk with an owner, another owner, an owner that ended (struck);
//   - the seven tabs (section 2): the owner's crown, commanded by the desk (line), given to another (letter + eye), "de si"
//     (letter + arrow), waiting for the owner (nothing of its own), the owner ended (struck letter), taken (the hand);
//   - the status bar line of a commanded pane;
//   - nothing counts in the orange, no tab is activated and the visible desk does not change; taking the data away takes
//     the mark away; turning the extension off takes everything.
// With TETHER_U1_PRINTS set to a folder, the pills, the tabs and the status bar go there in the light and the dark theme.
// Every kill goes through test/kill.ts (pid + creation time); the daemon here is closed in-process.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { agentHue } from '../../app/shared/agent-color.ts'
import { DisposableStore } from '../../app/shared/vscode-lifecycle.ts'
import type { AgentAdapter, LaunchPlan } from '../../src/agents/types.ts'
import { DoorHost } from '../../src/daemon/door/host.ts'
import { startDaemon } from '../../src/daemon/server.ts'
import { removeHome, tempHome, uniquePipe } from '../unit/daemon.helpers.ts'
import { killElectron } from './electron.ts'

type Hooks = {
  activeDesk(): string
  activeId(): string | undefined
  currentPane(): string | undefined
  switchDesk(id: string): void
  createDesk(side: 'before' | 'after', relativeTo?: string): string
  renameDesk(id: string, name: string): void
  openSlot(id: string): Promise<void>
  openNote(path: string): Promise<void>
  disposeExtension(id: string): void
  ext: Record<string, Record<string, unknown>>
}
declare const window: { __tether: Hooks; innerWidth: number }
type Box = { x: number; y: number; width: number; height: number }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const EXT = 'for-agents'
// The agent process is a fake that only stays alive: no LLM, no real agent.
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

const pill = (page: Page, desk: string) => page.locator(`#desk-switch .seg[data-desk="${desk}"]`)
const tabOf = (page: Page, id: string) => page.locator(`.tether-tab[data-slot="${id}"]`)
const T = new Date(2026, 10, 21, 14, 2).toISOString()
const own = (owner: string, extra: Record<string, unknown> = {}) => ({ owner, since: T, givenBy: 'user', ...extra })

/** What a tab shows of the extension, as plain data. */
const tabMarks = (page: Page, id: string) => tabOf(page, id).evaluate(tab => ({
  emblems: [...tab.querySelectorAll<HTMLElement>(':scope > .ext-emblems > .ext-emblem')].map(e => ({
    cls: e.className.replace('ext-emblem', '').trim(), text: e.textContent?.trim() ?? '', svg: e.querySelectorAll('svg').length, title: e.getAttribute('title') ?? '', hue: e.style.getPropertyValue('--emblem-hue') || e.style.getPropertyValue('--hue'),
  })),
  line: tab.classList.contains('ext-line') ? (tab as HTMLElement).style.getPropertyValue('--line-hue') : null,
  orange: tab.querySelectorAll('.attn.done, .attn.waiting, .attn.attention').length,
}))

test('for-agents marks: the four pills, the seven tabs and the status bar line, from the data', { timeout: 420_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit', env: { ...process.env, TETHER_TEST_EXTENSIONS: '1' } })
  assert.equal(build.status, 0, 'app build failed')
  const home = tempHome()
  const pipe = uniquePipe(home)
  const logs: string[] = []
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
  const daemon = await startDaemon({ home, pipe, memoryIntervalMs: 0, readyFallbackMs: 500, minAgentAgeMs: 0, adapters: { soul: fake }, door, log: m => logs.push(m) })
  const api = door.apiFor(EXT, new DisposableStore())
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home, pipe))
    page.on('console', m => { if (m.type() === 'error') console.log(m.type(), m.text()) })
    // Wide enough for the four pills (a narrow window folds the last ones into the "+N" menu).
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(1600, 900) })
    await page.waitForFunction(() => window.innerWidth >= 1500)
    const probe = <R>(name: string, ...args: unknown[]): Promise<R> =>
      page.evaluate(({ name, args }) => (window.__tether.ext['door-probe']![name] as unknown as (...a: unknown[]) => unknown)(...args) as never, { name, args })
    const set = (kind: 'desk' | 'pane', id: string, key: string, value: unknown): Promise<void> => api.objects.set(kind, id, key, value)

    // ---- the layout: four desks (kai-aware, geral, bancada, migração), the seven tabs in the first ----
    await page.keyboard.press('Control+Shift+N')
    await page.waitForFunction(() => window.__tether.activeDesk() === 'desk-2')
    await page.keyboard.press('Control+Shift+N')
    await page.waitForFunction(() => window.__tether.activeDesk() === 'desk-3')
    await page.keyboard.press('Control+Shift+N')
    await page.waitForFunction(() => window.__tether.activeDesk() === 'desk-4')
    const KAI_AWARE = 'desk-1', GERAL = 'desk-2', BANCADA = 'desk-3', MIGRACAO = 'desk-4'
    for (const [id, name] of [[KAI_AWARE, 'kai-aware'], [GERAL, 'geral'], [BANCADA, 'bancada'], [MIGRACAO, 'migração']] as const) await page.evaluate(({ id, name }) => window.__tether.renameDesk(id, name), { id, name })

    const slot = async (name: string): Promise<string> => (await api.slots.create({ kind: 'soul', cwd: home, name, start: false })).slotId
    // The daemon starts three agents at a time and queues the rest; a short ready fallback lets the queue drain.
    const owner = await slot('Atrium'), commanded = await slot('soul · bancada'), given = await slot('codex · conferência')
    const kai = await slot('Kai'), waiting = await slot('soul · testes'), forgotten = await slot('codex · migração')
    const common = await slot('soul comum')
    const notePath = join(home, 'browser-admin.md')
    writeFileSync(notePath, '# admin\n')

    await page.evaluate(id => window.__tether.switchDesk(id), BANCADA)
    await page.waitForFunction(() => window.__tether.activeDesk() === 'desk-3')
    await page.evaluate(id => window.__tether.openSlot(id), common)
    await tabOf(page, common).waitFor()
    await page.evaluate(id => window.__tether.switchDesk(id), KAI_AWARE)
    await page.waitForFunction(() => window.__tether.activeDesk() === 'desk-1')
    const seven = [owner, commanded, given, kai, waiting, forgotten]
    for (const id of seven) { await page.evaluate(id => window.__tether.openSlot(id), id); await tabOf(page, id).waitFor() }
    await page.evaluate(p => window.__tether.openNote(p), notePath)
    const noteTab = page.locator('.tether-tab.note', { hasText: 'browser-admin' })
    await noteTab.waitFor()
    const note = (await noteTab.getAttribute('data-slot'))!

    // The status bar of the pane that will carry the line: closed, as it starts. The extension does not open it.
    await tabOf(page, waiting).click()
    const bar = page.locator(`.panel[data-slot-id="${waiting}"] .status-bar`)
    const detailsOpen = (): Promise<boolean> => page.evaluate(id => document.querySelector(`.panel[data-slot-id="${id}"]`)?.getAttribute('data-details') === 'true', waiting)
    assert.equal(await detailsOpen(), false, 'the status bar starts closed')

    // An orange count the marks must not touch: one attention on the common pane of "bancada".
    await probe('raiseAttention', common)
    await pill(page, BANCADA).locator('.desk-badge').waitFor()
    const count = (desk: string): Promise<string | null> => pill(page, desk).locator('.desk-badge').count().then(n => n === 0 ? null : pill(page, desk).locator('.desk-badge').innerText())
    assert.equal(await count(BANCADA), '1')

    const before = { desk: await page.evaluate(() => window.__tether.activeDesk()), active: await page.evaluate(() => window.__tether.activeId()), current: await page.evaluate(() => window.__tether.currentPane()) }
    assert.equal(before.active, waiting)
    for (const id of [...seven, note]) assert.deepEqual((await tabMarks(page, id)).emblems, [], 'no mark before the data')
    assert.equal(await page.locator('.desk-seal, .ext-line, .ext-head-item').count(), 0, 'nothing of the extension on screen before the data')

    // ---- the data: what the daemon side of the extension writes ----
    await set('desk', KAI_AWARE, 'owner', own(owner))
    await set('desk', BANCADA, 'owner', own(kai))
    await set('desk', MIGRACAO, 'owner', own(owner, { ended: { at: T, name: 'Atrium' } }))
    await set('pane', given, 'owner', own(kai, { givenBy: owner }))
    await set('pane', kai, 'owner', own(kai))
    await set('pane', forgotten, 'owner', own(kai, { ended: { at: T, name: 'Kai' } }))
    await set('pane', note, 'hand', { with: 'user', why: 'taken', by: 'gesture', since: T })
    await set('pane', waiting, 'last', { by: owner, verb: 'send', at: T })

    // ---- section 1: the four pills ----
    await pill(page, KAI_AWARE).locator('.desk-seal').waitFor()
    const seal = (desk: string) => pill(page, desk).locator('.desk-seal')
    const sealOf = (desk: string) => seal(desk).evaluate(el => ({ cls: el.className, name: el.querySelector('.nm')?.textContent ?? '', hue: (el as HTMLElement).style.getPropertyValue('--seal-hue'), svg: el.querySelectorAll('svg').length, outline: getComputedStyle(el).outlineStyle, line: el.querySelector('.nm') ? getComputedStyle(el.querySelector('.nm')!).textDecorationLine : '' }))
    assert.equal(await seal(GERAL).count(), 0, 'geral: a common desk has no seal')
    const solid = await sealOf(KAI_AWARE)
    assert.ok(!solid.cls.includes('struck') && solid.name === 'Atrium' && solid.hue === String(agentHue(owner)) && solid.svg === 1, `kai-aware: the solid seal with the name, in the hue of the owner (${JSON.stringify(solid)})`)
    assert.match((await pill(page, KAI_AWARE).getAttribute('title')) ?? '', /Dono: Atrium/)
    const other = await sealOf(BANCADA)
    assert.ok(other.name === 'Kai' && other.hue === String(agentHue(kai)), `bancada: the seal of the other owner (${JSON.stringify(other)})`)
    await page.waitForFunction(d => !!document.querySelector(`#desk-switch .seg[data-desk="${d}"] .desk-seal.struck`), MIGRACAO)
    const struck = await sealOf(MIGRACAO)
    assert.ok(struck.name === 'Atrium' && struck.outline === 'dashed' && struck.line === 'line-through', `migração: dashed and struck (${JSON.stringify(struck)})`)
    assert.equal(await count(BANCADA), '1', 'the orange count is the same with the seals on the pills')
    for (const d of [KAI_AWARE, GERAL, MIGRACAO]) assert.equal(await count(d), null, `no count appeared on ${d}`)

    // ---- section 2: the seven tabs ----
    await tabOf(page, owner).locator('.ext-emblem').waitFor()
    await tabOf(page, commanded).waitFor()
    await page.waitForFunction(id => document.querySelector(`.tether-tab[data-slot="${id}"]`)?.classList.contains('ext-line') === true, commanded)
    const m = async (id: string) => tabMarks(page, id)
    const crown = await m(owner)
    assert.equal(crown.emblems.length, 1, '1: one emblem on the owner pane')
    assert.ok(crown.emblems[0]!.svg === 1 && crown.emblems[0]!.text === '' && /dono da mesa/.test(crown.emblems[0]!.title), `1: the crown (${JSON.stringify(crown.emblems)})`)
    assert.equal(crown.line, null, '1: no line on the owner pane')
    const inherited = await m(commanded)
    assert.deepEqual(inherited.emblems, [], '2: commanded by the desk: no emblem')
    assert.equal(inherited.line, String(agentHue(owner)), '2: the line in the hue of the owner')
    const givenMarks = await m(given)
    assert.deepEqual(givenMarks.emblems.map(e => [e.text, e.title]), [['K', 'Dono: Kai'], ['', 'Atrium vê']], '3: the letter of Kai and the eye')
    assert.equal(givenMarks.emblems[1]!.svg, 1, '3: the eye is a glyph')
    assert.equal(givenMarks.line, null, '3: the pane beats the desk: no line')
    const self = await m(kai)
    assert.deepEqual(self.emblems.map(e => [e.text, e.title, e.svg]), [['K', 'Kai, de si', 0], ['', 'de si', 1]], '4: the letter and the arrow')
    const waits = await m(waiting)
    assert.deepEqual(waits.emblems, [], '5: nothing of its own on the tab that waits for the owner')
    assert.equal(waits.line, String(agentHue(owner)), '5: it keeps the line of the desk')
    const ended = await m(forgotten)
    assert.equal(ended.emblems.length, 1, '6: one emblem')
    assert.ok(ended.emblems[0]!.cls.includes('struck') && ended.emblems[0]!.text === 'K' && ended.emblems[0]!.title === 'Kai encerrou', `6: the struck letter (${JSON.stringify(ended.emblems)})`)
    assert.equal(ended.line, null, '6: no line')
    const taken = await m(note)
    assert.equal(taken.emblems.length, 1, '7: one emblem')
    assert.ok(taken.emblems[0]!.svg === 1 && /Com você/.test(taken.emblems[0]!.title), `7: the hand (${JSON.stringify(taken.emblems)})`)
    assert.equal(taken.line, null, '7: no line, no colour')
    assert.equal(await tabOf(page, note).locator(':scope > .ext-emblems .ext-emblem').evaluate(el => (el as HTMLElement).style.getPropertyValue('--emblem-hue') + (el as HTMLElement).style.getPropertyValue('--hue')), '', '7: no hue')

    // The status bar line of the commanded pane. The bar stayed closed while the marks came (nothing comes to the front);
    // the person opens it, and the line is there: the owner and the last thing it did.
    assert.equal(await detailsOpen(), false, 'the extension did not open the status bar')
    await tabOf(page, waiting).click({ button: 'right' })
    await page.locator('#ctx-menu li', { hasText: 'Mostrar barra de status' }).click()
    await page.waitForFunction(id => document.querySelector(`.panel[data-slot-id="${id}"]`)?.getAttribute('data-details') === 'true', waiting)
    await page.waitForFunction(id => !document.querySelector(`.panel[data-slot-id="${id}"]`)?.textContent?.includes('Na fila'), waiting, { timeout: 60_000 })
    await page.waitForTimeout(400)
    const item = bar.locator('.ext-head > .ext-head-item')
    await item.waitFor()
    assert.equal(await item.locator('.tx').innerText(), 'Atrium pela mesa · enviou pedido 14:02')
    assert.equal(await item.locator('svg.caret').count(), 1, 'a ▾ that opens the tab menu')
    assert.equal(await bar.locator('.ext-head-item').count(), 1, 'one line in this bar')
    assert.equal(await page.locator(`.panel[data-slot-id="${forgotten}"] .ext-head-item`).count(), 0, 'no line on a pane nobody commands')

    // ---- nothing counts in the orange, nothing is activated, the visible desk does not change ----
    for (const id of [...seven, note]) assert.equal((await m(id)).orange, 0, `${id}: no orange mark`)
    assert.equal(await count(BANCADA), '1', 'the count of the pill is still 1 (the one attention that was the person\'s)')
    assert.deepEqual({ desk: await page.evaluate(() => window.__tether.activeDesk()), active: await page.evaluate(() => window.__tether.activeId()), current: await page.evaluate(() => window.__tether.currentPane()) }, before, 'the visible desk and the active pane did not change')

    // ---- the prints ----
    const dir = process.env.TETHER_U1_PRINTS
    if (dir) {
      mkdirSync(dir, { recursive: true })
      const shot = async (name: string, scheme: string, boxes: Array<Box | null>): Promise<void> => {
        const bs = boxes.filter((b): b is Box => b !== null)
        const x = Math.max(0, Math.min(...bs.map(b => b.x)) - 10), y = Math.max(0, Math.min(...bs.map(b => b.y)) - 8)
        await page.screenshot({ path: join(dir, `u1-${name}-${scheme}.png`), clip: { x, y, width: Math.max(...bs.map(b => b.x + b.width)) + 10 - x, height: Math.max(...bs.map(b => b.y + b.height)) + 8 - y } })
      }
      for (const scheme of ['light', 'dark'] as const) {
        await page.evaluate(s => { document.documentElement.dataset.theme = s }, scheme)
        await page.waitForTimeout(400)
        await shot('1-capsula', scheme, [await page.locator('#desk-switch').boundingBox()])
        await shot('2-abas', scheme, await Promise.all([...seven, note].map(id => tabOf(page, id).boundingBox())))
        await shot('3-barra-de-status', scheme, [await bar.boundingBox()])
      }
    }

    // ---- taking the data away takes the mark away ----
    await set('pane', given, 'owner', undefined)
    await page.waitForFunction(id => !document.querySelector(`.tether-tab[data-slot="${id}"] .ext-emblem`), given)
    await set('pane', note, 'hand', undefined)
    await page.waitForFunction(id => !document.querySelector(`.tether-tab[data-slot="${id}"] .ext-emblem`), note)
    await set('desk', MIGRACAO, 'owner', undefined)
    await page.waitForFunction(d => !document.querySelector(`#desk-switch .seg[data-desk="${d}"] .desk-seal`), MIGRACAO)
    await set('desk', KAI_AWARE, 'owner', undefined)
    await page.waitForFunction(d => !document.querySelector(`#desk-switch .seg[data-desk="${d}"] .desk-seal`), KAI_AWARE)
    await page.waitForFunction(id => !document.querySelector(`.tether-tab[data-slot="${id}"]`)?.classList.contains('ext-line') && !document.querySelector(`.tether-tab[data-slot="${id}"] .ext-emblem`), commanded)
    assert.equal(await bar.locator('.ext-head-item').count(), 0, 'the status bar line went with the owner of the desk')
    assert.equal((await m(owner)).emblems.length, 0, 'the crown went with the desk\'s owner')

    // ---- turning the extension off takes everything ----
    await set('desk', KAI_AWARE, 'owner', own(owner))
    await set('pane', given, 'owner', own(kai, { givenBy: owner }))
    await tabOf(page, given).locator('.ext-emblem').first().waitFor()
    await page.waitForFunction(() => document.querySelectorAll('.desk-seal, .ext-line, .ext-head-item').length > 0)
    await page.evaluate(id => window.__tether.disposeExtension(id), EXT)
    await page.waitForFunction(() => document.querySelectorAll('.ext-emblem, .desk-seal, .ext-line, .ext-head-item').length === 0)
    await set('pane', forgotten, 'hand', { with: 'user', why: 'taken', by: 'gesture', since: T })
    await page.waitForTimeout(400)
    assert.equal(await page.locator('.ext-emblem, .desk-seal, .ext-line, .ext-head-item').count(), 0, 'and data written after it went draws nothing')
  } catch (e) {
    console.error(`daemon log:\n${logs.slice(-20).join('\n')}`)
    throw e
  } finally {
    if (app) await killElectron(app, root).catch(() => {})
    await daemon.close()
    await removeHome(home)
  }
})
