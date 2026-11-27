// WebAuthn as the house reads it (spec 7.4, E-13; step 2.4): the challenges of the one registration and of every
// assertion, and the verification of both ceremonies. Pure: crypto.subtle only, the same code on Node 24 and in a
// browser.
//
// The profile is narrow on purpose. ES256 on P-256 and no other algorithm; attestation format "none" and no other;
// user presence and user verification always required; no authenticator extensions. The decoder reads exactly the
// CBOR a conforming client emits in the CTAP2 canonical form (W3C WebAuthn, conformance rule for CBOR) and refuses
// the rest: it is not a general CBOR decoder.
//
// A verdict is `{ ok: true, … }` or `{ ok: false, reason }`, the reason out of a fixed list: nothing that came from
// the device ever reaches an error message. On the wire every refusal is the same answer; the reason is for the
// portal's logs and for tests.
import { ascii, b64url, concat, copy, equal, fail, Reader, WireError, type Bytes } from './bytes.ts'
import { parseJsonObject } from './content.ts'
import { hasPointShape, selfTest, sha256 } from './crypto.ts'
import { actDigest, derToP1363, elevateDigest, unlockDigest, UV_PURPOSE, uvChallenge, uvRegChallenge } from './presence.ts'

const subtle = (): SubtleCrypto => globalThis.crypto.subtle

// ---------------------------------------------------------------------------------------------------------------
// The relying party: the one fixed origin of the PWA and its rpId, both from the house's configuration (spec 10.2 S-8)
// ---------------------------------------------------------------------------------------------------------------

export interface RelyingParty { readonly origin: string; readonly rpId: string }

const DOMAIN = /^(?=.{1,253}$)[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})*$/
const isDomain = (host: string): boolean => DOMAIN.test(host) && !/^[0-9.]+$/.test(host)

/**
 * The relying party of a house. `origin` is the serialized origin exactly as a browser writes it in clientDataJSON
 * (`https://host[:port]`, lowercase, no path, no default port); `http://` is accepted for `localhost` only. `rpId`
 * defaults to the host and may otherwise be a parent domain of it. A value that no browser would ever produce is a
 * configuration error and throws here, before any ceremony.
 */
export function relyingParty(origin: string, rpId?: string): RelyingParty {
  let url: URL
  try { url = new URL(origin) } catch { return fail('malformed', 'the PWA origin is not a URL') }
  const host = url.hostname
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && host === 'localhost')
  if (!secure || url.origin !== origin || !isDomain(host)) {
    fail('malformed', 'the PWA origin must be https://host[:port], or http://localhost[:port]')
  }
  const id = rpId ?? host
  const parent = id.includes('.') && host.endsWith(`.${id}`)
  if (!isDomain(id) || !(id === host || parent)) fail('malformed', 'the rpId must be the host of the PWA origin or a parent domain of it')
  return Object.freeze({ origin, rpId: id })
}

// ---------------------------------------------------------------------------------------------------------------
// Challenges (spec 7.4). The house and the device are bound through sessionId, the first 16 bytes of a transcript
// that covers pub_H, houseId and pub_D; the act is bound through its digest.
// ---------------------------------------------------------------------------------------------------------------

/** The challenge of the one registration a pairing allows: `H(LBL("uv-reg") ‖ sessionId ‖ pub_D)`. */
export async function registrationChallenge(sessionId: Uint8Array, pubD: Uint8Array): Promise<Bytes> {
  return uvRegChallenge(sessionId, pubD)
}

/** What an assertion proves presence for. The purpose and its digest travel together, so they cannot be mismatched. */
export type PresenceContext =
  | { purpose: 'unlock' }
  | { purpose: 'elevate'; deviceId: Uint8Array }
  | { purpose: 'act'; op: number; actId: Uint8Array; body: Uint8Array }

/**
 * The challenge of one assertion: `H(LBL("uv") ‖ sessionId ‖ u32(uvCtr) ‖ purpose ‖ digest)`. For an act the portal
 * passes the request it actually received, never what `uv.challenge` announced.
 */
export async function assertionChallenge(sessionId: Uint8Array, uvCtr: number, ctx: PresenceContext): Promise<Bytes> {
  switch (ctx.purpose) {
    case 'unlock': return uvChallenge(sessionId, uvCtr, UV_PURPOSE.unlock, unlockDigest())
    case 'elevate': return uvChallenge(sessionId, uvCtr, UV_PURPOSE.elevate, await elevateDigest(ctx.deviceId))
    case 'act': return uvChallenge(sessionId, uvCtr, UV_PURPOSE.act, await actDigest(ctx.op, ctx.actId, ctx.body))
    default: return fail('malformed', 'uv purpose')
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Refusals and limits
// ---------------------------------------------------------------------------------------------------------------

export type WebAuthnFailure =
  | 'too-large' // an input above its cap; nothing was parsed
  | 'malformed' // JSON, CBOR, DER or authenticator data that does not parse strictly: truncated, not canonical, bytes left over
  | 'type' // clientDataJSON.type is not the one of this ceremony
  | 'challenge' // not the challenge the portal expects: another session, another act, another counter
  | 'origin' // not the fixed origin of the PWA
  | 'cross-origin' // the ceremony ran inside a cross-origin frame
  | 'rp-id' // rpIdHash is not the hash of the configured rpId
  | 'user-presence' // UP is not set
  | 'user-verification' // UV is not set
  | 'flags' // a flag the ceremony does not allow, or one it needs is missing (AT, BS without BE)
  | 'extensions' // authenticator extensions are present
  | 'attestation' // an attestation format other than "none", or a statement that is not empty
  | 'algorithm' // a credential key that is not ES256 on P-256
  | 'key' // a public key that is not a point of the curve
  | 'signature' // the signature does not verify under the registered key
  | 'sign-count' // the signature counter did not grow

/** A refusal while reading device input. Its message is the reason and nothing else. The verifiers never let it out. */
export class WebAuthnRefusal extends Error {
  readonly reason: WebAuthnFailure
  constructor(reason: WebAuthnFailure) {
    super(reason)
    this.name = 'WebAuthnRefusal'
    this.reason = reason
  }
}

const refuse = (reason: WebAuthnFailure): never => { throw new WebAuthnRefusal(reason) }

/** Caps of every input, checked before anything is parsed. The authenticator data cap is the largest ES256 registration. */
export const WEBAUTHN_LIMITS = {
  clientDataJSON: 1024,
  attestationObject: 4096,
  authenticatorData: 37 + 16 + 2 + 1023 + 77,
  credentialId: 1023,
  signature: 72,
} as const

type Verdict<T> = ({ ok: true } & T) | { ok: false; reason: WebAuthnFailure }

/** Turns every refusal into a verdict. A platform that failed the self-test, or a bug, still throws. */
async function verdict<T extends object>(run: () => Promise<T>): Promise<Verdict<T>> {
  try { return { ok: true, ...(await run()) } }
  catch (e) {
    if (e instanceof WebAuthnRefusal) return { ok: false, reason: e.reason }
    if (e instanceof WireError && e.code !== 'self-test') return { ok: false, reason: 'malformed' }
    throw e
  }
}

// ---------------------------------------------------------------------------------------------------------------
// clientDataJSON (W3C WebAuthn, CollectedClientData)
// ---------------------------------------------------------------------------------------------------------------

const own = (o: Record<string, unknown>, key: string): unknown => (Object.hasOwn(o, key) ? o[key] : undefined)

/** Unknown members are ignored, as the standard requires; the four the house depends on are compared exactly. */
function checkClientData(raw: Uint8Array, type: 'webauthn.create' | 'webauthn.get', challenge: Uint8Array, rp: RelyingParty): void {
  const c = parseJsonObject(raw)
  if (own(c, 'type') !== type) refuse('type')
  if (own(c, 'challenge') !== b64url(challenge)) refuse('challenge')
  if (own(c, 'origin') !== rp.origin) refuse('origin')
  const cross = own(c, 'crossOrigin')
  if (cross !== undefined && cross !== false) refuse('cross-origin')
}

// ---------------------------------------------------------------------------------------------------------------
// The CBOR this profile reads, in the CTAP2 canonical form: definite lengths, shortest heads, keys in order
// ---------------------------------------------------------------------------------------------------------------

const UINT = 0
const NINT = 1
const BSTR = 2
const TSTR = 3
const MAP = 5

/** One head: major type and argument. A longer head than the argument needs, a 64-bit one or an indefinite length is refused. */
function head(r: Reader): { major: number; arg: number } {
  const b = r.u8()
  const major = b >>> 5
  const info = b & 31
  if (info < 24) return { major, arg: info }
  let arg = -1
  if (info === 24) { arg = r.u8(); if (arg < 24) arg = -1 }
  else if (info === 25) { arg = r.u16(); if (arg < 0x100) arg = -1 }
  else if (info === 26) { arg = r.u32(); if (arg < 0x10000) arg = -1 }
  return arg < 0 ? refuse('malformed') : { major, arg }
}

function sized(r: Reader, major: number): number {
  const h = head(r)
  return h.major === major ? h.arg : refuse('malformed')
}

function int(r: Reader): number {
  const h = head(r)
  if (h.major === UINT) return h.arg
  return h.major === NINT ? -1 - h.arg : refuse('malformed')
}

function text(r: Reader, max: number): Bytes {
  const n = sized(r, TSTR)
  return n <= max ? r.take(n) : refuse('malformed')
}

const expectText = (r: Reader, value: Bytes): void => { if (!equal(text(r, value.length), value)) refuse('malformed') }
const expectLabel = (r: Reader, label: number): void => { if (int(r) !== label) refuse('malformed') }

function coordinate(r: Reader): Bytes {
  return sized(r, BSTR) === 32 ? r.take(32) : refuse('malformed')
}

const COSE_KTY_EC2 = 2
const COSE_ALG_ES256 = -7
const COSE_CRV_P256 = 1

/**
 * The credential public key: `{1: 2, 3: -7, -1: 1, -2: x(32), -3: y(32)}`, these five members in this order and no
 * other (the standard forbids optional members here). Returns the uncompressed point. A well-formed key of another
 * type, algorithm or curve is `algorithm`; anything else is `malformed`.
 */
function coseEs256(r: Reader): Bytes {
  const n = sized(r, MAP)
  if (n < 2) refuse('malformed')
  expectLabel(r, 1)
  const kty = int(r)
  expectLabel(r, 3)
  const alg = int(r)
  if (kty !== COSE_KTY_EC2 || alg !== COSE_ALG_ES256) refuse('algorithm')
  if (n !== 5) refuse('malformed')
  expectLabel(r, -1)
  if (int(r) !== COSE_CRV_P256) refuse('algorithm')
  expectLabel(r, -2)
  const x = coordinate(r)
  expectLabel(r, -3)
  const y = coordinate(r)
  return concat(Uint8Array.of(0x04), x, y)
}

// ---------------------------------------------------------------------------------------------------------------
// Authenticator data and the attestation object
// ---------------------------------------------------------------------------------------------------------------

export const AUTH_FLAG = { UP: 0x01, UV: 0x04, BE: 0x08, BS: 0x10, AT: 0x40, ED: 0x80 } as const

export interface AuthenticatorData {
  rpIdHash: Bytes
  flags: number
  signCount: number
  /** Present exactly when the AT flag is set. */
  attested?: { aaguid: Bytes; credentialId: Bytes; publicKey: Bytes }
}

/**
 * `rpIdHash(32) ‖ flags(1) ‖ signCount(4) ‖ [aaguid(16) ‖ u16(len) ‖ credentialId ‖ COSE key]`, with nothing after it.
 * Structure only: the policy on the flags is the verifiers'. Extensions are refused, so the end of the data is known.
 * Throws WebAuthnRefusal or WireError.
 */
export function parseAuthenticatorData(raw: Uint8Array): AuthenticatorData {
  if (raw.length > WEBAUTHN_LIMITS.authenticatorData) refuse('too-large')
  const r = new Reader(raw)
  const data: AuthenticatorData = { rpIdHash: r.take(32), flags: r.u8(), signCount: r.u32() }
  if (data.flags & AUTH_FLAG.ED) refuse('extensions')
  if (data.flags & AUTH_FLAG.AT) {
    const aaguid = r.take(16)
    const len = r.u16()
    if (len < 1 || len > WEBAUTHN_LIMITS.credentialId) refuse('malformed')
    data.attested = { aaguid, credentialId: r.take(len), publicKey: coseEs256(r) }
  }
  r.end()
  return data
}

const FMT = ascii('fmt')
const ATT_STMT = ascii('attStmt')
const AUTH_DATA = ascii('authData')
const FMT_NONE = ascii('none')
const FMT_MAX = 32

/**
 * `{"fmt": "none", "attStmt": {}, "authData": bytes}`, the three members in canonical order. Returns the authenticator
 * data inside. Throws WebAuthnRefusal or WireError.
 */
export function parseAttestationObject(raw: Uint8Array): AuthenticatorData {
  if (raw.length > WEBAUTHN_LIMITS.attestationObject) refuse('too-large')
  const r = new Reader(raw)
  if (sized(r, MAP) !== 3) refuse('malformed')
  expectText(r, FMT)
  if (!equal(text(r, FMT_MAX), FMT_NONE)) refuse('attestation')
  expectText(r, ATT_STMT)
  if (sized(r, MAP) !== 0) refuse('attestation')
  expectText(r, AUTH_DATA)
  const n = sized(r, BSTR)
  if (n > WEBAUTHN_LIMITS.authenticatorData) refuse('too-large')
  const authData = r.take(n)
  r.end()
  return parseAuthenticatorData(authData)
}

/** What both ceremonies demand of the authenticator data: this rpId, the person present and verified, coherent backup bits. */
async function checkAuthData(data: AuthenticatorData, rp: RelyingParty): Promise<void> {
  if (!equal(data.rpIdHash, await sha256(ascii(rp.rpId)))) refuse('rp-id')
  if (!(data.flags & AUTH_FLAG.UP)) refuse('user-presence')
  if (!(data.flags & AUTH_FLAG.UV)) refuse('user-verification')
  if (data.flags & AUTH_FLAG.BS && !(data.flags & AUTH_FLAG.BE)) refuse('flags')
}

const ECDSA = { name: 'ECDSA', hash: 'SHA-256' } as const

async function importCredentialKey(pub: Uint8Array): Promise<CryptoKey> {
  await selfTest()
  if (!hasPointShape(pub)) refuse('key')
  try { return await subtle().importKey('raw', copy(pub), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']) }
  catch { return refuse('key') }
}

const expectChallenge = (challenge: Uint8Array): void => {
  if (challenge.length !== 32) fail('malformed', 'the expected challenge must be 32 bytes')
}

// ---------------------------------------------------------------------------------------------------------------
// Registration (W3C WebAuthn 7.1, for attestation "none")
// ---------------------------------------------------------------------------------------------------------------

/** What the house keeps of a registered credential. `publicKey` is the uncompressed P-256 point (65 bytes). */
export interface WebAuthnCredential {
  credentialId: Bytes
  publicKey: Bytes
  /** The counter seen last. A synced passkey reports 0 forever. */
  signCount: number
  /** The credential may exist on other devices of the same person (a synced passkey). Fixed at registration. */
  backupEligible: boolean
  backedUp: boolean
}

export type RegistrationVerdict = Verdict<{ credential: WebAuthnCredential }>

/**
 * Verifies the answer to `navigator.credentials.create`. `challenge` is `registrationChallenge` of this session.
 *
 * With attestation "none" nothing here is signed: the registration is as trustworthy as the session that carries it,
 * which is why the wire accepts it once, in the session that concluded the pairing (spec 7.4 point 1).
 */
export async function verifyRegistration(o: {
  rp: RelyingParty; challenge: Uint8Array; clientDataJSON: Uint8Array; attestationObject: Uint8Array
}): Promise<RegistrationVerdict> {
  expectChallenge(o.challenge)
  return verdict(async () => {
    if (o.clientDataJSON.length > WEBAUTHN_LIMITS.clientDataJSON) refuse('too-large')
    if (o.attestationObject.length > WEBAUTHN_LIMITS.attestationObject) refuse('too-large')
    checkClientData(o.clientDataJSON, 'webauthn.create', o.challenge, o.rp)
    const data = parseAttestationObject(o.attestationObject)
    await checkAuthData(data, o.rp)
    const attested = data.attested ?? refuse('flags')
    await importCredentialKey(attested.publicKey)
    return {
      credential: {
        credentialId: attested.credentialId,
        publicKey: attested.publicKey,
        signCount: data.signCount,
        backupEligible: (data.flags & AUTH_FLAG.BE) !== 0,
        backedUp: (data.flags & AUTH_FLAG.BS) !== 0,
      },
    }
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Assertion (W3C WebAuthn 7.2; spec 7.4 point 5)
// ---------------------------------------------------------------------------------------------------------------

export type AssertionVerdict = Verdict<{ signCount: number; backedUp: boolean }>

/**
 * The counter rule of the standard: when the stored or the received counter is not zero, the received one must be
 * greater. Both zero is an authenticator without a counter. It is a signal of a cloned authenticator, not the defence
 * (spec 7.4 point 5): the defence is the single-use challenge.
 */
const counterGrew = (stored: number, seen: number): boolean => (stored === 0 && seen === 0) || seen > stored

/**
 * Verifies one assertion (`navigator.credentials.get`) against the challenge the portal expects and the credential
 * registered at pairing. On success the caller stores the returned `signCount` before it answers.
 */
export async function verifyAssertion(o: {
  rp: RelyingParty
  challenge: Uint8Array
  /** The three byte strings of a `UvProof` (spec 7.1). */
  proof: { authenticatorData: Uint8Array; clientDataJSON: Uint8Array; signature: Uint8Array }
  /** `publicKey` and `signCount` of the stored `WebAuthnCredential`. */
  credential: { publicKey: Uint8Array; signCount: number }
}): Promise<AssertionVerdict> {
  expectChallenge(o.challenge)
  const stored = o.credential.signCount
  if (!Number.isInteger(stored) || stored < 0 || stored > 0xffffffff) fail('range', 'stored signCount')
  return verdict(async () => {
    const { authenticatorData, clientDataJSON, signature } = o.proof
    if (clientDataJSON.length > WEBAUTHN_LIMITS.clientDataJSON || signature.length > WEBAUTHN_LIMITS.signature) refuse('too-large')
    if (authenticatorData.length > WEBAUTHN_LIMITS.authenticatorData) refuse('too-large')
    checkClientData(clientDataJSON, 'webauthn.get', o.challenge, o.rp)
    const data = parseAuthenticatorData(authenticatorData)
    if (data.attested) refuse('flags')
    await checkAuthData(data, o.rp)
    const key = await importCredentialKey(o.credential.publicKey)
    const signed = concat(authenticatorData, await sha256(clientDataJSON))
    if (!(await subtle().verify(ECDSA, key, derToP1363(signature), signed))) refuse('signature')
    if (!counterGrew(stored, data.signCount)) refuse('sign-count')
    return { signCount: data.signCount, backedUp: (data.flags & AUTH_FLAG.BS) !== 0 }
  })
}
