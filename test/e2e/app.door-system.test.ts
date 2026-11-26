// E2E of the S5 seams the Regency's System uses (slice R5a), through the door probe (hidden window, private home, pipe and
// user dir, an in-process tetherd, no agent process ever started: the claude slot is created with start: false):
//   1. ronda: on, reassembled with a criterion, off refused without force (ronda-criterion), off with force; the pane's
//      ronda follows by event; a shell answers ronda-unavailable;
//   2. profiles: the list carries env names and never a value; a save is heard by event; "Duplicar" opens the editor on a copy;
//   3. status icons as data, and show() opens an icon's popover;
//   4. peekNew: a process pane with no tab opens in the card and not in the layout; "Abrir nesta mesa" makes that pane (same
//      id) a tab; from another desk peekNew lends the tab; a wrong id or type is refused.
// Run alone: node --test --test-force-exit --test-concurrency=1 test/e2e/app.door-system.test.ts   (the build is remade)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import type { Reply, SlotState } from '../../src/daemon/protocol.ts'
import { startDaemon } from '../../src/daemon/server.ts'
import { removeHome, tempHome, uniquePipe } from '../unit/daemon.helpers.ts'
import { killElectron } from './electron.ts'

type PeekState = { open: boolean; screen?: string; screenType?: string; pane?: string }
type Hooks = {
  ext: Record<string, Record<string, unknown>>
  panelIds(): string[]
  slots(): SlotState[]
  activeDesk(): string
  createDesk(side: 'before' | 'after', relativeTo?: string): string
  switchDesk(id: string): void
  peekState(): PeekState
}
declare const window: { __tether: Hooks; tether: { request(body: unknown): Promise<Reply> } }
declare const document: { querySelector(s: string): { value?: string } | null; querySelectorAll(s: string): { length: number } }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const SECRET = 'valor-secreto-r5a'

async function launch(home: string, pipe: string, userDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_') && !k.toUpperCase().startsWith('CLAUDE')) env[k] = v
  env.TETHER_PIPE = pipe
  env.TETHER_HOME = home
  env.TETHER_USER_DIR = userDir
  env.TETHER_E2E_HIDDEN = '1'
  delete env.TETHER_CLAUDE_ARGS
  delete env.NODE_TEST_CONTEXT
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  page.on('pageerror', e => console.error(`renderer error: ${e.stack}`))
  page.on('console', m => { if (m.type() === 'error') console.error(`renderer console: ${m.text()}`) })
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  return { app, page }
}

const probe = <T>(page: Page, name: string, ...args: unknown[]): Promise<T> =>
  page.evaluate(({ name, args }) => (window.__tether.ext['door-probe']![name] as unknown as (...a: unknown[]) => unknown)(...args) as never, { name, args })
const ask = (page: Page, body: unknown): Promise<Reply> => page.evaluate(b => window.tether.request(b), body)
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
async function until(cond: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const end = Date.now() + timeoutMs
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timeout: ${what}`)
    await sleep(100)
  }
}
type Answer = { ok: boolean; code?: string; message?: string; outcome?: string; ronda?: { intervalMs: number; criterion?: string } }
type Ronda = { intervalMs: number; nextAt: string; criterion?: string } | null

test('door system seams: ronda, profiles, status icons and peekNew', { timeout: 400_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit', env: { ...process.env, TETHER_TEST_EXTENSIONS: '1' } })
  assert.equal(build.status, 0, 'app build failed')
  const home = tempHome()
  const pipe = uniquePipe(home)
  const userDir = join(home, 'user-dir')
  mkdirSync(userDir, { recursive: true })
  const logs: string[] = []
  const daemon = await startDaemon({ home, pipe, memoryIntervalMs: 0, readyFallbackMs: 60_000, minAgentAgeMs: 0, log: m => logs.push(m) })
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home, pipe, userDir))
    await page.waitForFunction(() => typeof window.__tether.ext?.['door-probe']?.sysRonda === 'function')
    const deskOne = await page.evaluate(() => window.__tether.activeDesk())

    // ---- 1. ronda ----
    console.log('step 1')
    const made = await ask(page, { t: 'create', kind: 'claude', cwd: home, name: 'SondaRonda', start: false, desk: deskOne })
    assert.equal(made.t, 'ok', JSON.stringify(made))
    const agent = (made as { slot: SlotState }).slot.slotId
    await page.waitForFunction(id => window.__tether.panelIds().includes(id), agent)
    assert.equal(await probe<Ronda>(page, 'sysRonda', agent), null, 'no ronda yet')
    const on = await probe<Answer>(page, 'sysSetRonda', agent, { interval: '10m' })
    assert.equal(on.ok, true, JSON.stringify(on))
    assert.equal(on.outcome, 'created')
    assert.equal(on.ronda?.intervalMs, 600_000)
    await until(async () => (await probe<Ronda>(page, 'sysRonda', agent))?.intervalMs === 600_000, 10_000, 'the pane carries the ronda')
    const re = await probe<Answer>(page, 'sysSetRonda', agent, { interval: '1h', criterion: 'testes verdes' })
    assert.equal(re.outcome, 'updated')
    await until(async () => (await probe<Ronda>(page, 'sysRonda', agent))?.criterion === 'testes verdes', 10_000, 'the reassembled ronda')
    assert.equal((await probe<Ronda>(page, 'sysRonda', agent))?.intervalMs, 3_600_000)
    const bad = await probe<Answer>(page, 'sysSetRonda', agent, { interval: 'logo' })
    assert.equal(bad.ok, false)
    assert.equal(bad.code, 'bad-request', 'a bad interval is a refusal with a sentence')
    const refused = await probe<Answer>(page, 'sysOffRonda', agent, false)
    assert.equal(refused.ok, false)
    assert.equal(refused.code, 'ronda-criterion', 'a criterion asks first, as the CLI does')
    assert.match(refused.message ?? '', /testes verdes/)
    assert.ok(await probe<Ronda>(page, 'sysRonda', agent), 'still on after the refusal')
    const off = await probe<Answer>(page, 'sysOffRonda', agent, true)
    assert.equal(off.outcome, 'off')
    await until(async () => (await probe<Ronda>(page, 'sysRonda', agent)) === null, 10_000, 'the pane lost its ronda')
    const heard = (await probe<{ slotId: string; ronda: Ronda }[]>(page, 'sysRondaHeard')).filter(h => h.slotId === agent)
    assert.ok(heard.some(h => h.ronda?.intervalMs === 600_000) && heard.some(h => h.ronda?.criterion === 'testes verdes') && heard.at(-1)!.ronda === null, `heard by event (${JSON.stringify(heard)})`)
    assert.equal((await probe<Answer>(page, 'sysOffRonda', agent, false)).outcome, 'was-off')
    const shell = await ask(page, { t: 'create', kind: 'shell', cwd: home, name: 'SondaShell', start: false })
    const unavailable = await probe<Answer>(page, 'sysSetRonda', (shell as { slot: SlotState }).slot.slotId, { interval: '10m' })
    assert.equal(unavailable.code, 'ronda-unavailable')
    assert.equal(page.isClosed(), false)
    assert.equal((await page.evaluate(id => window.__tether.slots().find(s => s.slotId === id)?.status, agent)) !== 'running', true, 'no agent process was started')

    // ---- 2. profiles ----
    console.log('step 2')
    const heardBefore = await probe<number>(page, 'sysProfilesHeard')
    const saved = await ask(page, { t: 'profile-save', profile: { name: 'Sonda R5a', agent: 'claude', args: [], env: { SONDA_TOKEN: SECRET, SONDA_DIR: 'C:/x' } } })
    assert.equal(saved.t, 'ok', JSON.stringify(saved))
    const pid = (saved as { profile: { id: string } }).profile.id
    await until(async () => (await probe<{ id: string }[]>(page, 'sysProfiles')).some(p => p.id === pid), 10_000, 'the new profile listed')
    assert.ok((await probe<number>(page, 'sysProfilesHeard')) > heardBefore, 'heard by event')
    const views = await probe<{ id: string; envNames: string[]; agent: string }[]>(page, 'sysProfiles')
    const view = views.find(p => p.id === pid)!
    assert.deepEqual(view.envNames, ['SONDA_DIR', 'SONDA_TOKEN'])
    assert.equal(view.agent, 'claude')
    assert.equal(JSON.stringify(views).includes(SECRET), false, 'no env value reaches the extension')
    assert.equal(JSON.stringify(views).includes('C:/x'), false)
    await probe(page, 'sysEditProfile', pid, true)
    await page.waitForSelector('#dlg-profiles[open]')
    assert.equal(await page.evaluate(() => (document.querySelector('#form-profile [name="name"]') as { value?: string } | null)?.value), 'Sonda R5a (cópia)', 'the editor starts a copy')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => document.querySelectorAll('#dlg-profiles[open]').length === 0)

    // ---- 3. status icons ----
    console.log('step 3')
    const items = await probe<{ id: string; title: string; state: string }[]>(page, 'sysStatus')
    assert.ok(items.length > 0, 'the bar has icons')
    assert.ok(items.every(i => typeof i.title === 'string' && typeof i.state === 'string'))
    const first = items[0]!.id
    assert.equal(await probe<boolean>(page, 'sysStatusShow', first), true)
    await page.waitForSelector(`.status-wrap[data-status="${first}"].pinned`)
    assert.equal(await probe<boolean>(page, 'sysStatusShow', 'nao.existe'), false)
    await page.keyboard.press('Escape')
    await page.waitForSelector(`.status-wrap[data-status="${first}"]:not(.pinned)`)

    // ---- 4. peekNew ----
    console.log('step 4')
    const pane = 'process:sonda-r5a'
    assert.equal(await probe(page, 'sysPeekNew', 'process', { id: pane, params: { name: 'sonda-r5a' } }), pane)
    await page.waitForFunction(id => window.__tether.peekState().screen === id, pane)
    assert.equal((await page.evaluate(() => window.__tether.peekState())).screenType, 'process')
    assert.equal((await page.evaluate(() => window.__tether.panelIds())).includes(pane), false, 'in the card, not in the layout')
    assert.equal(await probe(page, 'sysPeekNew', 'process', { id: pane, params: { name: 'sonda-r5a' } }), pane, 'the same id again: the one in the card')
    assert.equal(await probe(page, 'sysPeekNew', 'process', { id: 'settings:x' }), null, 'an id of another type')
    assert.equal(await probe(page, 'sysPeekNew', 'nao-existe', {}), null, 'an unknown type')
    assert.equal(await probe(page, 'sysPeekNew', 'terminal', { id: 'x' }), null, 'a type with a slot')
    await page.click('#peek .peek-open')
    await page.waitForFunction(id => window.__tether.panelIds().includes(id), pane)
    await page.waitForFunction(() => !window.__tether.peekState().open)
    const deskTwo = await page.evaluate(() => window.__tether.createDesk('after'))
    await page.evaluate(id => window.__tether.switchDesk(id), deskTwo)
    await sleep(300)
    assert.equal(await probe(page, 'sysPeekNew', 'process', { id: pane, params: { name: 'sonda-r5a' } }), pane)
    await page.waitForFunction(id => window.__tether.peekState().pane === id, pane)
    assert.equal(await page.evaluate(() => window.__tether.activeDesk()), deskTwo, 'the person stays on her desk')
  } finally {
    if (app) await killElectron(app, root).catch(() => {})
    await daemon.close()
    await removeHome(home)
  }
})
