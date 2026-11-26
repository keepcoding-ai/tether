// Identifiers, key certificates, admission tickets and the key-rotation declaration (spec 1.2, 1.3, 5.1, 5.2, 6.4).
// Every signed structure is a fixed layout checked for its exact size before any signature is verified. All instants
// are Unix seconds (spec 11 Q5); validity windows tolerate CLOCK_SKEW on both ends (spec 11 Q14).
import { audBytes, audFromBytes } from './aud.ts'
import { base32, concat, equal, fail, lp16, lp8, Reader, u32, u64, u8, WireError, type Bytes } from './bytes.ts'
import {
  ADMIT_TTL_S, CERT_ROLE_RELAY, CERT_ROLE_TICKET, CLOCK_SKEW_S, KEY_ROTATE_MIN_OVERLAP_S, KEYCERT_TTL_R_S,
  KEYCERT_TTL_T_S, LBL,
} from './constants.ts'
import {
  hasPointShape, isValidPoint, sha256, systemEntropy, validatePoint, verifyLabeled, type Entropy, type RoleKey,
} from './crypto.ts'

// ---------------------------------------------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------------------------------------------

const idOf = async (label: 'house-id' | 'device-id' | 'key-id', pub: Uint8Array, n: number): Promise<Bytes> => {
  if (!hasPointShape(pub)) fail('bad-point', 'public key shape')
  return (await sha256(LBL(label), pub)).slice(0, n)
}

/** `houseId = H(LBL("house-id") ‖ pub_H)`, 32 bytes. */
export const houseIdOf = (pubH: Uint8Array): Promise<Bytes> => idOf('house-id', pubH, 32)
/** `deviceId = H(LBL("device-id") ‖ pub_D)[0..16]`. A lookup index, never an identity. */
export const deviceIdOf = (pubD: Uint8Array): Promise<Bytes> => idOf('device-id', pubD, 16)
/** `keyId(pub) = H(LBL("key-id") ‖ pub)[0..8]`. */
export const keyIdOf = (pub: Uint8Array): Promise<Bytes> => idOf('key-id', pub, 8)

/** The houseId as text: base32 lowercase without padding, 52 characters. */
export function houseIdText(houseId: Uint8Array): string {
  if (houseId.length !== 32) fail('malformed', 'houseId must be 32 bytes')
  return base32(houseId)
}

/** The fingerprint shown to the person: the first 20 characters of the text in groups of 4 (spec 11 Q7). */
export function houseFingerprint(houseId: Uint8Array): string {
  return houseIdText(houseId).slice(0, 20).replace(/(.{4})(?=.)/g, '$1 ')
}

const inWindow = (now: number, notBefore: number, notAfter: number): boolean =>
  notAfter > notBefore && now >= notBefore - CLOCK_SKEW_S && now <= notAfter + CLOCK_SKEW_S

// ---------------------------------------------------------------------------------------------------------------
// KeyCert = KeyCertBody(115) ‖ sig(64)
// KeyCertBody = 0x01 ‖ role(1) ‖ houseId(32) ‖ pub(65) ‖ u64(notBefore) ‖ u64(notAfter)
// ---------------------------------------------------------------------------------------------------------------

export type CertRole = typeof CERT_ROLE_RELAY | typeof CERT_ROLE_TICKET

export interface KeyCert {
  role: CertRole
  houseId: Bytes
  pub: Bytes
  notBefore: number
  notAfter: number
  body: Bytes
  sig: Bytes
}

const certTtl = (role: CertRole): number => (role === CERT_ROLE_RELAY ? KEYCERT_TTL_R_S : KEYCERT_TTL_T_S)

export function parseKeyCert(cert: Uint8Array): KeyCert {
  if (cert.length !== 179) fail('malformed', 'KeyCert must be 179 bytes')
  const r = new Reader(cert)
  if (r.u8() !== 0x01) fail('bad-version', 'KeyCert version')
  const role = r.u8()
  if (role !== CERT_ROLE_RELAY && role !== CERT_ROLE_TICKET) return fail('malformed', 'KeyCert role')
  const houseId = r.take(32)
  const pub = r.take(65)
  const notBefore = r.u64()
  const notAfter = r.u64()
  const sig = r.take(64)
  r.end()
  return { role, houseId, pub, notBefore, notAfter, body: cert.slice(0, 115), sig }
}

/** The house certifies K_R (role 0x01) or K_T (role 0x02) with K_H. The duration is capped by the role (E-5). */
export async function issueKeyCert(
  kH: RoleKey, c: { role: CertRole; pub: Uint8Array; notBefore: number; notAfter: number },
): Promise<Bytes> {
  if (c.role !== CERT_ROLE_RELAY && c.role !== CERT_ROLE_TICKET) fail('malformed', 'KeyCert role')
  if (c.notAfter <= c.notBefore || c.notAfter - c.notBefore > certTtl(c.role)) fail('range', 'KeyCert duration')
  await validatePoint(c.pub)
  if (equal(c.pub, kH.pub)) fail('bad-label', 'a certified key must not be the identity key')
  const body = concat(u8(0x01), u8(c.role), await houseIdOf(kH.pub), c.pub, u64(c.notBefore), u64(c.notAfter))
  return concat(body, await kH.sign('key-cert', body))
}

export type CertFailure = 'malformed' | 'role' | 'house' | 'window' | 'duration' | 'point' | 'signature'

/**
 * What the relay checks of each certificate (spec 5.1 step 3): role, houseId, validity with CLOCK_SKEW, duration
 * within the cap of the role, a valid point, and the signature by pub_H.
 */
export async function verifyKeyCert(
  cert: Uint8Array, pubH: Uint8Array, role: CertRole, now: number,
): Promise<{ ok: true; cert: KeyCert } | { ok: false; reason: CertFailure }> {
  let c: KeyCert
  try { c = parseKeyCert(cert) }
  catch (e) { if (e instanceof WireError) return { ok: false, reason: 'malformed' }; throw e }
  if (c.role !== role) return { ok: false, reason: 'role' }
  if (!equal(c.houseId, await houseIdOf(pubH))) return { ok: false, reason: 'house' }
  if (!inWindow(now, c.notBefore, c.notAfter)) return { ok: false, reason: 'window' }
  if (c.notAfter - c.notBefore > certTtl(role)) return { ok: false, reason: 'duration' }
  if (!(await isValidPoint(c.pub))) return { ok: false, reason: 'point' }
  if (!(await verifyLabeled(pubH, 'key-cert', c.body, c.sig))) return { ok: false, reason: 'signature' }
  return { ok: true, cert: c }
}

/** True when a certificate already accepted is still inside its window at `now` (checked again at each admission). */
export const certLiveAt = (c: { notBefore: number; notAfter: number }, now: number): boolean =>
  inWindow(now, c.notBefore, c.notAfter)

/**
 * One key, one role, for the house keys the relay sees (spec 11 Q20): pub_H, pub_R and every pub_T are pairwise
 * distinct. The relay applies it to H_AUTH and refuses when it fails.
 */
export function houseKeysDistinct(pubH: Uint8Array, pubR: Uint8Array, pubTs: readonly Uint8Array[]): boolean {
  const all = [pubH, pubR, ...pubTs]
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) if (equal(all[i]!, all[j]!)) return false
  return true
}

// ---------------------------------------------------------------------------------------------------------------
// relay-auth and relay-pop bodies
// ---------------------------------------------------------------------------------------------------------------

/** `lp8(aud) ‖ houseId ‖ r ‖ c ‖ u64(ts)`: the only body K_R signs. `r` is the one value that comes from outside. */
export function relayAuthBody(aud: string, houseId: Uint8Array, r: Uint8Array, c: Uint8Array, ts: number): Bytes {
  if (houseId.length !== 32 || r.length !== 32 || c.length !== 32) fail('malformed', 'relay-auth field size')
  return concat(lp8(audBytes(aud)), houseId, r, c, u64(ts))
}

/** `lp8(aud) ‖ houseId ‖ ticketId ‖ n_R ‖ n_D`: the only body K_A signs. */
export function relayPopBody(aud: string, houseId: Uint8Array, ticketId: Uint8Array, nR: Uint8Array, nD: Uint8Array): Bytes {
  if (houseId.length !== 32 || ticketId.length !== 16 || nR.length !== 32 || nD.length !== 32) fail('malformed', 'relay-pop field size')
  return concat(lp8(audBytes(aud)), houseId, ticketId, nR, nD)
}

// ---------------------------------------------------------------------------------------------------------------
// AdmitTicket = lp16(AdmitTicketBody) ‖ sig_T(64)
// AdmitTicketBody = 0x01 ‖ houseId(32) ‖ ktId(8) ‖ ticketId(16) ‖ pub_A(65) ‖ u64(notBefore) ‖ u64(exp) ‖ lp8(aud)
// ---------------------------------------------------------------------------------------------------------------

export interface AdmitTicket {
  houseId: Bytes
  ktId: Bytes
  ticketId: Bytes
  pubA: Bytes
  notBefore: number
  exp: number
  aud: string
  body: Bytes
  sig: Bytes
}

/** Strict structure of a ticket. It does not verify the signature: the device cannot (it does not know pub_T). */
export function parseAdmitTicket(ticket: Uint8Array): AdmitTicket {
  const r = new Reader(ticket)
  const body = r.lp16()
  const sig = r.take(64)
  r.end()
  const b = new Reader(body)
  if (b.u8() !== 0x01) fail('bad-version', 'AdmitTicket version')
  const t: AdmitTicket = {
    houseId: b.take(32), ktId: b.take(8), ticketId: b.take(16), pubA: b.take(65), notBefore: b.u64(), exp: b.u64(),
    aud: audFromBytes(b.lp8()), body, sig,
  }
  b.end()
  if (!hasPointShape(t.pubA)) fail('bad-point', 'pub_A shape')
  return t
}

/**
 * The house issues an admission ticket for pub_A with K_T. The ticket never outlives ADMIT_TTL nor the certificate
 * of the K_T that signs it (E-5). It carries no deviceId, pub_D, name or scope.
 */
export async function issueAdmitTicket(
  kT: RoleKey,
  t: { certT: Uint8Array; pubA: Uint8Array; aud: string; notBefore: number; exp: number; entropy?: Entropy },
): Promise<Bytes> {
  const cert = parseKeyCert(t.certT)
  if (cert.role !== CERT_ROLE_TICKET || !equal(cert.pub, kT.pub)) fail('bad-label', 'the certificate is not of this ticket key')
  if (t.exp <= t.notBefore || t.exp - t.notBefore > ADMIT_TTL_S) fail('range', 'ticket duration above ADMIT_TTL')
  if (t.exp > cert.notAfter) fail('range', 'ticket beyond the certificate of its key')
  await validatePoint(t.pubA)
  const ticketId = (t.entropy ?? systemEntropy).random(16)
  const body = concat(
    u8(0x01), cert.houseId, await keyIdOf(kT.pub), ticketId, t.pubA, u64(t.notBefore), u64(t.exp), lp8(audBytes(t.aud)),
  )
  return concat(lp16(body), await kT.sign('relay-admit', body))
}

/** The time rules of a ticket taken alone: window with CLOCK_SKEW and duration within ADMIT_TTL. */
export const ticketTimeOk = (t: { notBefore: number; exp: number }, now: number): boolean =>
  inWindow(now, t.notBefore, t.exp) && t.exp - t.notBefore <= ADMIT_TTL_S

// ---------------------------------------------------------------------------------------------------------------
// KeyRotate (spec 6.4): verification only in this milestone
// KeyRotateBody = 0x01 ‖ oldHouseId(32) ‖ newPub(65) ‖ u32(seq) ‖ u64(issuedAt) ‖ u64(overlapUntil)   (118 bytes)
// ---------------------------------------------------------------------------------------------------------------

export interface KeyRotate { oldHouseId: Bytes; newPub: Bytes; seq: number; issuedAt: number; overlapUntil: number }

export function encodeKeyRotateBody(k: KeyRotate): Bytes {
  if (k.oldHouseId.length !== 32 || k.newPub.length !== 65) fail('malformed', 'KeyRotate field size')
  return concat(u8(0x01), k.oldHouseId, k.newPub, u32(k.seq), u64(k.issuedAt), u64(k.overlapUntil))
}

export function parseKeyRotateBody(body: Uint8Array): KeyRotate {
  if (body.length !== 118) fail('malformed', 'KeyRotateBody must be 118 bytes')
  const r = new Reader(body)
  if (r.u8() !== 0x01) fail('bad-version', 'KeyRotate version')
  const k: KeyRotate = { oldHouseId: r.take(32), newPub: r.take(65), seq: r.u32(), issuedAt: r.u64(), overlapUntil: r.u64() }
  r.end()
  return k
}

export type RotateFailure = 'malformed' | 'house' | 'seq' | 'overlap' | 'point' | 'same-key' | 'sig-old' | 'sig-new'

/**
 * What the device checks of a rotation declaration received inside a session authenticated by the old key:
 * oldHouseId equal to the pinned one, seq equal to its own seq + 1, an overlap of at least ADMIT_TTL + 1 day, a valid
 * new key different from the pinned one, the old key's signature and the new key's acceptance.
 */
export async function verifyKeyRotate(d: {
  body: Uint8Array; sigOld: Uint8Array; sigNew: Uint8Array; pinnedPubH: Uint8Array; currentSeq: number
}): Promise<{ ok: true; rotate: KeyRotate } | { ok: false; reason: RotateFailure }> {
  let k: KeyRotate
  try { k = parseKeyRotateBody(d.body) }
  catch (e) { if (e instanceof WireError) return { ok: false, reason: 'malformed' }; throw e }
  if (!equal(k.oldHouseId, await houseIdOf(d.pinnedPubH))) return { ok: false, reason: 'house' }
  if (k.seq !== d.currentSeq + 1) return { ok: false, reason: 'seq' }
  if (k.overlapUntil - k.issuedAt < KEY_ROTATE_MIN_OVERLAP_S) return { ok: false, reason: 'overlap' }
  if (!(await isValidPoint(k.newPub))) return { ok: false, reason: 'point' }
  if (equal(k.newPub, d.pinnedPubH)) return { ok: false, reason: 'same-key' }
  if (!(await verifyLabeled(d.pinnedPubH, 'key-rotate', d.body, d.sigOld))) return { ok: false, reason: 'sig-old' }
  if (d.sigOld.length !== 64) return { ok: false, reason: 'sig-old' }
  if (!(await verifyLabeled(k.newPub, 'key-rotate-accept', concat(d.body, d.sigOld), d.sigNew))) return { ok: false, reason: 'sig-new' }
  return { ok: true, rotate: k }
}
