// System work off the loop (E3.7): `taskkill`, the process-table sample, the start-time helper and the renamed-node copy run on
// the executor's worker. With the worker executor, stopping 5 panels while the memory sampler runs (a PowerShell / ps per
// sample) leaves the daemon's loop without a stall of 100 ms or more. The monitor runs in the test process, which hosts the
// daemon, so it sees exactly what the daemon's loop sees. The spawns themselves are outside the window: in-process node-pty
// creates the process on the loop (the hosted default does it in tether-ptyd, see the note in server.ts launch()).
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import type { AgentAdapter, LaunchPlan, PlanInput } from '../../src/agents/types.ts'
import type { TetherEvent } from '../../src/core/event.ts'
import { slotEventsPath } from '../../src/core/paths.ts'
import { createExecutor } from '../../src/exec/executor.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { Recorder, removeHome, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

const LAG_LIMIT_MS = 100

function inertPlan(cwd: string): LaunchPlan {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  return { command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd, env }
}

const fakeSoul: AgentAdapter = {
  name: 'soul',
  plan: (input: PlanInput) => inertPlan(input.resume?.cwd ?? input.slot.cwd),
  sessionExists: async () => 'unknown',
  title: async (b) => b.title,
}

function startEvent(slotId: string, sessionId: string, cwd: string): TetherEvent {
  return { v: 1, ts: new Date().toISOString(), slotId, agent: 'soul', kind: 'start', source: 'startup', sessionId, cwd, resume: { cwd, args: ['-r', sessionId] } }
}

/** Max gap between two ticks of a 5 ms timer, beyond the 5 ms itself. */
function lagMonitor(): { stop(): number } {
  let last = performance.now()
  let max = 0
  const timer = setInterval(() => {
    const now = performance.now()
    max = Math.max(max, now - last - 5)
    last = now
  }, 5)
  return { stop: () => { clearInterval(timer); return max } }
}

describe('system work on the executor', () => {
  const homes: string[] = []
  const daemons: Daemon[] = []
  const recorders: Recorder[] = []
  after(async () => {
    for (const r of recorders) r.close()
    for (const d of daemons) await d.close()
    for (const h of homes) await removeHome(h)
  })

  test(`stopping 5 panels while the memory sample runs never stalls the loop ${LAG_LIMIT_MS} ms (worker executor)`, async () => {
    const executor = createExecutor({ mode: 'worker' })
    try {
      const home = tempHome()
      homes.push(home)
      const cwd = join(home, 'work')
      mkdirSync(cwd)
      const logs: string[] = []
      const daemon = await startDaemon({
        home, pipe: uniquePipe(home), executor, panelHost: false, adapters: { soul: fakeSoul },
        readyFallbackMs: 60_000, minAgentAgeMs: 0, memoryIntervalMs: 300, log: (m) => logs.push(m),
      })
      daemons.push(daemon)
      const rec = await Recorder.connect(daemon.pipe)
      recorders.push(rec)
      // Warm the worker's lane so its start-up (~40 ms) is not mistaken for a stall.
      await executor.run('startTimeInfo', [])
      const ids: string[] = []
      for (let i = 0; i < 5; i++) {
        const { slot } = await rec.client.request({ t: 'create', kind: 'soul', cwd, name: `os${i}`, start: true })
        ids.push(slot!.slotId)
        await waitUntil(() => daemon.slots().some((s) => s.slotId === slot!.slotId && s.pid !== undefined), 15_000, 'a spawned slot')
        appendFileSync(slotEventsPath(home, slot!.slotId), JSON.stringify(startEvent(slot!.slotId, `os-${i}`, cwd)) + '\n')
        await rec.state(slot!.slotId, (x) => x.status === 'running', 15_000, 'running')
      }
      const monitor = lagMonitor()
      // Stop all five at once (five taskkills on the work lane) while the sampler fires every 300 ms.
      await Promise.all(ids.map((slotId) => rec.client.request({ t: 'stop', slotId })))
      await waitUntil(() => daemon.slots().filter((s) => ids.includes(s.slotId)).every((s) => s.status === 'exited' || s.pid === undefined), 20_000, 'all stopped')
      const max = monitor.stop()
      assert.ok(max < LAG_LIMIT_MS, `the loop stalled ${max.toFixed(0)} ms while stopping 5 panels with the sampler running`)
      assert.ok(!logs.some((m) => m.includes('memory sample failed')), `memory sample: ${logs.filter((m) => m.includes('memory sample')).join('; ')}`)
    } finally {
      for (const d of daemons.splice(0)) await d.close()
      await executor.close()
    }
  })

  test('a forced memory sample (60 s sampler) and a start-time query leave the loop free', async () => {
    const executor = createExecutor({ mode: 'worker' })
    try {
      await executor.run('startTimeInfo', [])
      const monitor = lagMonitor()
      const [rows, started] = await Promise.all([executor.run('sampleProcessTable', []), executor.run('startTime', [process.pid])])
      const max = monitor.stop()
      assert.ok(rows.some((r) => r.pid === process.pid), 'the table lists this process')
      assert.ok(started !== null && !Number.isNaN(Date.parse(started)), `start time: ${started}`)
      assert.ok(max < LAG_LIMIT_MS, `the loop stalled ${max.toFixed(0)} ms during one sample and one start-time query`)
    } finally {
      await executor.run('stopStartTimeHelper', []).catch(() => null)
      await executor.close()
    }
  })
})
