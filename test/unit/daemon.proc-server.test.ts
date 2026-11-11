// tetherd's proc-* requests against a tether-procd host running in this process: start, refusals, stop with who
// and why, a process that ends by itself (never restarted), recipe change, forget, and a tetherd restart that finds
// the process still running in the host (closing tetherd never touches the host).
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { after, before, describe, test } from 'node:test'
import { procCardPath } from '../../src/core/paths.ts'
import { DaemonError } from '../../src/daemon/client.ts'
import { pendingNotices } from '../../src/daemon/notices.ts'
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

  test('proc-attach: the scrollback, then proc-data to the attached client only; proc-detach stops it; no way to write', async () => {
    const other = await Recorder.connect(daemon.pipe)
    try {
      const mine: string[] = []
      const theirs: string[] = []
      rec.client.on('proc-data', (name, data) => { if (name === 'web') mine.push(data) })
      other.client.on('proc-data', (_name, data) => theirs.push(data))
      const r = await rec.client.request({ t: 'proc-attach', name: 'web' })
      assert.equal(typeof r.scrollback, 'string', 'the host holds this run')
      await waitUntil(() => mine.join('').includes('tick'), 5_000, 'live output')
      assert.deepEqual(theirs, [], 'only the attached client hears the output')
      await assert.rejects(rec.client.request({ t: 'proc-attach', name: 'nada' }), (e: Error) => e instanceof DaemonError && e.code === 'unknown-proc')
      await rec.client.request({ t: 'proc-detach', name: 'web' })
      await new Promise((res) => setTimeout(res, 150))
      const n = mine.length
      await new Promise((res) => setTimeout(res, 400))
      assert.equal(mine.length, n, 'no output after detach')
      // A client that goes away is let go of: attaching it and closing it leaves the next attach working.
      await other.client.request({ t: 'proc-attach', name: 'web' })
    } finally {
      other.close()
    }
    const again = await rec.client.request({ t: 'proc-attach', name: 'web' })
    assert.match(again.scrollback ?? '', /tick/)
    await rec.client.request({ t: 'proc-detach', name: 'web' })
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

describe('daemon: ports and declared uses through an in-process host', () => {
  const home = tempHome()
  const hostPipe = uniquePipe(home)
  let host: ProcHost
  let daemon: Daemon
  let rec: Recorder
  const boot = async (): Promise<void> => {
    daemon = await startDaemon({ home, pipe: uniquePipe(home), memoryIntervalMs: 0, connectProcHost: () => HostClient.open(hostPipe), procHostReconnectMs: 300, rondaAllowSeconds: true })
    rec = await Recorder.connect(daemon.pipe)
  }
  const recipe = (script: string, over: Record<string, unknown> = {}) => ({ command: 'node', args: ['-e', script], cwd: home, ...over })
  const listen = (port: number) => `require("net").createServer().listen(${port}, "127.0.0.1"); setInterval(() => {}, 1000)`
  let A = ''
  let B = ''
  const byA = () => ({ slotId: A, user: 'guga' })
  const byB = () => ({ slotId: B, user: 'guga' })
  const kinds = (name: string) => readProcEvents(home, name).map((e) => e.kind)
  const pid = async (name: string) => (await rec.client.request({ t: 'proc-info', name })).proc!.pid!
  const freePort = () => new Promise<number>((res) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)) }) })

  before(async () => {
    host = new ProcHost({ home, pipe: hostPipe })
    await host.listen()
    await boot()
    A = (await rec.client.request({ t: 'create', kind: 'shell', cwd: home, name: 'painel-a' })).slot!.slotId
    B = (await rec.client.request({ t: 'create', kind: 'shell', cwd: home, name: 'painel-b' })).slot!.slotId
  })
  after(async () => {
    rec?.close()
    await daemon?.close()
    await host?.close()
    await removeHome(home)
  })

  test('a declared port that already listens refuses the start with who holds it; --force starts anyway', async () => {
    const port = await freePort()
    const outside = createServer()
    await new Promise<void>((r) => outside.listen(port, '127.0.0.1', () => r()))
    try {
      await assert.rejects(rec.client.request({ t: 'proc-start', name: 'ocupa', recipe: recipe(SERVE, { ports: [port] }) }),
        (e: Error) => e instanceof DaemonError && e.code === 'port-busy' && new RegExp(`porta ${port} já está ocupada por fora do tether: .*pid ${process.pid}`).test(e.message))
      assert.equal(existsSync(procCardPath(home, 'ocupa')), false, 'a refused start registers nothing')
      const rows = (await rec.client.request({ t: 'proc-ports', check: port })).ports!
      assert.equal(rows[0]!.listening, true)
      assert.equal(rows[0]!.outside, true)
      assert.equal(rows[0]!.owner?.pid, process.pid)
      const s = (await rec.client.request({ t: 'proc-start', name: 'ocupa', recipe: recipe(SERVE, { ports: [port] }), force: true })).proc!
      assert.equal(s.status, 'running')
      assert.deepEqual(s.ports, [{ port, listening: true }])
    } finally {
      await new Promise<void>((r) => outside.close(() => r()))
    }
    await rec.client.request({ t: 'proc-stop', name: 'ocupa' })
  })

  test('two processes declaring one port: the second start names the first; the view shows the owner by name', async () => {
    const port = await freePort()
    const first = (await rec.client.request({ t: 'proc-start', name: 'svc', recipe: recipe(listen(port), { ports: [port] }), by: byA() })).proc!
    await assert.rejects(rec.client.request({ t: 'proc-start', name: 'svc2', recipe: recipe(SERVE, { ports: [port] }) }),
      (e: Error) => e instanceof DaemonError && e.code === 'port-busy' && /declarada por svc, que está rodando/.test(e.message))
    let row
    for (let i = 0; i < 50 && !row?.listening; i++) { row = (await rec.client.request({ t: 'proc-ports', check: port })).ports![0]; await new Promise((r) => setTimeout(r, 100)) }
    assert.equal(row!.owner?.proc, 'svc')
    assert.equal(row!.owner?.pid, first.pid)
    assert.deepEqual(row!.declaredBy, [{ name: 'svc', status: 'running' }])
    const all = (await rec.client.request({ t: 'proc-ports' })).ports!
    assert.ok(all.some((r) => r.port === port && r.owner?.proc === 'svc'))
  })

  test('use: purpose required, 60m ceiling, shown in the state', async () => {
    await assert.rejects(rec.client.request({ t: 'proc-use', name: 'svc', purpose: ' ', by: byA() }), /diga para quê/)
    await assert.rejects(rec.client.request({ t: 'proc-use', name: 'svc', duration: '2h', purpose: 'x', by: byA() }), /o máximo é 1h/)
    const s = (await rec.client.request({ t: 'proc-use', name: 'svc', duration: '10m', purpose: 'e2e do checkout', by: byA() })).proc!
    assert.equal(s.uses?.length, 1)
    assert.equal(s.uses![0]!.by.slotId, A)
    assert.equal(s.uses![0]!.purpose, 'e2e do checkout')
    assert.ok(kinds('svc').includes('use-declared'))
  })

  test('restart by another panel while in use: refused with the board, nothing restarted, the user hears it', async () => {
    const before = await pid('svc')
    await assert.rejects(rec.client.request({ t: 'proc-restart', name: 'svc', by: byB() }),
      (e: Error) => e instanceof DaemonError && e.code === 'proc-in-use' && /painel-a \(shell\) até .*: e2e do checkout/.test(e.message) && /--wait/.test(e.message) && /--force "motivo"/.test(e.message))
    assert.equal(await pid('svc'), before)
    assert.equal(kinds('svc').at(-1), 'refused-in-use')
    assert.ok(pendingNotices(home, A).some((n) => /\[tether\] processos: painel-b \(shell\) quer reiniciar svc; seu uso vai até .*tether proc release svc/.test(n.text)))
  })

  test('--wait: the act runs once the use is released', async () => {
    const before = await pid('svc')
    const p = rec.client.request({ t: 'proc-restart', name: 'svc', by: byB(), waitMs: 10_000 })
    await new Promise((r) => setTimeout(r, 400))
    assert.equal(await pid('svc'), before, 'still waiting')
    const rel = await rec.client.request({ t: 'proc-release', name: 'svc', by: byA() })
    assert.equal(rel.released, true)
    const s = (await p).proc!
    assert.notEqual(s.pid, before)
  })

  test('--force "motivo": runs now, recorded with the reason over whose use; the user hears who and why; the use stays', async () => {
    await rec.client.request({ t: 'proc-use', name: 'svc', purpose: 'carga', by: byA() })
    const before = await pid('svc')
    await assert.rejects(rec.client.request({ t: 'proc-restart', name: 'svc', by: byB(), force: '' }), /motivo/)
    const s = (await rec.client.request({ t: 'proc-restart', name: 'svc', by: byB(), force: 'corrigi o parser' })).proc!
    assert.notEqual(s.pid, before)
    const forced = readProcEvents(home, 'svc').find((e) => e.kind === 'forced')!
    assert.equal(forced.reason, 'corrigi o parser')
    assert.equal(forced.over![0]!.by.slotId, A)
    assert.ok(pendingNotices(home, A).some((n) => /svc foi reiniciado por painel-b \(shell\), à força sobre o seu uso, motivo: "corrigi o parser"/.test(n.text)))
    assert.equal(s.uses?.length, 1, 'the use goes on over the new run')
  })

  test('a use runs out by itself (seconds in tests) and survives a tetherd restart until then', async () => {
    await rec.client.request({ t: 'proc-use', name: 'svc', duration: '3s', purpose: 'curto', by: byA() })
    rec.close()
    await daemon.close()
    await boot()
    assert.equal((await rec.client.request({ t: 'proc-info', name: 'svc' })).proc!.uses?.length, 1, 'kept across the restart')
    await waitUntil(() => kinds('svc').at(-1) === 'use-expired', 8_000, 'use-expired')
    assert.equal((await rec.client.request({ t: 'proc-info', name: 'svc' })).proc!.uses, undefined)
    assert.ok(pendingNotices(home, A).some((n) => /seu uso de svc venceu às/.test(n.text)))
  })

  test('the process ends by itself: the panels that use it hear the code', async () => {
    await rec.client.request({ t: 'proc-start', name: 'curto', recipe: recipe('setTimeout(() => process.exit(5), 1500)') })
    await rec.client.request({ t: 'proc-use', name: 'curto', purpose: 'olhar', by: byA() })
    await waitUntil(() => kinds('curto').includes('ended'), 10_000, 'curto ended')
    assert.ok(pendingNotices(home, A).some((n) => /curto encerrou sozinho às .* com código 5/.test(n.text)))
  })

  test('the panel is forgotten: its uses end, and the panel refused meanwhile hears the process is free', async () => {
    await rec.client.request({ t: 'proc-use', name: 'svc', purpose: 'de novo', by: byA() })
    await assert.rejects(rec.client.request({ t: 'proc-stop', name: 'svc', by: byB() }), (e: Error) => e instanceof DaemonError && e.code === 'proc-in-use')
    assert.ok(!pendingNotices(home, B).some((n) => /svc ficou livre/.test(n.text)))
    await rec.client.request({ t: 'forget', slotId: A })
    assert.ok(pendingNotices(home, B).some((n) => /svc ficou livre/.test(n.text)))
    const s = (await rec.client.request({ t: 'proc-info', name: 'svc' })).proc!
    assert.equal(s.uses, undefined)
    const last = readProcEvents(home, 'svc').at(-1)!
    assert.equal(last.kind, 'use-released')
    assert.equal(last.cause, 'panel-gone')
    await rec.client.request({ t: 'proc-stop', name: 'svc', by: byB() })
  })
})
