// Byte helpers of the remote wire (spec 0.1). Pure: no node:*, no Buffer, no DOM. Integers are unsigned big-endian.
// Every value this module hands to crypto.subtle is a `Bytes` (a Uint8Array over its own ArrayBuffer), never a view
// into a frame that came from outside.

export type Bytes = Uint8Array<ArrayBuffer>

export type WireErrorCode =
  | 'malformed' // a frame or structure that does not parse: wrong size, bytes left over, field out of its domain
  | 'too-large' // above the cap of its layer
  | 'unknown-type' // a type byte this version does not know, or one not allowed in that direction
  | 'bad-point' // a public key that is not an uncompressed P-256 point on the curve
  | 'bad-version' // version or suite this build does not speak
  | 'bad-label' // a key asked to sign a label outside its role, or a body of the wrong size
  | 'bad-state' // a call the state machine does not accept in its current state
  | 'auth' // AEAD or signature failure
  | 'replay' // record counter different from the expected one
  | 'self-test' // the platform failed the start-up self-test; the module refuses to operate
  | 'range' // an integer or a time outside what this implementation represents
  | 'locked' // pairing is blocked by PAIR_LOCKOUT

/** The one error type of the module. On the wire every one of them means "close"; the code is for logs and tests. */
export class WireError extends Error {
  readonly code: WireErrorCode
  constructor(code: WireErrorCode, message?: string) {
    super(message ? `${code}: ${message}` : code)
    this.name = 'WireError'
    this.code = code
  }
}

export function fail(code: WireErrorCode, message?: string): never { throw new WireError(code, message) }

/** A private copy of `src` over a fresh ArrayBuffer. */
export function copy(src: Uint8Array): Bytes {
  const out = new Uint8Array(src.length)
  out.set(src)
  return out
}

export function concat(...parts: readonly Uint8Array[]): Bytes {
  let n = 0
  for (const p of parts) n += p.length
  const out = new Uint8Array(n)
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

export function u8(v: number): Bytes {
  if (!Number.isInteger(v) || v < 0 || v > 0xff) fail('range', 'u8')
  return Uint8Array.of(v)
}

export function u16(v: number): Bytes {
  if (!Number.isInteger(v) || v < 0 || v > 0xffff) fail('range', 'u16')
  return Uint8Array.of(v >>> 8, v & 0xff)
}

export function u32(v: number): Bytes {
  if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) fail('range', 'u32')
  return Uint8Array.of(v >>> 24, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff)
}

/** u64 from a JS number: counters and Unix seconds never leave the safe-integer range. */
export function u64(v: number): Bytes {
  if (!Number.isSafeInteger(v) || v < 0) fail('range', 'u64')
  const hi = Math.floor(v / 0x100000000)
  const lo = v >>> 0
  return concat(u32(hi), u32(lo))
}

export function lp8(x: Uint8Array): Bytes {
  if (x.length > 0xff) fail('too-large', 'lp8')
  return concat(u8(x.length), x)
}

export function lp16(x: Uint8Array): Bytes {
  if (x.length > 0xffff) fail('too-large', 'lp16')
  return concat(u16(x.length), x)
}

/** Strict cursor over a frame: every read is bounds-checked and `end()` refuses bytes left over (spec 2.1 rule 1). */
export class Reader {
  readonly #src: Uint8Array
  #at = 0
  constructor(src: Uint8Array) { this.#src = src }

  get remaining(): number { return this.#src.length - this.#at }

  take(n: number): Bytes {
    if (n < 0 || n > this.remaining) fail('malformed', 'truncated')
    const out = new Uint8Array(n)
    out.set(this.#src.subarray(this.#at, this.#at + n))
    this.#at += n
    return out
  }

  u8(): number {
    if (this.remaining < 1) fail('malformed', 'truncated')
    return this.#src[this.#at++]!
  }

  u16(): number { const b = this.take(2); return (b[0]! << 8) | b[1]! }

  u32(): number { const b = this.take(4); return ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0 }

  u64(): number {
    const hi = this.u32()
    const lo = this.u32()
    if (hi > 0x1fffff) fail('range', 'u64 above the safe integer range')
    return hi * 0x100000000 + lo
  }

  lp8(): Bytes { return this.take(this.u8()) }
  lp16(): Bytes { return this.take(this.u16()) }
  rest(): Bytes { return this.take(this.remaining) }
  end(): void { if (this.remaining !== 0) fail('malformed', 'bytes left over') }
}

/** Plain comparison, for public values only. */
export function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** Constant-time comparison (spec 0.1): XOR accumulated over the whole length. The lengths themselves are public. */
export function ctEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let acc = 0
  for (let i = 0; i < a.length; i++) acc |= a[i]! ^ b[i]!
  return acc === 0
}

export function isZero(a: Uint8Array): boolean {
  let acc = 0
  for (let i = 0; i < a.length; i++) acc |= a[i]!
  return acc === 0
}

/** Best-effort erase of an intermediate secret (spec 0.3 rule 6). */
export function wipe(...arrays: readonly (Uint8Array | undefined)[]): void {
  for (const a of arrays) a?.fill(0)
}

const HEX = '0123456789abcdef'

export function toHex(a: Uint8Array): string {
  let s = ''
  for (let i = 0; i < a.length; i++) s += HEX[a[i]! >>> 4]! + HEX[a[i]! & 15]!
  return s
}

export function fromHex(s: string): Bytes {
  if (s.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(s)) fail('malformed', 'hex')
  const out = new Uint8Array(s.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16)
  return out
}

/** ASCII bytes of a string that must be 7-bit. */
export function ascii(s: string): Bytes {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c > 0x7f) fail('malformed', 'not ASCII')
    out[i] = c
  }
  return out
}

export function utf8(s: string): Bytes { return copy(new TextEncoder().encode(s)) }

/** Strict UTF-8 decoding: an invalid sequence is an error, never a replacement character. */
export function utf8Decode(b: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(b) }
  catch { return fail('malformed', 'invalid UTF-8') }
}

const B32 = 'abcdefghijklmnopqrstuvwxyz234567'

/** RFC 4648 base32, lowercase, no padding (spec 1.2 and 11 Q7). */
export function base32(a: Uint8Array): string {
  let out = ''
  let acc = 0
  let bits = 0
  for (let i = 0; i < a.length; i++) {
    acc = (acc << 8) | a[i]!
    bits += 8
    while (bits >= 5) { out += B32[(acc >>> (bits - 5)) & 31]!; bits -= 5 }
    acc &= (1 << bits) - 1
  }
  if (bits > 0) out += B32[(acc << (5 - bits)) & 31]!
  return out
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/** base64url without padding. */
export function b64url(a: Uint8Array): string {
  let out = ''
  for (let i = 0; i < a.length; i += 3) {
    const b0 = a[i]!
    const b1 = a[i + 1]
    const b2 = a[i + 2]
    out += B64[b0 >>> 2]!
    out += B64[((b0 & 3) << 4) | ((b1 ?? 0) >>> 4)]!
    if (b1 !== undefined) out += B64[((b1 & 15) << 2) | ((b2 ?? 0) >>> 6)]!
    if (b2 !== undefined) out += B64[b2 & 63]!
  }
  return out
}

/** Strict base64url without padding: unknown characters, an impossible length or non-zero trailing bits are errors. */
export function fromB64url(s: string): Bytes {
  if (s.length % 4 === 1) fail('malformed', 'base64url length')
  const out = new Uint8Array(Math.floor((s.length * 3) / 4))
  let acc = 0
  let bits = 0
  let at = 0
  for (let i = 0; i < s.length; i++) {
    const v = B64.indexOf(s[i]!)
    if (v < 0) fail('malformed', 'base64url character')
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) { out[at++] = (acc >>> (bits - 8)) & 0xff; bits -= 8 }
    acc &= (1 << bits) - 1
  }
  if (acc !== 0) fail('malformed', 'base64url trailing bits')
  return out
}

/** Fresh random bytes from the platform CSPRNG (spec 0.3 rule 2). */
export function randomBytes(n: number): Bytes {
  const out = new Uint8Array(n)
  globalThis.crypto.getRandomValues(out)
  return out
}

/** Runs async steps one at a time, in call order. A state machine uses it so two frames never interleave inside it. */
export class Serial {
  #tail: Promise<unknown> = Promise.resolve()
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(fn, fn)
    this.#tail = next.catch(() => undefined)
    return next
  }
}
