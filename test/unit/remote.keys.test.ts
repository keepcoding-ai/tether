// Remote wire, layer 2 (spec 0.3, 1, 4.4, 5.1, 5.2, 6.4): the start-up self-test and point validation, HKDF, the
// one-message handshake keys, keys in their roles with domain labels, identifiers, key certificates, admission
// tickets and the key-rotation declaration. Negative tests of spec 9.2 are named with their number.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { ascii, concat, fromHex, toHex, u8, WireError, type Bytes } from '../../src/remote/bytes.ts'
import { ADMIT_TTL_S, CLOCK_SKEW_S, KEYCERT_TTL_R_S, KEYCERT_TTL_T_S, LBL } from '../../src/remote/constants.ts'
import {
  bodySizeOk, generateEphemeral, generateRoleKey, hasPointShape, hkdf, isValidPoint, OneShotKey, randomDigits,
  ROLE_LABELS, Secret, SELF_TEST_POINTS, selfTest, sha256, validatePoint, verifyLabeled,
} from '../../src/remote/crypto.ts'
import {
  deviceIdOf, encodeKeyRotateBody, houseFingerprint, houseIdOf, houseIdText, houseKeysDistinct, issueAdmitTicket,
  issueKeyCert, keyIdOf, parseAdmitTicket, parseKeyCert, relayAuthBody, relayPopBody, ticketTimeOk, verifyKeyCert,
  verifyKeyRotate,
} from '../../src/remote/keys.ts'

const NOW = 1_795_000_000
const fill = (n: number, v: number): Bytes => new Uint8Array(n).fill(v)
const rejects = async (p: Promise<unknown>): Promise<string> => {
  try { await p } catch (e) { return e instanceof WireError ? e.code : `other:${String(e)}` }
  return 'no-error'
}

/** P1363 (r ‖ s) to DER, as a WebAuthn authenticator or an OpenSSL signer would emit it. */
function toDer(sig: Uint8Array): Bytes {
  const int = (x: Uint8Array): Bytes => {
    let i = 0
    while (i < x.length - 1 && x[i] === 0) i++
    const body = x[i]! & 0x80 ? concat(u8(0), x.subarray(i)) : concat(x.subarray(i))
    return concat(u8(0x02), u8(body.length), body)
  }
  const seq = concat(int(sig.subarray(0, 32)), int(sig.subarray(32)))
  return concat(u8(0x30), u8(seq.length), seq)
}

describe('remote point validation and self-test', () => {
  test('the self-test passes on this platform, and is the same promise every time', async () => {
    await selfTest()
    assert.equal(selfTest(), selfTest())
  })

  test('V-11 / 1: valid accepted; off-curve, compressed, hybrid, wrong prefix and 64 bytes refused', async () => {
    assert.equal(await isValidPoint(SELF_TEST_POINTS.valid()), true)
    for (const name of ['offCurve', 'compressed', 'hybrid', 'badPrefix', 'short64'] as const) {
      assert.equal(await isValidPoint(SELF_TEST_POINTS[name]()), false, name)
      assert.equal(await rejects(validatePoint(SELF_TEST_POINTS[name]())), 'bad-point', name)
    }
    assert.equal(hasPointShape(SELF_TEST_POINTS.hybrid()), false, 'the hybrid form has 65 bytes and only the prefix check stops it')
    assert.equal(await isValidPoint(concat(u8(4), fill(64, 0))), false, 'the all-zero point')
    assert.equal(await isValidPoint(new Uint8Array(0)), false)
  })

  test('this platform does accept compressed and hybrid points in raw import: our shape check is what refuses them', async () => {
    // Documents why spec 0.3 rule 5 has two proofs. If a platform starts refusing them, this only gets stricter.
    const alg = { name: 'ECDH', namedCurve: 'P-256' } as const
    const tryImport = (p: Bytes): Promise<boolean> => crypto.subtle.importKey('raw', p, alg, true, []).then(() => true, () => false)
    assert.equal(await tryImport(SELF_TEST_POINTS.offCurve()), false, 'the platform must refuse a point off the curve')
    const lax = [await tryImport(SELF_TEST_POINTS.compressed()), await tryImport(SELF_TEST_POINTS.hybrid())]
    assert.equal(lax.length, 2)
  })

  test('1: ECDH with a peer point off the curve, compressed, hybrid or of the wrong size closes', async () => {
    const e = await generateEphemeral()
    for (const name of ['offCurve', 'compressed', 'hybrid', 'badPrefix', 'short64'] as const)
      assert.equal(await rejects(Secret.agree(e.privateKey, SELF_TEST_POINTS[name]())), 'bad-point', name)
  })
})

describe('remote key schedule primitives', () => {
  test('V-3: HKDF-SHA-256 matches the test cases of RFC 5869', async () => {
    const seq = (from: number, n: number): Bytes => Uint8Array.from({ length: n }, (_, i) => from + i)
    assert.equal(
      toHex(await hkdf(fill(22, 0x0b), seq(0, 13), seq(0xf0, 10), 42)),
      '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
    )
    assert.equal(
      toHex(await hkdf(seq(0, 80), seq(0x60, 80), seq(0xb0, 80), 82)),
      'b11e398dc80327a1c8e7f78c596a49344f012eda2d4efad8a050cc4c19afa97c59045a99cac7827271cb41c65e590e09da3275600c2f09b8367793a9aca3db71cc30c58179ec3e87c14c01d5c1f3434f1d87',
    )
    assert.equal(
      toHex(await hkdf(fill(22, 0x0b), new Uint8Array(0), new Uint8Array(0), 42)),
      '8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8',
    )
  })

  test('both ends of an ECDH derive the same bits, and a different label or salt gives different bits', async () => {
    const a = await generateEphemeral()
    const b = await generateEphemeral()
    const za = await Secret.agree(a.privateKey, b.pub)
    const zb = await Secret.agree(b.privateKey, a.pub)
    const salt = fill(32, 7)
    const k1 = toHex(await za.bits(salt, LBL('sas'), 4))
    assert.equal(k1, toHex(await zb.bits(salt, LBL('sas'), 4)))
    assert.notEqual(toHex(await za.bits(salt, LBL('k-d2h'), 32)), toHex(await za.bits(salt, LBL('k-h2d'), 32)))
    assert.notEqual(toHex(await za.bits(fill(32, 8), LBL('sas'), 4)), k1)
    za.destroy()
    assert.equal(await rejects(za.bits(salt, LBL('sas'), 4)), 'bad-state')
  })

  test('a handshake key protects exactly one message: the second use cannot happen', async () => {
    const a = await generateEphemeral()
    const b = await generateEphemeral()
    const za = await Secret.agree(a.privateKey, b.pub)
    const zb = await Secret.agree(b.privateKey, a.pub)
    const salt = fill(32, 1)
    const sealer = new OneShotKey(await za.aesKey(salt, 'k-hs-d2h', 'encrypt'))
    const opener = new OneShotKey(await zb.aesKey(salt, 'k-hs-d2h', 'decrypt'))
    const ct = await sealer.seal(fill(32, 2), ascii('one message'))
    assert.equal(ct.length, 11 + 16)
    assert.equal(await rejects(Promise.resolve().then(() => sealer.seal(fill(32, 2), ascii('again')))), 'bad-state')
    assert.equal(toHex(await opener.open(fill(32, 2), ct)), toHex(ascii('one message')))
    assert.equal(await rejects(Promise.resolve().then(() => opener.open(fill(32, 2), ct))), 'bad-state')
    const opener2 = new OneShotKey(await zb.aesKey(salt, 'k-hs-d2h', 'decrypt'))
    assert.equal(await rejects(opener2.open(fill(32, 3), ct)), 'auth', 'another AAD does not open')
    const wrongKey = new OneShotKey(await zb.aesKey(salt, 'k-hs-h2d', 'decrypt'))
    assert.equal(await rejects(wrongKey.open(fill(32, 2), ct)), 'auth', 'the key of the other direction does not open')
  })

  test('decimal digits come by rejection and are always ASCII digits', () => {
    const d = randomDigits(600)
    assert.equal(d.length, 600)
    assert.ok(d.every(b => b >= 0x30 && b <= 0x39))
    const fixed = randomDigits(3, { random: () => Uint8Array.of(250, 255, 7, 19, 249, 0), ephemeral: generateEphemeral })
    assert.equal(toHex(fixed), toHex(ascii('799')), 'bytes of 250 and above are rejected, not folded')
  })
})

describe('remote keys in their roles', () => {
  test('each role signs only its labels (C-2.3), and only a body of the exact size (C-2.1)', async () => {
    const all = Object.values(ROLE_LABELS).flat()
    for (const role of ['house', 'relay', 'ticket', 'device', 'admission'] as const) {
      const { key } = await generateRoleKey(role)
      for (const label of all) {
        const allowed = ROLE_LABELS[role].includes(label)
        const body = label === 'relay-auth' ? relayAuthBody('relay.test', fill(32, 1), fill(32, 2), fill(32, 3), NOW)
          : label === 'relay-pop' ? relayPopBody('relay.test', fill(32, 1), fill(16, 2), fill(32, 3), fill(32, 4))
          : label === 'relay-admit' ? concat(fill(138, 1), u8(10), ascii('relay.test'))
          : fill({ 'house-hs': 32, 'device-hs': 96, 'house-pair': 32, 'device-pair': 32, 'key-cert': 115, 'key-rotate': 118, 'key-rotate-accept': 182 }[label], 9)
        assert.equal(bodySizeOk(label, body), true, label)
        assert.equal(await rejects(key.sign(label, body)), allowed ? 'no-error' : 'bad-label', `${role} / ${label}`)
        if (allowed) assert.equal(await rejects(key.sign(label, concat(body, u8(0)))), 'bad-label', `${label} + 1 byte`)
      }
    }
  })

  test('a signature verifies only under its own label: house-hs is not house-pair, device-hs is not device-pair', async () => {
    const { key } = await generateRoleKey('house')
    const th = fill(32, 5)
    const sig = await key.sign('house-hs', th)
    assert.equal(sig.length, 64)
    assert.equal(await verifyLabeled(key.pub, 'house-hs', th, sig), true)
    assert.equal(await verifyLabeled(key.pub, 'house-pair', th, sig), false, 'same body, another label')
    assert.equal(await verifyLabeled(key.pub, 'device-pair', th, sig), false)
    assert.equal(await verifyLabeled(key.pub, 'house-hs', fill(32, 6), sig), false)
    const other = await generateRoleKey('house')
    assert.equal(await verifyLabeled(other.pub, 'house-hs', th, sig), false, 'another key')
  })

  test('10: a signature of 63 or 65 bytes, or in DER, is refused without verifying', async () => {
    const { key } = await generateRoleKey('house')
    const th = fill(32, 5)
    const sig = await key.sign('house-hs', th)
    assert.equal(await verifyLabeled(key.pub, 'house-hs', th, sig.subarray(0, 63)), false)
    assert.equal(await verifyLabeled(key.pub, 'house-hs', th, concat(sig, u8(0))), false)
    const der = toDer(sig)
    assert.ok(der.length >= 68 && der.length <= 72)
    assert.equal(await verifyLabeled(key.pub, 'house-hs', th, der), false)
    // "Without verifying": a key that is not even a point is not reached when the size is wrong.
    assert.equal(await verifyLabeled(fill(65, 0), 'house-hs', th, der), false)
    assert.equal(await verifyLabeled(SELF_TEST_POINTS.compressed(), 'house-hs', th, sig), false)
  })

  test('48 (E-3): a body whose aud has 0 or 254 bytes, or an uppercase letter, is refused without verifying', async () => {
    const { key } = await generateRoleKey('relay')
    const fixed = fill(104, 1)
    const good = concat(u8(10), ascii('relay.test'), fixed)
    const sig = await key.sign('relay-auth', good)
    assert.equal(await verifyLabeled(key.pub, 'relay-auth', good, sig), true)
    for (const [name, body] of [
      ['0 bytes', concat(u8(0), fixed)],
      ['254 bytes', concat(u8(254), fill(254, 0x61), fixed)],
      ['uppercase', concat(u8(10), ascii('Relay.test'), fixed)],
      ['length that lies', concat(u8(9), ascii('relay.test'), fixed)],
    ] as const) {
      assert.equal(bodySizeOk('relay-auth', body), false, name)
      assert.equal(await verifyLabeled(key.pub, 'relay-auth', body, sig), false, name)
      assert.equal(await rejects(key.sign('relay-auth', body)), 'bad-label', name)
    }
    assert.equal(bodySizeOk('relay-auth', concat(u8(253), fill(253, 0x61), fixed)), true, '253 bytes is the cap')
    assert.equal(await rejects(Promise.resolve().then(() => relayAuthBody('RELAY', fill(32, 1), fill(32, 2), fill(32, 3), NOW))), 'malformed')
    assert.equal(await rejects(Promise.resolve().then(() => relayAuthBody('relay.test', fill(32, 1), fill(31, 2), fill(32, 3), NOW))), 'malformed', 'r of 31 bytes is never signed')
  })
})

describe('remote identifiers', () => {
  test('V-2 shape: houseId is 32 bytes, deviceId 16, keyId 8; text is 52 base32 characters', async () => {
    const pub = SELF_TEST_POINTS.valid()
    const houseId = await houseIdOf(pub)
    assert.equal(toHex(houseId), toHex(await sha256(LBL('house-id'), pub)))
    assert.equal(toHex(await deviceIdOf(pub)), toHex((await sha256(LBL('device-id'), pub)).subarray(0, 16)))
    assert.equal(toHex(await keyIdOf(pub)), toHex((await sha256(LBL('key-id'), pub)).subarray(0, 8)))
    const text = houseIdText(houseId)
    assert.match(text, /^[a-z2-7]{52}$/)
    assert.match(houseFingerprint(houseId), /^[a-z2-7]{4}( [a-z2-7]{4}){4}$/)
    assert.equal(houseFingerprint(houseId).replace(/ /g, ''), text.slice(0, 20))
    assert.equal(await rejects(houseIdOf(SELF_TEST_POINTS.compressed())), 'bad-point')
  })
})

describe('remote key certificates', () => {
  test('a certificate of each role verifies; its body is 115 bytes and the whole is 179', async () => {
    const h = await generateRoleKey('house')
    const r = await generateRoleKey('relay')
    const t = await generateRoleKey('ticket')
    const certR = await issueKeyCert(h.key, { role: 1, pub: r.pub, notBefore: NOW, notAfter: NOW + KEYCERT_TTL_R_S })
    const certT = await issueKeyCert(h.key, { role: 2, pub: t.pub, notBefore: NOW, notAfter: NOW + KEYCERT_TTL_T_S })
    assert.equal(certR.length, 179)
    assert.equal(parseKeyCert(certR).body.length, 115)
    const vr = await verifyKeyCert(certR, h.pub, 1, NOW + 10)
    const vt = await verifyKeyCert(certT, h.pub, 2, NOW + 10)
    assert.equal(vr.ok && toHex(vr.cert.pub), toHex(r.pub))
    assert.equal(vt.ok, true)
  })

  test('34: expired, role swapped or of another house is refused; so are a tampered body and a long duration', async () => {
    const h = await generateRoleKey('house')
    const other = await generateRoleKey('house')
    const r = await generateRoleKey('relay')
    const cert = await issueKeyCert(h.key, { role: 1, pub: r.pub, notBefore: NOW, notAfter: NOW + 1000 })
    const reason = async (c: Uint8Array, pubH: Uint8Array, role: 1 | 2, now: number): Promise<string> => {
      const v = await verifyKeyCert(c, pubH, role, now)
      return v.ok ? 'ok' : v.reason
    }
    assert.equal(await reason(cert, h.pub, 1, NOW + 1000 + CLOCK_SKEW_S), 'ok', 'inside the skew')
    assert.equal(await reason(cert, h.pub, 1, NOW + 1000 + CLOCK_SKEW_S + 1), 'window', 'expired')
    assert.equal(await reason(cert, h.pub, 1, NOW - CLOCK_SKEW_S - 1), 'window', 'not yet valid')
    assert.equal(await reason(cert, h.pub, 2, NOW), 'role', 'presented as the other role')
    assert.equal(await reason(cert, other.pub, 1, NOW), 'house', 'of another house')
    const swapped = concat(cert)
    swapped[1] = 2
    assert.equal(await reason(swapped, h.pub, 2, NOW), 'signature', 'role byte rewritten')
    const tampered = concat(cert)
    tampered[40] = tampered[40]! ^ 1
    assert.notEqual(await reason(tampered, h.pub, 1, NOW), 'ok')
    assert.equal(await reason(cert.subarray(0, 178), h.pub, 1, NOW), 'malformed')
    // A certificate longer than the cap of its role cannot be issued by this module; one signed by hand is refused.
    assert.equal(await rejects(issueKeyCert(h.key, { role: 1, pub: r.pub, notBefore: NOW, notAfter: NOW + KEYCERT_TTL_R_S + 1 })), 'range')
    const long = parseKeyCert(await issueKeyCert(h.key, { role: 2, pub: r.pub, notBefore: NOW, notAfter: NOW + KEYCERT_TTL_T_S }))
    const longBody = concat(long.body)
    longBody[1] = 1 // a 90-day body presented as role 0x01, whose cap is 30 days
    const forged = concat(longBody, await h.key.sign('key-cert', longBody))
    assert.equal(await reason(forged, h.pub, 1, NOW), 'duration')
    assert.equal(await rejects(issueKeyCert(h.key, { role: 1, pub: h.pub, notBefore: NOW, notAfter: NOW + 10 })), 'bad-label', 'K_H is never certified as K_R')
    assert.equal(await rejects(issueKeyCert(r.key, { role: 1, pub: r.pub, notBefore: NOW, notAfter: NOW + 10 })), 'bad-label', 'only K_H signs key-cert')
  })

  test('the house keys the relay sees are pairwise distinct (Q20)', async () => {
    const [h, r, t1, t2] = [fill(65, 1), fill(65, 2), fill(65, 3), fill(65, 4)]
    assert.equal(houseKeysDistinct(h, r, [t1, t2]), true)
    assert.equal(houseKeysDistinct(h, r, [t1]), true)
    assert.equal(houseKeysDistinct(h, h, [t1]), false, 'pub_R = pub_H')
    assert.equal(houseKeysDistinct(h, r, [h]), false, 'pub_T = pub_H')
    assert.equal(houseKeysDistinct(h, r, [r]), false, 'pub_T = pub_R')
    assert.equal(houseKeysDistinct(h, r, [t1, concat(t1)]), false, 'the two pub_T are the same key')
  })
})

describe('remote admission tickets', () => {
  const setup = async () => {
    const h = await generateRoleKey('house')
    const t = await generateRoleKey('ticket')
    const a = await generateRoleKey('admission')
    const certT = await issueKeyCert(h.key, { role: 2, pub: t.pub, notBefore: NOW, notAfter: NOW + KEYCERT_TTL_T_S })
    return { h, t, a, certT }
  }

  test('V-7 shape: a ticket parses back, is signed under relay-admit and names no device', async () => {
    const { h, t, a, certT } = await setup()
    const ticket = await issueAdmitTicket(t.key, { certT, pubA: a.pub, aud: 'relay.test:8443', notBefore: NOW, exp: NOW + ADMIT_TTL_S })
    const p = parseAdmitTicket(ticket)
    assert.equal(toHex(p.houseId), toHex(await houseIdOf(h.pub)))
    assert.equal(toHex(p.ktId), toHex(await keyIdOf(t.pub)))
    assert.equal(toHex(p.pubA), toHex(a.pub))
    assert.equal(p.aud, 'relay.test:8443')
    assert.equal(p.ticketId.length, 16)
    assert.equal(p.body.length, 138 + 1 + 15)
    assert.equal(ticket.length, 2 + p.body.length + 64)
    assert.equal(await verifyLabeled(t.pub, 'relay-admit', p.body, p.sig), true)
    assert.equal(await verifyLabeled(h.pub, 'relay-admit', p.body, p.sig), false, 'K_H does not sign tickets')
    assert.equal(ticketTimeOk(p, NOW), true)
    assert.equal(ticketTimeOk(p, NOW + ADMIT_TTL_S + CLOCK_SKEW_S + 1), false, 'expired')
    assert.equal(ticketTimeOk(p, NOW - CLOCK_SKEW_S - 1), false, 'not yet valid')
    const second = parseAdmitTicket(await issueAdmitTicket(t.key, { certT, pubA: a.pub, aud: 'relay.test:8443', notBefore: NOW, exp: NOW + 60 }))
    assert.notEqual(toHex(second.ticketId), toHex(p.ticketId), 'ticketId is random')
  })

  test('50 (E-5): no ticket above ADMIT_TTL nor beyond the certificate of the key that signs it', async () => {
    const { h, t, a, certT } = await setup()
    const base = { certT, pubA: a.pub, aud: 'relay.test' }
    assert.equal(await rejects(issueAdmitTicket(t.key, { ...base, notBefore: NOW, exp: NOW + ADMIT_TTL_S + 1 })), 'range')
    assert.equal(await rejects(issueAdmitTicket(t.key, { ...base, notBefore: NOW, exp: NOW })), 'range')
    const late = NOW + KEYCERT_TTL_T_S - 100
    assert.equal(await rejects(issueAdmitTicket(t.key, { ...base, notBefore: late, exp: late + 101 })), 'range', 'beyond notAfter of K_T')
    assert.equal(await rejects(issueAdmitTicket(t.key, { ...base, notBefore: late, exp: late + 100 })), 'no-error')
    const t2 = await generateRoleKey('ticket')
    assert.equal(await rejects(issueAdmitTicket(t2.key, { ...base, notBefore: NOW, exp: NOW + 60 })), 'bad-label', 'certificate of another K_T')
    assert.equal(await rejects(issueAdmitTicket(h.key, { ...base, notBefore: NOW, exp: NOW + 60 })), 'bad-label', 'K_H does not issue tickets')
    assert.equal(await rejects(issueAdmitTicket(t.key, { ...base, aud: 'Relay.test', notBefore: NOW, exp: NOW + 60 })), 'malformed')
    assert.equal(await rejects(issueAdmitTicket(t.key, { ...base, pubA: SELF_TEST_POINTS.offCurve(), notBefore: NOW, exp: NOW + 60 })), 'bad-point')
  })

  test('a ticket with a byte left over, a wrong version or a hostile aud does not parse', async () => {
    const { t, a, certT } = await setup()
    const ticket = await issueAdmitTicket(t.key, { certT, pubA: a.pub, aud: 'relay.test', notBefore: NOW, exp: NOW + 60 })
    const code = (b: Uint8Array): string => { try { parseAdmitTicket(b) } catch (e) { return (e as WireError).code } return 'ok' }
    assert.equal(code(ticket), 'ok')
    assert.equal(code(concat(ticket, u8(0))), 'malformed')
    assert.equal(code(ticket.subarray(0, ticket.length - 1)), 'malformed')
    const v2 = concat(ticket)
    v2[2] = 2
    assert.equal(code(v2), 'bad-version')
    const upper = concat(ticket)
    upper[2 + 139] = 0x52
    assert.equal(code(upper), 'malformed')
    const compressed = concat(ticket)
    compressed[2 + 57] = 0x03
    assert.equal(code(compressed), 'bad-point')
  })
})

describe('remote key rotation declaration', () => {
  test('V-8 shape: verifies with both signatures; every deviation is refused', async () => {
    const oldH = await generateRoleKey('house')
    const newH = await generateRoleKey('house')
    const rotate = { oldHouseId: await houseIdOf(oldH.pub), newPub: newH.pub, seq: 1, issuedAt: NOW, overlapUntil: NOW + ADMIT_TTL_S + 86_400 }
    const body = encodeKeyRotateBody(rotate)
    assert.equal(body.length, 118)
    const sigOld = await oldH.key.sign('key-rotate', body)
    const sigNew = await newH.key.sign('key-rotate-accept', concat(body, sigOld))
    const reason = async (d: Partial<Parameters<typeof verifyKeyRotate>[0]>): Promise<string> => {
      const v = await verifyKeyRotate({ body, sigOld, sigNew, pinnedPubH: oldH.pub, currentSeq: 0, ...d })
      return v.ok ? 'ok' : v.reason
    }
    assert.equal(await reason({}), 'ok')
    assert.equal(await reason({ currentSeq: 1 }), 'seq', 'a replayed declaration')
    assert.equal(await reason({ pinnedPubH: newH.pub }), 'house', 'not the pinned house')
    assert.equal(await reason({ sigOld: sigNew }), 'sig-old')
    assert.equal(await reason({ sigNew: sigOld }), 'sig-new', 'the old key cannot accept for the new one')
    assert.equal(await reason({ sigNew: await newH.key.sign('key-rotate-accept', concat(body, fill(64, 1))) }), 'sig-new', 'acceptance of another sigOld')
    assert.equal(await reason({ body: body.subarray(0, 117) }), 'malformed')

    const signed = async (r: typeof rotate, signer = newH): Promise<Partial<Parameters<typeof verifyKeyRotate>[0]>> => {
      const b = encodeKeyRotateBody(r)
      const so = await oldH.key.sign('key-rotate', b)
      return { body: b, sigOld: so, sigNew: await signer.key.sign('key-rotate-accept', concat(b, so)) }
    }
    assert.equal(await reason(await signed({ ...rotate, overlapUntil: NOW + ADMIT_TTL_S + 86_399 })), 'overlap')
    assert.equal(await reason(await signed({ ...rotate, newPub: oldH.pub }, oldH)), 'same-key')
    assert.equal(await reason(await signed({ ...rotate, newPub: SELF_TEST_POINTS.offCurve() })), 'point')
  })
})
