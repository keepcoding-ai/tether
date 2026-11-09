// E2E of the agents the extensions see on both hosts (TetherUi.agents, TetherMain.agents) with the probe test/e2e/fixtures/agents-probe
// (built in with TETHER_TEST_EXTENSIONS=1) and an inert stand-in for the soul (TETHER_SOUL_CMD): hidden window, private home/pipe,
// real tetherd, CLAUDE* stripped.
//   1. the list: the agent pane (kind, name, alive, desk), a plain shell left out, the same slotId in main;
//   2. focus from another desk and from a system desk; false for an unknown slot; a move is a change;
//   3. the agent is stopped: main's onDidExit, the renderer's change (alive false), focus works and nothing restarts it;
//   4. app restart: the same slotId.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import type { SlotState } from '../../src/daemon/protocol.ts'
import type { AgentPane } from '../../app/renderer/agent-panes.ts'
import type { AgentExit, AgentInfo } from '../../app/main/agents.ts'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type Hooks = {
  slots(): SlotState[]
  connection(): { connected: boolean; pid?: number } | undefined
  activeDesk(): string
  desks(): { id: string }[]
  createDesk(side: 'before' | 'after', relativeTo?: string): string
  switchDesk(id: string): void
  movePaneToDesk(slotId: string, deskId: string): void
  openSlot(slotId: string): Promise<void>
  ext: Record<string, Record<string, (...a: never[]) => unknown>>
}
declare const window: { __tether: Hooks; tether: { request(r: unknown): Promise<{ t: string; slot?: SlotState }> } }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-agents-${process.pid}`
const SYS = 'system-desk-probe.main'
const FAKE_SOUL = `"${process.execPath}" -e "setInterval(()=>{},1000)"`

/** The statuses of a slot with a process (a stopped agent with no confirmed session reads "unconfirmed", not "exited"). */
const LIVE = ['running', 'starting', 'queued']
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

async function launch(home: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_') && !k.toUpperCase().startsWith('CLAUDE')) env[k] = v
  env.TETHER_PIPE = pipe
  env.TETHER_HOME = home
  env.TETHER_E2E_HIDDEN = '1'
  env.TETHER_SOUL_CMD = FAKE_SOUL
  delete env.TETHER_CLAUDE_ARGS
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10_000)
  page.on('pageerror', e => console.error(`renderer error: ${e.message}`))
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  return { app, page }
}

const probe = <T>(page: Page, name: string, ...args: unknown[]): Promise<T> =>
  page.evaluate(({ name, args }) => (window.__tether.ext['agents-probe']![name] as unknown as (...a: unknown[]) => unknown)(...args) as never, { name, args })
const list = (page: Page) => probe<AgentPane[]>(page, 'list')
const get = (page: Page, id: string) => probe<AgentPane | null>(page, 'get', id)
const changes = (page: Page) => probe<AgentPane[]>(page, 'changes')
const until = async (what: string, cond: () => Promise<boolean>, ms = 10_000): Promise<void> => {
  const end = Date.now() + ms
  while (!(await cond())) { if (Date.now() > end) throw new Error(`timeout: ${what}`); await sleep(100) }
}
type Probe = { main: { agents: { list(): AgentInfo[] } }; exits: AgentExit[] }
const mainList = (app: ElectronApplication): Promise<AgentInfo[]> => app.evaluate(() => (globalThis as unknown as { __agentsProbe: Probe }).__agentsProbe.main.agents.list())
const mainExits = (app: ElectronApplication): Promise<AgentExit[]> => app.evaluate(() => (globalThis as unknown as { __agentsProbe: Probe }).__agentsProbe.exits)

test('agents: list, focus across desks, exit event, moves and the same slotId after a restart', { timeout: 300_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit', env: { ...process.env, TETHER_TEST_EXTENSIONS: '1' } })
  assert.equal(build.status, 0, 'app build failed')
  const home = mkdtempSync(join(tmpdir(), 'tether-agents-'))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    daemons.push(await claim((await page.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    const [d1] = await page.evaluate(() => window.__tether.desks().map(d => d.id)) as [string]

    // ---- 1. the list ----
    const slotId = await page.evaluate(async cwd => {
      const shell = await window.tether.request({ t: 'create', kind: 'shell', cwd, start: false })
      await window.__tether.openSlot(shell.slot!.slotId)
      const r = await window.tether.request({ t: 'create', kind: 'soul', cwd, name: 'Sonda', start: true })
      await window.__tether.openSlot(r.slot!.slotId)
      return r.slot!.slotId
    }, home)
    await until('the soul runs', async () => (await page.evaluate(() => window.__tether.slots())).find(s => s.slotId === slotId)?.status === 'running', 20_000)
    await until('the pane is listed', async () => (await get(page, slotId)) !== null)
    const first = await list(page)
    assert.equal(first.length, 1, 'the shell is no agent')
    assert.deepEqual(first[0], { slotId, kind: 'soul', name: 'Sonda', alive: true, paneId: slotId, deskId: d1, deskTitle: first[0]!.deskTitle, isSystemDesk: false, inDrawer: false })
    assert.deepEqual(await mainList(app), [{ slotId, kind: 'soul', name: 'Sonda', alive: true }], 'main: the same slotId, no layout')
    assert.ok((await changes(page)).some(c => c.slotId === slotId && c.alive), 'the renderer heard the pane arrive')

    // ---- 2. focus ----
    const d2 = await page.evaluate(d => window.__tether.createDesk('after', d), d1)
    await page.evaluate(([id, to]) => window.__tether.movePaneToDesk(id!, to!), [slotId, d2] as const)
    await until('the move is a change', async () => (await get(page, slotId))?.deskId === d2)
    await page.evaluate(d => window.__tether.switchDesk(d), d1)
    assert.equal(await page.evaluate(() => window.__tether.activeDesk()), d1)
    assert.equal(await probe(page, 'focus', slotId), true)
    assert.equal(await page.evaluate(() => window.__tether.activeDesk()), d2, 'focus went to the desk of the pane')
    assert.equal(await probe(page, 'focus', 'nope'), false)

    await page.evaluate(([id, to]) => window.__tether.movePaneToDesk(id!, to!), [slotId, SYS] as const)
    await until('the move to a system desk', async () => (await get(page, slotId))?.deskId === SYS)
    assert.equal((await get(page, slotId))!.isSystemDesk, true)
    await page.evaluate(d => window.__tether.switchDesk(d), d1)
    assert.equal(await probe(page, 'focus', slotId), true)
    assert.equal(await page.evaluate(() => window.__tether.activeDesk()), SYS, 'focus entered the system desk')
    await page.evaluate(d => window.__tether.switchDesk(d), d1)

    // ---- 3. the agent stops ----
    const pid = (await page.evaluate(() => window.__tether.slots())).find(s => s.slotId === slotId)!.pid
    assert.ok(pid && pidAlive(pid))
    void page.evaluate(id => window.tether.request({ t: 'stop', slotId: id }), slotId)
    await until('the slot stopped', async () => !LIVE.includes((await page.evaluate(() => window.__tether.slots())).find(s => s.slotId === slotId)!.status), 50_000)
    await until('main heard the exit', async () => (await mainExits(app!)).length > 0)
    assert.deepEqual((await mainExits(app)).map(e => [e.slotId, e.reason, e.alive]), [[slotId, 'exited', false]], 'main: onDidExit once')
    await until('the pane is not alive', async () => (await get(page, slotId))?.alive === false)
    assert.equal((await changes(page)).at(-1)!.alive, false)
    assert.equal(await probe(page, 'focus', slotId), true, 'an ended agent can still be focused')
    await sleep(1500)
    assert.ok(!LIVE.includes((await page.evaluate(() => window.__tether.slots())).find(s => s.slotId === slotId)!.status), 'and focus did not restart it')

    // ---- 4. restart ----
    await killElectron(app, root)
    app = undefined
    ;({ app, page } = await launch(home))
    await until('the slot is known', async () => (await page.evaluate(() => window.__tether.slots())).some(s => s.slotId === slotId))
    await page.evaluate(id => window.__tether.openSlot(id), slotId)
    await until('the pane is listed again', async () => (await get(page, slotId)) !== null)
    assert.ok((await mainList(app)).some(a => a.slotId === slotId), 'main knows the same slotId')
  } finally {
    if (app) await killElectron(app, root).catch(() => {})
    for (const d of daemons) await killOwned(d, { tree: true })
    for (let i = 0; i < 20 && daemons.some(d => pidAlive(d.pid)); i++) await sleep(500)
    for (let i = 0; i < 5; i++) {
      try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
  }
})
