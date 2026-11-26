// What travels inside an encrypted record (spec 2.4 and 7.1): the padded plaintext, the content types and their
// bodies, and the application envelopes. Also the two structures of the pairing that are not frames: DeviceHello
// (spec 3.4) and the two accesses of a pairing ticket, the typed code and the QR blob (spec 3.2).
import { audBytes, audFromBytes } from './aud.ts'
import {
  ascii, b64url, concat, fail, fromB64url, lp16, lp8, Reader, u16, u32, u64, u8, utf8, utf8Decode, type Bytes,
} from './bytes.ts'
import { CLOSE, DEVICE_NAME_MAX, MAX_RECORD_CONTENT, PAIR_CODE_DIGITS, PRESENCE, type Presence } from './constants.ts'

// ---------------------------------------------------------------------------------------------------------------
// Record plaintext: ctype(1) ‖ u32(clen) ‖ content(clen) ‖ padding(zeros)
// ---------------------------------------------------------------------------------------------------------------

export const CTYPE = {
  HS_DONE: 0x01, PAIR_DONE: 0x02, PAIR_ACK: 0x03, PING: 0x04, PONG: 0x05, CLOSE: 0x06,
  REQ: 0x10, RES: 0x11, EVT: 0x12, BIN: 0x13,
} as const
export type ContentType = keyof typeof CTYPE

const CTYPE_NAME = new Map<number, ContentType>((Object.keys(CTYPE) as ContentType[]).map(k => [CTYPE[k], k]))

/** Who may write each content type (spec 2.4). A type in the wrong direction closes. */
export const CTYPE_SENDER: Record<ContentType, 'device' | 'house' | 'both'> = {
  HS_DONE: 'house', PAIR_DONE: 'house', PAIR_ACK: 'device', PING: 'both', PONG: 'both', CLOSE: 'both',
  REQ: 'device', RES: 'house', EVT: 'house', BIN: 'both',
}

/** Padded size of a plaintext of `n` bytes: 64, 128, 256, 512, 1024, then the next multiple of 1024 (spec 2.4). */
export function paddedSize(n: number): number {
  for (const step of [64, 128, 256, 512, 1024]) if (n <= step) return step
  return Math.ceil(n / 1024) * 1024
}

export function padPlaintext(ctype: ContentType, content: Uint8Array): Bytes {
  if (content.length > MAX_RECORD_CONTENT) fail('too-large', 'record content above its cap')
  const out = new Uint8Array(paddedSize(5 + content.length))
  out[0] = CTYPE[ctype]
  out.set(u32(content.length), 1)
  out.set(content, 5)
  return out
}

/** Receiver side: `5 + clen` must fit the plaintext and every padding byte must be zero (spec 2.4). */
export function unpadPlaintext(pt: Uint8Array): { ctype: ContentType; content: Bytes } {
  const r = new Reader(pt)
  const ctype = CTYPE_NAME.get(r.u8())
  if (!ctype) return fail('unknown-type', 'content type')
  const clen = r.u32()
  if (clen > r.remaining) fail('malformed', 'clen above the plaintext')
  const content = r.take(clen)
  const pad = r.rest()
  let acc = 0
  for (let i = 0; i < pad.length; i++) acc |= pad[i]!
  if (acc !== 0) fail('malformed', 'non-zero padding')
  return { ctype, content }
}

// ---------------------------------------------------------------------------------------------------------------
// Control contents
// ---------------------------------------------------------------------------------------------------------------

export interface HsDone { houseMaxVer: number; now: number; presence: Presence; elevUntil: number }

export function encodeHsDone(d: HsDone): Bytes {
  return concat(u8(d.houseMaxVer), u64(d.now), u8(d.presence), u64(d.elevUntil))
}

function readPresence(v: number): Presence {
  if (v !== PRESENCE.locked && v !== PRESENCE.unlocked && v !== PRESENCE.noCredential) return fail('malformed', 'presence')
  return v
}

export function decodeHsDone(b: Uint8Array): HsDone {
  const r = new Reader(b)
  const d: HsDone = { houseMaxVer: r.u8(), now: r.u64(), presence: readPresence(r.u8()), elevUntil: r.u64() }
  r.end()
  return d
}

export interface PairDone {
  houseMaxVer: number
  now: number
  houseConfirm: Bytes
  deviceId: Bytes
  /** The whole AdmitTicket (lp16(body) ‖ sig_T), opaque at this layer. */
  admitTicket: Bytes
  /** UTF-8, up to 255 bytes. Hostile text for the device. */
  houseName: string
}

export function encodePairDone(d: PairDone): Bytes {
  if (d.houseConfirm.length !== 32 || d.deviceId.length !== 16) fail('malformed', 'PAIR_DONE field size')
  return concat(u8(d.houseMaxVer), u64(d.now), d.houseConfirm, d.deviceId, lp16(d.admitTicket), lp8(utf8(d.houseName)))
}

export function decodePairDone(b: Uint8Array): PairDone {
  const r = new Reader(b)
  const d: PairDone = {
    houseMaxVer: r.u8(), now: r.u64(), houseConfirm: r.take(32), deviceId: r.take(16), admitTicket: r.lp16(),
    houseName: utf8Decode(r.lp8()),
  }
  r.end()
  return d
}

export const encodePing = (recvNext: number): Bytes => u64(recvNext)

export function decodePing(b: Uint8Array): { recvNext: number } {
  const r = new Reader(b)
  const recvNext = r.u64()
  r.end()
  return { recvNext }
}

export const encodePong = (pingCtr: number, recvNext: number): Bytes => concat(u64(pingCtr), u64(recvNext))

export function decodePong(b: Uint8Array): { pingCtr: number; recvNext: number } {
  const r = new Reader(b)
  const out = { pingCtr: r.u64(), recvNext: r.u64() }
  r.end()
  return out
}

export type CloseCode = (typeof CLOSE)[keyof typeof CLOSE]

export const isCloseCode = (v: number): v is CloseCode => Number.isInteger(v) && v >= CLOSE.normal && v <= CLOSE.limit

export function encodeClose(code: CloseCode): Bytes {
  if (!isCloseCode(code)) fail('malformed', 'close code')
  return u8(code)
}

export function decodeClose(b: Uint8Array): { code: CloseCode } {
  const r = new Reader(b)
  const code = r.u8()
  r.end()
  if (!isCloseCode(code)) return fail('malformed', 'close code')
  return { code }
}

// ---------------------------------------------------------------------------------------------------------------
// Application envelopes (spec 7.1). The JSON body stays as raw bytes: the portal decides scope and presence by `op`
// before it parses anything, and the per-act presence challenge hashes these exact bytes.
// ---------------------------------------------------------------------------------------------------------------

export interface UvProof { uvCtr: number; authenticatorData: Bytes; clientDataJSON: Bytes; signature: Bytes }

export interface Req { reqId: number; op: number; actId?: Bytes; uvProof?: UvProof; body: Bytes }

const REQ_FLAG_ACT = 0x01
const REQ_FLAG_UV = 0x02

export function encodeReq(q: Req): Bytes {
  if (q.actId && q.actId.length !== 16) fail('malformed', 'actId must be 16 bytes')
  const flags = (q.actId ? REQ_FLAG_ACT : 0) | (q.uvProof ? REQ_FLAG_UV : 0)
  const uv = q.uvProof
    ? concat(u32(q.uvProof.uvCtr), lp16(q.uvProof.authenticatorData), lp16(q.uvProof.clientDataJSON), lp16(q.uvProof.signature))
    : new Uint8Array(0)
  return concat(u32(q.reqId), u16(q.op), u8(flags), q.actId ?? new Uint8Array(0), uv, q.body)
}

export function decodeReq(b: Uint8Array): Req {
  const r = new Reader(b)
  const reqId = r.u32()
  const op = r.u16()
  const flags = r.u8()
  if ((flags & ~(REQ_FLAG_ACT | REQ_FLAG_UV)) !== 0) fail('malformed', 'reserved REQ flag')
  const q: Req = { reqId, op, body: new Uint8Array(0) }
  if (flags & REQ_FLAG_ACT) q.actId = r.take(16)
  if (flags & REQ_FLAG_UV) {
    q.uvProof = { uvCtr: r.u32(), authenticatorData: r.lp16(), clientDataJSON: r.lp16(), signature: r.lp16() }
  }
  q.body = r.rest()
  return q
}

export const RES_STATUS = {
  ok: 0x00, badRequest: 0x01, unknownOp: 0x02, noScope: 0x03, locked: 0x04, presenceRequired: 0x05,
  notFound: 0x06, limit: 0x07, noApp: 0x08, failed: 0x09,
} as const
export type ResStatus = (typeof RES_STATUS)[keyof typeof RES_STATUS]

export interface Res { reqId: number; status: ResStatus; body: Bytes }

export const encodeRes = (s: Res): Bytes => concat(u32(s.reqId), u8(s.status), s.body)

export function decodeRes(b: Uint8Array): Res {
  const r = new Reader(b)
  const reqId = r.u32()
  const status = r.u8()
  if (status > RES_STATUS.failed) fail('malformed', 'RES status')
  return { reqId, status: status as ResStatus, body: r.rest() }
}

export interface Evt { evt: number; body: Bytes }

export const encodeEvt = (e: Evt): Bytes => concat(u16(e.evt), e.body)

export function decodeEvt(b: Uint8Array): Evt {
  const r = new Reader(b)
  return { evt: r.u16(), body: r.rest() }
}

export interface Bin { stream: number; data: Bytes }

export const encodeBin = (x: Bin): Bytes => concat(u32(x.stream), x.data)

export function decodeBin(b: Uint8Array): Bin {
  const r = new Reader(b)
  return { stream: r.u32(), data: r.rest() }
}

/** The JSON body of REQ, RES and EVT: strict UTF-8 with an object at the root (spec 2.6). Everything else is refused. */
export function parseJsonObject(body: Uint8Array): Record<string, unknown> {
  const text = utf8Decode(body)
  let v: unknown
  try { v = JSON.parse(text) } catch { return fail('malformed', 'body is not JSON') }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return fail('malformed', 'body root is not an object')
  return v as Record<string, unknown>
}

// ---------------------------------------------------------------------------------------------------------------
// DeviceHello = pub_D(65) ‖ pub_A(65) ‖ caps(1) ‖ lp8(name)
// ---------------------------------------------------------------------------------------------------------------

export const CAPS = { platformAuthenticator: 0x01, installed: 0x02 } as const
const CAPS_MASK = CAPS.platformAuthenticator | CAPS.installed

export interface DeviceHello { pubD: Bytes; pubA: Bytes; caps: number; name: string }

export function encodeDeviceHello(h: DeviceHello): Bytes {
  if (h.pubD.length !== 65 || h.pubA.length !== 65) fail('malformed', 'DeviceHello key size')
  if ((h.caps & ~CAPS_MASK) !== 0) fail('malformed', 'reserved caps bit')
  const name = utf8(h.name)
  if (name.length > DEVICE_NAME_MAX) fail('too-large', 'device name above 64 bytes')
  return concat(h.pubD, h.pubA, u8(h.caps), lp8(name))
}

export function decodeDeviceHello(b: Uint8Array): DeviceHello {
  const r = new Reader(b)
  const pubD = r.take(65)
  const pubA = r.take(65)
  const caps = r.u8()
  if ((caps & ~CAPS_MASK) !== 0) fail('malformed', 'reserved caps bit')
  const nameBytes = r.lp8()
  if (nameBytes.length > DEVICE_NAME_MAX) fail('too-large', 'device name above 64 bytes')
  r.end()
  return { pubD, pubA, caps, name: utf8Decode(nameBytes) }
}

/**
 * The declared name as the machine may show it (B-3): controls, format characters (bidi overrides, zero-width),
 * separators of line and paragraph, private-use and unassigned code points are dropped; whitespace is collapsed.
 * The result is still "what the device declares", never an identity.
 */
export function sanitizeDeclaredName(name: string): string {
  return name
    .replace(/\s+/gu, ' ')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cs}\p{Cn}]/gu, '')
    .replace(/ +/g, ' ')
    .trim()
}

// ---------------------------------------------------------------------------------------------------------------
// The two accesses of a pairing ticket (spec 3.2)
// ---------------------------------------------------------------------------------------------------------------

/** The typed code: R (6 digits) followed by S (6 digits). Spaces and hyphens are dropped; anything else is refused. */
export function parseTypedCode(input: string): { R: Bytes; S: Bytes } {
  const digits = input.replace(/[ -]/g, '')
  if (!new RegExp(`^[0-9]{${2 * PAIR_CODE_DIGITS}}$`).test(digits)) fail('malformed', 'the code is 12 digits')
  return { R: ascii(digits.slice(0, PAIR_CODE_DIGITS)), S: ascii(digits.slice(PAIR_CODE_DIGITS)) }
}

/** The code as the machine shows it: `123 456 789 012`. */
export function formatTypedCode(R: Uint8Array, S: Uint8Array): string {
  let d = ''
  for (const b of [...R, ...S]) d += String.fromCharCode(b)
  return d.replace(/(\d{3})(?=\d)/g, '$1 ')
}

export const QR_VERSION = 0x01

export interface QrBlob { maxVer: number; relayHost: string; houseId: Bytes; R: Bytes; S: Bytes }

/** qrVer(1)=0x01 ‖ maxVer(1) ‖ lp8(relayHost) ‖ houseId(32) ‖ R(16) ‖ S(16) */
export function encodeQrBlob(q: QrBlob): Bytes {
  if (q.houseId.length !== 32 || q.R.length !== 16 || q.S.length !== 16) fail('malformed', 'QR field size')
  return concat(u8(QR_VERSION), u8(q.maxVer), lp8(audBytes(q.relayHost)), q.houseId, q.R, q.S)
}

export function decodeQrBlob(b: Uint8Array): QrBlob {
  const r = new Reader(b)
  if (r.u8() !== QR_VERSION) fail('bad-version', 'QR version')
  const maxVer = r.u8()
  if (maxVer < 1) fail('malformed', 'QR maxVer')
  const q: QrBlob = { maxVer, relayHost: audFromBytes(r.lp8()), houseId: r.take(32), R: r.take(16), S: r.take(16) }
  r.end()
  return q
}

/** The blob travels in the URL fragment, never in the query (B-2): `#pair=<base64url>`. */
export const qrFragment = (q: QrBlob): string => `#pair=${b64url(encodeQrBlob(q))}`

export function parseQrFragment(fragment: string): QrBlob {
  const m = /^#?pair=([A-Za-z0-9_-]+)$/.exec(fragment)
  if (!m) return fail('malformed', 'pairing fragment')
  return decodeQrBlob(fromB64url(m[1]!))
}
