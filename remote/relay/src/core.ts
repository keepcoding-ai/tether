// The relay core (fio-spec 5): admission of houses and devices, and the routing of opaque frames between them. Pure:
// no socket, no `ws`, no disk. The shell hands it one `Conn` per WebSocket and forwards what arrives; the core
// answers through the same `Conn`. It never opens an inner frame: it reads the outer frame, checks sizes and routes.
//
// Scale (hundreds of houses, dozens of routes each): every map has a ceiling (sockets, IPs, routes per house, rvs per
// house, the deny list per house), work per frame is O(1), and the timers are shared: one FIFO for the auth deadline,
// one FIFO for the uniform refusal (both delays are constants, so arrival order is deadline order), one idle sweep.
// The only per-object timers are the rare ones: a pair listen and a second-house contest, at most one each per house.
import {
  decodeOuter, DenyList, encodeOuter, equal, NOTICE, PAIR_STATE, R_AUTH_FAIL_CODE, randomBytes, ROUTE_KIND, toHex,
  verifyDeviceAdmit, verifyHouseAuth, WireError,
  type Bytes, type Leg, type OuterFrame, type RelayHouse,
} from '../../../src/remote/index.ts'
import { RELAY_LIMITS, WS_CLOSE, type RelayLimits } from './limits.ts'

type Frame<T extends OuterFrame['type']> = Extract<OuterFrame, { type: T }>

/** One WebSocket, as the core sees it. `close` runs the closing handshake with no reason; `terminate` drops at once. */
export interface Conn {
  send(frame: Uint8Array): void
  /** Bytes accepted by `send` and not yet written to the network. */
  buffered(): number
  close(code: number): void
  terminate(): void
}

export interface Clock {
  /** Monotonic milliseconds, for deadlines and delays. */
  mono(): number
  /** Unix seconds, for certificates and tickets. */
  wallS(): number
}

export interface Timers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

/**
 * Structured log line. The core never passes a ticket, an rv, a proof of possession, a nonce, a houseId or an IP
 * alongside a houseId (5.6, M-10): fields are counters, reasons and sizes.
 */
export type RelayLog = (event: string, fields?: Record<string, string | number>) => void

export interface RelayCoreOptions {
  /** The relay's own identity, as houses and devices sign it: lowercase host, with the port if any (11 Q6). */
  aud: string
  limits?: Partial<RelayLimits>
  clock?: Clock
  timers?: Timers
  log?: RelayLog
}

type PeerState = 'awaiting' | 'verifying' | 'contest' | 'open' | 'closed'

/** One socket. The shell keeps it opaque and gives it back with each message and on close. */
export class Peer {
  readonly leg: Leg
  readonly ip: string
  readonly conn: Conn
  /** R_CHALLENGE `r` on the house leg, R_HELLO `n_R` on the device leg: fresh per socket. */
  readonly nonce: Bytes
  state: PeerState = 'awaiting'
  lastSeen: number
  /** Counted in the pending (not admitted) sockets of its IP. */
  pending = true
  /** House leg: its own entry once open, or the contested entry during a contest. Device leg: the house of its route. */
  house: HouseEntry | undefined
  routeId = 0
  ticketId: Bytes | undefined

  constructor(leg: Leg, ip: string, conn: Conn, nonce: Bytes, now: number) {
    this.leg = leg
    this.ip = ip
    this.conn = conn
    this.nonce = nonce
    this.lastSeen = now
  }
}

interface Listen { rvs: string[]; exp: number; timer: unknown }

interface Contest { challenger: Peer; info: RelayHouse; echo: Bytes; timer: unknown }

interface HouseEntry {
  readonly id: string
  readonly peer: Peer
  readonly info: RelayHouse
  /** routeId → device socket. Per house socket, never global (5.4). */
  readonly routes: Map<number, Peer>
  nextRouteId: number
  /** The route counter went around u32 once: from then on every id counts as one this house had. */
  wrapped: boolean
  readonly deny: DenyList
  discards: number
  listen: Listen | undefined
  /** Monotonic instants of the listens of the last hour (at most `listensPerHour`). */
  listenTimes: number[]
  contest: Contest | undefined
}

interface IpEntry { conns: number; pending: number; missCount: number; missStart: number }

export interface RelayStats {
  peers: number
  houses: number
  routes: number
  listens: number
  ips: number
  queued: number
  /** Highest `buffered()` seen on any socket right before the relay wrote to it. */
  peakBuffered: number
}

const HOUR_MS = 3_600_000
const U32 = 0x1_0000_0000

/** Items ordered by a constant delay: arrival order is deadline order, so one timer for the head serves them all. */
class FifoTimer<T> {
  readonly #clock: Clock
  readonly #timers: Timers
  readonly #fire: (item: T) => void
  #at: number[] = []
  #items: T[] = []
  #head = 0
  #handle: unknown

  constructor(clock: Clock, timers: Timers, fire: (item: T) => void) {
    this.#clock = clock
    this.#timers = timers
    this.#fire = fire
  }

  get length(): number { return this.#items.length - this.#head }

  push(at: number, item: T): void {
    this.#at.push(at)
    this.#items.push(item)
    if (this.length === 1) this.#arm()
  }

  /** Drops items that can no longer fire. The caller bounds the live ones, so this keeps the queue bounded too. */
  compact(live: (item: T) => boolean): void {
    const at: number[] = []
    const items: T[] = []
    for (let i = this.#head; i < this.#items.length; i++) {
      if (live(this.#items[i]!)) { at.push(this.#at[i]!); items.push(this.#items[i]!) }
    }
    this.#at = at
    this.#items = items
    this.#head = 0
    if (this.#handle !== undefined) { this.#timers.clear(this.#handle); this.#handle = undefined }
    if (this.length > 0) this.#arm()
  }

  clear(): void {
    if (this.#handle !== undefined) this.#timers.clear(this.#handle)
    this.#handle = undefined
    this.#at = []
    this.#items = []
    this.#head = 0
  }

  #arm(): void {
    const wait = Math.max(0, this.#at[this.#head]! - this.#clock.mono())
    this.#handle = this.#timers.set(() => this.#run(), wait)
  }

  #run(): void {
    this.#handle = undefined
    const now = this.#clock.mono()
    while (this.#head < this.#items.length && this.#at[this.#head]! <= now) {
      const item = this.#items[this.#head]!
      this.#head++
      this.#fire(item)
    }
    if (this.#head > 1024 && this.#head * 2 > this.#items.length) {
      this.#at = this.#at.slice(this.#head)
      this.#items = this.#items.slice(this.#head)
      this.#head = 0
    }
    if (this.length > 0 && this.#handle === undefined) this.#arm()
  }
}

const systemClock: Clock = { mono: () => performance.now(), wallS: () => Math.floor(Date.now() / 1000) }

const systemTimers: Timers = {
  set: (fn, ms) => {
    const t = setTimeout(fn, ms)
    t.unref()
    return t
  },
  clear: h => clearTimeout(h as ReturnType<typeof setTimeout>),
}

export class RelayCore {
  readonly aud: string
  readonly limits: RelayLimits
  readonly #clock: Clock
  readonly #timers: Timers
  readonly #log: RelayLog
  readonly #peers = new Set<Peer>()
  /** houseId (hex) → the one authenticated socket of that house. */
  readonly #houses = new Map<string, HouseEntry>()
  /** rv (hex) → the house listening on it. At most two rvs per house. */
  readonly #listens = new Map<string, HouseEntry>()
  readonly #ips = new Map<string, IpEntry>()
  readonly #deadlines: FifoTimer<Peer>
  readonly #refusals: FifoTimer<Peer>
  #sweep: unknown
  #stopped = false
  #peakBuffered = 0

  constructor(o: RelayCoreOptions) {
    this.aud = o.aud
    this.limits = { ...RELAY_LIMITS, ...o.limits }
    this.#clock = o.clock ?? systemClock
    this.#timers = o.timers ?? systemTimers
    this.#log = o.log ?? (() => {})
    this.#deadlines = new FifoTimer(this.#clock, this.#timers, p => {
      if (p.state === 'awaiting') { this.#log('auth.deadline', { leg: p.leg }); this.#drop(p, WS_CLOSE.policy) }
    })
    this.#refusals = new FifoTimer(this.#clock, this.#timers, p => this.#refuseNow(p))
    this.#armSweep()
  }

  // -------------------------------------------------------------------------------------------------------------
  // What the shell calls
  // -------------------------------------------------------------------------------------------------------------

  /** Whether one more socket from `ip` fits the limits (5.7). The shell asks before upgrading; `attach` asks again. */
  canAccept(ip: string): boolean {
    if (this.#stopped || this.#peers.size >= this.limits.maxConns) return false
    const e = this.#ips.get(ip)
    if (!e) return this.#ips.size < 2 * this.limits.maxConns
    return e.conns < this.limits.connsPerIp && e.pending < this.limits.pendingPerIp
  }

  /** A WebSocket opened on `leg`. Returns undefined, with the socket already closed, when it does not fit. */
  attach(conn: Conn, leg: Leg, ip: string): Peer | undefined {
    if (!this.canAccept(ip)) { conn.close(WS_CLOSE.policy); this.#log('limit.conns', { leg }); return undefined }
    const now = this.#clock.mono()
    const peer = new Peer(leg, ip, conn, randomBytes(32), now)
    this.#peers.add(peer)
    const e = this.#ips.get(ip) ?? { conns: 0, pending: 0, missCount: 0, missStart: 0 }
    e.conns++
    e.pending++
    this.#ips.set(ip, e)
    this.#deadlines.push(now + this.limits.authDeadlineMs, peer)
    if (this.#deadlines.length > 2 * this.#peers.size + 1024) this.#deadlines.compact(p => p.state === 'awaiting')
    conn.send(encodeOuter(leg === 'house' ? { type: 'R_CHALLENGE', r: peer.nonce } : { type: 'R_HELLO', nR: peer.nonce }))
    return peer
  }

  /** One WebSocket message. `binary` false is a text frame, which closes (2.1 rule 4). */
  message(peer: Peer, data: Uint8Array, binary: boolean): void {
    if (peer.state === 'closed') return
    const arrival = this.#clock.mono()
    peer.lastSeen = arrival
    if (!binary) { this.#log('frame.text', { leg: peer.leg }); return this.#drop(peer, WS_CLOSE.unsupported) }
    if (peer.state !== 'open') return this.#preAuth(peer, data, arrival)
    let f: OuterFrame
    try { f = decodeOuter(peer.leg, 'end', data) }
    catch (e) { return this.#malformed(peer, e) }
    if (peer.leg === 'device') return this.#fromDevice(peer, f)
    return this.#fromHouse(peer, f)
  }

  /** The WebSocket closed, from either side. Idempotent. */
  closed(peer: Peer): void { this.#detach(peer) }

  /** Closes every socket and empties every map. The core refuses new sockets afterwards. */
  shutdown(): void {
    this.#stopped = true
    for (const p of [...this.#peers]) this.#drop(p, WS_CLOSE.goingAway)
    this.#deadlines.clear()
    this.#refusals.clear()
    if (this.#sweep !== undefined) this.#timers.clear(this.#sweep)
    this.#sweep = undefined
    this.#houses.clear()
    this.#listens.clear()
    this.#ips.clear()
  }

  stats(): RelayStats {
    let routes = 0
    for (const h of this.#houses.values()) routes += h.routes.size
    return {
      peers: this.#peers.size, houses: this.#houses.size, routes, listens: this.#listens.size, ips: this.#ips.size,
      queued: this.#deadlines.length + this.#refusals.length, peakBuffered: this.#peakBuffered,
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Before admission: one D_ADMIT, D_PAIR or H_AUTH, nothing else (5.7)
  // -------------------------------------------------------------------------------------------------------------

  #preAuth(peer: Peer, data: Uint8Array, arrival: number): void {
    if (peer.state !== 'awaiting') { this.#log('frame.unexpected', { leg: peer.leg }); return this.#drop(peer, WS_CLOSE.policy) }
    if (data.length > this.limits.maxPreAuth) { this.#log('frame.too-big', { leg: peer.leg }); return this.#drop(peer, WS_CLOSE.tooBig) }
    let f: OuterFrame
    try { f = decodeOuter(peer.leg, 'end', data, { preAuth: true }) }
    catch (e) { return this.#malformed(peer, e) }
    if (peer.leg === 'house' && f.type === 'H_AUTH') return this.#houseAuth(peer, f)
    if (peer.leg === 'device' && f.type === 'D_ADMIT') return this.#deviceAdmit(peer, f, arrival)
    if (peer.leg === 'device' && f.type === 'D_PAIR') return this.#devicePair(peer, f, arrival)
    this.#log('frame.unexpected', { leg: peer.leg })
    this.#drop(peer, WS_CLOSE.policy)
  }

  /**
   * The uniform refusal (5.3): R_FAIL with no body at arrival + FAIL_DELAY, then close 1000 with no reason. The
   * instant comes from the arrival, not from the verification: a verdict that is not ready by then is a refusal too.
   */
  #refuseLater(peer: Peer, arrival: number): void {
    peer.state = 'verifying'
    this.#refusals.push(arrival + this.limits.failDelayMs, peer)
    if (this.#refusals.length > 2 * this.#peers.size + 1024) this.#refusals.compact(p => p.state === 'verifying')
  }

  #refuseNow(peer: Peer): void {
    if (peer.state !== 'verifying') return
    peer.conn.send(encodeOuter({ type: 'R_FAIL' }))
    this.#drop(peer, WS_CLOSE.normal)
  }

  #deviceAdmit(peer: Peer, f: Frame<'D_ADMIT'>, arrival: number): void {
    this.#refuseLater(peer, arrival)
    const entry = this.#houses.get(toHex(f.houseId))
    const house = entry && entry.peer.state === 'open' ? entry : undefined
    verifyDeviceAdmit({ admit: f, nR: peer.nonce, aud: this.aud, nowS: this.#clock.wallS(), house: house?.info, deny: house?.deny })
      .then(v => {
        if (peer.state !== 'verifying') return
        if (!v.ok) { this.#log('device.refused', { reasons: v.failed.join(',') }); return }
        // The house may have gone, or been replaced, while the signatures were checked.
        if (!house || this.#houses.get(house.id) !== house || house.peer.state !== 'open') {
          this.#log('device.refused', { reasons: 'house-online' })
          return
        }
        if (house.deny.has(v.ticketId)) { this.#log('device.refused', { reasons: 'not-denied' }); return }
        peer.ticketId = v.ticketId
        if (!this.#openRoute(peer, house, ROUTE_KIND.admit, v.ticketId)) this.#log('limit.routes', {})
      })
      .catch(e => { this.#log('device.error', { error: errorName(e) }) })
  }

  #devicePair(peer: Peer, f: Frame<'D_PAIR'>, arrival: number): void {
    const now = this.#clock.mono()
    const ip = this.#ips.get(peer.ip)
    if (ip && now - ip.missStart >= this.limits.pairMissWindowMs) { ip.missCount = 0; ip.missStart = now }
    const blocked = ip !== undefined && ip.missCount >= this.limits.pairMissPerIp
    const entry = this.#listens.get(toHex(f.rv))
    const live = entry !== undefined && entry.listen !== undefined && entry.listen.exp > now && entry.peer.state === 'open'
    if (!live && ip) {
      if (ip.missCount === 0) ip.missStart = now
      ip.missCount++
    }
    if (blocked) this.#log('limit.pair-miss', {})
    this.#refuseLater(peer, arrival)
    if (!blocked && live && !this.#openRoute(peer, entry, ROUTE_KIND.pair, f.rv)) this.#log('limit.routes', {})
    if (!live) this.#log('device.refused', { reasons: 'no-listen' })
  }

  /** Admits a device into a route of `house`, or leaves it to the uniform refusal when the house is full. */
  #openRoute(peer: Peer, house: HouseEntry, kind: number, hint: Bytes): boolean {
    if (house.routes.size >= this.limits.routesPerHouse) return false
    let id = house.nextRouteId
    while (house.routes.has(id) || id === 0) id = (id + 1) % U32
    house.nextRouteId = (id + 1) % U32
    if (house.nextRouteId === 0) house.wrapped = true
    house.routes.set(id, peer)
    peer.house = house
    peer.routeId = id
    this.#settle(peer)
    this.#send(house.peer, encodeOuter({ type: 'ROUTE_OPEN', routeId: id, kind, hint }))
    this.#send(peer, encodeOuter({ type: 'R_OK' }))
    return true
  }

  #houseAuth(peer: Peer, f: Frame<'H_AUTH'>): void {
    peer.state = 'verifying'
    verifyHouseAuth({ auth: f, r: peer.nonce, aud: this.aud, nowS: this.#clock.wallS() })
      .then(v => {
        if (peer.state !== 'verifying') return
        if (!v.ok) { this.#log('house.refused', { reason: v.reason }); return this.#refuseHouse(peer) }
        const id = toHex(v.house.houseId)
        const current = this.#houses.get(id)
        if (!current) return this.#acceptHouse(peer, id, v.house)
        if (current.contest) { this.#log('house.refused', { reason: 'contest-pending' }); return this.#refuseHouse(peer) }
        // A second socket proves the same key (5.1, M-2): the live one is asked first, never dropped in silence.
        peer.state = 'contest'
        peer.house = current
        const echo = randomBytes(8)
        current.contest = {
          challenger: peer, info: v.house, echo,
          timer: this.#timers.set(() => this.#contestTimeout(current), this.limits.secondHousePingMs),
        }
        this.#send(current.peer, encodeOuter({ type: 'LINK_PING', echo }))
      })
      .catch(e => { this.#log('house.error', { error: errorName(e) }); this.#drop(peer, WS_CLOSE.policy) })
  }

  #refuseHouse(peer: Peer): void {
    peer.conn.send(encodeOuter({ type: 'R_AUTH_FAIL', code: R_AUTH_FAIL_CODE }))
    this.#drop(peer, WS_CLOSE.normal)
  }

  #acceptHouse(peer: Peer, id: string, info: RelayHouse): void {
    const entry: HouseEntry = {
      id, peer, info, routes: new Map(), nextRouteId: 1, wrapped: false, deny: new DenyList(), discards: 0, listen: undefined,
      listenTimes: [], contest: undefined,
    }
    this.#houses.set(id, entry)
    peer.house = entry
    this.#settle(peer)
    this.#send(peer, encodeOuter({ type: 'R_AUTH_OK' }))
    this.#log('house.up', { houses: this.#houses.size })
  }

  /** The first house answered LINK_PING: it is alive, so the second is refused and the first is told. */
  #contestAnswered(entry: HouseEntry): void {
    const c = entry.contest
    if (!c) return
    entry.contest = undefined
    this.#timers.clear(c.timer)
    this.#log('house.second-refused', {})
    if (c.challenger.state === 'contest') this.#refuseHouse(c.challenger)
    this.#send(entry.peer, encodeOuter({ type: 'R_NOTICE', code: NOTICE.secondHouse }))
  }

  /** The first house did not answer in time, or closed: it goes, and the second takes its place. */
  #contestTimeout(entry: HouseEntry): void {
    const c = entry.contest
    if (!c) return
    entry.contest = undefined
    this.#timers.clear(c.timer)
    this.#log('house.replaced', {})
    if (entry.peer.state !== 'closed') this.#drop(entry.peer, WS_CLOSE.goingAway)
    if (c.challenger.state === 'contest') this.#acceptHouse(c.challenger, entry.id, c.info)
  }

  // -------------------------------------------------------------------------------------------------------------
  // After admission: routing (5.4) and the house's own frames
  // -------------------------------------------------------------------------------------------------------------

  #fromDevice(peer: Peer, f: OuterFrame): void {
    const house = peer.house
    if (f.type !== 'DATA' || !house) { this.#log('frame.unexpected', { leg: 'device' }); return this.#drop(peer, WS_CLOSE.policy) }
    const frame = encodeOuter({ type: 'ROUTE_DATA', routeId: peer.routeId, inner: f.inner })
    // The house queue is full: the route writing into it goes, the relay does not hold its bytes (5.7).
    if (this.#over(house.peer, frame, this.limits.houseQueueBytes)) return this.#slow(peer)
    house.peer.conn.send(frame)
  }

  #fromHouse(peer: Peer, f: OuterFrame): void {
    const house = peer.house
    if (!house) return this.#drop(peer, WS_CLOSE.policy)
    switch (f.type) {
      case 'ROUTE_DATA': {
        const device = house.routes.get(f.routeId)
        if (!device) return this.#discard(house, f.routeId)
        const frame = encodeOuter({ type: 'DATA', inner: f.inner })
        if (this.#over(device, frame, this.limits.routeQueueBytes)) return this.#slow(device)
        device.conn.send(frame)
        return
      }
      case 'ROUTE_CLOSE': {
        const device = house.routes.get(f.routeId)
        if (!device) return this.#discard(house, f.routeId)
        house.routes.delete(f.routeId)
        device.house = undefined
        return this.#drop(device, WS_CLOSE.normal)
      }
      case 'H_DENY': return this.#deny(house, f)
      case 'H_PAIR_LISTEN': return this.#listen(house, f)
      case 'H_PAIR_CANCEL': return this.#clearListen(house)
      case 'LINK_PING': return this.#send(peer, encodeOuter({ type: 'LINK_PONG', echo: f.echo }))
      case 'LINK_PONG':
        if (house.contest && equal(house.contest.echo, f.echo)) this.#contestAnswered(house)
        return
      default:
        this.#log('frame.unexpected', { leg: 'house' })
        return this.#drop(peer, WS_CLOSE.policy)
    }
  }

  /**
   * A routeId with no live route of this house is dropped (5.4). It is counted, and three close the house, only when
   * this house never had it: a frame still in flight to a route of its own that just closed (the device left, or the
   * relay dropped it as slow) is the normal race of a closing route, not a probe of another house's routes. Route ids
   * of a house are handed out in sequence from 1, so "had it" is `id < nextRouteId` until the counter wraps.
   */
  #discard(house: HouseEntry, routeId: number): void {
    if (routeId >= 1 && (routeId < house.nextRouteId || house.wrapped)) return
    house.discards++
    this.#log('route.discard', { count: house.discards })
    if (house.discards >= this.limits.houseDiscards) this.#drop(house.peer, WS_CLOSE.policy)
  }

  #deny(house: HouseEntry, f: Frame<'H_DENY'>): void {
    const r = house.deny.apply(f, this.#clock.wallS())
    if (!r.ok) {
      this.#log('limit.deny', { size: house.deny.size })
      return this.#send(house.peer, encodeOuter({ type: 'R_NOTICE', code: r.notice }))
    }
    // A denied ticket with a live route loses it now: the revoked device does not keep the relay (6.1).
    for (const device of [...house.routes.values()]) {
      if (device.ticketId && house.deny.has(device.ticketId)) this.#drop(device, WS_CLOSE.normal)
    }
  }

  #listen(house: HouseEntry, f: Frame<'H_PAIR_LISTEN'>): void {
    const now = this.#clock.mono()
    house.listenTimes = house.listenTimes.filter(t => now - t < HOUR_MS)
    if (house.listenTimes.length >= this.limits.listensPerHour) {
      this.#log('limit.listen', {})
      return this.#send(house.peer, encodeOuter({ type: 'R_NOTICE', code: NOTICE.limit }))
    }
    const rvs = f.rvs.map(toHex)
    for (const rv of rvs) {
      const holder = this.#listens.get(rv)
      if (holder && holder !== house) return this.#send(house.peer, encodeOuter({ type: 'R_PAIR_STATE', code: PAIR_STATE.rvInUse }))
    }
    house.listenTimes.push(now)
    // One active listen per house: a new one replaces the previous.
    this.#clearListen(house)
    if (f.ttl === 0) return this.#send(house.peer, encodeOuter({ type: 'R_PAIR_STATE', code: PAIR_STATE.expired }))
    const listen: Listen = {
      rvs, exp: now + f.ttl * 1000,
      timer: this.#timers.set(() => {
        if (house.listen !== listen) return
        this.#clearListen(house)
        this.#send(house.peer, encodeOuter({ type: 'R_PAIR_STATE', code: PAIR_STATE.expired }))
      }, f.ttl * 1000),
    }
    house.listen = listen
    for (const rv of rvs) this.#listens.set(rv, house)
    this.#send(house.peer, encodeOuter({ type: 'R_PAIR_STATE', code: PAIR_STATE.listening }))
  }

  #clearListen(house: HouseEntry): void {
    const l = house.listen
    if (!l) return
    house.listen = undefined
    this.#timers.clear(l.timer)
    for (const rv of l.rvs) if (this.#listens.get(rv) === house) this.#listens.delete(rv)
  }

  // -------------------------------------------------------------------------------------------------------------
  // Queues, closing and housekeeping
  // -------------------------------------------------------------------------------------------------------------

  #over(target: Peer, frame: Uint8Array, cap: number): boolean {
    const buffered = target.conn.buffered()
    if (buffered > this.#peakBuffered) this.#peakBuffered = buffered
    return buffered + frame.length > cap
  }

  /** The slow route is dropped at once: its socket is terminated and its bytes are not kept (5.7). */
  #slow(device: Peer): void {
    this.#log('route.slow', {})
    this.#drop(device, 'terminate')
  }

  #send(peer: Peer, frame: Uint8Array): void {
    if (peer.state !== 'closed') peer.conn.send(frame)
  }

  #malformed(peer: Peer, e: unknown): void {
    if (!(e instanceof WireError)) throw e
    this.#log('frame.malformed', { leg: peer.leg, code: e.code })
    this.#drop(peer, e.code === 'too-large' ? WS_CLOSE.tooBig : WS_CLOSE.policy)
  }

  /** The socket leaves the pending count of its IP: it is admitted or authenticated. */
  #settle(peer: Peer): void {
    peer.state = 'open'
    if (!peer.pending) return
    peer.pending = false
    const e = this.#ips.get(peer.ip)
    if (e) e.pending--
  }

  #drop(peer: Peer, how: number | 'terminate'): void {
    if (peer.state === 'closed') return
    this.#detach(peer)
    if (how === 'terminate') peer.conn.terminate()
    else peer.conn.close(how)
  }

  #detach(peer: Peer): void {
    if (peer.state === 'closed') return
    const was = peer.state
    peer.state = 'closed'
    this.#peers.delete(peer)
    const e = this.#ips.get(peer.ip)
    if (e) {
      e.conns--
      if (peer.pending) e.pending--
      if (e.conns <= 0 && e.missCount === 0) this.#ips.delete(peer.ip)
    }
    peer.pending = false
    const house = peer.house
    peer.house = undefined
    if (!house) return
    if (peer.leg === 'device') {
      if (house.routes.get(peer.routeId) === peer) {
        house.routes.delete(peer.routeId)
        this.#send(house.peer, encodeOuter({ type: 'ROUTE_CLOSE', routeId: peer.routeId }))
      }
      return
    }
    if (was === 'contest') {
      // The challenger went away while the live house was being asked.
      if (house.contest?.challenger === peer) { this.#timers.clear(house.contest.timer); house.contest = undefined }
      return
    }
    // The house socket closed: its routes, its listen and its deny list go with it (5.6: memory only).
    if (this.#houses.get(house.id) === house) this.#houses.delete(house.id)
    this.#clearListen(house)
    for (const device of house.routes.values()) {
      device.house = undefined
      this.#drop(device, WS_CLOSE.goingAway)
    }
    house.routes.clear()
    this.#log('house.down', { houses: this.#houses.size })
    if (house.contest) this.#contestTimeout(house)
  }

  #armSweep(): void {
    const every = Math.max(10, Math.min(10_000, Math.floor(this.limits.idleMs / 3)))
    this.#sweep = this.#timers.set(() => { this.#runSweep(); if (!this.#stopped) this.#armSweep() }, every)
  }

  /** Idle sockets close (5.7), and IP entries kept only for the D_PAIR window are forgotten once it passes. */
  #runSweep(): void {
    const now = this.#clock.mono()
    for (const p of [...this.#peers]) {
      if (now - p.lastSeen > this.limits.idleMs) { this.#log('idle', { leg: p.leg }); this.#drop(p, WS_CLOSE.goingAway) }
    }
    for (const [ip, e] of this.#ips) {
      if (e.conns <= 0 && now - e.missStart >= this.limits.pairMissWindowMs) this.#ips.delete(ip)
    }
  }
}

function errorName(e: unknown): string {
  return e instanceof Error ? e.name : 'unknown'
}
