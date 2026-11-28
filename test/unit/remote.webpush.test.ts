// Web Push of the portal (RR4 step 4.4, fio-spec 15): the content coding of RFC 8188, the message encryption of RFC 8291
// and VAPID of RFC 8292, against the RFCs' own example values (public, copied from the RFC text), and the rule of the
// endpoint (M-11: only a public push service of the list, never a door into the person's network).
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { b64url, concat, fromB64url, utf8, utf8Decode } from '../../src/remote/bytes.ts'
import { generateEphemeral } from '../../src/remote/crypto.ts'
import {
  aes128gcmDecrypt, aes128gcmEncrypt, benchPushOrigin, checkPushSubscription, importEcdhPrivate, importVapidKey, noticeBody, parsePushNotice,
  pushEndpointCheck, PUSH_ENDPOINT_MAX, vapidAuthorization, verifyVapid, webPushDecrypt, webPushEncrypt, type VapidKey,
} from '../../src/remote/webpush.ts'

const d = fromB64url

describe('RFC 8188 (aes128gcm)', () => {
  test('section 3.1: one record, the RFC\'s salt and key, the RFC\'s bytes', async () => {
    const body = await aes128gcmEncrypt({ ikm: d('yqdlZ-tYemfogSmv7Ws5PQ'), salt: d('I1BsxtFttlv3u_Oo94xnmw'), plaintext: utf8('I am the walrus'), rs: 4096 })
    assert.equal(b64url(body), 'I1BsxtFttlv3u_Oo94xnmwAAEAAA-NAVub2qFgBEuQKRapoZu-IxkIva3MEB1PD-ly8Thjg')
    assert.equal(utf8Decode((await aes128gcmDecrypt(d('yqdlZ-tYemfogSmv7Ws5PQ'), body)).plaintext), 'I am the walrus')
  })

  test('section 3.2: two records of rs 25 with key id "a1" open to the same message', async () => {
    const body = d('uNCkWiNYzKTnBN9ji3-qWAAAABkCYTHOG8chz_gnvgOqdGYovxyjuqRyJFjEDyoF1Fvkj6hQPdPHI51OEUKEpgz3SsLWIqS_uA')
    const r = await aes128gcmDecrypt(d('BO3ZVPxUlnLORbVGMpbT1Q'), body)
    assert.equal(utf8Decode(r.plaintext), 'I am the walrus')
    assert.equal(utf8Decode(r.keyid), 'a1')
  })

  test('a flipped bit, a cut body or a wrong key does not open', async () => {
    const ikm = d('yqdlZ-tYemfogSmv7Ws5PQ')
    const body = d('I1BsxtFttlv3u_Oo94xnmwAAEAAA-NAVub2qFgBEuQKRapoZu-IxkIva3MEB1PD-ly8Thjg')
    const flipped = body.slice()
    flipped[30]! ^= 1
    await assert.rejects(aes128gcmDecrypt(ikm, flipped), /auth/)
    await assert.rejects(aes128gcmDecrypt(ikm, body.slice(0, body.length - 3)), /auth|malformed/)
    await assert.rejects(aes128gcmDecrypt(d('BO3ZVPxUlnLORbVGMpbT1Q'), body), /auth/)
    await assert.rejects(aes128gcmEncrypt({ ikm, salt: new Uint8Array(16), plaintext: new Uint8Array(4096) }), /too-large/)
  })
})

// RFC 8291 Appendix A.
const A = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  header: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  ciphertext: '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ',
}

describe('RFC 8291 (Web Push message encryption)', () => {
  test('Appendix A: the RFC\'s keys, salt and secret give the RFC\'s message, byte for byte', async () => {
    const asKey = { pub: d(A.asPublic), privateKey: await importEcdhPrivate(d(A.asPrivate), d(A.asPublic)) }
    const body = await webPushEncrypt({ uaPublic: d(A.uaPublic), auth: d(A.auth), plaintext: d(A.plaintext), asKey, salt: d(A.salt) })
    assert.equal(b64url(body), b64url(concat(d(A.header), d(A.ciphertext))))
  })

  test('Appendix A: the device\'s half opens the RFC\'s message', async () => {
    const uaPrivate = await importEcdhPrivate(d(A.uaPrivate), d(A.uaPublic))
    const pt = await webPushDecrypt({ uaPrivate, uaPublic: d(A.uaPublic), auth: d(A.auth), body: concat(d(A.header), d(A.ciphertext)) })
    assert.equal(utf8Decode(pt), 'When I grow up, I want to be a watermelon')
  })

  test('live: fresh keys each message, padded to a multiple, and only the subscription opens it', async () => {
    const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
    const uaPublic = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey))
    const auth = crypto.getRandomValues(new Uint8Array(16))
    const a = await webPushEncrypt({ uaPublic, auth, plaintext: utf8('x'), padTo: 256 })
    const b = await webPushEncrypt({ uaPublic, auth, plaintext: utf8('a much longer name than x'), padTo: 256 })
    assert.equal(a.length, b.length, 'the length of the name does not show')
    assert.notEqual(b64url(a.subarray(0, 16)), b64url(b.subarray(0, 16)), 'a fresh salt')
    assert.notEqual(b64url(a.subarray(21, 86)), b64url(b.subarray(21, 86)), 'a fresh server key')
    assert.equal(utf8Decode(await webPushDecrypt({ uaPrivate: ua.privateKey, uaPublic, auth, body: b })), 'a much longer name than x')
    const other = crypto.getRandomValues(new Uint8Array(16))
    await assert.rejects(webPushDecrypt({ uaPrivate: ua.privateKey, uaPublic, auth: other, body: b }), /auth/)
    await assert.rejects(webPushEncrypt({ uaPublic, auth: new Uint8Array(15), plaintext: utf8('x') }), /malformed/)
    await assert.rejects(webPushEncrypt({ uaPublic: uaPublic.slice(1), auth, plaintext: utf8('x') }), /bad-point/)
  })
})

async function newVapid(): Promise<VapidKey> {
  const k = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', k.privateKey))
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', k.publicKey))
  return importVapidKey(pkcs8, pub)
}

describe('RFC 8292 (VAPID)', () => {
  test('section 2.4: the example\'s k= is the uncompressed point of the example\'s JWK (x, y)', () => {
    const k = d('BA1Hxzyi1RUM1b5wjxsn7nGxAszw2u61m164i3MrAIxHF6YK5h4SDYic-dRuU_RCPCfA5aq9ojSwk5Y2EmClBPs')
    assert.equal(k[0], 0x04)
    assert.equal(b64url(k.subarray(1, 33)), 'DUfHPKLVFQzVvnCPGyfucbECzPDa7rWbXriLcysAjEc')
    assert.equal(b64url(k.subarray(33)), 'F6YK5h4SDYic-dRuU_RCPCfA5aq9ojSwk5Y2EmClBPs')
  })

  test('the header has the RFC\'s form and claims, signs ES256, and binds the audience and the time', async () => {
    const key = await newVapid()
    const now = 1_800_000_000
    const h = await vapidAuthorization(key, 'https://push.example.net', now)
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(h)
    assert.ok(m)
    assert.deepEqual(JSON.parse(utf8Decode(d(m[1]!))), { typ: 'JWT', alg: 'ES256' })
    const claims = JSON.parse(utf8Decode(d(m[2]!))) as { aud: string; exp: number; sub: string }
    assert.equal(claims.aud, 'https://push.example.net')
    assert.ok(claims.exp > now && claims.exp <= now + 24 * 3600)
    assert.match(claims.sub, /^mailto:.+\.invalid$/, 'the contact names no house')
    assert.equal(m[4], b64url(key.pub))
    const ok = await verifyVapid(h, 'https://push.example.net', now)
    assert.equal(ok.ok, true)
    assert.equal((await verifyVapid(h, 'https://other.example', now)).ok, false)
    assert.equal((await verifyVapid(h, 'https://push.example.net', now + 13 * 3600)).ok, false)
    const forged = h.replace(/k=.+$/, `k=${b64url((await newVapid()).pub)}`)
    assert.deepEqual(await verifyVapid(forged, 'https://push.example.net', now), { ok: false, why: 'signature' })
  })

  test('the private half of K_V cannot be exported from the portal', async () => {
    const key = await newVapid()
    assert.equal(key.privateKey.extractable, false)
    await assert.rejects(crypto.subtle.exportKey('pkcs8', key.privateKey))
  })
})

describe('the endpoint (M-11)', () => {
  test('the four public services are accepted', () => {
    for (const url of [
      'https://fcm.googleapis.com/fcm/send/abc:def',
      'https://updates.push.services.mozilla.com/wpush/v2/gAAAA',
      'https://web.push.apple.com/QGxyz',
      'https://wns2-par02p.notify.windows.com/w/?token=AwYAAA',
    ]) assert.equal(pushEndpointCheck(url).ok, true, url)
  })

  test('anything else is refused, with why', () => {
    const cases: [unknown, string][] = [
      ['http://fcm.googleapis.com/fcm/send/x', 'scheme'],
      ['https://10.0.0.1/push', 'ip'],
      ['https://192.168.0.10/fcm/send/x', 'ip'],
      ['https://[::1]/x', 'ip'],
      ['https://0x7f000001/x', 'ip'],
      ['https://localhost/x', 'local'],
      ['https://printer.local/x', 'local'],
      ['https://router.internal/x', 'local'],
      ['https://intranet/x', 'local'],
      ['https://evil.example/fcm/send/x', 'host'],
      ['https://fcm.googleapis.com.evil.example/x', 'host'],
      ['https://push.apple.com/x', 'host'],
      ['https://notapple.com/x', 'host'],
      ['https://user:pass@fcm.googleapis.com/fcm/send/x', 'userinfo'],
      ['https://fcm.googleapis.com:8443/fcm/send/x', 'port'],
      [`https://fcm.googleapis.com/fcm/send/${'a'.repeat(PUSH_ENDPOINT_MAX)}`, 'too-long'],
      ['not a url', 'malformed'],
      [42, 'malformed'],
    ]
    for (const [url, why] of cases) assert.deepEqual(pushEndpointCheck(url), { ok: false, why }, String(url).slice(0, 60))
  })

  test('the bench origin is one exact http://localhost:<port>, and only where it is given', () => {
    assert.equal(benchPushOrigin('http://localhost:41234'), 'http://localhost:41234')
    for (const v of [undefined, 'https://localhost:1', 'http://127.0.0.1:41234', 'http://localhost', 'http://localhost:1/x', 'http://evil.example:80']) assert.equal(benchPushOrigin(v), undefined, String(v))
    assert.equal(pushEndpointCheck('http://localhost:41234/push/1').ok, false)
    assert.equal(pushEndpointCheck('http://localhost:41234/push/1', 'http://localhost:41234').ok, true)
    assert.equal(pushEndpointCheck('http://localhost:41235/push/1', 'http://localhost:41234').ok, false)
    assert.equal(pushEndpointCheck('http://u:p@localhost:41234/push/1', 'http://localhost:41234').ok, false)
  })

  test('a subscription needs a point of P-256 and a 16-octet secret', async () => {
    const e = await generateEphemeral()
    const endpoint = 'https://fcm.googleapis.com/fcm/send/abc'
    const good = await checkPushSubscription({ endpoint, p256dh: b64url(e.pub), auth: b64url(new Uint8Array(16).fill(7)) })
    assert.equal(good.ok, true)
    assert.equal((await checkPushSubscription({ endpoint, p256dh: `${b64url(e.pub)}=`, auth: `${b64url(new Uint8Array(16))}==` })).ok, true, 'padding is tolerated')
    assert.deepEqual(await checkPushSubscription({ endpoint, p256dh: b64url(e.pub.slice(1)), auth: b64url(new Uint8Array(16)) }), { ok: false, why: 'keys' })
    assert.deepEqual(await checkPushSubscription({ endpoint, p256dh: b64url(e.pub), auth: b64url(new Uint8Array(8)) }), { ok: false, why: 'keys' })
    assert.deepEqual(await checkPushSubscription({ endpoint: 'https://10.0.0.1/', p256dh: b64url(e.pub), auth: b64url(new Uint8Array(16)) }), { ok: false, why: 'ip' })
  })
})

describe('the notice', () => {
  test('fixed phrases, and the service worker reads only the shape', () => {
    assert.equal(noticeBody('waiting'), 'espera você')
    assert.equal(noticeBody('talk', 'obra'), 'falou com você em #obra')
    assert.equal(noticeBody('poll', 'obra'), 'abriu uma enquete em #obra')
    const n = { kind: 'talk', title: 'conferente', body: 'falou com você em #obra', tag: 'c:c_abc', url: '?c=c_abc' }
    assert.deepEqual(parsePushNotice(n), n)
    assert.deepEqual(parsePushNotice({ ...n, kind: 'waiting', tag: 'a:s1', url: '?tab=waiting' }), { ...n, kind: 'waiting', tag: 'a:s1', url: '?tab=waiting' })
    for (const bad of [
      null, 'x', { ...n, kind: 'other' }, { ...n, title: '' }, { ...n, title: 'x'.repeat(65) }, { ...n, body: 'x'.repeat(121) },
      { ...n, tag: 'x:1' }, { ...n, url: 'https://evil.example/' }, { ...n, url: '/elsewhere' }, { ...n, url: '?c=a&x=1' }, { ...n, url: '//evil.example' },
    ]) assert.equal(parsePushNotice(bad), null, JSON.stringify(bad))
  })
})
