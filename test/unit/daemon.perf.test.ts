// `perf` request: the daemon's ruler snapshot (pull only).
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { perf } from '../../src/core/perf.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { Recorder, removeHome, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

let home: string
let daemon: Daemon

before(async () => {
  home = tempHome()
  daemon = await startDaemon({ home, pipe: uniquePipe(home) })
})
after(async () => {
  await daemon.close()
  await removeHome(home)
})

test('perf: replies with samples and incidents, and `since` filters them', async () => {
  const c = await Recorder.connect(daemon.pipe)
  perf.incident('test-incident', { x: 1 })
  await waitUntil(() => perf.snapshot().samples.length > 0, 5_000, 'the first sample')
  const r = await c.client.request({ t: 'perf' })
  assert.ok(r.perf)
  assert.ok(r.perf.samples.length > 0)
  assert.equal(typeof r.perf.samples[0]!.maxMs, 'number')
  assert.ok(r.perf.incidents.some((i) => i.kind === 'test-incident'))
  const later = await c.client.request({ t: 'perf', since: r.perf.now + 60_000 })
  assert.equal(later.perf!.samples.length, 0)
  assert.equal(later.perf!.incidents.length, 0)
  c.client.close()
})

test('perf: a blocked request handler shows up as a slow incident with its label', async () => {
  process.env.TETHER_TEST_BLOCK = '1'
  try {
    const c = await Recorder.connect(daemon.pipe)
    await c.client.request({ t: 'debug-block', ms: 250 })
    await waitUntil(() => perf.snapshot().incidents.some((i) => i.kind === 'slow' && (i.data as { label?: string }).label === 'req:debug-block'), 5_000, 'the slow incident')
    const r = await c.client.request({ t: 'perf' })
    const slow = r.perf!.incidents.find((i) => i.kind === 'slow')!
    assert.ok((slow.data as { ms: number }).ms >= 200)
    assert.ok(r.perf!.labels!['req:debug-block']!.n >= 1)
    assert.ok(r.perf!.labels!['req:perf']!.n >= 1)
    c.client.close()
  } finally {
    delete process.env.TETHER_TEST_BLOCK
  }
})
