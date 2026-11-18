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
