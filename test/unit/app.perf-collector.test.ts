import assert from 'node:assert/strict'
import { test } from 'node:test'
import { termBacklog } from '../../app/renderer/perf-collector.ts'
import {
  EchoTracker, Heartbeat, isRendererReport, Ring, RendererPerfStore, WindowStats, priorityName, ECHO_TTL_MS, INCIDENT_RING_CAP,
  type RendererReport,
} from '../../app/shared/perf-renderer.ts'
import { probeResult } from '../../app/shared/probe-app.ts'

const wall = () => 1000

test('WindowStats: a frame over 200 ms is an incident and a long frame; small gaps only move the max', () => {
  const s = new WindowStats(0, wall)
  s.frameGap(16); s.frameGap(120)
  assert.equal(s.incidents.length, 0)
  s.frameGap(450)
  assert.deepEqual(s.incidents.map(i => [i.kind, i.ms]), [['long-frame', 450]])
  const out = s.flush(5000, true, new EchoTracker())
  assert.equal(out?.longFrames.count, 1)
  assert.equal(out?.rafGapMaxMs, 450)
})

test('WindowStats: timer lag, long task and rAF stall become incidents', () => {
  const s = new WindowStats(0, wall)
  s.timerLag(50); s.timerLag(2900); s.longTask(3000); s.longTask(80); s.rafStalled(1400); s.webglLost('a')
  assert.deepEqual(s.incidents.map(i => i.kind), ['timer-lag', 'long-task', 'raf-stalled', 'webgl-lost'])
})

test('WindowStats.flush: quiet window sends nothing; typing, backlog or a gap makes it notable; counters reset', () => {
  const echo = new EchoTracker()
  const s = new WindowStats(0, wall)
  s.frameGap(16); s.timerLag(3)
  assert.equal(s.flush(5000, true, echo), undefined)
  s.keyPainted(12); s.keyPainted(30)
  const typed = s.flush(10000, true, echo)
  assert.deepEqual(typed?.input, { count: 2, maxMs: 30, sumMs: 42 })
  assert.equal(s.flush(15000, true, echo), undefined)
  s.term({ slotId: 'x', kind: 'shell', renderer: 'webgl', pendingMax: 4096, sinceRenderMax: 20, webglLost: false })
  s.term({ slotId: 'x', kind: 'shell', renderer: 'webgl', pendingMax: 100, sinceRenderMax: 900, webglLost: false })
  s.term({ slotId: 'y', kind: 'agent', renderer: 'webgl', pendingMax: 0, sinceRenderMax: 20, webglLost: false })
  const t = s.flush(20000, true, echo)
  assert.deepEqual(t?.terms.map(x => [x.slotId, x.pendingMax, x.sinceRenderMax]), [['x', 4096, 900]])
})

test('WindowStats.flush: new echo samples make a window notable', () => {
  const echo = new EchoTracker(); const s = new WindowStats(0, wall)
  echo.key('a', 'shell', 0); echo.data('a', 10)
  assert.ok(s.flush(5000, true, echo))
  assert.equal(s.flush(10000, true, echo), undefined)
})

test('EchoTracker: first key of a burst waits; aggregates by kind and slot; stale keys never claim output', () => {
  const e = new EchoTracker()
  e.key('a', 'shell', 100); e.key('a', 'shell', 105)
  assert.equal(e.data('a', 112), 12)
  assert.equal(e.data('a', 113), undefined)
  e.key('b', 'agent', 0)
  assert.equal(e.data('b', ECHO_TTL_MS + 1), undefined)
  e.key('b', 'agent', 1000); assert.equal(e.data('b', 1300), 300)
  const sum = e.summary()
  assert.equal(sum.byKind.shell.count, 1)
  assert.equal(sum.byKind.shell.buckets[1], 1) // 12 ms: [8,16)
  assert.equal(sum.byKind.agent.maxMs, 300)
  assert.equal(sum.byKind.agent.buckets.at(-1), 1)
  assert.equal(sum.bySlot.b?.kind, 'agent')
})

test('EchoTracker: the per-slot table is bounded', () => {
  const e = new EchoTracker()
  for (let i = 0; i < 500; i++) { e.key('s' + i, 'shell', 0); e.data('s' + i, 5) }
  assert.ok(Object.keys(e.summary().bySlot).length <= 64)
})

test('Ring: never exceeds its cap, oldest dropped', () => {
  const r = new Ring<number>(3)
  for (let i = 0; i < 10; i++) r.push(i)
  assert.deepEqual(r.toArray(), [7, 8, 9])
})

test('RendererPerfStore: incident ring is capped; priority samples count the demotions', () => {
  const st = new RendererPerfStore()
  for (let i = 0; i < INCIDENT_RING_CAP + 20; i++) st.report({ t: 'incident', incident: { at: i, kind: 'long-frame', ms: 300 } })
  assert.equal(st.incidents.size, INCIDENT_RING_CAP)
  st.samplePriority(1, -7); st.samplePriority(2, 0); st.samplePriority(3, 10)
  const v = st.view(123, 10, 4)
  assert.equal(v.prioritySamples, 3)
  assert.equal(v.priorityBelowRaised, 2)
  assert.equal(v.priority?.name, 'BELOW_NORMAL')
  assert.equal(v.pid, 123)
})

test('priorityName maps the os.getPriority classes', () => {
  assert.deepEqual([-7, 0, 10, 19, null].map(priorityName), ['ABOVE_NORMAL', 'NORMAL', 'BELOW_NORMAL', 'IDLE', 'unknown'])
})

test('Heartbeat: round trip, missed ping and one stall per ping', () => {
  const h = new Heartbeat()
  const a = h.ping(0)
  assert.equal(h.pong(a, 7), 7)
  const b = h.ping(2000)
  assert.equal(h.check(2500), undefined)
  assert.equal(h.check(3200), 1200)
  assert.equal(h.check(3300), undefined)
  h.ping(4000) // b never answered
  assert.equal(h.pong(b, 4001), undefined)
  const v = h.view()
  assert.equal(v.count, 1); assert.equal(v.missed, 1); assert.equal(v.lastMs, 7)
})

test('isRendererReport accepts a real summary and incident, refuses garbage', () => {
  const s = new WindowStats(0, wall); s.keyPainted(5)
  const summary = s.flush(5000, true, new EchoTracker())!
  assert.ok(isRendererReport({ t: 'summary', summary } satisfies RendererReport))
  assert.ok(isRendererReport({ t: 'incident', incident: { at: 1, kind: 'long-task', ms: 3000 } }))
  assert.ok(!isRendererReport({ t: 'incident', incident: { at: 1, kind: 'nope', ms: 3 } }))
  assert.ok(!isRendererReport({ t: 'summary', summary: { ...summary, terms: new Array(100).fill({}) } }))
  assert.ok(!isRendererReport(null)); assert.ok(!isRendererReport({ t: 'x' }))
})

test('termBacklog reads xterm internals defensively', () => {
  assert.equal(termBacklog({ _core: { _writeBuffer: { _pendingData: 321 } } } as never), 321)
  assert.equal(termBacklog({} as never), 0)
  assert.equal(termBacklog({ get _core(): never { throw new Error('x') } } as never), 0)
})

test('probeResult: agentMs is the daemon-write to daemon-out time when the probe crossed tetherd', () => {
  assert.equal(probeResult('s', { seq: 1, t: [0, 1, 2, 10, 14, 15, 16] }).agentMs, 4)
  assert.equal(probeResult('s', { seq: 1, t: [0, 1] }).agentMs, undefined)
})
