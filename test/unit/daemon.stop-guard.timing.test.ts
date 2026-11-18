// tetherd never kills a young agent: `stop`, `forget` and `close()` (the `shutdown` request) all go through the
// same wait as the `set-profile` restart — the process must be at least minAgentAgeMs old AND have reported
// this run (or left 'starting' by the ready fallback), capped at killWaitCapMs so nothing hangs. Shells are
// killed at once. No real agent: a fake claude adapter launches an inert process; the test appends the start
// event the Claude hook would write.
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import type { AgentAdapter, LaunchPlan, PlanInput } from '../../src/agents/types.ts'
import type { TetherEvent } from '../../src/core/event.ts'
import { slotEventsPath } from '../../src/core/paths.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { pidAlive, Recorder, removeHome, sleep, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

let home: string
let daemon: Daemon
let cwd: string

const MIN_AGE_MS = 1_500
const CAP_MS = 8_000
/** The daemon's log: "killing anyway" is the load-independent proof that a kill hit the cap (or did not). */
const logs: string[] = []
const gaveUp = (slotId: string): boolean => logs.some((l) => l.startsWith(`slot ${slotId}:`) && l.includes('killing anyway'))
const SESSION = 'dddddddd-0000-4000-8000-000000000004'

function inertPlan(cwd: string): LaunchPlan {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  return { command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd, env }
}

const fakeClaude: AgentAdapter = {
  name: 'claude',
  plan: (input: PlanInput) => inertPlan(input.resume?.cwd ?? input.slot.cwd),
  sessionExists: async () => true,
  title: async (b) => b.title,
}

function startEvent(slotId: string, sessionId: string, dir = cwd): TetherEvent {
  return { v: 1, ts: new Date().toISOString(), slotId, agent: 'claude', kind: 'start', source: 'startup', sessionId, cwd: dir, resume: { cwd: dir, args: ['--resume', sessionId] } }
}

function report(h: string, slotId: string, dir = cwd): void {
  appendFileSync(slotEventsPath(h, slotId), JSON.stringify(startEvent(slotId, SESSION, dir)) + '\n')
}

before(async () => {
  home = tempHome()
  cwd = join(home, 'work')
  mkdirSync(cwd)
  daemon = await startDaemon({ home, pipe: uniquePipe(home), adapters: { claude: fakeClaude }, readyFallbackMs: 60_000, minAgentAgeMs: MIN_AGE_MS, killWaitCapMs: CAP_MS, log: (m) => logs.push(m) })
})
after(async () => {
  await daemon.close()
  await removeHome(home)
})

describe('stop on a young claude', () => {
  test('a stop right after the spawn kills only after the minimum age AND the start report; clients see `stopping`', async () => {
    const c = await Recorder.connect(daemon.pipe)
    const { slot } = await c.client.request({ t: 'create', kind: 'claude', cwd, start: true })
    const slotId = slot!.slotId
    const pid = slot!.pid!
    assert.equal(slot!.status, 'starting')

    const t0 = Date.now()
    const stopping = c.client.request({ t: 'stop', slotId })
    await c.state(slotId, (s) => s.stopping === true && s.pid === pid, 5_000, 'stopping broadcast on the live process')
    await sleep(600)
    assert.ok(pidAlive(pid), 'not killed before the minimum age')
    report(home, slotId) // the hook writes the start event ~0.6 s into the run
    await c.state(slotId, (s) => s.status === 'running' && s.binding?.sessionId === SESSION, 5_000, 'report seen during the wait')
    const stopped = await stopping
    const elapsed = Date.now() - t0
    assert.ok(elapsed >= MIN_AGE_MS - 100, `killed only after the minimum age (${elapsed} ms)`)
    assert.ok(!gaveUp(slotId), `did not wait for the cap once aged and reported (${elapsed} ms)`)
    assert.equal(stopped.slot!.status, 'exited', 'reported run: a plain exited, nothing unconfirmed')
    assert.equal(stopped.slot!.pid, undefined)
    assert.equal(stopped.slot!.stopping, undefined, 'the flag is gone from the reply')
    await waitUntil(() => !pidAlive(pid), 10_000, 'process gone')
    await c.client.request({ t: 'forget', slotId })
    c.close()
  })

  test('a claude that never reports is killed at the cap, and the run is unconfirmed', async () => {
    const c = await Recorder.connect(daemon.pipe)
    const { slot } = await c.client.request({ t: 'create', kind: 'claude', cwd, start: true })
    const slotId = slot!.slotId
    const pid = slot!.pid!
    const t0 = Date.now()
    const stopped = await c.client.request({ t: 'stop', slotId })
    const elapsed = Date.now() - t0
    assert.ok(elapsed >= CAP_MS - 100 && gaveUp(slotId), `waited for the cap (${elapsed} ms)`)
    assert.equal(stopped.slot!.status, 'unconfirmed')
    await waitUntil(() => !pidAlive(pid), 10_000, 'process gone')
    await c.client.request({ t: 'forget', slotId })
    c.close()
  })

  test('a second stop during the wait joins it: both answer after the one kill', async () => {
    const c = await Recorder.connect(daemon.pipe)
    const { slot } = await c.client.request({ t: 'create', kind: 'claude', cwd, start: true })
    const slotId = slot!.slotId
    const pid = slot!.pid!
    const t0 = Date.now()
    const first = c.client.request({ t: 'stop', slotId })
    await sleep(200)
    const second = c.client.request({ t: 'stop', slotId })
    await sleep(300)
    report(home, slotId)
    const [a, b] = await Promise.all([first, second])
    const elapsed = Date.now() - t0
    assert.ok(elapsed >= MIN_AGE_MS - 100, `neither stop killed early (${elapsed} ms)`)
    assert.equal(a.slot!.status, 'exited')
    assert.equal(b.slot!.status, 'exited')
    await waitUntil(() => !pidAlive(pid), 10_000, 'process gone')
    await c.client.request({ t: 'forget', slotId })
    c.close()
  })

  test('forget takes the same path: the young claude is killed only after the age and the report', async () => {
    const c = await Recorder.connect(daemon.pipe)
    const { slot } = await c.client.request({ t: 'create', kind: 'claude', cwd, start: true })
    const slotId = slot!.slotId
    const pid = slot!.pid!
    const t0 = Date.now()
    const forgetting = c.client.request({ t: 'forget', slotId })
    await sleep(400)
    assert.ok(pidAlive(pid), 'not killed before the minimum age')
    report(home, slotId)
    await forgetting
    const elapsed = Date.now() - t0
    assert.ok(elapsed >= MIN_AGE_MS - 100, `killed only after the minimum age (${elapsed} ms)`)
    assert.ok(c.removed.includes(slotId))
    await waitUntil(() => !pidAlive(pid), 10_000, 'process gone')
    c.close()
  })

  test('a shell is killed at once', async () => {
    const c = await Recorder.connect(daemon.pipe)
    const { slot } = await c.client.request({ t: 'create', kind: 'shell', cwd, start: true })
    const stopped = await c.client.request({ t: 'stop', slotId: slot!.slotId })
    assert.equal(stopped.slot!.status, 'exited')
    assert.ok(!c.states.some((s) => s.slotId === slot!.slotId && s.stopping), 'never `stopping`')
    await c.client.request({ t: 'forget', slotId: slot!.slotId })
    c.close()
  })

  test('an aged claude already running (reported) is killed at once', async () => {
    const c = await Recorder.connect(daemon.pipe)
    const { slot } = await c.client.request({ t: 'create', kind: 'claude', cwd, start: true })
    const slotId = slot!.slotId
    report(home, slotId)
    await c.state(slotId, (s) => s.status === 'running', 5_000, 'running')
    await sleep(MIN_AGE_MS)
    const stopped = await c.client.request({ t: 'stop', slotId })
    assert.ok(!gaveUp(slotId), 'just the kill, no wait')
    assert.ok(!c.states.some((s) => s.slotId === slotId && s.stopping), 'never `stopping`: nothing to wait for')
    assert.equal(stopped.slot!.status, 'exited')
    await c.client.request({ t: 'forget', slotId })
    c.close()
  })
})

describe('the ready fallback and the guard switch', () => {
  test('the ready fallback (running without a report) does not release the kill: it waits for the cap', async () => {
    const quick = await startDaemon({ home: tempHome(), pipe: uniquePipe(home), adapters: { claude: fakeClaude }, readyFallbackMs: 300, minAgentAgeMs: 200, killWaitCapMs: 2_000, log: (m) => logs.push(m) })
    try {
      const qcwd = join(quick.home, 'work')
      mkdirSync(qcwd)
      const q = await Recorder.connect(quick.pipe)
      const { slot } = await q.client.request({ t: 'create', kind: 'claude', cwd: qcwd, start: true })
      await q.state(slot!.slotId, (s) => s.status === 'running', 5_000, 'running by the fallback')
      const t0 = Date.now()
      const stopped = await q.client.request({ t: 'stop', slotId: slot!.slotId })
      const elapsed = Date.now() - t0
      assert.ok(elapsed >= 1_900 && gaveUp(slot!.slotId), `a run that never reported waits for the cap (${elapsed} ms)`)
      assert.equal(stopped.slot!.status, 'unconfirmed')
      await q.client.request({ t: 'forget', slotId: slot!.slotId })
      q.close()
    } finally {
      const h = quick.home
      await quick.close()
      await removeHome(h)
    }
  })

  test('minAgentAgeMs: 0 disables the guard (test daemons that never report)', async () => {
    const off = await startDaemon({ home: tempHome(), pipe: uniquePipe(home), adapters: { claude: fakeClaude }, readyFallbackMs: 60_000, minAgentAgeMs: 0 })
    try {
      const ocwd = join(off.home, 'work')
      mkdirSync(ocwd)
      const o = await Recorder.connect(off.pipe)
      const { slot } = await o.client.request({ t: 'create', kind: 'claude', cwd: ocwd, start: true })
      await o.client.request({ t: 'stop', slotId: slot!.slotId })
      assert.ok(!o.states.some((s) => s.slotId === slot!.slotId && s.stopping), 'never `stopping`')
      await o.client.request({ t: 'forget', slotId: slot!.slotId })
      o.close()
    } finally {
      const h = off.home
      await off.close()
      await removeHome(h)
    }
  })
})

describe('shutdown (close) with young claudes', () => {
  test('every slot waits in parallel; start reports arriving during the close are honoured, so it takes ~one minimum age, not the cap', async () => {
    const d = await startDaemon({ home: tempHome(), pipe: uniquePipe(home), adapters: { claude: fakeClaude }, readyFallbackMs: 60_000, minAgentAgeMs: MIN_AGE_MS, killWaitCapMs: 20_000, log: (m) => logs.push(m) })
    const dcwd = join(d.home, 'work')
    mkdirSync(dcwd)
    const c = await Recorder.connect(d.pipe)
    const a = (await c.client.request({ t: 'create', kind: 'claude', cwd: dcwd, start: true })).slot!
    const b = (await c.client.request({ t: 'create', kind: 'claude', cwd: dcwd, start: true })).slot!
    const sh = (await c.client.request({ t: 'create', kind: 'shell', cwd: dcwd, start: true })).slot!
    const pids = [a.pid!, b.pid!, sh.pid!]
    try {
      const t0 = Date.now()
      const closing = d.close()
      await sleep(500)
      assert.ok(pidAlive(a.pid!) && pidAlive(b.pid!), 'young claudes still alive 0.5 s into the shutdown')
      report(d.home, a.slotId, dcwd)
      report(d.home, b.slotId, dcwd)
      await closing
      const elapsed = Date.now() - t0
      assert.ok(elapsed >= MIN_AGE_MS - 100, `no claude killed before its minimum age (${elapsed} ms)`)
      assert.ok(!gaveUp(a.slotId) && !gaveUp(b.slotId), `the reports were seen during the close: neither slot hit the cap (${elapsed} ms)`)
      for (const pid of pids) await waitUntil(() => !pidAlive(pid), 10_000, `pid ${pid} gone`)
    } finally {
      c.close()
      await d.close()
      await removeHome(d.home)
    }
  })
})
