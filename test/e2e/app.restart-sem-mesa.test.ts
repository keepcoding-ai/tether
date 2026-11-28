// E2E of the slot's lifecycle intent across a full restart of the app, with the real app on a private home and pipe, hidden
// window, and a tetherd in this process with a fake `soul` adapter (a `.cjs` that logs every launch to a file). No LLM.
//   1. slot A runs with a pane in a desk, slot B runs with no pane, slot C was ended by the person (`stop` with no why),
//      slot D was hibernated (`why: 'hibernate'`); all four reported their session (binding confirmed);
//   2. the person leaves by "Sair e encerrar tudo" (quitAll, which stops every slot with `why: 'quit'` and shuts the daemon
//      down): the app, the tetherd and every agent process are gone;
//   3. a new tetherd boots on the same home and the app opens again: A and B come back resuming the SAME session, C and D
//      stay stopped, and no slot ever had two processes (the launch log counts them per slot; the app's own start of A's pane
//      races the boot relaunch and must not add one).
// Path exercised: the daemon runs without the terminal-pane host (`panelHost: false`), so quitting kills the agents and the
// boot relaunches them; adoption from a surviving host is not exercised here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import type { AgentAdapter, LaunchPlan } from '../../src/agents/types.ts'
import type { SlotMeta, TetherEvent } from '../../src/core/event.ts'
import { slotEventsPath, slotMetaPath } from '../../src/core/paths.ts'
import { DaemonClient } from '../../src/daemon/client.ts'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { pidAlive, removeHome, sleep, tempHome, uniquePipe, waitUntil } from '../unit/daemon.helpers.ts'
import { killElectron } from './electron.ts'

type Hooks = {
  panelIds(): string[]
  desks(): { id: string; name: string; panes: string[] }[]
}
declare const window: { __tether: Hooks }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')

const FAKE_AGENT = String.raw`
const fs = require('node:fs')
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ slot: process.env.FAKE_SLOT, resume: process.env.FAKE_RESUME, pid: process.pid }) + '\n')
setInterval(() => {}, 60000)
`
interface Launch { slot: string; resume: string; pid: number }

async function launch(home: string, pipe: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k.startsWith('ELECTRON_') || k.toUpperCase().startsWith('CLAUDE') || k.startsWith('TETHER_')) continue
    env[k] = v
  }
  env.TETHER_PIPE = pipe
  env.TETHER_HOME = home
  env.TETHER_E2E_HIDDEN = '1'
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  page.on('pageerror', e => console.error(`renderer error: ${e.message}`))
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  return { app, page }
}

test('restart without a desk: what ran comes back once, what was stopped stays', { timeout: 300_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  const home = tempHome()
  const pipe = uniquePipe(home)
  const cwd = join(home, 'work')
  mkdirSync(cwd)
  const logFile = join(home, 'launches.jsonl')
  writeFileSync(join(home, 'fake-agent.cjs'), FAKE_AGENT)
  const fake: AgentAdapter = {
    name: 'soul',
    resumes: true,
    plan: (input): LaunchPlan => {
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('TETHER_')) env[k] = v
      delete env.NODE_TEST_CONTEXT
      env.FAKE_LOG = logFile
      env.FAKE_SLOT = input.slot.slotId
      env.FAKE_RESUME = input.resume?.sessionId ?? 'new'
      return { command: process.execPath, args: [join(home, 'fake-agent.cjs')], cwd: input.resume?.cwd ?? input.slot.cwd, env }
    },
    sessionExists: async () => 'unknown',
    title: async b => b.title,
  }
  const logs: string[] = []
  let shutdown: () => void = () => {}
  const boot = (): Promise<Daemon> => startDaemon({
    home, pipe, adapters: { soul: fake }, panelHost: false, memoryIntervalMs: 0, minAgentAgeMs: 0, readyFallbackMs: 60_000,
    log: m => logs.push(m), onShutdown: () => shutdown(),
  })
  const launches = (slotId?: string): Launch[] => {
    if (!existsSync(logFile)) return []
    const all = readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Launch)
    return slotId ? all.filter(l => l.slot === slotId) : all
  }
  const meta = (slotId: string): SlotMeta => JSON.parse(readFileSync(slotMetaPath(home, slotId), 'utf8')) as SlotMeta
  const report = (slotId: string, sessionId: string): void => {
    const ev: TetherEvent = { v: 1, ts: new Date().toISOString(), slotId, agent: 'soul', kind: 'start', source: 'startup', sessionId, cwd, resume: { cwd, args: ['-r', sessionId] } }
    appendFileSync(slotEventsPath(home, slotId), JSON.stringify(ev) + '\n')
  }

  let daemon: Daemon | undefined = await boot()
  const state = (slotId: string): SlotState | undefined => daemon?.slots().find(s => s.slotId === slotId)
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home, pipe))
    const client = await DaemonClient.open(pipe, 'test', { home })
    const ids: Record<'A' | 'B' | 'C' | 'D', string> = { A: '', B: '', C: '', D: '' }
    try {
      // ---- 1. A with a pane in desk-1, B without a pane, C ended, D hibernated ----
      console.log('step 1')
      const deskName = (await page.evaluate(() => window.__tether.desks()))[0]!.name
      for (const k of ['A', 'B', 'C', 'D'] as const) {
        const { slot } = await client.request({ t: 'create', kind: 'soul', cwd, start: true, ...(k === 'A' ? { desk: deskName } : {}) })
        const id = slot!.slotId
        ids[k] = id
        await waitUntil(() => launches(id).length === 1, 15_000, `first launch of ${k}`)
        report(id, `sess-${k}`)
        await waitUntil(() => state(id)?.status === 'running' && state(id)?.binding?.sessionId === `sess-${k}`, 15_000, `${k} running with its session`)
      }
      await page.waitForFunction(id => window.__tether.panelIds().includes(id), ids.A)
      assert.equal(await page.evaluate(id => window.__tether.panelIds().includes(id), ids.B), false, 'B has no pane')
      await client.request({ t: 'stop', slotId: ids.C })
      await client.request({ t: 'stop', slotId: ids.D, why: 'hibernate' })
      await waitUntil(() => state(ids.C)?.pid === undefined && state(ids.D)?.pid === undefined, 15_000, 'C and D stopped')
      assert.equal(meta(ids.C).want, 'ended')
      assert.equal(meta(ids.D).want, 'asleep')
    } finally {
      client.close()
    }
    const firstPids = launches().map(l => l.pid)

    // ---- 2. "Sair e encerrar tudo": app, tetherd and agents gone ----
    console.log('step 2')
    const down = new Promise<void>(r => { shutdown = r })
    await app.evaluate(({ Menu }) => { Menu.getApplicationMenu()?.getMenuItemById('quit-all')?.click() })
    const quit = page.locator('dialog.ask[data-dialog="quit-all"][open]')
    await quit.waitFor()
    const closed = app.waitForEvent('close', { timeout: 30_000 })
    await quit.locator('button.choice[data-choice="quit"]').click()
    await closed
    app = undefined
    await down
    daemon = undefined
    await waitUntil(() => firstPids.every(p => !pidAlive(p)), 15_000, 'every agent process is gone')
    assert.equal(meta(ids.A).want, 'run', 'quit keeps A meant to run')
    assert.equal(meta(ids.B).want, 'run', 'quit keeps B meant to run')
    assert.equal(meta(ids.C).want, 'ended')
    assert.equal(meta(ids.D).want, 'asleep')

    // ---- 3. a new tetherd on the same home, the app again ----
    console.log('step 3')
    daemon = await boot()
    ;({ app, page } = await launch(home, pipe))
    for (const k of ['A', 'B'] as const) {
      const id = ids[k]
      await waitUntil(() => launches(id).length >= 2 && state(id)?.pid === launches(id)[1]!.pid, 30_000, `${k} relaunched`)
        .catch(e => { throw new Error(`${(e as Error).message}; launches ${JSON.stringify(launches(id))}; state ${JSON.stringify(state(id))}; meta ${JSON.stringify(meta(id))}; log tail ${logs.slice(-15).join(' | ')}`) })
      assert.equal(launches(id)[1]!.resume, `sess-${k}`, `${k} resumed its own session`)
      assert.equal(state(id)?.binding?.sessionId, `sess-${k}`)
    }
    await page.waitForFunction(id => window.__tether.panelIds().includes(id), ids.A)
    await sleep(3_000) // room for a late second start (the app's pane start racing the boot)
    assert.equal(launches(ids.A).length, 2, 'A launched once per run')
    assert.equal(launches(ids.B).length, 2, 'B launched once per run')
    assert.equal(launches(ids.C).length, 1, 'C stayed ended')
    assert.equal(launches(ids.D).length, 1, 'D stayed asleep')
    assert.equal(state(ids.C)?.pid, undefined)
    assert.equal(state(ids.D)?.pid, undefined)
    const live = launches().filter(l => pidAlive(l.pid)).map(l => l.slot).sort()
    assert.deepEqual(live, [ids.A, ids.B].sort(), 'exactly one live process each for A and B')
  } finally {
    if (app) await killElectron(app, root).catch(() => {})
    await daemon?.close().catch(() => {})
    for (const l of launches()) if (pidAlive(l.pid)) console.error(`left alive: ${l.slot} pid ${l.pid}`)
    await removeHome(home)
  }
})
