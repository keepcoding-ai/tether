// Remote wire, the fixed vectors of spec 9.1 (V-1 to V-11). The file test/unit/remote.vectors.json was produced by
// this implementation and is checked here against it on every run; the checker (src/remote/testing.ts) is pure, so a
// browser harness can run the same file against the same module. REMOTE_VECTORS_UPDATE=1 regenerates the file with
// new test keys: do that only when the wire changes on purpose, and review the diff.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fromHex, toHex, WireError } from '../../src/remote/bytes.ts'
import { generateEphemeral, generateRoleKey } from '../../src/remote/crypto.ts'
import {
  checkVectors, fixedEntropy, fixedSigner, generateTestKey, generateVectors, recordingSigner, testEphemeral, type SigLog,
  type Vectors,
} from '../../src/remote/testing.ts'

const FILE = join(dirname(fileURLToPath(import.meta.url)), 'remote.vectors.json')
const rejects = async (p: Promise<unknown>): Promise<string> => {
  try { await p } catch (e) { return e instanceof WireError ? e.code : `other:${String(e)}` }
  return 'no-error'
}

describe('remote fixed vectors', () => {
  test('the recorded vector file verifies against this module (V-1 to V-11)', async () => {
    if (process.env.REMOTE_VECTORS_UPDATE === '1') writeFileSync(FILE, JSON.stringify(await generateVectors(), null, 1) + '\n')
    assert.ok(existsSync(FILE), 'test/unit/remote.vectors.json is missing: generate it with REMOTE_VECTORS_UPDATE=1')
    const vectors = JSON.parse(readFileSync(FILE, 'utf8')) as Vectors
    const results = await checkVectors(vectors)
    const failed = results.filter(r => !r.ok)
    assert.deepEqual(failed, [], `${failed.length} vector checks failed`)
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) assert.ok(results.some(r => r.name.startsWith(`V-${n} `)), `V-${n} was checked`)
    assert.ok(results.length >= 30)
    // The shape a reader of the file relies on.
    assert.equal(vectors.v4_session.computed.th.length, 6, 'TH0 to TH5')
    assert.deepEqual(vectors.v5_pairing.map(p => p.computed.th.length), [7, 7], 'TH0 to TH6')
    assert.deepEqual(vectors.v5_pairing.map(p => p.inputs.access), ['code', 'qr'])
    assert.match(vectors.v5_pairing[1]!.computed.sas, /^0[0-9]{5}$/, 'one SAS with a leading zero')
    assert.deepEqual([vectors.v4_session.frames.hs1.length, vectors.v4_session.frames.hs2.length, vectors.v4_session.frames.hs3.length], [200, 356, 194])
    assert.equal(vectors.v5_pairing[0]!.computed.S.length, 12, 'typed code: S is the six ASCII digits')
    assert.equal(vectors.v5_pairing[1]!.computed.S.length, 32, 'QR: S is 16 bytes')
  })

  test('a vector file that was tampered with does not verify', async () => {
    const vectors = JSON.parse(readFileSync(FILE, 'utf8')) as Vectors
    const flip = (hex: string): string => { const b = fromHex(hex); b[b.length - 1] = b[b.length - 1]! ^ 1; return toHex(b) }
    const cases: [string, (v: Vectors) => void][] = [
      ['a nonce of the session', v => { v.v4_session.inputs.nD = flip(v.v4_session.inputs.nD) }],
      ['a recorded signature', v => { const k = Object.keys(v.v4_session.inputs.sigs)[0]!; v.v4_session.inputs.sigs[k] = flip(v.v4_session.inputs.sigs[k]!) }],
      ['a session key', v => { v.v4_session.computed.kD2h = flip(v.v4_session.computed.kD2h) }],
      ['the SAS', v => { v.v5_pairing[0]!.computed.sas = '999999' }],
      ['a label', v => { v.v1_labels.th = flip(v.v1_labels.th!) }],
      ['a record', v => { v.v6_record.cases[2]!.frame = flip(v.v6_record.cases[2]!.frame) }],
      ['the ticket', v => { v.v7_admission.ticket = flip(v.v7_admission.ticket) }],
      ['the acceptance of the new house key', v => { v.v8_rotate.sigNew = flip(v.v8_rotate.sigNew) }],
      ['a point marked as accepted', v => { v.v11_points[1]!.accepted = true }],
    ]
    for (const [name, tamper] of cases) {
      const copy = structuredClone(vectors)
      tamper(copy)
      assert.ok((await checkVectors(copy)).some(r => !r.ok), name)
    }
  })

  test('the seam: fixed entropy hands out exactly what was queued, and a fixed signer holds no key', async () => {
    const eph = await generateEphemeral()
    const e = fixedEntropy({ randoms: [new Uint8Array(32).fill(1), new Uint8Array(16).fill(2)], ephemerals: [eph] })
    assert.equal(toHex(e.random(32)), '01'.repeat(32))
    assert.equal(await rejects(Promise.resolve().then(() => e.random(32))), 'bad-state', 'the next one queued has 16 bytes')
    assert.equal((await e.ephemeral()).pub, eph.pub)
    assert.equal(await rejects(e.ephemeral()), 'bad-state')

    const k = await generateTestKey()
    const log: SigLog = {}
    const real = await recordingSigner('house', k, log)
    const th = new Uint8Array(32).fill(7)
    const sig = await real.sign('house-hs', th)
    const replay = fixedSigner('house', k.pub, log)
    assert.equal(toHex(await replay.sign('house-hs', th)), toHex(sig))
    assert.equal(await rejects(replay.sign('house-hs', new Uint8Array(32).fill(8))), 'auth', 'it cannot sign anything that was not recorded')
    assert.equal(await rejects(replay.sign('relay-auth', th)), 'bad-label', 'and it keeps the role rule')
    assert.equal(toHex((await testEphemeral(k)).pub), k.pub)
    const { key } = await generateRoleKey('house')
    assert.equal(key.pub.length, 65)
  })
})
