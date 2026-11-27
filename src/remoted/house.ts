// The house side of the remote wire inside the portal (fio-spec 3, 4, 5, 7): the routes the relay opens on the house's
// socket, the session handshakes of paired devices (HouseHandshake), the one pairing ticket (HousePairing), the sessions
// per device, and the gate of each request by the operations table. Transport-agnostic: frames in (`onFrame`), frames out
// (`deps.send`), time by `tick(nowMs)`; the relay socket, the pipe and the registry's writer are the caller's.
//
// What a device can get in this milestone: the session family (session.info, admit.renew, device.revoke-self) and
// attention.list / attention.watch. Every other line of the table answers `failed` with `not-implemented`, after the
// gate: nothing is ever forwarded to the pipe, and no pipe object leaves whole (attention.ts is the projection).
import {
  ActCache, ADMIT_TTL_S, CLOSE, decodeOuter, decodeReq, encodeEvt, encodeOuter, encodeRes, fromB64url, fromHex,
  HousePairing, HouseHandshake, houseFingerprint, houseIdOf, issueAdmitTicket, keyIdOf, PairLockout, parseAdmitTicket,
  parseJsonObject, parseKeyCert, PRESENCE, qrFragment, RES_STATUS, ROUTE_KIND, ROUTES_PER_HOUSE, SESSIONS_PER_DEVICE,
  admitRenewKeyAllowed, b64url, sanitizeDeclaredName, toHex, WireError, PAIR_STATE, IDLE_LOCK_MS, EVT,
  type Bytes, type CloseCode, type DeviceRecord, type HouseHsEffect, type HousePairEffect, type OuterFrame, type Req, type ResStatus,
  type RoleKey, type Session, type SessionEffect,
} from '../remote/index.ts'
import type { AttentionView } from './attention.ts'
import { gate } from './gate.ts'
import type { DenyRow, PairBegun, PairView, PortalAsk, PortalDevice, PortalNote, PortalStatus } from './ipc.ts'

/** Spec 5.8: at most this many handshakes per minute per ticketId hint, and pending in total. */
const HS_PER_TICKET_PER_MIN = 6
const HS_PENDING_MAX = 32
const HS_RATE_DENY_S = 600
/** Old ticket denied this long after a renewal (spec 5.5). */
export const RENEW_DENY_AFTER_MS = 60_000
/** Requests in flight per session; above it the request is answered `limit`. */
const INFLIGHT_MAX = 16
/** Every session of the portal, all devices together. */
const SESSIONS_MAX = 32
/**
 * Frames waiting on one route. A device keeps at most INFLIGHT_MAX requests open, plus a handshake frame or a CLOSE:
 * twice that leaves room for an honest burst; more is a relay or device flooding the house's memory, and the route goes.
 */
const ROUTE_QUEUE_MAX = 2 * INFLIGHT_MAX
const PAIR_STATE_WAIT_MS = 5_000
const PAIR_REDRAWS = 3

export interface HouseKeys {
  kH: RoleKey
  kT: RoleKey
  /** The certificate of kT (the newest ticket key): every ticket this portal issues is signed with it. */
  certT: Bytes
}

export interface HouseDeps {
  keys: HouseKeys
  /** The relay's identity as this house configured it (host[:port], lowercase). */
  aud: string
  houseName: string
  attention: AttentionView
  /** One outer frame to the relay. A no-op while the link is down. */
  send(frame: Bytes): void
  /** Asks the registry's writer (the extension); resolves when it wrote, rejects when it refused. */
  ask(a: PortalAsk): Promise<void>
  note(n: PortalNote): void
  /** A native notice on the machine (spec 3.2 (d), 3.4): independent of the app's screen. */
  notice(text: string): void
  log(msg: string): void
  now(): number
  /** Bench knobs (only set under TETHER_TEST_REMOTE=1 by main.ts). */
  idleMs?: number
  renewDenyAfterMs?: number
}

interface DeviceMem {
  acts: ActCache<{ status: ResStatus; body: Bytes }>
  sessions: Set<SessionRoute>
  /** A revocation started: nothing more is issued to this device. */
  revoking: boolean
}

interface SessionRoute {
  kind: 'session'
  route: number
  session: Session
  deviceId: string
  freshPair: boolean
  openedMs: number
  lastReqMs: number
  inflight: number
  watching: boolean
}
interface PairingEntry { p: HousePairing; view: PairView; waitState?: (code: number) => void }

type Route =
  | { kind: 'admit'; route: number; hs: HouseHandshake; hint: string }
  | { kind: 'pair'; route: number }
  | SessionRoute

const json = (v: unknown): Bytes => new TextEncoder().encode(JSON.stringify(v))
const STRICT_KEYS: Record<string, readonly string[]> = {
  'session.info': [], 'admit.renew': ['pubA'], 'device.revoke-self': [], 'attention.list': [], 'attention.watch': [],
}

export class House {
  readonly #d: HouseDeps
  readonly #routes = new Map<number, Route>()
  /** The frames of each route waiting their turn (see #routeData); gone when the route goes. */
  readonly #queues = new Map<number, { tail: Promise<void>; pending: number }>()
  readonly #devices = new Map<string, PortalDevice>()
  readonly #mem = new Map<string, DeviceMem>()
  /** ticketId → exp (Unix s): what the relay must refuse; resent whole at each link up (spec 6.1). */
  readonly #deny = new Map<string, number>()
  /** ticketId hint → arrival instants within the last minute (spec 5.8). */
  readonly #hsRate = new Map<string, number[]>()
  readonly #lockout = new PairLockout()
  #pairing: PairingEntry | undefined
  #linkUp = false
  #fingerprint = ''

  constructor(deps: HouseDeps) { this.#d = deps }

  async init(devices: readonly PortalDevice[], deny: readonly DenyRow[]): Promise<void> {
    this.#fingerprint = houseFingerprint(await houseIdOf(this.#d.keys.kH.pub))
    for (const dv of devices) this.#devices.set(dv.deviceId, dv)
    for (const r of deny) this.#addDeny(r.ticketId, r.exp)
  }

  get fingerprint(): string { return this.#fingerprint }

  status(): PortalStatus {
    return { link: this.#linkUp ? 'up' : 'down', sessions: this.#sessionCount(), houseFingerprint: this.#fingerprint }
  }

  // ---- registry (from the extension) -------------------------------------------------------------------------

  upsertDevice(dv: PortalDevice): void { this.#devices.set(dv.deviceId, dv) }

  forgetDevice(deviceId: string): void {
    this.#devices.delete(deviceId)
    this.#closeDevice(deviceId, CLOSE.revoked)
    this.#mem.delete(deviceId)
  }

  /** Spec 6.1, after the registry was written: close the live sessions with CLOSE(0x04), deny every live ticket. */
  async revoke(deviceId: string, deny: readonly DenyRow[]): Promise<void> {
    const dv = this.#devices.get(deviceId)
    if (dv) dv.state = 'revoked'
    const mem = this.#mem.get(deviceId)
    if (mem) mem.revoking = true
    await this.#closeDevice(deviceId, CLOSE.revoked)
    const added: DenyRow[] = []
    for (const r of deny) if (this.#addDeny(r.ticketId, r.exp)) added.push(r)
    if (added.length) this.#sendDeny(added)
    this.#mem.delete(deviceId)
    this.#d.note({ note: 'audit', act: 'device.revoke', deviceId, result: 'ok' })
  }

  /** The remote goes off: every session gets CLOSE(0x06), the pairing in course is cancelled. */
  async shutdown(): Promise<void> {
    for (const deviceId of [...this.#mem.keys()]) await this.#closeDevice(deviceId, CLOSE.remoteOff)
    if (this.#pairing && !this.#isOver(this.#pairing.view.state)) this.#pairEffects(await this.#pairing.p.cancel(this.#d.now()))
  }

  // ---- the relay link ----------------------------------------------------------------------------------------

  linkUp(): void {
    this.#linkUp = true
    this.#pruneDeny()
    const all = [...this.#deny].map(([ticketId, exp]) => ({ ticketId, exp }))
    if (all.length) this.#sendDeny(all)
    this.#d.note({ note: 'link', state: 'up' })
  }

  linkDown(): void {
    if (!this.#linkUp && this.#routes.size === 0) return
    this.#linkUp = false
    for (const r of this.#routes.values()) {
      if (r.kind === 'session') this.#endSession(r, 'link down')
      else if (r.kind === 'admit') void r.hs.routeClosed()
    }
    this.#routes.clear()
    this.#queues.clear()
    if (this.#pairing && !this.#isOver(this.#pairing.view.state)) void this.#pairing.p.cancel(this.#d.now()).then((fx) => this.#pairEffects(fx))
    this.#d.note({ note: 'link', state: 'down' })
    this.#d.note({ note: 'sessions', count: 0 })
  }

  /** One frame of the house leg written by the relay (after R_AUTH_OK). */
  onFrame(bytes: Uint8Array): void {
    let f: OuterFrame
    try { f = decodeOuter('house', 'relay', bytes) } catch (e) {
      if (e instanceof WireError) { this.#d.log(`relay frame refused: ${e.code}`); return }
      throw e
    }
    switch (f.type) {
      case 'ROUTE_OPEN': return this.#routeOpen(f.routeId, f.kind, f.hint)
      case 'ROUTE_DATA': return this.#routeData(f.routeId, f.inner)
      case 'ROUTE_CLOSE': return this.#routeClosed(f.routeId)
      case 'R_PAIR_STATE': this.#pairing?.waitState?.(f.code); return
      case 'R_NOTICE': this.#d.log(`relay notice ${f.code}`); return
      default: return
    }
  }

  #routeOpen(route: number, kind: number, hint: Bytes): void {
    if (this.#routes.has(route)) return this.#close(route)
    if (this.#routes.size >= ROUTES_PER_HOUSE) return this.#close(route)
    if (kind === ROUTE_KIND.pair) {
      if (!this.#pairing || this.#isOver(this.#pairing.view.state)) return this.#close(route)
      this.#routes.set(route, { kind: 'pair', route })
      return
    }
    if (kind !== ROUTE_KIND.admit) return this.#close(route)
    // Admission: the hint (ticketId) is unauthenticated and used only for the limits of spec 5.8.
    const hintHex = toHex(hint)
    const nowMs = this.#d.now()
    const pending = [...this.#routes.values()].filter((r) => r.kind === 'admit').length
    const recent = (this.#hsRate.get(hintHex) ?? []).filter((t) => nowMs - t < 60_000)
    recent.push(nowMs)
    this.#hsRate.set(hintHex, recent)
    if (this.#hsRate.size > 1024) this.#hsRate.delete(this.#hsRate.keys().next().value!)
    if (recent.length > HS_PER_TICKET_PER_MIN) {
      if (hint.length === 16 && this.#addDeny(hintHex, Math.floor(nowMs / 1000) + HS_RATE_DENY_S)) {
        this.#sendDeny([{ ticketId: hintHex, exp: Math.floor(nowMs / 1000) + HS_RATE_DENY_S }])
      }
      return this.#close(route)
    }
    if (pending >= HS_PENDING_MAX) return this.#close(route)
    const hs = new HouseHandshake({ kH: this.#d.keys.kH, nowMs, lookup: (id) => this.#lookup(toHex(id)) })
    this.#routes.set(route, { kind: 'admit', route, hs, hint: hintHex })
  }

  #lookup(deviceId: string): DeviceRecord | undefined {
    const dv = this.#devices.get(deviceId)
    if (!dv || dv.state !== 'active') return undefined
    const mem = this.#mem.get(deviceId)
    return {
      pubD: fromHex(dv.pubD), revoked: mem?.revoking === true, expired: false, maxVerUsed: dv.maxVerUsed,
      liveSessions: mem?.sessions.size ?? 0,
      // RR1 has no presence credential yet (WebAuthn is step 2.4): the class comes from the registry, never from `caps`.
      presence: PRESENCE.noCredential, elevUntil: 0,
    }
  }

  /**
   * Frames of one route are handled one after the other: frame N+1 is dispatched only after frame N was handled and
   * its effects applied (a pairing that becomes a session, the AES-GCM counter per direction). The kind of the route is
   * read at dispatch, never at arrival.
   */
  #routeData(route: number, inner: Bytes): void {
    if (!this.#routes.has(route)) return
    let q =this.#queues.get(route)
    if (!q) { q = { tail: Promise.resolve(), pending: 0 }; this.#queues.set(route, q) }
    if (q.pending >= ROUTE_QUEUE_MAX) {
      this.#d.log(`route ${route}: more than ${ROUTE_QUEUE_MAX} frames waiting; closed`)
      this.#routeClosed(route)
      this.#d.send(encodeOuter({ type: 'ROUTE_CLOSE', routeId: route }))
      return
    }
    const queue = q
    queue.pending++
    queue.tail = queue.tail.then(async () => {
      try {
        if (this.#queues.get(route) === queue) await this.#dispatch(route, inner)
      } catch (e) {
        this.#d.log(`route ${route}: frame failed (${(e as Error).message})`)
      } finally {
        queue.pending--
      }
    })
  }

  async #dispatch(route: number, inner: Bytes): Promise<void> {
    const r = this.#routes.get(route)
    if (!r) return
    const nowMs = this.#d.now()
    if (r.kind === 'admit') this.#hsEffects(r, await r.hs.onFrame(inner, nowMs))
    else if (r.kind === 'pair') {
      const pr = this.#pairing
      if (!pr) return this.#close(route)
      this.#pairEffects(await pr.p.onFrame(route, inner, nowMs))
    } else this.#sessionEffects(r, await r.session.receive(inner, nowMs))
  }

  #routeClosed(route: number): void {
    const r = this.#routes.get(route)
    if (!r) return
    this.#routes.delete(route)
    this.#queues.delete(route)
    if (r.kind === 'admit') void r.hs.routeClosed()
    else if (r.kind === 'pair') void this.#pairing?.p.routeClosed(route, this.#d.now()).then((fx) => this.#pairEffects(fx))
    else this.#endSession(r, 'route closed by the relay')
  }

  #close(route: number): void {
    this.#routes.delete(route)
    this.#queues.delete(route)
    this.#d.send(encodeOuter({ type: 'ROUTE_CLOSE', routeId: route }))
  }

  #data(route: number, inner: Bytes): void {
    if (!this.#routes.has(route)) return
    this.#d.send(encodeOuter({ type: 'ROUTE_DATA', routeId: route, inner }))
  }

  /** At `notBeforeMs`, when given (the uniform failure of spec 4.2 rule 7). */
  #later(notBeforeMs: number | undefined, fn: () => void): void {
    const wait = notBeforeMs === undefined ? 0 : notBeforeMs - this.#d.now()
    if (wait <= 0) fn()
    else setTimeout(fn, wait)
  }

  #hsEffects(r: Extract<Route, { kind: 'admit' }>, fx: HouseHsEffect[]): void {
    for (const e of fx) {
      if (e.t === 'send') this.#later(e.notBeforeMs, () => this.#data(r.route, e.frame))
      else if (e.t === 'close') this.#later(e.notBeforeMs, () => { if (this.#routes.get(r.route) === r) this.#close(r.route) })
      else {
        const deviceId = toHex(e.device.deviceId)
        if (this.#routes.get(r.route) !== r || this.#sessionCount() >= SESSIONS_MAX) {
          void e.session.close(CLOSE.limit, this.#d.now()).then((x) => this.#flush(r.route, x))
          continue
        }
        this.#adopt(r.route, e.session, deviceId, false)
        const dv = this.#devices.get(deviceId)
        if (dv && e.device.ver > dv.maxVerUsed) dv.maxVerUsed = e.device.ver
        this.#d.note({ note: 'seen', deviceId, ver: e.device.ver })
        this.#d.note({ note: 'audit', act: 'session.open', deviceId, result: 'ok' })
      }
    }
  }

  #adopt(route: number, session: Session, deviceId: string, freshPair: boolean): void {
    const nowMs = this.#d.now()
    const s: SessionRoute = { kind: 'session', route, session, deviceId, freshPair, openedMs: nowMs, lastReqMs: nowMs, inflight: 0, watching: false }
    this.#routes.set(route, s)
    this.#memOf(deviceId).sessions.add(s)
    this.#d.note({ note: 'sessions', count: this.#sessionCount() })
  }

  #memOf(deviceId: string): DeviceMem {
    let m = this.#mem.get(deviceId)
    if (!m) { m = { acts: new ActCache(), sessions: new Set(), revoking: false }; this.#mem.set(deviceId, m) }
    return m
  }

  #sessionCount(): number {
    let n = 0
    for (const r of this.#routes.values()) if (r.kind === 'session') n++
    return n
  }

  #flush(route: number, fx: SessionEffect[]): void {
    for (const e of fx) {
      if (e.t === 'send') this.#data(route, e.frame)
      else if (e.t === 'closed' && this.#routes.has(route)) this.#close(route)
    }
  }

  #sessionEffects(s: SessionRoute, fx: SessionEffect[]): void {
    for (const e of fx) {
      if (e.t === 'send') this.#data(s.route, e.frame)
      else if (e.t === 'closed') {
        this.#endSession(s, e.reason)
        if (this.#routes.has(s.route)) this.#close(s.route)
      } else if (e.ctype === 'REQ') void this.#request(s, e.content)
      else {
        // A device writes only REQ and BIN; BIN needs a stream opened by a REQ, and this milestone opens none.
        void s.session.close(CLOSE.protocol, this.#d.now()).then((x) => this.#sessionEffects(s, x))
      }
    }
  }

  #endSession(s: SessionRoute, _reason: string): void {
    if (this.#routes.get(s.route) === s) { this.#routes.delete(s.route); this.#queues.delete(s.route) }
    this.#mem.get(s.deviceId)?.sessions.delete(s)
    s.session.drop('ended')
    this.#d.note({ note: 'sessions', count: this.#sessionCount() })
  }

  async #closeDevice(deviceId: string, code: CloseCode): Promise<void> {
    const mem = this.#mem.get(deviceId)
    if (!mem) return
    await Promise.all([...mem.sessions].map(async (s) => {
      const fx = await s.session.close(code, this.#d.now())
      this.#flush(s.route, fx)
      this.#endSession(s, 'closed by the house')
    }))
  }

  // ---- requests ----------------------------------------------------------------------------------------------

  async #request(s: SessionRoute, content: Bytes): Promise<void> {
    let req: Req
    try { req = decodeReq(content) } catch {
      const fx = await s.session.close(CLOSE.protocol, this.#d.now())
      return this.#sessionEffects(s, fx)
    }
    const nowMs = this.#d.now()
    s.lastReqMs = nowMs
    if (s.inflight >= INFLIGHT_MAX) return this.#answer(s, req.reqId, RES_STATUS.limit, {})
    const dv = this.#devices.get(s.deviceId)
    const verdict = gate(req, {
      scopes: new Set(dv?.scopes ?? []), presence: PRESENCE.noCredential, elevUntilS: 0, freshPair: s.freshPair,
      openedMs: s.openedMs, nowMs,
    })
    if (!verdict.ok) return this.#answer(s, req.reqId, verdict.status, verdict.status === RES_STATUS.unknownOp ? { error: 'unknown-op' } : {})
    const line = verdict.line
    const mem = this.#memOf(s.deviceId)
    if (req.actId) {
      const done = mem.acts.get(req.actId, nowMs)
      if (done) return this.#send(s, req.reqId, done.status, done.body)
    }
    let body: Record<string, unknown>
    try {
      body = parseJsonObject(req.body)
      const allowed = STRICT_KEYS[line.name]
      if (allowed && Object.keys(body).some((k) => !allowed.includes(k))) throw new WireError('malformed', 'unknown field')
    } catch { return this.#answer(s, req.reqId, RES_STATUS.badRequest, { error: 'bad-request' }) }
    s.inflight++
    let status: ResStatus = RES_STATUS.ok
    let out: unknown = {}
    try {
      switch (line.name) {
        case 'session.info':
          out = { house: this.#fingerprint, name: sanitizeDeclaredName(this.#d.houseName).slice(0, 64), deviceId: s.deviceId, ver: s.session.ver, presence: PRESENCE.noCredential, scopes: dv?.scopes ?? [] }
          break
        case 'attention.list':
          out = this.#d.attention.items()
          break
        case 'attention.watch':
          s.watching = true
          out = this.#d.attention.items()
          break
        case 'admit.renew':
          ({ status, out } = await this.#renew(s, body))
          break
        case 'device.revoke-self':
          // Only lowers power: no proof needed. The registry's writer runs the revocation (spec 6.1 order).
          this.#d.note({ note: 'revoke-self', deviceId: s.deviceId })
          break
        default:
          status = RES_STATUS.failed
          out = { error: 'not-implemented' }
      }
    } catch (e) {
      this.#d.log(`request ${line.name} failed: ${(e as Error).message}`)
      status = RES_STATUS.failed
      out = { error: 'failed' }
    } finally { s.inflight-- }
    const bytes = json(out)
    if (line.mutates && req.actId) mem.acts.put(req.actId, { status, body: bytes }, this.#d.now())
    await this.#send(s, req.reqId, status, bytes)
  }

  async #renew(s: SessionRoute, body: Record<string, unknown>): Promise<{ status: ResStatus; out: unknown }> {
    const refused = { status: RES_STATUS.failed, out: { error: 'refused' } }
    const dv = this.#devices.get(s.deviceId)
    const mem = this.#mem.get(s.deviceId)
    if (!dv || dv.state !== 'active' || mem?.revoking) return refused
    if (typeof body.pubA !== 'string') return { status: RES_STATUS.badRequest, out: { error: 'bad-request' } }
    let pubA: Bytes
    try { pubA = fromB64url(body.pubA) } catch { return { status: RES_STATUS.badRequest, out: { error: 'bad-request' } } }
    if (!(await admitRenewKeyAllowed(pubA, fromHex(dv.pubD), dv.usedKeyIds.map(fromHex)))) return refused
    const { ticket, row } = await this.#issue(pubA)
    const old = dv.tickets.slice()
    try { await this.#d.ask({ ask: 'renew', deviceId: s.deviceId, ticket: row }) } catch { return refused }
    dv.tickets = [row]
    dv.usedKeyIds = [...dv.usedKeyIds, row.keyId]
    // One live ticket per device, plus the slack of the switch: the previous ones are denied a minute later.
    setTimeout(() => {
      const added = old.filter((t) => this.#addDeny(t.ticketId, t.exp)).map((t) => ({ ticketId: t.ticketId, exp: t.exp }))
      if (added.length) this.#sendDeny(added)
    }, this.#d.renewDenyAfterMs ?? RENEW_DENY_AFTER_MS).unref?.()
    this.#d.note({ note: 'audit', act: 'admit.renew', deviceId: s.deviceId, result: 'ok' })
    return { status: RES_STATUS.ok, out: { ticket: b64url(ticket) } }
  }

  async #issue(pubA: Bytes): Promise<{ ticket: Bytes; row: { ticketId: string; exp: number; keyId: string } }> {
    const nowS = Math.floor(this.#d.now() / 1000)
    const cert = parseKeyCert(this.#d.keys.certT)
    const ticket = await issueAdmitTicket(this.#d.keys.kT, {
      certT: this.#d.keys.certT, pubA, aud: this.#d.aud, notBefore: nowS, exp: Math.min(nowS + ADMIT_TTL_S, cert.notAfter),
    })
    const t = parseAdmitTicket(ticket)
    return { ticket, row: { ticketId: toHex(t.ticketId), exp: t.exp, keyId: toHex(await keyIdOf(pubA)) } }
  }

  #answer(s: SessionRoute, reqId: number, status: ResStatus, body: unknown): Promise<void> {
    return this.#send(s, reqId, status, json(body))
  }

  async #send(s: SessionRoute, reqId: number, status: ResStatus, body: Bytes): Promise<void> {
    if (s.session.state !== 'open') return
    try {
      const fx = await s.session.send('RES', encodeRes({ reqId, status, body }), this.#d.now())
      this.#sessionEffects(s, fx)
    } catch (e) { if (!(e instanceof WireError)) throw e }
  }

  // ---- time --------------------------------------------------------------------------------------------------

  async tick(): Promise<void> {
    const nowMs = this.#d.now()
    const idleMs = this.#d.idleMs ?? IDLE_LOCK_MS
    const jobs: Promise<void>[] = []
    for (const r of [...this.#routes.values()]) {
      if (r.kind === 'admit') jobs.push(r.hs.tick(nowMs).then((fx) => this.#hsEffects(r, fx)))
      else if (r.kind === 'session') {
        if (nowMs - r.lastReqMs >= idleMs) jobs.push(r.session.close(CLOSE.idle, nowMs).then((fx) => this.#sessionEffects(r, fx)))
        else jobs.push(r.session.tick(nowMs).then((fx) => this.#sessionEffects(r, fx)))
      }
    }
    if (this.#pairing && !this.#isOver(this.#pairing.view.state)) jobs.push(this.#pairing.p.tick(nowMs).then((fx) => this.#pairEffects(fx)))
    if (this.#d.attention.takeChange()) jobs.push(this.#pushAttention())
    await Promise.all(jobs)
  }

  async #pushAttention(): Promise<void> {
    const body = json(this.#d.attention.items())
    const evt = encodeEvt({ evt: EVT.attentionChanged.code, body })
    for (const r of [...this.#routes.values()]) {
      if (r.kind !== 'session' || !r.watching || r.session.state !== 'open') continue
      const dv = this.#devices.get(r.deviceId)
      if (!dv?.scopes.includes(EVT.attentionChanged.scope)) continue
      try { this.#sessionEffects(r, await r.session.send('EVT', evt, this.#d.now())) } catch (e) { if (!(e instanceof WireError)) throw e }
    }
  }

  // ---- deny list ---------------------------------------------------------------------------------------------

  #addDeny(ticketId: string, exp: number): boolean {
    const cur = this.#deny.get(ticketId)
    if (cur !== undefined && cur >= exp) return false
    this.#deny.set(ticketId, exp)
    return true
  }

  #pruneDeny(): void {
    const nowS = Math.floor(this.#d.now() / 1000)
    for (const [id, exp] of this.#deny) if (nowS > exp + 300) this.#deny.delete(id)
  }

  #sendDeny(rows: readonly DenyRow[]): void {
    if (!this.#linkUp) return
    for (let i = 0; i < rows.length; i += 256) {
      this.#d.send(encodeOuter({ type: 'H_DENY', overflow: false, entries: rows.slice(i, i + 256).map((r) => ({ ticketId: fromHex(r.ticketId), exp: r.exp })) }))
    }
  }

  // ---- pairing -----------------------------------------------------------------------------------------------

  #isOver(s: PairView['state']): boolean { return s === 'done' || s === 'burned' }

  async pairBegin(): Promise<PairBegun> {
    if (!this.#linkUp) throw new PortalError('offline', 'o portal não está ligado ao relay agora')
    if (this.#pairing && !this.#isOver(this.#pairing.view.state)) {
      this.#pairEffects(await this.#pairing.p.cancel(this.#d.now()))
    }
    for (let attempt = 0; attempt < PAIR_REDRAWS; attempt++) {
      let p: HousePairing
      try { p = await HousePairing.create({ kH: this.#d.keys.kH, lockout: this.#lockout, nowMs: this.#d.now() }) } catch (e) {
        if (e instanceof WireError && e.code === 'locked') throw new PortalError('locked', 'pareamento bloqueado por uma hora depois de cinco tentativas falhas')
        throw e
      }
      const view: PairView = { pairId: toHex(p.pairId), state: 'open', expiresAt: p.expiresAtMs }
      const entry: PairingEntry = { p, view }
      this.#pairing = entry
      const state = await new Promise<number | undefined>((resolve) => {
        const timer = setTimeout(() => resolve(undefined), PAIR_STATE_WAIT_MS)
        entry.waitState = (code) => { clearTimeout(timer); entry.waitState = undefined; resolve(code) }
        this.#d.send(encodeOuter({ type: 'H_PAIR_LISTEN', ttl: 120, rvs: [p.rvCode, p.rvQr] }))
      })
      if (state === PAIR_STATE.listening) {
        const code = p.code()
        const qr = qrFragment(await p.qr(this.#d.aud))
        this.#d.notice('Um pareamento de aparelho foi iniciado neste computador. Se não foi você, cancele na tela do tether.')
        this.#d.note({ note: 'audit', act: 'pair.begin', result: 'ok' })
        return { ...view, code, qr, fingerprint: this.#fingerprint }
      }
      await p.cancel(this.#d.now())
      this.#pairing = undefined
      this.#d.send(encodeOuter({ type: 'H_PAIR_CANCEL' }))
      if (state !== PAIR_STATE.rvInUse) throw new PortalError('relay', 'o relay não confirmou o ponto de encontro')
    }
    throw new PortalError('relay', 'o relay recusou os pontos de encontro sorteados')
  }

  #pairOf(pairId: string): PairingEntry {
    const pr = this.#pairing
    if (!pr || pr.view.pairId !== pairId) throw new PortalError('not-found', 'nenhum pareamento com esse id')
    return pr
  }

  pairState(pairId: string): PairView { return { ...this.#pairOf(pairId).view } }

  async pairSas(pairId: string, digits: string): Promise<PairView> {
    const pr = this.#pairOf(pairId)
    if (pr.view.state !== 'waiting-sas') throw new PortalError('bad-state', 'o pareamento não está esperando os dígitos')
    this.#pairEffects(await pr.p.submitSas(digits, this.#d.now()))
    // sas-ok continues asynchronously (registry write, then PAIR_DONE); the view says where it is.
    return { ...pr.view }
  }

  async pairCancel(pairId: string): Promise<PairView> {
    const pr = this.#pairOf(pairId)
    if (!this.#isOver(pr.view.state)) this.#pairEffects(await pr.p.cancel(this.#d.now()))
    return { ...pr.view }
  }

  #pairEffects(fx: HousePairEffect[]): void {
    const pr = this.#pairing
    if (!pr) return
    for (const e of fx) {
      switch (e.t) {
        case 'send': this.#data(e.route, e.frame); break
        case 'close': if (this.#routes.has(e.route)) this.#close(e.route); break
        case 'await-sas':
          pr.view.state = 'waiting-sas'
          pr.view.device = { declaredName: sanitizeDeclaredName(e.device.declaredName).slice(0, 64), caps: e.device.caps, access: e.device.access }
          pr.view.triesLeft = 3
          break
        case 'sas-wrong': pr.view.triesLeft = e.triesLeft; break
        case 'sas-ok': pr.view.state = 'confirmed'; void this.#confirm(pr, e.device); break
        case 'burned': {
          pr.view.state = 'burned'
          pr.view.burnReason = e.reason
          delete pr.view.triesLeft
          if (this.#linkUp) this.#d.send(encodeOuter({ type: 'H_PAIR_CANCEL' }))
          if (e.eraseDeviceId) {
            const id = toHex(e.eraseDeviceId)
            this.#devices.delete(id)
            this.#d.note({ note: 'erase', deviceId: id })
          }
          this.#d.note({ note: 'audit', act: 'pair', result: `burned:${e.reason}` })
          if (e.countsForLockout || e.reason === 'collision') {
            this.#d.notice(e.reason === 'collision'
              ? 'Duas tentativas de pareamento ao mesmo tempo: o código foi anulado. Gere outro.'
              : 'Um pareamento de aparelho falhou neste computador e o código foi anulado.')
          }
          break
        }
        case 'done': {
          pr.view.state = 'done'
          delete pr.view.triesLeft
          if (this.#linkUp) this.#d.send(encodeOuter({ type: 'H_PAIR_CANCEL' }))
          const deviceId = toHex(e.deviceId)
          const dv = this.#devices.get(deviceId)
          if (dv) dv.state = 'active'
          this.#adopt(e.route, e.session, deviceId, true)
          this.#d.note({ note: 'acked', deviceId })
          this.#d.note({ note: 'audit', act: 'pair', deviceId, result: 'done' })
          this.#d.notice('Um aparelho foi pareado com este computador. Você pode revogá-lo a qualquer momento.')
          break
        }
      }
    }
  }

  async #confirm(pr: PairingEntry, device: { deviceId: Bytes; pubD: Bytes; pubA: Bytes; name: string; ver: number; access: 'code' | 'qr' }): Promise<void> {
    const deviceId = toHex(device.deviceId)
    try {
      const { ticket, row } = await this.#issue(device.pubA)
      const name = sanitizeDeclaredName(device.name).slice(0, 64)
      await this.#d.ask({ ask: 'paired', device: { deviceId, pubD: toHex(device.pubD), name, ver: device.ver, access: device.access }, ticket: row })
      this.#devices.set(deviceId, {
        deviceId, pubD: toHex(device.pubD), state: 'pending', maxVerUsed: device.ver, scopes: [...DEFAULT_SCOPES],
        tickets: [row], usedKeyIds: [row.keyId],
      })
      if (this.#pairing !== pr) return
      this.#pairEffects(await pr.p.confirm({ admitTicket: ticket, houseName: sanitizeDeclaredName(this.#d.houseName).slice(0, 64), nowMs: this.#d.now() }))
    } catch (e) {
      this.#d.log(`pairing: the device could not be written (${(e as Error).message}); cancelled`)
      if (this.#pairing === pr) this.#pairEffects(await pr.p.cancel(this.#d.now()))
    }
  }
}

/** Every scope a device gets at pairing (plano §2 "Escopos": all on, adjustable on the machine from RR2). */
export const DEFAULT_SCOPES = [
  'attention', 'channels', 'regency:read', 'manage:agents', 'manage:desks', 'manage:procs', 'manage:destructive',
  'peek:terminal:read', 'peek:terminal:write', 'peek:browser',
] as const

export class PortalError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'PortalError'
    this.code = code
  }
}
