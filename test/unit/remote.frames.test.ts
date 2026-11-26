// Remote wire, layer 1 (spec 2): byte helpers, the outer frame of each relay leg, the inner frame, the padded record
// plaintext, the control contents, the application envelopes and the two pairing accesses. Negative tests of spec 9.2
// are named with their number.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { audBytes, isValidAudBytes } from '../../src/remote/aud.ts'
import {
  ascii, b64url, base32, concat, ctEqual, fromB64url, fromHex, lp16, lp8, Reader, toHex, u16, u32, u64, u8, utf8, WireError,
} from '../../src/remote/bytes.ts'
import { DENY_MAX, LABEL_NAMES, LBL, MAX_INNER, MAX_PRE_AUTH, MAX_RECORD_CONTENT } from '../../src/remote/constants.ts'
import {
  CTYPE, decodeBin, decodeClose, decodeDeviceHello, decodeEvt, decodeHsDone, decodePairDone, decodePing, decodePong,
  decodeQrBlob, decodeReq, decodeRes, encodeBin, encodeClose, encodeDeviceHello, encodeEvt, encodeHsDone, encodePairDone,
  encodePing, encodePong, encodeQrBlob, encodeReq, encodeRes, formatTypedCode, paddedSize, padPlaintext, parseJsonObject,
  parseQrFragment, parseTypedCode, qrFragment, sanitizeDeclaredName, unpadPlaintext,
} from '../../src/remote/content.ts'
import {
  decodeInner, decodeOuter, encodeInner, encodeOuter, INNER_SIZE, innerTypeOf, type InnerFrame, type OuterFrame,
} from '../../src/remote/frames.ts'

const fill = (n: number, v: number): Uint8Array<ArrayBuffer> => new Uint8Array(n).fill(v)
const code = (fn: () => unknown): string => {
  try { fn() } catch (e) { return e instanceof WireError ? e.code : `other:${String(e)}` }
  return 'no-error'
}

describe('remote bytes', () => {
  test('integers are big-endian and refuse values outside their width', () => {
    assert.equal(toHex(u8(0xab)), 'ab')
    assert.equal(toHex(u16(0x0102)), '0102')
    assert.equal(toHex(u32(0xdeadbeef)), 'deadbeef')
    assert.equal(toHex(u64(2 ** 32)), '0000000100000000')
    assert.equal(toHex(u64(2 ** 53 - 1)), '001fffffffffffff')
    assert.equal(code(() => u8(256)), 'range')
    assert.equal(code(() => u64(-1)), 'range')
    assert.equal(code(() => u64(2 ** 53)), 'range')
    assert.equal(new Reader(u64(2 ** 40 + 7)).u64(), 2 ** 40 + 7)
    assert.equal(code(() => new Reader(fromHex('0020000000000000')).u64()), 'range')
  })

  test('lp8 and lp16 prefix the length; the reader refuses truncation and bytes left over', () => {
    assert.equal(toHex(lp8(fromHex('aabb'))), '02aabb')
    assert.equal(toHex(lp16(fromHex('aabb'))), '0002aabb')
    assert.equal(code(() => lp8(fill(256, 0))), 'too-large')
    assert.equal(code(() => new Reader(fromHex('03aabb')).lp8()), 'malformed')
    const r = new Reader(fromHex('0102'))
    r.u8()
    assert.equal(code(() => r.end()), 'malformed')
  })

  test('base32 is RFC 4648 lowercase without padding; base64url round-trips and refuses stray bits', () => {
    assert.equal(base32(ascii('foobar')), 'mzxw6ytboi')
    assert.equal(base32(ascii('fo')), 'mzxq')
    assert.equal(base32(fill(32, 0xff)).length, 52)
    for (const n of [0, 1, 2, 3, 4, 31, 32]) {
      const b = fill(n, 0xa5)
      assert.deepEqual(fromB64url(b64url(b)), b)
    }
    assert.equal(b64url(ascii('fo')), 'Zm8')
    assert.equal(code(() => fromB64url('Zm9')), 'malformed', 'non-zero trailing bits')
    assert.equal(code(() => fromB64url('Zm8=')), 'malformed', 'padding is not accepted')
    assert.equal(code(() => fromB64url('Z')), 'malformed')
  })

  test('constant-time comparison answers like a plain one', () => {
    assert.equal(ctEqual(fromHex('0011'), fromHex('0011')), true)
    assert.equal(ctEqual(fromHex('0011'), fromHex('0010')), false)
    assert.equal(ctEqual(fromHex('0011'), fromHex('001100')), false)
  })

  test('V-1 shape: every label is the ASCII name under the prefix with a final zero, and none prefixes another', () => {
    const all = LABEL_NAMES.map(n => toHex(LBL(n)))
    assert.equal(toHex(LBL('th')), toHex(concat(ascii('tether-remote/v1/th'), u8(0))))
    assert.equal(new Set(all).size, LABEL_NAMES.length)
    for (const a of all) for (const b of all) if (a !== b) assert.ok(!b.startsWith(a), 'no label is a prefix of another')
  })

  test('aud: 1 to 253 printable ASCII bytes without uppercase (48, E-3)', () => {
    assert.equal(isValidAudBytes(ascii('relay.example:8443')), true)
    assert.equal(isValidAudBytes(ascii('localhost:8787')), true)
    assert.equal(isValidAudBytes(new Uint8Array(0)), false, '0 bytes')
    assert.equal(isValidAudBytes(fill(253, 0x61)), true)
    assert.equal(isValidAudBytes(fill(254, 0x61)), false, '254 bytes')
    assert.equal(isValidAudBytes(ascii('Relay.example')), false, 'uppercase')
    assert.equal(isValidAudBytes(ascii('relay example')), false, 'space')
    assert.equal(isValidAudBytes(fromHex('610062')), false, 'zero byte')
    assert.equal(isValidAudBytes(fromHex('61c3a9')), false, 'not ASCII')
    assert.equal(code(() => audBytes('RELAY')), 'malformed')
    assert.equal(code(() => audBytes('')), 'malformed')
  })
})

describe('remote outer frames', () => {
  const samples: { leg: 'device' | 'house'; sender: 'relay' | 'end'; frame: OuterFrame }[] = [
    { leg: 'device', sender: 'relay', frame: { type: 'R_HELLO', nR: fill(32, 1) } },
    { leg: 'device', sender: 'end', frame: { type: 'D_ADMIT', houseId: fill(32, 2), ticket: fill(210, 3), nD: fill(32, 4), sigA: fill(64, 5) } },
    { leg: 'device', sender: 'end', frame: { type: 'D_PAIR', rv: fill(16, 6) } },
    { leg: 'device', sender: 'relay', frame: { type: 'R_OK' } },
    { leg: 'device', sender: 'relay', frame: { type: 'R_FAIL' } },
    { leg: 'device', sender: 'end', frame: { type: 'DATA', inner: fill(100, 7) } },
    { leg: 'house', sender: 'relay', frame: { type: 'R_CHALLENGE', r: fill(32, 8) } },
    { leg: 'house', sender: 'end', frame: { type: 'H_AUTH', pubH: fill(65, 4), certR: fill(179, 9), certsT: [fill(179, 10), fill(179, 11)], c: fill(32, 12), ts: 1_795_000_000, sigR: fill(64, 13) } },
    { leg: 'house', sender: 'relay', frame: { type: 'R_AUTH_OK' } },
    { leg: 'house', sender: 'relay', frame: { type: 'R_AUTH_FAIL', code: 0 } },
    { leg: 'house', sender: 'end', frame: { type: 'H_PAIR_LISTEN', ttl: 120, rvs: [fill(16, 14), fill(16, 15)] } },
    { leg: 'house', sender: 'end', frame: { type: 'H_PAIR_CANCEL' } },
    { leg: 'house', sender: 'relay', frame: { type: 'R_PAIR_STATE', code: 1 } },
    { leg: 'house', sender: 'end', frame: { type: 'H_DENY', entries: [{ ticketId: fill(16, 16), exp: 1_800_000_000 }], overflow: false } },
    { leg: 'house', sender: 'relay', frame: { type: 'R_NOTICE', code: 2 } },
    { leg: 'house', sender: 'relay', frame: { type: 'ROUTE_OPEN', routeId: 7, kind: 1, hint: fill(16, 17) } },
    { leg: 'house', sender: 'end', frame: { type: 'ROUTE_DATA', routeId: 0xffffffff, inner: fill(50, 18) } },
    { leg: 'house', sender: 'relay', frame: { type: 'ROUTE_CLOSE', routeId: 7 } },
    { leg: 'house', sender: 'end', frame: { type: 'LINK_PING', echo: fill(8, 19) } },
    { leg: 'house', sender: 'relay', frame: { type: 'LINK_PONG', echo: fill(8, 20) } },
  ]

  test('every outer frame round-trips, starts with version 0x01 and refuses a trailing byte (9)', () => {
    for (const s of samples) {
      const bytes = encodeOuter(s.frame)
      assert.equal(bytes[0], 0x01)
      assert.deepEqual(decodeOuter(s.leg, s.sender, bytes), s.frame, s.frame.type)
      assert.equal(code(() => decodeOuter(s.leg, s.sender, concat(bytes, u8(0)))), s.frame.type === 'DATA' || s.frame.type === 'ROUTE_DATA' ? 'no-error' : 'malformed', `${s.frame.type} + 1 byte`)
    }
  })

  test('H_AUTH has the size the spec fixes: 2 + 65 + 179 + 1 + 179×nT + 32 + 8 + 64', () => {
    const f = samples.find(s => s.frame.type === 'H_AUTH')!.frame
    assert.equal(encodeOuter(f).length, 2 + 65 + 179 + 1 + 358 + 32 + 8 + 64)
  })

  test('a type of the other leg, or of the other direction, is unknown', () => {
    const hello = encodeOuter({ type: 'R_HELLO', nR: fill(32, 1) })
    assert.equal(code(() => decodeOuter('device', 'end', hello)), 'unknown-type', 'the device does not send R_HELLO')
    assert.equal(code(() => decodeOuter('house', 'relay', hello)), 'unknown-type', 'not a house-leg type')
    assert.equal(code(() => decodeOuter('device', 'relay', fromHex('0199'))), 'unknown-type')
    assert.equal(code(() => decodeOuter('device', 'relay', fromHex('0204'))), 'bad-version')
    assert.equal(code(() => decodeOuter('device', 'relay', new Uint8Array(0))), 'malformed')
  })

  test('a challenge of 31 or 33 bytes does not decode (27, the house closes without signing)', () => {
    assert.equal(code(() => decodeOuter('house', 'relay', concat(fromHex('0120'), fill(31, 1)))), 'malformed')
    assert.equal(code(() => decodeOuter('house', 'relay', concat(fromHex('0120'), fill(33, 1)))), 'malformed')
  })

  test('caps: MAX_PRE_AUTH before admission, MAX_OUTER after, MAX_INNER inside DATA (32)', () => {
    const big = concat(fromHex('0110'), fill(MAX_PRE_AUTH, 1))
    assert.equal(code(() => decodeOuter('device', 'end', big, { preAuth: true })), 'too-large')
    assert.equal(decodeOuter('device', 'end', big).type, 'DATA')
    assert.equal(code(() => decodeOuter('device', 'end', concat(fromHex('0110'), fill(MAX_INNER + 1, 1)))), 'too-large')
    assert.equal(code(() => decodeOuter('device', 'end', fill(2 * 1024 * 1024, 1), { preAuth: true })), 'too-large', '2 MiB before admission')
    assert.equal(code(() => decodeOuter('device', 'end', fromHex('0110'))), 'malformed', 'empty DATA')
  })

  test('field domains: nT, n of rv, ttl, codes, route kind', () => {
    const auth = encodeOuter(samples.find(s => s.frame.type === 'H_AUTH')!.frame)
    const bad = concat(auth)
    bad[2 + 65 + 179] = 3
    assert.equal(code(() => decodeOuter('house', 'end', bad)), 'malformed', 'nT = 3')
    assert.equal(code(() => decodeOuter('house', 'end', concat(fromHex('0124'), u16(121), u8(1), fill(16, 1)))), 'malformed', 'ttl above PAIR_TTL')
    assert.equal(code(() => decodeOuter('house', 'end', concat(fromHex('0124'), u16(60), u8(0)))), 'malformed', 'no rv')
    assert.equal(code(() => decodeOuter('house', 'end', concat(fromHex('0124'), u16(60), u8(3), fill(48, 1)))), 'malformed', 'three rv')
    assert.equal(code(() => decodeOuter('house', 'relay', fromHex('012301'))), 'malformed', 'R_AUTH_FAIL code is only 0x00')
    assert.equal(code(() => decodeOuter('house', 'relay', fromHex('012603'))), 'malformed')
    assert.equal(code(() => decodeOuter('house', 'relay', fromHex('012800'))), 'malformed')
    assert.equal(code(() => decodeOuter('house', 'relay', concat(fromHex('0130'), u32(1), u8(3), fill(16, 0)))), 'malformed')
    assert.equal(code(() => encodeOuter({ type: 'R_AUTH_FAIL', code: 1 as 0 })), 'malformed')
  })

  test('H_DENY above DENY_MAX is recognised by its size and not materialised (51, E-6)', () => {
    const n = DENY_MAX + 1
    const frame = concat(fromHex('0127'), u16(n), fill(n * 24, 0))
    const f = decodeOuter('house', 'end', frame)
    assert.deepEqual(f, { type: 'H_DENY', entries: [], overflow: true })
    assert.equal(code(() => decodeOuter('house', 'end', concat(fromHex('0127'), u16(2), fill(24, 0)))), 'malformed', 'n does not match the size')
    const full = decodeOuter('house', 'end', concat(fromHex('0127'), u16(DENY_MAX), fill(DENY_MAX * 24, 0)))
    assert.equal(full.type === 'H_DENY' && full.entries.length, DENY_MAX)
    assert.equal(code(() => encodeOuter({ type: 'H_DENY', entries: Array.from({ length: n }, () => ({ ticketId: fill(16, 0), exp: 1 })), overflow: false })), 'too-large')
  })
})

describe('remote inner frames', () => {
  const samples: InnerFrame[] = [
    { type: 'HS1', ver: 1, suite: 1, eD: fill(65, 1), nD: fill(32, 2) },
    { type: 'HS2', eH: fill(65, 3), nH: fill(32, 4), ct2: fill(80, 5) },
    { type: 'HS3', ct3: fill(96, 6) },
    { type: 'P1', ver: 1, suite: 1, rv: fill(16, 7), commit: fill(32, 8) },
    { type: 'P2', eH: fill(65, 9), nH: fill(32, 10), pubH: fill(65, 11) },
    { type: 'P3', eD: fill(65, 12), nD: fill(32, 13), ct3: fill(278, 14) },
    { type: 'P4', ct4: fill(80, 15) },
    { type: 'HS_FAIL' },
    { type: 'REC', ctr: 2 ** 32, sealed: fill(80, 16) },
  ]

  test('every inner frame round-trips with the size of spec 2.3', () => {
    for (const f of samples) {
      const bytes = encodeInner(f)
      assert.deepEqual(decodeInner(bytes), f, f.type)
      assert.equal(innerTypeOf(bytes), f.type)
      if (f.type !== 'REC' && f.type !== 'P3') assert.equal(bytes.length, INNER_SIZE[f.type], f.type)
    }
    assert.equal(encodeInner(samples[5]!).length, 378, 'P3 at its cap')
    assert.equal(innerTypeOf(new Uint8Array(0)), undefined)
    assert.equal(innerTypeOf(fromHex('99')), undefined)
  })

  test('a handshake frame one byte short or one byte long closes (9)', () => {
    for (const f of samples) {
      if (f.type === 'REC') continue
      const bytes = encodeInner(f)
      assert.notEqual(code(() => decodeInner(concat(bytes, u8(0)))), 'no-error', `${f.type} + 1`)
      assert.notEqual(code(() => decodeInner(bytes.subarray(0, bytes.length - 1))), 'no-error', `${f.type} - 1`)
    }
  })

  test('P3: ct3 outside 214..278, a length prefix that lies, or a frame above 378 closes', () => {
    const head = concat(u8(0x13), fill(65, 1), fill(32, 2))
    assert.equal(code(() => decodeInner(concat(head, lp16(fill(213, 0))))), 'malformed')
    assert.equal(code(() => decodeInner(concat(head, lp16(fill(279, 0))))), 'too-large')
    assert.equal(code(() => decodeInner(concat(head, u16(260), fill(250, 0)))), 'malformed')
    assert.equal(decodeInner(concat(head, lp16(fill(214, 0)))).type, 'P3')
  })

  test('unknown inner type, a record below its minimum and a frame above MAX_INNER close', () => {
    assert.equal(code(() => decodeInner(fromHex('0500'))), 'unknown-type')
    assert.equal(code(() => decodeInner(concat(u8(0x20), fill(28, 0)))), 'malformed')
    assert.equal(code(() => decodeInner(concat(u8(0x20), fill(MAX_INNER, 0)))), 'too-large')
    assert.equal(decodeInner(concat(u8(0x20), fill(MAX_INNER - 1, 0))).type, 'REC')
  })
})

describe('remote record plaintext and contents', () => {
  test('V-6 shape: the padding ladder is 64, 128, 256, 512, 1024, then multiples of 1024', () => {
    const cases: [number, number][] = [
      [0, 64], [59, 64], [60, 128], [123, 128], [124, 256], [251, 256], [252, 512], [507, 512], [508, 1024],
      [1019, 1024], [1020, 2048], [2043, 2048], [2044, 3072],
    ]
    for (const [clen, size] of cases) {
      const pt = padPlaintext('REQ', fill(clen, 0xaa))
      assert.equal(pt.length, size, `content of ${clen}`)
      assert.equal(paddedSize(5 + clen), size)
      const back = unpadPlaintext(pt)
      assert.equal(back.ctype, 'REQ')
      assert.equal(back.content.length, clen)
    }
    const largest = padPlaintext('BIN', fill(MAX_RECORD_CONTENT, 1)).length
    assert.equal(largest, 261_120)
    assert.ok(largest + 25 <= MAX_INNER && largest + 1024 + 25 > MAX_INNER, 'the largest record fits MAX_INNER and the next step does not')
    assert.equal(code(() => padPlaintext('BIN', fill(MAX_RECORD_CONTENT + 1, 1))), 'too-large')
  })

  test('non-zero padding, clen above the plaintext and an unknown content type close (9)', () => {
    const pt = padPlaintext('PING', encodePing(3))
    const dirty = concat(pt)
    dirty[pt.length - 1] = 1
    assert.equal(code(() => unpadPlaintext(dirty)), 'malformed')
    const lying = concat(pt)
    lying.set(u32(pt.length), 1)
    assert.equal(code(() => unpadPlaintext(lying)), 'malformed')
    const unknown = concat(pt)
    unknown[0] = 0x7f
    assert.equal(code(() => unpadPlaintext(unknown)), 'unknown-type')
    assert.equal(code(() => unpadPlaintext(fromHex('04000000'))), 'malformed', 'shorter than the header')
  })

  test('control contents round-trip and refuse a byte left over', () => {
    const done = { houseMaxVer: 1, now: 1_795_000_000, presence: 1 as const, elevUntil: 0 }
    assert.equal(encodeHsDone(done).length, 18)
    assert.deepEqual(decodeHsDone(encodeHsDone(done)), done)
    assert.equal(code(() => decodeHsDone(concat(encodeHsDone(done), u8(0)))), 'malformed')
    const badPresence = encodeHsDone(done)
    badPresence[9] = 3
    assert.equal(code(() => decodeHsDone(badPresence)), 'malformed')

    const pd = { houseMaxVer: 1, now: 5, houseConfirm: fill(32, 1), deviceId: fill(16, 2), admitTicket: fill(200, 3), houseName: 'Casa do Guga' }
    assert.deepEqual(decodePairDone(encodePairDone(pd)), pd)
    assert.equal(code(() => decodePairDone(concat(encodePairDone(pd), u8(0)))), 'malformed')

    assert.deepEqual(decodePing(encodePing(9)), { recvNext: 9 })
    assert.deepEqual(decodePong(encodePong(4, 9)), { pingCtr: 4, recvNext: 9 })
    assert.equal(code(() => decodePing(fill(9, 0))), 'malformed')
    assert.deepEqual(decodeClose(encodeClose(4)), { code: 4 })
    assert.equal(code(() => decodeClose(u8(0))), 'malformed')
    assert.equal(code(() => decodeClose(u8(8))), 'malformed')
    assert.equal(CTYPE.BIN, 0x13)
  })

  test('REQ carries the op outside the JSON, with optional actId and uvProof; reserved flags close', () => {
    const body = utf8('{"a":1}')
    const plain = { reqId: 7, op: 0x0100, body }
    assert.deepEqual(decodeReq(encodeReq(plain)), plain)
    assert.equal(toHex(encodeReq(plain).subarray(0, 7)), '00000007010000')
    const full = {
      reqId: 8, op: 0x0601, actId: fill(16, 9), body,
      uvProof: { uvCtr: 3, authenticatorData: fill(37, 1), clientDataJSON: utf8('{}'), signature: fill(70, 2) },
    }
    assert.deepEqual(decodeReq(encodeReq(full)), full)
    const reserved = encodeReq(plain)
    reserved[6] = 0x04
    assert.equal(code(() => decodeReq(reserved)), 'malformed')
    const truncated = encodeReq({ reqId: 1, op: 2, actId: fill(16, 1), body: new Uint8Array(0) })
    assert.equal(code(() => decodeReq(truncated.subarray(0, 20))), 'malformed')
    assert.deepEqual(decodeRes(encodeRes({ reqId: 7, status: 5, body })), { reqId: 7, status: 5, body })
    assert.equal(code(() => decodeRes(fromHex('000000070a'))), 'malformed')
    assert.deepEqual(decodeEvt(encodeEvt({ evt: 0x0100, body })), { evt: 0x0100, body })
    assert.deepEqual(decodeBin(encodeBin({ stream: 3, data: fill(5, 1) })), { stream: 3, data: fill(5, 1) })
  })

  test('the JSON body is strict UTF-8 with an object at the root', () => {
    assert.deepEqual(parseJsonObject(utf8('{"a":[1]}')), { a: [1] })
    assert.equal(code(() => parseJsonObject(utf8('[1]'))), 'malformed')
    assert.equal(code(() => parseJsonObject(utf8('null'))), 'malformed')
    assert.equal(code(() => parseJsonObject(utf8('{'))), 'malformed')
    assert.equal(code(() => parseJsonObject(fromHex('7b22ff227d'))), 'malformed')
    assert.equal(code(() => parseJsonObject(new Uint8Array(0))), 'malformed')
  })

  test('DeviceHello: name up to 64 bytes of valid UTF-8, reserved caps bits zero (64)', () => {
    const h = { pubD: fill(65, 4), pubA: fill(65, 5), caps: 3, name: 'Celular da sala' }
    assert.deepEqual(decodeDeviceHello(encodeDeviceHello(h)), h)
    assert.equal(encodeDeviceHello({ ...h, name: '' }).length, 132)
    assert.equal(encodeDeviceHello({ ...h, name: 'a'.repeat(64) }).length, 196)
    assert.equal(code(() => encodeDeviceHello({ ...h, name: 'a'.repeat(65) })), 'too-large')
    assert.equal(code(() => decodeDeviceHello(concat(fill(130, 4), u8(0), lp8(fill(65, 0x61))))), 'too-large', 'a name of 65 bytes is refused')
    assert.equal(code(() => decodeDeviceHello(concat(fill(130, 4), u8(4), lp8(ascii('x'))))), 'malformed', 'reserved caps bit')
    assert.equal(code(() => decodeDeviceHello(concat(fill(130, 4), u8(0), lp8(fromHex('ff'))))), 'malformed', 'invalid UTF-8')
    assert.equal(code(() => decodeDeviceHello(concat(encodeDeviceHello(h), u8(0)))), 'malformed')
  })

  test('the declared name is shown without overrides, controls or invisible characters (64, B-3)', () => {
    assert.equal(sanitizeDeclaredName('Guga‮gnp.exe'), 'Gugagnp.exe')
    assert.equal(sanitizeDeclaredName('a\u0000b\u001bc​d⁦e'), 'abcde')
    assert.equal(sanitizeDeclaredName('  TV   da\tsala \n'), 'TV da sala')
    assert.equal(sanitizeDeclaredName('‮‏'), '')
  })

  test('V-10 shape: the typed code is R then S, 12 digits, spaces and hyphens dropped', () => {
    const c = parseTypedCode('123 456-789 012')
    assert.equal(toHex(c.R), toHex(ascii('123456')))
    assert.equal(toHex(c.S), toHex(ascii('789012')))
    assert.equal(formatTypedCode(c.R, c.S), '123 456 789 012')
    for (const bad of ['12345678901', '1234567890123', '12345678901a', '１２３４５６７８９０１２', '123\t456789012', ''])
      assert.equal(code(() => parseTypedCode(bad)), 'malformed', JSON.stringify(bad))
  })

  test('V-10 shape: the QR blob travels in the fragment and refuses a hostile relay host', () => {
    const q = { maxVer: 1, relayHost: 'relay.example:443', houseId: fill(32, 1), R: fill(16, 2), S: fill(16, 3) }
    assert.equal(encodeQrBlob(q).length, 1 + 1 + 1 + 17 + 32 + 16 + 16)
    assert.deepEqual(decodeQrBlob(encodeQrBlob(q)), q)
    assert.deepEqual(parseQrFragment(qrFragment(q)), q)
    assert.ok(qrFragment(q).startsWith('#pair='))
    assert.equal(code(() => parseQrFragment('?pair=AAAA')), 'malformed', 'never in the query')
    assert.equal(code(() => encodeQrBlob({ ...q, relayHost: 'Relay.example' })), 'malformed')
    const wrongVer = encodeQrBlob(q)
    wrongVer[0] = 2
    assert.equal(code(() => decodeQrBlob(wrongVer)), 'bad-version')
    assert.equal(code(() => decodeQrBlob(concat(encodeQrBlob(q), u8(0)))), 'malformed')
    const upper = encodeQrBlob(q)
    upper[3] = 0x52
    assert.equal(code(() => decodeQrBlob(upper)), 'malformed')
  })
})
