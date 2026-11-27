// RR3 step 3.4a, end to end: the three reads of the remote (regency.tree, channels.marks, channels.page) and their thin
// notices, through the whole path. A tetherd of the bench (home under TETHER_BENCH_DIR or the system temp, never the
// person's; its folder name carries a SECRET, so every path of the machine does) with the `remote`, `channels` and
// `regency` extensions and the real portal; the REAL relay (remote/relay/, its own process) behind a spy (a TCP proxy that
// keeps every WebSocket payload, unmasked, of both legs); and a test device in this process (DevicePairing /
// DeviceHandshake over Node's WebSocket). The app (a pipe client `app`) creates a channel, speaks in it with an attachment,
// and publishes the Regency's tree, with a CANARY in what a device may see. Played in order: pair, read the tree, the
// marks and the channel page by page; a new line and a new tree reach the device as notices; the spy never saw the CANARY
// in clear, and the device never got the SECRET (the attachment's path, the home).
import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { connect as netConnect, createServer, type Server, type Socket } from 'node:net'
import { join, resolve } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { DaemonClient } from '../../src/daemon/client.ts'
import { DoorHost } from '../../src/daemon/door/host.ts'
import { DaemonExtensionHost } from '../../src/daemon/ext-host.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { decodeOuter, OP_CODES, RES_STATUS, WS_SUBPROTOCOL, type Bytes } from '../../src/remote/index.ts'
import { EVT } from '../../src/remote/scopes.ts'
import { activateWith as activateRemote } from '../../extensions/remote/daemon.ts'
import { manifest as remoteManifest } from '../../extensions/remote/manifest.ts'
import { activate as activateChannels } from '../../extensions/channels/daemon.ts'
import { manifest as channelsManifest } from '../../extensions/channels/manifest.ts'
import { activateWith as activateRegency } from '../../extensions/regency/daemon.ts'
import { manifest as regencyManifest } from '../../extensions/regency/manifest.ts'
import { removeHome, uniquePipe } from '../unit/daemon.helpers.ts'
import { benchHome, TestDevice, until, type DeviceSession, type FakeRelay } from '../unit/remoted.helpers.ts'

const root = resolve(import.meta.dirname, '..', '..')
/** What a device may see (a line's body, a pane's title): it must reach the device, and never cross the relay in clear. */
const CANARY = `canario-${randomBytes(6).toString('hex')}`
/** In the bench home's name, so in every path of the machine: it must reach neither the relay nor the device. */
const SECRET = `segredo${randomBytes(6).toString('hex')}`

const ext = async (c: DaemonClient, name: string, args?: Record<string, unknown>, extName = 'remote'): Promise<Record<string, unknown>> =>
  (await c.request({ t: 'ext-request', ext: extName, name, ...(args ? { args } : {}) })).result as Record<string, unknown>

// ---- the spy: a TCP proxy that reads the WebSocket frames going through it (as in remote.skeleton) ---------------

function wsTap(onFrame: (payload: Buffer) => void): (chunk: Buffer) => void {
  let buf = Buffer.alloc(0)
  let header = true
  let frag: Buffer[] = []
  return (chunk) => {
    buf = Buffer.concat([buf, chunk])
    if (header) {
      const i = buf.indexOf('\r\n\r\n')
      if (i < 0) return
      buf = buf.subarray(i + 4)
      header = false
    }
    for (;;) {
      if (buf.length < 2) return
      const fin = (buf[0]! & 0x80) !== 0
      const op = buf[0]! & 0x0f
      const masked = (buf[1]! & 0x80) !== 0
      let len = buf[1]! & 0x7f
      let at = 2
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); at = 4 } else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); at = 10 }
      const maskAt = at
      if (masked) at += 4
      if (buf.length < at + len) return
      const payload = Buffer.from(buf.subarray(at, at + len))
      if (masked) for (let i = 0; i < payload.length; i++) payload[i]! ^= buf[maskAt + (i % 4)]!
      buf = buf.subarray(at + len)
      if (op >= 0x8) continue
      frag.push(payload)
      if (fin) { onFrame(Buffer.concat(frag)); frag = [] }
    }
  }
}

class Spy {
  readonly frames: Buffer[] = []
  readonly raw: Buffer[] = []
  target = 0
  #server!: Server
  readonly #sockets = new Set<Socket>()

  async start(): Promise<number> {
    this.#server = createServer((client) => {
      const up = netConnect({ host: 'localhost', port: this.target })
      this.#sockets.add(client).add(up)
      const tapUp = wsTap((p) => this.frames.push(p))
      const tapDown = wsTap((p) => this.frames.push(p))
      client.on('data', (c: Buffer) => { this.raw.push(c); tapUp(c); up.write(c) })
      up.on('data', (c: Buffer) => { this.raw.push(c); tapDown(c); client.write(c) })
      const end = (): void => { client.destroy(); up.destroy(); this.#sockets.delete(client); this.#sockets.delete(up) }
      client.on('close', end); up.on('close', end)
      client.on('error', () => {}); up.on('error', () => {})
    })
    await new Promise<void>((r) => this.#server.listen(0, 'localhost', r))
    return (this.#server.address() as { port: number }).port
  }

  close(): Promise<void> {
    for (const s of this.#sockets) s.destroy()
    return new Promise((r) => this.#server.close(() => r()))
  }

  saw(text: string): boolean {
    const needle = Buffer.from(text, 'utf8')
    return this.frames.some((f) => f.includes(needle)) || Buffer.concat(this.raw).includes(needle)
  }
}

// ---- the device's leg: Node's WebSocket to the real relay, in the shape TestDevice drives ---------------------------

class WsLeg {
  readonly inbox: ReturnType<typeof decodeOuter>[] = []
  closed = false
  route: number | undefined
  readonly #ws: WebSocket
  readonly #pending: Bytes[] = []
  #waiters: (() => void)[] = []

  constructor(url: string) {
    this.#ws = new WebSocket(url, WS_SUBPROTOCOL)
    this.#ws.binaryType = 'arraybuffer'
    this.#ws.onopen = () => { for (const b of this.#pending.splice(0)) this.#ws.send(b) }
    this.#ws.onmessage = (e: MessageEvent) => {
      if (!(e.data instanceof ArrayBuffer)) return
      this.inbox.push(decodeOuter('device', 'relay', new Uint8Array(e.data)))
      this.#wake()
    }
    this.#ws.onclose = () => { this.closed = true; this.#wake() }
    this.#ws.onerror = () => { this.closed = true; this.#wake() }
  }

  #wake(): void { for (const w of this.#waiters.splice(0)) w() }

  async next(ms = 5_000): Promise<ReturnType<typeof decodeOuter>> {
    const end = Date.now() + ms
    while (this.inbox.length === 0) {
      if (this.closed) throw new Error('device leg closed')
      if (Date.now() > end) throw new Error('device leg: nothing arrived')
      await new Promise<void>((r) => { this.#waiters.push(r); setTimeout(r, 50) })
    }
    return this.inbox.shift()!
  }

  send(bytes: Bytes): void {
    if (this.#ws.readyState === WebSocket.OPEN) this.#ws.send(bytes)
    else if (this.#ws.readyState === WebSocket.CONNECTING) this.#pending.push(bytes)
  }

  close(): void { if (!this.closed) { this.closed = true; this.#ws.close() } }
}

// ---- child processes of the bench ---------------------------------------------------------------------------------

function spawnNode(args: string[], event: string, lines: string[]): Promise<{ proc: ChildProcess; line: Record<string, unknown> }> {
  return new Promise((resolveP, reject) => {
    const proc = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } })
    let pending = ''
    let done = false
    const timer = setTimeout(() => { if (!done) { done = true; reject(new Error(`${args[0]}: no ${event} in 15 s`)) } }, 15_000)
    proc.stdout!.on('data', (c: Buffer) => {
      pending += c.toString('utf8')
      let i
      while ((i = pending.indexOf('\n')) >= 0) {
        const l = pending.slice(0, i)
        pending = pending.slice(i + 1)
        lines.push(l)
        try {
          const j = JSON.parse(l) as Record<string, unknown>
          if (!done && j.event === event) { done = true; clearTimeout(timer); resolveP({ proc, line: j }) }
        } catch { /* not JSON */ }
      }
    })
    proc.stderr!.on('data', (c: Buffer) => lines.push(`[stderr] ${c.toString('utf8')}`))
    proc.on('exit', (code) => { if (!done) { done = true; clearTimeout(timer); reject(new Error(`${args[0]} exited ${code}: ${lines.join('\n')}`)) } })
  })
}

/** Our own bench process and its tree, by PID only. */
function killTree(p: ChildProcess | undefined): void {
  if (!p?.pid || p.exitCode !== null) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' })
  else p.kill('SIGKILL')
}

/** The Regency's entry as the app publishes it, with the CANARY in a pane's title and in its seal line (RR3.4d). */
const tree = (title: string): Record<string, unknown> => ({
  desks: { desks: [{ id: 'desk-1', name: 'Mesa', color: 'blue', kind: 'queue', asleep: false, panes: [{ id: 'a1b2c3d4', type: 'agent', icon: 'claude', title, lines: [`revisa ${CANARY}`, 'Esperando você'] }] }] },
  owners: { desk: {}, pane: {} }, channels: [], channelMarks: {}, agents: [{ id: 'a1b2c3d4', kind: 'claude', name: 'conferente' }], since: {}, collapsed: [],
})

// ---- the test ---------------------------------------------------------------------------------------------------

describe('remote reads end to end (RR3.4a): the tree, the marks and a channel page through the real relay', () => {
  const home = benchHome(`tether-remote-read-${SECRET}-`)
  const pipe = uniquePipe(home)
  const logs: string[] = []
  const relayLines: string[] = []
  const env: NodeJS.ProcessEnv = {
    ...process.env, TETHER_TEST_REMOTE: '1', TETHER_TEST_REMOTE_NOTICE: join(home, 'notices.txt'), TETHER_TEST_REMOTE_TICK_MS: '200',
    TETHER_TEST_REMOTE_CHANNELS_GAP_MS: '300', TETHER_TEST_REMOTE_REGENCY_GAP_MS: '300',
  }
  const door = new DoorHost({ log: () => {} })
  const spy = new Spy()
  let daemon: Daemon
  let extHost: DaemonExtensionHost
  let app: DaemonClient
  let cli: DaemonClient
  let relay: ChildProcess | undefined
  let device: TestDevice
  let s: DeviceSession
  let channelId = ''
  let memberId = ''
  let moderatorName = ''
  let deviceUrl = ''
  let aud = ''
  const got: unknown[] = []
  const read = async (op: number, body: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const r = await s.request(op, body)
    got.push(r)
    assert.equal(r.status, RES_STATUS.ok, `op 0x${op.toString(16)}: ${JSON.stringify(r.body)}`)
    return r.body
  }

  before(async () => {
    const spyPort = await spy.start()
    aud = `localhost:${spyPort}`
    deviceUrl = `ws://${aud}/v1/device`
    // No --origins: the device here is no browser; the Origin check is the relay's own test.
    const r = await spawnNode(['remote/relay/src/main.ts', 'serve', '--port', '0', '--aud', aud], 'relay.listening', relayLines)
    relay = r.proc
    spy.target = Number(r.line.port)

    extHost = new DaemonExtensionHost({
      home, log: (m) => logs.push(m), door,
      extensions: [
        { manifest: remoteManifest, activate: (api) => activateRemote(api, { env }).disposables },
        { manifest: channelsManifest, activate: (api) => activateChannels(api) },
        { manifest: regencyManifest, activate: (api) => activateRegency(api).disposables },
      ],
    })
    extHost.activate()
    daemon = await startDaemon({ home, pipe, memoryIntervalMs: 0, door, log: (m) => logs.push(m) })
    extHost.emitStarted()
    app = await DaemonClient.open(pipe, 'app', { home })
    cli = await DaemonClient.open(pipe, 'cli', { home })
    assert.deepEqual(await ext(app, 'remote.on', { relayUrl: `ws://${aud}/v1/house` }), { on: true })
    for (let i = 0; i < 100; i++) { if ((await ext(cli, 'remote.status')).link === 'up') break; await new Promise((res) => setTimeout(res, 200)) }
    assert.equal((await ext(cli, 'remote.status')).link, 'up', `the house at the relay:\n${relayLines.join('\n')}`)

    // What the app holds: a channel with 55 lines, the last with an attachment, and the published tree.
    const made = await ext(app, 'create', { name: 'obra' }, 'channels')
    channelId = (made.channel as { id: string }).id
    // A member (RR3.4d): an agent's slot, not started, joined by the person.
    const created = await cli.request({ t: 'create', kind: 'claude', cwd: home, name: 'conferente', start: false }) as { slot?: { slotId: string } }
    memberId = created.slot!.slotId
    await ext(app, 'join', { channel: channelId, agent: memberId }, 'channels')
    for (let i = 1; i <= 54; i++) await ext(app, 'say', { channel: channelId, text: `fala ${i} ${CANARY}` }, 'channels')
    const file = join(home, 'nota.txt')
    writeFileSync(file, 'conteúdo do anexo')
    await ext(app, 'say', { channel: channelId, text: `com anexo ${CANARY}`, files: [{ path: file }] }, 'channels')
    await ext(app, 'tree.publish', { tree: tree(`Agente ${CANARY}`) }, 'regency')

    const relayLike = { device: () => new WsLeg(deviceUrl), aud } as unknown as FakeRelay
    device = await TestDevice.make(relayLike)
  })

  after(async () => {
    s?.leg.close()
    try { await ext(cli, 'remote.off') } catch { /* already off */ }
    app?.close()
    cli?.close()
    extHost?.dispose()
    await daemon?.close()
    killTree(relay)
    await spy.close()
    await removeHome(home)
  })

  test('pairing through the real relay, the SAS typed on the house, then a normal session', async () => {
    const begun = await ext(app, 'pair.begin')
    const { sas, done } = await device.pair(String(begun.code), { name: 'Telefone de leitura' })
    const digits = await sas
    for (let i = 0; i < 100 && (await ext(app, 'pair.state', { pairId: begun.pairId })).state !== 'waiting-sas'; i++) await new Promise((res) => setTimeout(res, 100))
    await ext(app, 'pair.sas', { pairId: begun.pairId, digits })
    const first = await done
    assert.ok(!('failed' in first), `pairing: ${JSON.stringify(first)}`)
    for (let i = 0; i < 100 && (await ext(app, 'pair.state', { pairId: begun.pairId })).state !== 'done'; i++) await new Promise((res) => setTimeout(res, 100))
    first.leg.close()
    const c = await device.connect()
    assert.ok(!('failed' in c), `session: ${JSON.stringify(c)}`)
    s = c
  })

  test("regency.tree: the app's tree, live, with its signature; the device's folds are its own", async () => {
    const t = await read(OP_CODES['regency.tree'])
    assert.equal(t.live, true)
    assert.match(String(t.sig), /^[0-9a-f]{16}$/)
    const input = t.input as { desks: { desks: { panes: { title: string; lines?: string[] }[] }[] }; collapsed: unknown[] }
    assert.equal(input.desks.desks[0]!.panes[0]!.title, `Agente ${CANARY}`)
    assert.deepEqual(input.desks.desks[0]!.panes[0]!.lines, [`revisa ${CANARY}`, 'Esperando você'], 'the seal lines of a live tree')
    assert.deepEqual(input.collapsed, [])
  })

  test("channels.marks: the open channel, counted by the rule of the app, with its members' ids and the person's name", async () => {
    const m = await read(OP_CODES['channels.marks'])
    const rows = m.channels as { channel: string; name: string; unread: number; members: string[] }[]
    assert.deepEqual(rows.map((r) => [r.channel, r.name]), [[channelId, 'obra']])
    assert.equal(rows[0]!.unread, 0, "the person's own speech is not unread")
    assert.deepEqual(rows[0]!.members, [memberId], "an agent's channels, by its id")
    assert.equal(typeof (m.moderator as { name: string }).name, 'string')
    assert.notEqual((m.moderator as { name: string }).name, '')
    moderatorName = (m.moderator as { name: string }).name
  })

  test('channels.page: the latest page, then the one before by the cursor; the attachment by its name, never its path', async () => {
    const latest = await read(OP_CODES['channels.page'], { channel: channelId })
    const lines = latest.lines as { seq: number; body: string; files?: { name: string }[] }[]
    assert.equal(lines.length, 50)
    const last = Number(latest.last)
    assert.equal(lines.at(-1)!.seq, last)
    assert.equal(latest.before, lines[0]!.seq, 'the cursor is the first line of this page')
    assert.deepEqual(lines.at(-1)!.files?.map((f) => f.name), ['nota.txt'])
    assert.deepEqual(latest.members, [{ id: memberId, name: 'conferente' }], 'who is in the channel now')
    assert.deepEqual(latest.moderator, { name: moderatorName }, "the person's name, the same as the marks'")
    const older = await read(OP_CODES['channels.page'], { channel: channelId, before: latest.before })
    const olderLines = older.lines as { seq: number }[]
    assert.equal(olderLines.at(-1)!.seq, Number(latest.before) - 1, 'the page before ends right before the cursor')
    assert.equal(olderLines[0]!.seq, 1)
    assert.equal(older.before, undefined, 'the start of the channel')
    assert.equal((await s.request(OP_CODES['channels.page'], { channel: 'c_naoexiste' })).status, RES_STATUS.notFound)
  })

  test('the notices: a new line and a new tree reach the device as thin events, and reading again shows them', async () => {
    const from = s.events.length
    await ext(app, 'say', { channel: channelId, text: `nova ${CANARY}` }, 'channels')
    await ext(app, 'tree.publish', { tree: tree(`Agente novo ${CANARY}`) }, 'regency')
    await until(() => (s.events.slice(from).some((e) => e.evt === EVT.channelsChanged.code) && s.events.slice(from).some((e) => e.evt === EVT.regencyChanged.code)) || undefined, 10_000, 'both notices')
    const evs = s.events.slice(from)
    got.push(evs)
    const ch = evs.find((e) => e.evt === EVT.channelsChanged.code)!.body
    assert.ok((ch.channels as string[]).includes(channelId))
    const rg = evs.find((e) => e.evt === EVT.regencyChanged.code)!.body
    assert.equal(rg.live, true)
    assert.equal(JSON.stringify(evs).includes(CANARY), false, 'a notice carries no content')
    const page = await read(OP_CODES['channels.page'], { channel: channelId })
    assert.match((page.lines as { body: string }[]).at(-1)!.body, /^nova /)
    const t = await read(OP_CODES['regency.tree'])
    assert.equal(t.sig, rg.sig)
  })

  test('the spy between the device and the relay never saw the CANARY in clear; the device never got the SECRET', () => {
    assert.ok(JSON.stringify(got).includes(CANARY), 'the CANARY did reach the device (it is what the person reads)')
    assert.equal(spy.saw(CANARY), false, 'no frame crossing the relay carries the CANARY in clear')
    assert.equal(spy.saw(SECRET), false, 'nor the SECRET of the machine')
    assert.equal(JSON.stringify(got).includes(SECRET), false, "the device got no path of the machine (the attachment's, the home)")
    assert.ok(spy.frames.length > 20, 'the spy did see the traffic')
  })
})
