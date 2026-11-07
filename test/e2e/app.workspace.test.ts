// E2E of the window's projects (F8 slice 0, the core service; no UI yet), hidden window on a private home/pipe, real
// tetherd, no real agent: claude slots created with `start: false` give agent panes (kind 'claude', a folder) with no
// process behind them.
//   1. two agent panes in folder A → one project A, inferred, held by both; a plain terminal in folder C infers nothing;
//      a SessionStart reporting A\sub (a `cd` then /clear) moves the slot's cwd but not the project;
//   2. closing both agent panes → no project;
//   3. "abrir pasta" B → pinned; opening B again → still one B, pinned, no dialog; an agent in B and unpinning makes B
//      inferred, pinning again promotes it; the pinned root lands in layout.json (`workspace.pinned`);
//   4. relaunch on the same home → B is back, pinned.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type Folder = { path: string; name: string; pinned: boolean; agents: string[] }
type Hooks = {
  connection(): { pid?: number } | undefined
  workspace(): { folders: Folder[]; pinned: { path: string }[]; current?: string }
  openFolder(path: string): void
  unpinProject(path: string): void
  toggleProjectPin(path: string): void
  addSlotPane(slotId: string): void
  detachPane(slotId: string): void
  panelIds(): string[]
  slots(): SlotState[]
}
declare const window: { __tether: Hooks; tether: { request(body: unknown): Promise<{ t: string; slot?: SlotState; message?: string }> } }
declare const document: { querySelector(s: string): unknown }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-appworkspace-${process.pid}`
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

function appEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_') && !/^(CLAUDE|TETHER_|ATRIUM_)/i.test(k)) env[k] = v
  env.TETHER_PIPE = pipe
  env.TETHER_HOME = home
  env.TETHER_E2E_HIDDEN = '1'
  return env
}

async function launch(home: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env: appEnv(home) })
  const page = await app.firstWindow()
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  return { app, page }
}

async function waitUntil(cond: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timeout (${ms} ms) waiting for ${what}`)
    await sleep(100)
  }
}

const folders = (page: Page): Promise<Folder[]> => page.evaluate(() => window.__tether.workspace().folders)
const summary = async (page: Page): Promise<string[]> => (await folders(page)).map(f => `${f.name}:${f.pinned ? 'pinned' : 'inferred'}:${f.agents.length}`)

async function create(page: Page, kind: string, cwd: string): Promise<string> {
  const reply = await page.evaluate(body => window.tether.request(body), { t: 'create', kind, cwd, start: false })
  assert.equal(reply.t, 'ok', `create ${kind}: ${reply.message ?? ''}`)
  return reply.slot!.slotId
}

const savedLayout = (home: string): { workspace?: { pinned: { path: string }[] } } => {
  try { return JSON.parse(readFileSync(join(home, 'layout.json'), 'utf8')) } catch { return {} }
}

test('projects: inferred from agent panes only, gone with the last one, open = pin (idempotent), pinned survive a relaunch', { timeout: 240_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  const home = mkdtempSync(join(tmpdir(), 'tether-appworkspace-'))
  const A = join(home, 'proj', 'alpha')
  const B = join(home, 'proj', 'beta')
  const C = join(home, 'proj', 'gamma')
  for (const d of [A, B, C]) mkdirSync(d, { recursive: true })
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let l = await launch(home)
    app = l.app
    let page = l.page
    const daemonPid = (await page.evaluate(() => window.__tether.connection()))!.pid!
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))
    assert.deepEqual(await folders(page), [], 'no project on a fresh home')

    // ---- 1. two agent panes in A → one inferred project; a shell in C infers nothing ----
    const a1 = await create(page, 'claude', A)
    const a2 = await create(page, 'claude', A)
    const sh = await create(page, 'shell', C)
    for (const id of [a1, a2, sh]) await page.evaluate(id => window.__tether.addSlotPane(id), id)
    await waitUntil(async () => (await page.evaluate(() => window.__tether.panelIds())).length >= 3, 10_000, 'three panes')
    await waitUntil(async () => (await folders(page)).length === 1, 5_000, 'project A')
    assert.deepEqual(await summary(page), ['alpha:inferred:2'])
    const fa = (await folders(page))[0]!
    assert.equal(fa.path.toLowerCase(), A.toLowerCase())
    assert.deepEqual([...fa.agents].sort(), [a1, a2].sort())
    // no agent process was started
    const states = await page.evaluate(() => window.__tether.slots().map(s => ({ id: s.slotId, status: s.status })))
    for (const id of [a1, a2]) assert.notEqual(states.find(s => s.id === id)?.status, 'running', 'the agent stays still')
    // `cd` is not followed: Claude's SessionStart hook (after a `cd sub` and a /clear or a compaction) reports the subfolder,
    // and the daemon moves the slot's cwd there; the project stays the folder the agent was opened in.
    const sub = join(A, 'sub')
    mkdirSync(sub)
    const ev = { v: 1, ts: new Date().toISOString(), slotId: a1, agent: 'claude', kind: 'start', source: 'compact', sessionId: '00000000-0000-4000-8000-000000000001', cwd: sub, resume: { cwd: sub, args: ['--resume', '00000000-0000-4000-8000-000000000001'] } }
    appendFileSync(join(home, 'slots', `${a1}.jsonl`), JSON.stringify(ev) + '\n')
    await waitUntil(async () => (await page.evaluate(id => window.__tether.slots().find(s => s.slotId === id)?.cwd, a1))?.toLowerCase() === sub.toLowerCase(), 10_000, 'the slot cwd to follow the hook')
    const moved = await page.evaluate(id => window.__tether.slots().find(s => s.slotId === id), a1)
    assert.equal(moved!.folder?.toLowerCase(), A.toLowerCase(), 'folder stays the creation folder')
    assert.deepEqual(await summary(page), ['alpha:inferred:2'], 'still one project A, held by both')

    // ---- 2. close both agent panes → gone ----
    await page.evaluate(id => window.__tether.detachPane(id), a1)
    await waitUntil(async () => (await summary(page)).join() === 'alpha:inferred:1', 5_000, 'A held by one agent')
    await page.evaluate(id => window.__tether.detachPane(id), a2)
    await waitUntil(async () => (await folders(page)).length === 0, 5_000, 'A gone with the last agent')
    await page.evaluate(id => window.__tether.detachPane(id), sh)

    // ---- 3. open B → pinned; again → still one, pinned, no dialog ----
    await page.evaluate(p => window.__tether.openFolder(p), B)
    assert.deepEqual(await summary(page), ['beta:pinned:0'])
    await page.evaluate(p => window.__tether.openFolder(p), B)
    await page.evaluate(p => window.__tether.openFolder(p), B.toUpperCase())
    assert.deepEqual(await summary(page), ['beta:pinned:0'], 'opening again changes nothing')
    assert.equal(await page.evaluate(() => document.querySelector('dialog[open]') !== null), false, 'no dialog')
    // an agent in B; unpin → inferred; toggle → pinned again
    const b1 = await create(page, 'claude', B)
    await page.evaluate(id => window.__tether.addSlotPane(id), b1)
    await waitUntil(async () => (await summary(page)).join() === 'beta:pinned:1', 5_000, 'B pinned with an agent')
    await page.evaluate(p => window.__tether.unpinProject(p), B)
    assert.deepEqual(await summary(page), ['beta:inferred:1'], 'unpinned with an agent = inferred')
    await page.evaluate(p => window.__tether.toggleProjectPin(p), B)
    assert.deepEqual(await summary(page), ['beta:pinned:1'], 'the toggle promotes it')
    await page.evaluate(id => window.__tether.detachPane(id), b1)
    await waitUntil(async () => (await summary(page)).join() === 'beta:pinned:0', 5_000, 'B stays pinned without agents')
    await waitUntil(() => savedLayout(home).workspace?.pinned.length === 1, 5_000, 'workspace.pinned in layout.json')
    assert.equal(savedLayout(home).workspace!.pinned[0]!.path.toLowerCase(), B.toLowerCase())

    // ---- 4. relaunch → B back, pinned ----
    await killElectron(app, root)
    app = undefined
    await sleep(2_000)
    l = await launch(home)
    app = l.app
    page = l.page
    await waitUntil(async () => (await folders(page)).length === 1, 10_000, 'B after relaunch')
    assert.deepEqual(await summary(page), ['beta:pinned:0'])
  } finally {
    if (app) await killElectron(app, root).catch(() => {})
    for (const d of daemons) await killOwned(d, { tree: true })
    const deadline = Date.now() + 10_000
    while (daemons.some(d => pidAlive(d.pid)) && Date.now() < deadline) await sleep(100)
    for (let i = 0; i < 5; i++) {
      try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
    assert.equal(existsSync(home), false, 'test home removed')
  }
})
