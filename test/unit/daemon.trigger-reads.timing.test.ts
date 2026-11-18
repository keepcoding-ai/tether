// The hook files tetherd reads when the watcher fires (the attention report, the subagent markers) go through the executor,
// with a generation per slot. With the executor in worker mode and 300 ms injected into every disk operation, a burst of 200
// hook events must not stall the loop (no gap of 100 ms or more) and must not lose the last attention seal or a marker.
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { AgentAdapter, LaunchPlan } from '../../src/agents/types.ts'
import type { SlotMeta } from '../../src/core/event.ts'
import { slotAttentionPath, slotEventsPath, slotsDir } from '../../src/core/paths.ts'
import { createSlot } from '../../src/core/store.ts'
import { createExecutor, type Executor } from '../../src/exec/executor.ts'
import { startDaemon, type Daemon, type FsProbeOp } from '../../src/daemon/server.ts'
import { Recorder, removeHome, sleep, tempHome, uniquePipe } from './daemon.helpers.ts'

function inertPlan(cwd: string): LaunchPlan {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  return { command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd, env }
}
const fakeSoul: AgentAdapter = { name: 'soul', plan: (input) => inertPlan(input.resume?.cwd ?? input.slot.cwd), sessionExists: async () => 'unknown', title: async (b) => b.title }

const homes: string[] = []
const daemons: Daemon[] = []
const executors: Executor[] = []
after(async () => {
  for (const d of daemons) await d.close()
  for (const e of executors) await e.close()
  for (const h of homes) await removeHome(h)
})

test('200 hook events with a slow disk: no loop stall of 100 ms, the last attention seal and every marker land', async () => {
  const home = tempHome()
  homes.push(home)
  const id = 'f4000001'
  const meta: SlotMeta = { v: 1, slotId: id, agent: 'soul', cwd: home, args: [], createdAt: '2026-10-01T00:00:00.000Z' }
  mkdirSync(slotsDir(home), { recursive: true })
  createSlot(home, meta)
  const ops: FsProbeOp[] = []
  const executor = createExecutor({ mode: 'worker', ioDelayMs: 300 })
  executors.push(executor)
  const daemon = await startDaemon({
    home, pipe: uniquePipe(home), readyFallbackMs: 60_000, minAgentAgeMs: 0, memoryIntervalMs: 0, adapters: { soul: fakeSoul },
    executor, fsProbe: (op) => { ops.push(op) },
  })
  daemons.push(daemon)
  const rec = await Recorder.connect(daemon.pipe)
  try {
    await rec.client.request({ t: 'start', slotId: id, choice: 'new' })
    await rec.state(id, (s) => s.status === 'starting' || s.status === 'running', 20_000, 'launched')
    appendFileSync(slotEventsPath(home, id), JSON.stringify({ v: 1, ts: new Date().toISOString(), slotId: id, agent: 'soul', kind: 'turn', source: 'turn', state: 'busy', sessionId: 's1' }) + '\n')
    await rec.state(id, (s) => s.turn === 'busy', 20_000, 'busy')

    let last = performance.now()
    let maxGap = 0
    const ticker = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now }, 5)
    const MARKERS = 20
    const t0 = Date.now()
    for (let i = 0; i < 200; i++) {
      const kind = i === 199 ? 'waiting' : i % 2 === 0 ? 'done' : 'waiting'
      // Asynchronous writes: the test's own thread is the loop under measurement, so it must not block it.
      await writeFile(slotAttentionPath(home, id), JSON.stringify({ ts: new Date(t0 + i).toISOString(), kind }))
      await writeFile(join(slotsDir(home), `${id}.bg.agent-${i % MARKERS}`), '1')
      if (i % 10 === 9) await sleep(20)
    }
    // The last seal and the marker count must arrive, however late the slow disk delivers them.
    await rec.state(id, (s) => s.attention === 'waiting' && s.background === MARKERS, 30_000, 'last seal and all markers')
    clearInterval(ticker)
    assert.ok(maxGap < 100, `the loop stalled for ${Math.round(maxGap)} ms during the burst`)
    assert.ok(ops.includes('attention:read'), 'the attention report was read through the executor')
  } finally {
    rec.close()
  }
})
