// Web Push from the portal (RR4 step 4.4; plano §2 "Push", fio-spec 15): the house dials the push service of a device
// itself, never through the relay. Three RFCs, over crypto.subtle only (no dependency, the same module in Node and a
// browser):
//   RFC 8188  the `aes128gcm` content coding (records of AES-128-GCM under keys derived by HKDF from IKM and a salt);
//   RFC 8291  the message encryption of Web Push (ECDH with the device's key and its auth secret give the IKM of 8188);
//   RFC 8292  VAPID: the house proves to the push service, with a key of its own (K_V, never K_H: M-11), who sends.
// And the rule of the endpoint (M-11): the URL comes from a device, so the portal POSTs only to a public push service of
// the list (FCM, Mozilla, Apple, WNS), over https on the default port, never to an IP, a local name or a URL with a
// credential; a bench origin is accepted only where the caller passes it (src/remoted/main.ts, bench only).
//
// What a notice carries (PushNotice) is also here: the portal builds it, the service worker reads it. Never the text of a
// speech, a question or a terminal, never a path nor a name: a fixed title, a fixed phrase, an opaque tag and the query
// of the place to open.
import { b64url, concat, copy, fail, fromB64url, u32, utf8, utf8Decode, WireError, type Bytes } from './bytes.ts'
import { ecdhBits, generateEphemeral, hkdf, validatePoint, type Ephemeral } from './crypto.ts'

const subtle = (): SubtleCrypto => globalThis.crypto.subtle

// ---------------------------------------------------------------------------------------------------------------------
// RFC 8188: aes128gcm
// ---------------------------------------------------------------------------------------------------------------------

/** The record size the house writes (RFC 8291 section 4: a push message is one record of at most 4096 octets). */
export const PUSH_RECORD_SIZE = 4096
const TAG = 16
const HEADER_FIXED = 21 // salt(16) ‖ rs(4) ‖ idlen(1)

async function contentKeys(ikm: Uint8Array, salt: Uint8Array): Promise<{ cek: CryptoKey; nonce: Bytes }> {
  const cekBytes = await hkdf(ikm, salt, utf8('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(ikm, salt, utf8('Content-Encoding: nonce\0'), 12)
  try {
    const cek = await subtle().importKey('raw', cekBytes, 'AES-GCM', false, ['encrypt', 'decrypt'])
    return { cek, nonce }
  } finally { cekBytes.fill(0) }
}

/** The nonce of record `seq`: the derived NONCE with the sequence number XORed into its last six octets. */
function recordNonce(nonce: Bytes, seq: number): Bytes {
  const out = copy(nonce)
  for (let i = 0; i < 6; i++) out[11 - i]! ^= Math.floor(seq / 2 ** (8 * i)) & 0xff
  return out
}

/**
 * One record of `aes128gcm` (RFC 8188 section 2): the header (salt, record size, key id) and the plaintext, its delimiter
 * 0x02 (the last record) and `pad` zero octets, sealed. Web Push needs a single record; a plaintext that does not fit `rs`
 * is refused.
 */
export async function aes128gcmEncrypt(o: { ikm: Uint8Array; salt: Uint8Array; keyid?: Uint8Array; plaintext: Uint8Array; rs?: number; pad?: number }): Promise<Bytes> {
  const rs = o.rs ?? PUSH_RECORD_SIZE
  const keyid = o.keyid ?? new Uint8Array(0)
  const pad = o.pad ?? 0
  if (o.salt.length !== 16) fail('malformed', 'salt must be 16 octets')
  if (keyid.length > 255) fail('malformed', 'keyid too long')
  if (!Number.isInteger(pad) || pad < 0) fail('range', 'pad')
  if (o.plaintext.length + 1 + pad + TAG > rs) fail('too-large', 'one record only')
  const { cek, nonce } = await contentKeys(o.ikm, o.salt)
  const record = concat(o.plaintext, Uint8Array.of(0x02), new Uint8Array(pad))
  const sealed = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: recordNonce(nonce, 0), tagLength: 128 }, cek, record))
  record.fill(0)
  return concat(o.salt, u32(rs), Uint8Array.of(keyid.length), keyid, sealed)
}

/** The header of an `aes128gcm` body. */
export function aes128gcmHeader(body: Uint8Array): { salt: Bytes; rs: number; keyid: Bytes; at: number } {
  if (body.length < HEADER_FIXED) fail('malformed', 'short header')
  const rs = ((body[16]! << 24) >>> 0) + (body[17]! << 16) + (body[18]! << 8) + body[19]!
  const idlen = body[20]!
  if (rs < 18) fail('malformed', 'record size')
  if (body.length < HEADER_FIXED + idlen) fail('malformed', 'short key id')
  return { salt: copy(body.subarray(0, 16)), rs, keyid: copy(body.subarray(HEADER_FIXED, HEADER_FIXED + idlen)), at: HEADER_FIXED + idlen }
}

/**
 * Opens an `aes128gcm` body (RFC 8188 section 2), any number of records: each but the last ends with 0x01, the last with
 * 0x02, then zero padding. A truncated body, a wrong tag or a missing delimiter fails with `auth`/`malformed`.
 */
export async function aes128gcmDecrypt(ikm: Uint8Array, body: Uint8Array): Promise<{ plaintext: Bytes; keyid: Bytes }> {
  const h = aes128gcmHeader(body)
  const { cek, nonce } = await contentKeys(ikm, h.salt)
  const parts: Bytes[] = []
  let at = h.at
  let seq = 0
  let last = false
  while (at < body.length) {
    if (last) fail('malformed', 'data after the last record')
    const end = Math.min(body.length, at + h.rs)
    if (end - at <= TAG) fail('malformed', 'short record')
    let open: Bytes
    try {
      open = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: recordNonce(nonce, seq), tagLength: 128 }, cek, copy(body.subarray(at, end))))
    } catch { return fail('auth', 'record does not open') }
    let i = open.length - 1
    while (i >= 0 && open[i] === 0) i--
    if (i < 0) fail('malformed', 'record without delimiter')
    if (open[i] === 0x02) last = true
    else if (open[i] !== 0x01) fail('malformed', 'bad delimiter')
    // A record that is not the last fills the record size exactly.
    if (!last && end - at !== h.rs) fail('malformed', 'short inner record')
    parts.push(copy(open.subarray(0, i)))
    open.fill(0)
    at = end
    seq++
  }
  if (!last) fail('malformed', 'no last record')
  return { plaintext: concat(...parts), keyid: h.keyid }
}

// ---------------------------------------------------------------------------------------------------------------------
// RFC 8291: Message Encryption for Web Push
// ---------------------------------------------------------------------------------------------------------------------

/** The auth secret of a subscription is 16 octets (RFC 8291 section 3.2). */
export const PUSH_AUTH_SIZE = 16

/** IKM of RFC 8291 section 3.3, from the ECDH secret, the auth secret and both public keys. */
async function pushIkm(ecdh: Bytes, auth: Uint8Array, uaPublic: Uint8Array, asPublic: Uint8Array): Promise<Bytes> {
  const keyInfo = concat(utf8('WebPush: info\0'), uaPublic, asPublic)
  return hkdf(ecdh, auth, keyInfo, 32)
}

/**
 * Encrypts one push message for a subscription (RFC 8291): a fresh application-server key pair and a fresh salt for each
 * message (both may be given, for the RFC's vector), the device's public key (`p256dh`) and its auth secret, one record of
 * aes128gcm with the server's public key as key id. `padTo` pads the plaintext to a multiple of that many octets so the
 * push service does not learn the length of what it carries.
 */
export async function webPushEncrypt(o: {
  uaPublic: Uint8Array; auth: Uint8Array; plaintext: Uint8Array; padTo?: number
  asKey?: Ephemeral; salt?: Uint8Array
}): Promise<Bytes> {
  if (o.auth.length !== PUSH_AUTH_SIZE) fail('malformed', 'auth secret must be 16 octets')
  await validatePoint(o.uaPublic)
  const as = o.asKey ?? (await generateEphemeral())
  const salt = o.salt ?? globalThis.crypto.getRandomValues(new Uint8Array(16))
  const ecdh = await ecdhBits(as.privateKey, o.uaPublic)
  const ikm = await pushIkm(ecdh, o.auth, o.uaPublic, as.pub)
  ecdh.fill(0)
  try {
    const unit = o.padTo ?? 0
    const pad = unit > 0 ? (unit - ((o.plaintext.length + 1) % unit)) % unit : 0
    return await aes128gcmEncrypt({ ikm, salt, keyid: as.pub, plaintext: o.plaintext, rs: PUSH_RECORD_SIZE, pad })
  } finally { ikm.fill(0) }
}

/** Decrypts a push message with the device's private key (the browser's half: for the bench's fake push service and tests). */
export async function webPushDecrypt(o: { uaPrivate: CryptoKey; uaPublic: Uint8Array; auth: Uint8Array; body: Uint8Array }): Promise<Bytes> {
  const h = aes128gcmHeader(o.body)
  if (h.keyid.length !== 65) fail('malformed', 'the key id is the server key')
  const ecdh = await ecdhBits(o.uaPrivate, h.keyid)
  const ikm = await pushIkm(ecdh, o.auth, o.uaPublic, h.keyid)
  ecdh.fill(0)
  try { return (await aes128gcmDecrypt(ikm, o.body)).plaintext } finally { ikm.fill(0) }
}

/** An ECDH private key from its raw scalar and public point (RFC vectors give both in base64url). */
export async function importEcdhPrivate(d: Uint8Array, pub: Uint8Array): Promise<CryptoKey> {
  if (d.length !== 32 || pub.length !== 65 || pub[0] !== 0x04) fail('malformed', 'P-256 key')
  const jwk = { kty: 'EC', crv: 'P-256', d: b64url(d), x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33)), ext: false }
  return subtle().importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
}

// ---------------------------------------------------------------------------------------------------------------------
// RFC 8292: VAPID
// ---------------------------------------------------------------------------------------------------------------------

/** K_V: the house's VAPID key (ECDSA P-256), its private half non-extractable, and its public point. */
export interface VapidKey { privateKey: CryptoKey; pub: Bytes }

/**
 * The `sub` claim: a contact the push service may use. It names no house and no person (an RFC 6761 `.invalid` address):
 * the only thing that ties the messages of one house together is K_V itself.
 */
export const VAPID_SUB = 'mailto:push@tether.invalid'
/** A token lives 12 h (the RFC caps it at 24 h). */
export const VAPID_TTL_S = 12 * 3600

export async function importVapidKey(pkcs8: Uint8Array, pub: Uint8Array): Promise<VapidKey> {
  await validatePoint(pub)
  const privateKey = await subtle().importKey('pkcs8', copy(pkcs8), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  return { privateKey, pub: copy(pub) }
}

const json64 = (v: unknown): string => b64url(utf8(JSON.stringify(v)))

/** The `Authorization` header of RFC 8292 section 3: `vapid t=<JWT ES256>, k=<public key>`, for the origin of the endpoint. */
export async function vapidAuthorization(key: VapidKey, aud: string, nowS: number, sub = VAPID_SUB): Promise<string> {
  const signing = `${json64({ typ: 'JWT', alg: 'ES256' })}.${json64({ aud, exp: nowS + VAPID_TTL_S, sub })}`
  const sig = new Uint8Array(await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, utf8(signing)))
  return `vapid t=${signing}.${b64url(sig)}, k=${b64url(key.pub)}`
}

export type VapidVerdict = { ok: true; pub: Bytes; sub: string; exp: number } | { ok: false; why: 'malformed' | 'alg' | 'aud' | 'exp' | 'signature' }

/**
 * Checks a VAPID header as a push service would (the bench's fake service, and tests): the JWT's header is ES256, `aud`
 * is the endpoint's origin, `exp` is in the future and at most 24 h away, `sub` is present, and the signature verifies
 * with the key in `k=`.
 */
export async function verifyVapid(header: string, aud: string, nowS: number): Promise<VapidVerdict> {
  const m = /^vapid t=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\s*,\s*k=([A-Za-z0-9_-]+)$/.exec(header.trim())
  if (!m) return { ok: false, why: 'malformed' }
  let head: { typ?: unknown; alg?: unknown }
  let claims: { aud?: unknown; exp?: unknown; sub?: unknown }
  let pub: Bytes
  let sig: Bytes
  try {
    head = JSON.parse(utf8Decode(fromB64url(m[1]!))) as typeof head
    claims = JSON.parse(utf8Decode(fromB64url(m[2]!))) as typeof claims
    pub = fromB64url(m[4]!)
    sig = fromB64url(m[3]!)
    await validatePoint(pub)
  } catch { return { ok: false, why: 'malformed' } }
  if (head.alg !== 'ES256' || sig.length !== 64) return { ok: false, why: 'alg' }
  if (claims.aud !== aud) return { ok: false, why: 'aud' }
  if (typeof claims.exp !== 'number' || claims.exp <= nowS || claims.exp > nowS + 24 * 3600) return { ok: false, why: 'exp' }
  if (typeof claims.sub !== 'string' || claims.sub === '') return { ok: false, why: 'malformed' }
  const k = await subtle().importKey('raw', pub, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
  const good = await subtle().verify({ name: 'ECDSA', hash: 'SHA-256' }, k, sig, utf8(`${m[1]}.${m[2]}`))
  return good ? { ok: true, pub, sub: claims.sub, exp: claims.exp } : { ok: false, why: 'signature' }
}

// ---------------------------------------------------------------------------------------------------------------------
// The endpoint (M-11)
// ---------------------------------------------------------------------------------------------------------------------

/** The longest endpoint kept (the services' URLs are a few hundred characters). */
export const PUSH_ENDPOINT_MAX = 1024
/** The public push services, by exact host. */
export const PUSH_HOSTS: readonly string[] = ['fcm.googleapis.com', 'updates.push.services.mozilla.com']
/** The public push services whose hosts vary under one domain (Apple, Windows), by suffix. */
export const PUSH_HOST_SUFFIXES: readonly string[] = ['.push.apple.com', '.notify.windows.com']

export type EndpointRefusal = 'malformed' | 'too-long' | 'scheme' | 'userinfo' | 'port' | 'ip' | 'local' | 'host'
export type EndpointVerdict = { ok: true; origin: string; host: string } | { ok: false; why: EndpointRefusal }

const IPV4ISH = /^[0-9.]+$|^0x/i

/**
 * Whether the portal may POST to this endpoint. `https:`, the default port, no user nor password, a host name (never an
 * IP literal, `localhost`, `.local`, `.internal` nor a name without a dot) of PUSH_HOSTS or under PUSH_HOST_SUFFIXES.
 * `benchOrigin` (src/remoted/main.ts gives it only on the bench, from TETHER_TEST_REMOTE_PUSH_ORIGIN) is one more origin
 * accepted as it is, so a test reaches its fake service on `http://localhost:<port>`.
 */
export function pushEndpointCheck(url: unknown, benchOrigin?: string): EndpointVerdict {
  if (typeof url !== 'string' || url === '') return { ok: false, why: 'malformed' }
  if (url.length > PUSH_ENDPOINT_MAX) return { ok: false, why: 'too-long' }
  let u: URL
  try { u = new URL(url) } catch { return { ok: false, why: 'malformed' } }
  if (benchOrigin !== undefined && u.origin === benchOrigin && u.username === '' && u.password === '') return { ok: true, origin: u.origin, host: u.host }
  if (u.protocol !== 'https:') return { ok: false, why: 'scheme' }
  if (u.username !== '' || u.password !== '') return { ok: false, why: 'userinfo' }
  if (u.port !== '') return { ok: false, why: 'port' }
  const host = u.hostname.toLowerCase()
  if (host.startsWith('[') || IPV4ISH.test(host)) return { ok: false, why: 'ip' }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.')) return { ok: false, why: 'local' }
  const listed = PUSH_HOSTS.includes(host) || PUSH_HOST_SUFFIXES.some((s) => host.endsWith(s) && host.length > s.length)
  return listed ? { ok: true, origin: u.origin, host } : { ok: false, why: 'host' }
}

/** The bench's extra origin: `http://localhost:<port>` exactly, or nothing. */
export function benchPushOrigin(v: string | undefined): string | undefined {
  if (v === undefined || !/^http:\/\/localhost:\d{2,5}$/.test(v)) return undefined
  return v
}

/** A subscription as a device gives it (PushSubscription.toJSON): the endpoint and the two keys, base64url. */
export interface PushSubscriptionInput { endpoint: string; p256dh: string; auth: string }
export type PushSubscriptionVerdict = { ok: true; sub: PushSubscriptionInput; host: string } | { ok: false; why: EndpointRefusal | 'keys' }

const unpad = (s: string): string => s.replace(/=+$/, '')

/** The subscription a device sent, checked: the endpoint by pushEndpointCheck, `p256dh` a point of P-256, `auth` 16 octets. */
export async function checkPushSubscription(body: Record<string, unknown>, benchOrigin?: string): Promise<PushSubscriptionVerdict> {
  const e = pushEndpointCheck(body.endpoint, benchOrigin)
  if (!e.ok) return e
  const { p256dh, auth } = body
  if (typeof p256dh !== 'string' || typeof auth !== 'string' || p256dh.length > 100 || auth.length > 32) return { ok: false, why: 'keys' }
  try {
    const pub = fromB64url(unpad(p256dh))
    const a = fromB64url(unpad(auth))
    if (a.length !== PUSH_AUTH_SIZE) return { ok: false, why: 'keys' }
    await validatePoint(pub)
    return { ok: true, sub: { endpoint: body.endpoint as string, p256dh: b64url(pub), auth: b64url(a) }, host: e.host }
  } catch (err) {
    if (err instanceof WireError) return { ok: false, why: 'keys' }
    throw err
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The notice
// ---------------------------------------------------------------------------------------------------------------------

/** Why the person is told: an agent began to wait for her, a speech addressed to her, a poll that calls her. Nothing else. */
export type PushKind = 'waiting' | 'talk' | 'poll'
export const PUSH_KINDS: readonly PushKind[] = ['waiting', 'talk', 'poll']

/**
 * What one push carries, and what the service worker shows. A notice is read on a locked screen, by whoever holds the
 * phone, and names are text agents choose (a tab's, a channel's): so no name and no text goes, only words the house
 * chose. `title`: always PUSH_TITLE; `body`: the fixed phrase of its kind; `tag`: one per agent or channel, so a new
 * notice replaces the old one, opaque (noticeTag); `url`: the query of the place to open (`?c=<channel>` or
 * `?tab=waiting`), never a path or a host.
 */
export interface PushNotice { kind: PushKind; title: string; body: string; tag: string; url: string }

export const PUSH_TITLE = 'tether'
/** The phrase of each kind: the only words of a notice besides PUSH_TITLE. */
export const PUSH_BODIES: Readonly<Record<PushKind, string>> = {
  waiting: 'Um agente espera você',
  talk: 'Falaram com você num canal',
  poll: 'Uma enquete chama você',
}
/** `a:` for an agent, `c:` for a channel, then 16 hex digits (noticeTag). */
const TAG_RE = /^[ac]:[0-9a-f]{16}$/
const URL_RE = /^\?(?:c=[A-Za-z0-9_.:-]{1,80}|tab=waiting)$/

/**
 * The tag of an agent's (`a`) or a channel's (`c`) notices: FNV-1a 64 of the id, in hex. It only has to stay the same for
 * one id and differ between ids, and say nothing legible; it is no secret (the notice's `url` carries the id itself, and
 * neither leaves the encrypted body but on the device).
 */
export function noticeTag(of: 'a' | 'c', id: string): string {
  let h = 0xcbf29ce484222325n
  for (const b of utf8(id)) h = ((h ^ BigInt(b)) * 0x100000001b3n) & 0xffffffffffffffffn
  return `${of}:${h.toString(16).padStart(16, '0')}`
}

/**
 * Reads a notice as the service worker gets it: whatever does not have the shape is dropped (null), and a title or a body
 * that is not the house's own words for that kind does not have it. The service worker shows only what passes; it keeps
 * nothing of it.
 */
export function parsePushNotice(raw: unknown): PushNotice | null {
  if (typeof raw !== 'object' || raw === null) return null
  const n = raw as Record<string, unknown>
  const { kind, title, body, tag, url } = n
  if (typeof kind !== 'string' || !(PUSH_KINDS as readonly string[]).includes(kind)) return null
  if (title !== PUSH_TITLE || body !== PUSH_BODIES[kind as PushKind]) return null
  if (typeof tag !== 'string' || !TAG_RE.test(tag) || tag[0] !== (kind === 'waiting' ? 'a' : 'c')) return null
  if (typeof url !== 'string' || !URL_RE.test(url) || (kind === 'waiting') !== (url === '?tab=waiting')) return null
  return { kind: kind as PushKind, title, body, tag, url }
}
