// PRD C15 / C18 in the daemon: a resume of a session the agent no longer has fails with `session-missing`
// before anything is spawned; a run that ends without its start event leaves the slot `unconfirmed`, and the
// next start must carry an explicit choice. No real agent: a fake claude adapter launches an inert process.
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import type { AgentAdapter, LaunchPlan } from '../../src/agents/types.ts'
import type { TetherEvent } from '../../src/core/event.ts'
import { slotEventsPath } from '../../src/core/paths.ts'
import { DaemonError } from '../../src/daemon/client.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { pidAlive, Recorder, removeHome, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

let home: string
let daemon: Daemon
let cwd: string

const MISSING = 'aaaaaaaa-0000-4000-8000-000000000001'
const PRESENT = 'bbbbbbbb-0000-4000-8000-000000000002'

/** A process that stays up until killed, in place of the agent. */
function inertPlan(cwd: string): LaunchPlan {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  return { command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd, env }
}

const planned: string[][] = []
const fakeClaude: AgentAdapter = {
  name: 'claude',
  plan: (input) => {
    planned.push(input.resume ? ['--resume', input.resume.sessionId] : ['--session-id'])
    return inertPlan(input.resume?.cwd ?? input.slot.cwd)
  },
  sessionExists: async (b) => b.sessionId !== MISSING,
  title: async (b) => b.title,
}

function startEvent(slotId: string, sessionId: string): TetherEvent {
  return { v: 1, ts: new Date().toISOString(), slotId, agent: 'claude', kind: 'start', source: 'startup', sessionId, cwd, resume: { cwd, args: ['--resume', sessionId] } }
}

before(async () => {
  home = tempHome()
  cwd = join(home, 'work')
  mkdirSync(cwd)
  daemon = await startDaemon({ home, pipe: uniquePipe(home), adapters: { claude: fakeClaude }, readyFallbackMs: 60_000, minAgentAgeMs: 0 })
})
after(async () => {
  await daemon.close()
  await removeHome(home)
})

describe('C15: session missing at resume', () => {
  test('start of a slot bound to a session the agent no longer has: session-missing, nothing spawned, slot in error', async () => {
    const c = await Recorder.connect(daemon.pipe)
    const { slot } = await c.client.request({ t: 'create', kind: 'claude', cwd })
    const slotId = slot!.slotId
    appendFileSync(slotEventsPath(home, slotId), JSON.stringify(startEvent(slotId, MISSING)) + '\n')
    await c.state(slotId, (s) => s.binding?.sessionId === MISSING)
    planned.length = 0
    await assert.rejects(c.client.request({ t: 'start', slotId }), (e: DaemonError) => e.code === 'session-missing' && e.message.includes(MISSING))
    assert.deepEqual(planned, [], 'the adapter was not asked for a plan')
    const errored = await c.state(slotId, (s) => s.status === 'error')
    assert.equal(errored.error?.code, 'session-missing')
    assert.equal(errored.pid, undefined)
    assert.equal(errored.binding?.sessionId, MISSING, 'the binding is kept: the user may still pick a new session')

    // choice 'new' clears the error and starts a fresh session
    const started = await c.client.request({ t: 'start', slotId, choice: 'new' })
    assert.equal(started.slot!.status, 'starting')
    assert.equal(started.slot!.error, undefined)
    assert.deepEqual(planned, [['--session-id']])
    await c.client.request({ t: 'forget', slotId })
    c.close()
  })

  test('a session the agent still has resumes normally', async () => {
    const c = await Recorder.connect(daemon.pipe)
    const { slot } = await c.client.request({ t: 'create', kind: 'claude', cwd })
    const slotId = slot!.slotId
    appendFileSync(slotEventsPath(home, slotId), JSON.stringify(startEvent(slotId, PRESENT)) + '\n')
    await c.state(slotId, (s) => s.binding?.sessionId === PRESENT)
    planned.length = 0
    const started = await c.client.request({ t: 'start', slotId })
    assert.equal(started.slot!.status, 'starting')
    assert.deepEqual(planned, [['--resume', PRESENT]])
    await c.client.request({ t: 'forget', slotId })
    c.close()
  })
})

describe('C18: a run that never reported', () => {
  test('process ran and exited without a start event: unconfirmed; start needs a choice', async () => {
    const c = await Recorder.connect(daemon.pipe)
    const { slot } = await c.client.request({ t: 'create', kind: 'claude', cwd, start: true })
    const slotId = slot!.slotId
    assert.equal(slot!.status, 'starting')
    const pid = slot!.pid!
    assert.ok(pidAlive(pid))

    const stopped = await c.client.request({ t: 'stop', slotId })
    assert.equal(stopped.slot!.status, 'unconfirmed')
    assert.equal(stopped.slot!.pid, undefined)
    assert.equal(stopped.slot!.binding, undefined)
    await waitUntil(() => !pidAlive(pid), 10_000, 'agent gone')
    await c.state(slotId, (s) => s.status === 'unconfirmed')

    await assert.rejects(c.client.request({ t: 'start', slotId }), (e: DaemonError) => e.code === 'unconfirmed')
    assert.equal((await c.client.request({ t: 'list' })).slots!.find((s) => s.slotId === slotId)!.status, 'unconfirmed')

    const started = await c.client.request({ t: 'start', slotId, choice: 'new' })
    assert.equal(started.slot!.status, 'starting')
    await c.client.request({ t: 'forget', slotId })
    c.close()
  })

  test('a run with an older binding that did not report again: unconfirmed, binding kept; choice resume reopens it', async () => {
    const c = await Recorder.connect(daemon.pipe)
    const { slot } = await c.client.request({ t: 'create', kind: 'claude', cwd })
    const slotId = slot!.slotId
    appendFileSync(slotEventsPath(home, slotId), JSON.stringify(startEvent(slotId, PRESENT)) + '\n')
    await c.state(slotId, (s) => s.binding?.sessionId === PRESENT)
    await c.client.request({ t: 'start', slotId })
    const stopped = await c.client.request({ t: 'stop', slotId })
    assert.equal(stopped.slot!.status, 'unconfirmed')
    assert.equal(stopped.slot!.binding?.sessionId, PRESENT)
    await assert.rejects(c.client.request({ t: 'start', slotId }), (e: DaemonError) => e.code === 'unconfirmed')
    planned.length = 0
    const again = await c.client.request({ t: 'start', slotId, choice: 'resume' })
    assert.equal(again.slot!.status, 'starting')
    assert.deepEqual(planned, [['--resume', PRESENT]])

    // this time the agent reports: the run is confirmed and the stop leaves a plain 'exited'
    appendFileSync(slotEventsPath(home, slotId), JSON.stringify(startEvent(slotId, PRESENT)) + '\n')
    await c.state(slotId, (s) => s.status === 'running')
    const stoppedAgain = await c.client.request({ t: 'stop', slotId })
    assert.equal(stoppedAgain.slot!.status, 'exited')
    await c.client.request({ t: 'forget', slotId })
    c.close()
  })

  test('a shell slot never reports and is never unconfirmed', async () => {
    const c = await Recorder.connect(daemon.pipe)
    const { slot } = await c.client.request({ t: 'create', kind: 'shell', cwd, start: true })
    const stopped = await c.client.request({ t: 'stop', slotId: slot!.slotId })
    assert.equal(stopped.slot!.status, 'exited')
    await c.client.request({ t: 'forget', slotId: slot!.slotId })
    c.close()
  })
})
