// The hash-chained transcripts of the two handshakes (spec 3.5 and 4.2) and the values derived from them. Only
// binary fields in fixed order enter a transcript: no JSON, no routeId, nothing that came from the relay.
import { concat, fail, lp16, u8, type Bytes } from './bytes.ts'
import { LBL, MODE_PAIR, MODE_SESSION } from './constants.ts'
import { sha256, type Secret } from './crypto.ts'

const step = (prev: Uint8Array, n: number, ...parts: Uint8Array[]): Promise<Bytes> => sha256(prev, u8(n), ...parts)
const h32 = (x: Uint8Array, what: string): Uint8Array => (x.length === 32 ? x : fail('malformed', `${what} must be 32 bytes`))

/** `TH0 = H(LBL("th") ‖ mode ‖ ver ‖ suite)`: version and suite are under both signatures (spec 2.5 rule 5). */
export const th0 = (mode: typeof MODE_PAIR | typeof MODE_SESSION, ver: number, suite: number): Promise<Bytes> =>
  sha256(LBL('th'), u8(mode), u8(ver), u8(suite))

/** `TH2 = H(TH1 ‖ 0x02 ‖ e_H ‖ N_H ‖ pub_H ‖ houseId)`, the same shape in both modes. */
export const th2 = (th1: Uint8Array, eH: Uint8Array, nH: Uint8Array, pubH: Uint8Array, houseId: Uint8Array): Promise<Bytes> =>
  step(h32(th1, 'TH1'), 0x02, eH, nH, pubH, houseId)

// Session handshake, mode 0x02 (spec 4.2)
export const session = {
  th0: (ver: number, suite: number): Promise<Bytes> => th0(MODE_SESSION, ver, suite),
  /** TH1 covers the body of HS1. */
  th1: (t0: Uint8Array, ver: number, suite: number, eD: Uint8Array, nD: Uint8Array): Promise<Bytes> =>
    step(t0, 0x01, u8(ver), u8(suite), eD, nD),
  th3: (t2: Uint8Array, ct2: Uint8Array): Promise<Bytes> => step(t2, 0x03, ct2),
  th4: (t3: Uint8Array, pubD: Uint8Array): Promise<Bytes> => step(t3, 0x04, pubD),
  th5: (t4: Uint8Array, ct3: Uint8Array): Promise<Bytes> => step(t4, 0x05, ct3),
} as const

// Pairing, mode 0x01 (spec 3.5)
export const pair = {
  th0: (ver: number, suite: number): Promise<Bytes> => th0(MODE_PAIR, ver, suite),
  /** TH1 covers the body of P1. */
  th1: (t0: Uint8Array, ver: number, suite: number, rv: Uint8Array, commit: Uint8Array): Promise<Bytes> =>
    step(t0, 0x01, u8(ver), u8(suite), rv, commit),
  th3: (t2: Uint8Array, eD: Uint8Array, nD: Uint8Array): Promise<Bytes> => step(t2, 0x03, eD, nD),
  /** TH4 is the last transcript the SAS depends on: only committed values, no signature (C-1.2, F-1). */
  th4: (t3: Uint8Array, deviceHello: Uint8Array): Promise<Bytes> => step(t3, 0x04, lp16(deviceHello)),
  th5: (t4: Uint8Array, ct3: Uint8Array): Promise<Bytes> => step(t4, 0x05, lp16(ct3)),
  th6: (t5: Uint8Array, ct4: Uint8Array): Promise<Bytes> => step(t5, 0x06, ct4),
  /** `commit = H(LBL("pair-commit") ‖ e_D ‖ N_D ‖ lp16(DeviceHello))` (C-1.1). */
  commit: (eD: Uint8Array, nD: Uint8Array, deviceHello: Uint8Array): Promise<Bytes> =>
    sha256(LBL('pair-commit'), eD, nD, lp16(deviceHello)),
  /** `rv = H(LBL("pair-rv") ‖ R)[0..16]`: the meeting point the relay sees. */
  rv: async (R: Uint8Array): Promise<Bytes> => (await sha256(LBL('pair-rv'), R)).slice(0, 16),
} as const

/** The six SAS digits as ASCII, from the four bytes of `KDF(Z, TH4, "sas", 4)`: u32 mod 10^6, zero-padded. */
export function sasFromBits(bits: Uint8Array): Bytes {
  if (bits.length !== 4) fail('malformed', 'SAS bits')
  const v = (((bits[0]! << 24) | (bits[1]! << 16) | (bits[2]! << 8) | bits[3]!) >>> 0) % 1_000_000
  const s = String(v).padStart(6, '0')
  return Uint8Array.from(s, c => c.charCodeAt(0))
}

export const sasOf = async (z: Secret, t4: Uint8Array): Promise<Bytes> => sasFromBits(await z.bits(t4, LBL('sas'), 4))

/** `houseConfirm = HKDF(Z, salt = TH6, info = LBL("pair-confirm") ‖ lp8(S), 32)`: the only place S is ever used. */
export const houseConfirmOf = (z: Secret, t6: Uint8Array, S: Uint8Array): Promise<Bytes> => {
  if (S.length > 0xff) fail('too-large', 'S')
  return z.bits(t6, concat(LBL('pair-confirm'), u8(S.length), S), 32)
}
