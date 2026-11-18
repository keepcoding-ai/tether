// Key->echo probe through the daemon in-process: a probed input comes back on the slot's next `data` event
// with the client's stamps plus tetherd's arrive / write / out, in non-decreasing order.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { DAEMON_LABELS, extendProbe, startProbe, type Probe } from '../../src/core/perf-probe.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { Recorder, removeHome, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

let home: string
let daemon: Daemon
let c: Recorder
const probes: Probe[] = []

before(async () => {
  home = tempHome()
  daemon = await startDaemon({ home, pipe: uniquePipe(home) })
  c = await Recorder.connect(daemon.pipe)
  c.client.on('data', (_id, _data, probe) => { if (probe) probes.push(probe) })
})
after(async () => {
  c.close()
  await daemon.close()
  await removeHome(home)
})

test('a probed input returns on the first data after the write, with the daemon stamps appended', async () => {
  const { slot } = await c.client.request({ t: 'create', kind: 'shell', cwd: home, start: true })
  const slotId = slot!.slotId
  await c.client.request({ t: 'attach', slotId, cols: 100, rows: 30 })
  await c.see(slotId, /\S/) // the prompt
  await new Promise((r) => setTimeout(r, 1500)) // let the shell settle so the echo is the next output
  assert.equal(probes.length, 0, 'no probe without a probed input')

  const first = startProbe(42)
  const sent = extendProbe(first)
  c.client.input(slotId, 'x', sent)
  await waitUntil(() => probes.length > 0, 10_000, 'the probe on a data event')

  const got = probes[0]!
  assert.equal(got.seq, 42)
  assert.equal(got.t.length, sent.t.length + DAEMON_LABELS.length)
  assert.deepEqual(got.t.slice(0, sent.t.length), sent.t)
  for (let i = 1; i < got.t.length; i++) assert.ok(got.t[i]! >= got.t[i - 1]!, `stamp ${i} is not before stamp ${i - 1}`)
  assert.ok(got.t[got.t.length - 1]! - got.t[0]! < 5_000)

  // Consumed: unprobed output after it carries none.
  const n = probes.length
  c.client.input(slotId, 'y')
  await c.see(slotId, /y/)
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(probes.length, n)
  await c.client.request({ t: 'stop', slotId }).catch(() => undefined)
})
