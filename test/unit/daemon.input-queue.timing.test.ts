// Keys that arrive while a slot is 'starting' with no pty yet wait in a short per-slot queue and are written, in order, as soon
// as the pty is there (host spawn finished, or the boot's adoption done): they used to be dropped silently. The queue is bounded
// (the excess is dropped, counted and logged once), a launch that fails drops it, and a probed key keeps its probe.
// The host runs in this process; the launch is held by a connector that waits for a gate, the adoption by a held `attach`.
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { DaemonClient } from '../../src/daemon/client.ts'
import { INPUT_QUEUE_MAX_BYTES, startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { HostClient } from '../../src/procd/client.ts'
import { ProcHost } from '../../src/procd/host.ts'
import { Recorder, removeHome, sleep, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

interface Gate { promise: Promise<void>; open(): void }
function gate(): Gate {
  let open!: () => void
  const promise = new Promise<void>((r) => { open = r })
  return { promise, open }
}

describe('daemon: input waits for a pty that is not up yet', () => {
  const home = tempHome()
  const cwd = join(home, 'work')
  const hostPipe = uniquePipe(home)
  let host: ProcHost
  let daemon: Daemon
  let rec: Recorder
  const logs: string[] = []
  // While `launchGate` is set, a spawn in the host waits for it; `launchFails` makes it fail after the wait.
  let launchGate: Gate | undefined
  let launchFails = false
  const statusOf = (id: string): string | undefined => daemon.slots().find((s) => s.slotId === id)?.status

  before(async () => {
    mkdirSync(cwd)
    mkdirSync(join(home, 'host'))
    host = new ProcHost({ home: join(home, 'host'), pipe: hostPipe, persist: false })
    await host.listen()
    daemon = await startDaemon({
      home,
      pipe: uniquePipe(home),
      memoryIntervalMs: 0,
      panelHost: true,
      log: (m) => logs.push(m),
      // The host connection is cached after the first use, so the held spawn is a wrapper on its request.
      connectPanelHost: async (launch) => {
        const c = await (launch ? HostClient.open(hostPipe) : HostClient.tryOpen(hostPipe))
        if (!c) return c
        const request = c.request.bind(c)
        c.request = async (body) => {
          if (body.t === 'spawn' && launchGate) {
            await launchGate.promise
            if (launchFails) throw new Error('host unreachable (test)')
          }
          return request(body)
        }
        return c
      },
    })
    rec = await Recorder.connect(daemon.pipe)
  })
  after(async () => {
    rec?.close()
    await daemon?.close()
    await host?.close()
    await removeHome(home)
  })

  async function created(): Promise<string> {
    const { slot } = await rec.client.request({ t: 'create', kind: 'shell', cwd })
    return slot!.slotId
  }

  test('keys sent during the spawn are echoed after it, in order, before newer ones', async () => {
    const slotId = await created()
    await rec.client.request({ t: 'attach', slotId, cols: 100, rows: 30 })
    launchGate = gate()
    const started = rec.client.request({ t: 'start', slotId })
    await waitUntil(() => statusOf(slotId) === 'starting', 10_000, 'slot starting')
    rec.client.input(slotId, "Write-Output ('um-' + 'q1')\r")
    rec.client.input(slotId, "Write-Output ('dois-' + 'q2')\r")
    await sleep(200)
    assert.equal(rec.text(slotId), '', 'nothing echoed while the pty is not up')
    launchGate.open()
    launchGate = undefined
    await started
    rec.client.input(slotId, "Write-Output ('tres-' + 'q3')\r") // newer: after the queued ones
    await rec.see(slotId, /um-q1[\s\S]*dois-q2[\s\S]*tres-q3/)
    await rec.client.request({ t: 'stop', slotId })
  })

  test('a probed key keeps its probe through the queue and the echo carries it', async () => {
    const slotId = await created()
    await rec.client.request({ t: 'attach', slotId, cols: 100, rows: 30 })
    const probes: { seq: number; t: number[] }[] = []
    rec.client.on('data', (id, _data, probe) => { if (id === slotId && probe) probes.push(probe) })
    launchGate = gate()
    const started = rec.client.request({ t: 'start', slotId })
    await waitUntil(() => statusOf(slotId) === 'starting', 10_000, 'slot starting')
    const t0 = performance.timeOrigin + performance.now()
    rec.client.input(slotId, "Write-Output ('sonda-' + 'q4')\r", { seq: 41, t: [t0] })
    await sleep(100)
    launchGate.open()
    launchGate = undefined
    await started
    await rec.see(slotId, /sonda-q4/)
    await waitUntil(() => probes.some((p) => p.seq === 41), 10_000, 'echo carrying probe 41')
    // client stamp, daemon-arrive (at the line), daemon-write (at the real write, after the wait), daemon-out
    const p = probes.find((x) => x.seq === 41)!
    assert.equal(p.t.length, 4)
    assert.ok(p.t[2]! - p.t[1]! >= 90, 'daemon-write is stamped when the key is really written, not when it arrived')
    await rec.client.request({ t: 'stop', slotId })
  })

  test('the ceiling counts and drops the excess, logging once, and keeps what fit', async () => {
    const slotId = await created()
    await rec.client.request({ t: 'attach', slotId, cols: 100, rows: 30 })
    const before = logs.filter((l) => l.includes('input queue full')).length
    launchGate = gate()
    const started = rec.client.request({ t: 'start', slotId })
    await waitUntil(() => statusOf(slotId) === 'starting', 10_000, 'slot starting')
    const half = 'A'.repeat(INPUT_QUEUE_MAX_BYTES / 2 + 10)
    rec.client.input(slotId, half) // fits
    rec.client.input(slotId, 'B'.repeat(INPUT_QUEUE_MAX_BYTES / 2 + 10)) // would pass the ceiling: dropped
    rec.client.input(slotId, 'C'.repeat(100)) // after a drop nothing is kept (no gap in the typed text)
    await waitUntil(() => logs.filter((l) => l.includes('input queue full')).length > before, 10_000, 'overflow log')
    await sleep(200)
    assert.equal(logs.filter((l) => l.includes('input queue full')).length, before + 1, 'logged once per slot')
    launchGate.open()
    launchGate = undefined
    await started
    await rec.see(slotId, /A{200}/)
    await sleep(500)
    assert.doesNotMatch(rec.text(slotId), /B{20}|C{20}/, 'the excess never reached the pane')
    await rec.client.request({ t: 'stop', slotId })
  })

  test('a launch that fails drops the queue', async () => {
    const slotId = await created()
    await rec.client.request({ t: 'attach', slotId, cols: 100, rows: 30 })
    launchGate = gate()
    launchFails = true
    const started = rec.client.request({ t: 'start', slotId }).then(() => 'ok', () => 'failed')
    await waitUntil(() => statusOf(slotId) === 'starting', 10_000, 'slot starting')
    rec.client.input(slotId, "Write-Output ('velha-' + 'q5')\r")
    await sleep(100)
    launchGate.open()
    launchGate = undefined
    assert.equal(await started, 'failed')
    launchFails = false
    assert.equal(statusOf(slotId), 'error')
    await rec.client.request({ t: 'start', slotId }) // a later launch works and must not replay the old key
    rec.client.input(slotId, "Write-Output ('nova-' + 'q6')\r")
    await rec.see(slotId, /nova-q6/)
    assert.doesNotMatch(rec.text(slotId), /velha-q5/)
    await rec.client.request({ t: 'stop', slotId })
  })

  test('input to a stopped slot is still dropped, with no queue', async () => {
    const slotId = await created()
    await rec.client.request({ t: 'attach', slotId, cols: 100, rows: 30 })
    rec.client.input(slotId, "Write-Output ('parado-' + 'q7')\r")
    await sleep(100)
    await rec.client.request({ t: 'start', slotId })
    await sleep(500)
    assert.doesNotMatch(rec.text(slotId), /parado-q7/, 'a key sent to a slot that was not starting is not replayed later')
    await rec.client.request({ t: 'stop', slotId })
  })
})

describe('daemon: input during the boot adoption window', () => {
  const home = tempHome()
  const cwd = join(home, 'work')
  const hostPipe = uniquePipe(home)
  let host: ProcHost
  let daemon: Daemon | undefined
  let slotId: string
  let attachGate: Gate | undefined
  let attachFails = false

  /** The host connection with its `attach` held (the adoption waits for it), optionally failing after the wait. */
  const connectPanelHost = async (launch: boolean): Promise<HostClient | undefined> => {
    const c = await (launch ? HostClient.open(hostPipe) : HostClient.tryOpen(hostPipe))
    if (!c) return c
    const request = c.request.bind(c)
    c.request = async (body) => {
      if (body.t === 'attach' && attachGate) {
        await attachGate.promise
        if (attachFails) throw new Error('ended between list and attach (test)')
      }
      return request(body)
    }
    return c
  }

  before(async () => {
    mkdirSync(cwd)
    mkdirSync(join(home, 'host'))
    host = new ProcHost({ home: join(home, 'host'), pipe: hostPipe, persist: false })
    await host.listen()
    // A first tetherd launches a pane in the host and dies hard, leaving it there for the next one to adopt.
    const first = await startDaemon({ home, pipe: uniquePipe(home), memoryIntervalMs: 0, panelHost: true, connectPanelHost })
    const r = await Recorder.connect(first.pipe)
    const { slot } = await r.client.request({ t: 'create', kind: 'shell', cwd, start: true })
    slotId = slot!.slotId
    r.close()
    await first.abandon()
  })
  after(async () => {
    await daemon?.close()
    await host?.close()
    await removeHome(home)
  })

  /** Boots a tetherd whose adoption is held; resolves with a client that already sees the slot 'starting'. */
  async function bootHeld(): Promise<{ booting: Promise<Daemon>; pipe: string; client: DaemonClient }> {
    attachGate = gate()
    const pipe = uniquePipe(home)
    const booting = startDaemon({ home, pipe, memoryIntervalMs: 0, panelHost: true, connectPanelHost })
    let client: DaemonClient | undefined
    await waitUntil(() => {
      if (client) return true
      DaemonClient.open(pipe, 'test').then((c) => { client = c }, () => {})
      return false
    }, 15_000, 'the held daemon listening')
    await sleep(100)
    const listed = await client!.request({ t: 'list' })
    assert.equal(listed.slots!.find((s) => s.slotId === slotId)?.status, 'starting', 'the slot is held in starting by the adoption')
    return { booting, pipe, client: client! }
  }

  test('a failed adoption drops what waited for it', async () => {
    attachFails = true
    const { booting, client } = await bootHeld()
    client.input(slotId, "Write-Output ('perdida-' + 'q8')\r")
    await sleep(100)
    attachGate!.open()
    attachGate = undefined
    daemon = await booting
    attachFails = false
    const rec = await Recorder.connect(daemon.pipe)
    client.close()
    await sleep(300)
    // The pane stays in the host untouched: the dropped key never reached it.
    const direct = await HostClient.open(hostPipe)
    try {
      const a = await direct.request({ t: 'attach', name: slotId })
      assert.doesNotMatch(a.scrollback ?? '', /perdida-q8/)
    } finally {
      direct.close()
      rec.close()
    }
    await daemon.abandon()
    daemon = undefined
  })

  test('keys sent while the adoption is held are echoed after it, in order, before newer ones', async () => {
    const { booting, client } = await bootHeld()
    client.input(slotId, "Write-Output ('antes-' + 'q9')\r")
    client.input(slotId, "Write-Output ('meio-' + 'q10')\r")
    await sleep(200)
    attachGate!.open()
    attachGate = undefined
    daemon = await booting
    assert.equal(daemon.slots().find((s) => s.slotId === slotId)?.status, 'running')
    const rec = await Recorder.connect(daemon.pipe)
    try {
      await rec.client.request({ t: 'attach', slotId, cols: 100, rows: 30 })
      rec.client.input(slotId, "Write-Output ('depois-' + 'q11')\r")
      await rec.see(slotId, /antes-q9[\s\S]*meio-q10[\s\S]*depois-q11/)
    } finally {
      await rec.client.request({ t: 'stop', slotId }).catch(() => undefined)
      client.close()
      rec.close()
    }
  })
})
