// The start queue: at most MAX_STARTING agent slots in 'starting' at once; the rest wait as 'queued' and start
// in order as the others reach 'running' (start event) or exit. Shell slots never queue. No real agent here:
// a fake soul adapter launches an inert node process, and the test writes the start events by hand.
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import type { AgentAdapter, LaunchPlan } from '../../src/agents/types.ts'
import type { TetherEvent } from '../../src/core/event.ts'
import { slotEventsPath } from '../../src/core/paths.ts'
import { MAX_STARTING, startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { pidAlive, Recorder, removeHome, sleep, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

let home: string
let daemon: Daemon
let cwd: string

/** A process that stays up until killed, in place of the agent. */
function inertPlan(cwd: string): LaunchPlan {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  return { command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd, env }
}

const fakeSoul: AgentAdapter = {
  name: 'soul',
  plan: (input) => inertPlan(input.resume?.cwd ?? input.slot.cwd),
  sessionExists: async () => 'unknown',
  title: async (b) => b.title,
}

function startEvent(slotId: string, sessionId: string): TetherEvent {
  return { v: 1, ts: new Date().toISOString(), slotId, agent: 'soul', kind: 'start', source: 'startup', sessionId, cwd, resume: { cwd, args: ['-r', sessionId] } }
}

before(async () => {
  home = tempHome()
  cwd = join(home, 'work')
  mkdirSync(cwd)
  daemon = await startDaemon({ home, pipe: uniquePipe(home), adapters: { soul: fakeSoul }, readyFallbackMs: 60_000 })
})
after(async () => {
  await daemon.close()
  await removeHome(home)
})

describe('resume queue', () => {
  test(`${MAX_STARTING} agents start at once; the others queue and start in order`, async () => {
    const c = await Recorder.connect(daemon.pipe)
    const ids: string[] = []
    for (let i = 0; i < MAX_STARTING + 2; i++) {
      const { slot } = await c.client.request({ t: 'create', kind: 'soul', cwd, name: `s${i}`, start: true })
      ids.push(slot!.slotId)
      assert.equal(slot!.status, i < MAX_STARTING ? 'starting' : 'queued', `slot ${i}`)
    }
    const list = (await c.client.request({ t: 'list' })).slots!
    assert.deepEqual(list.filter((s) => s.status === 'starting').length, MAX_STARTING)
    const queued = list.filter((s) => s.status === 'queued')
    assert.deepEqual(queued.map((s) => s.slotId), ids.slice(MAX_STARTING))
    for (const q of queued) assert.equal(q.pid, undefined)

    // a shell slot is not held back by the queue
    const shell = await c.client.request({ t: 'create', kind: 'shell', cwd, start: true })
    assert.equal(shell.slot!.status, 'running')
    await c.client.request({ t: 'forget', slotId: shell.slot!.slotId })

    // the first agent confirms it is up: its seat goes to the first queued slot, in order
    appendFileSync(slotEventsPath(home, ids[0]!), JSON.stringify(startEvent(ids[0]!, 'sess-0')) + '\n')
    await c.state(ids[0]!, (s) => s.status === 'running' && s.binding?.sessionId === 'sess-0')
    const third = await c.state(ids[MAX_STARTING]!, (s) => s.status === 'starting')
    assert.ok(third.pid! > 0)
    assert.ok(pidAlive(third.pid!))
    const stillQueued = (await c.client.request({ t: 'list' })).slots!.find((s) => s.slotId === ids[MAX_STARTING + 1])!
    assert.equal(stillQueued.status, 'queued')

    // an agent that exits also frees a seat
    await c.client.request({ t: 'stop', slotId: ids[1]! })
    await c.state(ids[1]!, (s) => s.status === 'exited')
    await c.state(ids[MAX_STARTING + 1]!, (s) => s.status === 'starting')
    assert.equal((await c.client.request({ t: 'list' })).slots!.filter((s) => s.status === 'queued').length, 0)

    for (const id of ids) await c.client.request({ t: 'forget', slotId: id })
    c.close()
  })

  test('stop on a queued slot takes it out of the queue (exited, never spawned); start again re-queues it', async () => {
    const c = await Recorder.connect(daemon.pipe)
    const ids: string[] = []
    for (let i = 0; i < MAX_STARTING + 1; i++) {
      const { slot } = await c.client.request({ t: 'create', kind: 'soul', cwd, start: true })
      ids.push(slot!.slotId)
    }
    const last = ids[MAX_STARTING]!
    await c.state(last, (s) => s.status === 'queued')
    const stopped = await c.client.request({ t: 'stop', slotId: last })
    assert.equal(stopped.slot!.status, 'exited')
    assert.equal(stopped.slot!.pid, undefined)
    await c.state(last, (s) => s.status === 'exited')

    const again = await c.client.request({ t: 'start', slotId: last })
    assert.equal(again.slot!.status, 'queued')
    // idempotent: a second start keeps it queued once
    assert.equal((await c.client.request({ t: 'start', slotId: last })).slot!.status, 'queued')

    // free one seat: the re-queued slot starts
    await c.client.request({ t: 'stop', slotId: ids[0]! })
    await c.state(last, (s) => s.status === 'starting')
    await sleep(100)
    assert.equal((await c.client.request({ t: 'list' })).slots!.filter((s) => s.status === 'starting').length, MAX_STARTING)

    for (const id of ids) await c.client.request({ t: 'forget', slotId: id })
    await waitUntil(() => c.removed.length >= ids.length, 10_000, 'all removed')
    c.close()
  })
})
