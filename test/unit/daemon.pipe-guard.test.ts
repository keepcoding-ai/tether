// A-1 (Temper, regência remota G0): any account of the machine can open tetherd's pipe (Windows gives Everyone and Anonymous
// read on a named pipe Node creates). These tests play that reader against a bench tetherd: a connection that never says
// hello gets no byte of what tetherd broadcasts (profiles, processes, slot states) and is dropped; it gets no answer to any
// request but the hello.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { connect, type Socket } from 'node:net'
import { after, before, describe, test } from 'node:test'
import type { ProcState, Profile } from '../../src/daemon/protocol.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { HostClient } from '../../src/procd/client.ts'
import { ProcHost } from '../../src/procd/host.ts'
import { hostStore } from '../../src/procd/run-store.ts'
import { Recorder, removeHome, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

/** A fake value, put where a secret would be: it must never reach a connection that did not identify itself. */
const CANARY = 'canario-a1-7f3e9b'
const HELLO_TIMEOUT_MS = 1_500

/** A raw connection that only listens: every byte it receives, and whether tetherd dropped it. */
interface Mute { socket: Socket; bytes: () => string; closed: () => boolean }

async function mute(pipe: string): Promise<Mute> {
  const socket = connect(pipe)
  await new Promise<void>((res, rej) => { socket.once('connect', res); socket.once('error', rej) })
  socket.setEncoding('utf8')
  let got = ''
  let closed = false
  socket.on('data', (c: string) => { got += c })
  socket.on('error', () => {})
  socket.on('close', () => { closed = true })
  return { socket, bytes: () => got, closed: () => closed }
}

describe('pipe guard: nothing leaves tetherd for a connection without hello', () => {
  const home = tempHome()
  const hostPipe = uniquePipe(home)
  let host: ProcHost
  let daemon: Daemon
  let rec: Recorder
  const heard: { profiles: Profile[][]; procs: ProcState[] } = { profiles: [], procs: [] }

  before(async () => {
    host = new ProcHost({ home, pipe: hostPipe, store: hostStore })
    await host.listen()
    daemon = await startDaemon({ home, pipe: uniquePipe(home), memoryIntervalMs: 0, helloTimeoutMs: HELLO_TIMEOUT_MS, connectProcHost: () => HostClient.open(hostPipe) })
    rec = await Recorder.connect(daemon.pipe)
    rec.client.on('profiles', (p) => heard.profiles.push(p))
    rec.client.on('proc', (p) => heard.procs.push(p))
  })
  after(async () => {
    try { await rec?.client.request({ t: 'proc-stop', name: 'canario' }) } catch { /* not running */ }
    rec?.close()
    await daemon?.close()
    await host?.close()
    await removeHome(home)
  })

  test('a mute client gets no byte while profiles, processes and slots change, and is dropped', async () => {
    const m = await mute(daemon.pipe)
    const profileCount = heard.profiles.length
    await rec.client.request({ t: 'profile-save', profile: { name: 'Canário', agent: 'shell', args: [], env: { CANARY_VAR: CANARY } } })
    await rec.client.request({ t: 'proc-start', name: 'canario', recipe: { command: 'node', args: ['-e', 'setInterval(() => {}, 1000)'], cwd: home, env: { CANARY_VAR: CANARY } } })
    const created = await rec.client.request({ t: 'create', kind: 'shell', cwd: home, start: false })
    await waitUntil(() => heard.profiles.length > profileCount && heard.procs.some((p) => p.name === 'canario'), 10_000, 'the identified client hears the changes')
    await rec.state(created.slot!.slotId, () => true)
    assert.equal(m.bytes(), '', 'the mute client received bytes')
    await waitUntil(m.closed, HELLO_TIMEOUT_MS + 5_000, 'tetherd drops the connection that never said hello')
    assert.equal(m.bytes(), '')
  })

  test('before the hello every request is refused and keystrokes are dropped; after it, answered', async () => {
    const m = await mute(daemon.pipe)
    m.socket.write('{"t":"list","id":1}\n{"t":"profiles-list","id":2}\n{"t":"input","slotId":"x","data":"echo"}\n')
    await waitUntil(() => m.bytes().split('\n').filter(Boolean).length >= 2, 5_000, 'two refusals')
    const lines = m.bytes().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
    assert.deepEqual(lines.map((l) => [l.t, l.id, l.code]), [['error', 1, 'auth-required'], ['error', 2, 'auth-required']])
    assert.ok(!m.bytes().includes(CANARY))
    m.socket.destroy()
  })

  test('Windows: a read-only client (PipeDirection.In, as another account opens it) reads nothing and is dropped', { skip: process.platform !== 'win32' }, async () => {
    const name = daemon.pipe.replace(/^\\\\\.\\pipe\\/, '')
    const ps = `$c = New-Object System.IO.Pipes.NamedPipeClientStream('.', '${name}', [System.IO.Pipes.PipeDirection]::In); $c.Connect(5000); `
      + `[Console]::Out.WriteLine('CONNECTED'); [Console]::Out.Flush(); $b = New-Object byte[] 65536; $n = 0; `
      + `while (($k = $c.Read($b, 0, $b.Length)) -gt 0) { $n += $k; [Console]::Out.WriteLine([Text.Encoding]::UTF8.GetString($b, 0, $k)) }; `
      + `[Console]::Out.WriteLine("READ $n BYTES"); $c.Dispose()`
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true })
    let out = ''
    child.stdout.setEncoding('utf8').on('data', (c: string) => { out += c })
    const exited = new Promise<number | null>((res) => child.on('exit', res))
    try {
      await waitUntil(() => out.includes('CONNECTED'), 20_000, 'the read-only client connects')
      await rec.client.request({ t: 'profile-save', profile: { name: 'Canário 2', agent: 'shell', args: [], env: { CANARY_VAR: CANARY } } })
      await rec.client.request({ t: 'create', kind: 'shell', cwd: home, start: false })
      assert.notEqual(await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), HELLO_TIMEOUT_MS + 15_000))]), 'timeout', 'tetherd dropped the reader')
      assert.match(out, /READ 0 BYTES/)
      assert.ok(!out.includes(CANARY))
    } finally {
      child.kill()
    }
  })
})
