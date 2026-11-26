// Remote wire, layer 5 (spec 5): the house proves its relay key, the device proves possession of the admission key
// of its ticket, and what the relay verifies of both. Timing, sockets and limits are the relay's (step 1.2); here is
// the verdict it builds them on. Negative tests of spec 9.2 are named with their number.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { concat, lp16, lp8, randomBytes, toHex, u16, u64, u8, WireError, type Bytes } from '../../src/remote/bytes.ts'
import {
  admitRenewKeyAllowed, buildDeviceAdmit, buildHouseAuth, DenyList, verifyDeviceAdmit, verifyHouseAuth, type AdmitCheck,
  type RelayHouse,
} from '../../src/remote/admission.ts'
import { audBytes } from '../../src/remote/aud.ts'
import { ADMIT_TTL_S, CLOCK_SKEW_S, DENY_MAX, KEYCERT_TTL_R_S, KEYCERT_TTL_T_S } from '../../src/remote/constants.ts'
import { generateRoleKey, SELF_TEST_POINTS, verifyLabeled, type RoleKey } from '../../src/remote/crypto.ts'
import { decodeOuter, encodeOuter, NOTICE, type OuterFrame } from '../../src/remote/frames.ts'
import { houseIdOf, issueAdmitTicket, issueKeyCert, keyIdOf, parseAdmitTicket, relayAuthBody } from '../../src/remote/keys.ts'

const NOW = 1_795_000_000
const AUD = 'relay.test:8443'
const rejects = async (p: Promise<unknown>): Promise<string> => {
  try { await p } catch (e) { return e instanceof WireError ? e.code : `other:${String(e)}` }
  return 'no-error'
}
type Frame<T extends OuterFrame['type']> = Extract<OuterFrame, { type: T }>

interface Home { kH: RoleKey; kR: RoleKey; kT: RoleKey; certR: Bytes; certT: Bytes }

async function home(): Promise<Home> {
  const kH = (await generateRoleKey('house')).key
  const kR = (await generateRoleKey('relay')).key
  const kT = (await generateRoleKey('ticket')).key
  return {
    kH, kR, kT,
    certR: await issueKeyCert(kH, { role: 1, pub: kR.pub, notBefore: NOW - 10, notAfter: NOW - 10 + KEYCERT_TTL_R_S }),
    certT: await issueKeyCert(kH, { role: 2, pub: kT.pub, notBefore: NOW - 10, notAfter: NOW - 10 + KEYCERT_TTL_T_S }),
  }
}

async function authFrame(h: Home, r: Bytes, o: Partial<Parameters<typeof buildHouseAuth>[0]> = {}): Promise<Frame<'H_AUTH'>> {
  const bytes = await buildHouseAuth({ r, aud: AUD, pubH: h.kH.pub, certR: h.certR, certsT: [h.certT], kR: h.kR, nowS: NOW, ...o })
  const f = decodeOuter('house', 'end', bytes, { preAuth: true })
  assert.ok(f.type === 'H_AUTH')
  return f
}

async function admitted(h: Home): Promise<RelayHouse> {
  const r = randomBytes(32)
  const v = await verifyHouseAuth({ auth: await authFrame(h, r), r, aud: AUD, nowS: NOW })
  assert.ok(v.ok)
  return v.house
}

describe('remote admission: the house proves its key', () => {
  test('H_AUTH verifies at the relay and registers the ticket keys of the house', async () => {
    const h = await home()
    const r = randomBytes(32)
    const auth = await authFrame(h, r)
    const v = await verifyHouseAuth({ auth, r, aud: AUD, nowS: NOW })
    assert.ok(v.ok)
    assert.equal(toHex(v.house.houseId), toHex(await houseIdOf(h.kH.pub)))
    assert.equal(v.house.ticketKeys.length, 1)
    assert.equal(toHex(v.house.ticketKeys[0]!.ktId), toHex(await keyIdOf(h.kT.pub)))
    // During a rotation the previous K_T stays registered as the second certificate (spec 6.3).
    const kT2 = (await generateRoleKey('ticket')).key
    const certT2 = await issueKeyCert(h.kH, { role: 2, pub: kT2.pub, notBefore: NOW, notAfter: NOW + KEYCERT_TTL_T_S })
    const two = await verifyHouseAuth({ auth: await authFrame(h, r, { certsT: [certT2, h.certT] }), r, aud: AUD, nowS: NOW })
    assert.equal(two.ok && two.house.ticketKeys.length, 2)
  })

  test('27: a challenge that is a TH2 yields a relay-auth signature by K_R, useless as house-hs; 31 or 33 bytes are never signed', async () => {
    const h = await home()
    const th2 = randomBytes(32) // what a hostile relay would send, hoping for LBL("house-hs") ‖ TH2
    const auth = await authFrame(h, th2)
    assert.equal(await verifyLabeled(h.kR.pub, 'relay-auth', relayAuthBody(AUD, await houseIdOf(h.kH.pub), th2, auth.c, auth.ts), auth.sigR), true)
    assert.equal(await verifyLabeled(h.kH.pub, 'house-hs', th2, auth.sigR), false, 'not a signature of K_H')
    assert.equal(await verifyLabeled(h.kR.pub, 'house-hs', th2, auth.sigR), false, 'nor house-hs under K_R')
    assert.equal(await verifyLabeled(h.kH.pub, 'house-pair', th2, auth.sigR), false)

    let signed = 0
    const counting: RoleKey = { role: 'relay', pub: h.kR.pub, sign: (l, b) => { signed++; return h.kR.sign(l, b) } }
    for (const n of [0, 31, 33, 64]) assert.equal(await rejects(authFrame({ ...h, kR: counting }, randomBytes(n))), 'malformed', `${n} bytes`)
    assert.equal(signed, 0, 'the house closed without signing anything')
    assert.equal(await rejects(authFrame({ ...h, kR: h.kH }, th2)), 'bad-label', 'K_H never signs relay-auth')
    assert.equal(await rejects(authFrame(h, th2, { aud: 'Relay.Test' })), 'malformed')
  })

  test('34: a key-cert expired, with the role swapped or of another house: refused; so are a bad signature, time and aud', async () => {
    const h = await home()
    const r = randomBytes(32)
    const reason = async (auth: Frame<'H_AUTH'>, o: { r?: Bytes; aud?: string; nowS?: number } = {}): Promise<string> => {
      const v = await verifyHouseAuth({ auth, r: o.r ?? r, aud: o.aud ?? AUD, nowS: o.nowS ?? NOW })
      return v.ok ? 'ok' : v.reason
    }
    const good = await authFrame(h, r)
    assert.equal(await reason(good), 'ok')
    const lateNow = NOW - 10 + KEYCERT_TTL_R_S + CLOCK_SKEW_S + 1
    assert.equal(await reason(await authFrame(h, r, { nowS: lateNow }), { nowS: lateNow }), 'cert-relay', 'K_R certificate expired')
    assert.equal(await reason(await authFrame(h, r, { certR: h.certT })), 'cert-relay', 'a ticket certificate presented as the relay one')
    assert.equal(await reason(await authFrame(h, r, { certsT: [h.certR] })), 'cert-ticket', 'a relay certificate presented as a ticket one')
    const other = await home()
    assert.equal(await reason(await authFrame(h, r, { certR: other.certR })), 'cert-relay', 'certificate of another house')
    assert.equal(await reason(await authFrame(h, r, { certsT: [other.certT] })), 'cert-ticket')
    assert.equal(await reason(await authFrame(h, r, { pubH: other.kH.pub })), 'cert-relay', 'another pub_H over the same certificates')
    assert.equal(await reason({ ...good, pubH: SELF_TEST_POINTS.offCurve() }), 'point')
    assert.equal(await reason({ ...good, pubH: SELF_TEST_POINTS.hybrid() }), 'point')

    assert.equal(await reason(good, { r: randomBytes(32) }), 'signature', 'the answer to the challenge of another socket')
    assert.equal(await reason(good, { aud: 'other.relay' }), 'signature', 'signed for another relay')
    assert.equal(await reason({ ...good, c: randomBytes(32) }), 'signature')
    assert.equal(await reason({ ...good, sigR: randomBytes(64) }), 'signature')
    const stolen = (await generateRoleKey('relay')).key
    assert.equal(await reason(await authFrame({ ...h, kR: stolen }, r)), 'signature', 'signed by a key that is not the certified K_R')
    assert.equal(await reason(good, { nowS: NOW + 2 * CLOCK_SKEW_S }), 'ok')
    assert.equal(await reason(good, { nowS: NOW + 2 * CLOCK_SKEW_S + 1 }), 'time')
    assert.equal(await reason(good, { nowS: NOW - 2 * CLOCK_SKEW_S - 1 }), 'cert-relay', 'before the certificate window')
    assert.equal(await reason({ ...good, ts: NOW + 2 * CLOCK_SKEW_S + 1 }), 'time', 'a timestamp from the future')
  })

  test('Q20: a house whose relay key is also a ticket key is refused', async () => {
    const h = await home()
    const r = randomBytes(32)
    const sameKey = await issueKeyCert(h.kH, { role: 2, pub: h.kR.pub, notBefore: NOW, notAfter: NOW + 1000 })
    const v = await verifyHouseAuth({ auth: await authFrame(h, r, { certsT: [sameKey] }), r, aud: AUD, nowS: NOW })
    assert.deepEqual(v, { ok: false, reason: 'keys-not-distinct' })
    const twice = await verifyHouseAuth({ auth: await authFrame(h, r, { certsT: [h.certT, h.certT] }), r, aud: AUD, nowS: NOW })
    assert.deepEqual(twice, { ok: false, reason: 'keys-not-distinct' })
  })
})

describe('remote admission: the device is admitted', () => {
  const setup = async () => {
    const h = await home()
    const house = await admitted(h)
    const kA = (await generateRoleKey('admission')).key
    const ticket = await issueAdmitTicket(h.kT, { certT: h.certT, pubA: kA.pub, aud: AUD, notBefore: NOW - 60, exp: NOW + 86_400 })
    const nR = randomBytes(32)
    const frame = async (o: Partial<Parameters<typeof buildDeviceAdmit>[0]> = {}): Promise<Frame<'D_ADMIT'>> => {
      const f = decodeOuter('device', 'end', await buildDeviceAdmit({ ticket, aud: AUD, nR, kA, ...o }), { preAuth: true })
      assert.ok(f.type === 'D_ADMIT')
      return f
    }
    const failed = async (admit: Frame<'D_ADMIT'>, o: { nR?: Bytes; aud?: string; nowS?: number; house?: RelayHouse | undefined; deny?: DenyList } = {}): Promise<AdmitCheck[] | 'ok'> => {
      const v = await verifyDeviceAdmit({ admit, nR: o.nR ?? nR, aud: o.aud ?? AUD, nowS: o.nowS ?? NOW, house: 'house' in o ? o.house : house, deny: o.deny })
      return v.ok ? 'ok' : v.failed
    }
    return { h, house, kA, ticket, nR, frame, failed }
  }

  test('a ticket with its proof of possession is admitted; the relay learns houseId, ticketId and pub_A only', async () => {
    const s = await setup()
    const admit = await s.frame()
    const v = await verifyDeviceAdmit({ admit, nR: s.nR, aud: AUD, nowS: NOW, house: s.house, deny: new DenyList() })
    assert.ok(v.ok)
    const t = parseAdmitTicket(s.ticket)
    assert.deepEqual(v, { ok: true, houseId: t.houseId, ticketId: t.ticketId, pubA: s.kA.pub, exp: NOW + 86_400 })
    assert.equal(encodeOuter(admit).length <= 4096, true, 'fits MAX_PRE_AUTH')
    assert.notEqual(toHex((await s.frame()).nD), toHex(admit.nD), 'n_D is fresh at every admission')
  })

  test('28: no proof of possession, a proof by another key, or one for the n_R of another connection: refused', async () => {
    const s = await setup()
    const admit = await s.frame()
    assert.deepEqual(await s.failed({ ...admit, sigA: new Uint8Array(64) }), ['sig-a'], 'the ticket alone admits nobody')
    const thief = (await generateRoleKey('admission')).key
    const stolenTicket = { ...thief, pub: s.kA.pub } // signs with its own key, claims the pub_A of the ticket
    assert.deepEqual(await s.failed(await s.frame({ kA: stolenTicket })), ['sig-a'])
    assert.deepEqual(await s.failed(admit, { nR: randomBytes(32) }), ['sig-a'], 'recorded on another connection')
    assert.deepEqual(await s.failed({ ...admit, nD: randomBytes(32) }), ['sig-a'])
    assert.equal(await rejects(buildDeviceAdmit({ ticket: s.ticket, aud: AUD, nR: s.nR, kA: thief })), 'bad-label', 'the device machine refuses a ticket of another key')
    assert.equal(await rejects(buildDeviceAdmit({ ticket: s.ticket, aud: AUD, nR: randomBytes(31), kA: s.kA })), 'malformed')
  })

  test('29: house offline, house unknown, ticket expired, denied or of another relay: every one is the same refusal', async () => {
    const s = await setup()
    const admit = await s.frame()
    const verdicts: Record<string, AdmitCheck[] | 'ok'> = {
      offline: await s.failed(admit, { house: undefined }),
      'another house connected under that id': await s.failed(admit, { house: await admitted(await home()) }),
      expired: await s.failed(admit, { nowS: NOW + 86_400 + CLOCK_SKEW_S + 1 }),
      'not yet valid': await s.failed(admit, { nowS: NOW - 60 - CLOCK_SKEW_S - 1 }),
      'other relay': await s.failed(admit, { aud: 'other.relay' }),
      'houseId rewritten': await s.failed({ ...admit, houseId: randomBytes(32) }),
      'ticket garbage': await s.failed({ ...admit, ticket: randomBytes(200) }),
    }
    const deny = new DenyList()
    deny.apply({ entries: [{ ticketId: parseAdmitTicket(s.ticket).ticketId, exp: NOW + 86_400 }], overflow: false }, NOW)
    verdicts.denied = await s.failed(admit, { deny })
    for (const [name, v] of Object.entries(verdicts)) assert.notEqual(v, 'ok', name)
    assert.deepEqual(verdicts.offline, ['house-online', 'ticket-key', 'cert-live', 'within-cert', 'sig-t'])
    assert.deepEqual(verdicts.expired, ['window'])
    assert.deepEqual(verdicts['other relay'], ['aud', 'sig-a'], 'the proof was made for the relay the device knows')
    assert.deepEqual(verdicts.denied, ['not-denied'], 'a revoked device learns nothing else: the same answer as house offline')
    assert.deepEqual(verdicts['houseId rewritten'], ['house-id', 'house-online'])
    assert.equal((verdicts['ticket garbage'] as AdmitCheck[]).includes('ticket'), true)
    // No early exit: an admission with everything wrong reports every check, signatures included.
    const all = await s.failed({ ...admit, ticket: randomBytes(200), sigA: randomBytes(64) }, { house: undefined })
    assert.deepEqual(all, ['ticket', 'house-id', 'house-online', 'ticket-key', 'cert-live', 'within-cert', 'sig-t', 'aud', 'window', 'duration', 'not-denied', 'sig-a'])
    assert.equal(await s.failed(admit, { nowS: NOW + 86_400 + CLOCK_SKEW_S }), 'ok', 'inside the skew')
  })

  test('a ticket signed by a key the house did not register, tampered, or issued by another house is refused', async () => {
    const s = await setup()
    const rogueT = (await generateRoleKey('ticket')).key
    const rogueCert = await issueKeyCert(s.h.kH, { role: 2, pub: rogueT.pub, notBefore: NOW - 10, notAfter: NOW + 1000 })
    const rogueTicket = await issueAdmitTicket(rogueT, { certT: rogueCert, pubA: s.kA.pub, aud: AUD, notBefore: NOW - 5, exp: NOW + 100 })
    assert.deepEqual(await s.failed(await s.frame({ ticket: rogueTicket })), ['ticket-key', 'cert-live', 'within-cert', 'sig-t'], '51: tickets of a K_T that is no longer registered are dead')

    const t = parseAdmitTicket(s.ticket)
    const forgedBody = concat(t.body)
    forgedBody.set(u64(NOW + 2 * 86_400), 130) // exp pushed forward, old signature kept
    const forged = concat(lp16(forgedBody), t.sig)
    assert.deepEqual(await s.failed(await s.frame({ ticket: forged })), ['sig-t'])

    const other = await home()
    const otherTicket = await issueAdmitTicket(other.kT, { certT: other.certT, pubA: s.kA.pub, aud: AUD, notBefore: NOW - 5, exp: NOW + 100 })
    const crossed = await s.frame({ ticket: otherTicket })
    assert.deepEqual(await s.failed(crossed), ['house-online', 'ticket-key', 'cert-live', 'within-cert', 'sig-t'], 'a ticket of house B does not open house A')
    assert.deepEqual(await s.failed({ ...crossed, houseId: s.house.houseId }), ['house-id', 'ticket-key', 'cert-live', 'within-cert', 'sig-t'])
  })

  test('50 (E-5): a ticket beyond the certificate of its K_T, or presented after that certificate expired: refused', async () => {
    const h = await home()
    const kT = (await generateRoleKey('ticket')).key
    const certT = await issueKeyCert(h.kH, { role: 2, pub: kT.pub, notBefore: NOW - 10, notAfter: NOW + 1000 })
    const r = randomBytes(32)
    const v = await verifyHouseAuth({ auth: await authFrame(h, r, { certsT: [certT] }), r, aud: AUD, nowS: NOW })
    assert.ok(v.ok)
    const kA = (await generateRoleKey('admission')).key
    const nR = randomBytes(32)
    const run = async (ticket: Bytes, nowS: number): Promise<AdmitCheck[] | 'ok'> => {
      const f = decodeOuter('device', 'end', await buildDeviceAdmit({ ticket, aud: AUD, nR, kA }))
      assert.ok(f.type === 'D_ADMIT')
      const out = await verifyDeviceAdmit({ admit: f, nR, aud: AUD, nowS, house: v.house, deny: undefined })
      return out.ok ? 'ok' : out.failed
    }
    // The module never issues such a ticket; a house that signs one by hand is caught at the relay.
    const body = concat(u8(1), v.house.houseId, await keyIdOf(kT.pub), randomBytes(16), kA.pub, u64(NOW - 5), u64(NOW + 1001), lp8(audBytes(AUD)))
    const beyond = concat(lp16(body), await kT.sign('relay-admit', body))
    assert.deepEqual(await run(beyond, NOW), ['within-cert'])
    const tooLong = concat(u8(1), v.house.houseId, await keyIdOf(h.kT.pub), randomBytes(16), kA.pub, u64(NOW - 5), u64(NOW - 5 + ADMIT_TTL_S + 1), lp8(audBytes(AUD)))
    const longTicket = concat(lp16(tooLong), await h.kT.sign('relay-admit', tooLong))
    assert.deepEqual(await run(longTicket, NOW), ['ticket-key', 'cert-live', 'within-cert', 'sig-t', 'duration'], 'above ADMIT_TTL, and of a key this house entry never registered')

    const fine = await issueAdmitTicket(kT, { certT, pubA: kA.pub, aud: AUD, notBefore: NOW - 5, exp: NOW + 1000 })
    assert.equal(await run(fine, NOW), 'ok')
    assert.equal(await run(fine, NOW + 1000 + CLOCK_SKEW_S), 'ok')
    // The certificate was valid at H_AUTH and is not any more at this admission: checked at the moment of admission.
    assert.deepEqual(await run(fine, NOW + 1000 + CLOCK_SKEW_S + 1), ['cert-live', 'window'])
  })
})

describe('remote admission: deny list and renewal', () => {
  const id = (n: number): Bytes => concat(new Uint8Array(12), u8((n >>> 24) & 255), u8((n >>> 16) & 255), u8((n >>> 8) & 255), u8(n & 255))

  test('H_DENY is additive, keeps the larger exp and prunes after exp + CLOCK_SKEW', () => {
    const d = new DenyList()
    assert.deepEqual(d.apply({ entries: [{ ticketId: id(1), exp: NOW + 100 }, { ticketId: id(2), exp: NOW + 200 }], overflow: false }, NOW), { ok: true })
    assert.deepEqual(d.apply({ entries: [{ ticketId: id(1), exp: NOW + 50 }, { ticketId: id(3), exp: NOW + 300 }], overflow: false }, NOW), { ok: true })
    assert.equal(d.size, 3)
    assert.equal(d.has(id(1)) && d.has(id(2)) && d.has(id(3)), true)
    assert.equal(d.has(id(4)), false)
    d.prune(NOW + 100 + CLOCK_SKEW_S)
    assert.equal(d.has(id(1)), true, 'the larger exp was kept, and the skew still covers it')
    d.prune(NOW + 100 + CLOCK_SKEW_S + 1)
    assert.equal(d.has(id(1)), false)
    assert.equal(d.size, 2)
    assert.deepEqual(d.apply({ entries: [{ ticketId: id(9), exp: NOW - CLOCK_SKEW_S - 1000 }], overflow: false }, NOW), { ok: true })
    assert.equal(d.has(id(9)), false, 'an entry already past its exp is not stored')
  })

  test('51 (E-6): an H_DENY that would pass DENY_MAX is refused whole with R_NOTICE 0x02; the list stays flat', () => {
    const d = new DenyList()
    const batch = (from: number, n: number) => ({ entries: Array.from({ length: n }, (_, i) => ({ ticketId: id(from + i), exp: NOW + 1000 })), overflow: false })
    assert.deepEqual(d.apply(batch(0, DENY_MAX - 1), NOW), { ok: true })
    assert.deepEqual(d.apply(batch(5000, 2), NOW), { ok: false, notice: NOTICE.limit })
    assert.equal(d.size, DENY_MAX - 1, 'atomic: nothing of the refused frame entered')
    assert.equal(d.has(id(5000)), false)
    assert.deepEqual(d.apply(batch(0, 10), NOW), { ok: true }, 'entries already present do not count twice')
    assert.deepEqual(d.apply(batch(5000, 1), NOW), { ok: true })
    assert.equal(d.size, DENY_MAX)
    assert.deepEqual(d.apply(batch(6000, 1), NOW), { ok: false, notice: NOTICE.limit })
    // A frame that announces 65 535 entries is recognised by the decoder and never materialised.
    const huge = decodeOuter('house', 'end', concat(Uint8Array.of(1, 0x27), u16(10_000), new Uint8Array(240_000)))
    assert.ok(huge.type === 'H_DENY')
    assert.deepEqual(d.apply(huge, NOW), { ok: false, notice: NOTICE.limit })
    assert.equal(d.size, DENY_MAX)
    // Once the old tickets expire the list empties by itself.
    d.prune(NOW + 1000 + CLOCK_SKEW_S + 1)
    assert.equal(d.size, 0)
  })

  test('47 (E-2): admit.renew refuses a pub_A equal to pub_D, to the current pub_A or to any earlier one', async () => {
    const kD = (await generateRoleKey('device')).key
    const a1 = (await generateRoleKey('admission')).key
    const a2 = (await generateRoleKey('admission')).key
    const a3 = (await generateRoleKey('admission')).key
    const used = [await keyIdOf(a1.pub), await keyIdOf(a2.pub)]
    assert.equal(await admitRenewKeyAllowed(a3.pub, kD.pub, used), true)
    assert.equal(await admitRenewKeyAllowed(kD.pub, kD.pub, used), false, 'pub_D')
    assert.equal(await admitRenewKeyAllowed(a2.pub, kD.pub, used), false, 'the current pub_A')
    assert.equal(await admitRenewKeyAllowed(a1.pub, kD.pub, used), false, 'an earlier pub_A')
    assert.equal(await admitRenewKeyAllowed(SELF_TEST_POINTS.offCurve(), kD.pub, used), false)
    assert.equal(await admitRenewKeyAllowed(SELF_TEST_POINTS.compressed(), kD.pub, used), false)
  })
})
