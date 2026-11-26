// Binary frames of the remote wire (spec 2.1 to 2.3): the outer frame (one WebSocket message) on each leg of the
// relay, and the inner frame the relay forwards without opening. Fixed layout, fixed order, explicit caps. A decoder
// consumes the whole frame; an unknown type, a size outside its cap or a field outside its domain is an error, and an
// error closes. Nothing here is "ignored if unknown".
import { concat, fail, Reader, u16, u32, u64, u8, lp16, type Bytes } from './bytes.ts'
import {
  DENY_MAX, MAX_INNER, MAX_OUTER, MAX_PRE_AUTH, PAIR_TTL_S, WIRE_VERSION,
} from './constants.ts'

// ---------------------------------------------------------------------------------------------------------------
// Outer frame: ver(1) = 0x01 ‖ otype(1) ‖ body
// ---------------------------------------------------------------------------------------------------------------

export const OTYPE = {
  R_HELLO: 0x01, D_ADMIT: 0x02, D_PAIR: 0x03, R_OK: 0x04, R_FAIL: 0x05, DATA: 0x10,
  R_CHALLENGE: 0x20, H_AUTH: 0x21, R_AUTH_OK: 0x22, R_AUTH_FAIL: 0x23, H_PAIR_LISTEN: 0x24, H_PAIR_CANCEL: 0x25,
  R_PAIR_STATE: 0x26, H_DENY: 0x27, R_NOTICE: 0x28, ROUTE_OPEN: 0x30, ROUTE_DATA: 0x31, ROUTE_CLOSE: 0x32,
  LINK_PING: 0x3e, LINK_PONG: 0x3f,
} as const
export type OuterType = keyof typeof OTYPE

/** `R_AUTH_FAIL.code`: one constant value, so the refusal carries no reason (spec 11 Q8). */
export const R_AUTH_FAIL_CODE = 0x00
export const PAIR_STATE = { listening: 0x00, rvInUse: 0x01, expired: 0x02 } as const
export const NOTICE = { secondHouse: 0x01, limit: 0x02 } as const
export const ROUTE_KIND = { admit: 0x01, pair: 0x02 } as const

export const KEY_CERT_SIZE = 179

export interface DenyEntry { ticketId: Bytes; exp: number }

export type OuterFrame =
  | { type: 'R_HELLO'; nR: Bytes }
  | { type: 'D_ADMIT'; houseId: Bytes; ticket: Bytes; nD: Bytes; sigA: Bytes }
  | { type: 'D_PAIR'; rv: Bytes }
  | { type: 'R_OK' }
  | { type: 'R_FAIL' }
  | { type: 'DATA'; inner: Bytes }
  | { type: 'R_CHALLENGE'; r: Bytes }
  | { type: 'H_AUTH'; pubH: Bytes; certR: Bytes; certsT: Bytes[]; c: Bytes; ts: number; sigR: Bytes }
  | { type: 'R_AUTH_OK' }
  | { type: 'R_AUTH_FAIL'; code: typeof R_AUTH_FAIL_CODE }
  | { type: 'H_PAIR_LISTEN'; ttl: number; rvs: Bytes[] }
  | { type: 'H_PAIR_CANCEL' }
  | { type: 'R_PAIR_STATE'; code: number }
  /** `overflow` is set, with no entries materialised, when the frame announces more than DENY_MAX (spec 11 Q13). */
  | { type: 'H_DENY'; entries: DenyEntry[]; overflow: boolean }
  | { type: 'R_NOTICE'; code: number }
  | { type: 'ROUTE_OPEN'; routeId: number; kind: number; hint: Bytes }
  | { type: 'ROUTE_DATA'; routeId: number; inner: Bytes }
  | { type: 'ROUTE_CLOSE'; routeId: number }
  | { type: 'LINK_PING'; echo: Bytes }
  | { type: 'LINK_PONG'; echo: Bytes }

export type Leg = 'device' | 'house'
/** Who wrote the frame: the relay, or the end of that leg (the device on the device leg, the house on the house leg). */
export type Sender = 'relay' | 'end'

const ALLOWED: Record<Leg, Record<Sender, readonly OuterType[]>> = {
  device: {
    relay: ['R_HELLO', 'R_OK', 'R_FAIL', 'DATA'],
    end: ['D_ADMIT', 'D_PAIR', 'DATA'],
  },
  house: {
    relay: ['R_CHALLENGE', 'R_AUTH_OK', 'R_AUTH_FAIL', 'R_PAIR_STATE', 'R_NOTICE', 'ROUTE_OPEN', 'ROUTE_DATA',
      'ROUTE_CLOSE', 'LINK_PING', 'LINK_PONG'],
    end: ['H_AUTH', 'H_PAIR_LISTEN', 'H_PAIR_CANCEL', 'H_DENY', 'ROUTE_DATA', 'ROUTE_CLOSE', 'LINK_PING', 'LINK_PONG'],
  },
}

const OTYPE_NAME = new Map<number, OuterType>((Object.keys(OTYPE) as OuterType[]).map(k => [OTYPE[k], k]))

const sized = (b: Uint8Array, n: number, what: string): Uint8Array => {
  if (b.length !== n) fail('malformed', `${what} must be ${n} bytes`)
  return b
}

const innerOf = (b: Uint8Array): Uint8Array => {
  if (b.length < 1) fail('malformed', 'empty inner frame')
  if (b.length > MAX_INNER) fail('too-large', 'inner frame above MAX_INNER')
  return b
}

function outerBody(f: OuterFrame): Bytes {
  switch (f.type) {
    case 'R_HELLO': return concat(sized(f.nR, 32, 'n_R'))
    case 'D_ADMIT':
      return concat(sized(f.houseId, 32, 'houseId'), lp16(f.ticket), sized(f.nD, 32, 'n_D'), sized(f.sigA, 64, 'sig_A'))
    case 'D_PAIR': return concat(sized(f.rv, 16, 'rv'))
    case 'R_OK': case 'R_FAIL': case 'R_AUTH_OK': case 'H_PAIR_CANCEL': return new Uint8Array(0)
    case 'DATA': return concat(innerOf(f.inner))
    case 'R_CHALLENGE': return concat(sized(f.r, 32, 'r'))
    case 'H_AUTH': {
      if (f.certsT.length < 1 || f.certsT.length > 2) fail('malformed', 'nT must be 1 or 2')
      return concat(
        sized(f.pubH, 65, 'pub_H'), sized(f.certR, KEY_CERT_SIZE, 'KeyCert_R'), u8(f.certsT.length),
        ...f.certsT.map(c => sized(c, KEY_CERT_SIZE, 'KeyCert_T')), sized(f.c, 32, 'c'), u64(f.ts), sized(f.sigR, 64, 'sig_R'),
      )
    }
    case 'R_AUTH_FAIL':
      if (f.code !== R_AUTH_FAIL_CODE) fail('malformed', 'R_AUTH_FAIL code is the constant 0x00')
      return u8(f.code)
    case 'H_PAIR_LISTEN':
      if (f.ttl > PAIR_TTL_S) fail('malformed', 'ttl above PAIR_TTL')
      if (f.rvs.length < 1 || f.rvs.length > 2) fail('malformed', 'n must be 1 or 2')
      return concat(u16(f.ttl), u8(f.rvs.length), ...f.rvs.map(rv => sized(rv, 16, 'rv')))
    case 'R_PAIR_STATE':
      if (f.code < 0 || f.code > 2) fail('malformed', 'pair state code')
      return u8(f.code)
    case 'H_DENY':
      if (f.overflow || f.entries.length > DENY_MAX) fail('too-large', 'H_DENY above DENY_MAX')
      return concat(u16(f.entries.length), ...f.entries.flatMap(e => [sized(e.ticketId, 16, 'ticketId'), u64(e.exp)]))
    case 'R_NOTICE':
      if (f.code !== NOTICE.secondHouse && f.code !== NOTICE.limit) fail('malformed', 'notice code')
      return u8(f.code)
    case 'ROUTE_OPEN':
      if (f.kind !== ROUTE_KIND.admit && f.kind !== ROUTE_KIND.pair) fail('malformed', 'route kind')
      return concat(u32(f.routeId), u8(f.kind), sized(f.hint, 16, 'hint'))
    case 'ROUTE_DATA': return concat(u32(f.routeId), innerOf(f.inner))
    case 'ROUTE_CLOSE': return u32(f.routeId)
    case 'LINK_PING': case 'LINK_PONG': return concat(sized(f.echo, 8, 'echo'))
  }
}

export function encodeOuter(f: OuterFrame): Bytes {
  const out = concat(u8(WIRE_VERSION), u8(OTYPE[f.type]), outerBody(f))
  if (out.length > MAX_OUTER) fail('too-large', 'outer frame above MAX_OUTER')
  return out
}

/**
 * Decodes one WebSocket binary message. `leg` and `sender` say which table of spec 2.2 applies: a type that exists
 * but does not belong to that leg and direction is as unknown as one that does not exist. `preAuth` applies the
 * MAX_PRE_AUTH cap the relay enforces before it admits or authenticates the socket.
 */
export function decodeOuter(leg: Leg, sender: Sender, bytes: Uint8Array, opts: { preAuth?: boolean } = {}): OuterFrame {
  if (bytes.length > (opts.preAuth ? MAX_PRE_AUTH : MAX_OUTER)) fail('too-large', 'outer frame above its cap')
  const r = new Reader(bytes)
  if (r.u8() !== WIRE_VERSION) fail('bad-version', 'outer frame version')
  const type = OTYPE_NAME.get(r.u8())
  if (!type || !ALLOWED[leg][sender].includes(type)) return fail('unknown-type', 'outer type not valid on this leg')
  const f = readOuter(type, r)
  r.end()
  return f
}

function readOuter(type: OuterType, r: Reader): OuterFrame {
  switch (type) {
    case 'R_HELLO': return { type, nR: r.take(32) }
    case 'D_ADMIT': return { type, houseId: r.take(32), ticket: r.lp16(), nD: r.take(32), sigA: r.take(64) }
    case 'D_PAIR': return { type, rv: r.take(16) }
    case 'R_OK': case 'R_FAIL': case 'R_AUTH_OK': case 'H_PAIR_CANCEL': return { type }
    case 'DATA': {
      const inner = r.rest()
      if (inner.length < 1) fail('malformed', 'empty inner frame')
      if (inner.length > MAX_INNER) fail('too-large', 'inner frame above MAX_INNER')
      return { type, inner }
    }
    case 'R_CHALLENGE': return { type, r: r.take(32) }
    case 'H_AUTH': {
      const pubH = r.take(65)
      const certR = r.take(KEY_CERT_SIZE)
      const nT = r.u8()
      if (nT < 1 || nT > 2) fail('malformed', 'nT must be 1 or 2')
      const certsT: Bytes[] = []
      for (let i = 0; i < nT; i++) certsT.push(r.take(KEY_CERT_SIZE))
      return { type, pubH, certR, certsT, c: r.take(32), ts: r.u64(), sigR: r.take(64) }
    }
    case 'R_AUTH_FAIL': {
      const code = r.u8()
      if (code !== R_AUTH_FAIL_CODE) fail('malformed', 'R_AUTH_FAIL code is the constant 0x00')
      return { type, code: R_AUTH_FAIL_CODE }
    }
    case 'H_PAIR_LISTEN': {
      const ttl = r.u16()
      if (ttl > PAIR_TTL_S) fail('malformed', 'ttl above PAIR_TTL')
      const n = r.u8()
      if (n < 1 || n > 2) fail('malformed', 'n must be 1 or 2')
      const rvs: Bytes[] = []
      for (let i = 0; i < n; i++) rvs.push(r.take(16))
      return { type, ttl, rvs }
    }
    case 'R_PAIR_STATE': {
      const code = r.u8()
      if (code > 2) fail('malformed', 'pair state code')
      return { type, code }
    }
    case 'H_DENY': {
      const n = r.u16()
      if (r.remaining !== n * 24) fail('malformed', 'H_DENY size')
      if (n > DENY_MAX) { r.rest(); return { type, entries: [], overflow: true } }
      const entries: DenyEntry[] = []
      for (let i = 0; i < n; i++) entries.push({ ticketId: r.take(16), exp: r.u64() })
      return { type, entries, overflow: false }
    }
    case 'R_NOTICE': {
      const code = r.u8()
      if (code !== NOTICE.secondHouse && code !== NOTICE.limit) fail('malformed', 'notice code')
      return { type, code }
    }
    case 'ROUTE_OPEN': {
      const routeId = r.u32()
      const kind = r.u8()
      if (kind !== ROUTE_KIND.admit && kind !== ROUTE_KIND.pair) fail('malformed', 'route kind')
      return { type, routeId, kind, hint: r.take(16) }
    }
    case 'ROUTE_DATA': {
      const routeId = r.u32()
      const inner = r.rest()
      if (inner.length < 1) fail('malformed', 'empty inner frame')
      if (inner.length > MAX_INNER) fail('too-large', 'inner frame above MAX_INNER')
      return { type, routeId, inner }
    }
    case 'ROUTE_CLOSE': return { type, routeId: r.u32() }
    case 'LINK_PING': case 'LINK_PONG': return { type, echo: r.take(8) }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Inner frame: itype(1) ‖ body. What the relay forwards without opening (spec 2.3).
// ---------------------------------------------------------------------------------------------------------------

export const ITYPE = {
  HS1: 0x01, HS2: 0x02, HS3: 0x03, HS_FAIL: 0x0f, P1: 0x11, P2: 0x12, P3: 0x13, P4: 0x14, REC: 0x20,
} as const
export type InnerType = keyof typeof ITYPE

/** Sizes of the fixed handshake frames, type byte included. */
export const INNER_SIZE = { HS1: 100, HS2: 178, HS3: 97, P1: 51, P2: 163, P4: 81, HS_FAIL: 1 } as const
/** P3: e_D(65) ‖ N_D(32) ‖ lp16(ct3), ct3 = lp16(DeviceHello 132..196) ‖ sig(64) ‖ tag(16) (spec 11 Q17). */
export const P3_MAX = 378
export const P3_CT_MIN = 214
export const P3_CT_MAX = 278
/** Smallest record: type ‖ ctr(8) ‖ 5 bytes of plaintext header ‖ tag(16). */
export const REC_MIN = 30

export type InnerFrame =
  | { type: 'HS1'; ver: number; suite: number; eD: Bytes; nD: Bytes }
  | { type: 'HS2'; eH: Bytes; nH: Bytes; ct2: Bytes }
  | { type: 'HS3'; ct3: Bytes }
  | { type: 'P1'; ver: number; suite: number; rv: Bytes; commit: Bytes }
  | { type: 'P2'; eH: Bytes; nH: Bytes; pubH: Bytes }
  | { type: 'P3'; eD: Bytes; nD: Bytes; ct3: Bytes }
  | { type: 'P4'; ct4: Bytes }
  | { type: 'HS_FAIL' }
  /** `sealed` is ct ‖ tag; `ctr` is the counter as written on the wire, which the receiver does not trust. */
  | { type: 'REC'; ctr: number; sealed: Bytes }

const ITYPE_NAME = new Map<number, InnerType>((Object.keys(ITYPE) as InnerType[]).map(k => [ITYPE[k], k]))

export function encodeInner(f: InnerFrame): Bytes {
  const t = u8(ITYPE[f.type])
  let out: Bytes
  switch (f.type) {
    case 'HS1': out = concat(t, u8(f.ver), u8(f.suite), sized(f.eD, 65, 'e_D'), sized(f.nD, 32, 'N_D')); break
    case 'HS2': out = concat(t, sized(f.eH, 65, 'e_H'), sized(f.nH, 32, 'N_H'), sized(f.ct2, 80, 'ct2')); break
    case 'HS3': out = concat(t, sized(f.ct3, 96, 'ct3')); break
    case 'P1': out = concat(t, u8(f.ver), u8(f.suite), sized(f.rv, 16, 'rv'), sized(f.commit, 32, 'commit')); break
    case 'P2': out = concat(t, sized(f.eH, 65, 'e_H'), sized(f.nH, 32, 'N_H'), sized(f.pubH, 65, 'pub_H')); break
    case 'P3':
      if (f.ct3.length < P3_CT_MIN || f.ct3.length > P3_CT_MAX) fail('malformed', 'ct3 size')
      out = concat(t, sized(f.eD, 65, 'e_D'), sized(f.nD, 32, 'N_D'), lp16(f.ct3))
      break
    case 'P4': out = concat(t, sized(f.ct4, 80, 'ct4')); break
    case 'HS_FAIL': out = t; break
    case 'REC':
      out = concat(t, u64(f.ctr), f.sealed)
      if (out.length < REC_MIN) fail('malformed', 'record below its minimum')
      break
  }
  if (out.length > MAX_INNER) fail('too-large', 'inner frame above MAX_INNER')
  return out
}

/** The type of an inner frame without decoding it, or undefined when the first byte is not a known type. */
export function innerTypeOf(bytes: Uint8Array): InnerType | undefined {
  return bytes.length > 0 ? ITYPE_NAME.get(bytes[0]!) : undefined
}

export function decodeInner(bytes: Uint8Array): InnerFrame {
  if (bytes.length > MAX_INNER) fail('too-large', 'inner frame above MAX_INNER')
  const r = new Reader(bytes)
  const type = ITYPE_NAME.get(r.u8())
  if (!type) return fail('unknown-type', 'inner type')
  if (type !== 'REC' && type !== 'P3' && bytes.length !== INNER_SIZE[type]) fail('malformed', `${type} size`)
  let f: InnerFrame
  switch (type) {
    case 'HS1': f = { type, ver: r.u8(), suite: r.u8(), eD: r.take(65), nD: r.take(32) }; break
    case 'HS2': f = { type, eH: r.take(65), nH: r.take(32), ct2: r.take(80) }; break
    case 'HS3': f = { type, ct3: r.take(96) }; break
    case 'P1': f = { type, ver: r.u8(), suite: r.u8(), rv: r.take(16), commit: r.take(32) }; break
    case 'P2': f = { type, eH: r.take(65), nH: r.take(32), pubH: r.take(65) }; break
    case 'P3': {
      if (bytes.length > P3_MAX) fail('too-large', 'P3 above its cap')
      const eD = r.take(65)
      const nD = r.take(32)
      const ct3 = r.lp16()
      if (ct3.length < P3_CT_MIN || ct3.length > P3_CT_MAX) fail('malformed', 'ct3 size')
      f = { type, eD, nD, ct3 }
      break
    }
    case 'P4': f = { type, ct4: r.take(80) }; break
    case 'HS_FAIL': f = { type }; break
    case 'REC': {
      if (bytes.length < REC_MIN) fail('malformed', 'record below its minimum')
      f = { type, ctr: r.u64(), sealed: r.rest() }
      break
    }
  }
  r.end()
  return f
}

/** The one-byte HS_FAIL frame: no reason, equivalent to a dropped connection (spec 2.3). */
export const HS_FAIL_FRAME = (): Bytes => u8(ITYPE.HS_FAIL)
