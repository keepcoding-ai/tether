// Remote wire, WebAuthn (spec 7.4, E-13; step 2.4): the verification of the one registration and of every assertion.
//
// Three sources of truth meet here. The vectors of the standard itself (W3C WebAuthn Level 3, section 16), copied
// into test/unit/remote.webauthn.vectors.json, check the format against bytes this repository did not produce. A
// software authenticator written in this file with crypto.subtle produces the house's fixed vectors (the accepted
// ceremonies and every refusal), regenerated only with REMOTE_VECTORS_UPDATE=1; it is itself checked against the
// standard's bytes. And the same authenticator runs live, with fresh keys, on every run.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ascii, b64url, concat, fromHex, randomBytes, toHex, u16, u32, u8, utf8, WireError, type Bytes } from '../../src/remote/bytes.ts'
import { SELF_TEST_POINTS, sha256 } from '../../src/remote/crypto.ts'
import { deviceIdOf } from '../../src/remote/keys.ts'
import { derToP1363 } from '../../src/remote/presence.ts'
import * as remote from '../../src/remote/index.ts'
import {
  assertionChallenge, AUTH_FLAG, parseAttestationObject, parseAuthenticatorData, registrationChallenge, relyingParty,
  verifyAssertion, verifyRegistration, WEBAUTHN_LIMITS, WebAuthnRefusal, type RelyingParty, type WebAuthnFailure,
} from '../../src/remote/webauthn.ts'
import {
  checkWebAuthnHouse as checkHouse, type WebAuthnAssertCase as AssertCase, type WebAuthnHouse as House,
  type WebAuthnRegCase as RegCase,
} from '../../src/remote/testing.ts'

const FILE = join(dirname(fileURLToPath(import.meta.url)), 'remote.webauthn.vectors.json')
const subtle = globalThis.crypto.subtle
const { UP, UV, BE, BS, AT, ED } = AUTH_FLAG
const EMPTY = new Uint8Array(0)

const REASONS: readonly WebAuthnFailure[] = [
  'too-large', 'malformed', 'type', 'challenge', 'origin', 'cross-origin', 'rp-id', 'user-presence', 'user-verification',
  'flags', 'extensions', 'attestation', 'algorithm', 'key', 'signature', 'sign-count',
]

// ---------------------------------------------------------------------------------------------------------------
// The software authenticator and client: what a browser and a platform authenticator emit, built from the standard
// ---------------------------------------------------------------------------------------------------------------

/** CBOR in the CTAP2 canonical form: the shortest head for every argument. */
const cborHead = (major: number, n: number): Bytes =>
  n < 24 ? u8((major << 5) | n) : n < 0x100 ? concat(u8((major << 5) | 24), u8(n)) : concat(u8((major << 5) | 25), u16(n))
const cInt = (v: number): Bytes => (v >= 0 ? cborHead(0, v) : cborHead(1, -1 - v))
const cBytes = (b: Uint8Array): Bytes => concat(cborHead(2, b.length), b)
const cText = (s: string): Bytes => concat(cborHead(3, s.length), ascii(s))
type Pair = readonly [Uint8Array, Uint8Array]
const cMap = (...pairs: Pair[]): Bytes => concat(cborHead(5, pairs.length), ...pairs.flatMap(p => [p[0], p[1]]))

/** COSE_Key of an EC2 public key (RFC 9052): kty, alg, crv, x, y. */
const coseEc2 = (pub: Uint8Array, alg = -7, crv = 1): Bytes =>
  cMap([cInt(1), cInt(2)], [cInt(3), cInt(alg)], [cInt(-1), cInt(crv)], [cInt(-2), cBytes(pub.subarray(1, 33))], [cInt(-3), cBytes(pub.subarray(33))])

interface Attested { aaguid: Uint8Array; credentialId: Uint8Array; cose: Uint8Array }

/** Authenticator data (WebAuthn 6.1): rpIdHash, flags, signCount, then the attested credential data and whatever follows. */
const authData = async (p: { rpId: string; flags: number; signCount: number; attested?: Attested | undefined; tail?: Uint8Array | undefined }): Promise<Bytes> =>
  concat(
    await sha256(ascii(p.rpId)), u8(p.flags), u32(p.signCount),
    p.attested ? concat(p.attested.aaguid, u16(p.attested.credentialId.length), p.attested.credentialId, p.attested.cose) : EMPTY,
    p.tail ?? EMPTY,
  )

const attMembers = (ad: Uint8Array, fmt = 'none', attStmt: Uint8Array = cMap()): Pair[] =>
  [[cText('fmt'), cText(fmt)], [cText('attStmt'), attStmt], [cText('authData'), cBytes(ad)]]

/** Attestation object (WebAuthn 6.5.4) as the client hands it to the relying party. */
const attestation = (ad: Uint8Array, fmt = 'none', attStmt: Uint8Array = cMap()): Bytes => cMap(...attMembers(ad, fmt, attStmt))

/** clientDataJSON in the serialization of the standard (WebAuthn 5.8.1.1). `crossOrigin: null` leaves the member out. */
const clientData = (p: { type: string; challenge: Uint8Array; origin: string; crossOrigin?: boolean | null | undefined; extra?: string | undefined }): Bytes =>
  utf8(`{"type":"${p.type}","challenge":"${b64url(p.challenge)}","origin":"${p.origin}"`
    + (p.crossOrigin === null ? '' : `,"crossOrigin":${p.crossOrigin ?? false}`) + (p.extra ?? '') + '}')

/** One DER INTEGER of a scalar; `padded` adds a zero the encoding does not need. */
const derInt = (x: Uint8Array, padded = false): Bytes => {
  let i = 0
  while (i < x.length - 1 && x[i] === 0) i++
  const mag = x.subarray(i)
  const minimal = mag[0]! & 0x80 ? concat(u8(0), mag) : concat(mag)
  const body = padded ? concat(u8(0), minimal) : minimal
  return concat(u8(0x02), u8(body.length), body)
}
const derSeq = (...parts: Uint8Array[]): Bytes => { const c = concat(...parts); return concat(u8(0x30), u8(c.length), c) }
/** P1363 (r ‖ s) to the DER an authenticator emits. */
const toDer = (sig: Uint8Array): Bytes => derSeq(derInt(sig.subarray(0, 32)), derInt(sig.subarray(32)))

/** A credential private key inside an authenticator: it never leaves, it only signs. */
interface Authenticator { pub: Bytes; signRaw(data: Uint8Array): Promise<Bytes> }

async function authenticator(): Promise<Authenticator> {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
  return {
    pub: new Uint8Array(await subtle.exportKey('raw', pair.publicKey)),
    signRaw: async data => new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, concat(data))),
  }
}

interface Proof { authenticatorData: Bytes; clientDataJSON: Bytes; signature: Bytes }

interface AssertParts {
  rpId: string; origin: string; challenge: Uint8Array; flags: number; signCount: number
  type?: string; crossOrigin?: boolean | null; extra?: string; tail?: Uint8Array; attested?: Attested
}

/** An assertion: the signature is over authenticatorData ‖ SHA-256(clientDataJSON) (WebAuthn 6.3.3). */
async function assertion(a: Authenticator, p: AssertParts): Promise<Proof> {
  const authenticatorData = await authData({ rpId: p.rpId, flags: p.flags, signCount: p.signCount, attested: p.attested, tail: p.tail })
  const clientDataJSON = clientData({ type: p.type ?? 'webauthn.get', challenge: p.challenge, origin: p.origin, crossOrigin: p.crossOrigin, extra: p.extra })
  const signature = toDer(await a.signRaw(concat(authenticatorData, await sha256(clientDataJSON))))
  return { authenticatorData, clientDataJSON, signature }
}

// ---------------------------------------------------------------------------------------------------------------
// The vector file
// ---------------------------------------------------------------------------------------------------------------

interface W3cCeremony {
  section: string
  credentialId?: string
  registration: { challenge: string; clientDataJSON: string; attestationObject: string }
  authentication?: { challenge: string; authenticatorData: string; clientDataJSON: string; signature: string }
}

interface VectorFile {
  about: string
  w3c: {
    source: string; rpId: string; origin: string
    none_es256: W3cCeremony; packed_self_es256: W3cCeremony; cross_origin: W3cCeremony; long_credential_id: W3cCeremony
  }
  house: House | null
}

const readFile = (): VectorFile => JSON.parse(readFileSync(FILE, 'utf8')) as VectorFile

// The checker lives in src/remote/testing.ts, so a browser runs the same vector file through the same code.

// ---------------------------------------------------------------------------------------------------------------
// The generator of the house block
// ---------------------------------------------------------------------------------------------------------------

async function generateHouse(): Promise<House> {
  const rp = relyingParty('https://pwa.example.test')
  const sessionId = randomBytes(16)
  const otherSessionId = randomBytes(16)
  const pubD = (await authenticator()).pub
  const deviceId = await deviceIdOf(pubD)
  const otherDeviceId = randomBytes(16)
  const uvCtr = 7
  const op = 0x0601
  const actId = randomBytes(16)
  const body = utf8('{"deviceId":"0123456789abcdef0123456789abcdef"}')
  const key = await authenticator()
  const stranger = await authenticator()
  const credentialId = randomBytes(32)
  const aaguid = new Uint8Array(16)
  const SYNCED = UP | UV | BE | BS
  const UNKNOWN_MEMBER = ',"other_keys_can_be_added_here":"do not compare clientDataJSON against a template"'

  const regChal = await registrationChallenge(sessionId, pubD)
  const unlock = await assertionChallenge(sessionId, uvCtr, { purpose: 'unlock' })
  const elevate = await assertionChallenge(sessionId, uvCtr, { purpose: 'elevate', deviceId })
  const act = await assertionChallenge(sessionId, uvCtr, { purpose: 'act', op, actId, body })

  // --- registrations --------------------------------------------------------------------------------------------
  const registrations: RegCase[] = []
  interface RegParts {
    challenge?: Uint8Array; type?: string; origin?: string; crossOrigin?: boolean | null; extra?: string
    rpId?: string; flags?: number; signCount?: number; credentialId?: Uint8Array; cose?: Uint8Array; bare?: boolean; tail?: Uint8Array
    fmt?: string; attStmt?: Uint8Array; object?: (ad: Bytes) => Bytes
  }
  const reg = async (name: string, p: RegParts, reason?: WebAuthnFailure): Promise<void> => {
    const flags = p.flags ?? SYNCED | AT
    const id = p.credentialId ?? credentialId
    const ad = await authData({
      rpId: p.rpId ?? rp.rpId, flags, signCount: p.signCount ?? 0, tail: p.tail,
      attested: p.bare ? undefined : { aaguid, credentialId: id, cose: p.cose ?? coseEc2(key.pub) },
    })
    registrations.push({
      name: `registration: ${name}`,
      challenge: toHex(regChal),
      clientDataJSON: toHex(clientData({ type: p.type ?? 'webauthn.create', challenge: p.challenge ?? regChal, origin: p.origin ?? rp.origin, crossOrigin: p.crossOrigin, extra: p.extra })),
      attestationObject: toHex(p.object ? p.object(ad) : attestation(ad, p.fmt, p.attStmt)),
      expect: reason
        ? { ok: false, reason }
        : { ok: true, credentialId: toHex(id), publicKey: toHex(key.pub), signCount: p.signCount ?? 0, backupEligible: (flags & BE) !== 0, backedUp: (flags & BS) !== 0 },
    })
  }
  const x = key.pub.subarray(1, 33)
  const y = key.pub.subarray(33)

  await reg('accepted, a synced passkey (BE and BS, counter 0)', {})
  await reg('accepted, a device-bound credential with a counter', { flags: UP | UV | AT, signCount: 1, credentialId: randomBytes(16) })
  await reg('accepted, clientDataJSON with members the house does not know', { extra: UNKNOWN_MEMBER })
  await reg('accepted, crossOrigin left out', { crossOrigin: null })
  await reg('accepted, the longest credential id', { credentialId: randomBytes(WEBAUTHN_LIMITS.credentialId) })

  await reg('challenge of another session', { challenge: await registrationChallenge(otherSessionId, pubD) }, 'challenge')
  await reg('challenge of another device key', { challenge: await registrationChallenge(sessionId, stranger.pub) }, 'challenge')
  await reg('challenge of an assertion', { challenge: unlock }, 'challenge')
  await reg('type of an assertion', { type: 'webauthn.get' }, 'type')
  await reg('wrong origin', { origin: 'https://pwa.example.test.evil.test' }, 'origin')
  await reg('wrong origin, a trailing slash', { origin: `${rp.origin}/` }, 'origin')
  await reg('wrong origin, http', { origin: 'http://pwa.example.test' }, 'origin')
  await reg('crossOrigin true', { crossOrigin: true }, 'cross-origin')
  await reg('crossOrigin as a string', { crossOrigin: null, extra: ',"crossOrigin":"false"' }, 'cross-origin')
  await reg('wrong rpId', { rpId: 'evil.example.test' }, 'rp-id')
  await reg('UV absent', { flags: UP | AT }, 'user-verification')
  await reg('UP absent', { flags: UV | AT }, 'user-presence')
  await reg('BS without BE', { flags: UP | UV | BS | AT }, 'flags')
  await reg('no attested credential data', { flags: SYNCED, bare: true }, 'flags')
  await reg('extensions present', { flags: SYNCED | AT | ED, tail: cMap([cText('credProtect'), cInt(2)]) }, 'extensions')
  await reg('attestation format packed', { fmt: 'packed', attStmt: cMap([cText('alg'), cInt(-7)], [cText('sig'), cBytes(randomBytes(70))]) }, 'attestation')
  await reg('attestation none with a statement', { attStmt: cMap([cText('alg'), cInt(-7)]) }, 'attestation')
  await reg('algorithm other than ES256, EdDSA', { cose: cMap([cInt(1), cInt(1)], [cInt(3), cInt(-8)], [cInt(-1), cInt(6)], [cInt(-2), cBytes(randomBytes(32))]) }, 'algorithm')
  await reg('algorithm other than ES256, RS256', { cose: cMap([cInt(1), cInt(3)], [cInt(3), cInt(-257)], [cInt(-1), cBytes(randomBytes(256))], [cInt(-2), cBytes(Uint8Array.of(1, 0, 1))]) }, 'algorithm')
  await reg('algorithm other than ES256, ES384 over the same point', { cose: coseEc2(key.pub, -35) }, 'algorithm')
  await reg('algorithm other than ES256, ES256 declared on P-384', { cose: coseEc2(key.pub, -7, 2) }, 'algorithm')
  await reg('a point off the curve', { cose: coseEc2(SELF_TEST_POINTS.offCurve()) }, 'key')
  await reg('CBOR truncated, the attestation object', { object: ad => attestation(ad).slice(0, -9) }, 'malformed')
  await reg('CBOR truncated, the credential key', { cose: coseEc2(key.pub).slice(0, -1) }, 'malformed')
  await reg('CBOR not canonical, authData length in a longer head than it needs', {
    object: ad => concat(cborHead(5, 3), cText('fmt'), cText('none'), cText('attStmt'), cMap(), cText('authData'), u8(0x59), u16(ad.length), ad),
  }, 'malformed')
  await reg('CBOR not canonical, map head in the long form', { object: ad => concat(u8(0xb8), u8(3), ...attMembers(ad).flat()) }, 'malformed')
  await reg('CBOR not canonical, indefinite-length map', { object: ad => concat(u8(0xbf), ...attMembers(ad).flat(), u8(0xff)) }, 'malformed')
  await reg('CBOR not canonical, members out of order', { object: ad => { const [fmt, stmt, data] = attMembers(ad); return cMap(data!, fmt!, stmt!) } }, 'malformed')
  await reg('CBOR not canonical, the same member twice', { object: ad => { const [fmt, , data] = attMembers(ad); return cMap(fmt!, fmt!, data!) } }, 'malformed')
  await reg('CBOR not canonical, a tag around authData', { object: ad => { const [fmt, stmt] = attMembers(ad); return cMap(fmt!, stmt!, [cText('authData'), concat(u8(0xc0), cBytes(ad))]) } }, 'malformed')
  await reg('CBOR not canonical, key members out of order', { cose: cMap([cInt(3), cInt(-7)], [cInt(1), cInt(2)], [cInt(-1), cInt(1)], [cInt(-2), cBytes(x)], [cInt(-3), cBytes(y)]) }, 'malformed')
  await reg('CBOR not canonical, key algorithm in a longer head than it needs', {
    cose: concat(cborHead(5, 5), cInt(1), cInt(2), cInt(3), Uint8Array.of(0x38, 0x06), cInt(-1), cInt(1), cInt(-2), cBytes(x), cInt(-3), cBytes(y)),
  }, 'malformed')
  await reg('a fourth member in the attestation object', { object: ad => cMap(...attMembers(ad), [cText('extra'), cInt(0)]) }, 'malformed')
  await reg('a key with an optional member', { cose: cMap([cInt(1), cInt(2)], [cInt(3), cInt(-7)], [cInt(-1), cInt(1)], [cInt(-2), cBytes(x)], [cInt(-3), cBytes(y)], [cInt(-4), cBytes(x)]) }, 'malformed')
  await reg('a key without its algorithm', { cose: cMap([cInt(1), cInt(2)], [cInt(-1), cInt(1)], [cInt(-2), cBytes(x)], [cInt(-3), cBytes(y)]) }, 'malformed')
  await reg('a coordinate of 31 bytes', { cose: cMap([cInt(1), cInt(2)], [cInt(3), cInt(-7)], [cInt(-1), cInt(1)], [cInt(-2), cBytes(x.subarray(1))], [cInt(-3), cBytes(y)]) }, 'malformed')
  await reg('an empty credential id', { credentialId: EMPTY }, 'malformed')
  await reg('bytes left over after the attestation object', { object: ad => concat(attestation(ad), u8(0)) }, 'malformed')
  await reg('bytes left over after the credential key', { tail: u8(0) }, 'malformed')
  await reg('clientDataJSON that is not JSON', { extra: ',' }, 'malformed')
  await reg('clientDataJSON above its cap', { extra: `,"pad":"${'x'.repeat(WEBAUTHN_LIMITS.clientDataJSON)}"` }, 'too-large')
  await reg('attestation object above its cap', { object: ad => concat(attestation(ad), new Uint8Array(WEBAUTHN_LIMITS.attestationObject)) }, 'too-large')
  await reg('a credential id above its cap', { credentialId: randomBytes(WEBAUTHN_LIMITS.credentialId + 1) }, 'too-large')

  // --- assertions -----------------------------------------------------------------------------------------------
  const assertions: AssertCase[] = []
  interface CaseParts extends Partial<AssertParts> {
    expected?: Uint8Array; stored?: number; signer?: Authenticator; publicKey?: Uint8Array; after?: (p: Proof) => Proof | Promise<Proof>
  }
  const asr = async (name: string, p: CaseParts, reason?: WebAuthnFailure): Promise<void> => {
    const expected = p.expected ?? unlock
    const flags = p.flags ?? SYNCED
    const signCount = p.signCount ?? 0
    let proof = await assertion(p.signer ?? key, { ...p, rpId: p.rpId ?? rp.rpId, origin: p.origin ?? rp.origin, challenge: p.challenge ?? expected, flags, signCount })
    if (p.after) proof = await p.after(proof)
    assertions.push({
      name: `assertion: ${name}`,
      challenge: toHex(expected), publicKey: toHex(p.publicKey ?? key.pub), storedSignCount: p.stored ?? 0,
      authenticatorData: toHex(proof.authenticatorData), clientDataJSON: toHex(proof.clientDataJSON), signature: toHex(proof.signature),
      expect: reason ? { ok: false, reason } : { ok: true, signCount, backedUp: (flags & BS) !== 0 },
    })
  }
  const flipLast = (b: Uint8Array): Bytes => { const c = concat(b); c[c.length - 1] = c[c.length - 1]! ^ 1; return c }
  const plain = (challenge: Uint8Array): Promise<Proof> => assertion(key, { rpId: rp.rpId, origin: rp.origin, challenge, flags: SYNCED, signCount: 0 })
  /** A plain unlock whose signature leaves room under the cap, so that a longer encoding of it is refused for its form. */
  const roomy = async (): Promise<Proof> => {
    for (;;) {
      const p = await plain(unlock)
      if (p.signature.length < WEBAUTHN_LIMITS.signature && !(derToP1363(p.signature)[0]! & 0x80)) return p
    }
  }

  await asr('accepted, unlock', {})
  await asr('accepted, elevate', { expected: elevate })
  await asr('accepted, one act', { expected: act })
  await asr('accepted, the counter grows', { flags: UP | UV, stored: 41, signCount: 42 })
  await asr('accepted, the first count of an authenticator that counts', { flags: UP | UV, stored: 0, signCount: 1 })
  await asr('accepted, clientDataJSON with members the house does not know', { extra: UNKNOWN_MEMBER })
  await asr('accepted, crossOrigin left out', { crossOrigin: null })

  await asr('challenge of another session', { challenge: await assertionChallenge(otherSessionId, uvCtr, { purpose: 'unlock' }) }, 'challenge')
  await asr('challenge of another counter', { challenge: await assertionChallenge(sessionId, uvCtr + 1, { purpose: 'unlock' }) }, 'challenge')
  await asr('challenge of an unlock presented for an elevation', { expected: elevate, challenge: unlock }, 'challenge')
  await asr('challenge of an elevation of another device', { expected: elevate, challenge: await assertionChallenge(sessionId, uvCtr, { purpose: 'elevate', deviceId: otherDeviceId }) }, 'challenge')
  await asr('challenge of another act, the operation', { expected: act, challenge: await assertionChallenge(sessionId, uvCtr, { purpose: 'act', op: 0x0600, actId, body }) }, 'challenge')
  await asr('challenge of another act, the actId', { expected: act, challenge: await assertionChallenge(sessionId, uvCtr, { purpose: 'act', op, actId: randomBytes(16), body }) }, 'challenge')
  await asr('challenge of another act, the body', { expected: act, challenge: await assertionChallenge(sessionId, uvCtr, { purpose: 'act', op, actId, body: utf8('{"deviceId":"fedcba9876543210fedcba9876543210"}') }) }, 'challenge')
  await asr('challenge of the registration', { challenge: regChal }, 'challenge')
  await asr('type of a registration', { type: 'webauthn.create' }, 'type')
  await asr('wrong origin', { origin: 'https://evil.example.test' }, 'origin')
  await asr('wrong origin, another port', { origin: `${rp.origin}:8443` }, 'origin')
  await asr('crossOrigin true', { crossOrigin: true }, 'cross-origin')
  await asr('wrong rpId', { rpId: 'evil.example.test' }, 'rp-id')
  await asr('wrong rpId, the parent domain', { rpId: 'example.test' }, 'rp-id')
  await asr('UV absent', { flags: UP | BE | BS }, 'user-verification')
  await asr('UP absent', { flags: UV | BE | BS }, 'user-presence')
  await asr('BS without BE', { flags: UP | UV | BS }, 'flags')
  await asr('attested credential data', { flags: SYNCED | AT, attested: { aaguid, credentialId, cose: coseEc2(key.pub) } }, 'flags')
  await asr('extensions present', { flags: SYNCED | ED, tail: cMap([cText('credProtect'), cInt(2)]) }, 'extensions')
  await asr('bytes left over after the authenticator data', { tail: u8(0) }, 'malformed')
  await asr('truncated authenticator data', { after: p => ({ ...p, authenticatorData: p.authenticatorData.slice(0, 36) }) }, 'malformed')
  await asr('signature tampered', { after: p => ({ ...p, signature: flipLast(p.signature) }) }, 'signature')
  await asr('signature tampered, clientDataJSON changed after signing', { after: p => ({ ...p, clientDataJSON: concat(p.clientDataJSON, utf8(' ')) }) }, 'signature')
  await asr('signature tampered, the counter changed after signing', { stored: 0, signCount: 5, after: p => ({ ...p, authenticatorData: flipLast(p.authenticatorData) }) }, 'signature')
  await asr('signature of another ceremony', { after: async p => ({ ...p, signature: (await plain(elevate)).signature }) }, 'signature')
  await asr('key of another device', { signer: stranger }, 'signature')
  await asr('key of another device, stored', { publicKey: stranger.pub }, 'signature')
  await asr('stored key off the curve', { publicKey: SELF_TEST_POINTS.offCurve() }, 'key')
  await asr('signature in P1363', { after: p => ({ ...p, signature: derToP1363(p.signature) }) }, 'malformed')
  await asr('signature in DER that is not minimal', { after: async () => { const p = await roomy(); const raw = derToP1363(p.signature); return { ...p, signature: derSeq(derInt(raw.subarray(0, 32), true), derInt(raw.subarray(32))) } } }, 'malformed')
  await asr('signature with bytes left over', { after: async () => { const p = await roomy(); return { ...p, signature: concat(p.signature, u8(0)) } } }, 'malformed')
  await asr('signature with s = 0', { after: p => ({ ...p, signature: derSeq(derInt(derToP1363(p.signature).subarray(0, 32)), derInt(new Uint8Array(32))) }) }, 'malformed')
  await asr('signature above its cap', { after: p => ({ ...p, signature: new Uint8Array(WEBAUTHN_LIMITS.signature + 1).fill(0x30) }) }, 'too-large')
  await asr('clientDataJSON above its cap', { extra: `,"pad":"${'x'.repeat(WEBAUTHN_LIMITS.clientDataJSON)}"` }, 'too-large')
  await asr('signCount regressed', { flags: UP | UV, stored: 42, signCount: 41 }, 'sign-count')
  await asr('signCount regressed, repeated', { flags: UP | UV, stored: 42, signCount: 42 }, 'sign-count')
  await asr('signCount regressed, back to zero', { flags: UP | UV, stored: 42, signCount: 0 }, 'sign-count')

  return {
    rp: { origin: rp.origin, rpId: rp.rpId },
    context: {
      sessionId: toHex(sessionId), otherSessionId: toHex(otherSessionId), pubD: toHex(pubD), deviceId: toHex(deviceId),
      otherDeviceId: toHex(otherDeviceId), uvCtr, op, actId: toHex(actId), body: toHex(body),
    },
    challenges: { registration: toHex(regChal), unlock: toHex(unlock), elevate: toHex(elevate), act: toHex(act) },
    registrations, assertions,
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------------------------

const code = async (p: Promise<unknown>): Promise<string> => {
  try { await p } catch (e) { return e instanceof WireError ? e.code : e instanceof WebAuthnRefusal ? `refusal:${e.reason}` : `other:${String(e)}` }
  return 'no-error'
}
const refusal = (fn: () => unknown): string => {
  try { fn() } catch (e) { return e instanceof WebAuthnRefusal ? e.reason : e instanceof WireError ? `wire:${e.code}` : `other:${String(e)}` }
  return 'no-error'
}

describe('webauthn fixed vectors of the house', () => {
  test('the recorded file verifies against this module: the accepted ceremonies and every refusal', async () => {
    if (process.env.REMOTE_VECTORS_UPDATE === '1') {
      const file = readFile()
      writeFileSync(FILE, JSON.stringify({ ...file, house: await generateHouse() }, null, 1) + '\n')
    }
    assert.ok(existsSync(FILE))
    const house = readFile().house
    assert.ok(house, 'the house block is missing: generate it with REMOTE_VECTORS_UPDATE=1')
    const failed = (await checkHouse(house)).filter(r => !r.ok)
    assert.deepEqual(failed, [], `${failed.length} vector checks failed`)

    const names = [...house.registrations, ...house.assertions].map(c => c.name)
    assert.equal(new Set(names).size, names.length, 'every case has its own name')
    for (const required of [
      'registration: accepted', 'assertion: accepted, unlock', 'assertion: accepted, elevate', 'assertion: accepted, one act',
      'registration: challenge of another session', 'assertion: challenge of another session', 'assertion: challenge of another act',
      'registration: wrong origin', 'assertion: wrong origin', 'registration: wrong rpId', 'assertion: wrong rpId',
      'registration: UV absent', 'assertion: UV absent', 'registration: UP absent', 'assertion: UP absent',
      'assertion: signature tampered', 'assertion: key of another device', 'assertion: signCount regressed',
      'registration: CBOR truncated', 'registration: CBOR not canonical', 'registration: algorithm other than ES256',
      'registration: bytes left over', 'assertion: bytes left over',
    ]) assert.ok(names.some(n => n.startsWith(required)), `a case for "${required}"`)
    const refusedFor = new Set([...house.registrations, ...house.assertions].map(c => (c.expect.ok ? 'ok' : c.expect.reason)))
    for (const reason of REASONS) assert.ok(refusedFor.has(reason), `a fixed vector is refused for ${reason}`)
    assert.ok(house.registrations.filter(c => c.expect.ok).length >= 3 && house.assertions.filter(c => c.expect.ok).length >= 5)
  })

  test('a vector file that was tampered with does not verify', async () => {
    const house = readFile().house!
    const flip = (hex: string): string => { const b = fromHex(hex); b[b.length - 1] = b[b.length - 1]! ^ 1; return toHex(b) }
    const find = <T extends { name: string }>(list: T[], name: string): T => list.find(c => c.name === name) ?? assert.fail(name)
    const cases: [string, (h: House) => void][] = [
      ['a challenge of the context', h => { h.challenges.act = flip(h.challenges.act) }],
      ['the session of the context', h => { h.context.sessionId = flip(h.context.sessionId) }],
      ['the key of an accepted registration', h => { const c = find(h.registrations, 'registration: accepted, a synced passkey (BE and BS, counter 0)'); if (c.expect.ok) c.expect.publicKey = flip(c.expect.publicKey) }],
      ['the signature of an accepted assertion', h => { const c = find(h.assertions, 'assertion: accepted, unlock'); c.signature = flip(c.signature) }],
      ['the stored counter of an accepted assertion', h => { find(h.assertions, 'assertion: accepted, the counter grows').storedSignCount = 42 }],
      ['the reason of a refusal', h => { find(h.assertions, 'assertion: UV absent').expect = { ok: false, reason: 'user-presence' } }],
      ['a refusal turned into an acceptance', h => { find(h.assertions, 'assertion: signCount regressed').expect = { ok: true, signCount: 41, backedUp: false } }],
    ]
    for (const [name, tamper] of cases) {
      const copy = structuredClone(house)
      tamper(copy)
      assert.ok((await checkHouse(copy)).some(r => !r.ok), name)
    }
  })
})

describe('webauthn against the vectors of the standard (W3C WebAuthn Level 3, section 16)', () => {
  const w3c = readFile().w3c
  const rp = relyingParty(w3c.origin, w3c.rpId)
  const regOf = (c: W3cCeremony) => ({
    rp, challenge: fromHex(c.registration.challenge), clientDataJSON: fromHex(c.registration.clientDataJSON),
    attestationObject: fromHex(c.registration.attestationObject),
  })
  const authOf = (c: W3cCeremony, publicKey: Uint8Array, signCount = 0) => {
    const a = c.authentication ?? assert.fail('no authentication in this vector')
    return {
      rp, challenge: fromHex(a.challenge), credential: { publicKey, signCount },
      proof: { authenticatorData: fromHex(a.authenticatorData), clientDataJSON: fromHex(a.clientDataJSON), signature: fromHex(a.signature) },
    }
  }
  const keyOf = (c: W3cCeremony): Bytes => parseAttestationObject(fromHex(c.registration.attestationObject)).attested!.publicKey

  test('16.2: the attestation object of the standard parses into the credential it describes', () => {
    const data = parseAttestationObject(fromHex(w3c.none_es256.registration.attestationObject))
    assert.equal(data.flags, UP | BE | BS | AT)
    assert.equal(data.signCount, 0)
    assert.equal(toHex(data.attested!.aaguid), '8446ccb9ab1db374750b2367ff6f3a1f')
    assert.equal(toHex(data.attested!.credentialId), w3c.none_es256.credentialId)
    assert.equal(toHex(data.attested!.publicKey), '04'
      + 'afefa16f97ca9b2d23eb86ccb64098d20db90856062eb249c33a9b672f26df61' + '930a56b87a2fca66334b03458abf879717c12cc68ed73290af2e2664796b9220')
    const auth = parseAuthenticatorData(fromHex(w3c.none_es256.authentication!.authenticatorData))
    assert.deepEqual([auth.flags, auth.signCount, auth.attested], [UP | BE | BS, 0, undefined])
    assert.equal(toHex(auth.rpIdHash), toHex(data.rpIdHash))
  })

  test('16.6: the assertion of the standard verifies under the key read from its own registration', async () => {
    const c = w3c.long_credential_id
    const data = parseAttestationObject(fromHex(c.registration.attestationObject))
    assert.equal(data.attested!.credentialId.length, 1023, 'the longest credential id the standard allows')
    assert.deepEqual(await verifyAssertion(authOf(c, data.attested!.publicKey)), { ok: true, signCount: 0, backedUp: false })
    // The same bytes under everything the house binds: another challenge, origin, rpId, key, or a counter that already ran.
    const base = authOf(c, data.attested!.publicKey)
    assert.deepEqual(await verifyAssertion({ ...base, challenge: fromHex(w3c.none_es256.authentication!.challenge) }), { ok: false, reason: 'challenge' })
    assert.deepEqual(await verifyAssertion({ ...base, rp: relyingParty('https://www.example.org', 'example.org') }), { ok: false, reason: 'origin' })
    assert.deepEqual(await verifyAssertion({ ...base, rp: { origin: w3c.origin, rpId: 'example.com' } }), { ok: false, reason: 'rp-id' })
    assert.deepEqual(await verifyAssertion(authOf(c, keyOf(w3c.none_es256))), { ok: false, reason: 'signature' })
    assert.deepEqual(await verifyAssertion(authOf(c, data.attested!.publicKey, 1)), { ok: false, reason: 'sign-count' })
  })

  test('16.4: the attestation object of the standard registers once the ceremony is same-origin', async () => {
    const c = w3c.cross_origin
    const sameOrigin = clientData({ type: 'webauthn.create', challenge: fromHex(c.registration.challenge), origin: w3c.origin })
    const v = await verifyRegistration({ ...regOf(c), clientDataJSON: sameOrigin })
    assert.ok(v.ok)
    assert.equal(toHex(v.credential.credentialId), c.credentialId)
    assert.deepEqual([v.credential.signCount, v.credential.backupEligible, v.credential.backedUp], [0, false, false])
    assert.equal(toHex(v.credential.publicKey), toHex(keyOf(c)))
    // As published the vector is a cross-origin ceremony, which the house refuses in both directions (spec 7.4 point 5).
    assert.deepEqual(await verifyRegistration(regOf(c)), { ok: false, reason: 'cross-origin' })
    assert.deepEqual(await verifyAssertion(authOf(c, v.credential.publicKey)), { ok: false, reason: 'cross-origin' })
  })

  test('where the house is stricter than the vectors: no user verification, and attestation other than none', async () => {
    assert.deepEqual(await verifyRegistration(regOf(w3c.none_es256)), { ok: false, reason: 'user-verification' })
    assert.deepEqual(await verifyAssertion(authOf(w3c.none_es256, keyOf(w3c.none_es256))), { ok: false, reason: 'user-verification' })
    assert.deepEqual(await verifyRegistration(regOf(w3c.long_credential_id)), { ok: false, reason: 'user-verification' })
    assert.deepEqual(await verifyRegistration(regOf(w3c.packed_self_es256)), { ok: false, reason: 'attestation' })
    assert.equal(refusal(() => parseAttestationObject(fromHex(w3c.packed_self_es256.registration.attestationObject))), 'attestation')
  })

  test('the software authenticator of this file emits the bytes of the standard', async () => {
    for (const c of [w3c.none_es256, w3c.cross_origin, w3c.long_credential_id]) {
      const data = parseAttestationObject(fromHex(c.registration.attestationObject))
      const att = data.attested!
      const rebuilt = attestation(await authData({
        rpId: w3c.rpId, flags: data.flags, signCount: data.signCount,
        attested: { aaguid: att.aaguid, credentialId: att.credentialId, cose: coseEc2(att.publicKey) },
      }))
      assert.equal(toHex(rebuilt), c.registration.attestationObject, `attestation object of ${c.section}`)
      const a = c.authentication!
      const auth = parseAuthenticatorData(fromHex(a.authenticatorData))
      assert.equal(toHex(await authData({ rpId: w3c.rpId, flags: auth.flags, signCount: auth.signCount })), a.authenticatorData, `authenticator data of ${c.section}`)
      assert.equal(toHex(toDer(derToP1363(fromHex(a.signature)))), a.signature, `DER signature of ${c.section}`)
    }
    const plain = w3c.long_credential_id
    assert.equal(
      toHex(clientData({ type: 'webauthn.create', challenge: fromHex(plain.registration.challenge), origin: w3c.origin })),
      plain.registration.clientDataJSON, 'clientDataJSON of a registration')
    assert.equal(
      toHex(clientData({ type: 'webauthn.get', challenge: fromHex(plain.authentication!.challenge), origin: w3c.origin })),
      plain.authentication!.clientDataJSON, 'clientDataJSON of an assertion')
  })
})

describe('webauthn live: a fresh authenticator on every run', () => {
  const rp = relyingParty('https://pwa.example.test')

  test('pairing registers, then unlock, elevation and one act verify, each only for what it was asked', async () => {
    const key = await authenticator()
    const sessionId = randomBytes(16)
    const pubD = (await authenticator()).pub
    const deviceId = await deviceIdOf(pubD)
    const credentialId = randomBytes(32)
    const regChal = await registrationChallenge(sessionId, pubD)
    const reg = await verifyRegistration({
      rp, challenge: regChal,
      clientDataJSON: clientData({ type: 'webauthn.create', challenge: regChal, origin: rp.origin }),
      attestationObject: attestation(await authData({ rpId: rp.rpId, flags: UP | UV | AT, signCount: 3, attested: { aaguid: new Uint8Array(16), credentialId, cose: coseEc2(key.pub) } })),
    })
    assert.ok(reg.ok)
    assert.deepEqual(
      [toHex(reg.credential.credentialId), toHex(reg.credential.publicKey), reg.credential.signCount, reg.credential.backupEligible, reg.credential.backedUp],
      [toHex(credentialId), toHex(key.pub), 3, false, false])

    const act = { purpose: 'act', op: 0x0601, actId: randomBytes(16), body: utf8('{"deviceId":"abc"}') } as const
    const contexts = [{ purpose: 'unlock' }, { purpose: 'elevate', deviceId }, act] as const
    const challenges = await Promise.all(contexts.map((ctx, i) => assertionChallenge(sessionId, i + 1, ctx)))
    assert.equal(new Set([toHex(regChal), ...challenges.map(toHex)]).size, 4)
    const credential = { publicKey: reg.credential.publicKey, signCount: reg.credential.signCount }
    for (const [i, challenge] of challenges.entries()) {
      const proof = await assertion(key, { rpId: rp.rpId, origin: rp.origin, challenge, flags: UP | UV, signCount: credential.signCount + 1 })
      for (const [j, expected] of challenges.entries()) {
        const v = await verifyAssertion({ rp, challenge: expected, proof, credential })
        if (i !== j) { assert.deepEqual(v, { ok: false, reason: 'challenge' }, `proof ${i} against challenge ${j}`); continue }
        assert.deepEqual(v, { ok: true, signCount: credential.signCount + 1, backedUp: false })
        credential.signCount = v.signCount
      }
      // The same proof again, now that the portal stored its counter.
      assert.deepEqual(await verifyAssertion({ rp, challenge, proof, credential }), { ok: false, reason: 'sign-count' })
    }
    assert.equal(credential.signCount, 6)
  })

  test('the challenge binds the session, the house behind it, the device and the act', async () => {
    const sessionId = randomBytes(16)
    const pubD = (await authenticator()).pub
    const deviceId = randomBytes(16)
    const actId = randomBytes(16)
    const body = utf8('{"a":1}')
    const all = [
      await registrationChallenge(sessionId, pubD),
      await registrationChallenge(randomBytes(16), pubD),
      await registrationChallenge(sessionId, (await authenticator()).pub),
      await assertionChallenge(sessionId, 1, { purpose: 'unlock' }),
      await assertionChallenge(randomBytes(16), 1, { purpose: 'unlock' }),
      await assertionChallenge(sessionId, 2, { purpose: 'unlock' }),
      await assertionChallenge(sessionId, 1, { purpose: 'elevate', deviceId }),
      await assertionChallenge(sessionId, 1, { purpose: 'elevate', deviceId: randomBytes(16) }),
      await assertionChallenge(sessionId, 1, { purpose: 'act', op: 0x0601, actId, body }),
      await assertionChallenge(sessionId, 1, { purpose: 'act', op: 0x0600, actId, body }),
      await assertionChallenge(sessionId, 1, { purpose: 'act', op: 0x0601, actId: randomBytes(16), body }),
      await assertionChallenge(sessionId, 1, { purpose: 'act', op: 0x0601, actId, body: utf8('{"a":2}') }),
    ]
    for (const c of all) assert.equal(c.length, 32)
    assert.equal(new Set(all.map(toHex)).size, all.length)
    assert.equal(await code(assertionChallenge(sessionId, 1, { purpose: 'lock' } as never)), 'malformed')
    assert.equal(await code(assertionChallenge(randomBytes(15), 1, { purpose: 'unlock' })), 'malformed')
    assert.equal(await code(assertionChallenge(sessionId, 1, { purpose: 'elevate', deviceId: randomBytes(15) })), 'malformed')
    assert.equal(await code(registrationChallenge(sessionId, SELF_TEST_POINTS.compressed())), 'bad-point')
  })

  test('every single bit of an assertion is covered: no flipped bit is ever accepted', async () => {
    const key = await authenticator()
    const challenge = await assertionChallenge(randomBytes(16), 1, { purpose: 'unlock' })
    const proof = await assertion(key, { rpId: rp.rpId, origin: rp.origin, challenge, flags: UP | UV | BE | BS, signCount: 9 })
    const credential = { publicKey: key.pub, signCount: 8 }
    assert.deepEqual(await verifyAssertion({ rp, challenge, proof, credential }), { ok: true, signCount: 9, backedUp: true })
    const seen = new Set<string>()
    for (const field of ['authenticatorData', 'clientDataJSON', 'signature'] as const) {
      for (let bit = 0; bit < proof[field].length * 8; bit++) {
        const bytes = concat(proof[field])
        bytes[bit >> 3] = bytes[bit >> 3]! ^ (1 << (bit & 7))
        const v = await verifyAssertion({ rp, challenge, proof: { ...proof, [field]: bytes }, credential })
        assert.equal(v.ok, false, `${field} bit ${bit}`)
        if (!v.ok) seen.add(v.reason)
      }
    }
    for (const reason of ['signature', 'malformed', 'rp-id', 'user-presence', 'user-verification', 'challenge', 'origin', 'type'] as const) {
      assert.ok(seen.has(reason), `some flipped bit is refused for ${reason}`)
    }
  })

  test('garbage never throws and never carries its bytes out: every verdict is a reason of the fixed list', async () => {
    const key = await authenticator()
    const challenge = randomBytes(32)
    const check = (v: { ok: boolean; reason?: string }, what: string): void => {
      assert.equal(v.ok, false, what)
      assert.ok(REASONS.includes(v.reason as WebAuthnFailure), `${what}: ${v.reason}`)
    }
    for (let i = 0; i < 200; i++) {
      const a = randomBytes(1 + (i * 7) % 300)
      const b = randomBytes(1 + (i * 13) % 400)
      const sig = randomBytes(1 + (i * 3) % 72)
      check(await verifyRegistration({ rp, challenge, clientDataJSON: a, attestationObject: b }), 'registration of noise')
      check(await verifyAssertion({ rp, challenge, proof: { authenticatorData: b, clientDataJSON: a, signature: sig }, credential: { publicKey: key.pub, signCount: 0 } }), 'assertion of noise')
      const cdj = clientData({ type: 'webauthn.create', challenge, origin: rp.origin })
      check(await verifyRegistration({ rp, challenge, clientDataJSON: cdj, attestationObject: b }), 'registration with a noise object')
      check(await verifyRegistration({ rp, challenge, clientDataJSON: cdj, attestationObject: attestation(concat(await sha256(ascii(rp.rpId)), u8(UP | UV | AT), b)) }), 'registration with noise credential data')
    }
    for (const empty of [EMPTY, utf8('null'), utf8('[]'), utf8('"x"'), utf8('{}'), Uint8Array.of(0xff, 0xfe)]) {
      check(await verifyRegistration({ rp, challenge, clientDataJSON: empty, attestationObject: EMPTY }), 'empty registration')
      check(await verifyAssertion({ rp, challenge, proof: { authenticatorData: EMPTY, clientDataJSON: empty, signature: EMPTY }, credential: { publicKey: key.pub, signCount: 0 } }), 'empty assertion')
    }

    const CANARY = 'CANARY-7f3a91'
    const hostile = [
      utf8(`{"type":"${CANARY}`),
      utf8(`{"type":"${CANARY}","challenge":"${CANARY}","origin":"${CANARY}"}`),
      utf8(`{"__proto__":{"type":"webauthn.create"},"constructor":"${CANARY}"}`),
    ]
    for (const cdj of hostile) {
      const v = await verifyRegistration({ rp, challenge, clientDataJSON: cdj, attestationObject: utf8(CANARY) })
      check(v, 'hostile clientDataJSON')
      assert.equal(JSON.stringify(v).includes(CANARY), false)
    }
    for (const raw of [utf8(CANARY), attestation(utf8(CANARY)), attestation(utf8(CANARY), CANARY)]) {
      for (const parse of [parseAttestationObject, parseAuthenticatorData]) {
        try { parse(raw); assert.fail('noise parsed') }
        catch (e) {
          assert.ok(e instanceof WebAuthnRefusal || e instanceof WireError)
          assert.equal(String((e as Error).message).includes(CANARY), false)
          if (e instanceof WebAuthnRefusal) assert.equal(e.message, e.reason)
        }
      }
    }
  })

  test('a member inherited by every object is not a member of clientDataJSON', async () => {
    const challenge = randomBytes(32)
    const attestationObject = attestation(await authData({ rpId: rp.rpId, flags: UP | UV | AT, signCount: 0, attested: { aaguid: new Uint8Array(16), credentialId: randomBytes(16), cose: coseEc2((await authenticator()).pub) } }))
    const proto = Object.prototype as Record<string, unknown>
    proto.type = 'webauthn.create'
    proto.challenge = b64url(challenge)
    proto.origin = rp.origin
    let polluted: unknown
    try {
      polluted = await verifyRegistration({ rp, challenge, clientDataJSON: utf8('{}'), attestationObject })
    } finally {
      delete proto.type
      delete proto.challenge
      delete proto.origin
    }
    assert.deepEqual(polluted, { ok: false, reason: 'type' })
    // Without the pollution the same object registers once clientDataJSON really carries the three members.
    const honest = await verifyRegistration({ rp, challenge, clientDataJSON: clientData({ type: 'webauthn.create', challenge, origin: rp.origin }), attestationObject })
    assert.equal(honest.ok, true)
  })

  test('what the caller owns is checked loudly, and the relying party is validated once', async () => {
    const key = await authenticator()
    const proof = { authenticatorData: EMPTY, clientDataJSON: EMPTY, signature: EMPTY }
    assert.equal(await code(verifyRegistration({ rp, challenge: randomBytes(31), clientDataJSON: EMPTY, attestationObject: EMPTY })), 'malformed')
    assert.equal(await code(verifyAssertion({ rp, challenge: randomBytes(33), proof, credential: { publicKey: key.pub, signCount: 0 } })), 'malformed')
    for (const signCount of [-1, 1.5, 2 ** 32, Number.NaN]) {
      assert.equal(await code(verifyAssertion({ rp, challenge: randomBytes(32), proof, credential: { publicKey: key.pub, signCount } })), 'range')
    }

    assert.deepEqual(relyingParty('https://pwa.example.test'), { origin: 'https://pwa.example.test', rpId: 'pwa.example.test' })
    assert.deepEqual(relyingParty('https://pwa.example.test:8443', 'example.test'), { origin: 'https://pwa.example.test:8443', rpId: 'example.test' })
    assert.deepEqual(relyingParty('http://localhost:5173'), { origin: 'http://localhost:5173', rpId: 'localhost' })
    assert.ok(Object.isFrozen(relyingParty('https://pwa.example.test')))
    const bad: [string, string?][] = [
      ['https://pwa.example.test/'], ['https://pwa.example.test/app'], ['https://PWA.example.test'], ['https://pwa.example.test:443'],
      ['http://pwa.example.test'], ['http://127.0.0.1:5173'], ['https://10.0.0.7'], ['https://[::1]'], ['https://user@pwa.example.test'],
      ['pwa.example.test'], ['wss://pwa.example.test'], [''], ['https://pwa.example.test?x=1'],
      ['https://pwa.example.test', 'other.test'], ['https://pwa.example.test', 'test'], ['https://pwa.example.test', 'a.pwa.example.test'],
      ['https://pwa.example.test', 'xample.test'], ['https://pwa.example.test', 'Example.test'], ['https://pwa.example.test', ''],
    ]
    for (const [origin, rpId] of bad) assert.throws(() => relyingParty(origin, rpId), (e: unknown) => e instanceof WireError && e.code === 'malformed', `${origin} ${rpId ?? ''}`)
  })

  test('the public surface carries the verifiers and the challenges, and none of the parsing', () => {
    const names = Object.keys(remote)
    for (const expected of ['relyingParty', 'registrationChallenge', 'assertionChallenge', 'verifyRegistration', 'verifyAssertion', 'WEBAUTHN_LIMITS']) {
      assert.ok(names.includes(expected), `${expected} is exported`)
    }
    for (const hidden of ['parseAuthenticatorData', 'parseAttestationObject', 'WebAuthnRefusal', 'AUTH_FLAG']) {
      assert.equal(names.includes(hidden), false, `${hidden} must not be public`)
    }
    assert.deepEqual(WEBAUTHN_LIMITS, { clientDataJSON: 1024, attestationObject: 4096, authenticatorData: 1155, credentialId: 1023, signature: 72 })
  })
})
