// Remote wire, layer 4 (spec 3): the pairing ceremony of both sides in memory, by the typed code and by the QR, and
// every way it must fail. Negative tests of spec 9.2 are named with their number.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { inspect } from 'node:util'
import { ascii, concat, lp16, lp8, randomBytes, toHex, u8, utf8, WireError, type Bytes } from '../../src/remote/bytes.ts'
import {
  CLOSE, HB_INTERVAL_MS, HS_DEADLINE_MS, KEYCERT_TTL_T_S, PAIR_ACK_WAIT_MS, PAIR_LOCKOUT_BLOCK_MS, PAIR_SAS_WINDOW_MS,
  PAIR_TTL_MS, SUITE,
} from '../../src/remote/constants.ts'
import { encodeDeviceHello, encodePairDone, formatTypedCode, parseTypedCode } from '../../src/remote/content.ts'
import {
  generateEphemeral, generateRoleKey, OneShotKey, Secret, SELF_TEST_POINTS, type Entropy, type Ephemeral, type RoleKey,
} from '../../src/remote/crypto.ts'
import { decodeInner, encodeInner, HS_FAIL_FRAME } from '../../src/remote/frames.ts'
import { deviceIdOf, houseIdOf, issueAdmitTicket, issueKeyCert } from '../../src/remote/keys.ts'
import {
  accessFromCode, accessFromQr, DevicePairing, HousePairing, PairLockout, type DevicePairEffect, type HousePairEffect,
  type PairAccess,
} from '../../src/remote/pairing.ts'
import { RecordChannel } from '../../src/remote/record.ts'
import { Session, type SessionEffect } from '../../src/remote/session.ts'
import { houseConfirmOf, pair as TH, sasFromBits, sasOf, th2 as TH2 } from '../../src/remote/transcript.ts'

const NOW = 1_795_000_000_000
const AUD = 'relay.test:8443'
const ROUTE = 7

type AnyEffect = DevicePairEffect | HousePairEffect | SessionEffect
const sends = (effects: readonly AnyEffect[]): Bytes[] => effects.flatMap(e => (e.t === 'send' ? [e.frame] : []))
const one = (effects: readonly AnyEffect[]): Bytes => {
  const s = sends(effects)
  assert.equal(s.length, 1, `expected one frame to send, got ${JSON.stringify(effects.map(e => e.t))}`)
  return s[0]!
}
const kinds = (effects: readonly AnyEffect[]): string[] => effects.map(e => e.t)
const pick = <T extends AnyEffect['t']>(effects: readonly AnyEffect[], t: T): Extract<AnyEffect, { t: T }> => {
  const e = effects.find(x => x.t === t)
  assert.ok(e, `no ${t} in ${JSON.stringify(kinds(effects))}`)
  return e as Extract<AnyEffect, { t: T }>
}
const burnedOf = (effects: readonly HousePairEffect[]): Extract<HousePairEffect, { t: 'burned' }> => pick(effects, 'burned') as Extract<HousePairEffect, { t: 'burned' }>
const rejects = async (p: Promise<unknown>): Promise<string> => {
  try { await p } catch (e) { return e instanceof WireError ? e.code : `other:${String(e)}` }
  return 'no-error'
}
const otherDigits = (sas: string): string => String((Number(sas) + 1) % 1_000_000).padStart(6, '0')

interface House { kH: RoleKey; kT: RoleKey; certT: Bytes; lockout: PairLockout }

async function house(): Promise<House> {
  const kH = (await generateRoleKey('house')).key
  const kT = (await generateRoleKey('ticket')).key
  const nowS = Math.floor(NOW / 1000)
  const certT = await issueKeyCert(kH, { role: 2, pub: kT.pub, notBefore: nowS, notAfter: nowS + KEYCERT_TTL_T_S })
  return { kH, kT, certT, lockout: new PairLockout() }
}

const admitFor = (h: House, pubA: Uint8Array): Promise<Bytes> => {
  const nowS = Math.floor(NOW / 1000)
  return issueAdmitTicket(h.kT, { certT: h.certT, pubA, aud: AUD, notBefore: nowS, exp: nowS + 3600 })
}

async function deviceKeys(): Promise<{ kD: RoleKey; kA: RoleKey }> {
  return { kD: (await generateRoleKey('device')).key, kA: (await generateRoleKey('admission')).key }
}

/** Runs the ceremony up to the point where the device shows the SAS and the machine asks for it. */
async function untilSas(h: House, o: { via?: 'code' | 'qr'; name?: string; houseMaxVer?: number; deviceMaxVer?: number } = {}) {
  const ticket = await HousePairing.create({ kH: h.kH, lockout: h.lockout, nowMs: NOW, houseMaxVer: o.houseMaxVer })
  const code = ticket.code()
  const access = o.via === 'qr' ? await accessFromQr(await ticket.qr(AUD)) : await accessFromCode(code)
  const keys = await deviceKeys()
  const wire: Bytes[] = []
  const houseEffects: HousePairEffect[] = []
  const d = await DevicePairing.start({ access, ...keys, name: o.name ?? 'Celular do Guga', caps: 1, nowMs: NOW, deviceMaxVer: o.deviceMaxVer })
  const p1 = one(d.effects)
  const e2 = await ticket.onFrame(ROUTE, p1, NOW)
  const p2 = one(e2)
  const p3 = one(await d.pairing.onFrame(p2, NOW))
  const e4 = await ticket.onFrame(ROUTE, p3, NOW)
  const p4 = one(e4)
  const shown = await d.pairing.onFrame(p4, NOW)
  wire.push(p1, p2, p3, p4)
  houseEffects.push(...e2, ...e4)
  return { ticket, code, access, keys, device: d.pairing, p1, p2, p3, p4, wire, houseEffects, sas: pick(shown, 'show-sas').sas, awaitSas: pick(e4, 'await-sas') }
}

async function complete(h: House, c: Awaited<ReturnType<typeof untilSas>>) {
  const ok = await c.ticket.submitSas(c.sas, NOW + 5000)
  const paired = pick(ok, 'sas-ok').device
  const admitTicket = await admitFor(h, paired.pubA)
  const sent = await c.ticket.confirm({ admitTicket, houseName: 'Casa de teste', nowMs: NOW + 5000 })
  const pairDone = one(sent)
  const de = await c.device.onFrame(pairDone, NOW + 5000)
  const ack = one(de)
  const he = await c.ticket.onFrame(ROUTE, ack, NOW + 5000)
  c.wire.push(pairDone, ack)
  c.houseEffects.push(...ok, ...sent, ...he)
  return { ok, paired, admitTicket, pairDone, de, ack, he }
}

/** A device written by hand over the primitives, to write the frames the real machine never would. */
async function manualDevice(access: PairAccess, keys: { kD: RoleKey; kA: RoleKey }, o: { eph?: Ephemeral; nD?: Bytes; hello?: Bytes } = {}) {
  const eph = o.eph ?? await generateEphemeral()
  const nD = o.nD ?? randomBytes(32)
  const hello = o.hello ?? encodeDeviceHello({ pubD: keys.kD.pub, pubA: keys.kA.pub, caps: 0, name: 'manual' })
  const commit = await TH.commit(eph.pub, nD, hello)
  const t1 = await TH.th1(await TH.th0(1, SUITE), 1, SUITE, access.rv, commit)
  return {
    p1: encodeInner({ type: 'P1', ver: 1, suite: SUITE, rv: access.rv, commit }),
    async p3(p2: Uint8Array, s: { eph?: Ephemeral; nD?: Bytes; hello?: Bytes; signer?: RoleKey } = {}) {
      const f = decodeInner(p2)
      assert.ok(f.type === 'P2')
      const e = s.eph ?? eph
      const n = s.nD ?? nD
      const hb = s.hello ?? hello
      const z = await Secret.agree(e.privateKey, f.eH)
      const t2 = await TH2(t1, f.eH, f.nH, f.pubH, await houseIdOf(f.pubH))
      const t3 = await TH.th3(t2, e.pub, n)
      const t4 = await TH.th4(t3, hb)
      const sas = String.fromCharCode(...await sasOf(z, t4))
      const sigD = await (s.signer ?? keys.kD).sign('device-pair', t4)
      const ct3 = await new OneShotKey(await z.aesKey(t3, 'k-hs-d2h', 'encrypt')).seal(t3, concat(lp16(hb), sigD))
      const t5 = await TH.th5(t4, ct3)
      return {
        frame: concat(u8(0x13), e.pub, n, lp16(ct3)),
        sas,
        async channel(p4: Uint8Array): Promise<RecordChannel> {
          const g = decodeInner(p4)
          assert.ok(g.type === 'P4')
          const t6 = await TH.th6(t5, g.ct4)
          return new RecordChannel({
            role: 'device', sessionId: t6.slice(0, 16), startedMs: NOW,
            sendKey: await z.aesKey(t6, 'k-d2h', 'encrypt'), recvKey: await z.aesKey(t6, 'k-h2d', 'decrypt'),
          })
        },
      }
    },
  }
}

/** A house written by hand over the primitives: it does not know S unless it is given. */
async function manualHouse(kH: RoleKey, o: { eph?: Ephemeral; nH?: Bytes } = {}) {
  const eph = o.eph ?? await generateEphemeral()
  const nH = o.nH ?? randomBytes(32)
  let t2: Bytes
  return {
    async p2(p1: Uint8Array): Promise<Bytes> {
      const f = decodeInner(p1)
      assert.ok(f.type === 'P1')
      const t1 = await TH.th1(await TH.th0(f.ver, SUITE), f.ver, SUITE, f.rv, f.commit)
      t2 = await TH2(t1, eph.pub, nH, kH.pub, await houseIdOf(kH.pub))
      return encodeInner({ type: 'P2', eH: eph.pub, nH, pubH: kH.pub })
    },
    async p4(p3: Uint8Array, signer: RoleKey = kH) {
      const f = decodeInner(p3)
      assert.ok(f.type === 'P3')
      const z = await Secret.agree(eph.privateKey, f.eD)
      const t3 = await TH.th3(t2, f.eD, f.nD)
      const opened = await new OneShotKey(await z.aesKey(t3, 'k-hs-d2h', 'decrypt')).open(t3, f.ct3)
      const hello = opened.slice(2, opened.length - 64)
      const t4 = await TH.th4(t3, hello)
      const t5 = await TH.th5(t4, f.ct3)
      const ct4 = await new OneShotKey(await z.aesKey(t3, 'k-hs-h2d', 'encrypt')).seal(t5, await signer.sign('house-pair', t5))
      const t6 = await TH.th6(t5, ct4)
      const channel = new RecordChannel({
        role: 'house', sessionId: t6.slice(0, 16), startedMs: NOW,
        sendKey: await z.aesKey(t6, 'k-h2d', 'encrypt'), recvKey: await z.aesKey(t6, 'k-d2h', 'decrypt'),
      })
      return { frame: encodeInner({ type: 'P4', ct4 }), channel, confirm: (S: Uint8Array): Promise<Bytes> => houseConfirmOf(z, t6, S) }
    },
  }
}

describe('remote pairing: the ceremony', () => {
  for (const via of ['code', 'qr'] as const) {
    test(`a device pairs by the ${via}: commit, reveal, SAS typed on the machine, houseConfirm, ack`, async () => {
      const h = await house()
      const c = await untilSas(h, { via })
      assert.deepEqual([c.p1.length, c.p2.length, c.p4.length], [51, 163, 81])
      assert.ok(c.p3.length <= 378)
      assert.match(c.sas, /^[0-9]{6}$/)
      assert.match(c.code, /^\d{3} \d{3} \d{3} \d{3}$/)
      assert.equal(c.ticket.state, 'waiting-sas')
      assert.equal(c.device.state, 'await-done')
      assert.deepEqual(c.awaitSas.device, { deviceId: await deviceIdOf(c.keys.kD.pub), declaredName: 'Celular do Guga', caps: 1, access: via })

      const f = await complete(h, c)
      assert.deepEqual(kinds(f.ok), ['sas-ok'])
      assert.equal(toHex(f.paired.pubD), toHex(c.keys.kD.pub))
      assert.equal(toHex(f.paired.pubA), toHex(c.keys.kA.pub))
      assert.deepEqual(kinds(f.de), ['paired', 'send'], 'persist first, then write the ack')
      assert.deepEqual(kinds(f.he), ['done'])
      assert.equal(c.ticket.state, 'done')
      assert.equal(c.device.state, 'done')

      const result = pick(f.de, 'paired').result
      assert.equal(toHex(result.pubH), toHex(h.kH.pub), 'the whole house key is the pin')
      assert.equal(toHex(result.houseId), toHex(await houseIdOf(h.kH.pub)))
      assert.equal(toHex(result.deviceId), toHex(await deviceIdOf(c.keys.kD.pub)))
      assert.equal(toHex(result.admitTicket), toHex(f.admitTicket))
      assert.deepEqual([result.houseName, result.ver, result.houseMaxVer, result.pinnedVer], ['Casa de teste', 1, 1, 1])
      assert.deepEqual(Object.keys(result).sort(), ['admitTicket', 'deviceId', 'houseId', 'houseMaxVer', 'houseName', 'houseNow', 'pinnedVer', 'pubH', 'ver'], 'never R, S, the SAS or Z')

      // The session that concluded the pairing goes on as a normal session, marked fresh-pair.
      const ds = pick(f.de, 'paired').session
      const hs = pick(f.he, 'done').session
      assert.equal(ds.freshPair && hs.freshPair, true)
      assert.equal(toHex(ds.sessionId), toHex(hs.sessionId))
      const req = one(await ds.send('REQ', utf8('{"op":5}'), NOW + 6000))
      assert.deepEqual(await hs.receive(req, NOW + 6000), [{ t: 'record', ctype: 'REQ', content: utf8('{"op":5}') }])
      assert.deepEqual(await ds.receive(one(await hs.send('RES', utf8('{}'), NOW + 6000)), NOW + 6000), [{ t: 'record', ctype: 'RES', content: utf8('{}') }])
      assert.deepEqual(await c.ticket.onFrame(ROUTE, req, NOW + 6000), [], 'the ticket no longer owns the route')
      assert.equal(h.lockout.recentFailures, 0)
    })
  }

  test('V-5 shape: the SAS is u32 mod 10^6 with leading zeros; the code is R then S', () => {
    assert.equal(String.fromCharCode(...sasFromBits(Uint8Array.of(0, 0, 0, 42))), '000042')
    assert.equal(String.fromCharCode(...sasFromBits(Uint8Array.of(0xff, 0xff, 0xff, 0xff))), '967295')
    assert.equal(String.fromCharCode(...sasFromBits(Uint8Array.of(0, 0x0f, 0x42, 0x40))), '000000')
    const { R, S } = parseTypedCode('000 001 999 998')
    assert.equal(formatTypedCode(R, S), '000 001 999 998')
  })

  test('the meeting point is H(pair-rv ‖ R)[0..16], different for the code and for the QR of one ticket', async () => {
    const h = await house()
    const ticket = await HousePairing.create({ kH: h.kH, lockout: h.lockout, nowMs: NOW })
    const byCode = await accessFromCode(ticket.code())
    const byQr = await accessFromQr(await ticket.qr(AUD))
    assert.equal(toHex(byCode.rv), toHex(ticket.rvCode))
    assert.equal(toHex(byQr.rv), toHex(ticket.rvQr))
    assert.notEqual(toHex(ticket.rvCode), toHex(ticket.rvQr))
    assert.equal(byCode.R.length, 6)
    assert.equal(byQr.R.length, 16)
    assert.equal(byQr.kind === 'qr' && toHex(byQr.houseId), toHex(await houseIdOf(h.kH.pub)))
    assert.equal(ticket.pairId.length, 16)
    const other = await HousePairing.create({ kH: h.kH, lockout: h.lockout, nowMs: NOW })
    assert.notEqual(other.code(), ticket.code())
  })

  test('heartbeats keep the pending session alive while the person types the SAS', async () => {
    const h = await house()
    const c = await untilSas(h)
    let t = NOW
    for (let i = 0; i < 5; i++) {
      t += HB_INTERVAL_MS
      const dping = one(await c.device.tick(t))
      const hping = one(await c.ticket.tick(t))
      const pongH = one(await c.ticket.onFrame(ROUTE, dping, t))
      const pongD = one(await c.device.onFrame(hping, t))
      assert.deepEqual(await c.device.onFrame(pongH, t), [])
      assert.deepEqual(await c.ticket.onFrame(ROUTE, pongD, t), [])
    }
    assert.equal(c.ticket.state, 'waiting-sas', '100 s later the ticket still waits')
    assert.deepEqual(kinds(await c.ticket.submitSas(c.sas.slice(0, 3) + ' ' + c.sas.slice(3), t)), ['sas-ok'], 'spaces are dropped')
  })
})

describe('remote pairing: what must fail', () => {
  test('15: a man in the middle gains nothing from 256 ephemerals after the commitment, nor from 256 re-signatures', async () => {
    const N = 256
    // (a) After seeing the reveal of the house, the attacker swaps its ephemeral: the reveal no longer opens its own
    // commitment, and the ticket burns at the first attempt. One reveal per ticket, so each try costs a ceremony.
    const keys = await deviceKeys()
    let mismatches = 0
    for (let i = 0; i < N; i++) {
      const h = await house()
      const ticket = await HousePairing.create({ kH: h.kH, lockout: h.lockout, nowMs: NOW })
      const m = await manualDevice(await accessFromCode(ticket.code()), keys)
      const p2 = one(await ticket.onFrame(ROUTE, m.p1, NOW))
      const swapped = await m.p3(p2, i % 3 === 0 ? { eph: await generateEphemeral() } : i % 3 === 1 ? { nD: randomBytes(32) }
        : { hello: encodeDeviceHello({ pubD: keys.kD.pub, pubA: keys.kA.pub, caps: 0, name: `m${i}` }) })
      const out = await ticket.onFrame(ROUTE, swapped.frame, NOW)
      if (burnedOf(out).reason === 'reveal-mismatch' && ticket.state === 'burned') mismatches++
      assert.deepEqual(kinds(await ticket.onFrame(ROUTE + 1, m.p1, NOW)), ['send', 'close'], 'no second reveal')
    }
    assert.equal(mismatches, N)

    // (b) Re-signing does not move the SAS of the house: with every committed value fixed, 256 different signatures
    // of the device are all accepted under the same six digits.
    const h = await house()
    const fixedEph = await generateEphemeral()
    const constant: Entropy = { random: n => new Uint8Array(n).fill(7), ephemeral: async () => fixedEph }
    const devEph = await generateEphemeral()
    const devNonce = randomBytes(32)
    const sasSeen = new Set<string>()
    const framesSeen = new Set<string>()
    for (let i = 0; i < N; i++) {
      const ticket = await HousePairing.create({ kH: h.kH, lockout: new PairLockout(), nowMs: NOW, entropy: constant })
      const m = await manualDevice(await accessFromCode(ticket.code()), keys, { eph: devEph, nD: devNonce })
      const p3 = await m.p3(one(await ticket.onFrame(ROUTE, m.p1, NOW)))
      sasSeen.add(p3.sas)
      framesSeen.add(toHex(p3.frame))
      assert.deepEqual(kinds(await ticket.onFrame(ROUTE, p3.frame, NOW)), ['send', 'await-sas'])
      assert.deepEqual(kinds(await ticket.submitSas([...sasSeen][0]!, NOW)), ['sas-ok'], `signature ${i}`)
    }
    assert.equal(sasSeen.size, 1, 'the SAS depends on Z and TH4 only')
    assert.equal(framesSeen.size, N, 'while every P3 was a different signature')

    // (c) Nor does the house move the SAS of the device by re-signing: 256 different P4 show the same digits.
    const shown = new Set<string>()
    const p4Seen = new Set<string>()
    const access = await accessFromCode('123456 654321')
    const devEntropy: Entropy = { random: () => devNonce, ephemeral: async () => devEph }
    const mh = await manualHouse(h.kH, { eph: fixedEph, nH: new Uint8Array(32).fill(7) })
    for (let i = 0; i < N; i++) {
      const d = await DevicePairing.start({ access, ...keys, name: 'fixed', nowMs: NOW, entropy: devEntropy })
      const p3 = one(await d.pairing.onFrame(await mh.p2(one(d.effects)), NOW))
      const p4 = (await mh.p4(p3)).frame
      p4Seen.add(toHex(p4))
      shown.add(pick(await d.pairing.onFrame(p4, NOW), 'show-sas').sas)
    }
    assert.equal(shown.size, 1)
    assert.equal(p4Seen.size, N)
  })

  test('16: a reveal that does not open the commitment burns the ticket and counts for the lockout', async () => {
    const h = await house()
    const ticket = await HousePairing.create({ kH: h.kH, lockout: h.lockout, nowMs: NOW })
    const keys = await deviceKeys()
    const m = await manualDevice(await accessFromCode(ticket.code()), keys)
    const p2 = one(await ticket.onFrame(ROUTE, m.p1, NOW))
    const out = await ticket.onFrame(ROUTE, (await m.p3(p2, { nD: randomBytes(32) })).frame, NOW)
    assert.deepEqual(out, [
      { t: 'send', route: ROUTE, frame: HS_FAIL_FRAME() }, { t: 'close', route: ROUTE, reason: 'pairing burned: reveal-mismatch' },
      { t: 'burned', reason: 'reveal-mismatch', countsForLockout: true },
    ])
    assert.equal(ticket.state, 'burned')
    assert.equal(h.lockout.recentFailures, 1)
    assert.equal(await rejects(ticket.submitSas('000000', NOW)), 'bad-state')
    assert.equal(await rejects(Promise.resolve().then(() => ticket.code())), 'bad-state', 'a burned ticket shows no code')
  })

  test('17: two P1 for the same ticket, one by each rv: both routes closed, ticket burned', async () => {
    const h = await house()
    const ticket = await HousePairing.create({ kH: h.kH, lockout: h.lockout, nowMs: NOW })
    const byCode = await manualDevice(await accessFromCode(ticket.code()), await deviceKeys())
    const byQr = await manualDevice(await accessFromQr(await ticket.qr(AUD)), await deviceKeys())
    assert.deepEqual(kinds(await ticket.onFrame(1, byCode.p1, NOW)), ['send'])
    const out = await ticket.onFrame(2, byQr.p1, NOW)
    assert.deepEqual(out, [
      { t: 'send', route: 2, frame: HS_FAIL_FRAME() }, { t: 'close', route: 2, reason: 'collision' },
      { t: 'send', route: 1, frame: HS_FAIL_FRAME() }, { t: 'close', route: 1, reason: 'pairing burned: collision' },
      { t: 'burned', reason: 'collision', countsForLockout: true },
    ])
    assert.equal(ticket.state, 'burned')
  })

  test('18: a second P1 after P2 was sent gets HS_FAIL; the house never sends a second P2', async () => {
    const h = await house()
    const c = await untilSas(h)
    const again = await ticket2ndP1(c.ticket, c.p1)
    assert.equal(again.filter(e => e.t === 'send').every(e => e.t === 'send' && toHex(e.frame) === toHex(HS_FAIL_FRAME())), true, 'only HS_FAIL leaves')
    assert.equal(burnedOf(again).reason, 'collision')
    // The same P1 again on the route in course is not a P3: it burns too, and no P2 is produced.
    const h2 = await house()
    const ticket = await HousePairing.create({ kH: h2.kH, lockout: h2.lockout, nowMs: NOW })
    const m = await manualDevice(await accessFromCode(ticket.code()), await deviceKeys())
    const first = await ticket.onFrame(ROUTE, m.p1, NOW)
    assert.equal(decodeInner(one(first)).type, 'P2')
    const second = await ticket.onFrame(ROUTE, m.p1, NOW)
    assert.deepEqual(sends(second).map(toHex), [toHex(HS_FAIL_FRAME())])
    assert.equal(burnedOf(second).reason, 'protocol')
  })

  test('19: a used ticket refuses its own code; a ticket cannot be serialised, so a restarted portal knows none', async () => {
    const h = await house()
    const c = await untilSas(h)
    await complete(h, c)
    const m = await manualDevice(c.access, await deviceKeys())
    assert.deepEqual(await c.ticket.onFrame(9, m.p1, NOW + 9000), [{ t: 'send', route: 9, frame: HS_FAIL_FRAME() }, { t: 'close', route: 9, reason: 'ticket not open' }])
    assert.equal(c.ticket.state, 'done')
    const dump = JSON.stringify(c.ticket) + inspect(c.ticket, { depth: 5, showHidden: true })
    for (const digit6 of [c.code.replace(/ /g, '').slice(0, 6), c.code.replace(/ /g, '').slice(6), c.sas]) assert.equal(dump.includes(digit6), false)
    assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(c.ticket))).sort(), ['pairId', 'rvCode', 'rvQr'], 'only public fields exist outside the object')
  })

  test('20: the third wrong SAS burns the ticket; a SAS after PAIR_SAS_WINDOW burns it', async () => {
    const h = await house()
    const c = await untilSas(h)
    const wrong = otherDigits(c.sas)
    assert.deepEqual(await c.ticket.submitSas(wrong, NOW), [{ t: 'sas-wrong', triesLeft: 2 }])
    assert.deepEqual(await c.ticket.submitSas('12345', NOW), [{ t: 'sas-wrong', triesLeft: 1 }], 'a malformed entry is a wrong entry')
    const third = await c.ticket.submitSas(wrong, NOW)
    assert.deepEqual(third, [{ t: 'close', route: ROUTE, reason: 'pairing burned: sas-wrong' }, { t: 'burned', reason: 'sas-wrong', countsForLockout: true }])
    assert.equal(await rejects(c.ticket.submitSas(c.sas, NOW)), 'bad-state', 'the right SAS no longer helps')
    assert.deepEqual(await c.device.routeClosed(), [{ t: 'failed', reason: 'route-closed' }])

    const late = await untilSas(h)
    assert.deepEqual(kinds(await late.ticket.submitSas(late.sas, NOW + PAIR_SAS_WINDOW_MS + 1)), ['close', 'burned'])
    assert.equal(late.ticket.state, 'burned')
    const byTick = await untilSas(h)
    assert.equal(burnedOf(await byTick.ticket.tick(NOW + PAIR_SAS_WINDOW_MS + 1)).reason, 'sas-window')
    const onTheEdge = await untilSas(await house())
    assert.deepEqual(kinds(await onTheEdge.ticket.submitSas(onTheEdge.sas, NOW + PAIR_SAS_WINDOW_MS)), ['sas-ok'], 'the last instant of the window')
    const right = await untilSas(await house())
    await right.ticket.submitSas(otherDigits(right.sas), NOW)
    await right.ticket.submitSas(otherDigits(right.sas), NOW)
    assert.deepEqual(kinds(await right.ticket.submitSas(right.sas, NOW)), ['sas-ok'], 'two wrong entries and the right one still pair')
  })

  test('21: PAIR_DONE with a wrong houseConfirm: the device persists nothing', async () => {
    const h = await house()
    // The house in the middle relays perfectly but never saw S: the device holds another S.
    const c0 = await HousePairing.create({ kH: h.kH, lockout: h.lockout, nowMs: NOW })
    const real = await accessFromCode(c0.code())
    const keys = await deviceKeys()
    const d = await DevicePairing.start({ access: { ...real, S: ascii(otherDigits(String.fromCharCode(...real.S))) }, ...keys, name: 'x', nowMs: NOW })
    const p3 = one(await d.pairing.onFrame(one(await c0.onFrame(ROUTE, one(d.effects), NOW)), NOW))
    const e4 = await c0.onFrame(ROUTE, p3, NOW)
    const sas = pick(await d.pairing.onFrame(one(e4), NOW), 'show-sas').sas
    const ok = pick(await c0.submitSas(sas, NOW), 'sas-ok').device
    const pairDone = one(await c0.confirm({ admitTicket: await admitFor(h, ok.pubA), houseName: 'falsa', nowMs: NOW }))
    const out = await d.pairing.onFrame(pairDone, NOW)
    assert.deepEqual(out, [{ t: 'failed', reason: 'house-not-confirmed' }], 'no paired effect, no ack')
    assert.equal(d.pairing.state, 'dead')

    // A hand-written house that does know S: its PAIR_DONE is accepted, unless the confirm is of another S, the
    // ticket is for another pub_A or of another house, or it names another device (Q15).
    const other = await house()
    for (const variant of ['good', 'other-S', 'other-pubA', 'other-house-ticket', 'other-device'] as const) {
      const keys2 = await deviceKeys()
      const access = await accessFromCode('111111 222222')
      const mh = await manualHouse(h.kH)
      const d2 = await DevicePairing.start({ access, ...keys2, name: 'x', nowMs: NOW })
      const p4 = await mh.p4(one(await d2.pairing.onFrame(await mh.p2(one(d2.effects)), NOW)))
      await d2.pairing.onFrame(p4.frame, NOW)
      const stranger = await deviceKeys()
      const content = encodePairDone({
        houseMaxVer: 1, now: 1, houseConfirm: await p4.confirm(ascii(variant === 'other-S' ? '222223' : '222222')),
        deviceId: await deviceIdOf(variant === 'other-device' ? stranger.kD.pub : keys2.kD.pub),
        admitTicket: await admitFor(variant === 'other-house-ticket' ? other : h, variant === 'other-pubA' ? stranger.kA.pub : keys2.kA.pub),
        houseName: 'x',
      })
      const got = await d2.pairing.onFrame((await p4.channel.seal('PAIR_DONE', content)).frame, NOW)
      if (variant === 'good') assert.deepEqual(kinds(got), ['paired', 'send'])
      else assert.deepEqual(got, [{ t: 'failed', reason: 'house-not-confirmed' }], variant)
    }
  })

  test('22: a QR whose houseId is not that of the pub_H in P2: the device aborts without sending P3', async () => {
    const h = await house()
    const impostor = await house()
    const ticket = await HousePairing.create({ kH: h.kH, lockout: h.lockout, nowMs: NOW })
    const access = await accessFromQr(await ticket.qr(AUD))
    const d = await DevicePairing.start({ access, ...await deviceKeys(), name: 'x', nowMs: NOW })
    const mh = await manualHouse(impostor.kH)
    const out = await d.pairing.onFrame(await mh.p2(one(d.effects)), NOW)
    assert.deepEqual(out, [{ t: 'failed', reason: 'house-id-mismatch' }], 'nothing was revealed')
    // By the typed code there is no pin: the same impostor reaches the SAS, and is stopped only by houseConfirm (21).
    const typed = await DevicePairing.start({ access: await accessFromCode(ticket.code()), ...await deviceKeys(), name: 'x', nowMs: NOW })
    assert.deepEqual(kinds(await typed.pairing.onFrame(await (await manualHouse(impostor.kH)).p2(one(typed.effects)), NOW)), ['send'])
  })

  test('23: a record that is not a heartbeat before PAIR_DONE closes and burns, on both sides', async () => {
    for (const ctype of ['REQ', 'BIN', 'PAIR_ACK'] as const) {
      const h = await house()
      const ticket = await HousePairing.create({ kH: h.kH, lockout: h.lockout, nowMs: NOW })
      const m = await manualDevice(await accessFromCode(ticket.code()), await deviceKeys())
      const p3 = await m.p3(one(await ticket.onFrame(ROUTE, m.p1, NOW)))
      const e4 = await ticket.onFrame(ROUTE, p3.frame, NOW)
      const ch = await p3.channel(one(e4))
      const out = await ticket.onFrame(ROUTE, (await ch.seal(ctype, new Uint8Array(0))).frame, NOW)
      assert.deepEqual(out, [{ t: 'close', route: ROUTE, reason: 'pairing burned: protocol' }, { t: 'burned', reason: 'protocol', countsForLockout: true }], `${ctype} from the device`)
    }
    for (const ctype of ['RES', 'EVT', 'BIN', 'HS_DONE'] as const) {
      const h = await house()
      const mh = await manualHouse(h.kH)
      const d = await DevicePairing.start({ access: await accessFromCode('111111 222222'), ...await deviceKeys(), name: 'x', nowMs: NOW })
      const p4 = await mh.p4(one(await d.pairing.onFrame(await mh.p2(one(d.effects)), NOW)))
      assert.deepEqual(kinds(await d.pairing.onFrame(p4.frame, NOW)), ['show-sas'])
      assert.deepEqual(await d.pairing.onFrame((await p4.channel.seal(ctype, new Uint8Array(0))).frame, NOW), [{ t: 'failed', reason: 'protocol' }], `${ctype} from the house`)
    }
    // CLOSE is accepted in the gap, and ends the ceremony.
    const h = await house()
    const mh = await manualHouse(h.kH)
    const d = await DevicePairing.start({ access: await accessFromCode('111111 222222'), ...await deviceKeys(), name: 'x', nowMs: NOW })
    const p4 = await mh.p4(one(await d.pairing.onFrame(await mh.p2(one(d.effects)), NOW)))
    await d.pairing.onFrame(p4.frame, NOW)
    assert.deepEqual(await d.pairing.onFrame((await p4.channel.seal('CLOSE', u8(CLOSE.normal))).frame, NOW), [{ t: 'failed', reason: 'closed' }])
  })

  test('24: after any failure the device machine is dead: it sends nothing more and cannot be restarted', async () => {
    const h = await house()
    const cases: [string, (d: DevicePairing, p2: Bytes) => Promise<DevicePairEffect[]>][] = [
      ['HS_FAIL after P1', d => d.onFrame(HS_FAIL_FRAME(), NOW)],
      ['timeout after P1', d => d.tick(NOW + HS_DEADLINE_MS)],
      ['route closed', d => d.routeClosed()],
      ['HS_FAIL after P3', async (d, p2) => { await d.onFrame(p2, NOW); return d.onFrame(HS_FAIL_FRAME(), NOW) }],
      ['timeout after P3', async (d, p2) => { await d.onFrame(p2, NOW); return d.tick(NOW + HS_DEADLINE_MS) }],
      ['a P4 that does not open', async (d, p2) => { await d.onFrame(p2, NOW); return d.onFrame(encodeInner({ type: 'P4', ct4: randomBytes(80) }), NOW) }],
      ['a frame that does not parse', d => d.onFrame(randomBytes(40), NOW)],
    ]
    for (const [name, breakIt] of cases) {
      const ticket = await HousePairing.create({ kH: h.kH, lockout: new PairLockout(), nowMs: NOW })
      const d = await DevicePairing.start({ access: await accessFromCode(ticket.code()), ...await deviceKeys(), name: 'x', nowMs: NOW })
      const p2 = one(await ticket.onFrame(ROUTE, one(d.effects), NOW))
      const out = await breakIt(d.pairing, p2)
      assert.deepEqual(kinds(out), ['failed'], name)
      assert.deepEqual(sends(out), [], `${name}: nothing is written`)
      assert.equal(d.pairing.state, 'dead', name)
      assert.deepEqual(await d.pairing.onFrame(p2, NOW), [], `${name}: the same P2 again does nothing`)
      assert.deepEqual(await d.pairing.tick(NOW + 1), [])
    }
    const signedByOther = await DevicePairing.start({ access: await accessFromCode('111111 222222'), ...await deviceKeys(), name: 'x', nowMs: NOW })
    const mh = await manualHouse(h.kH)
    const p3 = one(await signedByOther.pairing.onFrame(await mh.p2(one(signedByOther.effects)), NOW))
    const forged = await mh.p4(p3, (await generateRoleKey('house')).key)
    assert.deepEqual(await signedByOther.pairing.onFrame(forged.frame, NOW), [{ t: 'failed', reason: 'house-not-proven' }], 'P4 signed by a key that is not the pub_H of P2: the SAS is never shown')
  })

  test('25: the SAS the house expects appears in no effect and nowhere in the ticket object', async () => {
    const h = await house()
    const c = await untilSas(h)
    c.houseEffects.push(...await c.ticket.submitSas(otherDigits(c.sas), NOW))
    await complete(h, c)
    const flat = JSON.stringify(c.houseEffects, (_k, v: unknown) => (v instanceof Uint8Array ? '<bytes>' : v instanceof Session ? '<session>' : v))
    assert.equal(flat.includes(c.sas), false)
    assert.equal(/"sas"\s*:/.test(flat), false)
    assert.deepEqual(Object.keys(c.awaitSas.device).sort(), ['access', 'caps', 'declaredName', 'deviceId'])
    assert.equal((JSON.stringify(c.ticket) + inspect(c.ticket, { depth: 6, showHidden: true })).includes(c.sas), false)
    // And it is not on the wire in clear either.
    for (const frame of c.wire) assert.equal(toHex(frame).includes(toHex(ascii(c.sas))), false)
  })

  test('26: five failed ceremonies block pairing for 60 minutes', async () => {
    const h = await house()
    for (let i = 0; i < 5; i++) {
      assert.equal(h.lockout.blockedUntil(NOW + i), undefined)
      const ticket = await HousePairing.create({ kH: h.kH, lockout: h.lockout, nowMs: NOW + i })
      const m = await manualDevice(await accessFromCode(ticket.code()), await deviceKeys())
      await ticket.onFrame(ROUTE, m.p1, NOW + i)
      assert.equal(burnedOf(await ticket.tick(NOW + i + HS_DEADLINE_MS)).countsForLockout, true)
    }
    const fifth = NOW + 4 + HS_DEADLINE_MS
    assert.equal(h.lockout.blockedUntil(fifth), fifth + PAIR_LOCKOUT_BLOCK_MS)
    assert.equal(await rejects(HousePairing.create({ kH: h.kH, lockout: h.lockout, nowMs: fifth + 1 })), 'locked')
    assert.equal(await rejects(HousePairing.create({ kH: h.kH, lockout: h.lockout, nowMs: fifth + PAIR_LOCKOUT_BLOCK_MS - 1 })), 'locked')
    assert.equal(await rejects(HousePairing.create({ kH: h.kH, lockout: h.lockout, nowMs: fifth + PAIR_LOCKOUT_BLOCK_MS })), 'no-error')

    // A ceremony that never got a P2 out (expired, cancelled, unknown rv) does not count.
    const quiet = await house()
    const expired = await HousePairing.create({ kH: quiet.kH, lockout: quiet.lockout, nowMs: NOW })
    assert.deepEqual(await expired.tick(NOW + PAIR_TTL_MS), [])
    assert.deepEqual(await expired.tick(NOW + PAIR_TTL_MS + 1), [{ t: 'burned', reason: 'expired', countsForLockout: false }])
    const cancelled = await HousePairing.create({ kH: quiet.kH, lockout: quiet.lockout, nowMs: NOW })
    assert.deepEqual(await cancelled.cancel(NOW), [{ t: 'burned', reason: 'cancelled', countsForLockout: false }])
    assert.equal(quiet.lockout.recentFailures, 0)
    // Four failures spread over more than an hour never block.
    const slow = new PairLockout()
    for (let i = 0; i < 12; i++) slow.recordFailure(NOW + i * 16 * 60_000)
    assert.equal(slow.blockedUntil(NOW + 12 * 16 * 60_000), undefined)
  })

  test('47 (E-2): a DeviceHello with pub_A = pub_D burns the ticket; the device machine refuses to build one', async () => {
    const h = await house()
    const ticket = await HousePairing.create({ kH: h.kH, lockout: h.lockout, nowMs: NOW })
    const keys = await deviceKeys()
    const hello = encodeDeviceHello({ pubD: keys.kD.pub, pubA: keys.kD.pub, caps: 0, name: 'one key' })
    const m = await manualDevice(await accessFromCode(ticket.code()), keys, { hello })
    const out = await ticket.onFrame(ROUTE, (await m.p3(one(await ticket.onFrame(ROUTE, m.p1, NOW)))).frame, NOW)
    assert.equal(burnedOf(out).reason, 'key-reuse')
    assert.equal(ticket.state, 'burned')
    const sameKeyAsAdmission = { ...keys.kD, role: 'admission' as const }
    assert.equal(await rejects(DevicePairing.start({ access: await accessFromCode('111111 222222'), kD: keys.kD, kA: sameKeyAsAdmission, name: 'x', nowMs: NOW })), 'bad-label')
    assert.equal(await rejects(DevicePairing.start({ access: await accessFromCode('111111 222222'), kD: keys.kA, kA: keys.kD, name: 'x', nowMs: NOW })), 'bad-label', 'keys in the wrong roles')
  })

  test('64 / 1: a name above 64 bytes, an invalid pub_D or an invalid ephemeral refuses the P3; a hostile name is shown sanitised', async () => {
    const keys = await deviceKeys()
    const breakP3: [string, (m: Awaited<ReturnType<typeof manualDevice>>, p2: Bytes) => Promise<Bytes>][] = [
      ['a name of 65 bytes', async (m, p2) => (await m.p3(p2)).frame],
      ['pub_D off the curve', async (m, p2) => (await m.p3(p2)).frame],
      ['e_D off the curve', async () => concat(u8(0x13), SELF_TEST_POINTS.offCurve(), randomBytes(32), lp16(randomBytes(230)))],
      ['e_D hybrid', async () => concat(u8(0x13), SELF_TEST_POINTS.hybrid(), randomBytes(32), lp16(randomBytes(230)))],
      ['ct3 that does not open', async (m, p2) => { const f = (await m.p3(p2)).frame; f[f.length - 1] = f[f.length - 1]! ^ 1; return f }],
      ['signed by another key', async (m, p2) => (await m.p3(p2, { signer: (await generateRoleKey('device')).key })).frame],
    ]
    const hellos: Record<string, Bytes | undefined> = {
      'a name of 65 bytes': concat(keys.kD.pub, keys.kA.pub, u8(0), lp8(new Uint8Array(65).fill(0x61))),
      'pub_D off the curve': concat(SELF_TEST_POINTS.offCurve(), keys.kA.pub, u8(0), lp8(ascii('x'))),
    }
    for (const [name, make] of breakP3) {
      const h = await house()
      const ticket = await HousePairing.create({ kH: h.kH, lockout: h.lockout, nowMs: NOW })
      const m = await manualDevice(await accessFromCode(ticket.code()), keys, { hello: hellos[name] })
      const out = await ticket.onFrame(ROUTE, await make(m, one(await ticket.onFrame(ROUTE, m.p1, NOW))), NOW)
      assert.equal(burnedOf(out).reason, 'protocol', name)
      assert.equal(out.some(e => e.t === 'await-sas'), false, name)
    }
    const h = await house()
    const c = await untilSas(h, { name: 'Guga‮\u0007 ​iphone' })
    assert.equal(c.awaitSas.device.declaredName, 'Guga iphone')
    assert.equal(pick(await c.ticket.submitSas(c.sas, NOW), 'sas-ok').device.name, 'Guga‮\u0007 ​iphone', 'the registry keeps what was declared; the screen shows the sanitised form')
    assert.equal(await rejects(DevicePairing.start({ access: c.access, ...keys, name: 'a'.repeat(65), nowMs: NOW })), 'too-large')
    // The device side: an invalid e_H or pub_H in P2 ends the ceremony.
    for (const field of ['eH', 'pubH'] as const) {
      const d = await DevicePairing.start({ access: c.access, ...keys, name: 'x', nowMs: NOW })
      const p2 = decodeInner(await (await manualHouse(h.kH)).p2(one(d.effects)))
      assert.ok(p2.type === 'P2')
      const bad = SELF_TEST_POINTS.offCurve()
      const frame = encodeInner(field === 'eH' ? { ...p2, eH: bad } : { ...p2, pubH: bad })
      assert.deepEqual(await d.pairing.onFrame(frame, NOW), [{ t: 'failed', reason: 'protocol' }], field)
    }
  })

  test('59: a route opened by pairing accepts only P1; an unknown rv gets HS_FAIL and leaves the ticket alone', async () => {
    const h = await house()
    const ticket = await HousePairing.create({ kH: h.kH, lockout: h.lockout, nowMs: NOW })
    const eph = await generateEphemeral()
    const hs1 = encodeInner({ type: 'HS1', ver: 1, suite: 1, eD: eph.pub, nD: randomBytes(32) })
    assert.deepEqual(await ticket.onFrame(3, hs1, NOW), [{ t: 'close', route: 3, reason: 'a route opened by pairing accepts only P1' }])
    assert.deepEqual(kinds(await ticket.onFrame(3, concat(u8(0x11), randomBytes(49)), NOW)), ['close'], 'a P1 one byte short')
    const stray = encodeInner({ type: 'P1', ver: 1, suite: 1, rv: randomBytes(16), commit: randomBytes(32) })
    assert.deepEqual(await ticket.onFrame(4, stray, NOW), [{ t: 'send', route: 4, frame: HS_FAIL_FRAME() }, { t: 'close', route: 4, reason: 'no such ticket' }])
    const v2 = encodeInner({ type: 'P1', ver: 2, suite: 1, rv: ticket.rvCode, commit: randomBytes(32) })
    assert.deepEqual(kinds(await ticket.onFrame(5, v2, NOW)), ['send', 'close'], 'a version the house does not speak')
    assert.equal(ticket.state, 'open', 'none of that touched the ticket')
    assert.equal(h.lockout.recentFailures, 0)
  })

  test('deadlines: PAIR_TTL for the first P1, HS_DEADLINE from P1 to P3, 30 s for the PAIR_ACK', async () => {
    const h = await house()
    const late = await HousePairing.create({ kH: h.kH, lockout: h.lockout, nowMs: NOW })
    const m = await manualDevice(await accessFromCode(late.code()), await deviceKeys())
    assert.deepEqual(await late.onFrame(ROUTE, m.p1, NOW + PAIR_TTL_MS + 1), [
      { t: 'send', route: ROUTE, frame: HS_FAIL_FRAME() }, { t: 'close', route: ROUTE, reason: 'ticket expired' },
      { t: 'burned', reason: 'expired', countsForLockout: false },
    ])

    const stalled = await HousePairing.create({ kH: h.kH, lockout: h.lockout, nowMs: NOW })
    const m2 = await manualDevice(await accessFromCode(stalled.code()), await deviceKeys())
    await stalled.onFrame(ROUTE, m2.p1, NOW + 1000)
    assert.deepEqual(await stalled.tick(NOW + 1000 + HS_DEADLINE_MS - 1), [])
    assert.deepEqual(await stalled.tick(NOW + 1000 + HS_DEADLINE_MS), [
      { t: 'send', route: ROUTE, frame: HS_FAIL_FRAME() }, { t: 'close', route: ROUTE, reason: 'pairing burned: p3-timeout' },
      { t: 'burned', reason: 'p3-timeout', countsForLockout: true },
    ])

    const c = await untilSas(h)
    const ok = pick(await c.ticket.submitSas(c.sas, NOW), 'sas-ok').device
    await c.ticket.confirm({ admitTicket: await admitFor(h, ok.pubA), houseName: 'x', nowMs: NOW + 1000 })
    assert.equal(await rejects(c.ticket.confirm({ admitTicket: await admitFor(h, ok.pubA), houseName: 'x', nowMs: NOW + 1000 })), 'bad-state', 'PAIR_DONE is sent once')
    assert.deepEqual(kinds(await c.ticket.tick(NOW + 1000 + PAIR_ACK_WAIT_MS - 1)), ['send'], 'only the heartbeat')
    const noAck = await c.ticket.tick(NOW + 1000 + PAIR_ACK_WAIT_MS)
    assert.deepEqual(burnedOf(noAck), { t: 'burned', reason: 'no-ack', countsForLockout: true, eraseDeviceId: ok.deviceId }, 'the device just written must be erased')
  })

  test('Q10: a P1 for a ticket already confirmed gets HS_FAIL and does not undo the pairing', async () => {
    const h = await house()
    const c = await untilSas(h)
    await c.ticket.submitSas(c.sas, NOW)
    const m = await manualDevice(c.access, await deviceKeys())
    assert.deepEqual(await c.ticket.onFrame(9, m.p1, NOW), [{ t: 'send', route: 9, frame: HS_FAIL_FRAME() }, { t: 'close', route: 9, reason: 'ticket not open' }])
    assert.equal(c.ticket.state, 'confirmed')
    assert.equal(await rejects(c.ticket.confirm({ admitTicket: await admitFor(h, (await deviceKeys()).kA.pub), houseName: 'x', nowMs: NOW })), 'bad-label', 'a ticket for another pub_A is not sent')
  })

  test('46 (E-1): pairing has no pin, so a downgrade is caught on PAIR_DONE: CLOSE(0x05), nothing persisted', async () => {
    const h = await house()
    const c = await untilSas(h, { houseMaxVer: 2, deviceMaxVer: 2 })
    const ok = pick(await c.ticket.submitSas(c.sas, NOW), 'sas-ok').device
    const pairDone = one(await c.ticket.confirm({ admitTicket: await admitFor(h, ok.pubA), houseName: 'x', nowMs: NOW }))
    const out = await c.device.onFrame(pairDone, NOW)
    assert.deepEqual(kinds(out), ['send', 'failed'])
    assert.deepEqual(pick(out, 'failed'), { t: 'failed', reason: 'version-downgrade' })
    const atHouse = await c.ticket.onFrame(ROUTE, one(out), NOW)
    assert.deepEqual(burnedOf(atHouse), { t: 'burned', reason: 'route-closed', countsForLockout: true, eraseDeviceId: ok.deviceId })
  })

  test('12: the spy on the relay sees pub_H and the meeting point, and nothing of the device or of S', async () => {
    const h = await house()
    const c = await untilSas(h, { name: 'CANARY-device-name' })
    await complete(h, c)
    const digits = c.code.replace(/ /g, '')
    const hidden: [string, Uint8Array][] = [
      ['pub_D', c.keys.kD.pub], ['X of pub_D', c.keys.kD.pub.subarray(1, 33)], ['pub_A', c.keys.kA.pub],
      ['deviceId', await deviceIdOf(c.keys.kD.pub)], ['name', utf8('CANARY-device-name')], ['S', ascii(digits.slice(6))],
      ['R', ascii(digits.slice(0, 6))], ['house name', utf8('Casa de teste')], ['SAS', ascii(c.sas)],
    ]
    const all = toHex(concat(...c.wire))
    for (const [name, bytes] of hidden) assert.equal(all.includes(toHex(bytes)), false, `${name} in clear`)
    assert.equal(all.includes(toHex(h.kH.pub)), true, 'pub_H travels in P2 by design')
    assert.equal(all.includes(toHex(c.access.rv)), true, 'rv is public by design')
  })
})

/** A second P1 on another route while the first ceremony is in course. */
async function ticket2ndP1(ticket: HousePairing, p1: Bytes): Promise<HousePairEffect[]> {
  return ticket.onFrame(ROUTE + 1, p1, NOW)
}
