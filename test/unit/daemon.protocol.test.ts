// Framing and buffering primitives of the daemon, plus the wire behaviour of a live server with a raw socket.
import assert from 'node:assert/strict'
import { connect } from 'node:net'
import { after, before, describe, test } from 'node:test'
import { guessId, LineParser, encode } from '../../src/daemon/ndjson.ts'
import { clientProof, daemonProof, newNonce, readPipeKey } from '../../src/daemon/pipe-key.ts'
import { Scrollback } from '../../src/daemon/scrollback.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { removeHome, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

describe('ndjson framing', () => {
  test('lines split across chunks are reassembled; blank lines and CRLF are tolerated', () => {
    const p = new LineParser()
    assert.deepEqual(p.push('{"t":"he'), [])
    const a = p.push('llo","id":1}\r\n\n{"t":"list","id":2}\n{"t":')
    assert.deepEqual(a.map((l) => l.value), [{ t: 'hello', id: 1 }, { t: 'list', id: 2 }])
    const b = p.push('"x"}\n')
    assert.deepEqual(b.map((l) => l.value), [{ t: 'x' }])
  })

  test('malformed lines come back with value undefined and the id can still be guessed', () => {
    const p = new LineParser()
    const [bad] = p.push('{"t":"list","id":7\n')
    assert.equal(bad?.value, undefined)
    assert.equal(guessId(bad!.raw), 7)
    assert.equal(guessId('nonsense'), undefined)
    const [arr] = p.push('[1,2]\n')
    assert.equal(arr?.value, undefined)
  })

  test('encode ends with exactly one newline', () => {
    assert.equal(encode({ t: 'ok', id: 1 }), '{"t":"ok","id":1}\n')
  })
})

describe('scrollback ring buffer', () => {
  test('keeps whole chunks up to the capacity and drops from the front', () => {
    const s = new Scrollback(10)
    s.push('aaaa'); s.push('bbbb'); s.push('cc')
    assert.equal(s.text(), 'aaaabbbbcc')
    s.push('d')
    assert.equal(s.text(), 'bbbbccd')
    s.push('x'.repeat(25))
    assert.equal(s.text(), 'x'.repeat(10))
    assert.equal(s.length, 10)
    s.clear()
    assert.equal(s.text(), '')
  })
})

describe('wire: raw socket against a live daemon', () => {
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

  test('auth, hello split in two chunks, garbage with an id, garbage without, then list', async () => {
    const sock = connect(daemon.pipe)
    await new Promise<void>((res, rej) => { sock.once('connect', res); sock.once('error', rej) })
    sock.setEncoding('utf8')
    let received = ''
    sock.on('data', (c: string) => { received += c })
    const lines = (): Record<string, unknown>[] => received.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)

    const nonce = newNonce()
    sock.write(`{"t":"auth","id":0,"nonce":"${nonce}"}\n`)
    await waitUntil(() => lines().length >= 1, 5_000, 'auth reply')
    const auth = lines()[0]!.auth as { nonce: string; proof: string }
    const key = (await readPipeKey(home))!
    assert.equal(auth.proof, daemonProof(key, nonce, auth.nonce), 'tetherd proves it holds the key')
    sock.write(`{"t":"hello","id":1,"v":2,"proof":"${clientProof(key, nonce, auth.nonce)}",`)
    await new Promise((r) => setTimeout(r, 50))
    sock.write('"client":"test"}\n')
    await waitUntil(() => lines().length >= 2, 5_000, 'hello reply')
    const hello = lines()[1]!
    assert.equal(hello.t, 'ok')
    assert.equal(hello.id, 1)
    assert.equal((hello.hello as { pid: number }).pid, process.pid)

    sock.write('{"t":"list","id":2\n')     // malformed, id guessable
    sock.write('not json at all\n')        // malformed, no id: ignored
    sock.write('{"t":"nope","id":3}\n')    // well-formed, unknown request
    sock.write('{"t":"list","id":4}\n')
    await waitUntil(() => lines().length >= 5, 5_000, 'three more replies')
    const [, , e2, e3, ok4] = lines()
    assert.deepEqual([e2!.t, e2!.id, e2!.code], ['error', 2, 'bad-request'])
    assert.deepEqual([e3!.t, e3!.id, e3!.code], ['error', 3, 'bad-request'])
    assert.equal(ok4!.t, 'ok')
    assert.deepEqual(ok4!.slots, [])
    sock.destroy()
  })
})
