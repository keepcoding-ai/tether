// Remote wire, the parts of spec 6 and 7 that are wire structure: the registry of operations, the deduplication of
// acts, the presence challenges and the strict DER-to-P1363 conversion. Also the purity of the module: no node:*,
// no Buffer, no DOM, and nothing of the test seam on the public surface.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { concat, fromHex, randomBytes, toHex, u16, u32, u8, utf8, WireError, type Bytes } from '../../src/remote/bytes.ts'
import { ACT_CACHE_MAX, ACT_CACHE_TTL_MS, LBL } from '../../src/remote/constants.ts'
import { generateRoleKey, sha256, verifyLabeled } from '../../src/remote/crypto.ts'
import * as remote from '../../src/remote/index.ts'
import { ActCache, opByCode, opByName, OPS } from '../../src/remote/ops.ts'
import { actDigest, derToP1363, elevateDigest, unlockDigest, UV_PURPOSE, uvChallenge, uvRegChallenge } from '../../src/remote/presence.ts'

const REMOTE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'remote')
const code = (fn: () => unknown): string => {
  try { fn() } catch (e) { return e instanceof WireError ? e.code : `other:${String(e)}` }
  return 'no-error'
}

describe('remote operations registry', () => {
  test('the lines fixed in v1: code, scope, presence, gesture and whether they change state', () => {
    const table = OPS.map(l => [l.code, l.name, l.scope, l.presence, l.gesture, l.mutates])
    assert.deepEqual(table, [
      [0x0001, 'session.info', 'session', 'none', false, false],
      [0x0002, 'admit.renew', 'session', 'none', false, true],
      [0x0003, 'uv.challenge', 'session', 'none', false, false],
      [0x0004, 'uv.assert', 'session', 'none', true, true],
      [0x0005, 'uv.register', 'session', 'fresh-pair', true, true],
      [0x0006, 'device.revoke-self', 'session', 'none', true, true],
      [0x0007, 'session.lock', 'session', 'none', true, true],
      [0x0008, 'house.key-rotate.ack', 'session', 'unlocked', false, true],
      [0x0009, 'session.visible', 'session', 'none', false, false],
      [0x0100, 'attention.list', 'attention', 'unlocked', false, false],
      [0x0101, 'attention.watch', 'attention', 'unlocked', false, false],
      [0x0102, 'attention.push-key', 'attention', 'unlocked', false, false],
      [0x0103, 'attention.push-on', 'attention', 'unlocked', true, true],
      [0x0104, 'attention.push-off', 'attention', 'unlocked', true, true],
      [0x0200, 'channels.marks', 'channels', 'unlocked', false, false],
      [0x0201, 'channels.page', 'channels', 'unlocked', false, false],
      [0x0202, 'channels.say', 'channels', 'unlocked', true, true],
      [0x0203, 'channels.react', 'channels', 'unlocked', true, true],
      [0x0204, 'channels.vote', 'channels', 'unlocked', true, true],
      [0x0205, 'channels.poll', 'channels', 'unlocked', true, true],
      [0x0206, 'channels.seen', 'channels', 'unlocked', false, true],
      [0x0207, 'channels.file', 'channels', 'unlocked', false, false],
      [0x0208, 'channels.upload', 'channels', 'unlocked', false, true],
      [0x0209, 'channels.upload-cancel', 'channels', 'unlocked', true, true],
      [0x020a, 'channels.create', 'channels', 'unlocked', true, true],
      [0x020b, 'channels.join', 'channels', 'unlocked', true, true],
      [0x020c, 'channels.remove', 'channels', 'unlocked', true, true],
      [0x020d, 'channels.mute', 'channels', 'unlocked', true, true],
      [0x020e, 'channels.unmute', 'channels', 'unlocked', true, true],
      [0x020f, 'channels.close', 'manage:destructive', 'per-act', true, true],
      [0x0210, 'channels.reopen', 'channels', 'unlocked', true, true],
      [0x0211, 'channels.poll-close', 'channels', 'unlocked', true, true],
      [0x0300, 'regency.tree', 'regency:read', 'unlocked', false, false],
      [0x0400, 'agents.stop', 'manage:agents', 'unlocked', true, true],
      [0x0401, 'agents.start', 'manage:agents', 'unlocked', true, true],
      [0x0402, 'agents.restart', 'manage:agents', 'unlocked', true, true],
      [0x0403, 'agents.rename', 'manage:agents', 'unlocked', true, true],
      [0x0404, 'agents.forget', 'manage:destructive', 'per-act', true, true],
      [0x0410, 'ronda.get', 'manage:agents', 'unlocked', false, false],
      [0x0411, 'ronda.set', 'manage:agents', 'unlocked', true, true],
      [0x0412, 'ronda.off', 'manage:agents', 'unlocked', true, true],
      [0x0420, 'procs.list', 'manage:procs', 'unlocked', false, false],
      [0x0421, 'procs.info', 'manage:procs', 'unlocked', false, false],
      [0x0422, 'procs.start', 'manage:procs', 'unlocked', true, true],
      [0x0423, 'procs.stop', 'manage:procs', 'unlocked', true, true],
      [0x0424, 'procs.stop-force', 'manage:procs', 'unlocked', true, true],
      [0x0425, 'procs.restart', 'manage:procs', 'unlocked', true, true],
      [0x0426, 'procs.restart-force', 'manage:procs', 'unlocked', true, true],
      [0x0427, 'procs.use', 'manage:procs', 'unlocked', true, true],
      [0x0428, 'procs.release', 'manage:procs', 'unlocked', true, true],
      [0x0429, 'procs.forget', 'manage:destructive', 'per-act', true, true],
      [0x042a, 'procs.forget-force', 'manage:destructive', 'per-act', true, true],
      [0x0430, 'desks.hibernate', 'manage:desks', 'unlocked', true, true],
      [0x0431, 'desks.wake', 'manage:desks', 'unlocked', true, true],
      [0x0432, 'desks.create', 'manage:desks', 'unlocked', true, true],
      [0x0433, 'desks.rename', 'manage:desks', 'unlocked', true, true],
      [0x0434, 'desks.color', 'manage:desks', 'unlocked', true, true],
      [0x0435, 'desks.close', 'manage:destructive', 'per-act', true, true],
      [0x0440, 'panes.hibernate', 'manage:desks', 'unlocked', true, true],
      [0x0441, 'panes.wake', 'manage:desks', 'unlocked', true, true],
      [0x0442, 'panes.suspend', 'manage:desks', 'unlocked', true, true],
      [0x0443, 'panes.move', 'manage:desks', 'unlocked', true, true],
      [0x0444, 'panes.close', 'manage:destructive', 'per-act', true, true],
      [0x0448, 'closed.reopen', 'manage:desks', 'unlocked', true, true],
      [0x0449, 'closed.forget', 'manage:destructive', 'per-act', true, true],
      [0x0450, 'owners.give', 'manage:agents', 'window', true, true],
      [0x0451, 'owners.revoke', 'manage:agents', 'unlocked', true, true],
      [0x0452, 'owners.take', 'manage:agents', 'unlocked', true, true],
      [0x0453, 'owners.return', 'manage:agents', 'window', true, true],
      [0x0600, 'device.list', 'manage:destructive', 'unlocked', false, false],
      [0x0601, 'device.revoke', 'manage:destructive', 'per-act', true, true],
    ])
  })

  test('39: an op without a line has no entry; codes and names are unique; every line is 16 bits and inside its range', () => {
    assert.equal(opByCode(0x000a), undefined)
    assert.equal(opByCode(0x02ff), undefined)
    assert.equal(opByCode(0x0601)?.name, 'device.revoke')
    assert.equal(opByName('attention.watch')?.code, 0x0101)
    assert.equal(opByName('ext-request'), undefined, 'there is no tunnel operation')
    assert.equal(new Set(OPS.map(l => l.code)).size, OPS.length)
    assert.equal(new Set(OPS.map(l => l.name)).size, OPS.length)
    for (const l of OPS) {
      assert.ok(Number.isInteger(l.code) && l.code > 0 && l.code <= 0xffff, l.name)
      const family = l.code >>> 8
      if (family === 4) assert.ok(l.scope.startsWith('manage:'), l.name)
      // Closing a channel from afar destroys (RR5, fio-spec 18): the channels' range reuses manage:destructive for it alone.
      else if (l.name === 'channels.close') assert.deepEqual([l.scope, l.presence], ['manage:destructive', 'per-act'])
      else assert.equal(l.scope, family === 0 ? 'session' : family === 1 ? 'attention' : family === 2 ? 'channels' : family === 3 ? 'regency:read' : 'manage:destructive', l.name)
      // What destroys is manage:destructive with a proof per act, and only it (RR5 5.2).
      if (family === 4) assert.equal(l.presence === 'per-act', l.scope === 'manage:destructive', l.name)
      assert.ok(l.scope.length > 0, 'a line always declares its scope')
    }
  })

  test('only lines triggered by the person are gestures; the one exception to E-8 is declared on its line', () => {
    assert.deepEqual(OPS.filter(l => l.gesture).map(l => l.name), [
      'uv.assert', 'uv.register', 'device.revoke-self', 'session.lock', 'attention.push-on', 'attention.push-off', 'channels.say', 'channels.react', 'channels.vote', 'channels.poll', 'channels.upload-cancel',
      'channels.create', 'channels.join', 'channels.remove', 'channels.mute', 'channels.unmute', 'channels.close', 'channels.reopen', 'channels.poll-close',
      'agents.stop', 'agents.start', 'agents.restart', 'agents.rename', 'agents.forget', 'ronda.set', 'ronda.off',
      'procs.start', 'procs.stop', 'procs.stop-force', 'procs.restart', 'procs.restart-force', 'procs.use', 'procs.release', 'procs.forget', 'procs.forget-force',
      'desks.hibernate', 'desks.wake', 'desks.create', 'desks.rename', 'desks.color', 'desks.close',
      'panes.hibernate', 'panes.wake', 'panes.suspend', 'panes.move', 'panes.close', 'closed.reopen', 'closed.forget',
      'owners.give', 'owners.revoke', 'owners.take', 'owners.return',
      'device.revoke',
    ])
    assert.deepEqual(OPS.filter(l => l.allowedWithoutCredential).map(l => l.name), ['house.key-rotate.ack'])
    for (const l of OPS) if (l.gesture) assert.equal(l.mutates, true, `${l.name}: a gesture changes state`)
  })
})

describe('remote act deduplication', () => {
  test('44: the same actId twice is one act with the same answer', () => {
    const cache = new ActCache<{ status: number; body: string }>()
    const actId = randomBytes(16)
    let executed = 0
    const handle = (now: number): { status: number; body: string } => {
      const before = cache.get(actId, now)
      if (before) return before
      executed++
      const response = { status: 0, body: `done #${executed}` }
      cache.put(actId, response, now)
      return response
    }
    const first = handle(1000)
    const again = handle(2000)
    assert.equal(executed, 1)
    assert.equal(again, first, 'the very same answer')
    cache.put(actId, { status: 9, body: 'other' }, 3000)
    assert.equal(cache.get(actId, 3000), first, 'the first answer of an actId is the one that stays')
    assert.equal(cache.get(randomBytes(16), 3000), undefined)
    assert.equal(code(() => cache.get(randomBytes(15), 0)), 'malformed')
  })

  test('an act is remembered for 15 minutes and the cache holds at most 1024', () => {
    const cache = new ActCache<number>()
    const a = randomBytes(16)
    cache.put(a, 1, 0)
    assert.equal(cache.get(a, ACT_CACHE_TTL_MS - 1), 1)
    assert.equal(cache.get(a, ACT_CACHE_TTL_MS), undefined)
    assert.equal(cache.size, 0)
    const ids = Array.from({ length: ACT_CACHE_MAX + 10 }, () => randomBytes(16))
    ids.forEach((id, i) => cache.put(id, i, 1000 + i))
    assert.equal(cache.size, ACT_CACHE_MAX, 'memory is flat')
    assert.equal(cache.get(ids[0]!, 3000), undefined, 'the oldest gave way')
    assert.equal(cache.get(ids[10]!, 3000), 10)
    assert.equal(cache.get(ids[ids.length - 1]!, 3000), ACT_CACHE_MAX + 9)
  })

  test('with sizeOf, the answers kept stay under their byte ceiling: the oldest go first, the newest always stays', () => {
    const cache = new ActCache<string>({ sizeOf: (s) => s.length, maxBytes: 100 })
    const ids = Array.from({ length: 10 }, () => randomBytes(16))
    ids.forEach((id, i) => cache.put(id, 'x'.repeat(30), i))
    assert.equal(cache.size, 3)
    assert.equal(cache.bytes, 90)
    assert.equal(cache.get(ids[6]!, 10), undefined)
    assert.equal(cache.get(ids[9]!, 10), 'x'.repeat(30))
    cache.put(randomBytes(16), 'y'.repeat(500), 11)
    assert.deepEqual([cache.size, cache.bytes], [1, 500], 'one answer over the ceiling is kept alone')
    assert.equal(cache.get(ids[9]!, ACT_CACHE_TTL_MS + 20), undefined)
    assert.deepEqual([cache.size, cache.bytes], [0, 0], 'expiry gives the bytes back')
  })
})

describe('remote presence challenges', () => {
  test('V-9 shape: the challenge binds session, counter, purpose and digest; each purpose has its own digest', async () => {
    const sessionId = randomBytes(16)
    const deviceId = randomBytes(16)
    const actId = randomBytes(16)
    const body = utf8('{"deviceId":"abc"}')
    assert.equal(toHex(unlockDigest()), '00'.repeat(32))
    assert.equal(toHex(await elevateDigest(deviceId)), toHex(await sha256(LBL('uv-window'), deviceId, u16(900))))
    assert.equal(toHex(await actDigest(0x0601, actId, body)), toHex(await sha256(LBL('act'), u16(0x0601), actId, await sha256(body))))
    const chal = await uvChallenge(sessionId, 7, UV_PURPOSE.unlock, unlockDigest())
    assert.equal(toHex(chal), toHex(await sha256(LBL('uv'), sessionId, u32(7), u8(1), new Uint8Array(32))))
    assert.equal(chal.length, 32)
    const pubD = (await generateRoleKey('device')).pub
    assert.equal(toHex(await uvRegChallenge(sessionId, pubD)), toHex(await sha256(LBL('uv-reg'), sessionId, pubD)))
  })

  test('41 (wire part): a challenge of another session, counter, purpose, op, actId or body is a different challenge', async () => {
    const sessionId = randomBytes(16)
    const actId = randomBytes(16)
    const body = utf8('{"deviceId":"abc"}')
    const base = toHex(await uvChallenge(sessionId, 1, UV_PURPOSE.act, await actDigest(0x0601, actId, body)))
    const others = [
      await uvChallenge(randomBytes(16), 1, UV_PURPOSE.act, await actDigest(0x0601, actId, body)),
      await uvChallenge(sessionId, 2, UV_PURPOSE.act, await actDigest(0x0601, actId, body)),
      await uvChallenge(sessionId, 1, UV_PURPOSE.elevate, await actDigest(0x0601, actId, body)),
      await uvChallenge(sessionId, 1, UV_PURPOSE.act, await actDigest(0x0600, actId, body)),
      await uvChallenge(sessionId, 1, UV_PURPOSE.act, await actDigest(0x0601, randomBytes(16), body)),
      await uvChallenge(sessionId, 1, UV_PURPOSE.act, await actDigest(0x0601, actId, utf8('{"deviceId":"abd"}'))),
    ]
    for (const o of others) assert.notEqual(toHex(o), base)
    assert.equal(code(() => { void uvChallenge(sessionId, 1, 4 as 1, new Uint8Array(32)) }), 'malformed')
    assert.equal(code(() => { void uvChallenge(randomBytes(15), 1, 1, new Uint8Array(32)) }), 'malformed')
  })
})

describe('remote strict DER signature (E-13)', () => {
  const int = (hex: string): Bytes => { const b = fromHex(hex); return concat(u8(0x02), u8(b.length), b) }
  const seq = (...parts: Bytes[]): Bytes => { const c = concat(...parts); return concat(u8(0x30), u8(c.length), c) }
  const ONE = '01'
  const N_MINUS_1 = 'ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632550'
  const N = 'ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551'

  /** P1363 to minimal DER, as an authenticator emits it. */
  const toDer = (sig: Uint8Array): Bytes => {
    const scalar = (x: Uint8Array): Bytes => {
      let i = 0
      while (i < 31 && x[i] === 0) i++
      const mag = x.subarray(i)
      return mag[0]! & 0x80 ? concat(u8(0x02), u8(mag.length + 1), u8(0), mag) : concat(u8(0x02), u8(mag.length), mag)
    }
    return seq(scalar(sig.subarray(0, 32)), scalar(sig.subarray(32)))
  }

  test('a real signature converted to DER comes back as the same 64 bytes, and verifies', async () => {
    const { key } = await generateRoleKey('house')
    for (let i = 0; i < 64; i++) {
      const th = randomBytes(32)
      const sig = await key.sign('house-hs', th)
      const back = derToP1363(toDer(sig))
      assert.equal(toHex(back), toHex(sig))
      assert.equal(await verifyLabeled(key.pub, 'house-hs', th, back), true)
    }
    assert.equal(toHex(derToP1363(seq(int(ONE), int('00' + N_MINUS_1)))), '00'.repeat(31) + '01' + N_MINUS_1, 'the edges of the range')
  })

  test('58: non-minimal DER, a byte left over, s = 0, a scalar at or above n, a negative or oversized INTEGER: refused', () => {
    const r = '00' + N_MINUS_1
    const bad: [string, Bytes][] = [
      ['s = 0', seq(int(ONE), int('00'))],
      ['r = 0', seq(int('00'), int(ONE))],
      ['empty INTEGER', seq(concat(u8(0x02), u8(0)), int(ONE))],
      ['r = n', seq(int('00' + N), int(ONE))],
      ['s = n', seq(int(ONE), int('00' + N))],
      ['s above n', seq(int(ONE), int('00' + 'ff'.repeat(32)))],
      ['a needless leading zero', seq(int('0001'), int(ONE))],
      ['two leading zeros', seq(int('0000' + N_MINUS_1), int(ONE))],
      ['negative (high bit without the zero)', seq(int(N_MINUS_1), int(ONE))],
      ['a byte left over after the SEQUENCE', concat(seq(int(r), int(ONE)), u8(0))],
      ['a byte left over inside the SEQUENCE', seq(int(r), int(ONE), u8(0))],
      ['three INTEGERs', seq(int(ONE), int(ONE), int(ONE))],
      ['one INTEGER', seq(int(ONE))],
      ['long-form length', concat(u8(0x30), u8(0x81), u8(6), int(ONE), int(ONE))],
      ['SEQUENCE length that lies', concat(u8(0x30), u8(7), int(ONE), int(ONE))],
      ['wrong outer tag', concat(u8(0x31), u8(6), int(ONE), int(ONE))],
      ['wrong inner tag', seq(concat(u8(0x03), u8(1), u8(1)), int(ONE))],
      ['INTEGER of 34 bytes', seq(int('0000' + 'ff'.repeat(32)), int(ONE))],
      ['truncated', seq(int(r), int(ONE)).subarray(0, 20)],
      ['empty', new Uint8Array(0)],
      ['P1363 passed as DER', new Uint8Array(64).fill(0x30)],
    ]
    for (const [name, der] of bad) assert.notEqual(code(() => derToP1363(der)), 'no-error', name)
  })
})

describe('remote module purity', () => {
  const sources = readdirSync(REMOTE_DIR).filter(f => f.endsWith('.ts'))

  test('no file of src/remote imports node:*, touches Buffer, process or the DOM, or awaits at the top level', () => {
    assert.ok(sources.includes('index.ts') && sources.length >= 14)
    for (const file of sources) {
      const src = readFileSync(join(REMOTE_DIR, file), 'utf8')
      const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map(m => m[1]!)
      for (const spec of imports) assert.match(spec, /^\.\/[a-z-]+\.ts$/, `${file} imports ${spec}`)
      assert.equal(/\bimport\s*\(/.test(src), false, `${file}: dynamic import`)
      const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
      for (const banned of [/\bBuffer\b/, /\bprocess\./, /\brequire\s*\(/, /\bdocument\./, /\bwindow\./, /\bnavigator\./, /\blocalStorage\b/, /\bindexedDB\b/, /\bsetTimeout\b/, /\bsetInterval\b/, /\bDate\.now\b/, /\bnew Date\b/, /\bWebSocket\b/, /\bfetch\s*\(/])
        assert.equal(banned.test(codeOnly), false, `${file} uses ${banned}`)
      assert.equal(/^await\s/m.test(codeOnly), false, `${file}: top-level await`)
    }
  })

  test('the public surface carries the machines and none of the test seam', () => {
    const names = Object.keys(remote)
    for (const expected of ['DeviceHandshake', 'HouseHandshake', 'DevicePairing', 'HousePairing', 'relayUrlAllowed', 'encodeOuter', 'decodeOuter',
      'verifyHouseAuth', 'verifyDeviceAdmit', 'buildHouseAuth', 'buildDeviceAdmit', 'DenyList', 'issueKeyCert', 'issueAdmitTicket',
      'selfTest', 'generateRoleKey', 'OPS', 'ActCache', 'derToP1363', 'verifyKeyRotate', 'houseKeysDistinct', 'WIRE_VERSION'])
      assert.ok(names.includes(expected), `${expected} is exported`)
    for (const hidden of ['systemEntropy', 'fixedEntropy', 'fixedSigner', 'generateVectors', 'checkVectors', 'Secret', 'OneShotKey', 'hkdf', 'ecdhBits',
      'sealRecordAt', 'RecordChannel', 'Session', 'ownerOf'])
      assert.equal(names.includes(hidden), false, `${hidden} must not be public`)
    const index = readFileSync(join(REMOTE_DIR, 'index.ts'), 'utf8')
    assert.equal(/from\s+'\.\/testing\.ts'/.test(index), false)
    for (const file of sources) {
      if (file === 'testing.ts') continue
      assert.equal(readFileSync(join(REMOTE_DIR, file), 'utf8').includes("'./testing.ts'"), false, `${file} imports the test seam`)
    }
  })
})
