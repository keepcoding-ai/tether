// ProcHost as a terminal-pane host (E1.2): persist:false (nothing on disk), write notices, output offsets,
// attach with from/epoch, release, and `exit` after the last `data`. Runs against a host in this process.
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { after, before, describe, test } from 'node:test'
import { encode, LineParser } from '../../src/daemon/ndjson.ts'
import { join } from 'node:path'
import { hostKeyPath } from '../../src/daemon/pipe-key.ts'
import { ProcHost } from '../../src/procd/host.ts'
import { identifyHost } from './host-auth.ts'
import { PROCD_PROTOCOL_VERSION, type HostEvent, type HostReply } from '../../src/procd/protocol.ts'
import { pidAlive, removeHome, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

const ECHO = "process.stdin.on('data', (d) => process.stdout.write(d)); setInterval(() => {}, 1000)"

type Msg = HostReply | HostEvent
class Wire {
  readonly msgs: Msg[] = []
  private nextId = 1
  private readonly socket: Socket
  private constructor(socket: Socket) { this.socket = socket }
  static async open(pipe: string, home: string): Promise<Wire> {
    const socket = connect(pipe)
    await new Promise<void>((resolve, reject) => { socket.once('connect', () => resolve()); socket.once('error', reject) })
    socket.setEncoding('utf8')
    const w = new Wire(socket)
    const parser = new LineParser()
    socket.on('data', (chunk: string) => { for (const l of parser.push(chunk)) if (l.value) w.msgs.push(l.value as unknown as Msg) })
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
  data(name: string): Extract<HostEvent, { t: 'data' }>[] {
    return this.msgs.filter((m): m is Extract<HostEvent, { t: 'data' }> => m.t === 'data' && m.name === name)
  }
  text(name: string): string { return this.data(name).map((d) => d.data).join('') }
  close(): void { this.socket.destroy() }
}

describe('ptyd host: persist:false, write, offsets, attach, release', () => {
  const home = tempHome()
  const pipe = uniquePipe(home)
  const before0 = readdirSync(home).sort()
  /** The home's files, without the host's own key (pipe-key.ts hostKeyPath), the one file a pane host writes. */
  const onDisk = (): string[] => readdirSync(home).filter((n) => join(home, n) !== hostKeyPath(home, pipe)).sort()
  let host: ProcHost
  let w: Wire
  let epoch = ''
  let pid = 0

  before(async () => {
    host = new ProcHost({ home, pipe, persist: false })
    await host.listen()
    w = await Wire.open(pipe, home)
  })
  after(async () => {
    w?.close()
    await host?.close()
    await removeHome(home)
  })

  test('hello announces the capabilities, same protocol version', async () => {
    const r = await w.request({ t: 'hello', v: PROCD_PROTOCOL_VERSION })
    assert.equal(r.hello!.v, PROCD_PROTOCOL_VERSION)
    assert.deepEqual(r.hello!.caps, ['write', 'offsets', 'lag'])
  })

  test('spawn + write: echo comes back as data events with a continuous off; nothing hits the disk', async () => {
    const s = await w.request({ t: 'spawn', name: 'pane-1', run: 1, plan: { command: process.execPath, args: ['-e', ECHO], cwd: home, env: process.env }, cols: 100, rows: 30, home })
    pid = s.pid!
    const a = await w.request({ t: 'attach', name: 'pane-1' })
    epoch = a.epoch!
    assert.equal(a.off, a.scrollback!.length)
    w.notice({ t: 'write', name: 'pane-1', data: 'alpha\r' })
    await waitUntil(() => w.text('pane-1').includes('alpha'), 10_000, 'echoed alpha')
    w.notice({ t: 'write', name: 'nobody', data: 'ignored\r' }) // unknown name: no reply, no error
    w.notice({ t: 'write', name: 'pane-1', data: 'beta\r' })
    await waitUntil(() => w.text('pane-1').includes('beta'), 10_000, 'echoed beta')
    let off = a.off!
    for (const d of w.data('pane-1')) { off += d.data.length; assert.equal(d.off, off, 'off is the offset after this chunk') }
    assert.equal(w.msgs.some((m) => m.t === 'error'), false)
    assert.deepEqual(onDisk(), before0, 'persist:false writes nothing under the home but its key')
  })

  test('attach {from, epoch} returns only what is missing; a wrong epoch returns the whole ring', async () => {
    const full = await w.request({ t: 'attach', name: 'pane-1' })
    const from = full.scrollback!.indexOf('beta')
    assert.ok(from > 0)
    const part = await w.request({ t: 'attach', name: 'pane-1', from, epoch })
    assert.equal(part.scrollback, full.scrollback!.slice(from))
    assert.equal(part.off, full.off)
    assert.equal(part.epoch, epoch)
    const caught = await w.request({ t: 'attach', name: 'pane-1', from: full.off, epoch })
    assert.equal(caught.scrollback, '')
    const wrong = await w.request({ t: 'attach', name: 'pane-1', from, epoch: 'other-run' })
    assert.equal(wrong.scrollback, full.scrollback)
  })

  test('release ends the run, and exit arrives after the last data', async () => {
    await w.request({ t: 'release', name: 'pane-1' })
    await waitUntil(() => w.msgs.some((m) => m.t === 'exit' && m.name === 'pane-1'), 10_000, 'exit event')
    const exitAt = w.msgs.findIndex((m) => m.t === 'exit' && m.name === 'pane-1')
    const lastData = w.msgs.map((m, i) => (m.t === 'data' ? i : -1)).reduce((a, b) => Math.max(a, b), -1)
    assert.ok(exitAt > lastData, 'exit comes after the last data')
    const list = await w.request({ t: 'list' })
    assert.ok(list.runs!.find((r) => r.name === 'pane-1')!.exit)
    assert.deepEqual(onDisk(), before0, 'still nothing on disk but its key')
    // release does not kill the tree: tidy the leftover process by pid.
    if (pidAlive(pid)) try { process.kill(pid) } catch { /* gone */ }
  })
})
