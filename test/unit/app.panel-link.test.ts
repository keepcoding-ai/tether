// PanelLink (main process <-> panel host): exactly-once, in-order output across a dropped connection and across
// `lag`; epoch change handed to onReset; input ceiling counted; reconnection waits grow 0.2 s -> 2 s.
import assert from 'node:assert/strict'
import type { Socket } from 'node:net'
import { after, before, describe, test } from 'node:test'
import { adaptHostClient, PanelLink, type PanelConn } from '../../app/main/panel-link.ts'
import { HostClient } from '../../src/procd/client.ts'
import { ProcHost } from '../../src/procd/host.ts'
import { removeHome, sleep, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

const LINES = 100_000 // ~5 MB at 50 chars a line
// "GO" emits LINES numbered lines then END, a slice per tick; anything else is echoed.
const CHILD = [
  `const pad = 'x'.repeat(40), NL = String.fromCharCode(10), N = ${LINES};`,
  'let i = 0;',
  'function go() { let o = ""; for (let k = 0; k < 500 && i < N; k++, i++) o += "L" + String(i).padStart(6, "0") + pad + NL; if (i >= N) o += "END" + NL; process.stdout.write(o); if (i < N) setImmediate(go) }',
  "process.stdin.on('data', (d) => { if (String(d).includes('GO')) go(); else process.stdout.write(d) });",
  'setInterval(() => {}, 1000)',
].join(' ')

/** The numbered lines must be L000000..L<N-1> then END, each once, in order (the pty adds escape noise around them). */
function assertComplete(text: string): void {
  const rows = text.match(/L\d{6}x{40}/g) ?? []
  assert.equal(rows.length, LINES, `got ${rows.length} numbered lines`)
  for (let i = 0; i < LINES; i++) if (rows[i] !== 'L' + String(i).padStart(6, '0') + 'x'.repeat(40)) assert.fail(`row ${i}: ${rows[i]}`)
  assert.equal(text.split('END').length, 2, 'END once')
}

/** A manual clock for the reconnection waits. */
function manualSchedule() {
  const waits: number[] = []
  let pending: (() => void) | undefined
  return {
    waits,
    schedule: (fn: () => void, ms: number) => { waits.push(ms); pending = fn; return () => { if (pending === fn) pending = undefined } },
    fire: async () => { const f = pending; pending = undefined; f?.(); await sleep(150) },
    get armed() { return pending !== undefined },
  }
}

describe('panel link against an in-process host', () => {
  const home = tempHome()
  const pipe = uniquePipe(home)
  let host: ProcHost
  let admin: HostClient
  const opened: HostClient[] = []
  let seq = 0

  const openRaw = async (p: string): Promise<PanelConn | undefined> => {
    const c = await HostClient.tryOpen(p)
    if (!c) return undefined
    opened.push(c)
    return adaptHostClient(c)
  }
  const spawn = async (name: string): Promise<void> => {
    await admin.request({ t: 'spawn', name, run: 1, plan: { command: process.execPath, args: ['-e', CHILD], cwd: home, env: process.env as Record<string, string> }, cols: 100, rows: 30, home })
  }

  before(async () => {
    host = new ProcHost({ home, pipe, persist: false, outHighWater: 4 * 1024, outQueueMax: 64 * 1024, batchMs: 5, scrollbackChars: 12 * 1024 * 1024 })
    await host.listen()
    admin = await HostClient.open(pipe)
  })
  after(async () => {
    admin?.close()
    for (const c of opened) c.close()
    await host?.close()
    await removeHome(home)
  })

  test('a connection destroyed mid-stream reconnects and the text is complete, in order, once', async () => {
    const name = `p${++seq}`
    await spawn(name)
    let text = ''
    const clock = manualSchedule()
    const states: boolean[] = []
    const link = new PanelLink({ pipe, onData: (_id, d) => { text += d }, onState: (s) => states.push(s), open: openRaw, schedule: clock.schedule })
    await link.start()
    assert.equal(link.connected, true)
    const a = await link.attach(name)
    text += a.scrollback
    assert.equal(link.has(name), true)
    link.write(name, 'GO\r')
    await waitUntil(() => text.length > 1_500_000, 30_000, 'half way')
    opened.at(-1)!.close() // destroys the socket
    await waitUntil(() => !link.connected, 5_000, 'link noticed the drop')
    assert.equal(clock.armed, true)
    await sleep(300) // the host keeps producing while the link is away
    await clock.fire()
    await waitUntil(() => link.connected, 5_000, 'reconnected')
    await waitUntil(() => text.includes('END'), 60_000, 'END')
    assertComplete(text)
    assert.deepEqual(states.slice(0, 3), [true, false, true])
    assert.ok(link.stats().resyncs >= 1)
    link.stop()
  })

  test('lag (client queue dropped by the host) recomposes with no loss', async () => {
    const name = `p${++seq}`
    await spawn(name)
    let text = ''
    const link = new PanelLink({ pipe, onData: (_id, d) => { text += d }, open: openRaw })
    await link.start()
    text += (await link.attach(name)).scrollback
    const sock = (opened.at(-1) as unknown as { socket: Socket }).socket
    sock.pause()
    link.write(name, 'GO\r')
    await waitUntil(() => host.stats().queuesDropped >= 1, 30_000, 'host dropped the queue')
    sock.resume()
    await waitUntil(() => text.includes('END'), 60_000, 'END')
    assertComplete(text)
    assert.ok(link.stats().resyncs >= 1, 'a resync happened')
    link.stop()
  })

  test('write: delivered to the process; above the pending ceiling it is dropped and counted', async () => {
    const name = `p${++seq}`
    await spawn(name)
    let text = ''
    const link = new PanelLink({ pipe, onData: (_id, d) => { text += d }, open: openRaw })
    await link.start()
    await link.attach(name)
    assert.equal(link.write(name, 'hello-panel'), true)
    await waitUntil(() => text.includes('hello-panel'), 5_000, 'echo')
    link.stop()
    const tight = new PanelLink({ pipe, onData: () => {}, open: openRaw, writeMaxPending: -1 })
    await tight.start()
    assert.equal(tight.write(name, 'nope'), false)
    assert.equal(tight.write(name, 'nope'), false)
    assert.equal(tight.stats().writesDropped, 2)
    tight.stop()
    assert.equal(tight.write(name, 'down'), false, 'down link drops too')
  })

  test('resize reaches the host without error', async () => {
    const name = `p${++seq}`
    await spawn(name)
    const link = new PanelLink({ pipe, onData: () => {}, open: openRaw })
    await link.start()
    await link.attach(name)
    link.resize(name, 90, 20)
    await sleep(100)
    assert.equal(link.connected, true)
    link.stop()
  })
})

describe('panel link logic with a fake connection', () => {
  type Fake = PanelConn & { fire: (e: string, ...a: unknown[]) => void; reqs: unknown[]; reply: (b: unknown) => { scrollback?: string; off?: number; epoch?: string } }
  function fake(reply: Fake['reply']): Fake {
    const h = new Map<string, ((...a: never[]) => void)[]>()
    const f = {
      reqs: [] as unknown[],
      isClosed: false,
      reply,
      on(e: string, fn: (...a: never[]) => void) { h.set(e, [...(h.get(e) ?? []), fn]); return f },
      request: async (b: unknown) => { f.reqs.push(b); return f.reply(b) },
      write: () => {},
      close: () => { f.isClosed = true; f.fire('close') },
      pending: () => 0,
      fire: (e: string, ...a: unknown[]) => { for (const fn of h.get(e) ?? []) (fn as (...x: unknown[]) => void)(...a) },
    }
    return f as unknown as Fake
  }

  test('reconnection waits grow 0.2 s to 2 s, then reset after a connection', async () => {
    const clock = manualSchedule()
    let up = false
    const c = fake(() => ({ scrollback: '', off: 0, epoch: 'e' }))
    const link = new PanelLink({ pipe: 'x', onData: () => {}, open: async () => (up ? c : undefined), schedule: clock.schedule })
    await link.start()
    for (let i = 0; i < 6; i++) await clock.fire()
    assert.deepEqual(clock.waits, [200, 400, 800, 1600, 2000, 2000, 2000])
    up = true
    await clock.fire()
    assert.equal(link.connected, true)
    assert.equal(link.nextDelayMs, 200)
    c.close()
    assert.equal(link.connected, false)
    assert.equal(clock.waits.at(-1), 200)
    link.stop()
  })

  test('overlapping and repeated data are trimmed by offset; a hole triggers a resync', async () => {
    const c = fake((b) => {
      const r = b as { from?: number }
      return r.from === undefined ? { scrollback: 'AB', off: 2, epoch: 'e' } : { scrollback: 'EF', off: 6, epoch: 'e' }
    })
    let got = ''
    const link = new PanelLink({ pipe: 'x', onData: (_i, d) => { got += d }, open: async () => c })
    await link.start()
    await link.attach('s')
    await sleep(0)
    c.fire('data', 's', 'CD', 4)
    c.fire('data', 's', 'CD', 4) // repeat
    c.fire('data', 's', 'BCD', 4) // overlap: nothing new
    assert.equal(got, 'CD')
    c.fire('data', 's', 'GH', 8) // hole (E,F missing): resync from 4 gets EF to 6, then GH is held out
    await sleep(10)
    assert.equal(got, 'CDEF')
    assert.deepEqual(c.reqs.at(-1), { t: 'attach', name: 's', from: 4, epoch: 'e' })
    c.fire('data', 's', 'GH', 8)
    assert.equal(got, 'CDEFGH')
    link.stop()
  })

  test('a re-attach that returns the whole ring (new epoch) goes to onReset', async () => {
    let n = 0
    const c = fake(() => (n++ === 0 ? { scrollback: 'old', off: 3, epoch: 'e1' } : { scrollback: 'brand-new', off: 9, epoch: 'e2' }))
    const resets: string[] = []
    const link = new PanelLink({ pipe: 'x', onData: () => {}, onReset: (id, s) => resets.push(`${id}:${s}`), open: async () => c })
    await link.start()
    await link.attach('s')
    c.fire('lag', 's')
    await sleep(10)
    assert.deepEqual(resets, ['s:brand-new'])
    c.fire('data', 's', 'Z', 10)
    link.stop()
  })
})
