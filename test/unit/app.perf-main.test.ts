import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildPerfGet } from '../../app/main/perf-main.ts'
import type { PerfSnapshot } from '../../src/core/perf.ts'
import type { Reply } from '../../src/daemon/protocol.ts'

const snap = (now: number): PerfSnapshot => ({ now, intervalMs: 1000, samples: [], incidents: [], dropped: {} })

function clock(...ticks: number[]): () => number { let i = 0; return () => ticks[Math.min(i++, ticks.length - 1)]! }

test('buildPerfGet: daemon ok pairs both snapshots and the round trip', async () => {
  let asked: unknown
  const r = await buildPerfGet(snap(1), async body => { asked = body; return { t: 'ok', id: 1, perf: snap(2) } as Reply }, 50, 2000, clock(100, 112))
  assert.deepEqual(asked, { t: 'perf', since: 50 })
  assert.equal(r.main.now, 1)
  assert.equal(r.daemon?.now, 2)
  assert.equal(r.daemonRttMs, 12)
})

test('buildPerfGet: no since sends no since', async () => {
  let asked: unknown
  await buildPerfGet(snap(1), async body => { asked = body; return { t: 'ok', id: 1, perf: snap(2) } as Reply })
  assert.deepEqual(asked, { t: 'perf' })
})

test('buildPerfGet: a daemon that throws or refuses (old: bad-request) yields null', async () => {
  const main = snap(1)
  const thrown = await buildPerfGet(main, async () => { throw new Error('gone') })
  assert.deepEqual(thrown, { main, daemon: null, daemonRttMs: null })
  const old = await buildPerfGet(main, async () => ({ t: 'error', id: -1, code: 'bad-request', message: 'x' }) as Reply)
  assert.deepEqual(old, { main, daemon: null, daemonRttMs: null })
  const noPerf = await buildPerfGet(main, async () => ({ t: 'ok', id: 1 }) as Reply)
  assert.equal(noPerf.daemon, null)
})

test('buildPerfGet: a daemon that does not answer in time yields null', async () => {
  const main = snap(1)
  const r = await buildPerfGet(main, () => new Promise<Reply>(() => {}), undefined, 20)
  assert.deepEqual(r, { main, daemon: null, daemonRttMs: null })
})
