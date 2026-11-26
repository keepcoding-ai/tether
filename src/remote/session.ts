// The session over the record layer, and the session handshake of an already paired device (spec 4). Everything
// here is a pure state machine: it receives bytes and the current time, and returns bytes to send and effects.
// No socket, no timer; the caller owns both and calls `tick(nowMs)` to let deadlines and heartbeats happen.
import { concat, equal, fail, Serial, WireError, type Bytes } from './bytes.ts'
import {
  CLOSE, FAIL_DELAY_MS, HB_INTERVAL_MS, HB_TIMEOUT_MS, HS_DEADLINE_MS, SESSIONS_PER_DEVICE, SUITE, SUPPORTED_VERSIONS,
  type Presence,
} from './constants.ts'
import {
  CTYPE_SENDER, decodeClose, decodeHsDone, decodePing, decodePong, encodeClose, encodeHsDone, encodePing, encodePong,
  type CloseCode, type ContentType,
} from './content.ts'
import {
  OneShotKey, Secret, SELF_TEST_POINTS, systemEntropy, validatePoint, verifyLabeled, type Entropy, type Ephemeral,
  type RoleKey,
} from './crypto.ts'
import { decodeInner, encodeInner, HS_FAIL_FRAME, innerTypeOf } from './frames.ts'
import { deviceIdOf, houseIdOf } from './keys.ts'
import { RecordChannel, type RecordLimits } from './record.ts'
import { session as TH, th2 as TH2 } from './transcript.ts'

// ---------------------------------------------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------------------------------------------

export type SessionRole = 'device' | 'house'
export type AppContentType = 'REQ' | 'RES' | 'EVT' | 'BIN'
type ControlType = 'HS_DONE' | 'PAIR_DONE' | 'PAIR_ACK'
/** What the session still waits for before application content is allowed in either direction. */
export type SessionGate = 'await-hs-done' | 'await-pair-done' | 'await-pair-ack' | 'open'

export type SessionEffect =
  /** An inner frame to write to the route. */
  | { t: 'send'; frame: Bytes }
  /** Application content that arrived, already authenticated and in order. */
  | { t: 'record'; ctype: AppContentType; content: Bytes }
  /** The session ended. Keys and counters are gone; the caller closes the route. `code` is the CLOSE code, if any. */
  | { t: 'closed'; by: 'peer' | 'local'; code?: CloseCode; reason: string }

export interface ControlEvent { ctype: ControlType; content: Bytes }

const isApp = (c: ContentType): c is AppContentType => c === 'REQ' || c === 'RES' || c === 'EVT' || c === 'BIN'

/**
 * One end of an established channel: the record layer plus the rules of content types (direction, order), the
 * heartbeat with its counters (spec 4.6) and the clean close (spec 4.7). A session never recovers from an error.
 */
export class Session {
  readonly role: SessionRole
  readonly ver: number
  readonly sessionId: Bytes
  readonly #ch: RecordChannel
  readonly #serial = new Serial()
  #gate: SessionGate
  #closed = false
  #freshPair = false
  #ackAllowed = false
  #lastRecvMs: number
  #lastPingMs: number
  readonly #pings = new Set<number>()
  #lastReported = 0
  #pingReport: { r: number; sent: number } | undefined

  constructor(init: { role: SessionRole; ver: number; channel: RecordChannel; gate: SessionGate; nowMs: number }) {
    this.role = init.role
    this.ver = init.ver
    this.#ch = init.channel
    this.sessionId = init.channel.sessionId
    this.#gate = init.gate
    this.#lastRecvMs = init.nowMs
    this.#lastPingMs = init.nowMs
  }

  get state(): 'gated' | 'open' | 'closed' { return this.#closed ? 'closed' : this.#gate === 'open' ? 'open' : 'gated' }
  /** True for the session that concluded a pairing (spec 3.4, 7.4). */
  get freshPair(): boolean { return this.#freshPair }
  /** Records this end has sent; the peer's `recvNext` can never be above it. */
  get sent(): number { return this.#ch.sent }
  get recvNext(): number { return this.#ch.recvNext }

  /** Feeds one inner frame that arrived on the route. */
  receive(frame: Uint8Array, nowMs: number): Promise<SessionEffect[]> {
    return this._receive(frame, nowMs).then(r => r.effects)
  }

  /** Sends application content. Only on an open session, and only a type this role may write. */
  send(ctype: AppContentType, content: Uint8Array, nowMs: number): Promise<SessionEffect[]> {
    return this.#serial.run(async () => {
      if (this.#closed || this.#gate !== 'open') fail('bad-state', 'the session is not open')
      const who = CTYPE_SENDER[ctype]
      if (!isApp(ctype) || (who !== 'both' && who !== this.role)) fail('bad-state', `${ctype} is not written by the ${this.role}`)
      if (this.#ch.rekeyDue(nowMs)) return this.#closeWith(CLOSE.rekey, 'rekey limit')
      return [{ t: 'send', frame: (await this.#ch.seal(ctype, content)).frame }]
    })
  }

  /** Lets time pass: heartbeat timeout, rekey by age, and the periodic PING. */
  tick(nowMs: number): Promise<SessionEffect[]> {
    return this.#serial.run(async () => {
      if (this.#closed) return []
      if (nowMs - this.#lastRecvMs >= HB_TIMEOUT_MS) return this.#die('no valid record within HB_TIMEOUT')
      if (this.#gate === 'await-hs-done') return []
      if (this.#ch.rekeyDue(nowMs)) return this.#closeWith(CLOSE.rekey, 'rekey limit')
      if (nowMs - this.#lastPingMs < HB_INTERVAL_MS) return []
      this.#lastPingMs = nowMs
      const { frame, ctr } = await this.#ch.seal('PING', encodePing(this.#ch.recvNext))
      this.#pings.add(ctr)
      return [{ t: 'send', frame }]
    })
  }

  /** Clean close: a CLOSE record, then the end of the session. */
  close(code: CloseCode, _nowMs: number): Promise<SessionEffect[]> {
    return this.#serial.run(() => this.#closeWith(code, 'closed locally'))
  }

  /** Ends the session without writing anything (the route is already gone, or the owner gave up). */
  drop(reason: string): SessionEffect[] { return this.#die(reason) }

  // -- for the machines that own a gated session (handshake and pairing) --------------------------------------

  /** Like `receive`, but also hands back the control record a gated session was waiting for. */
  _receive(frame: Uint8Array, nowMs: number): Promise<{ effects: SessionEffect[]; control?: ControlEvent }> {
    return this.#serial.run(() => this.#recv(frame, nowMs))
  }

  /** Writes HS_DONE, PAIR_DONE or PAIR_ACK. HS_DONE is always record 0 of the house (spec 4.2 rule 8). */
  _sendControl(ctype: ControlType, content: Uint8Array): Promise<Bytes> {
    return this.#serial.run(async () => {
      if (this.#closed) fail('bad-state', 'the session is closed')
      if (ctype === 'HS_DONE' && this.#ch.sent !== 0) fail('bad-state', 'HS_DONE must be record 0')
      return (await this.#ch.seal(ctype, content)).frame
    })
  }

  _open(freshPair: boolean): void { this.#gate = 'open'; this.#freshPair = freshPair }
  _allowAck(): void { this.#ackAllowed = true }

  // -- internals ---------------------------------------------------------------------------------------------------

  #finish(): void {
    this.#closed = true
    this.#ch.destroy()
    this.#pings.clear()
  }

  #die(reason: string): SessionEffect[] {
    if (this.#closed) return []
    this.#finish()
    return [{ t: 'closed', by: 'local', reason }]
  }

  async #closeWith(code: CloseCode, reason: string): Promise<SessionEffect[]> {
    if (this.#closed) return []
    const out: SessionEffect[] = []
    try { out.push({ t: 'send', frame: (await this.#ch.seal('CLOSE', encodeClose(code))).frame }) }
    catch (e) { if (!(e instanceof WireError)) throw e }
    this.#finish()
    out.push({ t: 'closed', by: 'local', code, reason })
    return out
  }

  /** The peer says which counter it expects next. Above what was sent, or going backwards, is a protocol error. */
  #report(r: number): boolean {
    if (r > this.#ch.sent || r < this.#lastReported) return false
    this.#lastReported = r
    return true
  }

  async #recv(frame: Uint8Array, nowMs: number): Promise<{ effects: SessionEffect[]; control?: ControlEvent }> {
    if (this.#closed) return { effects: [] }
    const die = (reason: string): { effects: SessionEffect[] } => ({ effects: this.#die(reason) })
    try {
      const { ctype, content, ctr } = await this.#ch.open(frame)
      this.#lastRecvMs = nowMs
      const who = CTYPE_SENDER[ctype]
      if (who === this.role) return die(`${ctype} in the wrong direction`)
      if (this.#gate === 'await-hs-done') {
        if (ctype !== 'HS_DONE' || ctr !== 0) return die('the first record of the house must be HS_DONE')
        return { effects: [], control: { ctype, content } }
      }
      switch (ctype) {
        case 'PING': {
          const { recvNext } = decodePing(content)
          const before = this.#pingReport
          if (!this.#report(recvNext)) return die('heartbeat counter out of range')
          this.#pingReport = { r: recvNext, sent: this.#ch.sent }
          // Two PINGs in a row report the same counter, already below what this end had sent: frames are being
          // withheld (spec 4.6, 11 Q12).
          if (before && recvNext === before.r && recvNext < before.sent) {
            return { effects: await this.#closeWith(CLOSE.protocol, 'the peer is not receiving') }
          }
          return { effects: [{ t: 'send', frame: (await this.#ch.seal('PONG', encodePong(ctr, this.#ch.recvNext))).frame }] }
        }
        case 'PONG': {
          const { pingCtr, recvNext } = decodePong(content)
          if (!this.#pings.delete(pingCtr) || recvNext <= pingCtr || !this.#report(recvNext)) return die('inconsistent PONG')
          for (const p of this.#pings) if (p < pingCtr) this.#pings.delete(p)
          return { effects: [] }
        }
        case 'CLOSE': {
          const { code } = decodeClose(content)
          this.#finish()
          return { effects: [{ t: 'closed', by: 'peer', code, reason: 'closed by the peer' }] }
        }
        case 'HS_DONE': return die('HS_DONE outside record 0')
        case 'PAIR_DONE':
          if (this.#gate !== 'await-pair-done') return die('PAIR_DONE outside a pairing')
          return { effects: [], control: { ctype, content } }
        case 'PAIR_ACK':
          if (this.#gate !== 'await-pair-ack' || !this.#ackAllowed) return die('PAIR_ACK before PAIR_DONE')
          return { effects: [], control: { ctype, content } }
        default:
          if (this.#gate !== 'open') return die(`${ctype} before the session is open`)
          return { effects: [{ t: 'record', ctype, content }] }
      }
    } catch (e) {
      if (!(e instanceof WireError)) throw e
      return die(`record refused: ${e.code}`)
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Session handshake, device side (initiator)
// ---------------------------------------------------------------------------------------------------------------

export type DeviceHsFailure =
  /** HS_FAIL from the house: no reason given. Retry later with backoff, same version, never "pair again". */
  | 'hs-fail'
  | 'timeout'
  | 'route-closed'
  /** A frame that does not parse, is not expected in this state, or carries an invalid point. */
  | 'protocol'
  /** Hard error: ct2 does not open or sig_H does not verify under the pinned key. HS3 was not sent. */
  | 'house-not-proven'
  /** The house speaks a higher version than this session used: the session is closed and not used (E-1). */
  | 'version-downgrade'

export interface HsDoneInfo {
  ver: number
  houseMaxVer: number
  /** `max(pinnedVer, min(houseMaxVer, the highest this device speaks))`: the floor only rises (spec 2.5 rule 3). */
  pinnedVer: number
  houseNow: number
  presence: Presence
  elevUntil: number
}

export type DeviceHsEffect =
  | { t: 'send'; frame: Bytes }
  | { t: 'established'; session: Session; info: HsDoneInfo }
  | { t: 'failed'; reason: DeviceHsFailure; hard: boolean }

export interface DeviceHandshakeInit {
  /** The whole pinned pub_H (65 bytes). No house key ever arrives on the wire in this mode. */
  pinnedPubH: Uint8Array
  kD: RoleKey
  nowMs: number
  /** The version to use; defaults to the only one of v1. The device starts a handshake only at its pinned version. */
  pinnedVer?: number
  /** The highest version this device speaks. */
  deviceMaxVer?: number
  limits?: Partial<RecordLimits>
  /** Test-only seam (spec 11 Q22). */
  entropy?: Entropy
}

const highestSupported = (): number => Math.max(...SUPPORTED_VERSIONS)

export class DeviceHandshake {
  readonly #serial = new Serial()
  readonly #init: DeviceHandshakeInit
  readonly #ver: number
  readonly #deviceMaxVer: number
  readonly #deadlineMs: number
  #state: 'sent-hs1' | 'sent-hs3' | 'done' | 'failed' = 'sent-hs1'
  #eph: Ephemeral | undefined
  #th1: Bytes
  #session: Session | undefined

  private constructor(init: DeviceHandshakeInit, ver: number, deviceMaxVer: number, eph: Ephemeral, th1: Bytes) {
    this.#init = init
    this.#ver = ver
    this.#deviceMaxVer = deviceMaxVer
    this.#eph = eph
    this.#th1 = th1
    this.#deadlineMs = init.nowMs + HS_DEADLINE_MS
  }

  static async start(init: DeviceHandshakeInit): Promise<{ hs: DeviceHandshake; effects: DeviceHsEffect[] }> {
    if (init.kD.role !== 'device') fail('bad-label', 'the session handshake signs with K_D')
    await validatePoint(init.pinnedPubH)
    const ver = init.pinnedVer ?? highestSupported()
    if (!SUPPORTED_VERSIONS.includes(ver)) fail('bad-version', 'this build does not speak the pinned version')
    const deviceMaxVer = init.deviceMaxVer ?? highestSupported()
    if (deviceMaxVer < ver) fail('bad-version', 'the pinned version is above what the device speaks')
    const entropy = init.entropy ?? systemEntropy
    const eph = await entropy.ephemeral()
    const nD = entropy.random(32)
    const th1 = await TH.th1(await TH.th0(ver, SUITE), ver, SUITE, eph.pub, nD)
    const hs = new DeviceHandshake(init, ver, deviceMaxVer, eph, th1)
    return { hs, effects: [{ t: 'send', frame: encodeInner({ type: 'HS1', ver, suite: SUITE, eD: eph.pub, nD }) }] }
  }

  get state(): 'sent-hs1' | 'sent-hs3' | 'done' | 'failed' { return this.#state }

  onFrame(frame: Uint8Array, nowMs: number): Promise<DeviceHsEffect[]> {
    return this.#serial.run(async () => {
      if (this.#state === 'done' || this.#state === 'failed') return []
      if (frame.length === 1 && innerTypeOf(frame) === 'HS_FAIL') return this.#fail('hs-fail')
      try {
        return this.#state === 'sent-hs1' ? await this.#onHs2(frame, nowMs) : await this.#onHsDone(frame, nowMs)
      } catch (e) {
        if (!(e instanceof WireError) || e.code === 'self-test') throw e
        return this.#fail('protocol')
      }
    })
  }

  tick(nowMs: number): Promise<DeviceHsEffect[]> {
    return this.#serial.run(async () => {
      if (this.#state === 'done' || this.#state === 'failed') return []
      return nowMs >= this.#deadlineMs ? this.#fail('timeout') : []
    })
  }

  /** The route closed under the handshake. Equivalent to HS_FAIL: no fallback of any kind. */
  routeClosed(): Promise<DeviceHsEffect[]> {
    return this.#serial.run(async () => (this.#state === 'done' || this.#state === 'failed' ? [] : this.#fail('route-closed')))
  }

  #fail(reason: DeviceHsFailure): DeviceHsEffect[] {
    this.#state = 'failed'
    this.#eph = undefined
    this.#session?.drop(reason)
    this.#session = undefined
    return [{ t: 'failed', reason, hard: reason === 'house-not-proven' }]
  }

  async #onHs2(frame: Uint8Array, nowMs: number): Promise<DeviceHsEffect[]> {
    const f = decodeInner(frame)
    if (f.type !== 'HS2') return this.#fail('protocol')
    const eph = this.#eph!
    if (equal(f.eH, eph.pub)) return this.#fail('protocol')
    const pubH = this.#init.pinnedPubH
    const z = await Secret.agree(eph.privateKey, f.eH)
    this.#eph = undefined
    const t2 = await TH2(this.#th1, f.eH, f.nH, pubH, await houseIdOf(pubH))
    const kH2d = new OneShotKey(await z.aesKey(t2, 'k-hs-h2d', 'decrypt'))
    const kD2h = new OneShotKey(await z.aesKey(t2, 'k-hs-d2h', 'encrypt'))
    // The house authenticates first. Only after sig_H verifies under the pinned key does the device sign and
    // reveal who it is (spec 4.2 rules 3 and 4).
    let sigH: Bytes
    try { sigH = await kH2d.open(t2, f.ct2) }
    catch (e) { if (e instanceof WireError && e.code === 'auth') { z.destroy(); return this.#fail('house-not-proven') } throw e }
    if (!(await verifyLabeled(pubH, 'house-hs', t2, sigH))) { z.destroy(); return this.#fail('house-not-proven') }
    const kD = this.#init.kD
    const t3 = await TH.th3(t2, f.ct2)
    const t4 = await TH.th4(t3, kD.pub)
    const sigD = await kD.sign('device-hs', concat(t4, sigH))
    const ct3 = await kD2h.seal(t3, concat(await deviceIdOf(kD.pub), sigD))
    const t5 = await TH.th5(t4, ct3)
    const channel = new RecordChannel({
      role: 'device', sessionId: t5.slice(0, 16), startedMs: nowMs, limits: this.#init.limits,
      sendKey: await z.aesKey(t5, 'k-d2h', 'encrypt'), recvKey: await z.aesKey(t5, 'k-h2d', 'decrypt'),
    })
    z.destroy()
    this.#session = new Session({ role: 'device', ver: this.#ver, channel, gate: 'await-hs-done', nowMs })
    this.#state = 'sent-hs3'
    return [{ t: 'send', frame: encodeInner({ type: 'HS3', ct3 }) }]
  }

  async #onHsDone(frame: Uint8Array, nowMs: number): Promise<DeviceHsEffect[]> {
    const session = this.#session!
    const r = await session._receive(frame, nowMs)
    if (!r.control) return this.#fail('protocol')
    const done = decodeHsDone(r.control.content)
    if (done.houseMaxVer < this.#ver) return this.#fail('protocol')
    // E-1: the downgrade is detected in the session where it happened.
    if (Math.min(done.houseMaxVer, this.#deviceMaxVer) > this.#ver) {
      const sends = (await session.close(CLOSE.protocol, nowMs)).filter(e => e.t === 'send')
      this.#session = undefined
      return [...sends, ...this.#fail('version-downgrade')]
    }
    session._open(false)
    this.#state = 'done'
    this.#session = undefined
    const info: HsDoneInfo = {
      ver: this.#ver, houseMaxVer: done.houseMaxVer, houseNow: done.now, presence: done.presence, elevUntil: done.elevUntil,
      pinnedVer: Math.max(this.#ver, Math.min(done.houseMaxVer, this.#deviceMaxVer)),
    }
    return [{ t: 'established', session, info }]
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Session handshake, house side (responder)
// ---------------------------------------------------------------------------------------------------------------

/** What the house registry answers about a device. The handshake reads it twice (spec 4.2 rule 6). */
export interface DeviceRecord {
  pubD: Uint8Array
  revoked: boolean
  expired: boolean
  /** The highest version this device has ever used; a lower one is refused (spec 2.5 rule 3). */
  maxVerUsed: number
  /** Sessions of this device alive right now, not counting the one being established. */
  liveSessions: number
  presence: Presence
  /** Unix seconds until which the elevation window is open; 0 for none. */
  elevUntil: number
}

export type DeviceLookup = (deviceId: Bytes) => DeviceRecord | undefined | Promise<DeviceRecord | undefined>

export type HouseHsEffect =
  /** `notBeforeMs`, when present, is the instant the frame must leave: the uniform failure of spec 4.2 rule 7. */
  | { t: 'send'; frame: Bytes; notBeforeMs?: number }
  | { t: 'close'; reason: string; notBeforeMs?: number }
  | { t: 'established'; session: Session; device: { deviceId: Bytes; pubD: Bytes; ver: number } }

export interface HouseHandshakeInit {
  kH: RoleKey
  lookup: DeviceLookup
  nowMs: number
  /** The highest version the house speaks, announced inside the channel. */
  houseMaxVer?: number
  limits?: Partial<RecordLimits>
  /** Test-only seam (spec 11 Q22). */
  entropy?: Entropy
}

const registryAccepts = (rec: DeviceRecord, ver: number): boolean =>
  !rec.revoked && !rec.expired && ver >= rec.maxVerUsed && rec.liveSessions < SESSIONS_PER_DEVICE

interface HouseHsPending { ver: number; z: Secret; t3: Bytes; sigH: Bytes; kD2h: OneShotKey }

/** One route opened by admission. It accepts only HS1, then only HS3 (spec 4.3). */
export class HouseHandshake {
  readonly #serial = new Serial()
  readonly #init: HouseHandshakeInit
  #state: 'route-open' | 'sent-hs2' | 'done' | 'closed' = 'route-open'
  #deadlineMs: number
  #pending: HouseHsPending | undefined

  constructor(init: HouseHandshakeInit) {
    if (init.kH.role !== 'house') fail('bad-label', 'the house signs the handshake with K_H')
    this.#init = init
    this.#deadlineMs = init.nowMs + HS_DEADLINE_MS
  }

  get state(): 'route-open' | 'sent-hs2' | 'done' | 'closed' { return this.#state }

  onFrame(frame: Uint8Array, nowMs: number): Promise<HouseHsEffect[]> {
    return this.#serial.run(async () => {
      if (this.#state === 'done' || this.#state === 'closed') return []
      try {
        return this.#state === 'route-open' ? await this.#onHs1(frame, nowMs) : await this.#onHs3(frame, nowMs)
      } catch (e) {
        if (!(e instanceof WireError) || e.code === 'self-test') throw e
        return this.#close(`handshake refused: ${e.code}`)
      }
    })
  }

  /** HS_DEADLINE: from the route opening to HS1, and again from HS1 to HS_DONE. */
  tick(nowMs: number): Promise<HouseHsEffect[]> {
    return this.#serial.run(async () => {
      if (this.#state === 'done' || this.#state === 'closed') return []
      return nowMs >= this.#deadlineMs ? this.#close('HS_DEADLINE') : []
    })
  }

  routeClosed(): Promise<HouseHsEffect[]> {
    return this.#serial.run(async () => { this.#drop(); return [] })
  }

  #drop(): void {
    this.#state = 'closed'
    this.#pending?.z.destroy()
    this.#pending = undefined
  }

  #close(reason: string): HouseHsEffect[] {
    this.#drop()
    return [{ t: 'close', reason }]
  }

  /** The same answer at the same instant, whatever failed in step 4 (spec 4.2 rule 7). */
  #uniformFail(arrivalMs: number): HouseHsEffect[] {
    this.#drop()
    const notBeforeMs = arrivalMs + FAIL_DELAY_MS
    return [{ t: 'send', frame: HS_FAIL_FRAME(), notBeforeMs }, { t: 'close', reason: 'hs-fail', notBeforeMs }]
  }

  async #onHs1(frame: Uint8Array, nowMs: number): Promise<HouseHsEffect[]> {
    if (innerTypeOf(frame) !== 'HS1') return this.#close('a route opened by admission accepts only HS1')
    const f = decodeInner(frame)
    if (f.type !== 'HS1') return this.#close('a route opened by admission accepts only HS1')
    if (!SUPPORTED_VERSIONS.includes(f.ver) || f.suite !== SUITE) {
      this.#drop()
      return [{ t: 'send', frame: HS_FAIL_FRAME() }, { t: 'close', reason: 'version or suite not spoken' }]
    }
    const entropy = this.#init.entropy ?? systemEntropy
    const eph = await entropy.ephemeral()
    if (equal(f.eD, eph.pub)) return this.#close('reflected ephemeral')
    const z = await Secret.agree(eph.privateKey, f.eD)
    const nH = entropy.random(32)
    const kH = this.#init.kH
    const t1 = await TH.th1(await TH.th0(f.ver, SUITE), f.ver, SUITE, f.eD, f.nD)
    const t2 = await TH2(t1, eph.pub, nH, kH.pub, await houseIdOf(kH.pub))
    const kH2d = new OneShotKey(await z.aesKey(t2, 'k-hs-h2d', 'encrypt'))
    const kD2h = new OneShotKey(await z.aesKey(t2, 'k-hs-d2h', 'decrypt'))
    // K_H signs TH2, which holds the house's fresh ephemeral: the signature is useless in any other session.
    const sigH = await kH.sign('house-hs', t2)
    const ct2 = await kH2d.seal(t2, sigH)
    this.#pending = { ver: f.ver, z, t3: await TH.th3(t2, ct2), sigH, kD2h }
    this.#state = 'sent-hs2'
    this.#deadlineMs = nowMs + HS_DEADLINE_MS
    return [{ t: 'send', frame: encodeInner({ type: 'HS2', eH: eph.pub, nH, ct2 }) }]
  }

  async #onHs3(frame: Uint8Array, nowMs: number): Promise<HouseHsEffect[]> {
    if (innerTypeOf(frame) !== 'HS3') return this.#close('only HS3 is accepted after HS2')
    const f = decodeInner(frame)
    if (f.type !== 'HS3') return this.#close('only HS3 is accepted after HS2')
    const p = this.#pending!
    let opened: Bytes
    try { opened = await p.kD2h.open(p.t3, f.ct3) }
    catch (e) { if (e instanceof WireError && e.code === 'auth') return this.#uniformFail(nowMs); throw e }
    const deviceId = opened.slice(0, 16)
    const sigD = opened.slice(16)
    // The identity is the key that verifies the signature; deviceId is only the lookup. An unknown deviceId walks
    // the same path with a dummy key and fails the same way (spec 4.2 rule 5).
    const rec = await this.#init.lookup(deviceId)
    const pubD = rec ? concat(rec.pubD) : SELF_TEST_POINTS.valid()
    const t4 = await TH.th4(p.t3, pubD)
    const sigOk = await verifyLabeled(pubD, 'device-hs', concat(t4, p.sigH), sigD)
    if (!rec || !sigOk || !registryAccepts(rec, p.ver)) return this.#uniformFail(nowMs)
    const t5 = await TH.th5(t4, f.ct3)
    const channel = new RecordChannel({
      role: 'house', sessionId: t5.slice(0, 16), startedMs: nowMs, limits: this.#init.limits,
      sendKey: await p.z.aesKey(t5, 'k-h2d', 'encrypt'), recvKey: await p.z.aesKey(t5, 'k-d2h', 'decrypt'),
    })
    // The registry is read again immediately before HS_DONE: a revocation in the middle kills the handshake.
    const again = await this.#init.lookup(deviceId)
    if (!again || !equal(again.pubD, pubD) || !registryAccepts(again, p.ver)) { channel.destroy(); return this.#uniformFail(nowMs) }
    const session = new Session({ role: 'house', ver: p.ver, channel, gate: 'open', nowMs })
    const done = encodeHsDone({
      houseMaxVer: this.#init.houseMaxVer ?? highestSupported(), now: Math.floor(nowMs / 1000), presence: again.presence,
      elevUntil: again.elevUntil,
    })
    const hsDone = await session._sendControl('HS_DONE', done)
    const ver = p.ver
    this.#drop()
    this.#state = 'done'
    return [{ t: 'send', frame: hsDone }, { t: 'established', session, device: { deviceId, pubD, ver } }]
  }
}
