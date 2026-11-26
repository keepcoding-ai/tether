// The record layer (spec 4.5): two AES-256-GCM keys, one per direction, and one 64-bit counter per direction per
// session. The counter travels in clear for diagnosis, but the receiver builds nonce and AAD from the value it
// expects: a repeated, skipped or earlier counter closes. There is no sliding window (the transport is ordered).
import { concat, fail, u64, u8, WireError, type Bytes } from './bytes.ts'
import { DIR_D2H, DIR_H2D, LBL, MAX_INNER, REKEY_AGE_MS, REKEY_BYTES, REKEY_FRAMES } from './constants.ts'
import { padPlaintext, unpadPlaintext, type ContentType } from './content.ts'
import { aeadOpen, aeadSeal } from './crypto.ts'
import { decodeInner, encodeInner, ITYPE } from './frames.ts'

export type Dir = typeof DIR_D2H | typeof DIR_H2D

/** `nonce = 0x00000000 ‖ u64(ctr)`. */
export const recordNonce = (ctr: number): Bytes => concat(new Uint8Array(4), u64(ctr))

/** `AAD = LBL("rec") ‖ sessionId(16) ‖ dir(1) ‖ u64(ctr) ‖ 0x20`. */
export function recordAad(sessionId: Uint8Array, dir: Dir, ctr: number): Bytes {
  if (sessionId.length !== 16) fail('malformed', 'sessionId must be 16 bytes')
  return concat(LBL('rec'), sessionId, u8(dir), u64(ctr), u8(ITYPE.REC))
}

/** Seals one padded plaintext at an explicit counter and returns the whole REC inner frame. */
export async function sealRecordAt(key: CryptoKey, sessionId: Uint8Array, dir: Dir, ctr: number, plaintext: Uint8Array): Promise<Bytes> {
  const sealed = await aeadSeal(key, recordNonce(ctr), recordAad(sessionId, dir, ctr), plaintext)
  return encodeInner({ type: 'REC', ctr, sealed })
}

/** Opens `ct ‖ tag` at the counter the receiver expects. */
export const openRecordAt = (key: CryptoKey, sessionId: Uint8Array, dir: Dir, ctr: number, sealed: Uint8Array): Promise<Bytes> =>
  aeadOpen(key, recordNonce(ctr), recordAad(sessionId, dir, ctr), sealed)

export interface RecordLimits { frames: number; bytes: number; ageMs: number }

/** Limits can only be lowered (tests do it); the spec values are the ceiling. */
const clampLimits = (l: Partial<RecordLimits> | undefined): RecordLimits => ({
  frames: Math.max(2, Math.min(l?.frames ?? REKEY_FRAMES, REKEY_FRAMES)),
  bytes: Math.max(1, Math.min(l?.bytes ?? REKEY_BYTES, REKEY_BYTES)),
  ageMs: Math.max(1, Math.min(l?.ageMs ?? REKEY_AGE_MS, REKEY_AGE_MS)),
})

export interface RecordChannelInit {
  role: 'device' | 'house'
  sessionId: Uint8Array
  /** Non-extractable AES-GCM key with only `encrypt`. */
  sendKey: CryptoKey
  /** Non-extractable AES-GCM key with only `decrypt`. */
  recvKey: CryptoKey
  startedMs: number
  limits?: Partial<RecordLimits>
}

/**
 * One established session's pair of directions. Counters are advanced synchronously before any await, so two
 * overlapping calls can never reuse a nonce. Any failure on receive kills the channel: it never recovers.
 */
export class RecordChannel {
  readonly sessionId: Bytes
  readonly #sendDir: Dir
  readonly #recvDir: Dir
  readonly #startedMs: number
  readonly #limits: RecordLimits
  #sendKey: CryptoKey | undefined
  #recvKey: CryptoKey | undefined
  #send = 0
  #recv = 0
  #sentBytes = 0
  #recvBytes = 0

  constructor(init: RecordChannelInit) {
    if (init.sessionId.length !== 16) fail('malformed', 'sessionId must be 16 bytes')
    this.sessionId = concat(init.sessionId)
    this.#sendDir = init.role === 'device' ? DIR_D2H : DIR_H2D
    this.#recvDir = init.role === 'device' ? DIR_H2D : DIR_D2H
    this.#sendKey = init.sendKey
    this.#recvKey = init.recvKey
    this.#startedMs = init.startedMs
    this.#limits = clampLimits(init.limits)
  }

  /** Records sent so far, which is also the counter of the next one. */
  get sent(): number { return this.#send }
  /** The next counter this end expects to receive. */
  get recvNext(): number { return this.#recv }
  get alive(): boolean { return this.#sendKey !== undefined }

  /**
   * True when the next record this end sends must be CLOSE(0x02): the next counter is the last one before the frame
   * limit, a byte limit was reached in either direction, or the session reached its age (spec 4.5, 11 Q18).
   */
  rekeyDue(nowMs: number): boolean {
    return this.#send >= this.#limits.frames - 1
      || this.#sentBytes >= this.#limits.bytes
      || this.#recvBytes >= this.#limits.bytes
      || nowMs - this.#startedMs >= this.#limits.ageMs
  }

  async seal(ctype: ContentType, content: Uint8Array): Promise<{ frame: Bytes; ctr: number }> {
    const key = this.#sendKey ?? fail('bad-state', 'the session is closed')
    if (this.#send >= this.#limits.frames) fail('range', 'send counter at the rekey limit')
    const plaintext = padPlaintext(ctype, content)
    const ctr = this.#send++
    const frame = await sealRecordAt(key, this.sessionId, this.#sendDir, ctr, plaintext)
    this.#sentBytes += frame.length
    return { frame, ctr }
  }

  /** Order of spec 4.5: size, counter exactly as expected, decrypt, padding. Any failure kills the channel. */
  async open(frame: Uint8Array): Promise<{ ctype: ContentType; content: Bytes; ctr: number }> {
    const key = this.#recvKey ?? fail('bad-state', 'the session is closed')
    try {
      if (frame.length > MAX_INNER) fail('too-large', 'record above MAX_INNER')
      const f = decodeInner(frame)
      if (f.type !== 'REC') return fail('unknown-type', 'not a record')
      const ctr = this.#recv
      if (f.ctr !== ctr) fail('replay', 'record counter is not the expected one')
      if (ctr >= this.#limits.frames) fail('range', 'record counter at the rekey limit')
      this.#recv++
      this.#recvBytes += frame.length
      const plaintext = await openRecordAt(key, this.sessionId, this.#recvDir, ctr, f.sealed)
      return { ...unpadPlaintext(plaintext), ctr }
    } catch (e) {
      this.destroy()
      throw e instanceof WireError ? e : new WireError('auth', 'record open failed')
    }
  }

  /** Drops both keys. Nothing of the session survives its end (spec 4.7). */
  destroy(): void {
    this.#sendKey = undefined
    this.#recvKey = undefined
  }
}
