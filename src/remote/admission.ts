// Admission at the relay (spec 5): the house proves its relay key, the device proves possession of the admission key
// of its ticket, and the relay verifies both. The relay stays blind: what it learns is houseId, ticketId and pub_A
// (a pseudonym that changes at every renewal), never deviceId, pub_D, names or content.
import { concat, equal, fail, toHex, WireError, type Bytes } from './bytes.ts'
import { ADMIT_TTL_S, CERT_ROLE_RELAY, CERT_ROLE_TICKET, CLOCK_SKEW_S, DENY_MAX } from './constants.ts'
import {
  ADMIT_BODY_FIXED, isValidPoint, SELF_TEST_POINTS, systemEntropy, verifyLabeled, type Entropy, type RoleKey,
} from './crypto.ts'
import { encodeOuter, NOTICE, type DenyEntry, type OuterFrame } from './frames.ts'
import {
  certLiveAt, houseIdOf, houseKeysDistinct, keyIdOf, parseAdmitTicket, relayAuthBody, relayPopBody, verifyKeyCert,
  type AdmitTicket,
} from './keys.ts'

type Frame<T extends OuterFrame['type']> = Extract<OuterFrame, { type: T }>

// ---------------------------------------------------------------------------------------------------------------
// The house proves its key (spec 5.1)
// ---------------------------------------------------------------------------------------------------------------

/**
 * The house answers R_CHALLENGE. K_R signs only this body: the one value from outside is `r`, exactly 32 bytes,
 * fenced by the label, the `aud` the house itself configured, its houseId and a random of its own. A challenge of
 * any other size closes without signing anything (C-2.2).
 */
export async function buildHouseAuth(o: {
  r: Uint8Array; aud: string; pubH: Uint8Array; certR: Uint8Array; certsT: readonly Uint8Array[]; kR: RoleKey
  nowS: number; entropy?: Entropy
}): Promise<Bytes> {
  if (o.r.length !== 32) fail('malformed', 'the relay challenge must be 32 bytes')
  if (o.kR.role !== 'relay') fail('bad-label', 'relay-auth is signed by K_R')
  const c = (o.entropy ?? systemEntropy).random(32)
  const sigR = await o.kR.sign('relay-auth', relayAuthBody(o.aud, await houseIdOf(o.pubH), o.r, c, o.nowS))
  return encodeOuter({
    type: 'H_AUTH', pubH: concat(o.pubH), certR: concat(o.certR), certsT: o.certsT.map(x => concat(x)), c, ts: o.nowS, sigR,
  })
}

/** What the relay keeps, in memory only, about an authenticated house. */
export interface RelayHouse {
  houseId: Bytes
  pubH: Bytes
  /** The ticket keys this house registered in H_AUTH (one or two), each with the window of its certificate. */
  ticketKeys: { ktId: Bytes; pub: Bytes; notBefore: number; notAfter: number }[]
}

export type HouseAuthFailure = 'point' | 'keys-not-distinct' | 'cert-relay' | 'cert-ticket' | 'time' | 'signature'

/**
 * What the relay checks of H_AUTH (spec 5.1 step 3, 11 Q20). `r` is the challenge this relay sent on this socket and
 * `aud` is the relay's own configured identity. The reason is for the relay's counters only: the house gets the one
 * constant R_AUTH_FAIL.
 */
export async function verifyHouseAuth(o: { auth: Frame<'H_AUTH'>; r: Uint8Array; aud: string; nowS: number }): Promise<
  { ok: true; house: RelayHouse } | { ok: false; reason: HouseAuthFailure }
> {
  const { auth, nowS } = o
  if (!(await isValidPoint(auth.pubH))) return { ok: false, reason: 'point' }
  const houseId = await houseIdOf(auth.pubH)
  const certR = await verifyKeyCert(auth.certR, auth.pubH, CERT_ROLE_RELAY, nowS)
  if (!certR.ok) return { ok: false, reason: 'cert-relay' }
  const ticketKeys: RelayHouse['ticketKeys'] = []
  for (const raw of auth.certsT) {
    const c = await verifyKeyCert(raw, auth.pubH, CERT_ROLE_TICKET, nowS)
    if (!c.ok) return { ok: false, reason: 'cert-ticket' }
    ticketKeys.push({ ktId: await keyIdOf(c.cert.pub), pub: c.cert.pub, notBefore: c.cert.notBefore, notAfter: c.cert.notAfter })
  }
  if (!houseKeysDistinct(auth.pubH, certR.cert.pub, ticketKeys.map(k => k.pub))) return { ok: false, reason: 'keys-not-distinct' }
  if (Math.abs(auth.ts - nowS) > 2 * CLOCK_SKEW_S) return { ok: false, reason: 'time' }
  let body: Bytes
  try { body = relayAuthBody(o.aud, houseId, o.r, auth.c, auth.ts) }
  catch (e) { if (e instanceof WireError) return { ok: false, reason: 'signature' }; throw e }
  if (!(await verifyLabeled(certR.cert.pub, 'relay-auth', body, auth.sigR))) return { ok: false, reason: 'signature' }
  return { ok: true, house: { houseId, pubH: concat(auth.pubH), ticketKeys } }
}

// ---------------------------------------------------------------------------------------------------------------
// The deny list (spec 5.6, E-6, 11 Q13)
// ---------------------------------------------------------------------------------------------------------------

/**
 * `ticketId → exp` of one house at the relay. H_DENY is additive; a frame that would take the list above DENY_MAX is
 * refused whole, with R_NOTICE 0x02; an entry is pruned once `now > exp + CLOCK_SKEW`.
 */
export class DenyList {
  readonly #entries = new Map<string, number>()

  get size(): number { return this.#entries.size }

  prune(nowS: number): void {
    for (const [id, exp] of this.#entries) if (nowS > exp + CLOCK_SKEW_S) this.#entries.delete(id)
  }

  apply(deny: { entries: readonly DenyEntry[]; overflow: boolean }, nowS: number): { ok: true } | { ok: false; notice: typeof NOTICE.limit } {
    if (deny.overflow) return { ok: false, notice: NOTICE.limit }
    this.prune(nowS)
    const incoming = new Map<string, number>()
    for (const e of deny.entries) {
      if (e.ticketId.length !== 16) fail('malformed', 'ticketId must be 16 bytes')
      if (nowS > e.exp + CLOCK_SKEW_S) continue
      const id = toHex(e.ticketId)
      incoming.set(id, Math.max(e.exp, incoming.get(id) ?? 0))
    }
    let added = 0
    for (const id of incoming.keys()) if (!this.#entries.has(id)) added++
    if (this.#entries.size + added > DENY_MAX) return { ok: false, notice: NOTICE.limit }
    for (const [id, exp] of incoming) this.#entries.set(id, Math.max(exp, this.#entries.get(id) ?? 0))
    return { ok: true }
  }

  has(ticketId: Uint8Array): boolean { return this.#entries.has(toHex(ticketId)) }
}

// ---------------------------------------------------------------------------------------------------------------
// The device is admitted (spec 5.2)
// ---------------------------------------------------------------------------------------------------------------

/**
 * The device answers R_HELLO. The ticket is not a bearer token: without the private half of K_A it admits nobody.
 * `aud` is what the device has stored, never what the relay says.
 */
export async function buildDeviceAdmit(o: {
  ticket: Uint8Array; aud: string; nR: Uint8Array; kA: RoleKey; entropy?: Entropy
}): Promise<Bytes> {
  if (o.nR.length !== 32) fail('malformed', 'n_R must be 32 bytes')
  if (o.kA.role !== 'admission') fail('bad-label', 'relay-pop is signed by K_A')
  const t = parseAdmitTicket(o.ticket)
  if (!equal(t.pubA, o.kA.pub)) fail('bad-label', 'the ticket is for another admission key')
  const nD = (o.entropy ?? systemEntropy).random(32)
  const sigA = await o.kA.sign('relay-pop', relayPopBody(o.aud, t.houseId, t.ticketId, o.nR, nD))
  return encodeOuter({ type: 'D_ADMIT', houseId: t.houseId, ticket: concat(o.ticket), nD, sigA })
}

export type AdmitCheck =
  | 'ticket' // the ticket parses
  | 'house-id' // houseId of the frame equals the one in the ticket
  | 'house-online' // that house is connected to this relay
  | 'ticket-key' // ktId is one of the ticket keys this house registered
  | 'cert-live' // the certificate of that K_T is valid now
  | 'within-cert' // exp of the ticket is not beyond notAfter of that certificate
  | 'sig-t' // the ticket is signed by that K_T
  | 'aud' // the ticket is for this relay
  | 'window' // the ticket is inside its time window, with CLOCK_SKEW
  | 'duration' // the ticket does not last more than ADMIT_TTL
  | 'not-denied' // ticketId is not in the deny list
  | 'sig-a' // the proof of possession verifies under the pub_A of the ticket

export type AdmitVerdict =
  | { ok: true; houseId: Bytes; ticketId: Bytes; pubA: Bytes; exp: number }
  /** `failed` is for the relay's counters and tests only. The device always gets the same R_FAIL (spec 5.3). */
  | { ok: false; failed: AdmitCheck[] }

/**
 * What the relay checks of D_ADMIT: everything, with no early exit (spec 5.2 step 3). Both signatures are verified
 * even when an earlier check already failed, against a dummy key when the real one is not known. `house` is the
 * entry of the houseId named in the frame, or undefined when that house is not connected; `nR` is the nonce this
 * relay sent on this socket; `aud` is the relay's own identity. Limits are the relay's to apply.
 */
export async function verifyDeviceAdmit(o: {
  admit: Frame<'D_ADMIT'>; nR: Uint8Array; aud: string; nowS: number; house: RelayHouse | undefined; deny: DenyList | undefined
}): Promise<AdmitVerdict> {
  const failed: AdmitCheck[] = []
  const check = (name: AdmitCheck, ok: boolean): void => { if (!ok) failed.push(name) }
  const t = tryParseTicket(o.admit.ticket)
  check('ticket', t !== undefined)
  check('house-id', t !== undefined && equal(o.admit.houseId, t.houseId))
  check('house-online', o.house !== undefined && equal(o.house.houseId, o.admit.houseId))
  const key = t && o.house ? o.house.ticketKeys.find(k => equal(k.ktId, t.ktId)) : undefined
  check('ticket-key', key !== undefined)
  check('cert-live', key !== undefined && certLiveAt(key, o.nowS))
  check('within-cert', key !== undefined && t !== undefined && t.exp <= key.notAfter)
  // A dummy key and well-formed dummy bodies keep both verifications running when the real inputs are missing.
  const dummyKey = SELF_TEST_POINTS.valid()
  const dummyTicketBody = concat(new Uint8Array(ADMIT_BODY_FIXED), Uint8Array.of(1, 0x78))
  const sigT = await verifyLabeled(key?.pub ?? dummyKey, 'relay-admit', t?.body ?? dummyTicketBody, t?.sig ?? new Uint8Array(64))
  check('sig-t', sigT && key !== undefined && t !== undefined)
  check('aud', t !== undefined && t.aud === o.aud)
  check('window', t !== undefined && certLiveAt({ notBefore: t.notBefore, notAfter: t.exp }, o.nowS))
  check('duration', t !== undefined && t.exp - t.notBefore <= ADMIT_TTL_S)
  check('not-denied', t !== undefined && !(o.deny?.has(t.ticketId) ?? false))
  const pop = tryPopBody(o.aud, t?.houseId ?? new Uint8Array(32), t?.ticketId ?? new Uint8Array(16), o.nR, o.admit.nD)
  const sigA = await verifyLabeled(t?.pubA ?? dummyKey, 'relay-pop', pop ?? new Uint8Array(0), o.admit.sigA)
  check('sig-a', sigA && pop !== undefined && t !== undefined)
  if (failed.length > 0 || !t) return { ok: false, failed }
  return { ok: true, houseId: t.houseId, ticketId: t.ticketId, pubA: t.pubA, exp: t.exp }
}

function tryParseTicket(ticket: Uint8Array): AdmitTicket | undefined {
  try { return parseAdmitTicket(ticket) }
  catch (e) { if (e instanceof WireError) return undefined; throw e }
}

function tryPopBody(aud: string, houseId: Uint8Array, ticketId: Uint8Array, nR: Uint8Array, nD: Uint8Array): Bytes | undefined {
  try { return relayPopBody(aud, houseId, ticketId, nR, nD) }
  catch (e) { if (e instanceof WireError) return undefined; throw e }
}

// ---------------------------------------------------------------------------------------------------------------
// Renewal (spec 5.5, E-2)
// ---------------------------------------------------------------------------------------------------------------

/**
 * The house accepts a new admission key only if it is a valid point that is not pub_D and was never an admission key
 * of this device. `usedKeyIds` are the `keyId(pub_A)` the registry keeps for the device, the current one included.
 */
export async function admitRenewKeyAllowed(pubANew: Uint8Array, pubD: Uint8Array, usedKeyIds: readonly Uint8Array[]): Promise<boolean> {
  if (!(await isValidPoint(pubANew)) || equal(pubANew, pubD)) return false
  const id = await keyIdOf(pubANew)
  return !usedKeyIds.some(k => equal(k, id))
}
