// Pairing (spec 3): commitment before the reveal, a SAS the person types on the machine, and a secret S that proves
// the house to the device. Two pure state machines, one per side, plus the lockout counter of the house.
//
// What must never be broken here:
//  - the SAS depends only on Z and TH4, and TH4 holds only committed values: no signature enters it (C-1.2, F-1);
//  - the house reveals (e_H, N_H) exactly once per ticket, and a second P1 burns the ticket (C-1.3);
//  - the device has one attempt per code: any failure after P1 kills the machine, and nothing restarts it (F-2);
//  - S is used only in houseConfirm, after the SAS matched; it never reaches a transcript, a hash or a key before;
//  - the house never shows, logs or returns the SAS it expects: it only compares, in constant time.
import {
  ascii, concat, ctEqual, equal, fail, lp16, Reader, Serial, wipe, WireError, type Bytes,
} from './bytes.ts'
import {
  CLOSE, HS_DEADLINE_MS, PAIR_ACK_WAIT_MS, PAIR_CODE_DIGITS, PAIR_LOCKOUT_BLOCK_MS, PAIR_LOCKOUT_FAILURES,
  PAIR_LOCKOUT_WINDOW_MS, PAIR_SAS_TRIES, PAIR_SAS_WINDOW_MS, PAIR_TTL_MS, SUITE, SUPPORTED_VERSIONS,
} from './constants.ts'
import {
  decodeDeviceHello, decodePairDone, encodeDeviceHello, encodePairDone, formatTypedCode, parseTypedCode,
  sanitizeDeclaredName, type QrBlob,
} from './content.ts'
import {
  OneShotKey, randomDigits, Secret, systemEntropy, validatePoint, verifyLabeled, type Entropy, type Ephemeral,
  type RoleKey,
} from './crypto.ts'
import { decodeInner, encodeInner, HS_FAIL_FRAME, innerTypeOf } from './frames.ts'
import { deviceIdOf, houseIdOf, parseAdmitTicket } from './keys.ts'
import { RecordChannel, type RecordLimits } from './record.ts'
import { ownerOf, Session } from './session.ts'
import { houseConfirmOf, pair as TH, sasOf, th2 as TH2 } from './transcript.ts'

const highestSupported = (): number => Math.max(...SUPPORTED_VERSIONS)

// ---------------------------------------------------------------------------------------------------------------
// The access the device received from the machine
// ---------------------------------------------------------------------------------------------------------------

export type PairAccess =
  /** Typed code: R and S are the ASCII bytes of their six digits. */
  | { kind: 'code'; R: Bytes; S: Bytes; rv: Bytes }
  /** QR: R and S are 16 random bytes; the blob also pins the house and says which relay and version to use. */
  | { kind: 'qr'; R: Bytes; S: Bytes; rv: Bytes; houseId: Bytes; relayHost: string; maxVer: number }

export async function accessFromCode(input: string): Promise<PairAccess> {
  const { R, S } = parseTypedCode(input)
  return { kind: 'code', R, S, rv: await TH.rv(R) }
}

export async function accessFromQr(q: QrBlob): Promise<PairAccess> {
  return { kind: 'qr', R: q.R, S: q.S, rv: await TH.rv(q.R), houseId: q.houseId, relayHost: q.relayHost, maxVer: q.maxVer }
}

// ---------------------------------------------------------------------------------------------------------------
// Device side
// ---------------------------------------------------------------------------------------------------------------

export type DevicePairFailure =
  | 'hs-fail'
  | 'timeout'
  | 'route-closed'
  /** A frame that does not parse, is not expected in this state, or carries an invalid point. */
  | 'protocol'
  /** QR: the pub_H of P2 is not the house the blob pinned. Nothing was revealed. */
  | 'house-id-mismatch'
  /** P4 does not open or sig_H does not verify under the pub_H of P2. */
  | 'house-not-proven'
  /** PAIR_DONE does not carry the houseConfirm of the S the machine showed, or names another device or ticket. */
  | 'house-not-confirmed'
  /** The house closed the session before confirming. */
  | 'closed'
  | 'version-downgrade'

/** What the device persists (as `pending`) when the pairing concludes (spec 3.6). Never R, S, the SAS or Z. */
export interface PairResult {
  /** The whole pub_H: the pin of every later handshake. */
  pubH: Bytes
  houseId: Bytes
  deviceId: Bytes
  admitTicket: Bytes
  /** Hostile text. */
  houseName: string
  ver: number
  houseMaxVer: number
  pinnedVer: number
  houseNow: number
}

export type DevicePairEffect =
  | { t: 'send'; frame: Bytes }
  /** Shown only after sig_H verified. The person types these six digits on the machine. */
  | { t: 'show-sas'; sas: string }
  /** Persist `result`, then write the PAIR_ACK that follows in the same list. The session is `freshPair`. */
  | { t: 'paired'; session: Session; result: PairResult }
  /** The code is dead: ask the machine for a new one. The machine never retries by itself. */
  | { t: 'failed'; reason: DevicePairFailure }

export interface DevicePairingInit {
  access: PairAccess
  /** Fresh, non-extractable, one pair per house. */
  kD: RoleKey
  /** Fresh and different from K_D (E-2). */
  kA: RoleKey
  /** Declared name, up to 64 bytes of UTF-8. */
  name: string
  caps?: number
  nowMs: number
  /** Typed code only: the version to use. The QR path takes it from the blob, without attempts. */
  ver?: number
  deviceMaxVer?: number
  limits?: Partial<RecordLimits>
  /** Test-only seam (spec 11 Q22). */
  entropy?: Entropy
}

type DevicePairState = 'sent-p1' | 'sent-p3' | 'await-done' | 'done' | 'dead'

export class DevicePairing {
  readonly #serial = new Serial()
  readonly #init: DevicePairingInit
  readonly #ver: number
  readonly #deviceMaxVer: number
  readonly #hello: Bytes
  readonly #nD: Bytes
  readonly #th1: Bytes
  readonly #deadlineMs: number
  #state: DevicePairState = 'sent-p1'
  #eph: Ephemeral | undefined
  #S: Bytes | undefined
  #mid: { pubH: Bytes; houseId: Bytes; z: Secret; t5: Bytes; sas: Bytes; kH2d: OneShotKey } | undefined
  #end: { pubH: Bytes; houseId: Bytes; confirm: Bytes; session: Session } | undefined

  private constructor(init: DevicePairingInit, ver: number, deviceMaxVer: number, hello: Bytes, eph: Ephemeral, nD: Bytes, th1: Bytes) {
    this.#init = init
    this.#ver = ver
    this.#deviceMaxVer = deviceMaxVer
    this.#hello = hello
    this.#eph = eph
    this.#nD = nD
    this.#th1 = th1
    this.#S = concat(init.access.S)
    this.#deadlineMs = init.nowMs + HS_DEADLINE_MS
  }

  static async start(init: DevicePairingInit): Promise<{ pairing: DevicePairing; effects: DevicePairEffect[] }> {
    if (init.kD.role !== 'device' || init.kA.role !== 'admission') fail('bad-label', 'pairing takes K_D and K_A in their roles')
    if (equal(init.kD.pub, init.kA.pub)) fail('bad-label', 'K_A must not be K_D')
    const deviceMaxVer = init.deviceMaxVer ?? highestSupported()
    const ver = init.access.kind === 'qr' ? Math.min(init.access.maxVer, deviceMaxVer) : init.ver ?? highestSupported()
    if (!SUPPORTED_VERSIONS.includes(ver) || deviceMaxVer < ver) fail('bad-version', 'this build does not speak that version')
    const hello = encodeDeviceHello({ pubD: init.kD.pub, pubA: init.kA.pub, caps: init.caps ?? 0, name: init.name })
    const entropy = init.entropy ?? systemEntropy
    const eph = await entropy.ephemeral()
    const nD = entropy.random(32)
    // The commitment binds e_D, N_D and the whole DeviceHello before the house reveals anything (C-1.1).
    const commit = await TH.commit(eph.pub, nD, hello)
    const th1 = await TH.th1(await TH.th0(ver, SUITE), ver, SUITE, init.access.rv, commit)
    const pairing = new DevicePairing(init, ver, deviceMaxVer, hello, eph, nD, th1)
    return { pairing, effects: [{ t: 'send', frame: encodeInner({ type: 'P1', ver, suite: SUITE, rv: init.access.rv, commit }) }] }
  }

  get state(): DevicePairState { return this.#state }
  #over(): boolean { return this.#state === 'done' || this.#state === 'dead' }

  onFrame(frame: Uint8Array, nowMs: number): Promise<DevicePairEffect[]> {
    return this.#serial.run(async () => {
      if (this.#over()) return []
      try {
        if (this.#state === 'await-done') return await this.#onRecord(frame, nowMs)
        if (frame.length === 1 && innerTypeOf(frame) === 'HS_FAIL') return this.#fail('hs-fail')
        return this.#state === 'sent-p1' ? await this.#onP2(frame) : await this.#onP4(frame, nowMs)
      } catch (e) {
        if (!(e instanceof WireError) || e.code === 'self-test') throw e
        return this.#fail('protocol')
      }
    })
  }

  tick(nowMs: number): Promise<DevicePairEffect[]> {
    return this.#serial.run(async () => {
      if (this.#over()) return []
      if (this.#state !== 'await-done') return nowMs >= this.#deadlineMs ? this.#fail('timeout') : []
      const out = await this.#end!.session.tick(nowMs)
      return out.some(e => e.t === 'closed') ? this.#fail('timeout') : out.flatMap(e => (e.t === 'send' ? [e] : []))
    })
  }

  routeClosed(): Promise<DevicePairEffect[]> {
    return this.#serial.run(async () => (this.#over() ? [] : this.#fail('route-closed')))
  }

  #fail(reason: DevicePairFailure): DevicePairEffect[] {
    this.#state = 'dead'
    this.#eph = undefined
    this.#mid?.z.destroy()
    wipe(this.#S, this.#mid?.sas, this.#end?.confirm)
    this.#end?.session.drop(reason)
    this.#S = this.#mid = this.#end = undefined
    return [{ t: 'failed', reason }]
  }

  async #onP2(frame: Uint8Array): Promise<DevicePairEffect[]> {
    const f = decodeInner(frame)
    if (f.type !== 'P2') return this.#fail('protocol')
    const eph = this.#eph!
    if (equal(f.eH, eph.pub)) return this.#fail('protocol')
    await validatePoint(f.pubH)
    const houseId = await houseIdOf(f.pubH)
    const access = this.#init.access
    // QR: the blob pinned the house. A P2 from another key is abandoned before e_D or N_D are revealed.
    if (access.kind === 'qr' && !equal(houseId, access.houseId)) return this.#fail('house-id-mismatch')
    const z = await Secret.agree(eph.privateKey, f.eH)
    this.#eph = undefined
    const t2 = await TH2(this.#th1, f.eH, f.nH, f.pubH, houseId)
    const t3 = await TH.th3(t2, eph.pub, this.#nD)
    const kD2h = new OneShotKey(await z.aesKey(t3, 'k-hs-d2h', 'encrypt'))
    const kH2d = new OneShotKey(await z.aesKey(t3, 'k-hs-h2d', 'decrypt'))
    const t4 = await TH.th4(t3, this.#hello)
    const sas = await sasOf(z, t4)
    const sigD = await this.#init.kD.sign('device-pair', t4)
    const ct3 = await kD2h.seal(t3, concat(lp16(this.#hello), sigD))
    this.#mid = { pubH: f.pubH, houseId, z, t5: await TH.th5(t4, ct3), sas, kH2d }
    this.#state = 'sent-p3'
    return [{ t: 'send', frame: encodeInner({ type: 'P3', eD: eph.pub, nD: this.#nD, ct3 }) }]
  }

  async #onP4(frame: Uint8Array, nowMs: number): Promise<DevicePairEffect[]> {
    const f = decodeInner(frame)
    if (f.type !== 'P4') return this.#fail('protocol')
    const m = this.#mid!
    let sigH: Bytes
    try { sigH = await m.kH2d.open(m.t5, f.ct4) }
    catch (e) { if (e instanceof WireError && e.code === 'auth') return this.#fail('house-not-proven'); throw e }
    if (!(await verifyLabeled(m.pubH, 'house-pair', m.t5, sigH))) return this.#fail('house-not-proven')
    const t6 = await TH.th6(m.t5, f.ct4)
    const channel = new RecordChannel({
      role: 'device', sessionId: t6.slice(0, 16), startedMs: nowMs, limits: this.#init.limits,
      sendKey: await m.z.aesKey(t6, 'k-d2h', 'encrypt'), recvKey: await m.z.aesKey(t6, 'k-h2d', 'decrypt'),
    })
    // S enters exactly here: the value the house must send back to prove it is the machine the person is looking at.
    const confirm = await houseConfirmOf(m.z, t6, this.#S!)
    m.z.destroy()
    wipe(this.#S)
    this.#S = undefined
    const sas = String.fromCharCode(...m.sas)
    wipe(m.sas)
    this.#end = { pubH: m.pubH, houseId: m.houseId, confirm, session: new Session({ role: 'device', ver: this.#ver, channel, gate: 'await-pair-done', nowMs }) }
    this.#mid = undefined
    this.#state = 'await-done'
    return [{ t: 'show-sas', sas }]
  }

  async #onRecord(frame: Uint8Array, nowMs: number): Promise<DevicePairEffect[]> {
    const end = this.#end!
    const r = await ownerOf(end.session).receive(frame, nowMs)
    const closed = r.effects.find(e => e.t === 'closed')
    if (closed) return this.#fail(closed.t === 'closed' && closed.by === 'peer' ? 'closed' : 'protocol')
    const out: DevicePairEffect[] = r.effects.flatMap(e => (e.t === 'send' ? [e] : []))
    if (!r.control) return out
    const done = decodePairDone(r.control.content)
    const deviceId = await deviceIdOf(this.#init.kD.pub)
    const ticket = parseAdmitTicket(done.admitTicket)
    const confirmed = ctEqual(done.houseConfirm, end.confirm)
    const sameDevice = equal(done.deviceId, deviceId)
    const sameTicket = equal(ticket.houseId, end.houseId) && equal(ticket.pubA, this.#init.kA.pub)
    if (!confirmed || !sameDevice || !sameTicket || done.houseMaxVer < this.#ver) return this.#fail('house-not-confirmed')
    // E-1: pairing has no pin yet, so the downgrade is caught here, inside the session where it happened.
    if (Math.min(done.houseMaxVer, this.#deviceMaxVer) > this.#ver) {
      const sends = (await end.session.close(CLOSE.protocol, nowMs)).flatMap(e => (e.t === 'send' ? [e] : []))
      return [...sends, ...this.#fail('version-downgrade')]
    }
    ownerOf(end.session).open(true)
    const ack = await ownerOf(end.session).sendControl('PAIR_ACK', new Uint8Array(0))
    const result: PairResult = {
      pubH: end.pubH, houseId: end.houseId, deviceId, admitTicket: done.admitTicket, houseName: done.houseName,
      ver: this.#ver, houseMaxVer: done.houseMaxVer, houseNow: done.now,
      pinnedVer: Math.max(this.#ver, Math.min(done.houseMaxVer, this.#deviceMaxVer)),
    }
    wipe(end.confirm)
    this.#end = undefined
    this.#state = 'done'
    return [...out, { t: 'paired', session: end.session, result }, { t: 'send', frame: ack }]
  }
}

// ---------------------------------------------------------------------------------------------------------------
// House side
// ---------------------------------------------------------------------------------------------------------------

/** PAIR_LOCKOUT: five failed ceremonies within 60 minutes block new pairings for 60 minutes. */
export class PairLockout {
  #failures: number[] = []
  #blockedUntilMs = 0

  recordFailure(nowMs: number): void {
    this.#failures = this.#failures.filter(t => nowMs - t < PAIR_LOCKOUT_WINDOW_MS)
    this.#failures.push(nowMs)
    if (this.#failures.length >= PAIR_LOCKOUT_FAILURES) this.#blockedUntilMs = nowMs + PAIR_LOCKOUT_BLOCK_MS
  }

  /** The instant the block ends, or undefined when pairing is allowed. */
  blockedUntil(nowMs: number): number | undefined { return nowMs < this.#blockedUntilMs ? this.#blockedUntilMs : undefined }
  get recentFailures(): number { return this.#failures.length }
}

export type PairState = 'open' | 'revealed' | 'waiting-sas' | 'confirmed' | 'done' | 'burned'

export type BurnReason =
  | 'expired' // PAIR_TTL passed without a P1
  | 'collision' // a second P1 while one was in course
  | 'reveal-mismatch' // P3 does not open the commitment of P1
  | 'key-reuse' // pub_A = pub_D
  | 'protocol' // a frame that does not parse, an invalid point, a signature that does not verify
  | 'p3-timeout' // HS_DEADLINE between P1 and P3
  | 'sas-wrong' // PAIR_SAS_TRIES wrong entries
  | 'sas-window' // PAIR_SAS_WINDOW passed
  | 'no-ack' // no PAIR_ACK within 30 s of PAIR_DONE
  | 'route-closed'
  | 'cancelled'

/** What the screen may say about the device while it asks for the SAS. A declared name is never an identity. */
export interface PendingDevice { deviceId: Bytes; declaredName: string; caps: number; access: 'code' | 'qr' }

/** What the house writes to its registry when the SAS matches (spec 3.6). */
export interface PairedDevice extends PendingDevice { pubD: Bytes; pubA: Bytes; name: string; ver: number }

export type HousePairEffect =
  | { t: 'send'; route: number; frame: Bytes }
  | { t: 'close'; route: number; reason: string }
  /** P3 verified and P4 sent: ask the person for the six digits the device shows. The SAS itself is never here. */
  | { t: 'await-sas'; device: PendingDevice }
  | { t: 'sas-wrong'; triesLeft: number }
  /** The SAS matched. Write the device to the registry, issue its first admission ticket, then call `confirm`. */
  | { t: 'sas-ok'; device: PairedDevice }
  /** The ticket is dead. `eraseDeviceId` names a device already handed out by `sas-ok` that must be erased. */
  | { t: 'burned'; reason: BurnReason; countsForLockout: boolean; eraseDeviceId?: Bytes }
  /** PAIR_ACK arrived. The route now belongs to `session`, a normal session marked `freshPair`. */
  | { t: 'done'; route: number; session: Session; deviceId: Bytes }

export interface HousePairingInit {
  kH: RoleKey
  lockout: PairLockout
  nowMs: number
  houseMaxVer?: number
  limits?: Partial<RecordLimits>
  /** Test-only seam (spec 11 Q22). */
  entropy?: Entropy
}

interface Active {
  route: number
  access: 'code' | 'qr'
  ver: number
  commit: Bytes
  eph?: Ephemeral
  t2: Bytes
  z?: Secret
  t6?: Bytes
  session?: Session
  device?: PairedDevice
}

/**
 * One pairing ticket of the house. It lives only in memory and dies with the process: a restarted portal knows no
 * ticket, so a used code never becomes valid again. There is no way to serialise it.
 */
export class HousePairing {
  readonly #serial = new Serial()
  readonly #init: HousePairingInit
  readonly #createdMs: number
  /** How the house names the ticket on screen and in the audit. It never goes to the wire. */
  readonly pairId: Bytes
  readonly rvCode: Bytes
  readonly rvQr: Bytes
  readonly #codeR: Bytes
  readonly #qrR: Bytes
  #codeS: Bytes | undefined
  #qrS: Bytes | undefined
  #state: PairState = 'open'
  #p2Sent = false
  #active: Active | undefined
  #doneRoute: number | undefined
  #sas: Bytes | undefined
  #tries = 0
  #hsDeadlineMs = 0
  #sasDeadlineMs = 0
  #ackDeadlineMs: number | undefined

  private constructor(init: HousePairingInit, v: { pairId: Bytes; codeR: Bytes; codeS: Bytes; qrR: Bytes; qrS: Bytes; rvCode: Bytes; rvQr: Bytes }) {
    this.#init = init
    this.#createdMs = init.nowMs
    this.pairId = v.pairId
    this.#codeR = v.codeR
    this.#codeS = v.codeS
    this.#qrR = v.qrR
    this.#qrS = v.qrS
    this.rvCode = v.rvCode
    this.rvQr = v.rvQr
  }

  /** Creates a ticket with its two accesses. Refused while PAIR_LOCKOUT blocks pairing. */
  static async create(init: HousePairingInit): Promise<HousePairing> {
    if (init.kH.role !== 'house') fail('bad-label', 'the house pairs with K_H')
    if (init.lockout.blockedUntil(init.nowMs) !== undefined) fail('locked', 'pairing is blocked by PAIR_LOCKOUT')
    const entropy = init.entropy ?? systemEntropy
    const pairId = entropy.random(16)
    const codeR = randomDigits(PAIR_CODE_DIGITS, entropy)
    const codeS = randomDigits(PAIR_CODE_DIGITS, entropy)
    const qrR = entropy.random(16)
    const qrS = entropy.random(16)
    return new HousePairing(init, { pairId, codeR, codeS, qrR, qrS, rvCode: await TH.rv(codeR), rvQr: await TH.rv(qrR) })
  }

  get state(): PairState { return this.#state }
  get expiresAtMs(): number { return this.#createdMs + PAIR_TTL_MS }

  /** The 12 digits the machine shows, `123 456 789 012`. Secret: it goes only to the screen that asked for it. */
  code(): string {
    if (this.#state !== 'open' || !this.#codeS) fail('bad-state', 'the code is shown only while the ticket is open')
    return formatTypedCode(this.#codeR, this.#codeS)
  }

  /** The QR blob. Secret, like the code. */
  async qr(relayHost: string): Promise<QrBlob> {
    if (this.#state !== 'open' || !this.#qrS) fail('bad-state', 'the QR is shown only while the ticket is open')
    return {
      maxVer: this.#init.houseMaxVer ?? highestSupported(), relayHost, houseId: await houseIdOf(this.#init.kH.pub),
      R: concat(this.#qrR), S: concat(this.#qrS),
    }
  }

  /** Feeds one inner frame that arrived on a route opened by pairing. */
  onFrame(route: number, frame: Uint8Array, nowMs: number): Promise<HousePairEffect[]> {
    return this.#serial.run(async () => {
      if (route === this.#doneRoute) return []
      const mine = this.#active?.route === route
      try {
        if (!mine) return await this.#onP1(route, frame, nowMs)
        return this.#state === 'revealed' ? await this.#onP3(frame, nowMs) : await this.#onRecord(frame, nowMs)
      } catch (e) {
        if (!(e instanceof WireError) || e.code === 'self-test') throw e
        return mine ? this.#burn('protocol', nowMs) : [{ t: 'close', route, reason: `refused: ${e.code}` }]
      }
    })
  }

  /** The six digits the person typed on the machine. Compared in constant time; the third wrong entry burns. */
  submitSas(input: string, nowMs: number): Promise<HousePairEffect[]> {
    return this.#serial.run(async () => {
      const a = this.#active
      if (this.#state !== 'waiting-sas' || !a?.device || !this.#sas) return fail('bad-state', 'no pairing is waiting for the SAS')
      if (nowMs > this.#sasDeadlineMs) return this.#burn('sas-window', nowMs)
      const digits = input.replace(/[ -]/g, '')
      const typed = /^[0-9]{6}$/.test(digits) ? ascii(digits) : new Uint8Array(6)
      const ok = ctEqual(typed, this.#sas)
      wipe(typed)
      if (!ok) {
        this.#tries++
        if (this.#tries >= PAIR_SAS_TRIES) return this.#burn('sas-wrong', nowMs)
        return [{ t: 'sas-wrong', triesLeft: PAIR_SAS_TRIES - this.#tries }]
      }
      wipe(this.#sas)
      this.#sas = undefined
      this.#state = 'confirmed'
      return [{ t: 'sas-ok', device: a.device }]
    })
  }

  /**
   * After `sas-ok`, with the device written to the registry and its first ticket issued: sends PAIR_DONE, with the
   * houseConfirm that only the holder of S can compute. PAIR_ACK is then awaited for 30 s.
   */
  confirm(o: { admitTicket: Uint8Array; houseName: string; nowMs: number }): Promise<HousePairEffect[]> {
    return this.#serial.run(async () => {
      const a = this.#active
      if (this.#state !== 'confirmed' || !a?.device || !a.z || !a.t6 || !a.session || this.#ackDeadlineMs !== undefined) {
        return fail('bad-state', 'confirm follows sas-ok, once')
      }
      const ticket = parseAdmitTicket(o.admitTicket)
      if (!equal(ticket.pubA, a.device.pubA) || !equal(ticket.houseId, await houseIdOf(this.#init.kH.pub))) {
        fail('bad-label', 'the ticket is not for the pub_A of this device in this house')
      }
      const S = a.access === 'code' ? this.#codeS! : this.#qrS!
      const houseConfirm = await houseConfirmOf(a.z, a.t6, S)
      a.z.destroy()
      a.z = undefined
      this.#wipeSecrets()
      const frame = await ownerOf(a.session).sendControl('PAIR_DONE', encodePairDone({
        houseMaxVer: this.#init.houseMaxVer ?? highestSupported(), now: Math.floor(o.nowMs / 1000), houseConfirm,
        deviceId: a.device.deviceId, admitTicket: concat(o.admitTicket), houseName: o.houseName,
      }))
      ownerOf(a.session).allowAck()
      this.#ackDeadlineMs = o.nowMs + PAIR_ACK_WAIT_MS
      return [{ t: 'send', route: a.route, frame }]
    })
  }

  /** Lets time pass: PAIR_TTL, the P1-to-P3 deadline, PAIR_SAS_WINDOW, the PAIR_ACK wait, and the heartbeat. */
  tick(nowMs: number): Promise<HousePairEffect[]> {
    return this.#serial.run(async () => {
      const a = this.#active
      switch (this.#state) {
        case 'open': return nowMs - this.#createdMs > PAIR_TTL_MS ? this.#burn('expired', nowMs) : []
        case 'revealed': return nowMs >= this.#hsDeadlineMs ? this.#burn('p3-timeout', nowMs) : []
        case 'waiting-sas':
          if (nowMs > this.#sasDeadlineMs) return this.#burn('sas-window', nowMs)
          break
        case 'confirmed':
          if (this.#ackDeadlineMs !== undefined && nowMs >= this.#ackDeadlineMs) return this.#burn('no-ack', nowMs)
          break
        default: return []
      }
      const out = await a!.session!.tick(nowMs)
      if (out.some(e => e.t === 'closed')) return this.#burn('route-closed', nowMs)
      return out.flatMap(e => (e.t === 'send' ? [{ t: 'send' as const, route: a!.route, frame: e.frame }] : []))
    })
  }

  /** The relay closed a route. If it was the one in course, the ceremony failed. */
  routeClosed(route: number, nowMs: number): Promise<HousePairEffect[]> {
    return this.#serial.run(async () => {
      if (this.#active?.route !== route) return []
      return this.#burn('route-closed', nowMs, true)
    })
  }

  /** The person gave up, or the relay said the meeting point is taken and another code will be drawn. */
  cancel(nowMs: number): Promise<HousePairEffect[]> {
    return this.#serial.run(async () => (this.#state === 'done' || this.#state === 'burned' ? [] : this.#burn('cancelled', nowMs)))
  }

  // -- internals ---------------------------------------------------------------------------------------------------

  #wipeSecrets(): void {
    wipe(this.#codeS, this.#qrS, this.#sas)
    this.#codeS = this.#qrS = this.#sas = undefined
  }

  #reject(route: number, reason: string): HousePairEffect[] {
    return [{ t: 'send', route, frame: HS_FAIL_FRAME() }, { t: 'close', route, reason }]
  }

  /** Every ceremony that fails after P2 counts for PAIR_LOCKOUT (spec 3.4). */
  #burn(reason: BurnReason, nowMs: number, routeGone = false): HousePairEffect[] {
    const out: HousePairEffect[] = []
    const a = this.#active
    if (a && !routeGone) {
      if (this.#state === 'revealed') out.push({ t: 'send', route: a.route, frame: HS_FAIL_FRAME() })
      out.push({ t: 'close', route: a.route, reason: `pairing burned: ${reason}` })
    }
    const eraseDeviceId = this.#state === 'confirmed' ? a?.device?.deviceId : undefined
    a?.z?.destroy()
    a?.session?.drop(reason)
    this.#wipeSecrets()
    this.#active = undefined
    this.#state = 'burned'
    const countsForLockout = this.#p2Sent
    if (countsForLockout) this.#init.lockout.recordFailure(nowMs)
    out.push(eraseDeviceId ? { t: 'burned', reason, countsForLockout, eraseDeviceId } : { t: 'burned', reason, countsForLockout })
    return out
  }

  async #onP1(route: number, frame: Uint8Array, nowMs: number): Promise<HousePairEffect[]> {
    if (innerTypeOf(frame) !== 'P1') return [{ t: 'close', route, reason: 'a route opened by pairing accepts only P1' }]
    const f = decodeInner(frame)
    if (f.type !== 'P1') return [{ t: 'close', route, reason: 'a route opened by pairing accepts only P1' }]
    if (!SUPPORTED_VERSIONS.includes(f.ver) || f.suite !== SUITE) return this.#reject(route, 'version or suite not spoken')
    // The ticket is found by the rv of P1 itself; the relay's hint is never used for this.
    const access = equal(f.rv, this.rvCode) ? 'code' : equal(f.rv, this.rvQr) ? 'qr' : undefined
    if (!access) return this.#reject(route, 'no such ticket')
    switch (this.#state) {
      case 'open': break
      // A second P1 while one is in course: no second chance inside the same ticket (C-1.3).
      case 'revealed': case 'waiting-sas': return [...this.#reject(route, 'collision'), ...this.#burn('collision', nowMs)]
      default: return this.#reject(route, 'ticket not open')
    }
    if (nowMs - this.#createdMs > PAIR_TTL_MS) return [...this.#reject(route, 'ticket expired'), ...this.#burn('expired', nowMs)]
    const entropy = this.#init.entropy ?? systemEntropy
    const kH = this.#init.kH
    // The ticket is marked revealed before anything is produced: (e_H, N_H) leave this house once per ticket.
    this.#state = 'revealed'
    this.#p2Sent = true
    this.#hsDeadlineMs = nowMs + HS_DEADLINE_MS
    const pending: Active = { route, access, ver: f.ver, commit: f.commit, t2: new Uint8Array(0) }
    this.#active = pending
    const eph = await entropy.ephemeral()
    const nH = entropy.random(32)
    const t1 = await TH.th1(await TH.th0(f.ver, SUITE), f.ver, SUITE, f.rv, f.commit)
    pending.eph = eph
    pending.t2 = await TH2(t1, eph.pub, nH, kH.pub, await houseIdOf(kH.pub))
    return [{ t: 'send', route, frame: encodeInner({ type: 'P2', eH: eph.pub, nH, pubH: kH.pub }) }]
  }

  async #onP3(frame: Uint8Array, nowMs: number): Promise<HousePairEffect[]> {
    const a = this.#active!
    if (innerTypeOf(frame) !== 'P3') return this.#burn('protocol', nowMs)
    const f = decodeInner(frame)
    if (f.type !== 'P3' || !a.eph) return this.#burn('protocol', nowMs)
    if (equal(f.eD, a.eph.pub)) return this.#burn('protocol', nowMs)
    const z = await Secret.agree(a.eph.privateKey, f.eD)
    a.eph = undefined
    a.z = z
    const t3 = await TH.th3(a.t2, f.eD, f.nD)
    const kD2h = new OneShotKey(await z.aesKey(t3, 'k-hs-d2h', 'decrypt'))
    const kH2d = new OneShotKey(await z.aesKey(t3, 'k-hs-h2d', 'encrypt'))
    const r = new Reader(await kD2h.open(t3, f.ct3))
    const helloBytes = r.lp16()
    const sigD = r.take(64)
    r.end()
    const hello = decodeDeviceHello(helloBytes)
    // The reveal must open the commitment of P1: nobody chooses their part after seeing the other's (C-1.1).
    if (!ctEqual(await TH.commit(f.eD, f.nD, helloBytes), a.commit)) return this.#burn('reveal-mismatch', nowMs)
    await validatePoint(hello.pubD)
    await validatePoint(hello.pubA)
    if (equal(hello.pubA, hello.pubD)) return this.#burn('key-reuse', nowMs)
    const t4 = await TH.th4(t3, helloBytes)
    if (!(await verifyLabeled(hello.pubD, 'device-pair', t4, sigD))) return this.#burn('protocol', nowMs)
    this.#sas = await sasOf(z, t4)
    const t5 = await TH.th5(t4, f.ct3)
    const ct4 = await kH2d.seal(t5, await this.#init.kH.sign('house-pair', t5))
    const t6 = await TH.th6(t5, ct4)
    const channel = new RecordChannel({
      role: 'house', sessionId: t6.slice(0, 16), startedMs: nowMs, limits: this.#init.limits,
      sendKey: await z.aesKey(t6, 'k-h2d', 'encrypt'), recvKey: await z.aesKey(t6, 'k-d2h', 'decrypt'),
    })
    a.t6 = t6
    a.session = new Session({ role: 'house', ver: a.ver, channel, gate: 'await-pair-ack', nowMs })
    const pending: PendingDevice = {
      deviceId: await deviceIdOf(hello.pubD), declaredName: sanitizeDeclaredName(hello.name), caps: hello.caps, access: a.access,
    }
    a.device = { ...pending, pubD: hello.pubD, pubA: hello.pubA, name: hello.name, ver: a.ver }
    this.#state = 'waiting-sas'
    this.#tries = 0
    this.#sasDeadlineMs = nowMs + PAIR_SAS_WINDOW_MS
    return [{ t: 'send', route: a.route, frame: encodeInner({ type: 'P4', ct4 }) }, { t: 'await-sas', device: pending }]
  }

  /** After P4 only heartbeats and CLOSE are accepted, until the PAIR_ACK that answers PAIR_DONE. Anything else burns. */
  async #onRecord(frame: Uint8Array, nowMs: number): Promise<HousePairEffect[]> {
    const a = this.#active!
    const r = await ownerOf(a.session!).receive(frame, nowMs)
    if (r.effects.some(e => e.t === 'closed')) return this.#burn(r.effects.some(e => e.t === 'closed' && e.by === 'peer') ? 'route-closed' : 'protocol', nowMs)
    const out: HousePairEffect[] = r.effects.flatMap(e => (e.t === 'send' ? [{ t: 'send' as const, route: a.route, frame: e.frame }] : []))
    if (!r.control) return out
    if (r.control.content.length !== 0) return this.#burn('protocol', nowMs)
    ownerOf(a.session!).open(true)
    this.#state = 'done'
    this.#doneRoute = a.route
    this.#active = undefined
    this.#wipeSecrets()
    return [...out, { t: 'done', route: a.route, session: a.session!, deviceId: a.device!.deviceId }]
  }
}
