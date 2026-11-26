// Extension requests and events (N1, daemon half) in a real tetherd on a test home and test pipe: an extension answers
// `ext-request` under its own id, a client gets `ext-event` with the `ext` the core set, and a satellite registers without
// a pipe. The real user's home, pipe and tetherd are never touched.
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { DisposableStore } from '../../app/shared/vscode-lifecycle.ts'
import { DaemonError } from '../../src/daemon/client.ts'
import { DoorHost } from '../../src/daemon/door/host.ts'
import { DoorError } from '../../src/daemon/door/port.ts'
import type { ExtRequestContext } from '../../src/daemon/door/types.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { Recorder, removeHome, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

const rejectsWith = (code: string) => (e: unknown): boolean => e instanceof DaemonError && e.code === code

describe('agent door extension requests (N1d)', () => {
  let home: string
  let daemon: Daemon
  let rec: Recorder
  const logs: string[] = []
  const door = new DoorHost({ log: (m) => logs.push(m) })
  const own = new DisposableStore()
  const other = new DisposableStore()
  const seen: { args: unknown; ctx: ExtRequestContext }[] = []

  before(async () => {
    home = tempHome()
    daemon = await startDaemon({ home, pipe: uniquePipe(home), memoryIntervalMs: 0, door, log: (m) => logs.push(m) })
    rec = await Recorder.connect(daemon.pipe)
    const api = door.apiFor('probe', own)
    api.requests.handle<{ n: number }>('ping', (args, ctx) => { seen.push({ args, ctx }); return { pong: args.n + 1 } })
    api.requests.handle('later', async () => { await new Promise((r) => setTimeout(r, 10)); return [1, 2, 3] })
    api.requests.handle('nothing', () => undefined)
    api.requests.handle('boom', () => { throw new Error('quebrou de propósito') })
    api.requests.handle('refuse', () => { throw new DoorError('door-denied', 'não é seu') })
    api.requests.handle('cyclic', () => { const o: Record<string, unknown> = {}; o.self = o; return o })
    door.apiFor('other', other).requests.handle('ping', () => 'other pong')
  })
  after(async () => {
    own.dispose()
    other.dispose()
    rec?.close()
    await daemon?.close()
    await removeHome(home)
  })

  test('a registered request answers over the pipe with its result, and the handler sees the args and ctx.client', async () => {
    const reply = await rec.client.request({ t: 'ext-request', ext: 'probe', name: 'ping', args: { n: 41 } })
    assert.deepEqual(reply.result, { pong: 42 })
    // ctx.conn: the asking connection's number, so a handler can answer only the connection that asked.
    const conn = seen.at(-1)?.ctx.conn
    assert.ok(Number.isInteger(conn) && conn! > 0)
    assert.deepEqual(seen.at(-1), { args: { n: 41 }, ctx: { client: 'test', conn } })
    assert.deepEqual((await rec.client.request({ t: 'ext-request', ext: 'probe', name: 'later' })).result, [1, 2, 3])
    assert.equal('result' in (await rec.client.request({ t: 'ext-request', ext: 'probe', name: 'nothing' })), false)
  })

  test('the same name in another extension does not collide; a repeated name in one extension throws', async () => {
    assert.equal((await rec.client.request({ t: 'ext-request', ext: 'other', name: 'ping' })).result, 'other pong')
    assert.throws(() => door.apiFor('probe', own).requests.handle('ping', () => 0), /já tem quem responda/)
    assert.deepEqual((await rec.client.request({ t: 'ext-request', ext: 'probe', name: 'ping', args: { n: 1 } })).result, { pong: 2 })
  })

  test('no handler for the extension or the name is unknown-request; a request without ext or name is bad-request', async () => {
    await assert.rejects(rec.client.request({ t: 'ext-request', ext: 'probe', name: 'nope' }), rejectsWith('unknown-request'))
    await assert.rejects(rec.client.request({ t: 'ext-request', ext: 'ghost', name: 'ping' }), rejectsWith('unknown-request'))
    await assert.rejects(rec.client.request({ t: 'ext-request', ext: '', name: 'ping' }), rejectsWith('bad-request'))
  })

  test('a handler that throws is the request error (a DoorError keeps its code) and the loop carries on', async () => {
    await assert.rejects(rec.client.request({ t: 'ext-request', ext: 'probe', name: 'boom' }), (e: unknown) => rejectsWith('bad-request')(e) && /quebrou de propósito/.test((e as Error).message))
    await assert.rejects(rec.client.request({ t: 'ext-request', ext: 'probe', name: 'refuse' }), rejectsWith('door-denied'))
    await assert.rejects(rec.client.request({ t: 'ext-request', ext: 'probe', name: 'cyclic' }), rejectsWith('bad-request'))
    assert.deepEqual((await rec.client.request({ t: 'ext-request', ext: 'probe', name: 'ping', args: { n: 9 } })).result, { pong: 10 })
    assert.ok((await rec.client.request({ t: 'list' })).slots)
  })

  test('disposing the extension undoes its registrations (and the name can be registered again)', async () => {
    const store = new DisposableStore()
    door.apiFor('short', store).requests.handle('ping', () => 'short')
    assert.equal((await rec.client.request({ t: 'ext-request', ext: 'short', name: 'ping' })).result, 'short')
    store.dispose()
    await assert.rejects(rec.client.request({ t: 'ext-request', ext: 'short', name: 'ping' }), rejectsWith('unknown-request'))
    const again = new DisposableStore()
    door.apiFor('short', again).requests.handle('ping', () => 'again')
    assert.equal((await rec.client.request({ t: 'ext-request', ext: 'short', name: 'ping' })).result, 'again')
    again.dispose()
  })

  test('events.emit reaches every client as ext-event with the ext the core set; a disposed extension emits nothing', async () => {
    const second = await Recorder.connect(daemon.pipe)
    try {
      const got: { ext: string; name: string; payload?: unknown }[][] = [[], []]
      rec.client.on('ext-event', (e) => got[0]!.push(e))
      second.client.on('ext-event', (e) => got[1]!.push(e))
      const store = new DisposableStore()
      const events = door.apiFor('probe', store).events
      events.emit('said', { room: 'obra', n: 1 })
      events.emit('bare')
      store.dispose()
      events.emit('said', { after: 'dispose' })
      door.apiFor('other', other).events.emit('said', 'from other')
      await waitUntil(() => got.every((g) => g.length >= 3), 5_000, 'ext-event on both clients')
      for (const g of got) assert.deepEqual(g, [
        { ext: 'probe', name: 'said', payload: { room: 'obra', n: 1 } },
        { ext: 'probe', name: 'bare' },
        { ext: 'other', name: 'said', payload: 'from other' },
      ])
    } finally {
      second.close()
    }
  })
})

describe('agent door extension requests in a satellite (no port)', () => {
  test('registering works and the handler answers through the registry', async () => {
    const sat = new DoorHost({ log: () => {} })
    const store = new DisposableStore()
    sat.apiFor('probe', store).requests.handle('ping', (_args, ctx) => ({ client: ctx.client }))
    const handler = sat.requestHandler('ext-request')
    assert.ok(handler)
    assert.deepEqual(await handler({ t: 'ext-request', id: 1, ext: 'probe', name: 'ping' }, { client: 'cli' }), { result: { client: 'cli' } })
    store.dispose()
    await assert.rejects(Promise.resolve().then(() => handler({ t: 'ext-request', id: 2, ext: 'probe', name: 'ping' }, { client: 'cli' })), (e: unknown) => e instanceof DoorError && e.code === 'unknown-request')
  })

  test('emitting does nothing (no port, no clients) and does not throw', () => {
    const sat = new DoorHost({ log: () => {} })
    const events = sat.apiFor('probe', new DisposableStore()).events
    assert.equal(sat.port, undefined)
    assert.doesNotThrow(() => { events.emit('said', { n: 1 }); events.emit('bare') })
  })
})
