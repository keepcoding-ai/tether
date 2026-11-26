// ProcHost output/input queues (E1.3): a client that stops reading is dropped with `lag` and recovers by offset, never
// slowing another client on the same pane; bursts are batched; input above the ceiling is counted and dropped.
import assert from 'node:assert/strict'
import { connect, type Socket } from 'node:net'
import { after, before, describe, test } from 'node:test'
import { encode, LineParser } from '../../src/daemon/ndjson.ts'
import { ProcHost } from '../../src/procd/host.ts'
import { identifyHost } from './host-auth.ts'
import { PROCD_PROTOCOL_VERSION, type HostEvent, type HostReply } from '../../src/procd/protocol.ts'
import { removeHome, sleep, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

// "FLOOD" prints 8000 numbered 100-char lines then END; "BURST" prints 20 short lines ~1 ms apart; else echo.
const CHILD = [
  "const pad = 'x'.repeat(92), NL = String.fromCharCode(10);",
  "process.stdin.on('data', (d) => {",
  "const s = String(d);",
  "if (s.includes('FLOOD')) { let o = ''; for (let i = 0; i < 8000; i++) o += 'L' + String(i).padStart(5, '0') + pad + NL; process.stdout.write(o + 'END' + NL) }",
  "else if (s.includes('BURST')) { for (let i = 0; i < 20; i++) { process.stdout.write('b' + i + NL); const t = Date.now(); while (Date.now() - t < 1); } process.stdout.write('BURSTEND' + NL) }",
  "else process.stdout.write(d);",
  "});",
  "setInterval(() => {}, 1000)",
].join(' ')

type Msg = HostReply | HostEvent
class Wire {
  readonly msgs: Msg[] = []
  /** Arrival time of each message (the wait helper polls every 50 ms, too coarse for latency). */
  readonly arrived = new WeakMap<object, number>()
  private nextId = 1
  private readonly socket: Socket
  private constructor(socket: Socket) { this.socket = socket }
  static async open(pipe: string, home: string): Promise<Wire> {
    const socket = connect(pipe)
    await new Promise<void>((resolve, reject) => { socket.once('connect', () => resolve()); socket.once('error', reject) })
    socket.setEncoding('utf8')
    const w = new Wire(socket)
    const parser = new LineParser()
    socket.on('data', (chunk: string) => { for (const l of parser.push(chunk)) if (l.value) { w.msgs.push(l.value as unknown as Msg); w.arrived.set(l.value, Date.now()) } })
    await identifyHost((b) => w.request(b), pipe, home)
    return w
  }
  async request(body: Record<string, unknown>): Promise<Extract<HostReply, { t: 'ok' }>> {
    const id = this.nextId++
    this.socket.write(encode({ ...body, id }))
    await waitUntil(() => this.msgs.some((m) => 'id' in m && m.id === id), 10_000, `reply to ${String(body.t)}`)
    const r = this.msgs.find((m) => 'id' in m && m.id === id) as HostReply
    assert.equal(r.t, 'ok', r.t === 'error' ? r.message : '')
    return r as Extract<HostReply, { t: 'ok' }>
  }
  notice(body: Record<string, unknown>): void { this.socket.write(encode(body)) }
  pause(): void { this.socket.pause() }
  resume(): void { this.socket.resume() }
  data(name: string): Extract<HostEvent, { t: 'data' }>[] {
    return this.msgs.filter((m): m is Extract<HostEvent, { t: 'data' }> => m.t === 'data' && m.name === name)
  }
  text(name: string): string { return this.data(name).map((d) => d.data).join('') }
  close(): void { this.socket.destroy() }
}

const spawnReq = (name: string, home: string) => ({ t: 'spawn', name, run: 1, plan: { command: process.execPath, args: ['-e', CHILD], cwd: home, env: process.env }, cols: 100, rows: 30, home })

describe('ptyd host queues: slow client, batching, input ceiling', () => {
  const home = tempHome()
  const pipe = uniquePipe(home)
  let host: ProcHost
  const wires: Wire[] = []
  const open = async (): Promise<Wire> => { const w = await Wire.open(pipe, home); wires.push(w); return w }

  before(async () => {
    host = new ProcHost({ home, pipe, persist: false, outHighWater: 4 * 1024, outQueueMax: 32 * 1024, batchMs: 5, scrollbackChars: 4 * 1024 * 1024 })
    await host.listen()
  })
  after(async () => {
    for (const w of wires) w.close()
    await host?.close()
    await removeHome(home)
  })

  test('a client that stops reading is dropped with lag and recovers by offset; another client is not delayed', async () => {
    const slow = await open()
    const fast = await open()
    await slow.request({ t: 'hello', v: PROCD_PROTOCOL_VERSION })
    await slow.request(spawnReq('p1', home))
    const a0 = await slow.request({ t: 'attach', name: 'p1' })
    const f0 = await fast.request({ t: 'attach', name: 'p1' })
    assert.equal(a0.off, f0.off)
    slow.pause()
    fast.notice({ t: 'write', name: 'p1', data: 'FLOOD\r' })
    await waitUntil(() => fast.text('p1').includes('END'), 20_000, 'fast client saw END')
    assert.ok(host.stats().queuesDropped >= 1, 'the paused client queue was dropped')

    // the slow client is still parked; the other one gets its echo promptly
    const before = fast.text('p1').length
    const t0 = Date.now()
    fast.notice({ t: 'write', name: 'p1', data: 'ping\r' })
    await waitUntil(() => fast.text('p1').slice(before).includes('ping'), 5_000, 'echo of ping')
    const echo = fast.data('p1').find((d) => d.data.includes('ping'))!
    const ms = fast.arrived.get(echo)! - t0
    assert.ok(ms < 50, `echo took ${ms} ms`)

    slow.resume()
    await waitUntil(() => slow.msgs.some((m) => m.t === 'lag' && m.name === 'p1'), 10_000, 'lag')
    const lagAt = slow.msgs.findIndex((m) => m.t === 'lag')
    assert.equal(slow.msgs.slice(lagAt).some((m) => m.t === 'data'), false, 'no data for the name after lag')
    const got = a0.scrollback! + slow.text('p1')
    const last = slow.data('p1').at(-1)?.off ?? a0.off!
    assert.equal(a0.off! + slow.text('p1').length, last, 'received offsets stay continuous up to the drop')
    const epoch = a0.epoch!
    const re = await slow.request({ t: 'attach', name: 'p1', from: last, epoch })
    assert.equal(re.epoch, epoch)
    const expected = f0.scrollback! + fast.text('p1')
    const total = got + re.scrollback!
    assert.equal(total, expected.slice(0, total.length), 'same text as the client that never lagged')
    assert.equal(re.off! - last, re.scrollback!.length)
    assert.ok((got + re.scrollback!).includes('L07999'), 'the whole flood is present')
    assert.equal((got + re.scrollback!).split('L00000').length, 2, 'no repetition')
  })

  test('writes in a burst leave as a few data events with a continuous off', async () => {
    const w = await open()
    await w.request(spawnReq('p2', home))
    const a = await w.request({ t: 'attach', name: 'p2' })
    w.notice({ t: 'write', name: 'p2', data: 'BURST\r' })
    await waitUntil(() => w.text('p2').includes('BURSTEND'), 10_000, 'burst end')
    const ds = w.data('p2')
    let off = a.off!
    for (const d of ds) { off += d.data.length; assert.equal(d.off, off) }
    for (let i = 0; i < 20; i++) assert.ok(w.text('p2').includes(`b${i}\r\n`), `b${i} present`)
    assert.ok(ds.length <= 14, `${ds.length} data events for ~24 ms of output`)
  })
})

describe('ptyd host queues: input ceiling', () => {
  const home = tempHome()
  const pipe = uniquePipe(home)
  let host: ProcHost
  let w: Wire
  before(async () => {
    host = new ProcHost({ home, pipe, persist: false, inputMax: -1 }) // pending input is never below -1: every write is over
    await host.listen()
    w = await Wire.open(pipe, home)
  })
  after(async () => {
    w?.close()
    await host?.close()
    await removeHome(home)
  })

  test('input above the ceiling is counted and dropped', async () => {
    await w.request(spawnReq('p3', home))
    await w.request({ t: 'attach', name: 'p3' })
    w.notice({ t: 'write', name: 'p3', data: 'dropped-input' })
    await waitUntil(() => host.stats().inputDropped === 1, 5_000, 'input counted')
    await sleep(200)
    assert.equal(w.text('p3').includes('dropped-input'), false, 'the process never saw it')
  })
})
