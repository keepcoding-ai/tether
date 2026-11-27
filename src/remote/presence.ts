// Presence on the wire (spec 7.4): the challenges the portal computes and the strict DER-to-P1363 conversion of a
// WebAuthn signature (E-13). The WebAuthn verification itself (clientDataJSON, authenticatorData, origin, UP and UV bits)
// is webauthn.ts; the state it opens (unlocked, the elevation window, the lockout) is the portal's (src/remoted/uv.ts).
import { concat, fail, Reader, u16, u32, u8, type Bytes } from './bytes.ts'
import { ELEV_WINDOW_S, LBL } from './constants.ts'
import { hasPointShape, sha256 } from './crypto.ts'

export const UV_PURPOSE = { unlock: 0x01, elevate: 0x02, act: 0x03 } as const
export type UvPurpose = (typeof UV_PURPOSE)[keyof typeof UV_PURPOSE]

const sized = (b: Uint8Array, n: number, what: string): Uint8Array => (b.length === n ? b : fail('malformed', `${what} must be ${n} bytes`))

/** `chal = H(LBL("uv") ‖ sessionId(16) ‖ u32(uvCtr) ‖ purpose(1) ‖ digest(32))` */
export function uvChallenge(sessionId: Uint8Array, uvCtr: number, purpose: UvPurpose, digest: Uint8Array): Promise<Bytes> {
  if (purpose !== UV_PURPOSE.unlock && purpose !== UV_PURPOSE.elevate && purpose !== UV_PURPOSE.act) fail('malformed', 'uv purpose')
  return sha256(LBL('uv'), sized(sessionId, 16, 'sessionId'), u32(uvCtr), u8(purpose), sized(digest, 32, 'digest'))
}

/** The digest of an unlock: 32 zero bytes. */
export const unlockDigest = (): Bytes => new Uint8Array(32)

/** The digest of an elevation: `H(LBL("uv-window") ‖ deviceId ‖ u16(ELEV_WINDOW in seconds))`. */
export const elevateDigest = (deviceId: Uint8Array): Promise<Bytes> =>
  sha256(LBL('uv-window'), sized(deviceId, 16, 'deviceId'), u16(ELEV_WINDOW_S))

/**
 * The digest of one act: `H(LBL("act") ‖ u16(op) ‖ actId ‖ H(JSON body bytes))`. The portal computes it from the
 * request it actually received, never from what was announced.
 */
export const actDigest = async (op: number, actId: Uint8Array, body: Uint8Array): Promise<Bytes> =>
  sha256(LBL('act'), u16(op), sized(actId, 16, 'actId'), await sha256(body))

/** The challenge of the one registration a pairing allows: `H(LBL("uv-reg") ‖ sessionId ‖ pub_D)`. */
export function uvRegChallenge(sessionId: Uint8Array, pubD: Uint8Array): Promise<Bytes> {
  if (!hasPointShape(pubD)) fail('bad-point', 'pub_D shape')
  return sha256(LBL('uv-reg'), sized(sessionId, 16, 'sessionId'), pubD)
}

// The order of the P-256 group.
const N = Uint8Array.of(
  0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
  0xbc, 0xe6, 0xfa, 0xad, 0xa7, 0x17, 0x9e, 0x84, 0xf3, 0xb9, 0xca, 0xc2, 0xfc, 0x63, 0x25, 0x51,
)

/** One DER INTEGER as a 32-byte big-endian scalar in [1, n − 1]: minimal encoding, positive, nothing else. */
function derScalar(r: Reader): Bytes {
  if (r.u8() !== 0x02) fail('malformed', 'DER: INTEGER expected')
  const len = r.u8()
  if (len < 1 || len > 33) fail('malformed', 'DER: INTEGER length')
  const v = r.take(len)
  if (v[0]! & 0x80) fail('malformed', 'DER: negative INTEGER')
  if (v[0] === 0 && (len === 1 || !(v[1]! & 0x80))) fail('malformed', 'DER: zero or non-minimal INTEGER')
  const mag = v[0] === 0 ? v.subarray(1) : v
  if (mag.length > 32) fail('malformed', 'DER: INTEGER above 256 bits')
  const out = new Uint8Array(32)
  out.set(mag, 32 - mag.length)
  let below = false
  for (let i = 0; i < 32; i++) {
    if (out[i]! < N[i]!) { below = true; break }
    if (out[i]! > N[i]!) break
  }
  if (!below) fail('malformed', 'DER: scalar not below the group order')
  return out
}

/**
 * A WebAuthn ES256 signature from DER to P1363, strictly (E-13): a SEQUENCE of exactly two INTEGERs, minimal
 * lengths, at most one leading zero, r and s in [1, n − 1], no byte left over. Any deviation is refused.
 */
export function derToP1363(der: Uint8Array): Bytes {
  const r = new Reader(der)
  if (r.u8() !== 0x30) fail('malformed', 'DER: SEQUENCE expected')
  // Two INTEGERs of at most 35 bytes each: the length always fits the short form, so the long form is not minimal.
  const len = r.u8()
  if (len >= 0x80 || len !== r.remaining) fail('malformed', 'DER: SEQUENCE length')
  const out = concat(derScalar(r), derScalar(r))
  r.end()
  return out
}
