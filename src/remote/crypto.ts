// Primitives of the remote wire over crypto.subtle (spec 0.1, 0.3, 1.4, 4.4): SHA-256, HKDF-SHA-256, ECDH and ECDSA
// on P-256, AES-256-GCM. The same code runs on Node 24 and in a browser. Private keys and AES keys only ever exist as
// non-extractable CryptoKey; intermediate secret bytes are wiped after use (best effort).
import { concat, copy, fail, isZero, randomBytes, wipe, WireError, type Bytes } from './bytes.ts'
import { isValidAudBytes } from './aud.ts'
import { LBL, type LabelName } from './constants.ts'

const subtle = (): SubtleCrypto => globalThis.crypto.subtle
const P256 = 'P-256'

export async function sha256(...parts: readonly Uint8Array[]): Promise<Bytes> {
  return new Uint8Array(await subtle().digest('SHA-256', concat(...parts)))
}

// ---------------------------------------------------------------------------------------------------------------
// Point validation and the start-up self-test (spec 0.3 rule 5, 4.4, 11 Q1 and Q2)
// ---------------------------------------------------------------------------------------------------------------

const hexBytes = (s: string): Bytes => {
  const out = new Uint8Array(s.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16)
  return out
}

// The P-256 base point. Its Y is odd, so the compressed form starts with 0x03 and the hybrid form with 0x07.
const GX = hexBytes('6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296')
const GY = hexBytes('4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5')
const GY_OFF = hexBytes('4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f4')

/** Fixed points of the self-test and of vector V-11. Only `valid` is a key this module accepts. */
export const SELF_TEST_POINTS = {
  valid: (): Bytes => concat(Uint8Array.of(0x04), GX, GY),
  offCurve: (): Bytes => concat(Uint8Array.of(0x04), GX, GY_OFF),
  compressed: (): Bytes => concat(Uint8Array.of(0x03), GX),
  hybrid: (): Bytes => concat(Uint8Array.of(0x07), GX, GY),
  badPrefix: (): Bytes => concat(Uint8Array.of(0x05), GX, GY),
  short64: (): Bytes => concat(GX, GY),
} as const

/** Our own check, before the platform sees the bytes: exactly 65 bytes and the uncompressed prefix (spec 4.4 rule 1). */
export function hasPointShape(pub: Uint8Array): boolean {
  return pub.length === 65 && pub[0] === 0x04
}

type EcAlg = 'ECDH' | 'ECDSA'

const platformImport = (pub: Bytes, alg: EcAlg): Promise<CryptoKey> =>
  subtle().importKey('raw', pub, { name: alg, namedCurve: P256 }, true, alg === 'ECDSA' ? ['verify'] : [])

async function runSelfTest(): Promise<void> {
  const broken = (why: string): never => fail('self-test', why)
  // (a) the platform refuses a point off the curve that has the right size and prefix, and accepts a valid one.
  for (const alg of ['ECDH', 'ECDSA'] as const) {
    try { await platformImport(SELF_TEST_POINTS.valid(), alg) } catch { broken(`the platform refuses a valid ${alg} point`) }
    let accepted = false
    try { await platformImport(SELF_TEST_POINTS.offCurve(), alg); accepted = true } catch { /* expected */ }
    if (accepted) broken(`the platform accepts an ${alg} point off the curve`)
  }
  // (b) our import refuses compressed, hybrid, wrong-prefix and 64-byte encodings before the platform is called.
  if (!hasPointShape(SELF_TEST_POINTS.valid())) broken('shape check refuses a valid point')
  for (const name of ['compressed', 'hybrid', 'badPrefix', 'short64'] as const) {
    if (hasPointShape(SELF_TEST_POINTS[name]())) broken(`shape check accepts a ${name} point`)
  }
}

let selfTestResult: Promise<void> | undefined

/**
 * The start-up self-test, memoised. Every operation that imports a key awaits it, so nothing operates before it
 * passes, and a platform that fails it makes the module refuse to operate for good. Call it at start-up to fail early.
 */
export function selfTest(): Promise<void> {
  selfTestResult ??= runSelfTest()
  return selfTestResult
}

async function importPoint(pub: Uint8Array, alg: EcAlg): Promise<CryptoKey> {
  await selfTest()
  if (!hasPointShape(pub)) fail('bad-point', 'not an uncompressed 65-byte point')
  try { return await platformImport(copy(pub), alg) }
  catch { return fail('bad-point', 'not a point of the curve') }
}

/** Throws `bad-point` unless `pub` is an uncompressed P-256 point on the curve. */
export async function validatePoint(pub: Uint8Array): Promise<void> { await importPoint(pub, 'ECDSA') }

export async function isValidPoint(pub: Uint8Array): Promise<boolean> {
  try { await validatePoint(pub); return true }
  catch (e) { if (e instanceof WireError && e.code === 'bad-point') return false; throw e }
}

// ---------------------------------------------------------------------------------------------------------------
// HKDF and ECDH
// ---------------------------------------------------------------------------------------------------------------

/** HKDF-SHA-256 (RFC 5869, extract and expand) over raw input keying material. For vectors and public derivations. */
export async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, n: number): Promise<Bytes> {
  const key = await subtle().importKey('raw', copy(ikm), 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: copy(salt), info: copy(info) }, key, n * 8))
}

export interface Ephemeral { readonly pub: Bytes; readonly privateKey: CryptoKey }

export async function generateEphemeral(): Promise<Ephemeral> {
  await selfTest()
  const pair = await subtle().generateKey({ name: 'ECDH', namedCurve: P256 }, false, ['deriveBits'])
  return { pub: new Uint8Array(await subtle().exportKey('raw', pair.publicKey)), privateKey: pair.privateKey }
}

/** The raw ECDH X coordinate (32 bytes). The peer point is validated; an all-zero result is refused (spec 4.4). */
export async function ecdhBits(own: CryptoKey, peerPub: Uint8Array): Promise<Bytes> {
  const peer = await importPoint(peerPub, 'ECDH')
  const z = new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: peer }, own, 256))
  if (z.length !== 32 || isZero(z)) { wipe(z); fail('bad-point', 'degenerate shared secret') }
  return z
}

/**
 * The shared secret Z of one handshake, held as a non-extractable HKDF key. Every derivation is
 * `KDF(Z, salt, name, n)` of spec 0.1; AES keys are derived straight into non-extractable CryptoKeys.
 */
export class Secret {
  #key: CryptoKey | undefined

  private constructor(key: CryptoKey) { this.#key = key }

  static async agree(own: CryptoKey, peerPub: Uint8Array): Promise<Secret> {
    const z = await ecdhBits(own, peerPub)
    try { return new Secret(await subtle().importKey('raw', z, 'HKDF', false, ['deriveBits', 'deriveKey'])) }
    finally { wipe(z) }
  }

  #live(): CryptoKey { return this.#key ?? fail('bad-state', 'the shared secret was already discarded') }

  /** `info` is the full info string: a label, possibly followed by a body (pair-confirm). */
  async bits(salt: Uint8Array, info: Uint8Array, n: number): Promise<Bytes> {
    const p = { name: 'HKDF', hash: 'SHA-256', salt: copy(salt), info: copy(info) }
    return new Uint8Array(await subtle().deriveBits(p, this.#live(), n * 8))
  }

  async aesKey(salt: Uint8Array, name: LabelName, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
    const p = { name: 'HKDF', hash: 'SHA-256', salt: copy(salt), info: LBL(name) }
    return subtle().deriveKey(p, this.#live(), { name: 'AES-GCM', length: 256 }, false, [usage])
  }

  destroy(): void { this.#key = undefined }
}

// ---------------------------------------------------------------------------------------------------------------
// AEAD
// ---------------------------------------------------------------------------------------------------------------

const TAG_BITS = 128

export async function aeadSeal(key: CryptoKey, iv: Uint8Array, aad: Uint8Array, pt: Uint8Array): Promise<Bytes> {
  const p = { name: 'AES-GCM', iv: copy(iv), additionalData: copy(aad), tagLength: TAG_BITS }
  return new Uint8Array(await subtle().encrypt(p, key, copy(pt)))
}

export async function aeadOpen(key: CryptoKey, iv: Uint8Array, aad: Uint8Array, ct: Uint8Array): Promise<Bytes> {
  const p = { name: 'AES-GCM', iv: copy(iv), additionalData: copy(aad), tagLength: TAG_BITS }
  try { return new Uint8Array(await subtle().decrypt(p, key, copy(ct))) }
  catch { return fail('auth', 'AEAD open failed') }
}

/**
 * A handshake key (`k_hs_*`): it protects exactly one message, with a zero IV. The key is consumed by its first use,
 * so a second seal or open under it cannot be written (spec 3.5).
 */
export class OneShotKey {
  #key: CryptoKey | undefined

  constructor(key: CryptoKey) { this.#key = key }

  #take(): CryptoKey {
    const k = this.#key ?? fail('bad-state', 'a handshake key protects exactly one message')
    this.#key = undefined
    return k
  }

  seal(aad: Uint8Array, pt: Uint8Array): Promise<Bytes> { return aeadSeal(this.#take(), new Uint8Array(12), aad, pt) }
  open(aad: Uint8Array, ct: Uint8Array): Promise<Bytes> { return aeadOpen(this.#take(), new Uint8Array(12), aad, ct) }
}

// ---------------------------------------------------------------------------------------------------------------
// Signatures: ECDSA P-256 with SHA-256, IEEE P1363 (r ‖ s, exactly 64 bytes), always over LBL(label) ‖ body
// ---------------------------------------------------------------------------------------------------------------

export type SignLabel =
  | 'house-hs' | 'device-hs' | 'house-pair' | 'device-pair' | 'key-cert' | 'key-rotate' | 'key-rotate-accept'
  | 'relay-auth' | 'relay-admit' | 'relay-pop'

export type KeyRole = 'house' | 'relay' | 'ticket' | 'device' | 'admission'

/** One key, one purpose (C-2.3): the labels each role may sign, and nothing else. K_V (VAPID) signs none of them. */
export const ROLE_LABELS: Record<KeyRole, readonly SignLabel[]> = {
  house: ['house-hs', 'house-pair', 'key-cert', 'key-rotate', 'key-rotate-accept'],
  relay: ['relay-auth'],
  ticket: ['relay-admit'],
  device: ['device-hs', 'device-pair'],
  admission: ['relay-pop'],
}

const FIXED_BODY: Partial<Record<SignLabel, number>> = {
  'house-hs': 32, 'device-hs': 96, 'house-pair': 32, 'device-pair': 32, 'key-cert': 115, 'key-rotate': 118,
  'key-rotate-accept': 182,
}
export const RELAY_AUTH_FIXED = 104 // houseId(32) ‖ r(32) ‖ c(32) ‖ u64(ts)
export const RELAY_POP_FIXED = 112 // houseId(32) ‖ ticketId(16) ‖ n_R(32) ‖ n_D(32)
export const ADMIT_BODY_FIXED = 138 // 0x01 ‖ houseId(32) ‖ ktId(8) ‖ ticketId(16) ‖ pub_A(65) ‖ u64 ‖ u64

/**
 * The exact size every signed body must have (spec 1.4 rule of verification, E-3). In the bodies that carry
 * `lp8(aud)` the size is the fixed part + 1 + len(aud) and the `aud` bytes must be valid. Checked before signing and
 * before verifying.
 */
export function bodySizeOk(label: SignLabel, body: Uint8Array): boolean {
  const fixed = FIXED_BODY[label]
  if (fixed !== undefined) return body.length === fixed
  if (label === 'relay-admit') {
    if (body.length < ADMIT_BODY_FIXED + 1) return false
    const a = body[ADMIT_BODY_FIXED]!
    return body.length === ADMIT_BODY_FIXED + 1 + a && isValidAudBytes(body.subarray(ADMIT_BODY_FIXED + 1))
  }
  const rest = label === 'relay-auth' ? RELAY_AUTH_FIXED : RELAY_POP_FIXED
  if (body.length < 1) return false
  const a = body[0]!
  return body.length === 1 + a + rest && isValidAudBytes(body.subarray(1, 1 + a))
}

const ECDSA = { name: 'ECDSA', hash: 'SHA-256' } as const

/** A key in its role: it signs only the labels of that role, and only bodies of the exact size (spec 11 Q23). */
export interface RoleKey {
  readonly role: KeyRole
  readonly pub: Bytes
  sign(label: SignLabel, body: Uint8Array): Promise<Bytes>
}

export function assertSignable(role: KeyRole, label: SignLabel, body: Uint8Array): void {
  if (!ROLE_LABELS[role].includes(label)) fail('bad-label', `a ${role} key does not sign ${label}`)
  if (!bodySizeOk(label, body)) fail('bad-label', `${label} body of the wrong size`)
}

/** Wraps a private ECDSA CryptoKey (non-extractable in production) and its public point as a key of one role. */
export function roleKey(role: KeyRole, privateKey: CryptoKey, pub: Uint8Array): RoleKey {
  if (!hasPointShape(pub)) fail('bad-point', 'public key shape')
  const ownPub = copy(pub)
  return {
    role,
    pub: ownPub,
    async sign(label, body) {
      assertSignable(role, label, body)
      const sig = new Uint8Array(await subtle().sign(ECDSA, privateKey, concat(LBL(label), body)))
      if (sig.length !== 64) fail('auth', 'the platform did not produce a P1363 signature')
      return sig
    },
  }
}

/** A fresh key of one role. Non-extractable unless the caller needs to persist it to a file (the house, step 1.3). */
export async function generateRoleKey(
  role: KeyRole, opts: { extractable?: boolean } = {},
): Promise<{ key: RoleKey; privateKey: CryptoKey; pub: Bytes }> {
  await selfTest()
  const pair = await subtle().generateKey({ name: 'ECDSA', namedCurve: P256 }, opts.extractable ?? false, ['sign', 'verify'])
  const pub = new Uint8Array(await subtle().exportKey('raw', pair.publicKey))
  return { key: roleKey(role, pair.privateKey, pub), privateKey: pair.privateKey, pub }
}

/**
 * Verifies `Sign(K, LBL(label) ‖ body)`. A signature that is not exactly 64 bytes (63, 65, DER), a body of the wrong
 * size or a key that is not a valid point is refused without verifying.
 */
export async function verifyLabeled(pub: Uint8Array, label: SignLabel, body: Uint8Array, sig: Uint8Array): Promise<boolean> {
  if (sig.length !== 64 || !bodySizeOk(label, body)) return false
  let key: CryptoKey
  try { key = await importPoint(pub, 'ECDSA') }
  catch (e) { if (e instanceof WireError && e.code === 'bad-point') return false; throw e }
  return subtle().verify(ECDSA, key, copy(sig), concat(LBL(label), body))
}

// ---------------------------------------------------------------------------------------------------------------
// Randomness
// ---------------------------------------------------------------------------------------------------------------

/**
 * Where nonces and ephemeral keys come from. The default is the platform. The parameter that carries it through the
 * state machines is a test-only seam (spec 11 Q22): production code never passes one, and the fixed implementation,
 * which imports private keys, lives only in testing.ts.
 */
export interface Entropy {
  random(n: number): Bytes
  ephemeral(): Promise<Ephemeral>
}

export const systemEntropy: Entropy = { random: randomBytes, ephemeral: generateEphemeral }

/** `n` decimal digits as ASCII bytes, uniform: drawn by rejection, without modulo bias (spec 0.3 rule 2). */
export function randomDigits(n: number, entropy: Entropy = systemEntropy): Bytes {
  const out = new Uint8Array(n)
  let at = 0
  while (at < n) {
    const pool = entropy.random(2 * (n - at))
    for (let i = 0; i < pool.length && at < n; i++) if (pool[i]! < 250) out[at++] = 0x30 + (pool[i]! % 10)
    wipe(pool)
  }
  return out
}
