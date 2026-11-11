// tetherd's proc-* requests against a tether-procd host running in this process: start, refusals, stop with who
// and why, a process that ends by itself (never restarted), recipe change, forget, and a tetherd restart that finds
// the process still running in the host (closing tetherd never touches the host).
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'
import { procCardPath } from '../../src/core/paths.ts'
import { DaemonError } from '../../src/daemon/client.ts'
import { readProcEvents, type ProcState } from '../../src/daemon/procs.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { HostClient } from '../../src/procd/client.ts'
import { ProcHost } from '../../src/procd/host.ts'
import { pidAlive, Recorder, removeHome, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

const SERVE = 'setInterval(() => console.log("tick"), 100)'
const EXIT7 = 'console.log("vou sair com 7"); setTimeout(() => process.exit(7), 300)'

describe('daemon: background processes through an in-process host', () => {
  const home = tempHome()
  const hostPipe = uniquePipe(home)
  let host: ProcHost
  let daemon: Daemon
  let rec: Recorder
  const boot = async (): Promise<void> => {
    daemon = await startDaemon({ home, pipe: uniquePipe(home), memoryIntervalMs: 0, connectProcHost: () => HostClient.open(hostPipe), procHostReconnectMs: 300 })
    rec = await Recorder.connect(daemon.pipe)
  }
  const procs: ProcState[] = []
  const recipe = (script: string, over: Record<string, unknown> = {}) => ({ command: 'node', args: ['-e', script], cwd: home, ...over })

  before(async () => {
    host = new ProcHost({ home, pipe: hostPipe })
    await host.listen()
    await boot()
    rec.client.on('proc', (p) => procs.push(p))
  })
  after(async () => {
    rec?.close()
    await daemon?.close()
    await host?.close()
    await removeHome(home)
  })

  test('start: running with pid, author from the CLI, broadcast; a second start is refused with who runs it', async () => {
    const r = await rec.client.request({ t: 'proc-start', name: 'web', recipe: recipe(SERVE, { description: 'servidor' }), by: { as: 'kai', user: 'guga' } })
    assert.equal(r.proc!.status, 'running')
    assert.ok(r.proc!.pid && pidAlive(r.proc!.pid))
    assert.deepEqual(r.proc!.startedBy, { kind: 'external', user: 'guga', label: 'kai' })
    assert.ok(procs.some((p) => p.name === 'web' && p.status === 'running'), 'clients heard of it')
    await assert.rejects(rec.client.request({ t: 'proc-start', name: 'web', recipe: recipe(SERVE) }), (e: Error) => e instanceof DaemonError && e.code === 'proc-running' && /kai \(guga\)/.test(e.message))
    await assert.rejects(rec.client.request({ t: 'proc-forget', name: 'web' }), (e: Error) => e instanceof DaemonError && e.code === 'proc-not-stopped')
    await assert.rejects(rec.client.request({ t: 'proc-start', name: 'nada' }), (e: Error) => e instanceof DaemonError && e.code === 'unknown-proc')
  })

  test('closing tetherd leaves the process in the host; the next tetherd finds it running, same pid', async () => {
    const pid = (await rec.client.request({ t: 'proc-info', name: 'web' })).proc!.pid!
    rec.close()
    await daemon.close()
    assert.ok(pidAlive(pid), 'the process outlives tetherd')
    await boot()
    rec.client.on('proc', (p) => procs.push(p))
    const info = await rec.client.request({ t: 'proc-info', name: 'web' })
    assert.equal(info.proc!.status, 'running')
    assert.equal(info.proc!.pid, pid)
    assert.deepEqual(info.events!.map((e) => e.kind), ['registered', 'started'])
  })

  test('stop: Ctrl+C ends it; stopped, by whom and why; a requested stop asks no attention', async () => {
    const s = (await rec.client.request({ t: 'proc-stop', name: 'web', reason: 'fim do teste', by: { user: 'guga' } })).proc!
    assert.equal(s.status, 'stopped')
    assert.equal(s.reason, 'fim do teste')
    assert.equal(s.stoppedBy?.user, 'guga')
    assert.equal(s.attention, undefined)
    assert.equal(s.exit?.cause, 'requested')
  })

  test('a changed recipe on a stopped name is recorded before and after; the same recipe is not', async () => {
    await rec.client.request({ t: 'proc-start', name: 'web', recipe: recipe(EXIT7) })
    const kinds = readProcEvents(home, 'web').map((e) => e.kind)
    assert.equal(kinds.filter((k) => k === 'recipe-changed').length, 1)
    const changed = readProcEvents(home, 'web').find((e) => e.kind === 'recipe-changed')!
    assert.deepEqual(changed.after, { args: ['-e', EXIT7] })
    assert.deepEqual(changed.before, { args: ['-e', SERVE], description: 'servidor' })
  })

  test('ending by itself: exited with code 7 and attention, never restarted; seen clears attention', async () => {
    await waitUntil(() => procs.some((p) => p.name === 'web' && p.status === 'exited'), 10_000, 'web exited')
    const info = await rec.client.request({ t: 'proc-info', name: 'web' })
    assert.equal(info.proc!.status, 'exited')
    assert.equal(info.proc!.exit?.code, 7)
    assert.equal(info.proc!.exit?.cause, 'own')
    assert.equal(info.proc!.attention, true)
    assert.equal(info.events!.filter((e) => e.kind === 'started').length, 2, 'no restart by itself')
    await rec.client.request({ t: 'proc-seen', name: 'web' })
    assert.equal((await rec.client.request({ t: 'proc-info', name: 'web' })).proc!.attention, undefined)
  })

  test('a command that does not exist: failed with the reason; forget removes the card', async () => {
    const s = (await rec.client.request({ t: 'proc-start', name: 'ruim', recipe: { command: 'nao-existe-xyz', args: [], cwd: home } })).proc!
    assert.equal(s.status, 'failed')
    assert.match(s.error ?? '', /comando não encontrado: nao-existe-xyz/)
    await rec.client.request({ t: 'proc-forget', name: 'ruim' })
    assert.equal(existsSync(procCardPath(home, 'ruim')), false)
    assert.ok(!(await rec.client.request({ t: 'proc-list' })).procs!.some((p) => p.name === 'ruim'))
  })

  test('host status; host stop refuses with live processes unless forced, and the stop is recorded as asked', async () => {
    await rec.client.request({ t: 'proc-start', name: 'api', recipe: recipe(SERVE) })
    const h = (await rec.client.request({ t: 'proc-host' })).host!
    assert.equal(h.pid, process.pid)
    assert.equal(h.live, 1)
    await assert.rejects(rec.client.request({ t: 'proc-host-stop' }), (e: Error) => e instanceof DaemonError && e.code === 'proc-host' && /api/.test(e.message))
    await rec.client.request({ t: 'proc-host-stop', force: true, by: { user: 'guga' } })
    const api = (await rec.client.request({ t: 'proc-info', name: 'api' })).proc!
    assert.equal(api.status, 'stopped')
    assert.equal(api.reason, 'anfitrião encerrado à força')
    assert.equal((await rec.client.request({ t: 'proc-host' })).host, null)
  })
})
