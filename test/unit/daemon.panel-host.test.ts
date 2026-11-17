// PanelHost (E1.5): remote PtyHandles over a tether-ptyd-style host running in this process (ProcHost persist:false).
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { PanelHost, type PanelConnector } from '../../src/daemon/panel-host.ts'
import { HostClient } from '../../src/procd/client.ts'
import { ProcHost, type HostOptions } from '../../src/procd/host.ts'
import type { ProcPlan } from '../../src/procd/protocol.ts'
import { pidAlive, removeHome, sleep, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

// Echo; "FLOOD" prints 8000 numbered 100-char lines then END; "STREAM" prints 3000 such lines 40 at a time every 2 ms;
// "QUIT" prints bye and exits by itself.
const CHILD = [
  "const pad = 'x'.repeat(92), NL = String.fromCharCode(10);",
  "process.stdin.on('data', (d) => {",
  "const s = String(d);",
  "if (s.includes('FLOOD')) { let o = ''; for (let i = 0; i < 8000; i++) o += 'L' + String(i).padStart(5, '0') + pad + NL; process.stdout.write(o + 'END' + NL) }",
  "else if (s.includes('STREAM')) { let i = 0; const t = setInterval(() => { let o = ''; for (let k = 0; k < 40; k++, i++) o += 'L' + String(i).padStart(5, '0') + pad + NL; process.stdout.write(o); if (i >= 3000) { clearInterval(t); process.stdout.write('END' + NL) } }, 2) }",
  "else if (s.includes('QUIT')) { process.stdout.write('bye' + NL); setTimeout(() => process.exit(3), 50) }",
  "else process.stdout.write(d);",
  "});",
  "setInterval(() => {}, 1000)",
].join(' ')

const plan = (home: string): ProcPlan => ({ command: process.execPath, args: ['-e', CHILD], cwd: home, env: process.env as Record<string, string> })
const SIZE = { cols: 100, rows: 30 }

interface Rig {
  home: string
  pipe: string
  host: ProcHost
  panel: PanelHost
  clients: HostClient[]
  ensured: { n: number }
  connector: PanelConnector
  stop(): Promise<void>
}

/** A host in this process, reached through a connector that records the clients it hands out. */
async function rig(hostOpts: Partial<HostOptions> = {}, startNow = true): Promise<Rig> {
  const home = tempHome()
  const pipe = uniquePipe(home)
  const host = new ProcHost({ home, pipe, persist: false, ...hostOpts })
  let listening = false
  const listen = async (): Promise<void> => { if (!listening) { listening = true; await host.listen() } }
  if (startNow) await listen()
  const clients: HostClient[] = []
  const ensured = { n: 0 }
  const connector: PanelConnector = {
    async tryOpen() { const c = listening ? await HostClient.tryOpen(pipe) : undefined; if (c) clients.push(c); return c },
    async ensure() { ensured.n++; await listen(); const c = await HostClient.open(pipe); clients.push(c); return c },
  }
  const panel = new PanelHost({ connector })
  return { home, pipe, host, panel, clients, ensured, connector, async stop() { panel.close(); await host.close(); await removeHome(home) } }
}

class Sink {
  text = ''
  events: string[] = []
  resets: string[] = []
  exit: number | undefined
  cb = {
    onData: (d: string) => { this.text += d; this.events.push('data') },
    onExit: (e: { exitCode: number }) => { this.exit = e.exitCode; this.events.push('exit') },
    onReset: (s: string) => { this.resets.push(s); this.text = s; this.events.push('reset') },
  }
}

describe('PanelHost: spawn, write, resize, kill, adopt', () => {
  let r: Rig
  before(async () => { r = await rig() })
  after(() => r.stop())

  test('spawn finds the host without launching; write comes back as data; resize is accepted', async () => {
    const s = new Sink()
    const h = await r.panel.spawn('a', plan(r.home), { ...SIZE, ...s.cb })
    assert.equal(r.ensured.n, 0, 'tryOpen found the host; ensure was not needed')
    assert.ok(h.pid > 0 && pidAlive(h.pid))
    h.write('alpha\r')
    await waitUntil(() => s.text.includes('alpha'), 10_000, 'alpha echoed')
    h.resize(80, 24)
    h.resize(0, 0) // ignored
    h.write('beta\r')
    await waitUntil(() => s.text.includes('beta'), 10_000, 'beta echoed')
    assert.equal(h.pendingInput(), 0)
    assert.equal(h.exit, undefined)
    await h.kill()
  })

  test('kill ends the process by pid, reports one exit, and exited resolves', async () => {
    const s = new Sink()
    const h = await r.panel.spawn('k', plan(r.home), { ...SIZE, ...s.cb })
    const pid = h.pid
    await h.kill()
    assert.ok(h.exit)
    await waitUntil(() => !pidAlive(pid), 10_000, 'process gone')
    assert.equal(s.events.filter((e) => e === 'exit').length, 1)
    assert.equal((await h.exited).exitCode, s.exit)
    h.release() // idempotent after the end
  })

  test('a process that ends by itself: exit arrives after the last data', async () => {
    const s = new Sink()
    const h = await r.panel.spawn('n', plan(r.home), { ...SIZE, ...s.cb })
    h.write('QUIT\r')
    await waitUntil(() => s.exit !== undefined, 15_000, 'natural exit')
    assert.equal(s.exit, 3)
    assert.ok(s.text.includes('bye'), 'bye was delivered')
    assert.equal(s.events.at(-1), 'exit', 'exit is the last event')
    assert.ok(!pidAlive(h.pid))
    // the name is reusable after a natural end
    const s2 = new Sink()
    const h2 = await r.panel.spawn('n', plan(r.home), { ...SIZE, ...s2.cb })
    h2.write('again\r')
    await waitUntil(() => s2.text.includes('again'), 10_000, 'second run echoes')
    await h2.kill()
  })

  test('adopt: a live run comes back with its ring, then continues; unknown or ended names give undefined', async () => {
    const s = new Sink()
    const h = await r.panel.spawn('ad', plan(r.home), { ...SIZE, ...s.cb })
    h.write('before-adopt\r')
    // The console shows the input and the child echoes it: two pieces, the second some ms after the first. Adopt only
    // once both are out, or the second is legitimate new output for the adopter (and not a replay of the ring).
    await waitUntil(() => s.text.split('before-adopt').length > 2, 10_000, 'echo seen twice')
    // a second PanelHost = a restarted tetherd
    const other = new PanelHost({ connector: { tryOpen: () => r.connector.tryOpen(), ensure: async () => { throw new Error('no launch') } } })
    assert.deepEqual((await other.list())!.map((x) => x.name), ['ad'])
    const s2 = new Sink()
    const got = await other.adopt('ad', s2.cb)
    assert.ok(got)
    assert.ok(got.scrollback.includes('before-adopt'))
    assert.equal(got.off, got.scrollback.length)
    assert.ok(got.epoch && got.spawnedAt && got.startedAt)
    assert.equal(got.handle.pid, h.pid)
    got.handle.write('after-adopt\r')
    await waitUntil(() => s2.text.includes('after-adopt'), 10_000, 'adopted handle hears new output')
    assert.equal(s2.text.includes('before-adopt'), false, 'the ring is returned, not replayed through onData')
    // The first owner heard everything since the spawn: what the adopter hears is that same stream after `off`, once.
    await waitUntil(() => s.text.length >= got.off + s2.text.length, 10_000, 'first owner caught up')
    assert.equal(s.text.slice(0, got.off), got.scrollback)
    assert.equal(s2.text, s.text.slice(got.off, got.off + s2.text.length))
    assert.equal(await other.adopt('missing', s2.cb), undefined)
    other.close()
    await h.kill()
    assert.equal(await r.panel.adopt('ad', s2.cb), undefined, 'ended run is not adoptable')
  })
})

describe('PanelHost: adopt while output flows', () => {
  test('a data event that overtakes the attach reply is superseded by the ring: every line once, in order', async () => {
    const r = await rig({ scrollbackChars: 4 * 1024 * 1024 })
    try {
      // The attach request leaves 30 ms late, so the host keeps sending data on the connection that is already attached.
      let slow = false
      const lateAttach: PanelConnector = {
        async tryOpen() {
          const c = await r.connector.tryOpen()
          if (!c) return undefined
          const request = c.request.bind(c)
          c.request = async (req) => { if (req.t === 'attach' && slow) await sleep(30); return request(req) }
          return c
        },
        ensure: () => r.connector.ensure(),
      }
      const panel = new PanelHost({ connector: lateAttach })
      const first = new Sink()
      const h = await panel.spawn('s', plan(r.home), { ...SIZE, ...first.cb })
      h.write('STREAM\r')
      await waitUntil(() => first.text.includes('L00300'), 10_000, 'output flowing')
      slow = true
      const s = new Sink()
      const got = await panel.adopt('s', s.cb) // same panel, same connection: a re-adopt
      assert.ok(got)
      await waitUntil(() => s.text.includes('END\r\n'), 20_000, 'END reached')
      const nums = [...(got.scrollback + s.text).matchAll(/L(\d{5})x/g)].map((m) => Number(m[1]))
      assert.equal(nums.length, 3000, 'no loss, no duplicate')
      nums.forEach((n, i) => { if (n !== i) assert.fail(`line ${i} out of order: ${n}`) })
      await h.kill()
      panel.close()
    } finally {
      await r.stop()
    }
  })
})

describe('PanelHost: connection', () => {
  test('launches on demand; a dropped connection ends every handle with -1; the next spawn reconnects', async () => {
    const r = await rig({}, false)
    try {
      assert.equal(await r.panel.list(), undefined, 'no host: list does not launch')
      assert.equal(await r.panel.adopt('x', new Sink().cb), undefined)
      assert.equal(r.ensured.n, 0)
      const a = new Sink()
      const b = new Sink()
      const ha = await r.panel.spawn('a', plan(r.home), { ...SIZE, ...a.cb })
      await r.panel.spawn('b', plan(r.home), { ...SIZE, ...b.cb })
      assert.equal(r.ensured.n, 1)
      assert.equal(r.clients.length, 1, 'one connection for both panes')
      r.clients[0]!.close()
      await waitUntil(() => a.exit !== undefined && b.exit !== undefined, 10_000, 'both exits')
      assert.equal(a.exit, -1)
      assert.equal(b.exit, -1)
      assert.equal(r.panel.connected, false)
      assert.equal((await ha.exited).exitCode, -1)
      const c = new Sink()
      const hc = await r.panel.spawn('c', plan(r.home), { ...SIZE, ...c.cb })
      assert.equal(r.ensured.n, 1, 'the host was still there: no launch')
      hc.write('hi\r')
      await waitUntil(() => c.text.includes('hi'), 10_000, 'echo after reconnect')
      await hc.kill()
    } finally {
      await r.stop()
    }
  })
})

/** Parks the connection's socket so the host's queue for it overflows (test-only reach into the client). */
const sock = (c: HostClient): { pause(): void; resume(): void } => (c as unknown as { socket: { pause(): void; resume(): void } }).socket

describe('PanelHost: lag recovers without loss or repetition', () => {
  test('forced lag with low ceilings: the owner ends with every line exactly once, in order', async () => {
    const r = await rig({ outHighWater: 4 * 1024, outQueueMax: 32 * 1024, batchMs: 5, scrollbackChars: 4 * 1024 * 1024 })
    try {
      const s = new Sink()
      const h = await r.panel.spawn('f', plan(r.home), { ...SIZE, ...s.cb })
      sock(r.clients[0]!).pause()
      h.write('FLOOD\r')
      await waitUntil(() => r.host.stats().queuesDropped >= 1, 20_000, 'queue dropped')
      await sleep(300)
      sock(r.clients[0]!).resume()
      await waitUntil(() => s.text.includes('END\r\n'), 20_000, 'END reached')
      assert.equal(s.resets.length, 0, 'the ring still covered it: no reset')
      const lines = [...s.text.matchAll(/L\d{5}x/g)].map((m) => m[0])
      assert.equal(lines.length, 8000, 'no loss, no duplicate')
      lines.forEach((l, i) => { if (!l.startsWith('L' + String(i).padStart(5, '0'))) assert.fail(`line ${i} out of order: ${l.slice(0, 8)}`) })
      await h.kill()
    } finally {
      await r.stop()
    }
  })

  test('when the ring no longer covers the owner, onReset gets the whole ring and the text continues from it', async () => {
    const r = await rig({ outHighWater: 4 * 1024, outQueueMax: 32 * 1024, batchMs: 5, scrollbackChars: 64 * 1024 })
    try {
      const s = new Sink()
      const h = await r.panel.spawn('g', plan(r.home), { ...SIZE, ...s.cb })
      sock(r.clients[0]!).pause()
      h.write('FLOOD\r')
      await waitUntil(() => r.host.stats().queuesDropped >= 1, 20_000, 'queue dropped')
      await sleep(500)
      sock(r.clients[0]!).resume()
      await waitUntil(() => s.resets.length >= 1 && s.text.includes('END\r\n'), 20_000, 'reset and END')
      assert.ok(s.resets[0]!.length <= 64 * 1024)
      assert.ok(s.text.endsWith('END\r\n'), 'owner text ends where the process did')
      const nums = [...s.text.matchAll(/L(\d{5})x/g)].map((m) => Number(m[1]))
      assert.equal(nums.at(-1), 7999)
      nums.forEach((n, i) => { if (i && n !== nums[i - 1]! + 1) assert.fail(`gap or repeat after reset at ${n}`) })
      await h.kill()
    } finally {
      await r.stop()
    }
  })
})
