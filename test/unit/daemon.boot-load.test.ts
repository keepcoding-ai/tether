// Boot with many slots: the daemon listens once the metas are in memory; the events, bindings, titles and rondas of the slots
// load afterwards in the background, a few at a time, without holding the loop. Until a slot is loaded its state simply lacks
// those fields; once all are, `list` carries what a synchronous boot used to.
import assert from 'node:assert/strict'
import { appendFileSync, writeFileSync } from 'node:fs'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { after, test } from 'node:test'
import type { AgentAdapter, LaunchPlan } from '../../src/agents/types.ts'
import type { SlotMeta, TetherEvent } from '../../src/core/event.ts'
import { perf } from '../../src/core/perf.ts'
import { slotEventsPath, slotRondaPath } from '../../src/core/paths.ts'
import { createSlot } from '../../src/core/store.ts'
import { startDaemon, type Daemon, type FsProbeOp } from '../../src/daemon/server.ts'
import { Recorder, removeHome, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

const N = 200
const SYNC_STEP_MAX_MS = 50

function inertPlan(cwd: string): LaunchPlan {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  return { command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd, env }
}
const fakeSoul: AgentAdapter = { name: 'soul', plan: (input) => inertPlan(input.resume?.cwd ?? input.slot.cwd), sessionExists: async () => 'unknown', title: async () => undefined }

const homes: string[] = []
const daemons: Daemon[] = []
after(async () => {
  for (const d of daemons) await d.close()
  for (const h of homes) await removeHome(h)
})

const id = (i: number): string => `bl${String(i).padStart(6, '0')}`
const meta = (i: number, cwd: string): SlotMeta => ({ v: 1, slotId: id(i), agent: 'soul', cwd, args: [], createdAt: `2026-10-01T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z` })
const line = (i: number, kind: TetherEvent['kind'], ts: string, extra: Partial<TetherEvent> = {}): string =>
  JSON.stringify({ v: 1, ts, slotId: id(i), agent: 'soul', kind, source: 'test', sessionId: `sess-${i}`, ...extra }) + '\n'
const lastTs = (i: number): string => `2026-11-0${1 + (i % 3)}T12:${String(i % 60).padStart(2, '0')}:00.000Z`

test('boot of 200 slots: listens at once, loads the files in the background in small steps, and ends with the same list', async () => {
  const home = tempHome()
  homes.push(home)
  for (let i = 0; i < N; i++) {
    createSlot(home, meta(i, home))
    // a realistic file: a start, then renames (a few slots carry a long history: ~100 KB)
    const renames = i % 25 === 0 ? 900 : 40
    let text = line(i, 'start', '2026-11-01T10:00:00.000Z', { title: 'inicio' })
    for (let k = 0; k < renames; k++) text += line(i, 'rename', `2026-11-01T10:${String(k % 60).padStart(2, '0')}:00.000Z`, { title: `titulo ${k}` })
    text += line(i, 'rename', lastTs(i), { title: `final ${i}` })
    writeFileSync(slotEventsPath(home, i === 0 ? id(0) : id(i)), text)
    if (i % 50 === 7) writeFileSync(slotRondaPath(home, id(i)), JSON.stringify({ v: 1, intervalMs: 600_000, nextAt: '2099-01-01T00:00:00.000Z', nudge: 'segue', createdAt: '2026-11-01T00:00:00.000Z' }))
  }
  const ops: { op: FsProbeOp; slotId?: string }[] = []
  const t0 = performance.now()
  const daemon = await startDaemon({ home, pipe: uniquePipe(home), readyFallbackMs: 60_000, minAgentAgeMs: 0, memoryIntervalMs: 0, adapters: { soul: fakeSoul }, backgroundBoot: true, fsProbe: (op, slotId) => { ops.push(slotId === undefined ? { op } : { op, slotId }) } })
  daemons.push(daemon)
  const listenMs = performance.now() - t0
  const rec = await Recorder.connect(daemon.pipe)

  // Listening with every slot known, before the files of the last ones are in.
  const early = (await rec.client.request({ t: 'list' })).slots!
  assert.equal(early.length, N)
  assert.ok(early.some((s) => s.binding === undefined), 'some slot is still waiting for its events')
  assert.ok(early.every((s) => s.status === 'exited' && s.kind === 'soul' && s.cwd === home), 'what the meta tells is there from the start')

  await daemon.hydrated()
  assert.equal(ops.filter((o) => o.op === 'slots:scan').length, 1)
  assert.equal(ops.filter((o) => o.op === 'events:full').length, N, 'one load per slot')
  assert.ok(listenMs < 5_000, `listen took ${listenMs.toFixed(0)} ms`)

  const { slots } = await rec.client.request({ t: 'list' })
  assert.equal(slots!.length, N)
  for (let i = 1; i < N; i++) {
    const s = slots!.find((x) => x.slotId === id(i))!
    assert.equal(s.binding?.sessionId, `sess-${i}`)
    assert.equal(s.binding?.title, `final ${i}`)
    assert.equal(s.endedAt, lastTs(i), 'an inactive slot reports its last event')
    assert.equal(s.idleSince, lastTs(i))
    assert.equal(s.ronda !== undefined, i % 50 === 7, 'the ronda files are loaded')
  }
  // The clients that were connected during the load heard about the new fields.
  const heard = rec.states.find((s) => s.slotId === id(N - 1) && s.binding?.title === `final ${N - 1}`)
  assert.ok(heard, 'a state broadcast carries the loaded binding')
  appendFileSync(slotEventsPath(home, id(5)), line(5, 'rename', '2026-11-05T00:00:00.000Z', { title: 'depois' }))
  await waitUntil(() => rec.states.some((s) => s.slotId === id(5) && s.binding?.title === 'depois'), 5_000, 'a later append is still followed')
  rec.close()
})

test('a start that arrives before the files of the slot are in waits for them and resumes the session they name', async () => {
  const home = tempHome()
  homes.push(home)
  for (let i = 0; i < N; i++) {
    createSlot(home, meta(i, home))
    writeFileSync(slotEventsPath(home, id(i)), line(i, 'start', '2026-11-01T10:00:00.000Z', { title: 'inicio' }))
  }
  const daemon = await startDaemon({ home, pipe: uniquePipe(home), readyFallbackMs: 60_000, minAgentAgeMs: 0, memoryIntervalMs: 0, adapters: { soul: fakeSoul }, backgroundBoot: true })
  daemons.push(daemon)
  const rec = await Recorder.connect(daemon.pipe)
  const last = id(0) // the oldest: the last one the background load reaches
  const before = (await rec.client.request({ t: 'list' })).slots!.find((x) => x.slotId === last)!
  assert.equal(before.binding, undefined, 'its events are not in yet')
  const started = (await rec.client.request({ t: 'start', slotId: last })).slot!
  assert.equal(started.binding?.sessionId, 'sess-0')
  assert.notEqual(started.status, 'error')
  await daemon.hydrated()
  rec.close()
})

test('no synchronous stretch of the boot of 200 slots holds the loop for long (retried: parallel test files share the CPU)', async () => {
  const home = tempHome()
  homes.push(home)
  for (let i = 0; i < N; i++) {
    createSlot(home, meta(i, home))
    let text = line(i, 'start', '2026-11-01T10:00:00.000Z', { title: 'inicio' })
    for (let k = 0; k < (i % 25 === 0 ? 900 : 40); k++) text += line(i, 'rename', `2026-11-01T10:${String(k % 60).padStart(2, '0')}:00.000Z`, { title: `titulo ${k}` })
    writeFileSync(slotEventsPath(home, id(i)), text)
  }
  const results: string[] = []
  for (let attempt = 0; attempt < 3; attempt++) {
    const loadBefore = perf.snapshot(0).labels?.['boot:load']?.totalMs ?? 0
    const lag = monitorEventLoopDelay({ resolution: 1 })
    const daemon = await startDaemon({ home, pipe: uniquePipe(home), readyFallbackMs: 60_000, minAgentAgeMs: 0, memoryIntervalMs: 0, adapters: { soul: fakeSoul }, backgroundBoot: true })
    lag.enable() // the daemon listens: what follows is the background load
    await daemon.hydrated()
    lag.disable()
    await daemon.close()
    const loadMs = (perf.snapshot(0).labels?.['boot:load']?.totalMs ?? 0) - loadBefore
    const p99 = lag.percentile(99) / 1e6
    results.push(`boot:load ${loadMs.toFixed(0)} ms, load-phase loop lag p99 ${p99.toFixed(0)} ms`)
    if (loadMs < SYNC_STEP_MAX_MS && p99 < SYNC_STEP_MAX_MS) return
  }
  assert.fail(`every boot held the loop too long: ${results.join('; ')}`)
})
