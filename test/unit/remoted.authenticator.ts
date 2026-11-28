// A software authenticator (the encodings of test/unit/remote.webauthn.test.ts) and the presence ceremonies as the PWA runs
// them, for the tests that need a device with a presence credential: register it in the pairing session, unlock, elevate,
// prove an act. The relying party is ORIGIN (a house bench started with `origin: ORIGIN`, or a remote with that webUrl).
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { ascii, b64url, concat, fromB64url, u16, u32, u8, utf8, type Bytes } from '../../src/remote/bytes.ts'
import { sha256 } from '../../src/remote/crypto.ts'
import { assertionChallenge, registrationChallenge, RES_STATUS, type UvProof } from '../../src/remote/index.ts'
import { AUTH_FLAG } from '../../src/remote/webauthn.ts'
import type { DeviceSession } from './remoted.helpers.ts'

export const ORIGIN = 'https://pwa.example'
export const RP_ID = 'pwa.example'
export const UV_OP = { challenge: 0x0003, assert: 0x0004, register: 0x0005 }
const { UP, UV, AT } = AUTH_FLAG
const subtle = globalThis.crypto.subtle
export const actId = (): Bytes => new Uint8Array(randomBytes(16))

const cborHead = (major: number, n: number): Bytes =>
  n < 24 ? u8((major << 5) | n) : n < 0x100 ? concat(u8((major << 5) | 24), u8(n)) : concat(u8((major << 5) | 25), u16(n))
const cInt = (v: number): Bytes => (v >= 0 ? cborHead(0, v) : cborHead(1, -1 - v))
const cBytes = (b: Uint8Array): Bytes => concat(cborHead(2, b.length), b)
const cText = (s: string): Bytes => concat(cborHead(3, s.length), ascii(s))
const cMap = (...pairs: (readonly [Uint8Array, Uint8Array])[]): Bytes => concat(cborHead(5, pairs.length), ...pairs.flatMap((p) => [p[0], p[1]]))
const coseEc2 = (pub: Uint8Array): Bytes =>
  cMap([cInt(1), cInt(2)], [cInt(3), cInt(-7)], [cInt(-1), cInt(1)], [cInt(-2), cBytes(pub.subarray(1, 33))], [cInt(-3), cBytes(pub.subarray(33))])
const clientData = (type: string, challenge: Uint8Array, origin: string): Bytes =>
  utf8(`{"type":"${type}","challenge":"${b64url(challenge)}","origin":"${origin}","crossOrigin":false}`)
const derInt = (x: Uint8Array): Bytes => {
  let i = 0
  while (i < x.length - 1 && x[i] === 0) i++
  const mag = x.subarray(i)
  const body = mag[0]! & 0x80 ? concat(u8(0), mag) : concat(mag)
  return concat(u8(0x02), u8(body.length), body)
}
const toDer = (sig: Uint8Array): Bytes => {
  const c = concat(derInt(sig.subarray(0, 32)), derInt(sig.subarray(32)))
  return concat(u8(0x30), u8(c.length), c)
}

export class SoftAuthenticator {
  readonly credentialId: Bytes = new Uint8Array(randomBytes(16))
  pub!: Bytes
  #key!: CryptoKeyPair

  static async make(): Promise<SoftAuthenticator> {
    const a = new SoftAuthenticator()
    a.#key = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
    a.pub = new Uint8Array(await subtle.exportKey('raw', a.#key.publicKey))
    return a
  }

  async #authData(flags: number, signCount: number, attested?: Uint8Array): Promise<Bytes> {
    return concat(await sha256(ascii(RP_ID)), u8(flags), u32(signCount), attested ?? new Uint8Array(0))
  }

  /** The answer of navigator.credentials.create, as the body of uv.register. */
  async register(challenge: Uint8Array, o: { origin?: string } = {}): Promise<{ clientDataJSON: string; attestationObject: string }> {
    const attested = concat(new Uint8Array(16), u16(this.credentialId.length), this.credentialId, coseEc2(this.pub))
    const ad = await this.#authData(UP | UV | AT, 0, attested)
    const att = cMap([cText('fmt'), cText('none')], [cText('attStmt'), cMap()], [cText('authData'), cBytes(ad)])
    return { clientDataJSON: b64url(clientData('webauthn.create', challenge, o.origin ?? ORIGIN)), attestationObject: b64url(att) }
  }

  /** The answer of navigator.credentials.get, as the uvProof of the envelope. */
  async assert(challenge: Uint8Array, uvCtr: number, o: { signCount?: number; origin?: string } = {}): Promise<UvProof> {
    const authenticatorData = await this.#authData(UP | UV, o.signCount ?? 0)
    const clientDataJSON = clientData('webauthn.get', challenge, o.origin ?? ORIGIN)
    const raw = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.#key.privateKey, concat(authenticatorData, await sha256(clientDataJSON))))
    return { uvCtr, authenticatorData, clientDataJSON, signature: toDer(raw) }
  }
}

// ---- the ceremonies as the PWA runs them -------------------------------------------------------------------------

export async function challenge(s: DeviceSession, purpose: 'unlock' | 'elevate'): Promise<{ uvCtr: number; challenge: Bytes }> {
  const c = await s.request(UV_OP.challenge, { purpose })
  assert.equal(c.status, RES_STATUS.ok, `uv.challenge ${purpose}`)
  return { uvCtr: c.body.uvCtr as number, challenge: fromB64url(c.body.challenge as string) }
}

export async function present(s: DeviceSession, a: SoftAuthenticator, purpose: 'unlock' | 'elevate' = 'unlock', o: { signCount?: number; origin?: string } = {}) {
  const c = await challenge(s, purpose)
  return s.request(UV_OP.assert, {}, { actId: actId(), uvProof: await a.assert(c.challenge, c.uvCtr, o) })
}

/** An act with its proof: the challenge computed by the device from the exact bytes it sends. */
export async function act(s: DeviceSession, a: SoftAuthenticator, op: number, body: Record<string, unknown>, o: { signCount?: number; proof?: boolean } = {}) {
  const raw = utf8(JSON.stringify(body))
  const id = actId()
  if (o.proof === false) return s.request(op, {}, { actId: id, raw })
  const c = await s.request(UV_OP.challenge, { purpose: 'act', op })
  assert.equal(c.status, RES_STATUS.ok, 'uv.challenge act')
  assert.equal(c.body.challenge, undefined, 'an act challenge is computed from the request, not handed out')
  const chal = await assertionChallenge(s.session.sessionId, c.body.uvCtr as number, { purpose: 'act', op, actId: id, body: raw })
  return s.request(op, {}, { actId: id, raw, uvProof: await a.assert(chal, c.body.uvCtr as number, o) })
}

/**
 * The pairing session registers the credential (uv.register) and unlocks (uv.assert): from then on the device holds a
 * usable credential, and that session is unlocked. Returns the authenticator, for the next sessions' unlocks.
 */
export async function registerAndUnlock(fresh: DeviceSession, pubD: Bytes): Promise<SoftAuthenticator> {
  const auth = await SoftAuthenticator.make()
  const reg = await fresh.request(UV_OP.register, await auth.register(await registrationChallenge(fresh.session.sessionId, pubD)), { actId: actId() })
  assert.equal(reg.status, RES_STATUS.ok, `uv.register: ${JSON.stringify(reg.body)}`)
  const un = await present(fresh, auth)
  assert.equal(un.status, RES_STATUS.ok, `uv.assert: ${JSON.stringify(un.body)}`)
  return auth
}
