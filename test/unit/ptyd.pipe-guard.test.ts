// A-1 on the hosts' pipes (tether-procd, tether-ptyd: one ProcHost each). Like tetherd's, a host pipe can be opened by
// any account of the machine, and the host told every connection when a run ended and took any request. Now: nothing
// before a proven hello (daemon/pipe-key.ts, scope 'tether-host', the host's own key file), a connection without hello is
// dropped, a hello without or with a wrong proof is refused and closed, and the client refuses a squatter before it
// sends a plan (whose env carries secrets). An older host is named as such; when idle, an upgrade asks it to leave.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { after, before, describe, test } from 'node:test'
import { clientProof, hostKeyPath, newNonce, readKeyFile } from '../../src/daemon/pipe-key.ts'
import { encode, LineParser } from '../../src/daemon/ndjson.ts'
import { HostClient, HostRequestError } from '../../src/procd/client.ts'
import { ProcHost } from '../../src/procd/host.ts'
import { removeHome, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

const HELLO_TIMEOUT_MS = 1_500
const SHORT = 'console.log("vou sair"); setTimeout(() => process.exit(3), 200)'

async function raw(pipe: string): Promise<{ socket: Socket; bytes: () => string; lines: () => Record<string, unknown>[]; closed: () => boolean }> {
  const socket = connect(pipe)
  await new Promise<void>((res, rej) => { socket.once('connect', res); socket.once('error', rej) })
  socket.setEncoding('utf8')
  let got = ''
  let closed = false
  socket.on('data', (c: string) => { got += c })
  socket.on('error', () => {})
  socket.on('close', () => { closed = true })
  return { socket, bytes: () => got, lines: () => got.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>), closed: () => closed }
}

describe('host pipe guard: nothing for a connection that did not prove the key', () => {
  const home = tempHome()
  const pipe = uniquePipe(home)
  let host: ProcHost
  let admin: HostClient
  before(async () => {
    host = new ProcHost({ home, pipe, persist: false, helloTimeoutMs: HELLO_TIMEOUT_MS })
    await host.listen()
    admin = await HostClient.open(pipe)
  })
  after(async () => {
    admin?.close()
    await host?.close()
    await removeHome(home)
  })

  test('a mute client gets no byte while a run starts and ends (the exit goes to the identified client), and is dropped', async () => {
    const m = await raw(pipe)
    const exits: string[] = []
    admin.on('exit', (name) => exits.push(name))
    await admin.request({ t: 'spawn', name: 'curto', run: 1, plan: { command: process.execPath, args: ['-e', SHORT], cwd: home, env: process.env as Record<string, string> }, cols: 80, rows: 24, home })
    await waitUntil(() => exits.includes('curto'), 10_000, 'the identified client hears the exit')
    assert.equal(m.bytes(), '', 'the mute client received bytes')
    await waitUntil(m.closed, HELLO_TIMEOUT_MS + 5_000, 'the host drops the connection that never said hello')
    assert.equal(m.bytes(), '')
  })

  test('before the hello: requests refused, a write dropped; a hello without proof, or made with another key, refused and closed', async () => {
    const m = await raw(pipe)
    m.socket.write(encode({ t: 'list', id: 1 }) + encode({ t: 'spawn', id: 2, name: 'intruso', run: 1, plan: { command: process.execPath, args: ['-e', ''], cwd: home, env: {} }, cols: 80, rows: 24, home }) + encode({ t: 'write', name: 'curto', data: 'x' }))
    await waitUntil(() => m.lines().length >= 2, 5_000, 'two refusals')
    assert.deepEqual(m.lines().map((l) => [l.id, l.code]), [[1, 'auth-required'], [2, 'auth-required']])
    assert.ok(!((await admin.request({ t: 'list' })).runs ?? []).some((r) => r.name === 'intruso'), 'nothing was spawned')
    m.socket.write(encode({ t: 'hello', id: 3, v: 1 }))
    await waitUntil(m.closed, 5_000, 'closed after a hello without proof')
    assert.equal(m.lines()[2]?.code, 'auth-required')
    assert.match(String(m.lines()[2]?.message), /versão anterior do tether/)

    const n = await raw(pipe)
    const nonce = newNonce()
    n.socket.write(encode({ t: 'auth', id: 0, nonce }))
    await waitUntil(() => n.lines().length >= 1, 5_000, 'auth reply')
    n.socket.write(encode({ t: 'hello', id: 1, v: 2, proof: clientProof(randomBytes(32), nonce, (n.lines()[0]!.auth as { nonce: string }).nonce, 'tether-host') }))
    await waitUntil(n.closed, 5_000, 'closed after a wrong proof')
    assert.equal(n.lines()[1]?.code, 'auth-failed')
  })

  test("tetherd's proof does not open a host: the scope is part of every label", async () => {
    const key = (await readKeyFile(hostKeyPath(home, pipe)))!
    const n = await raw(pipe)
    const nonce = newNonce()
    n.socket.write(encode({ t: 'auth', id: 0, nonce }))
    await waitUntil(() => n.lines().length >= 1, 5_000, 'auth reply')
    n.socket.write(encode({ t: 'hello', id: 1, v: 2, proof: clientProof(key, nonce, (n.lines()[0]!.auth as { nonce: string }).nonce, 'tetherd') }))
    await waitUntil(n.closed, 5_000, 'closed')
    assert.equal(n.lines()[1]?.code, 'auth-failed')
  })

  test('two hosts in one home (tether-procd and tether-ptyd) keep apart keys, private to the user', async () => {
    const other = uniquePipe(home)
    const second = new ProcHost({ home, pipe: other, persist: false })
    await second.listen()
    try {
      assert.notEqual(hostKeyPath(home, other), hostKeyPath(home, pipe))
      assert.notEqual((await readKeyFile(hostKeyPath(home, other)))!.toString('hex'), (await readKeyFile(hostKeyPath(home, pipe)))!.toString('hex'))
      const c = await HostClient.open(other, 5_000, { home })
      c.close()
      if (process.platform === 'win32') {
        const ps = `$a = Get-Acl -LiteralPath '${hostKeyPath(home, pipe).replace(/'/g, "''")}'; 'PROTECTED=' + $a.AreAccessRulesProtected; `
          + `$a.Access | ForEach-Object { 'ACE=' + $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value }; `
          + `'ME=' + [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value`
        const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true })
        const me = /ME=(\S+)/.exec(out)![1]!
        assert.match(out, /PROTECTED=True/)
        assert.deepEqual([...out.matchAll(/ACE=(\S+)/g)].map((x) => (x[1] === me ? 'me' : x[1])).sort(), ['S-1-5-18', 'me'])
      }
    } finally { await second.close() }
  })

  test('Windows: a read-only client (PipeDirection.In) on the host pipe reads nothing and is dropped', { skip: process.platform !== 'win32' }, async () => {
    const name = pipe.replace(/^\\\\\.\\pipe\\/, '')
    const ps = `$c = New-Object System.IO.Pipes.NamedPipeClientStream('.', '${name}', [System.IO.Pipes.PipeDirection]::In); $c.Connect(5000); `
      + `[Console]::Out.WriteLine('CONNECTED'); [Console]::Out.Flush(); $b = New-Object byte[] 65536; $n = 0; `
      + `while (($k = $c.Read($b, 0, $b.Length)) -gt 0) { $n += $k }; [Console]::Out.WriteLine("READ $n BYTES"); $c.Dispose()`
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true })
    let out = ''
    child.stdout.setEncoding('utf8').on('data', (c: string) => { out += c })
    const exited = new Promise<number | null>((res) => child.on('exit', res))
    try {
      await waitUntil(() => out.includes('CONNECTED'), 20_000, 'the read-only client connects')
      const exits: string[] = []
      admin.on('exit', (n) => exits.push(n))
      await admin.request({ t: 'spawn', name: 'curto2', run: 1, plan: { command: process.execPath, args: ['-e', SHORT], cwd: home, env: process.env as Record<string, string> }, cols: 80, rows: 24, home })
      await waitUntil(() => exits.includes('curto2'), 10_000, 'exit heard by the identified client')
      assert.notEqual(await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), HELLO_TIMEOUT_MS + 15_000))]), 'timeout', 'the host dropped the reader')
      assert.match(out, /READ 0 BYTES/)
    } finally { child.kill() }
  })
})

/** A program on a host pipe: `answer` decides each reply; `got` keeps what it was sent. */
async function fakeHost(pipe: string, answer: (msg: Record<string, unknown>) => unknown): Promise<{ server: Server; got: Record<string, unknown>[] }> {
  const got: Record<string, unknown>[] = []
  const server = createServer((s) => {
    const p = new LineParser()
    s.setEncoding('utf8')
    s.on('error', () => {})
    s.on('data', (chunk: string) => {
      for (const l of p.push(chunk)) {
        if (!l.value) continue
        got.push(l.value)
        const r = answer(l.value)
        if (r) s.write(encode(r))
        if (l.value.t === 'shutdown') { s.end(); server.close() }
      }
    })
  })
  await new Promise<void>((res) => server.listen(pipe, res))
  return { server, got }
}

describe('host pipe guard: the client checks who answers', () => {
  const home = tempHome()
  after(async () => { await removeHome(home) })

  test('a squatter on the host pipe is refused before the client sends a hello, let alone a plan', async () => {
    const pipe = uniquePipe(home)
    const real = new ProcHost({ home, pipe: uniquePipe(home), persist: false })
    await real.listen() // a key exists in the home, but not for this pipe: the squatter cannot prove one
    const fake = await fakeHost(pipe, (m) => m.t === 'auth' ? { t: 'ok', id: 0, auth: { nonce: newNonce(), proof: 'ab'.repeat(32) } } : { t: 'ok', id: m.id })
    try {
      await assert.rejects(HostClient.open(pipe, 5_000, { home }), (e: Error) => /não provou ter a chave|não encontrei a chave/.test(e.message))
      assert.deepEqual(fake.got.map((m) => m.t), ['auth'])
      await assert.rejects(HostClient.ensure({ home, pipe, node: process.execPath, env: {} }, 1_000), 'ensure does not hand it a plan either')
      assert.ok(fake.got.every((m) => m.t === 'auth'), 'only auth requests reached the squatter')
    } finally {
      fake.server.close()
      await real.close()
    }
  })

  test('a host of protocol 1: refused as outdated; ping (legacy) names it; idle, an upgrade asks it to leave; busy, it stays', async () => {
    const pipe = uniquePipe(home)
    let runs: { name: string; run: number; pid: number; startedAt: string; spawnedAt: string; exit?: unknown }[] = [{ name: 'x', run: 1, pid: 1, startedAt: '', spawnedAt: '' }]
    const fake = await fakeHost(pipe, (m) => m.t === 'auth' ? { t: 'error', id: m.id, code: 'bad-request', message: 'mensagem desconhecida: auth' }
      : m.t === 'hello' ? { t: 'ok', id: m.id, hello: { v: 1, pid: 777, version: '0.1.0', startedAt: '' } }
        : m.t === 'list' ? { t: 'ok', id: m.id, runs } : m.t === 'shutdown' ? { t: 'ok', id: m.id } : { t: 'ok', id: m.id })
    try {
      await assert.rejects(HostClient.open(pipe, 5_000, { home }), (e: Error) => e instanceof HostRequestError && e.code === 'outdated' && /pid 777/.test(e.message) && /tether proc host stop --force/.test(e.message))
      assert.equal((await HostClient.ping(pipe, home))?.legacy, true)
      assert.equal(await HostClient.retireIdle(pipe, home), false, 'it runs something: it stays')
      assert.ok(!fake.got.some((m) => m.t === 'shutdown'))
      runs = []
      assert.equal(await HostClient.retireIdle(pipe, home), true, 'idle: asked to leave, and the pipe is free')
      assert.ok(fake.got.some((m) => m.t === 'shutdown'))
      assert.ok(!fake.got.some((m) => m.t === 'spawn'), 'no plan ever went to it')
    } finally { fake.server.close() }
  })
})
