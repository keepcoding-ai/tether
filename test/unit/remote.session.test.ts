// Remote wire, layer 3 (spec 4): the record layer, the session with its heartbeat and close, and the session
// handshake of a paired device, both sides in memory. Negative tests of spec 9.2 are named with their number.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { concat, randomBytes, toHex, u8, utf8, WireError, type Bytes } from '../../src/remote/bytes.ts'
import { CLOSE, FAIL_DELAY_MS, HB_INTERVAL_MS, HB_TIMEOUT_MS, HS_DEADLINE_MS, MAX_INNER, SUITE } from '../../src/remote/constants.ts'
import { encodeHsDone, encodePing, encodePong, padPlaintext, type ContentType } from '../../src/remote/content.ts'
import {
  generateEphemeral, generateRoleKey, OneShotKey, Secret, SELF_TEST_POINTS, type Ephemeral, type RoleKey,
} from '../../src/remote/crypto.ts'
import { decodeInner, encodeInner, HS_FAIL_FRAME } from '../../src/remote/frames.ts'
import { deviceIdOf, houseIdOf } from '../../src/remote/keys.ts'
import { RecordChannel, recordAad, recordNonce, sealRecordAt, type RecordLimits } from '../../src/remote/record.ts'
import {
  DeviceHandshake, HouseHandshake, ownerOf, Session, type DeviceHsEffect, type DeviceRecord, type HouseHsEffect,
  type SessionEffect, type SessionGate,
} from '../../src/remote/session.ts'
import { session as TH, th2 as TH2 } from '../../src/remote/transcript.ts'

const NOW = 1_795_000_000_000

type AnyEffect = DeviceHsEffect | HouseHsEffect | SessionEffect
const sends = (effects: readonly AnyEffect[]): Bytes[] => effects.flatMap(e => (e.t === 'send' ? [e.frame] : []))
const one = (effects: readonly AnyEffect[]): Bytes => {
  const s = sends(effects)
  assert.equal(s.length, 1, `expected one frame to send, got ${JSON.stringify(effects.map(e => e.t))}`)
  return s[0]!
}
const kinds = (effects: readonly AnyEffect[]): string[] => effects.map(e => e.t)
const flip = (frame: Uint8Array, at: number): Bytes => { const b = concat(frame); b[at] = b[at]! ^ 1; return b }
const established = (effects: readonly (DeviceHsEffect | HouseHsEffect)[]): Session => {
  const e = effects.find(x => x.t === 'established')
  assert.ok(e && e.t === 'established', `not established: ${JSON.stringify(kinds(effects))}`)
  return e.session
}
const closedOf = (effects: readonly SessionEffect[]): Extract<SessionEffect, { t: 'closed' }> | undefined =>
  effects.find((e): e is Extract<SessionEffect, { t: 'closed' }> => e.t === 'closed')
const rejects = async (p: Promise<unknown>): Promise<string> => {
  try { await p } catch (e) { return e instanceof WireError ? e.code : `other:${String(e)}` }
  return 'no-error'
}

// ---------------------------------------------------------------------------------------------------------------
// A pair of sessions over keys made by the test, to reach states the handshake API does not let one write
// ---------------------------------------------------------------------------------------------------------------

async function aesPair(): Promise<{ enc: CryptoKey; dec: CryptoKey }> {
  const raw = randomBytes(32)
  const alg = { name: 'AES-GCM' }
  return {
    enc: await crypto.subtle.importKey('raw', raw, alg, false, ['encrypt']),
    dec: await crypto.subtle.importKey('raw', raw, alg, false, ['decrypt']),
  }
}

async function rawPair(o: { deviceGate?: SessionGate; houseGate?: SessionGate; limits?: Partial<RecordLimits>; sessionId?: Bytes } = {}) {
  const d2h = await aesPair()
  const h2d = await aesPair()
  const sessionId = o.sessionId ?? randomBytes(16)
  const dc = new RecordChannel({ role: 'device', sessionId, sendKey: d2h.enc, recvKey: h2d.dec, startedMs: NOW, limits: o.limits })
  const hc = new RecordChannel({ role: 'house', sessionId, sendKey: h2d.enc, recvKey: d2h.dec, startedMs: NOW, limits: o.limits })
  return {
    sessionId, d2h, h2d, dc, hc,
    device: new Session({ role: 'device', ver: 1, channel: dc, gate: o.deviceGate ?? 'open', nowMs: NOW }),
    house: new Session({ role: 'house', ver: 1, channel: hc, gate: o.houseGate ?? 'open', nowMs: NOW }),
  }
}

describe('remote record layer', () => {
  test('V-6 shape: the nonce is four zeros and the counter; the AAD binds session, direction, counter and type', () => {
    assert.equal(toHex(recordNonce(0)), '000000000000000000000000')
    assert.equal(toHex(recordNonce(1)), '000000000000000000000001')
    assert.equal(toHex(recordNonce(2 ** 32)), '000000000000000100000000')
    const sid = new Uint8Array(16).fill(0xab)
    const aad = recordAad(sid, 1, 2 ** 32)
    assert.equal(toHex(aad), toHex(concat(utf8('tether-remote/v1/rec'), u8(0), sid, u8(1), new Uint8Array([0, 0, 0, 1, 0, 0, 0, 0]), u8(0x20))))
    assert.notEqual(toHex(recordAad(sid, 2, 0)), toHex(recordAad(sid, 1, 0)))
  })

  test('records flow in both directions, each with its own counter from zero', async () => {
    const p = await rawPair()
    for (let i = 0; i < 3; i++) {
      const { frame, ctr } = await p.dc.seal('REQ', utf8(`q${i}`))
      assert.equal(ctr, i)
      const f = decodeInner(frame)
      assert.equal(f.type === 'REC' && f.ctr, i)
      const got = await p.hc.open(frame)
      assert.deepEqual([got.ctype, toHex(got.content), got.ctr], ['REQ', toHex(utf8(`q${i}`)), i])
    }
    const back = await p.hc.seal('RES', utf8('r'))
    assert.equal(back.ctr, 0, 'the other direction has its own counter')
    assert.equal((await p.dc.open(back.frame)).ctype, 'RES')
    assert.equal(p.dc.sent, 3)
    assert.equal(p.hc.recvNext, 3)
  })

  test('6: a repeated, a skipped and an earlier counter each close the channel for good', async () => {
    const replay = await rawPair()
    const f0 = (await replay.dc.seal('REQ', utf8('a'))).frame
    await replay.hc.open(f0)
    assert.equal(await rejects(replay.hc.open(f0)), 'replay', 'the same record twice')
    assert.equal(replay.hc.alive, false)
    assert.equal(await rejects(replay.hc.open((await replay.dc.seal('REQ', utf8('b'))).frame)), 'bad-state', 'no recovery')

    const skip = await rawPair()
    await skip.dc.seal('REQ', utf8('lost'))
    assert.equal(await rejects(skip.hc.open((await skip.dc.seal('REQ', utf8('b'))).frame)), 'replay', 'a record was dropped in the middle')

    const earlier = await rawPair()
    const e0 = (await earlier.dc.seal('REQ', utf8('a'))).frame
    const e1 = (await earlier.dc.seal('REQ', utf8('b'))).frame
    await earlier.hc.open(e0)
    await earlier.hc.open(e1)
    assert.equal(await rejects(earlier.hc.open(e0)), 'replay', 'an earlier record again')
  })

  test('8: one bit flipped in the ciphertext, in the tag or in the wire counter closes', async () => {
    for (const where of ['counter', 'ciphertext', 'tag'] as const) {
      const p = await rawPair()
      const frame = (await p.dc.seal('REQ', utf8('payload'))).frame
      const at = where === 'counter' ? 8 : where === 'ciphertext' ? 12 : frame.length - 1
      assert.notEqual(await rejects(p.hc.open(flip(frame, at))), 'no-error', where)
      assert.equal(p.hc.alive, false, where)
    }
    // The wire counter is not trusted: a frame whose counter was rewritten to the expected value still does not open,
    // because nonce and AAD come from the value the receiver expects and the sender used another.
    const p = await rawPair()
    await p.dc.seal('REQ', utf8('first'))
    const second = (await p.dc.seal('REQ', utf8('second'))).frame
    const rewritten = concat(second)
    rewritten[8] = 0
    assert.equal(await rejects(p.hc.open(rewritten)), 'auth')
  })

  test('7: a record of one session injected into another session does not open', async () => {
    const a = await rawPair()
    const b = await rawPair()
    const frame = (await a.dc.seal('REQ', utf8('for A'))).frame
    assert.equal(await rejects(b.hc.open(frame)), 'auth')
    // Same keys, another sessionId: the AAD alone refuses the graft.
    const c = await rawPair()
    const other = new RecordChannel({ role: 'house', sessionId: randomBytes(16), sendKey: c.h2d.enc, recvKey: c.d2h.dec, startedMs: NOW })
    assert.equal(await rejects(other.open((await c.dc.seal('REQ', utf8('x'))).frame)), 'auth')
    // A record is not accepted in the direction it was written in.
    const d = await rawPair()
    const mirror = new RecordChannel({ role: 'device', sessionId: d.sessionId, sendKey: d.d2h.enc, recvKey: d.d2h.dec, startedMs: NOW })
    assert.equal(await rejects(mirror.open((await d.dc.seal('REQ', utf8('x'))).frame)), 'auth', 'reflected to its sender')
  })

  test('9: non-zero padding and a clen above the plaintext close', async () => {
    const dirty = await rawPair()
    const pt = padPlaintext('REQ', utf8('x'))
    pt[pt.length - 1] = 1
    assert.equal(await rejects(dirty.hc.open(await sealRecordAt(dirty.d2h.enc, dirty.sessionId, 1, 0, pt))), 'malformed')
    const lying = await rawPair()
    const pt2 = padPlaintext('REQ', utf8('x'))
    pt2[1] = 0xff
    assert.equal(await rejects(lying.hc.open(await sealRecordAt(lying.d2h.enc, lying.sessionId, 1, 0, pt2))), 'malformed')
    const unknown = await rawPair()
    const pt3 = padPlaintext('REQ', utf8('x'))
    pt3[0] = 0x77
    assert.equal(await rejects(unknown.hc.open(await sealRecordAt(unknown.d2h.enc, unknown.sessionId, 1, 0, pt3))), 'unknown-type')
    const big = await rawPair()
    assert.equal(await rejects(big.hc.open(new Uint8Array(MAX_INNER + 1).fill(0x20))), 'too-large')
    const notRec = await rawPair()
    assert.equal(await rejects(notRec.hc.open(HS_FAIL_FRAME())), 'unknown-type')
  })

  test('11: a counter at the frame limit closes on receive; the sender closes with CLOSE(0x02) one record before', async () => {
    const p = await rawPair({ limits: { frames: 4 } })
    assert.deepEqual(kinds(await p.device.send('REQ', utf8('0'), NOW)), ['send'])
    assert.deepEqual(kinds(await p.device.send('REQ', utf8('1'), NOW)), ['send'])
    assert.deepEqual(kinds(await p.device.send('REQ', utf8('2'), NOW)), ['send'])
    const last = await p.device.send('REQ', utf8('3'), NOW)
    assert.deepEqual(kinds(last), ['send', 'closed'], 'the fourth record is CLOSE, not the request')
    assert.equal(closedOf(last)?.code, CLOSE.rekey)
    const lastFrame = decodeInner(one(last))
    assert.equal(lastFrame.type === 'REC' && lastFrame.ctr, 3, 'the last counter before the limit')
    assert.equal(p.device.state, 'closed')

    // A receiver whose limit is lower refuses the counter that reaches it, even though it authenticates.
    const q = await rawPair()
    const strict = new RecordChannel({ role: 'house', sessionId: q.sessionId, sendKey: q.h2d.enc, recvKey: q.d2h.dec, startedMs: NOW, limits: { frames: 2 } })
    await strict.open((await q.dc.seal('REQ', utf8('0'))).frame)
    await strict.open((await q.dc.seal('REQ', utf8('1'))).frame)
    assert.equal(await rejects(strict.open((await q.dc.seal('REQ', utf8('2'))).frame)), 'range')
    assert.equal(await rejects((async () => { const z = await rawPair({ limits: { frames: 2 } }); await z.dc.seal('REQ', utf8('0')); await z.dc.seal('REQ', utf8('1')); await z.dc.seal('REQ', utf8('2')) })()), 'range', 'the sender never writes a counter at the limit')
  })

  test('11: the byte limit and the age limit end the session with CLOSE(0x02)', async () => {
    const bytes = await rawPair({ limits: { bytes: 200 } })
    const big = await bytes.device.send('REQ', new Uint8Array(150), NOW)
    assert.deepEqual(kinds(big), ['send'])
    assert.equal((await bytes.house.receive(one(big), NOW))[0]?.t, 'record')
    const over = await bytes.device.send('REQ', utf8('x'), NOW)
    assert.deepEqual(kinds(over), ['send', 'closed'], 'the request is not written; CLOSE is')
    assert.equal(closedOf(over)?.code, CLOSE.rekey)
    assert.equal(closedOf(await bytes.house.receive(one(over), NOW))?.code, CLOSE.rekey)
    // The receiving end counted the same bytes: it too would close instead of writing.
    const mirror = await rawPair({ limits: { bytes: 200 } })
    await mirror.house.receive(one(await mirror.device.send('REQ', new Uint8Array(150), NOW)), NOW)
    assert.equal(closedOf(await mirror.house.send('RES', utf8('{}'), NOW))?.code, CLOSE.rekey, 'the limit is per direction, in either direction')

    const age = await rawPair({ limits: { ageMs: 1000 } })
    assert.deepEqual(kinds(await age.device.tick(NOW + 999)), [])
    const aged = await age.device.tick(NOW + 1000)
    assert.equal(closedOf(aged)?.code, CLOSE.rekey)
    const atHouse = await age.house.receive(one(aged), NOW + 1000)
    assert.deepEqual(closedOf(atHouse), { t: 'closed', by: 'peer', code: CLOSE.rekey, reason: 'closed by the peer' })
  })
})

describe('remote session', () => {
  test('application content flows only in the direction of its type', async () => {
    const p = await rawPair()
    const req = one(await p.device.send('REQ', utf8('{"q":1}'), NOW))
    assert.deepEqual(await p.house.receive(req, NOW), [{ t: 'record', ctype: 'REQ', content: utf8('{"q":1}') }])
    assert.deepEqual(await p.device.receive(one(await p.house.send('RES', utf8('{}'), NOW)), NOW), [{ t: 'record', ctype: 'RES', content: utf8('{}') }])
    assert.equal((await p.device.receive(one(await p.house.send('EVT', utf8('{}'), NOW)), NOW))[0]?.t, 'record')
    assert.equal((await p.device.receive(one(await p.house.send('BIN', utf8('b'), NOW)), NOW))[0]?.t, 'record')
    assert.equal((await p.house.receive(one(await p.device.send('BIN', utf8('b'), NOW)), NOW))[0]?.t, 'record')
    assert.equal(await rejects(p.house.send('REQ', utf8('{}'), NOW)), 'bad-state', 'the house does not write REQ')
    assert.equal(await rejects(p.device.send('RES', utf8('{}'), NOW)), 'bad-state')
    assert.equal(await rejects(p.device.send('PING' as 'REQ', utf8(''), NOW)), 'bad-state', 'control types are not application content')
  })

  test('5: a content type in the wrong direction closes', async () => {
    for (const [from, ctype] of [['house', 'REQ'], ['device', 'RES'], ['device', 'EVT'], ['device', 'HS_DONE'], ['device', 'PAIR_DONE'], ['house', 'PAIR_ACK']] as const) {
      const p = await rawPair()
      const frame = (await (from === 'house' ? p.hc : p.dc).seal(ctype as ContentType, new Uint8Array(0))).frame
      const got = await (from === 'house' ? p.device : p.house).receive(frame, NOW)
      assert.equal(closedOf(got)?.by, 'local', `${ctype} from the ${from}`)
      assert.deepEqual(sends(got), [], 'no error answer')
    }
  })

  test('5: HS_DONE is record 0 of the house and nothing else; a second HS_DONE closes', async () => {
    const done = encodeHsDone({ houseMaxVer: 1, now: 1, presence: 0, elevUntil: 0 })
    const notFirst = await rawPair({ deviceGate: 'await-hs-done' })
    const ping = (await notFirst.hc.seal('PING', encodePing(0))).frame
    assert.equal(closedOf((await ownerOf(notFirst.device).receive(ping, NOW)).effects)?.by, 'local', 'a PING in the place of HS_DONE')

    const late = await rawPair({ deviceGate: 'await-hs-done' })
    await late.hc.seal('PING', encodePing(0))
    const r = await ownerOf(late.device).receive((await late.hc.seal('HS_DONE', done)).frame, NOW)
    assert.equal(closedOf(r.effects)?.by, 'local', 'HS_DONE at counter 1 (and counter 0 was withheld)')

    const twice = await rawPair({ deviceGate: 'await-hs-done' })
    const first = await ownerOf(twice.device).receive((await twice.hc.seal('HS_DONE', done)).frame, NOW)
    assert.equal(first.control?.ctype, 'HS_DONE')
    ownerOf(twice.device).open(false)
    assert.equal(closedOf(await twice.device.receive((await twice.hc.seal('HS_DONE', done)).frame, NOW))?.by, 'local')

    const before = await rawPair({ deviceGate: 'await-pair-done' })
    assert.equal(closedOf(await before.device.receive((await before.hc.seal('RES', utf8('{}'))).frame, NOW))?.by, 'local', 'RES before the session is open')
    assert.equal(await rejects(before.device.send('REQ', utf8('{}'), NOW)), 'bad-state', 'REQ cannot be written before the session is open')
  })

  test('heartbeat: PING every HB_INTERVAL, answered by PONG with the counters; silence for HB_TIMEOUT closes locally', async () => {
    const p = await rawPair()
    assert.deepEqual(await p.device.tick(NOW + HB_INTERVAL_MS - 1), [])
    const ping = one(await p.device.tick(NOW + HB_INTERVAL_MS))
    assert.deepEqual(await p.device.tick(NOW + HB_INTERVAL_MS + 1), [], 'one PING per interval')
    const pong = one(await p.house.receive(ping, NOW + HB_INTERVAL_MS))
    assert.deepEqual(await p.device.receive(pong, NOW + HB_INTERVAL_MS), [])
    assert.equal(p.device.state, 'open')
    const silent = await p.house.tick(NOW + HB_INTERVAL_MS + HB_TIMEOUT_MS)
    assert.deepEqual(silent, [{ t: 'closed', by: 'local', reason: 'no valid record within HB_TIMEOUT' }], 'closes locally, writes nothing')
  })

  test('heartbeat: an inconsistent PONG closes (unknown ping, counter not above the ping, counter above what was sent)', async () => {
    const unknown = await rawPair()
    assert.equal(closedOf(await unknown.device.receive((await unknown.hc.seal('PONG', encodePong(0, 1))).frame, NOW))?.by, 'local', 'no PING was pending')

    const notAbove = await rawPair()
    const ping = one(await notAbove.device.tick(NOW + HB_INTERVAL_MS))
    assert.equal(decodeInner(ping).type, 'REC')
    assert.equal(closedOf(await notAbove.device.receive((await notAbove.hc.seal('PONG', encodePong(0, 0))).frame, NOW))?.by, 'local', 'recvNext must be above the ping it answers')

    const tooHigh = await rawPair()
    await tooHigh.device.tick(NOW + HB_INTERVAL_MS)
    assert.equal(closedOf(await tooHigh.device.receive((await tooHigh.hc.seal('PONG', encodePong(0, 9))).frame, NOW))?.by, 'local', 'the peer cannot have received what was not sent')

    const pingHigh = await rawPair()
    assert.equal(closedOf(await pingHigh.device.receive((await pingHigh.hc.seal('PING', encodePing(1))).frame, NOW))?.by, 'local')
    const backwards = await rawPair()
    await backwards.device.send('REQ', utf8('a'), NOW)
    await backwards.device.send('REQ', utf8('b'), NOW)
    await backwards.device.receive((await backwards.hc.seal('PING', encodePing(2))).frame, NOW)
    assert.equal(closedOf(await backwards.device.receive((await backwards.hc.seal('PING', encodePing(1))).frame, NOW))?.by, 'local', 'the report went backwards')
  })

  test('heartbeat: two PINGs in a row reporting the same counter below what was sent mean withheld frames: CLOSE(0x05)', async () => {
    const p = await rawPair()
    for (let i = 0; i < 5; i++) await p.device.send('REQ', utf8('withheld'), NOW)
    // The house never saw the five requests: its PINGs keep saying "I expect 0".
    const first = await p.device.receive((await p.hc.seal('PING', encodePing(0))).frame, NOW + 20_000)
    assert.deepEqual(kinds(first), ['send'], 'the first report only sets the baseline; it is answered')
    const second = await p.device.receive((await p.hc.seal('PING', encodePing(0))).frame, NOW + 40_000)
    assert.deepEqual(kinds(second), ['send', 'closed'])
    assert.equal(closedOf(second)?.code, CLOSE.protocol)

    // A peer that is merely idle (nothing outstanding) or that advances is never closed.
    const idle = await rawPair()
    for (let i = 0; i < 4; i++) {
      const pong = await idle.device.receive((await idle.hc.seal('PING', encodePing(idle.hc.recvNext))).frame, NOW)
      assert.deepEqual(kinds(pong), ['send'])
      await idle.hc.open(one(pong))
    }
    const moving = await rawPair()
    for (let i = 0; i < 4; i++) {
      await moving.house.receive(one(await moving.device.send('REQ', utf8('x'), NOW)), NOW)
      const pong = await moving.device.receive((await moving.hc.seal('PING', encodePing(moving.hc.recvNext))).frame, NOW)
      assert.deepEqual(kinds(pong), ['send'])
      await moving.hc.open(one(pong))
    }
    // One PING that finds frames in flight is not a stall: the next one reports them received.
    const flight = await rawPair()
    const q = one(await flight.device.send('REQ', utf8('in flight'), NOW))
    const p1 = await flight.device.receive((await flight.hc.seal('PING', encodePing(0))).frame, NOW)
    await flight.hc.open(q)
    await flight.hc.open(one(p1))
    assert.deepEqual(kinds(await flight.device.receive((await flight.hc.seal('PING', encodePing(flight.hc.recvNext))).frame, NOW)), ['send'])
  })

  test('close: a CLOSE record ends both ends; CLOSE(0x04) reaches the device as revoked; nothing survives', async () => {
    const p = await rawPair()
    const out = await p.house.close(CLOSE.revoked, NOW)
    assert.deepEqual(kinds(out), ['send', 'closed'])
    assert.deepEqual(await p.device.receive(one(out), NOW), [{ t: 'closed', by: 'peer', code: CLOSE.revoked, reason: 'closed by the peer' }])
    assert.equal(p.device.state, 'closed')
    assert.equal(p.dc.alive, false, 'keys are dropped')
    assert.equal(p.hc.alive, false)
    assert.deepEqual(await p.device.receive(one(out), NOW), [], 'a closed session ignores everything')
    assert.equal(await rejects(p.device.send('REQ', utf8('{}'), NOW)), 'bad-state')
    assert.deepEqual(await p.house.close(CLOSE.normal, NOW), [], 'closing twice writes nothing')
    const bad = await rawPair()
    assert.equal(closedOf(await bad.device.receive((await bad.hc.seal('CLOSE', u8(9))).frame, NOW))?.by, 'local', 'an unknown close code is a protocol error')
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Session handshake
// ---------------------------------------------------------------------------------------------------------------

interface World {
  house: RoleKey
  device: RoleKey
  deviceId: Bytes
  registry: Map<string, DeviceRecord>
  lookups: number
  lookup: (id: Bytes) => DeviceRecord | undefined
}

async function world(): Promise<World> {
  const house = (await generateRoleKey('house')).key
  const device = (await generateRoleKey('device')).key
  const deviceId = await deviceIdOf(device.pub)
  const registry = new Map<string, DeviceRecord>()
  registry.set(toHex(deviceId), { pubD: device.pub, revoked: false, expired: false, maxVerUsed: 1, liveSessions: 0, presence: 1, elevUntil: 0 })
  const w: World = { house, device, deviceId, registry, lookups: 0, lookup: id => { w.lookups++; return w.registry.get(toHex(id)) } }
  return w
}

async function connect(w: World, o: { houseMaxVer?: number; deviceMaxVer?: number } = {}) {
  const wire: { dir: 'd2h' | 'h2d'; frame: Bytes }[] = []
  const d = await DeviceHandshake.start({ pinnedPubH: w.house.pub, kD: w.device, nowMs: NOW, deviceMaxVer: o.deviceMaxVer })
  const h = new HouseHandshake({ kH: w.house, lookup: w.lookup, nowMs: NOW, houseMaxVer: o.houseMaxVer })
  const hs1 = one(d.effects)
  wire.push({ dir: 'd2h', frame: hs1 })
  const hs2 = one(await h.onFrame(hs1, NOW))
  wire.push({ dir: 'h2d', frame: hs2 })
  const hs3 = one(await d.hs.onFrame(hs2, NOW))
  wire.push({ dir: 'd2h', frame: hs3 })
  const houseEffects = await h.onFrame(hs3, NOW + 5)
  const hsDone = one(houseEffects)
  wire.push({ dir: 'h2d', frame: hsDone })
  const deviceEffects = await d.hs.onFrame(hsDone, NOW + 5)
  return { d, h, hs1, hs2, hs3, hsDone, houseEffects, deviceEffects, wire }
}

/** A device written by hand over the primitives, to produce the HS3 the real one would never write. */
class ManualDevice {
  readonly eph: Ephemeral
  readonly nD = randomBytes(32)
  readonly hs1: Bytes
  private constructor(eph: Ephemeral) {
    this.eph = eph
    this.hs1 = encodeInner({ type: 'HS1', ver: 1, suite: SUITE, eD: eph.pub, nD: this.nD })
  }
  static async create(): Promise<ManualDevice> { return new ManualDevice(await generateEphemeral()) }

  async hs3(pubH: Uint8Array, hs2: Uint8Array, o: { signer: RoleKey; claimPub?: Uint8Array; deviceId?: Bytes; wrongTranscript?: boolean; garbage?: boolean }): Promise<Bytes> {
    const f = decodeInner(hs2)
    assert.ok(f.type === 'HS2')
    const z = await Secret.agree(this.eph.privateKey, f.eH)
    const t1 = await TH.th1(await TH.th0(1, SUITE), 1, SUITE, this.eph.pub, this.nD)
    const t2 = await TH2(t1, f.eH, f.nH, pubH, await houseIdOf(pubH))
    const sigH = await new OneShotKey(await z.aesKey(t2, 'k-hs-h2d', 'decrypt')).open(t2, f.ct2)
    const t3 = await TH.th3(t2, f.ct2)
    const claim = o.claimPub ?? o.signer.pub
    const t4 = await TH.th4(o.wrongTranscript ? randomBytes(32) : t3, claim)
    const sigD = await o.signer.sign('device-hs', concat(t4, sigH))
    const body = o.garbage ? randomBytes(80) : concat(o.deviceId ?? await deviceIdOf(claim), sigD)
    const ct3 = o.garbage ? randomBytes(96) : await new OneShotKey(await z.aesKey(t2, 'k-hs-d2h', 'encrypt')).seal(t3, body)
    return encodeInner({ type: 'HS3', ct3 })
  }
}

describe('remote session handshake', () => {
  test('both sides establish the same session and exchange messages; the registry is read twice', async () => {
    const w = await world()
    const c = await connect(w)
    assert.deepEqual([c.hs1.length, c.hs2.length, c.hs3.length], [100, 178, 97])
    assert.deepEqual(kinds(c.houseEffects), ['send', 'established'])
    assert.deepEqual(kinds(c.deviceEffects), ['established'])
    const hs = established(c.houseEffects)
    const ds = established(c.deviceEffects)
    assert.equal(toHex(hs.sessionId), toHex(ds.sessionId))
    assert.equal(hs.sessionId.length, 16)
    assert.equal(w.lookups, 2, 'after the signature and again immediately before HS_DONE')
    const info = c.deviceEffects.find(e => e.t === 'established')
    assert.deepEqual(info?.t === 'established' && info.info, { ver: 1, houseMaxVer: 1, pinnedVer: 1, houseNow: Math.floor((NOW + 5) / 1000), presence: 1, elevUntil: 0 })
    const dev = c.houseEffects.find(e => e.t === 'established')
    assert.equal(dev?.t === 'established' && toHex(dev.device.pubD), toHex(w.device.pub))
    assert.equal(ds.freshPair, false)

    const hsDone = decodeInner(c.hsDone)
    assert.equal(hsDone.type === 'REC' && hsDone.ctr, 0, 'HS_DONE is record 0 of the house')
    const req = one(await ds.send('REQ', utf8('{"op":"hello"}'), NOW))
    assert.deepEqual(await hs.receive(req, NOW), [{ t: 'record', ctype: 'REQ', content: utf8('{"op":"hello"}') }])
    const res = one(await hs.send('RES', utf8('{"ok":true}'), NOW))
    assert.deepEqual(await ds.receive(res, NOW), [{ t: 'record', ctype: 'RES', content: utf8('{"ok":true}') }])
    assert.equal(c.d.hs.state, 'done')
    assert.equal(c.h.state, 'done')
    assert.deepEqual(await c.d.hs.onFrame(c.hs2, NOW), [], 'a finished handshake ignores frames')
  })

  test('2: two handshakes with the same static keys have different sessionId and keys', async () => {
    const w = await world()
    const a = await connect(w)
    const b = await connect(w)
    const [da, ha, db, hb] = [established(a.deviceEffects), established(a.houseEffects), established(b.deviceEffects), established(b.houseEffects)]
    assert.notEqual(toHex(da.sessionId), toHex(db.sessionId))
    assert.notEqual(toHex(a.hs2), toHex(b.hs2))
    const forA = one(await da.send('REQ', utf8('{}'), NOW))
    assert.equal(closedOf(await hb.receive(forA, NOW))?.by, 'local', 'a record of session A does not open in session B')
    assert.equal((await ha.receive(forA, NOW))[0]?.t, 'record')
    // E-4: a BIN frame is valid only in the session it was written in. Replayed after a reconnection (a new
    // handshake of the same device with the same house) it does not open, so a recorded Enter cannot be typed twice.
    const keys = one(await da.send('BIN', concat(new Uint8Array(4), utf8('rm -rf x\r')), NOW))
    assert.equal((await ha.receive(keys, NOW))[0]?.t, 'record')
    const reconnect = await connect(w)
    assert.equal(closedOf(await established(reconnect.houseEffects).receive(keys, NOW))?.by, 'local')
  })

  test('3: HS2 signed by another key, or reused from another session, is a hard error and HS3 is never sent', async () => {
    const w = await world()
    // A false house that knows the pinned public key and builds a perfect transcript, but signs with its own key.
    const fake = (await generateRoleKey('house')).key
    const d = await DeviceHandshake.start({ pinnedPubH: w.house.pub, kD: w.device, nowMs: NOW })
    const hs1 = decodeInner(one(d.effects))
    assert.ok(hs1.type === 'HS1')
    const eph = await generateEphemeral()
    const nH = randomBytes(32)
    const z = await Secret.agree(eph.privateKey, hs1.eD)
    const t1 = await TH.th1(await TH.th0(1, SUITE), 1, SUITE, hs1.eD, hs1.nD)
    const t2 = await TH2(t1, eph.pub, nH, w.house.pub, await houseIdOf(w.house.pub))
    const ct2 = await new OneShotKey(await z.aesKey(t2, 'k-hs-h2d', 'encrypt')).seal(t2, await fake.sign('house-hs', t2))
    const forged = await d.hs.onFrame(encodeInner({ type: 'HS2', eH: eph.pub, nH, ct2 }), NOW)
    assert.deepEqual(forged, [{ t: 'failed', reason: 'house-not-proven', hard: true }], 'ct2 opens, the signature is not of the pinned key')

    // A whole HS2 recorded from another session of the real house.
    const other = await connect(w)
    const d2 = await DeviceHandshake.start({ pinnedPubH: w.house.pub, kD: w.device, nowMs: NOW })
    assert.deepEqual(await d2.hs.onFrame(other.hs2, NOW), [{ t: 'failed', reason: 'house-not-proven', hard: true }])
    assert.equal(d2.hs.state, 'failed')
    assert.deepEqual(await d2.hs.onFrame(other.hs2, NOW), [], 'no second chance')

    // The real signature of another session, re-encrypted under this session's keys by someone holding K_H's output.
    const d3 = await DeviceHandshake.start({ pinnedPubH: w.house.pub, kD: w.device, nowMs: NOW })
    const hs1c = decodeInner(one(d3.effects))
    assert.ok(hs1c.type === 'HS1')
    const eph3 = await generateEphemeral()
    const z3 = await Secret.agree(eph3.privateKey, hs1c.eD)
    const t1c = await TH.th1(await TH.th0(1, SUITE), 1, SUITE, hs1c.eD, hs1c.nD)
    const t2c = await TH2(t1c, eph3.pub, nH, w.house.pub, await houseIdOf(w.house.pub))
    const staleSig = await w.house.sign('house-hs', t2) // a genuine house-hs signature, over another transcript
    const ct2c = await new OneShotKey(await z3.aesKey(t2c, 'k-hs-h2d', 'encrypt')).seal(t2c, staleSig)
    assert.deepEqual(await d3.hs.onFrame(encodeInner({ type: 'HS2', eH: eph3.pub, nH, ct2: ct2c }), NOW), [{ t: 'failed', reason: 'house-not-proven', hard: true }])
  })

  test('14: a house whose key is not the pinned one is a hard error', async () => {
    const w = await world()
    const impostor = (await generateRoleKey('house')).key
    const d = await DeviceHandshake.start({ pinnedPubH: w.house.pub, kD: w.device, nowMs: NOW })
    const h = new HouseHandshake({ kH: impostor, lookup: w.lookup, nowMs: NOW })
    const hs2 = one(await h.onFrame(one(d.effects), NOW))
    assert.deepEqual(await d.hs.onFrame(hs2, NOW), [{ t: 'failed', reason: 'house-not-proven', hard: true }])
  })

  test('4: HS3 for another transcript, with an unknown deviceId, of a revoked device or that does not open: the same HS_FAIL at the same instant', async () => {
    const w = await world()
    const stranger = (await generateRoleKey('device')).key
    const arrival = NOW + 1234
    const run = async (o: Parameters<ManualDevice['hs3']>[2], prepare?: () => void): Promise<HouseHsEffect[]> => {
      const m = await ManualDevice.create()
      const h = new HouseHandshake({ kH: w.house, lookup: w.lookup, nowMs: NOW })
      const hs2 = one(await h.onFrame(m.hs1, NOW))
      prepare?.()
      return h.onFrame(await m.hs3(w.house.pub, hs2, o), arrival)
    }
    const good = await run({ signer: w.device })
    assert.deepEqual(kinds(good), ['send', 'established'], 'the hand-written device is a correct one')

    const expected: HouseHsEffect[] = [
      { t: 'send', frame: HS_FAIL_FRAME(), notBeforeMs: arrival + FAIL_DELAY_MS },
      { t: 'close', reason: 'hs-fail', notBeforeMs: arrival + FAIL_DELAY_MS },
    ]
    assert.deepEqual(await run({ signer: w.device, wrongTranscript: true }), expected, 'a valid signature over another transcript')
    assert.deepEqual(await run({ signer: stranger }), expected, 'unknown deviceId')
    assert.deepEqual(await run({ signer: stranger, deviceId: w.deviceId }), expected, 'a registered deviceId signed by another key')
    assert.deepEqual(await run({ signer: w.device, garbage: true }), expected, 'ct3 does not open')
    const rec = w.registry.get(toHex(w.deviceId))!
    assert.deepEqual(await run({ signer: w.device }, () => { rec.revoked = true }), expected, 'revoked')
    rec.revoked = false
    assert.deepEqual(await run({ signer: w.device }, () => { rec.expired = true }), expected, 'expired')
    rec.expired = false
    assert.deepEqual(await run({ signer: w.device }, () => { rec.maxVerUsed = 2 }), expected, 'a version below the floor of this device (2.5 rule 3)')
    rec.maxVerUsed = 1
    assert.deepEqual(await run({ signer: w.device }, () => { rec.liveSessions = 3 }), expected, '62: the fourth session of the same device')
    rec.liveSessions = 2
    assert.deepEqual(kinds(await run({ signer: w.device })), ['send', 'established'], 'the third session is accepted')
  })

  test('38: a device revoked in the middle of the handshake gets no HS_DONE', async () => {
    const w = await world()
    const rec = w.registry.get(toHex(w.deviceId))!
    let n = 0
    const lookup = (id: Bytes): DeviceRecord | undefined => { n++; return n === 1 ? w.registry.get(toHex(id)) : { ...rec, revoked: true } }
    const d = await DeviceHandshake.start({ pinnedPubH: w.house.pub, kD: w.device, nowMs: NOW })
    const h = new HouseHandshake({ kH: w.house, lookup, nowMs: NOW })
    const hs3 = one(await d.hs.onFrame(one(await h.onFrame(one(d.effects), NOW)), NOW))
    const out = await h.onFrame(hs3, NOW)
    assert.equal(n, 2)
    assert.deepEqual(out, [
      { t: 'send', frame: HS_FAIL_FRAME(), notBeforeMs: NOW + FAIL_DELAY_MS },
      { t: 'close', reason: 'hs-fail', notBeforeMs: NOW + FAIL_DELAY_MS },
    ])
    assert.deepEqual(await d.hs.onFrame(HS_FAIL_FRAME(), NOW + FAIL_DELAY_MS), [{ t: 'failed', reason: 'hs-fail', hard: false }])
  })

  test('13: HS_FAIL in the middle is a soft failure: no lower version, no offer to pair again, no retry inside the machine', async () => {
    const w = await world()
    for (const when of ['after-hs1', 'after-hs3'] as const) {
      const d = await DeviceHandshake.start({ pinnedPubH: w.house.pub, kD: w.device, nowMs: NOW })
      if (when === 'after-hs3') {
        const h = new HouseHandshake({ kH: w.house, lookup: w.lookup, nowMs: NOW })
        await d.hs.onFrame(one(await h.onFrame(one(d.effects), NOW)), NOW)
      }
      const out = await d.hs.onFrame(HS_FAIL_FRAME(), NOW)
      assert.deepEqual(out, [{ t: 'failed', reason: 'hs-fail', hard: false }], when)
      assert.deepEqual(sends(out), [], 'nothing is written in answer')
      assert.equal(d.hs.state, 'failed')
      assert.deepEqual(await d.hs.tick(NOW + HS_DEADLINE_MS), [], 'a failed handshake stays failed')
    }
    // The only version a device can start with is one this build speaks; there is no API to go below the pin.
    assert.equal(await rejects(DeviceHandshake.start({ pinnedPubH: w.house.pub, kD: w.device, nowMs: NOW, pinnedVer: 0 })), 'bad-version')
    assert.equal(await rejects(DeviceHandshake.start({ pinnedPubH: w.house.pub, kD: w.device, nowMs: NOW, pinnedVer: 2 })), 'bad-version')
  })

  test('46 (E-1): a session at a version below min(houseMaxVer, what the device speaks) is closed with CLOSE(0x05) and not used', async () => {
    const w = await world()
    const c = await connect(w, { houseMaxVer: 2, deviceMaxVer: 2 })
    assert.deepEqual(kinds(c.deviceEffects), ['send', 'failed'])
    const failed = c.deviceEffects.find(e => e.t === 'failed')
    assert.deepEqual(failed, { t: 'failed', reason: 'version-downgrade', hard: false })
    const hs = established(c.houseEffects)
    assert.deepEqual(await hs.receive(one(c.deviceEffects), NOW), [{ t: 'closed', by: 'peer', code: CLOSE.protocol, reason: 'closed by the peer' }])
    // A device that only speaks v1 is not fooled by a house that announces more: there is nothing higher to use.
    const ok = await connect(w, { houseMaxVer: 2 })
    assert.deepEqual(kinds(ok.deviceEffects), ['established'])
    // And a house that announces less than the version in use is incoherent.
    const low = await connect(w, { houseMaxVer: 0 })
    assert.deepEqual(low.deviceEffects, [{ t: 'failed', reason: 'protocol', hard: false }])
  })

  test('1: an ephemeral off the curve, compressed, hybrid, of the wrong size or equal to the other side closes', async () => {
    const w = await world()
    for (const name of ['offCurve', 'hybrid', 'badPrefix'] as const) {
      const h = new HouseHandshake({ kH: w.house, lookup: w.lookup, nowMs: NOW })
      const hs1 = encodeInner({ type: 'HS1', ver: 1, suite: 1, eD: SELF_TEST_POINTS[name](), nD: randomBytes(32) })
      assert.deepEqual(kinds(await h.onFrame(hs1, NOW)), ['close'], `e_D ${name}`)
      assert.equal(h.state, 'closed')

      const d = await DeviceHandshake.start({ pinnedPubH: w.house.pub, kD: w.device, nowMs: NOW })
      const hs2 = encodeInner({ type: 'HS2', eH: SELF_TEST_POINTS[name](), nH: randomBytes(32), ct2: randomBytes(80) })
      assert.deepEqual(await d.hs.onFrame(hs2, NOW), [{ t: 'failed', reason: 'protocol', hard: false }], `e_H ${name}`)
    }
    // A compressed point (33 bytes) or one of 64 bytes cannot even be framed: the frame size is fixed.
    for (const name of ['compressed', 'short64'] as const) {
      const h = new HouseHandshake({ kH: w.house, lookup: w.lookup, nowMs: NOW })
      const frame = concat(u8(0x01), u8(1), u8(1), SELF_TEST_POINTS[name](), randomBytes(32))
      assert.deepEqual(kinds(await h.onFrame(frame, NOW)), ['close'], `e_D ${name}`)
      const padded = concat(u8(0x01), u8(1), u8(1), SELF_TEST_POINTS[name](), new Uint8Array(65 - SELF_TEST_POINTS[name]().length), randomBytes(32))
      const h2 = new HouseHandshake({ kH: w.house, lookup: w.lookup, nowMs: NOW })
      assert.deepEqual(kinds(await h2.onFrame(padded, NOW)), ['close'], `e_D ${name}, padded to 65 bytes`)
    }
    // Reflection: the house answers with the device's own ephemeral.
    const d = await DeviceHandshake.start({ pinnedPubH: w.house.pub, kD: w.device, nowMs: NOW })
    const hs1 = decodeInner(one(d.effects))
    assert.ok(hs1.type === 'HS1')
    const reflected = encodeInner({ type: 'HS2', eH: hs1.eD, nH: randomBytes(32), ct2: randomBytes(80) })
    assert.deepEqual(await d.hs.onFrame(reflected, NOW), [{ t: 'failed', reason: 'protocol', hard: false }])
    const eph = await generateEphemeral()
    const h = new HouseHandshake({ kH: w.house, lookup: w.lookup, nowMs: NOW, entropy: { random: randomBytes, ephemeral: async () => eph } })
    const same = encodeInner({ type: 'HS1', ver: 1, suite: 1, eD: eph.pub, nD: randomBytes(32) })
    assert.deepEqual(await h.onFrame(same, NOW), [{ t: 'close', reason: 'reflected ephemeral' }])
  })

  test('a version or a suite the house does not speak gets HS_FAIL at once; the house never negotiates', async () => {
    const w = await world()
    for (const [ver, suite] of [[2, 1], [0, 1], [1, 2]] as const) {
      const h = new HouseHandshake({ kH: w.house, lookup: w.lookup, nowMs: NOW })
      const eph = await generateEphemeral()
      const out = await h.onFrame(encodeInner({ type: 'HS1', ver, suite, eD: eph.pub, nD: randomBytes(32) }), NOW)
      assert.deepEqual(out, [{ t: 'send', frame: HS_FAIL_FRAME() }, { t: 'close', reason: 'version or suite not spoken' }])
    }
  })

  test('5 / 59: only the frame of each state is accepted: REQ before HS_DONE, P1 on an admission route, HS1 twice', async () => {
    const w = await world()
    const p1 = encodeInner({ type: 'P1', ver: 1, suite: 1, rv: randomBytes(16), commit: randomBytes(32) })
    const h = new HouseHandshake({ kH: w.house, lookup: w.lookup, nowMs: NOW })
    assert.deepEqual(await h.onFrame(p1, NOW), [{ t: 'close', reason: 'a route opened by admission accepts only HS1' }], '59')

    const d = await DeviceHandshake.start({ pinnedPubH: w.house.pub, kD: w.device, nowMs: NOW })
    const h2 = new HouseHandshake({ kH: w.house, lookup: w.lookup, nowMs: NOW })
    await h2.onFrame(one(d.effects), NOW)
    const early = encodeInner({ type: 'REC', ctr: 0, sealed: randomBytes(80) })
    assert.deepEqual(await h2.onFrame(early, NOW), [{ t: 'close', reason: 'only HS3 is accepted after HS2' }], 'a record in the place of HS3')

    const h3 = new HouseHandshake({ kH: w.house, lookup: w.lookup, nowMs: NOW })
    await h3.onFrame(one(d.effects), NOW)
    assert.deepEqual(kinds(await h3.onFrame(one(d.effects), NOW)), ['close'], 'a second HS1')

    const d2 = await DeviceHandshake.start({ pinnedPubH: w.house.pub, kD: w.device, nowMs: NOW })
    assert.deepEqual(await d2.hs.onFrame(early, NOW), [{ t: 'failed', reason: 'protocol', hard: false }], 'a record in the place of HS2')
    const d3 = await DeviceHandshake.start({ pinnedPubH: w.house.pub, kD: w.device, nowMs: NOW })
    assert.deepEqual(await d3.hs.onFrame(concat(one(d3.effects), u8(0)), NOW), [{ t: 'failed', reason: 'protocol', hard: false }], 'a frame with a byte left over')
  })

  test('60: a recorded HS1 replayed on a new route gets a fresh HS2 and dies at HS_DEADLINE without a valid HS3', async () => {
    const w = await world()
    const first = await connect(w)
    const h = new HouseHandshake({ kH: w.house, lookup: w.lookup, nowMs: NOW })
    const hs2 = one(await h.onFrame(first.hs1, NOW + 1000))
    assert.notEqual(toHex(hs2), toHex(first.hs2), 'a new ephemeral and a new signature')
    assert.deepEqual(await h.tick(NOW + 1000 + HS_DEADLINE_MS - 1), [])
    // Replaying the HS3 of the recorded session does not help: it was sealed under other keys.
    const h2 = new HouseHandshake({ kH: w.house, lookup: w.lookup, nowMs: NOW })
    await h2.onFrame(first.hs1, NOW)
    assert.deepEqual(kinds(await h2.onFrame(first.hs3, NOW)), ['send', 'close'])
    assert.deepEqual(await h.tick(NOW + 1000 + HS_DEADLINE_MS), [{ t: 'close', reason: 'HS_DEADLINE' }])
    assert.equal(h.state, 'closed')
  })

  test('HS_DEADLINE: the device gives up without HS2 or without HS_DONE; the house without HS1', async () => {
    const w = await world()
    const d = await DeviceHandshake.start({ pinnedPubH: w.house.pub, kD: w.device, nowMs: NOW })
    assert.deepEqual(await d.hs.tick(NOW + HS_DEADLINE_MS - 1), [])
    assert.deepEqual(await d.hs.tick(NOW + HS_DEADLINE_MS), [{ t: 'failed', reason: 'timeout', hard: false }])
    const h = new HouseHandshake({ kH: w.house, lookup: w.lookup, nowMs: NOW })
    assert.deepEqual(await h.tick(NOW + HS_DEADLINE_MS), [{ t: 'close', reason: 'HS_DEADLINE' }])
    const d2 = await DeviceHandshake.start({ pinnedPubH: w.house.pub, kD: w.device, nowMs: NOW })
    assert.deepEqual(await d2.hs.routeClosed(), [{ t: 'failed', reason: 'route-closed', hard: false }])
  })

  test('the handshake only signs with the key of its role, and only pins a real point', async () => {
    const w = await world()
    assert.equal(await rejects(DeviceHandshake.start({ pinnedPubH: w.house.pub, kD: w.house, nowMs: NOW })), 'bad-label')
    assert.equal(await rejects(DeviceHandshake.start({ pinnedPubH: SELF_TEST_POINTS.offCurve(), kD: w.device, nowMs: NOW })), 'bad-point')
    assert.throws(() => new HouseHandshake({ kH: w.device, lookup: w.lookup, nowMs: NOW }), (e: unknown) => e instanceof WireError && e.code === 'bad-label')
  })

  test('12: the spy on the relay sees no deviceId, no pub_D, no canary, and no nonce twice per direction', async () => {
    const w = await world()
    const c = await connect(w)
    const ds = established(c.deviceEffects)
    const hs = established(c.houseEffects)
    const canary = utf8('CANARY-7f3a9c-terminal-secret')
    for (let i = 0; i < 20; i++) {
      const q = one(await ds.send(i % 2 ? 'REQ' : 'BIN', concat(canary, u8(i)), NOW))
      c.wire.push({ dir: 'd2h', frame: q })
      await hs.receive(q, NOW)
      const a = one(await hs.send(i % 2 ? 'RES' : 'EVT', concat(canary, u8(i)), NOW))
      c.wire.push({ dir: 'h2d', frame: a })
      await ds.receive(a, NOW)
    }
    const ping = one(await ds.tick(NOW + HB_INTERVAL_MS))
    c.wire.push({ dir: 'd2h', frame: ping })
    c.wire.push({ dir: 'h2d', frame: one(await hs.receive(ping, NOW + HB_INTERVAL_MS)) })

    const contains = (hay: Uint8Array, needle: Uint8Array): boolean => toHex(hay).includes(toHex(needle))
    const seen = { d2h: new Set<number>(), h2d: new Set<number>() }
    const sizes = new Set<number>()
    for (const { dir, frame } of c.wire) {
      assert.equal(contains(frame, w.deviceId), false, 'deviceId in clear')
      assert.equal(contains(frame, w.device.pub), false, 'pub_D in clear')
      assert.equal(contains(frame, w.device.pub.subarray(1, 33)), false, 'the X of pub_D in clear')
      assert.equal(contains(frame, canary), false, 'canary in clear')
      assert.equal(contains(frame, w.house.pub), false, 'no house key travels in session mode')
      const f = decodeInner(frame)
      if (f.type !== 'REC') continue
      assert.equal(seen[dir].has(f.ctr), false, `nonce ${f.ctr} twice in ${dir}`)
      seen[dir].add(f.ctr)
      sizes.add(frame.length)
    }
    assert.equal(seen.d2h.size, 21)
    assert.equal(seen.h2d.size, 22)
    assert.deepEqual([...sizes], [64 + 25], 'heartbeat and application records are indistinguishable by size')
  })
})
