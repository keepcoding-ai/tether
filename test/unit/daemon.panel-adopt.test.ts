// tetherd and the panes in the terminal-pane host (E1.7), with a host running in this process: a `direct` client (the app)
// gets no output of a hosted pane through tetherd but does of an in-process one; `typed` only feeds the attention; and a
// tetherd that dies without stopping anything is followed by one that ADOPTS the host's live panes (same pid, the host's
// ring as scrollback) instead of reaping them, leaving alone a live run that is no slot of its home.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { clearRun, readRun, removeSlot, writeRun } from '../../src/core/store.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { HostClient } from '../../src/procd/client.ts'
import { ProcHost } from '../../src/procd/host.ts'
import { pidAlive, Recorder, removeHome, sleep, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

/** The pid of a process that already exited (a tetherd that died). */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  const pid = child.pid!
  await new Promise((r) => child.once('exit', r))
  return pid
}

describe('daemon: direct clients, typed, adoption of hosted panes', () => {
  const home = tempHome()
  const cwd = join(home, 'work')
  const hostPipe = uniquePipe(home)
  let host: ProcHost
  let daemon: Daemon
  let rec: Recorder
  let direct: Recorder
  const connectPanelHost = (launch: boolean): Promise<HostClient | undefined> => (launch ? HostClient.open(hostPipe) : HostClient.tryOpen(hostPipe))
  const boot = (): Promise<Daemon> => startDaemon({ home, pipe: uniquePipe(home), memoryIntervalMs: 0, panelHost: true, connectPanelHost })

  before(async () => {
    mkdirSync(cwd)
    mkdirSync(join(home, 'host'))
    host = new ProcHost({ home: join(home, 'host'), pipe: hostPipe, persist: false })
    await host.listen()
    daemon = await boot()
    rec = await Recorder.connect(daemon.pipe)
    direct = await Recorder.connect(daemon.pipe, { direct: true })
  })
  after(async () => {
    rec?.close()
    direct?.close()
    await daemon?.close()
    await host?.close() // its live runs die with it
    await removeHome(home)
  })

  let slotId: string
  let pid: number
  let orphanId: string
  let orphanPid: number

  test('a direct client gets no data nor scrollback of a hosted pane; a plain client gets both', async () => {
    const { slot } = await rec.client.request({ t: 'create', kind: 'shell', cwd, start: true })
    slotId = slot!.slotId
    pid = slot!.pid!
    assert.equal(slot!.ptyHost, true)
    await rec.client.request({ t: 'attach', slotId, cols: 100, rows: 30 })
    const d = await direct.client.request({ t: 'attach', slotId, cols: 100, rows: 30 })
    assert.equal(d.scrollback, undefined, 'no scrollback of a hosted pane for a direct client')
    rec.client.input(slotId, "Write-Output ('antes-' + 'da-morte')\r")
    await rec.see(slotId, /antes-da-morte/)
    await sleep(300)
    assert.equal(direct.text(slotId), '', 'no data of a hosted pane for a direct client')
    const late = await rec.client.request({ t: 'attach', slotId, cols: 100, rows: 30 })
    assert.match(late.scrollback!, /antes-da-morte/)
  })

  test('typed feeds the attention and writes nothing to the pane', async () => {
    rec.client.input(slotId, "Write-Output ([char]7 + 'sino')\r")
    await rec.state(slotId, (s) => s.attention !== undefined, 15_000, 'attention after a bell')
    const n = rec.states.length
    direct.client.typed(slotId, "Write-Output ('nao-' + 'escrito')\r")
    await waitUntil(() => rec.states.slice(n).some((s) => s.slotId === slotId && s.attention === undefined), 10_000, 'attention cleared by typed')
    rec.client.input(slotId, "Write-Output ('depois-' + 'do-typed')\r")
    await rec.see(slotId, /depois-do-typed/)
    assert.doesNotMatch(rec.text(slotId), /nao-/, 'typed never reaches the PTY')
  })

  test('a tetherd that dies without stopping is followed by one that adopts the live panes, reaping nothing', async () => {
    // A second hosted pane whose slot will be gone: a live run that belongs to no slot of this home.
    const { slot } = await rec.client.request({ t: 'create', kind: 'shell', cwd, start: true })
    orphanId = slot!.slotId
    orphanPid = slot!.pid!
    await waitUntil(() => readRun(home, slotId)?.agentPid === pid, 10_000, 'run file of the slot')
    const run = readRun(home, slotId)!
    rec.close()
    direct.close()
    await daemon.abandon()
    assert.ok(pidAlive(pid) && pidAlive(orphanPid), 'a hard death leaves the hosted panes alive')
    // The run file now names a tetherd that is gone, with the agent's true identity: exactly what the reaper kills.
    writeRun(home, slotId, { ...run, pid: await deadPid(), startedAt: '2000-01-01T00:00:00.000Z' })
    removeSlot(home, orphanId)
    clearRun(home, orphanId)

    daemon = await boot()
    rec = await Recorder.connect(daemon.pipe)
    direct = await Recorder.connect(daemon.pipe, { direct: true })
    const s = daemon.slots().find((x) => x.slotId === slotId)!
    assert.equal(s.status, 'running')
    assert.equal(s.pid, pid, 'the same process, adopted')
    assert.equal(s.ptyHost, true)
    assert.ok(pidAlive(pid), 'the adopted pane was not reaped')
    assert.ok(pidAlive(orphanPid), 'a live run with no slot is left running')
    assert.equal(daemon.slots().some((x) => x.slotId === orphanId), false)
    const attached = await rec.client.request({ t: 'attach', slotId, cols: 100, rows: 30 })
    assert.match(attached.scrollback!, /antes-da-morte/, 'the scrollback comes from the host ring')
    await waitUntil(() => readRun(home, slotId)?.pid === daemon.pid && readRun(home, slotId)?.agentPid === pid, 10_000, 'run file rewritten by the new tetherd')
    rec.client.input(slotId, "Write-Output ('depois-' + 'da-volta')\r")
    await rec.see(slotId, /depois-da-volta/)
    await sleep(300)
    assert.doesNotMatch(direct.text(slotId), /depois-da-volta/, 'still no hosted data for a direct client after adoption')
  })

  test('stop of an adopted pane kills it by pid', async () => {
    const stopped = await rec.client.request({ t: 'stop', slotId })
    assert.equal(stopped.slot!.status, 'exited')
    await waitUntil(() => !pidAlive(pid), 10_000, 'adopted shell gone')
    assert.ok(pidAlive(orphanPid), 'the run with no slot is still untouched')
  })
})

describe('daemon: a direct client and an in-process pane', () => {
  test('in-process output reaches a direct client as it reaches anyone', async () => {
    const home = tempHome()
    const cwd = join(home, 'work')
    mkdirSync(cwd)
    const daemon = await startDaemon({ home, pipe: uniquePipe(home), memoryIntervalMs: 0, panelHost: false, connectPanelHost: async () => undefined })
    const rec = await Recorder.connect(daemon.pipe)
    const direct = await Recorder.connect(daemon.pipe, { direct: true })
    try {
      const { slot } = await rec.client.request({ t: 'create', kind: 'shell', cwd, start: true })
      const slotId = slot!.slotId
      assert.equal(slot!.ptyHost, undefined)
      await rec.client.request({ t: 'attach', slotId, cols: 100, rows: 30 })
      const d = await direct.client.request({ t: 'attach', slotId, cols: 100, rows: 30 })
      assert.equal(typeof d.scrollback, 'string', 'an in-process pane keeps its scrollback for a direct client')
      rec.client.input(slotId, "Write-Output ('em-' + 'processo')\r")
      await rec.see(slotId, /em-processo/)
      await direct.see(slotId, /em-processo/)
    } finally {
      rec.close()
      direct.close()
      await daemon.close()
      await removeHome(home)
    }
  })
})
