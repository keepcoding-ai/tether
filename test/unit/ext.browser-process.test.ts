// The browser process's pure parts: which tabs come back paused after a crash (crash-rules.ts), and the line between the app
// and the process (app/main/browser-wire.ts) over a real local pipe.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CRASH_REPEAT_MS, pausedAfter } from '../../extensions/browser/crash-rules.ts'
import { BROWSER_CRASHED, Wire } from '../../app/main/browser-wire.ts'

test('pausedAfter: a tab suspect in two crashes within the window is paused; otherwise none', () => {
  assert.deepEqual([...pausedAfter(undefined, { at: 1000, suspects: ['a'] })], [])
  assert.deepEqual([...pausedAfter({ at: 0, suspects: ['a', 'b'] }, { at: 60_000, suspects: ['b', 'c'] })], ['b'])
  assert.deepEqual([...pausedAfter({ at: 0, suspects: ['a'] }, { at: CRASH_REPEAT_MS + 1, suspects: ['a'] })], [], 'too far apart')
  assert.deepEqual([...pausedAfter({ at: 0, suspects: ['a'] }, { at: CRASH_REPEAT_MS, suspects: ['a'] })], ['a'], 'at the limit')
  assert.deepEqual([...pausedAfter({ at: 0, suspects: [] }, { at: 10, suspects: ['a'] })], [])
})

async function pair(): Promise<{ a: Wire; b: Wire; close(): void }> {
  const path = process.platform === 'win32' ? `\\\\.\\pipe\\tether-wire-test-${process.pid}-${Math.random().toString(36).slice(2)}` : join(tmpdir(), `tw-${process.pid}.sock`)
  let serverSide!: Socket
  const server = createServer(s => { serverSide = s })
  await new Promise<void>(r => server.listen(path, r))
  const c = connect(path)
  await new Promise<void>(r => c.once('connect', r))
  while (!serverSide) await new Promise(r => setTimeout(r, 5))
  return { a: new Wire(serverSide), b: new Wire(c), close: () => server.close() }
}

test('Wire: calls both ways, errors, bytes, one-way posts, and BROWSER_CRASHED when the line goes', async () => {
  const { a, b, close } = await pair()
  try {
    b.handle('add', (x: unknown, y: unknown) => (x as number) + (y as number))
    b.handle('fail', () => { throw new Error('nope') })
    b.handle('bytes', (buf: unknown) => Buffer.concat([buf as Buffer, Buffer.from([9])]))
    const posted: unknown[] = []
    b.handle('note', (v: unknown) => { posted.push(v) })
    a.handle('back', () => 'from a')
    assert.equal(await a.call('add', 2, 3), 5)
    await assert.rejects(a.call('fail'), /nope/)
    await assert.rejects(a.call('missing'), /desconhecido/)
    assert.deepEqual([...(await a.call('bytes', new Uint8Array([1, 2])) as Buffer)], [1, 2, 9])
    assert.equal(await b.call('back'), 'from a')
    a.post('note', { x: 1, skip: undefined })
    await new Promise(r => setTimeout(r, 50))
    assert.deepEqual(posted, [{ x: 1 }])
    b.handle('slow', () => new Promise(() => {}))
    const pending = a.call('slow')
    b.close()
    await assert.rejects(pending, new RegExp(BROWSER_CRASHED))
    await assert.rejects(a.call('add', 1, 1), new RegExp(BROWSER_CRASHED))
  } finally { a.close(); b.close(); close() }
})
