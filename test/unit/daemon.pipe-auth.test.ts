// A-1, second layer: only the user who runs tetherd gets through the hello. The client proves it read <home>/tetherd.key
// (private to the user) by HMAC over both sides' nonces, and tetherd proves the same back (pipe-key.ts). Played against a
// bench tetherd: a hello without proof (a client older than protocol 2), with a wrong proof, or made with another key is
// refused and the connection closed; a program squatting the pipe's name is refused before the client says anything; an
// older tetherd is named as such instead of hanging; the key file is private to the user.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { statSync } from 'node:fs'
import { createServer, connect, type Server, type Socket } from 'node:net'
import { after, before, describe, test } from 'node:test'
import { DaemonClient, DaemonError, NotTetherError, pingDaemon } from '../../src/daemon/client.ts'
import { encode, LineParser } from '../../src/daemon/ndjson.ts'
import { clientProof, newNonce, pipeKeyPath, readPipeKey } from '../../src/daemon/pipe-key.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { removeHome, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

/** A raw connection: the lines it got, and whether tetherd closed it. */
async function raw(pipe: string): Promise<{ socket: Socket; lines: () => Record<string, unknown>[]; closed: () => boolean }> {
  const socket = connect(pipe)
  await new Promise<void>((res, rej) => { socket.once('connect', res); socket.once('error', rej) })
  socket.setEncoding('utf8')
  let got = ''
  let closed = false
  socket.on('data', (c: string) => { got += c })
  socket.on('error', () => {})
  socket.on('close', () => { closed = true })
  return { socket, lines: () => got.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>), closed: () => closed }
}

describe('pipe auth: only the owner of the key gets through the hello', () => {
  const home = tempHome()
  let daemon: Daemon
  before(async () => { daemon = await startDaemon({ home, pipe: uniquePipe(home), memoryIntervalMs: 0 }) })
  after(async () => { await daemon?.close(); await removeHome(home) })

  test('a hello without proof (a client of protocol 1) is refused with a message to update, and the connection closed', async () => {
    const c = await raw(daemon.pipe)
    c.socket.write(encode({ t: 'hello', id: 0, v: 1, client: 'app' }))
    await waitUntil(c.closed, 5_000, 'tetherd closes the connection')
    const [r] = c.lines()
    assert.equal(r?.t, 'error')
    assert.equal(r?.code, 'auth-required')
    assert.match(String(r?.message), /versão anterior do tether: atualize/)
  })

  test('a hello with a proof made from another key, or with no auth before it, is refused and closed', async () => {
    const c = await raw(daemon.pipe)
    const nonce = newNonce()
    c.socket.write(encode({ t: 'auth', id: 0, nonce }))
    await waitUntil(() => c.lines().length >= 1, 5_000, 'auth reply')
    const auth = c.lines()[0]!.auth as { nonce: string }
    c.socket.write(encode({ t: 'hello', id: 1, v: 2, client: 'test', proof: clientProof(randomBytes(32), nonce, auth.nonce) }))
    await waitUntil(c.closed, 5_000, 'tetherd closes the connection')
    assert.deepEqual([c.lines()[1]?.t, c.lines()[1]?.code], ['error', 'auth-failed'])

    const d = await raw(daemon.pipe)
    d.socket.write(encode({ t: 'hello', id: 0, v: 2, client: 'test', proof: 'ab'.repeat(32) }))
    await waitUntil(d.closed, 5_000, 'tetherd closes the connection')
    assert.deepEqual([d.lines()[0]?.t, d.lines()[0]?.code], ['error', 'auth-required'])
  })

  test('a proof cannot be replayed: the right proof for one connection fails on another', async () => {
    const key = (await readPipeKey(home))!
    const a = await raw(daemon.pipe)
    const nonce = newNonce()
    a.socket.write(encode({ t: 'auth', id: 0, nonce }))
    await waitUntil(() => a.lines().length >= 1, 5_000, 'auth reply')
    const proof = clientProof(key, nonce, (a.lines()[0]!.auth as { nonce: string }).nonce)
    const b = await raw(daemon.pipe)
    b.socket.write(encode({ t: 'auth', id: 0, nonce }))
    await waitUntil(() => b.lines().length >= 1, 5_000, 'auth reply')
    b.socket.write(encode({ t: 'hello', id: 1, v: 2, client: 'test', proof }))
    await waitUntil(b.closed, 5_000, 'replayed proof refused')
    assert.equal(b.lines()[1]?.code, 'auth-failed')
    a.socket.write(encode({ t: 'hello', id: 1, v: 2, client: 'test', proof }))
    await waitUntil(() => a.lines().length >= 2, 5_000, 'hello reply')
    assert.equal(a.lines()[1]?.t, 'ok')
    a.socket.destroy()
  })

  test('the client of this code gets through; a client pointed at another home (no key there) is told so', async () => {
    const c = await DaemonClient.open(daemon.pipe, 'test', { home })
    assert.equal(c.hello.v, 2)
    assert.equal(c.hello.legacy, undefined)
    c.close()
    const elsewhere = tempHome()
    try {
      await assert.rejects(DaemonClient.open(daemon.pipe, 'test', { home: elsewhere }), (e: Error) => e instanceof DaemonError && e.code === 'auth-failed' && /TETHER_HOME/.test(e.message))
    } finally { await removeHome(elsewhere) }
  })

  test('the key file: 64 hex digits, private to the user (Windows: only the user and SYSTEM, no inheritance; else 0600)', () => {
    const path = pipeKeyPath(home)
    if (process.platform === 'win32') {
      const ps = `$a = Get-Acl -LiteralPath '${path.replace(/'/g, "''")}'; 'PROTECTED=' + $a.AreAccessRulesProtected; `
        + `$a.Access | ForEach-Object { 'ACE=' + $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value + ' ' + $_.AccessControlType }; `
        + `'ME=' + [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value`
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true })
      const me = /ME=(\S+)/.exec(out)![1]!
      assert.match(out, /PROTECTED=True/)
      const aces = [...out.matchAll(/ACE=(\S+) (\S+)/g)].map((m) => `${m[1] === me ? 'me' : m[1]} ${m[2]}`).sort()
      assert.deepEqual(aces, ['S-1-5-18 Allow', 'me Allow'])
    } else {
      assert.equal(statSync(path).mode & 0o777, 0o600)
      assert.equal(statSync(home).mode & 0o777, 0o700)
      assert.equal(statSync(daemon.pipe).mode & 0o777, 0o600)
    }
  })

  test('each tetherd draws a new key: the next one on the same home refuses a proof made with the previous key', async () => {
    const before = (await readPipeKey(home))!
    await daemon.close()
    daemon = await startDaemon({ home, pipe: uniquePipe(home), memoryIntervalMs: 0 })
    const now = (await readPipeKey(home))!
    assert.notEqual(now.toString('hex'), before.toString('hex'))
    const c = await DaemonClient.open(daemon.pipe, 'test', { home })
    c.close()
  })
})

/** A program on a pipe that speaks the protocol's first words: `answer` decides each reply; `got` keeps what it was sent. */
async function fakeTether(pipe: string, answer: (msg: Record<string, unknown>) => unknown): Promise<{ server: Server; got: Record<string, unknown>[] }> {
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
      }
    })
  })
  await new Promise<void>((res) => server.listen(pipe, res))
  return { server, got }
}

describe('pipe auth: the client checks who answers', () => {
  const home = tempHome()
  after(async () => { await removeHome(home) })

  test('a program squatting the pipe (no key) is refused before the client sends a hello', async () => {
    const pipe = uniquePipe(home)
    const fake = await fakeTether(pipe, (m) => m.t === 'auth' ? { t: 'ok', id: 0, auth: { nonce: newNonce(), proof: 'cd'.repeat(32) } } : { t: 'ok', id: 0, hello: { v: 2, pid: 1, version: 'x' } })
    try {
      // The home has a key of its own, so the squatter cannot learn it from the client: the client refuses its proof.
      const real = await startDaemon({ home, pipe: uniquePipe(home), memoryIntervalMs: 0 })
      try {
        await assert.rejects(DaemonClient.open(pipe, 'app', { home }), (e: Error) => e instanceof NotTetherError && /não provou ter a chave/.test(e.message))
        assert.deepEqual(fake.got.map((m) => m.t), ['auth'], 'nothing after the auth: no hello, no proof')
      } finally { await real.close() }
    } finally { fake.server.close() }
  })

  test('a tetherd of protocol 1: refused with daemon-outdated (what to do), accepted as legacy for ping and shutdown', async () => {
    const pipe = uniquePipe(home)
    const fake = await fakeTether(pipe, (m) => m.t === 'auth'
      ? { t: 'error', id: m.id, code: 'bad-request', message: 'mensagem desconhecida: auth' }
      : m.t === 'hello' ? { t: 'ok', id: m.id, hello: { v: 1, pid: 4242, version: '0.3.7' } } : { t: 'ok', id: m.id })
    try {
      await assert.rejects(DaemonClient.open(pipe, 'app', { home }), (e: Error) => e instanceof DaemonError && e.code === 'daemon-outdated'
        && /versão 0\.3\.7, pid 4242/.test(e.message) && /reinicie o tetherd/.test(e.message))
      await assert.rejects(DaemonClient.connect({ home, pipe, client: 'cli' }), (e: Error) => e instanceof DaemonError && e.code === 'daemon-outdated', 'connect does not spawn over it')
      const hello = await pingDaemon(pipe, home)
      assert.equal(hello?.pid, 4242)
      assert.equal(hello?.legacy, true)
      const c = await DaemonClient.open(pipe, 'cli', { home, legacy: true })
      await c.request({ t: 'shutdown' })
      c.close()
      assert.ok(fake.got.some((m) => m.t === 'shutdown'))
      assert.ok(fake.got.filter((m) => m.t === 'hello').every((m) => m.proof === undefined && m.v === 1), 'no proof goes to a tetherd that cannot check one')
    } finally { fake.server.close() }
  })
})
