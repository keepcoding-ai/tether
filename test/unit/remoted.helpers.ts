// Bench for the remote portal: a minimal WebSocket server (the root package has no `ws`; RFC 6455 is small enough for a
// test), a fake relay in this process that checks the house for real (verifyHouseAuth / verifyDeviceAdmit) and repasses
// opaque frames between the house's socket and in-process device legs, a spy that keeps every frame that crossed it, and
// a test device made of DevicePairing / DeviceHandshake. The integration with the real relay (remote/relay/) is step 1.5's.
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  accessFromCode, buildDeviceAdmit, decodeEvt, decodeOuter, decodeRes, DenyList, DeviceHandshake, DevicePairing, encodeOuter,
  encodeReq, generateRoleKey, NOTICE, PAIR_STATE, R_AUTH_FAIL_CODE, ROUTE_KIND, toHex, verifyDeviceAdmit, verifyHouseAuth,
  WS_SUBPROTOCOL, type Bytes, type DeviceHsFailure, type DevicePairFailure, type HsDoneInfo, type PairResult, type RelayHouse,
  type RoleKey, type Session, type SessionEffect, type UvProof,
} from '../../src/remote/index.ts'

/** Bench homes live under TETHER_BENCH_DIR when set (the house rule: C:/atrium/.tmp/…), else the system temp. */
export function benchHome(prefix = 'tether-remoted-'): string {
  return mkdtempSync(join(process.env.TETHER_BENCH_DIR ?? tmpdir(), prefix))
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function until<T>(f: () => T | undefined | false, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = f()
    if (v) return v
    if (Date.now() > end) throw new Error(`timeout (${ms} ms) waiting for ${what}`)
    await sleep(25)
  }
}

// ---- a minimal WebSocket server (binary frames, close, ping) ---------------------------------------------------------

export class WsConn {
  #buf = Buffer.alloc(0)
  #frag: Buffer[] = []
  onBinary: (b: Uint8Array) => void = () => {}
  onText: () => void = () => {}
  onClose: () => void = () => {}
  closed = false
  readonly socket: Socket

  constructor(socket: Socket) {
    this.socket = socket
    socket.on('data', (c: Buffer) => { this.#buf = Buffer.concat([this.#buf, c]); this.#parse() })
    socket.on('close', () => { if (!this.closed) { this.closed = true; this.onClose() } })
    socket.on('error', () => {})
  }

  #parse(): void {
    for (;;) {
      const b = this.#buf
      if (b.length < 2) return
      const fin = (b[0]! & 0x80) !== 0
      const op = b[0]! & 0x0f
      const masked = (b[1]! & 0x80) !== 0
      let len = b[1]! & 0x7f
      let at = 2
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); at = 4 } else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); at = 10 }
      const maskAt = at
      if (masked) at += 4
      if (b.length < at + len) return
      const payload = Buffer.from(b.subarray(at, at + len))
      if (masked) for (let i = 0; i < payload.length; i++) payload[i]! ^= b[maskAt + (i % 4)]!
      this.#buf = b.subarray(at + len)
      if (op === 0x8) { this.close(); return }
      if (op === 0x9) { this.#write(0xa, payload); continue }
      if (op === 0xa) continue
      if (op === 0x1) { this.onText(); continue }
      this.#frag.push(payload)
      if (fin) { const whole = Buffer.concat(this.#frag); this.#frag = []; this.onBinary(new Uint8Array(whole)) }
    }
  }

  #write(op: number, payload: Uint8Array): void {
    if (this.closed || this.socket.destroyed) return
    const n = payload.length
    const head = n < 126 ? Buffer.from([0x80 | op, n]) : n < 65536 ? Buffer.from([0x80 | op, 126, n >> 8, n & 0xff]) : (() => { const h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); return h })()
    this.socket.write(Buffer.concat([head, payload]))
  }

  send(b: Uint8Array): void { this.#write(0x2, b) }

  close(): void {
    if (this.closed) return
    this.#write(0x8, Buffer.from([0x03, 0xe8]))
    this.closed = true
    this.socket.end()
    setTimeout(() => this.socket.destroy(), 50)
    this.onClose()
  }
}

export async function wsServer(onConn: (c: WsConn, req: IncomingMessage) => void): Promise<{ server: Server; port: number; close(): Promise<void> }> {
  const sockets = new Set<Socket>()
  const server = createServer((_req, res) => { res.statusCode = 404; res.end() })
  server.on('upgrade', (req, socket: Socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    const key = req.headers['sec-websocket-key']
    const protos = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((s) => s.trim())
    if (typeof key !== 'string' || !protos.includes(WS_SUBPROTOCOL)) { socket.destroy(); return }
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: ${WS_SUBPROTOCOL}\r\n\r\n`)
    onConn(new WsConn(socket), req)
  })
  await new Promise<void>((r) => server.listen(0, 'localhost', r))
  const port = (server.address() as { port: number }).port
  return {
    server, port,
    close: () => new Promise<void>((r) => { for (const s of sockets) s.destroy(); server.close(() => r()) }),
  }
}

// ---- the fake relay ----------------------------------------------------------------------------------------------

interface HouseConn {
  ws: WsConn
  r: Bytes
  house?: RelayHouse
  deny: DenyList
  listen?: string[]
  routes: Map<number, DeviceLeg>
}

/** One device's socket at the relay, in this process: frames in (`send`) and out (`inbox`). */
export class DeviceLeg {
  readonly nR = new Uint8Array(randomBytes(32))
  readonly inbox: ReturnType<typeof decodeOuter>[] = []
  route: number | undefined
  closed = false
  readonly #relay: FakeRelay
  #admitted = false
  #waiters: (() => void)[] = []

  constructor(relay: FakeRelay) {
    this.#relay = relay
    this.push(encodeOuter({ type: 'R_HELLO', nR: this.nR }))
  }

  /** A frame the relay writes to this device. */
  push(bytes: Bytes): void {
    this.#relay.spy.push({ dir: 'to-device', bytes })
    this.inbox.push(decodeOuter('device', 'relay', bytes))
    for (const w of this.#waiters.splice(0)) w()
  }

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
    this.#relay.spy.push({ dir: 'from-device', bytes })
    const f = decodeOuter('device', 'end', bytes, { preAuth: !this.#admitted })
    void this.#relay.fromDevice(this, f, Date.now())
  }

  admitted(route: number): void { this.#admitted = true; this.route = route }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.#relay.deviceClosed(this)
    for (const w of this.#waiters.splice(0)) w()
  }
}

export class FakeRelay {
  readonly spy: { dir: 'to-house' | 'from-house' | 'to-device' | 'from-device'; bytes: Bytes }[] = []
  house: HouseConn | undefined
  houseAuths = 0
  #nextRoute = 1
  #srv!: Awaited<ReturnType<typeof wsServer>>

  static async start(): Promise<FakeRelay> {
    const r = new FakeRelay()
    r.#srv = await wsServer((c, req) => r.#onConn(c, req))
    return r
  }

  get url(): string { return `ws://localhost:${this.#srv.port}/v1/house` }
  get aud(): string { return `localhost:${this.#srv.port}` }
  get linkUp(): boolean { return this.house?.house !== undefined && !this.house.ws.closed }

  close(): Promise<void> { return this.#srv.close() }

  /** Cuts the house's socket, as a network drop would. */
  dropHouse(): void { this.house?.ws.socket.destroy() }

  #toHouse(h: HouseConn, bytes: Bytes): void { this.spy.push({ dir: 'to-house', bytes }); h.ws.send(bytes) }

  #onConn(ws: WsConn, req: IncomingMessage): void {
    if (req.url !== '/v1/house') { ws.close(); return }
    const h: HouseConn = { ws, r: new Uint8Array(randomBytes(32)), deny: new DenyList(), routes: new Map() }
    ws.onText = () => ws.close()
    ws.onClose = () => {
      if (this.house === h) this.house = undefined
      for (const leg of h.routes.values()) leg.close()
    }
    ws.onBinary = (bytes) => { void this.#fromHouse(h, bytes) }
    this.#toHouse(h, encodeOuter({ type: 'R_CHALLENGE', r: h.r }))
  }

  async #fromHouse(h: HouseConn, bytes: Uint8Array): Promise<void> {
    this.spy.push({ dir: 'from-house', bytes: new Uint8Array(bytes) })
    const nowS = Math.floor(Date.now() / 1000)
    if (!h.house) {
      const f = decodeOuter('house', 'end', bytes, { preAuth: true })
      if (f.type !== 'H_AUTH') { h.ws.close(); return }
      const v = await verifyHouseAuth({ auth: f, r: h.r, aud: this.aud, nowS })
      if (!v.ok) { this.#toHouse(h, encodeOuter({ type: 'R_AUTH_FAIL', code: R_AUTH_FAIL_CODE })); h.ws.close(); return }
      h.house = v.house
      this.house = h
      this.houseAuths++
      this.#toHouse(h, encodeOuter({ type: 'R_AUTH_OK' }))
      return
    }
    const f = decodeOuter('house', 'end', bytes)
    switch (f.type) {
      case 'H_DENY': {
        const r = h.deny.apply(f, nowS)
        if (!r.ok) this.#toHouse(h, encodeOuter({ type: 'R_NOTICE', code: NOTICE.limit }))
        return
      }
      case 'H_PAIR_LISTEN':
        h.listen = f.rvs.map(toHex)
        this.#toHouse(h, encodeOuter({ type: 'R_PAIR_STATE', code: PAIR_STATE.listening }))
        return
      case 'H_PAIR_CANCEL': h.listen = undefined; return
      case 'ROUTE_DATA': h.routes.get(f.routeId)?.push(encodeOuter({ type: 'DATA', inner: f.inner })); return
      case 'ROUTE_CLOSE': {
        const leg = h.routes.get(f.routeId)
        h.routes.delete(f.routeId)
        leg?.close()
        return
      }
      case 'LINK_PING': this.#toHouse(h, encodeOuter({ type: 'LINK_PONG', echo: f.echo })); return
      default: return
    }
  }

  device(): DeviceLeg { return new DeviceLeg(this) }

  async fromDevice(leg: DeviceLeg, f: ReturnType<typeof decodeOuter>, arrival: number): Promise<void> {
    const h = this.house
    const fail = async (): Promise<void> => {
      await sleep(Math.max(0, arrival + 500 - Date.now()))
      leg.push(encodeOuter({ type: 'R_FAIL' }))
      leg.closed = true
    }
    if (f.type === 'D_ADMIT') {
      const v = await verifyDeviceAdmit({ admit: f, nR: leg.nR, aud: this.aud, nowS: Math.floor(Date.now() / 1000), house: h?.house, deny: h?.deny })
      if (!v.ok || !h) return fail()
      const route = this.#nextRoute++
      h.routes.set(route, leg)
      leg.admitted(route)
      leg.push(encodeOuter({ type: 'R_OK' }))
      this.#toHouse(h, encodeOuter({ type: 'ROUTE_OPEN', routeId: route, kind: ROUTE_KIND.admit, hint: v.ticketId }))
      return
    }
    if (f.type === 'D_PAIR') {
      if (!h?.listen?.includes(toHex(f.rv))) return fail()
      const route = this.#nextRoute++
      h.routes.set(route, leg)
      leg.admitted(route)
      leg.push(encodeOuter({ type: 'R_OK' }))
      this.#toHouse(h, encodeOuter({ type: 'ROUTE_OPEN', routeId: route, kind: ROUTE_KIND.pair, hint: f.rv }))
      return
    }
    if (f.type === 'DATA' && h && leg.route !== undefined) this.#toHouse(h, encodeOuter({ type: 'ROUTE_DATA', routeId: leg.route, inner: f.inner }))
  }

  deviceClosed(leg: DeviceLeg): void {
    const h = this.house
    if (!h || leg.route === undefined || h.routes.get(leg.route) !== leg) return
    h.routes.delete(leg.route)
    this.#toHouse(h, encodeOuter({ type: 'ROUTE_CLOSE', routeId: leg.route }))
  }

  /** Every byte that crossed the relay, both legs, both directions. */
  allBytes(): Buffer { return Buffer.concat(this.spy.map((s) => Buffer.from(s.bytes))) }
}

// ---- a test device -----------------------------------------------------------------------------------------------

export interface DeviceReply { status: number; body: Record<string, unknown> }

export class DeviceSession {
  readonly session: Session
  readonly leg: DeviceLeg
  readonly info: HsDoneInfo | undefined
  readonly events: { evt: number; body: Record<string, unknown> }[] = []
  closed: { by: string; code?: number } | undefined
  #reqId = 1
  readonly #waiting = new Map<number, (r: DeviceReply) => void>()

  constructor(session: Session, leg: DeviceLeg, info: HsDoneInfo | undefined) {
    this.session = session
    this.leg = leg
    this.info = info
    void this.#pump()
  }

  async #pump(): Promise<void> {
    for (;;) {
      let f
      try { f = await this.leg.next(600_000) } catch { this.closed ??= { by: 'route' }; return }
      if (f.type !== 'DATA') continue
      this.#apply(await this.session.receive(f.inner, Date.now()))
      if (this.closed) return
    }
  }

  #apply(fx: SessionEffect[]): void {
    for (const e of fx) {
      if (e.t === 'send') this.leg.send(encodeOuter({ type: 'DATA', inner: e.frame }))
      else if (e.t === 'closed') { this.closed = { by: e.by, ...(e.code !== undefined ? { code: e.code } : {}) }; this.leg.close() }
      else if (e.ctype === 'RES') {
        const r = decodeRes(e.content)
        this.#waiting.get(r.reqId)?.({ status: r.status, body: JSON.parse(new TextDecoder().decode(r.body)) as Record<string, unknown> })
        this.#waiting.delete(r.reqId)
      } else if (e.ctype === 'EVT') {
        const v = decodeEvt(e.content)
        this.events.push({ evt: v.evt, body: JSON.parse(new TextDecoder().decode(v.body)) as Record<string, unknown> })
      }
    }
  }

  async request(op: number, body: Record<string, unknown> = {}, o: { actId?: Bytes; raw?: Bytes; uvProof?: UvProof } = {}): Promise<DeviceReply> {
    const reqId = this.#reqId++
    const content = encodeReq({
      reqId, op, ...(o.actId ? { actId: o.actId } : {}), ...(o.uvProof ? { uvProof: o.uvProof } : {}),
      body: o.raw ?? new TextEncoder().encode(JSON.stringify(body)),
    })
    const got = new Promise<DeviceReply>((resolve, reject) => {
      this.#waiting.set(reqId, resolve)
      setTimeout(() => reject(new Error(`no RES for op 0x${op.toString(16)}`)), 10_000)
    })
    this.#apply(await this.session.send('REQ', content, Date.now()))
    return got
  }
}

export class TestDevice {
  kD!: RoleKey
  kA!: RoleKey
  result: PairResult | undefined
  readonly relay: FakeRelay

  constructor(relay: FakeRelay) { this.relay = relay }

  static async make(relay: FakeRelay): Promise<TestDevice> {
    const d = new TestDevice(relay)
    d.kD = (await generateRoleKey('device')).key
    d.kA = (await generateRoleKey('admission')).key
    return d
  }

  /**
   * Pairs with the typed code. `sas` resolves with the six digits the device shows (only after the house proved itself);
   * `done` with the session that concluded the pairing, or the failure.
   */
  async pair(code: string, o: { name?: string; caps?: number } = {}): Promise<{ sas: Promise<string>; done: Promise<DeviceSession | { failed: DevicePairFailure | 'relay-refused' }> }> {
    const access = await accessFromCode(code)
    const leg = this.relay.device()
    await leg.next() // R_HELLO
    leg.send(encodeOuter({ type: 'D_PAIR', rv: access.rv }))
    const ok = await leg.next()
    let showSas!: (s: string) => void
    const sas = new Promise<string>((r) => { showSas = r })
    if (ok.type !== 'R_OK') return { sas, done: Promise.resolve({ failed: 'relay-refused' }) }
    const { pairing, effects } = await DevicePairing.start({ access, kD: this.kD, kA: this.kA, name: o.name ?? 'Telefone de teste', caps: o.caps ?? 0, nowMs: Date.now() })
    const done = (async (): Promise<DeviceSession | { failed: DevicePairFailure | 'relay-refused' }> => {
      let fx = effects
      for (;;) {
        for (const e of fx) {
          if (e.t === 'send') leg.send(encodeOuter({ type: 'DATA', inner: e.frame }))
          else if (e.t === 'show-sas') showSas(e.sas)
          else if (e.t === 'failed') return { failed: e.reason }
        }
        const paired = fx.find((e) => e.t === 'paired')
        if (paired && paired.t === 'paired') { this.result = paired.result; return new DeviceSession(paired.session, leg, undefined) }
        let f
        try { f = await leg.next(60_000) } catch { fx = await pairing.routeClosed(); continue }
        if (f.type !== 'DATA') continue
        fx = await pairing.onFrame(f.inner, Date.now())
      }
    })()
    return { sas, done }
  }

  /** A normal session: admission with the stored ticket, then the session handshake under the pinned pub_H. */
  async connect(): Promise<DeviceSession | { failed: DeviceHsFailure | 'relay-refused' }> {
    const r = this.result
    if (!r) throw new Error('not paired')
    const leg = this.relay.device()
    const hello = await leg.next()
    if (hello.type !== 'R_HELLO') throw new Error('no R_HELLO')
    leg.send(await buildDeviceAdmit({ ticket: r.admitTicket, aud: this.relay.aud, nR: hello.nR, kA: this.kA }))
    const ok = await leg.next(5_000)
    if (ok.type !== 'R_OK') return { failed: 'relay-refused' }
    const { hs, effects } = await DeviceHandshake.start({ pinnedPubH: r.pubH, kD: this.kD, nowMs: Date.now(), pinnedVer: r.pinnedVer })
    let fx = effects
    for (;;) {
      for (const e of fx) {
        if (e.t === 'send') leg.send(encodeOuter({ type: 'DATA', inner: e.frame }))
        else if (e.t === 'failed') { leg.close(); return { failed: e.reason } }
        else return new DeviceSession(e.session, leg, e.info)
      }
      let f
      try { f = await leg.next(15_000) } catch { fx = await hs.routeClosed(); continue }
      if (f.type !== 'DATA') continue
      fx = await hs.onFrame(f.inner, Date.now())
    }
  }

  /** The device keeps its new ticket after admit.renew (and the K_A that goes with it). */
  renewed(ticket: Bytes, kA: RoleKey): void {
    if (!this.result) throw new Error('not paired')
    this.result = { ...this.result, admitTicket: ticket }
    this.kA = kA
  }
}
