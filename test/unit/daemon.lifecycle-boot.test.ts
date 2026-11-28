// The slot's lifecycle intent (SlotMeta.want) and the boot relaunch: a slot meant to run comes back when a new tetherd boots,
// with no client connected; ended, hibernated, suspended and legacy slots do not; an unconfirmed binding is never resumed on a
// guess; a crash loop stops after MAX_BOOT_TRIES boots; a start that races the boot launches one process; an adopted pane is not
// launched again; the boot goes through the start queue. No real agent: a fake `soul` adapter launches a `.cjs` that logs each
// launch (slot, resumed session) to a file, and the test writes the start events by hand. Home and pipe are the test's own.
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import type { AgentAdapter, LaunchPlan } from '../../src/agents/types.ts'
import type { SlotMeta, TetherEvent } from '../../src/core/event.ts'
import { slotEventsPath, slotMetaPath } from '../../src/core/paths.ts'
import { readRun, writeRun } from '../../src/core/store.ts'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { MAX_BOOT_TRIES, MAX_STARTING, startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { pidAlive, Recorder, removeHome, sleep, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

const FAKE_AGENT = String.raw`
const fs = require('node:fs')
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ slot: process.env.FAKE_SLOT, resume: process.env.FAKE_RESUME, pid: process.pid }) + '\n')
if (fs.existsSync(process.env.FAKE_DIE)) process.exit(1)
setInterval(() => {}, 60000)
`

interface Launch { slot: string; resume: string; pid: number }

/** One test's bench: its own home, a fake agent and the launches it logged. */
class Bench {
  readonly home = tempHome()
  readonly cwd = join(this.home, 'work')
  readonly logFile = join(this.home, 'launches.jsonl')
  readonly logs: string[] = []
  daemon: Daemon | undefined
  private readonly fake: AgentAdapter

  constructor() {
    mkdirSync(this.cwd)
    writeFileSync(join(this.home, 'fake-agent.cjs'), FAKE_AGENT)
    this.fake = {
      name: 'soul',
      resumes: true,
      plan: (input): LaunchPlan => {
        const env: Record<string, string> = {}
        for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
        delete env.NODE_TEST_CONTEXT
        env.FAKE_LOG = this.logFile
        env.FAKE_SLOT = input.slot.slotId
        env.FAKE_RESUME = input.resume?.sessionId ?? 'new'
        env.FAKE_DIE = this.dieFile(input.slot.slotId)
        return { command: process.execPath, args: [join(this.home, 'fake-agent.cjs')], cwd: input.resume?.cwd ?? input.slot.cwd, env }
      },
      sessionExists: async () => 'unknown',
      title: async (b) => b.title,
    }
  }

  dieFile(slotId: string): string { return join(this.home, `die-${slotId}`) }

  async boot(opts: { panelHost?: boolean; readyFallbackMs?: number } = {}): Promise<Daemon> {
    this.daemon = await startDaemon({
      home: this.home,
      pipe: uniquePipe(this.home),
      adapters: { soul: this.fake },
      panelHost: opts.panelHost ?? false,
      memoryIntervalMs: 0,
      minAgentAgeMs: 0,
      readyFallbackMs: opts.readyFallbackMs ?? 60_000,
      log: (m) => this.logs.push(m),
    })
    return this.daemon
  }

  async close(): Promise<void> {
    await this.daemon?.close()
    this.daemon = undefined
  }

  launches(slotId?: string): Launch[] {
    if (!existsSync(this.logFile)) return []
    const all = readFileSync(this.logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Launch)
    return slotId ? all.filter((l) => l.slot === slotId) : all
  }

  state(slotId: string): SlotState {
    const s = this.daemon!.slots().find((x) => x.slotId === slotId)
    assert.ok(s, `slot ${slotId} known`)
    return s
  }

  meta(slotId: string): SlotMeta {
    return JSON.parse(readFileSync(slotMetaPath(this.home, slotId), 'utf8')) as SlotMeta
  }

  /** The agent reports its session (what the hook writes): the slot's binding becomes confirmed. */
  report(slotId: string, sessionId: string): void {
    const ev: TetherEvent = { v: 1, ts: new Date().toISOString(), slotId, agent: 'soul', kind: 'start', source: 'startup', sessionId, cwd: this.cwd, resume: { cwd: this.cwd, args: ['-r', sessionId] } }
    appendFileSync(slotEventsPath(this.home, slotId), JSON.stringify(ev) + '\n')
  }

  /** A soul slot created and started by a client, its session reported and seen running. */
  async running(rec: Recorder, sessionId: string | undefined): Promise<string> {
    const { slot } = await rec.client.request({ t: 'create', kind: 'soul', cwd: this.cwd, start: true })
    const id = slot!.slotId
    await waitUntil(() => this.launches(id).length > 0, 10_000, `first launch of ${id}`)
    if (sessionId) {
      this.report(id, sessionId)
      await rec.state(id, (s) => s.status === 'running' && s.binding?.sessionId === sessionId, 10_000, 'running with its session')
    }
    return id
  }

  async dispose(): Promise<void> {
    await this.close().catch(() => {})
    await removeHome(this.home)
  }
}

const benches: Bench[] = []
const bench = (): Bench => { const b = new Bench(); benches.push(b); return b }
after(async () => { for (const b of benches) await b.dispose() })

/** Waits a little and proves nothing was launched meanwhile. */
async function noLaunch(b: Bench, slotId: string, count: number): Promise<void> {
  await sleep(600)
  assert.equal(b.launches(slotId).length, count, `no new launch of ${slotId}`)
  assert.equal(b.state(slotId).pid, undefined, `${slotId} has no process`)
}

describe('lifecycle intent: the boot relaunches what is meant to run', () => {
  test('1. a slot meant to run with a confirmed binding comes back after a reboot, resuming its session, with no client', async () => {
    const b = bench()
    await b.boot()
    const rec = await Recorder.connect(b.daemon!.pipe)
    const id = await b.running(rec, 'sess-1')
    assert.equal(b.state(id).want, 'run')
    const firstPid = b.launches(id)[0]!.pid
    rec.close()
    await b.close() // tetherd's teardown kills the agent and leaves the intent as it was
    await waitUntil(() => !pidAlive(firstPid), 10_000, 'the first agent is gone')
    assert.equal(b.meta(id).want, 'run')

    await b.boot() // nobody connects
    await waitUntil(() => b.launches(id).length === 2, 10_000, 'the relaunch')
    const relaunch = b.launches(id)[1]!
    assert.equal(relaunch.resume, 'sess-1', 'resumed the same session')
    await waitUntil(() => b.state(id).pid === relaunch.pid, 10_000, 'the slot runs the relaunched process')
    assert.equal(b.state(id).want, 'run')
    assert.ok(b.logs.some((l) => l.includes(`slot ${id}: relaunching at boot (resume sess-1`)))
  })

  test('2. a slot ended by a stop without why does not come back', async () => {
    const b = bench()
    await b.boot()
    const rec = await Recorder.connect(b.daemon!.pipe)
    const id = await b.running(rec, 'sess-2')
    const stopped = await rec.client.request({ t: 'stop', slotId: id })
    assert.equal(stopped.slot!.want, 'ended')
    assert.equal(b.meta(id).want, 'ended')
    rec.close()
    await b.close()
    await b.boot()
    assert.equal(b.state(id).want, 'ended')
    await noLaunch(b, id, 1)
    assert.equal(b.state(id).status, 'exited')
  })

  test('3. hibernated and suspended slots do not come back; a start wakes them and records run', async () => {
    const b = bench()
    await b.boot()
    let rec = await Recorder.connect(b.daemon!.pipe)
    const asleep = await b.running(rec, 'sess-3a')
    const suspended = await b.running(rec, 'sess-3s')
    assert.equal((await rec.client.request({ t: 'stop', slotId: asleep, why: 'hibernate' })).slot!.want, 'asleep')
    assert.equal((await rec.client.request({ t: 'stop', slotId: suspended, why: 'suspend' })).slot!.want, 'suspended')
    await assert.rejects(rec.client.request({ t: 'stop', slotId: asleep, why: 'nap' as 'end' }), /why inválido/)
    rec.close()
    await b.close()
    await b.boot()
    await noLaunch(b, asleep, 1)
    await noLaunch(b, suspended, 1)

    rec = await Recorder.connect(b.daemon!.pipe)
    for (const id of [asleep, suspended]) {
      await rec.client.request({ t: 'start', slotId: id })
      await waitUntil(() => b.launches(id).length === 2, 10_000, `the wake of ${id}`)
      await waitUntil(() => b.state(id).want === 'run' && b.state(id).pid !== undefined, 10_000, `${id} runs`)
      await waitUntil(() => b.meta(id).want === 'run', 10_000, `${id} meta says run`)
    }
    rec.close()
  })

  test('3b. set-want records asleep/suspended without touching the process (the app migration); the boot then leaves it', async () => {
    const b = bench()
    await b.boot()
    const rec = await Recorder.connect(b.daemon!.pipe)
    const id = await b.running(rec, 'sess-3w')
    const pid = b.state(id).pid!
    const set = await rec.client.request({ t: 'set-want', slotId: id, want: 'asleep' })
    assert.equal(set.slot!.want, 'asleep')
    assert.equal(set.slot!.pid, pid, 'the process is untouched')
    assert.equal(b.meta(id).want, 'asleep', 'on disk when it answers')
    await assert.rejects(rec.client.request({ t: 'set-want', slotId: id, want: 'run' as 'asleep' }), /want inválido/)
    rec.close()
    await b.close()
    await b.boot()
    await noLaunch(b, id, 1)
  })

  test('4. a legacy slot (meta without want) is never relaunched', async () => {
    const b = bench()
    await b.boot()
    const rec = await Recorder.connect(b.daemon!.pipe)
    const id = await b.running(rec, 'sess-4')
    rec.close()
    await b.close()
    const meta = b.meta(id)
    delete meta.want
    writeFileSync(slotMetaPath(b.home, id), JSON.stringify(meta, null, 2) + '\n')
    await b.boot()
    assert.equal(b.state(id).want, undefined)
    await noLaunch(b, id, 1)
  })

  test('5. a slot meant to run without a confirmed binding is not relaunched: it stays unconfirmed', async () => {
    const b = bench()
    await b.boot()
    const rec = await Recorder.connect(b.daemon!.pipe)
    const id = await b.running(rec, undefined) // never reports its session
    rec.close()
    await b.close()
    assert.equal(b.meta(id).want, 'run')
    await b.boot()
    await noLaunch(b, id, 1)
    assert.equal(b.state(id).status, 'unconfirmed')
    assert.equal(b.state(id).want, 'run')
  })

  test(`6. crash loop: after ${MAX_BOOT_TRIES} boots without a healthy run the next boot does not relaunch; a manual start resets it`, async () => {
    const b = bench()
    await b.boot()
    let rec = await Recorder.connect(b.daemon!.pipe)
    const id = await b.running(rec, 'sess-6')
    rec.close()
    await b.close()
    writeFileSync(b.dieFile(id), '') // from now on the agent dies at once
    for (let i = 1; i <= MAX_BOOT_TRIES; i++) {
      await b.boot()
      await waitUntil(() => b.launches(id).length === 1 + i, 10_000, `relaunch ${i}`)
      await waitUntil(() => b.state(id).pid === undefined && b.state(id).status !== 'starting', 10_000, `death ${i}`)
      assert.equal(b.meta(id).bootTries, i)
      await b.close()
    }
    await b.boot()
    await noLaunch(b, id, 1 + MAX_BOOT_TRIES)
    assert.equal(b.state(id).want, 'run', 'still meant to run (interrupted), only not relaunched')
    assert.ok(b.logs.some((l) => l.includes(`slot ${id}: relaunched ${MAX_BOOT_TRIES} boots in a row`)))

    rmSync(b.dieFile(id))
    rec = await Recorder.connect(b.daemon!.pipe)
    await rec.client.request({ t: 'start', slotId: id })
    await waitUntil(() => b.launches(id).length === 2 + MAX_BOOT_TRIES, 10_000, 'the manual start')
    await waitUntil(() => b.meta(id).bootTries === undefined, 10_000, 'the count reset by the manual start')
    rec.close()
    await b.close()
    await b.boot() // relaunched again: the count started over
    await waitUntil(() => b.launches(id).length === 3 + MAX_BOOT_TRIES, 10_000, 'relaunch after the reset')
  })

  test('7. a start that races the boot relaunch launches one process (starting and queued)', async () => {
    const b = bench()
    await b.boot()
    let rec = await Recorder.connect(b.daemon!.pipe)
    const ids: string[] = []
    for (let i = 0; i < MAX_STARTING + 1; i++) ids.push(await b.running(rec, `sess-7-${i}`))
    rec.close()
    await b.close()

    await b.boot()
    rec = await Recorder.connect(b.daemon!.pipe)
    // Right after the boot: the first MAX_STARTING are starting (or about to), the last one queued.
    const replies = await Promise.all(ids.map((id) => rec.client.request({ t: 'start', slotId: id })))
    assert.equal(replies[MAX_STARTING]!.slot!.status, 'queued', 'the queued one stays queued')
    for (let i = 0; i < MAX_STARTING; i++) assert.equal(replies[i]!.slot!.status, 'starting')
    for (let i = 0; i < MAX_STARTING; i++) await waitUntil(() => b.launches(ids[i]).length === 2, 10_000, `relaunch of ${ids[i]}`)
    b.report(ids[0]!, 'sess-7-0') // a seat frees: the queued one goes
    await waitUntil(() => b.launches(ids[MAX_STARTING]).length === 2, 10_000, 'the queued one launches')
    await rec.client.request({ t: 'start', slotId: ids[MAX_STARTING]! }) // once more, now that it is up
    await sleep(600)
    for (const id of ids) {
      assert.equal(b.launches(id).length, 2, `one launch of ${id} in this boot`)
      assert.equal(b.state(id).pid, b.launches(id)[1]!.pid)
    }
    rec.close()
  })

  test('8. a pane adopted from the terminal-pane host is not launched again', async () => {
    const b = bench()
    await b.boot({ panelHost: true })
    let rec = await Recorder.connect(b.daemon!.pipe)
    const id = await b.running(rec, 'sess-8')
    const pid = b.state(id).pid!
    assert.equal(b.state(id).ptyHost, true)
    await waitUntil(() => readRun(b.home, id)?.agentPid === pid, 10_000, 'run file')
    const run = readRun(b.home, id)!
    rec.close()
    await b.daemon!.abandon() // a hard death: the hosted pane lives on
    b.daemon = undefined
    assert.ok(pidAlive(pid))
    writeRun(b.home, id, { ...run, pid: await deadPid(), startedAt: '2000-01-01T00:00:00.000Z' })

    await b.boot({ panelHost: true })
    assert.equal(b.state(id).pid, pid, 'adopted, the same process')
    await noLaunchAlive(b, id, 1)
    rec = await Recorder.connect(b.daemon!.pipe)
    await rec.client.request({ t: 'stop', slotId: id })
    rec.close()
  })

  test(`9. queue: with ${MAX_STARTING + 2} slots meant to run, at most ${MAX_STARTING} are starting at once`, async () => {
    const b = bench()
    await b.boot()
    let rec = await Recorder.connect(b.daemon!.pipe)
    const ids: string[] = []
    for (let i = 0; i < MAX_STARTING + 2; i++) ids.push(await b.running(rec, `sess-9-${i}`))
    rec.close()
    await b.close()

    await b.boot()
    rec = await Recorder.connect(b.daemon!.pipe)
    let most = 0
    const count = (): number => b.daemon!.slots().filter((s) => ids.includes(s.slotId) && s.status === 'starting').length
    const deadline = Date.now() + 1_000
    while (Date.now() < deadline) { most = Math.max(most, count()); await sleep(20) }
    assert.equal(most, MAX_STARTING)
    assert.equal(b.daemon!.slots().filter((s) => ids.includes(s.slotId) && s.status === 'queued').length, 2)
    // Order is stable (creation order): the first ones got the seats.
    for (let i = 0; i < MAX_STARTING; i++) assert.equal(b.launches(ids[i]).length, 2)
    for (let i = MAX_STARTING; i < ids.length; i++) assert.equal(b.launches(ids[i]).length, 1)
    // Seats free as agents report: the rest go, never more than MAX_STARTING starting.
    for (let i = 0; i < 2; i++) {
      b.report(ids[i]!, `sess-9-${i}`)
      await waitUntil(() => b.launches(ids[MAX_STARTING + i]).length === 2, 10_000, `queued ${i} launches`)
      assert.ok(count() <= MAX_STARTING)
    }
    rec.close()
  })
})

/** Like noLaunch, for a slot that keeps its (adopted) process. */
async function noLaunchAlive(b: Bench, slotId: string, count: number): Promise<void> {
  await sleep(600)
  assert.equal(b.launches(slotId).length, count, `no new launch of ${slotId}`)
}

/** The pid of a process that already exited (a tetherd that died). */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  const pid = child.pid!
  await new Promise((r) => child.once('exit', r))
  return pid
}
