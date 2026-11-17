// `debug-block` request: test-only event-loop blocker gated by TETHER_TEST_BLOCK=1.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { busyWait } from '../../src/daemon/debug-block.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { Recorder, removeHome, tempHome, uniquePipe } from './daemon.helpers.ts'

let home: string
let daemon: Daemon
const saved = process.env.TETHER_TEST_BLOCK

before(async () => {
  home = tempHome()
  daemon = await startDaemon({ home, pipe: uniquePipe(home) })
})
after(async () => {
  if (saved === undefined) delete process.env.TETHER_TEST_BLOCK
  else process.env.TETHER_TEST_BLOCK = saved
  await daemon.close()
  await removeHome(home)
})

test('busyWait: spins until the injected clock passes ms', () => {
  let t = 0
  busyWait(5, () => t++)
  assert.ok(t >= 5)
})

test('debug-block: without the env var it is a bad-request', async () => {
  delete process.env.TETHER_TEST_BLOCK
  const c = await Recorder.connect(daemon.pipe)
  await assert.rejects(c.client.request({ t: 'debug-block', ms: 10 }), /debug-block|bad-request/)
  c.client.close()
})

test('debug-block: with the env var replies ok at once and blocks the loop', async () => {
  process.env.TETHER_TEST_BLOCK = '1'
  try {
    const c = await Recorder.connect(daemon.pipe)
    // The daemon runs in this process, so the client shares the blocked loop: the ok and the
    // following list can only be read once the busy wait ends.
    const t0 = Date.now()
    const r = await c.client.request({ t: 'debug-block', ms: 300 })
    assert.equal(r.t, 'ok')
    await c.client.request({ t: 'list' })
    assert.ok(Date.now() - t0 >= 290, `list answered after ${Date.now() - t0}ms`)
    c.client.close()
  } finally {
    if (saved === undefined) delete process.env.TETHER_TEST_BLOCK
    else process.env.TETHER_TEST_BLOCK = saved
  }
})

test('debug-block: invalid or over-ceiling ms is a bad-request', async () => {
  process.env.TETHER_TEST_BLOCK = '1'
  try {
    const c = await Recorder.connect(daemon.pipe)
    for (const ms of [0, -5, NaN, 30_001, '9' as unknown as number]) {
      await assert.rejects(c.client.request({ t: 'debug-block', ms }), /ms inválido/)
    }
    c.client.close()
  } finally {
    if (saved === undefined) delete process.env.TETHER_TEST_BLOCK
    else process.env.TETHER_TEST_BLOCK = saved
  }
})
