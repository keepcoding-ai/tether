// The relay identity (`aud`) as it travels in signed bodies and in the QR blob (spec 1.4 rule of verification, 11 Q6):
// 1 to 253 bytes, each one printable ASCII (0x21..0x7E) and never an uppercase letter. Anything else is refused
// before any signature is verified.
import { ascii, fail, type Bytes } from './bytes.ts'
import { AUD_MAX } from './constants.ts'

export function isValidAudBytes(b: Uint8Array): boolean {
  if (b.length < 1 || b.length > AUD_MAX) return false
  for (let i = 0; i < b.length; i++) {
    const c = b[i]!
    if (c < 0x21 || c > 0x7e) return false
    if (c >= 0x41 && c <= 0x5a) return false
  }
  return true
}

/** Bytes of a valid `aud`; throws on anything outside the rule. */
export function audBytes(aud: string): Bytes {
  for (let i = 0; i < aud.length; i++) if (aud.charCodeAt(i) > 0x7f) fail('malformed', 'aud is not ASCII')
  const b = ascii(aud)
  if (!isValidAudBytes(b)) fail('malformed', 'aud outside 1..253 printable lowercase ASCII')
  return b
}

/** The string of an `aud` read from the wire; throws on anything outside the rule. */
export function audFromBytes(b: Uint8Array): string {
  if (!isValidAudBytes(b)) fail('malformed', 'aud outside 1..253 printable lowercase ASCII')
  let s = ''
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!)
  return s
}
