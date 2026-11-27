// TEST-ONLY. Never imported by index.ts or by any other file of this directory, and never part of a production bundle.
//
// This is the seam of spec 9.1 (and 11 Q21/Q22): fixed ephemerals imported from their private scalar, fixed nonces,
// and signers that replay a recorded signature (ECDSA is randomised, so a vector carries its signatures as input).
// `generateVectors` produces the fixed vector file and `checkVectors` verifies one. Both are pure (crypto.subtle
// only), so the same file of vectors runs on Node 24 and in a browser against the same module.
import { buildDeviceAdmit, buildHouseAuth, verifyDeviceAdmit, verifyHouseAuth } from './admission.ts'
import { b64url, concat, equal, fail, fromHex, lp16, lp8, toHex, utf8, type Bytes } from './bytes.ts'
import { LABEL_NAMES, LBL, SUITE, type LabelName } from './constants.ts'
import {
  decodeQrBlob, encodeDeviceHello, encodeHsDone, encodePing, encodeQrBlob, padPlaintext, paddedSize, parseTypedCode,
  qrFragment,
} from './content.ts'
import {
  aeadSeal, assertSignable, ecdhBits, hkdf, isValidPoint, SELF_TEST_POINTS, sha256, verifyLabeled, type Entropy,
  type Ephemeral, type KeyRole, type RoleKey, type SignLabel,
} from './crypto.ts'
import { decodeOuter, encodeInner } from './frames.ts'
import {
  deviceIdOf, encodeKeyRotateBody, houseFingerprint, houseIdOf, houseIdText, issueAdmitTicket, issueKeyCert, keyIdOf,
  parseAdmitTicket, relayAuthBody, relayPopBody, verifyKeyRotate,
} from './keys.ts'
import { accessFromCode, accessFromQr, DevicePairing, HousePairing, PairLockout } from './pairing.ts'
import { actDigest, elevateDigest, unlockDigest, UV_PURPOSE, uvChallenge, uvRegChallenge } from './presence.ts'
import { recordAad, recordNonce, sealRecordAt } from './record.ts'
import { DeviceHandshake, HouseHandshake } from './session.ts'
import { pair as PTH, sasFromBits, session as STH, th2 as TH2 } from './transcript.ts'
import { assertionChallenge, registrationChallenge, verifyAssertion, verifyRegistration } from './webauthn.ts'

const subtle = (): SubtleCrypto => globalThis.crypto.subtle
const P256 = { namedCurve: 'P-256' } as const
const ZERO_IV = new Uint8Array(12)

// ---------------------------------------------------------------------------------------------------------------
// The seam
// ---------------------------------------------------------------------------------------------------------------

/** A test key: the private scalar (base64url) and the uncompressed public point (hex). Never a real key. */
export interface TestKey { d: string; pub: string }

export async function generateTestKey(): Promise<TestKey> {
  const pair = await subtle().generateKey({ name: 'ECDSA', ...P256 }, true, ['sign', 'verify'])
  const jwk = await subtle().exportKey('jwk', pair.privateKey)
  return { d: jwk.d ?? fail('malformed', 'no private scalar'), pub: toHex(new Uint8Array(await subtle().exportKey('raw', pair.publicKey))) }
}

function importPrivate(k: TestKey, alg: 'ECDH' | 'ECDSA'): Promise<CryptoKey> {
  const pub = fromHex(k.pub)
  const jwk = { kty: 'EC', crv: 'P-256', d: k.d, x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33)) }
  return subtle().importKey('jwk', jwk, { name: alg, ...P256 }, false, alg === 'ECDH' ? ['deriveBits'] : ['sign'])
}

/** A fixed ephemeral, imported from its private scalar. */
export async function testEphemeral(k: TestKey): Promise<Ephemeral> {
  return { pub: fromHex(k.pub), privateKey: await importPrivate(k, 'ECDH') }
}

export type SigLog = Record<string, string>
const sigKey = (label: SignLabel, body: Uint8Array): string => `${label}:${toHex(body)}`

/** A real signer over a test key that records every signature it produces, to become input of a vector. */
export async function recordingSigner(role: KeyRole, k: TestKey, log: SigLog): Promise<RoleKey> {
  const priv = await importPrivate(k, 'ECDSA')
  const pub = fromHex(k.pub)
  return {
    role, pub,
    async sign(label, body) {
      assertSignable(role, label, body)
      const sig = new Uint8Array(await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, concat(LBL(label), body)))
      log[sigKey(label, body)] = toHex(sig)
      return sig
    },
  }
}

/** A signer that only replays recorded signatures: asked for anything else, it fails. It holds no private key. */
export function fixedSigner(role: KeyRole, pubHex: string, log: SigLog): RoleKey {
  const pub = fromHex(pubHex)
  return {
    role, pub,
    async sign(label, body) {
      assertSignable(role, label, body)
      const sig = log[sigKey(label, body)]
      return sig ? fromHex(sig) : fail('auth', `no recorded ${label} signature for this body`)
    },
  }
}

/** Entropy that hands out the given nonces and ephemerals in order, and fails when asked for anything else. */
export function fixedEntropy(o: { randoms?: readonly Uint8Array[]; ephemerals?: readonly Ephemeral[] }): Entropy {
  const randoms = [...(o.randoms ?? [])]
  const ephemerals = [...(o.ephemerals ?? [])]
  return {
    random(n) {
      const next = randoms.shift()
      if (!next || next.length !== n) return fail('bad-state', `fixed entropy: no random of ${n} bytes queued`)
      return concat(next)
    },
    async ephemeral() { return ephemerals.shift() ?? fail('bad-state', 'fixed entropy: no ephemeral queued') },
  }
}

const aesKey = (raw: Uint8Array, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> =>
  subtle().importKey('raw', concat(raw), { name: 'AES-GCM' }, false, [usage])

/** Deterministic filler for the fixed "random" inputs of the vectors; every byte is below 250 (see randomDigits). */
const pattern = (n: number, seed: number): Bytes => Uint8Array.from({ length: n }, (_, i) => (seed * 31 + i * 17 + ((i * i) >>> 3)) % 250)

// ---------------------------------------------------------------------------------------------------------------
// Straight-line recomputation of the two handshakes, over raw HKDF and AES: independent of the state machines
// ---------------------------------------------------------------------------------------------------------------

interface SessionInputs { kH: TestKey; kD: TestKey; eD: TestKey; eH: TestKey; nD: string; nH: string; nowMs: number; sigs: SigLog }

async function computeSession(i: SessionInputs) {
  const [pubH, pubD, eD, eH, nD, nH] = [fromHex(i.kH.pub), fromHex(i.kD.pub), fromHex(i.eD.pub), fromHex(i.eH.pub), fromHex(i.nD), fromHex(i.nH)]
  const t0 = await STH.th0(1, SUITE)
  const t1 = await STH.th1(t0, 1, SUITE, eD, nD)
  const t2 = await TH2(t1, eH, nH, pubH, await houseIdOf(pubH))
  const z = await ecdhBits(await importPrivate(i.eD, 'ECDH'), eH)
  const zHouse = await ecdhBits(await importPrivate(i.eH, 'ECDH'), eD)
  const kHsH2d = await hkdf(z, t2, LBL('k-hs-h2d'), 32)
  const kHsD2h = await hkdf(z, t2, LBL('k-hs-d2h'), 32)
  const sigH = fromHex(i.sigs[sigKey('house-hs', t2)] ?? fail('auth', 'vector lacks sig_H'))
  const ct2 = await aeadSeal(await aesKey(kHsH2d, 'encrypt'), ZERO_IV, t2, sigH)
  const t3 = await STH.th3(t2, ct2)
  const t4 = await STH.th4(t3, pubD)
  const sigDBody = concat(t4, sigH)
  const sigD = fromHex(i.sigs[sigKey('device-hs', sigDBody)] ?? fail('auth', 'vector lacks sig_D'))
  const deviceId = await deviceIdOf(pubD)
  const ct3 = await aeadSeal(await aesKey(kHsD2h, 'encrypt'), ZERO_IV, t3, concat(deviceId, sigD))
  const t5 = await STH.th5(t4, ct3)
  return {
    th: [t0, t1, t2, t3, t4, t5].map(toHex), z: toHex(z), zAgree: equal(z, zHouse),
    sigsValid: (await verifyLabeled(pubH, 'house-hs', t2, sigH)) && (await verifyLabeled(pubD, 'device-hs', sigDBody, sigD)),
    kHsH2d: toHex(kHsH2d), kHsD2h: toHex(kHsD2h),
    kD2h: toHex(await hkdf(z, t5, LBL('k-d2h'), 32)), kH2d: toHex(await hkdf(z, t5, LBL('k-h2d'), 32)),
    sessionId: toHex(t5.slice(0, 16)), deviceId: toHex(deviceId),
    hs1: toHex(encodeInner({ type: 'HS1', ver: 1, suite: SUITE, eD, nD })),
    hs2: toHex(encodeInner({ type: 'HS2', eH, nH, ct2 })),
    hs3: toHex(encodeInner({ type: 'HS3', ct3 })),
  }
}

async function runSession(i: SessionInputs, kH: RoleKey, kD: RoleKey) {
  const d = await DeviceHandshake.start({
    pinnedPubH: kH.pub, kD, nowMs: i.nowMs, entropy: fixedEntropy({ randoms: [fromHex(i.nD)], ephemerals: [await testEphemeral(i.eD)] }),
  })
  const h = new HouseHandshake({
    kH, nowMs: i.nowMs, entropy: fixedEntropy({ randoms: [fromHex(i.nH)], ephemerals: [await testEphemeral(i.eH)] }),
    lookup: () => ({ pubD: kD.pub, revoked: false, expired: false, maxVerUsed: 1, liveSessions: 0, presence: 1, elevUntil: 0 }),
  })
  const frameOf = (effects: readonly { t: string; frame?: Bytes }[]): Bytes => effects.find(e => e.t === 'send')?.frame ?? fail('bad-state', 'no frame')
  const hs1 = frameOf(d.effects)
  const hs2 = frameOf(await h.onFrame(hs1, i.nowMs))
  const hs3 = frameOf(await d.hs.onFrame(hs2, i.nowMs))
  const houseEffects = await h.onFrame(hs3, i.nowMs)
  const hsDone = frameOf(houseEffects)
  const deviceEffects = await d.hs.onFrame(hsDone, i.nowMs)
  return {
    hs1: toHex(hs1), hs2: toHex(hs2), hs3: toHex(hs3), hsDone: toHex(hsDone),
    established: houseEffects.some(e => e.t === 'established') && deviceEffects.some(e => e.t === 'established'),
  }
}

interface PairInputs {
  kH: TestKey; kT: TestKey; kD: TestKey; kA: TestKey; eD: TestKey; eH: TestKey
  access: 'code' | 'qr'; name: string; aud: string; nowMs: number
  /** House randoms, in the order the ticket draws them: pairId, code R pool, code S pool, QR R, QR S, then N_H. */
  pairId: string; codeRPool: string; codeSPool: string; qrR: string; qrS: string; nH: string
  nD: string; ticketId: string
  sigs: SigLog
}

async function pairSetup(i: PairInputs) {
  const pubH = fromHex(i.kH.pub)
  const digits = (pool: string): Bytes => Uint8Array.from(fromHex(pool).subarray(0, 6), b => 0x30 + (b % 10))
  const [R, S] = i.access === 'code' ? [digits(i.codeRPool), digits(i.codeSPool)] : [fromHex(i.qrR), fromHex(i.qrS)]
  const hello = encodeDeviceHello({ pubD: fromHex(i.kD.pub), pubA: fromHex(i.kA.pub), caps: 1, name: i.name })
  return { pubH, R, S, rv: await PTH.rv(R), hello, houseId: await houseIdOf(pubH) }
}

/** Everything up to the SAS: no signature is needed, which is the point of spec 3.5. */
async function computePairSas(i: PairInputs) {
  const s = await pairSetup(i)
  const [eD, eH, nD, nH] = [fromHex(i.eD.pub), fromHex(i.eH.pub), fromHex(i.nD), fromHex(i.nH)]
  const commit = await PTH.commit(eD, nD, s.hello)
  const t0 = await PTH.th0(1, SUITE)
  const t1 = await PTH.th1(t0, 1, SUITE, s.rv, commit)
  const t2 = await TH2(t1, eH, nH, s.pubH, s.houseId)
  const t3 = await PTH.th3(t2, eD, nD)
  const z = await ecdhBits(await importPrivate(i.eD, 'ECDH'), eH)
  const t4 = await PTH.th4(t3, s.hello)
  const sas = String.fromCharCode(...sasFromBits(await hkdf(z, t4, LBL('sas'), 4)))
  return { ...s, eD, eH, nD, nH, commit, t0, t1, t2, t3, t4, z, sas }
}

async function computePairing(i: PairInputs) {
  const a = await computePairSas(i)
  const kHsD2h = await hkdf(a.z, a.t3, LBL('k-hs-d2h'), 32)
  const kHsH2d = await hkdf(a.z, a.t3, LBL('k-hs-h2d'), 32)
  const sigD = fromHex(i.sigs[sigKey('device-pair', a.t4)] ?? fail('auth', 'vector lacks sig_D'))
  const ct3 = await aeadSeal(await aesKey(kHsD2h, 'encrypt'), ZERO_IV, a.t3, concat(lp16(a.hello), sigD))
  const t5 = await PTH.th5(a.t4, ct3)
  const sigH = fromHex(i.sigs[sigKey('house-pair', t5)] ?? fail('auth', 'vector lacks sig_H'))
  const ct4 = await aeadSeal(await aesKey(kHsH2d, 'encrypt'), ZERO_IV, t5, sigH)
  const t6 = await PTH.th6(t5, ct4)
  return {
    R: toHex(a.R), S: toHex(a.S), rv: toHex(a.rv), commit: toHex(a.commit), sas: a.sas,
    th: [a.t0, a.t1, a.t2, a.t3, a.t4, t5, t6].map(toHex), z: toHex(a.z),
    sigsValid: (await verifyLabeled(fromHex(i.kD.pub), 'device-pair', a.t4, sigD)) && (await verifyLabeled(a.pubH, 'house-pair', t5, sigH)),
    kHsD2h: toHex(kHsD2h), kHsH2d: toHex(kHsH2d),
    kD2h: toHex(await hkdf(a.z, t6, LBL('k-d2h'), 32)), kH2d: toHex(await hkdf(a.z, t6, LBL('k-h2d'), 32)),
    houseConfirm: toHex(await hkdf(a.z, t6, concat(LBL('pair-confirm'), lp8(a.S)), 32)),
    sessionId: toHex(t6.slice(0, 16)), deviceId: toHex(await deviceIdOf(fromHex(i.kD.pub))),
    p1: toHex(encodeInner({ type: 'P1', ver: 1, suite: SUITE, rv: a.rv, commit: a.commit })),
    p2: toHex(encodeInner({ type: 'P2', eH: a.eH, nH: a.nH, pubH: a.pubH })),
    p3: toHex(encodeInner({ type: 'P3', eD: a.eD, nD: a.nD, ct3 })),
    p4: toHex(encodeInner({ type: 'P4', ct4 })),
  }
}

async function runPairing(i: PairInputs, k: { kH: RoleKey; kT: RoleKey; kD: RoleKey; kA: RoleKey }) {
  const nowS = Math.floor(i.nowMs / 1000)
  const ticket = await HousePairing.create({
    kH: k.kH, lockout: new PairLockout(), nowMs: i.nowMs,
    entropy: fixedEntropy({
      randoms: [i.pairId, i.codeRPool, i.codeSPool, i.qrR, i.qrS, i.nH].map(fromHex), ephemerals: [await testEphemeral(i.eH)],
    }),
  })
  const code = ticket.code()
  const qr = await ticket.qr(i.aud)
  const access = i.access === 'code' ? await accessFromCode(code) : await accessFromQr(qr)
  const d = await DevicePairing.start({
    access, kD: k.kD, kA: k.kA, name: i.name, caps: 1, nowMs: i.nowMs,
    entropy: fixedEntropy({ randoms: [fromHex(i.nD)], ephemerals: [await testEphemeral(i.eD)] }),
  })
  type Fx = { t: string; frame?: Bytes; sas?: string }
  const frameOf = (effects: readonly Fx[]): Bytes => effects.find(e => e.t === 'send')?.frame ?? fail('bad-state', 'no frame')
  const p1 = frameOf(d.effects)
  const p2 = frameOf(await ticket.onFrame(1, p1, i.nowMs))
  const p3 = frameOf(await d.pairing.onFrame(p2, i.nowMs))
  const p4 = frameOf(await ticket.onFrame(1, p3, i.nowMs))
  const shown: readonly Fx[] = await d.pairing.onFrame(p4, i.nowMs)
  const sas = shown.find(e => e.t === 'show-sas')?.sas ?? fail('bad-state', 'no SAS shown')
  const ok = await ticket.submitSas(sas, i.nowMs)
  const certT = await issueKeyCert(k.kH, { role: 2, pub: k.kT.pub, notBefore: nowS, notAfter: nowS + 86_400 * 90 })
  const admitTicket = await issueAdmitTicket(k.kT, {
    certT, pubA: k.kA.pub, aud: i.aud, notBefore: nowS, exp: nowS + 86_400 * 30, entropy: fixedEntropy({ randoms: [fromHex(i.ticketId)] }),
  })
  const pairDone = frameOf(await ticket.confirm({ admitTicket, houseName: 'Casa dos vetores', nowMs: i.nowMs }))
  const deviceEnd = await d.pairing.onFrame(pairDone, i.nowMs)
  const pairAck = frameOf(deviceEnd)
  const houseEnd = await ticket.onFrame(1, pairAck, i.nowMs)
  return {
    code, qrBlob: toHex(encodeQrBlob(qr)), sasShown: sas,
    p1: toHex(p1), p2: toHex(p2), p3: toHex(p3), p4: toHex(p4), pairDone: toHex(pairDone), pairAck: toHex(pairAck),
    certT: toHex(certT), admitTicket: toHex(admitTicket),
    paired: ok.some(e => e.t === 'sas-ok') && deviceEnd.some(e => e.t === 'paired') && houseEnd.some(e => e.t === 'done'),
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The vector file
// ---------------------------------------------------------------------------------------------------------------

type Computed<F extends (...a: never[]) => Promise<unknown>> = Awaited<ReturnType<F>>

export interface Vectors {
  about: string
  v1_labels: Record<string, string>
  v2_ids: { pub: string; houseId: string; houseIdText: string; fingerprint: string; deviceId: string; keyId: string }
  v3_hkdf: {
    rfc5869: { ikm: string; salt: string; info: string; len: number; okm: string }[]
    protocol: { z: string; salt: string; S: string; out: Record<string, string> }
  }
  v4_session: { inputs: SessionInputs; computed: Computed<typeof computeSession>; frames: Computed<typeof runSession> }
  v5_pairing: { name: string; inputs: PairInputs; computed: Computed<typeof computePairing>; frames: Computed<typeof runPairing> }[]
  v6_record: {
    key: string; sessionId: string
    cases: { dir: number; ctr: number; nonce: string; aad: string; plaintext: string; frame: string }[]
    padding: [number, number][]
  }
  v7_admission: {
    keys: { kH: TestKey; kR: TestKey; kT: TestKey; kA: TestKey }; sigs: SigLog; aud: string; nowS: number
    r: string; c: string; nR: string; nD: string; ticketId: string
    certR: string; certT: string; relayAuthBody: string; hAuth: string; ticket: string; relayPopBody: string; dAdmit: string
  }
  v8_rotate: { keys: { old: TestKey; next: TestKey }; seq: number; body: string; sigOld: string; sigNew: string }
  v9_presence: {
    sessionId: string; deviceId: string; pubD: string; uvCtr: number; op: number; actId: string; body: string
    unlock: string; elevateDigest: string; elevate: string; actDigest: string; act: string; reg: string
  }
  v10_access: {
    typed: { input: string; R: string; S: string; rv: string }
    qr: { blob: string; fragment: string; maxVer: number; relayHost: string; houseId: string; R: string; S: string; rv: string }
  }
  v11_points: { name: string; point: string; accepted: boolean }[]
}

const run = (from: number, n: number): string => toHex(Uint8Array.from({ length: n }, (_, i) => from + i))

const RFC5869 = [
  {
    ikm: '0b'.repeat(22), salt: run(0x00, 13), info: run(0xf0, 10), len: 42,
    okm: '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
  },
  {
    ikm: run(0x00, 80), salt: run(0x60, 80), info: run(0xb0, 80), len: 82,
    okm: 'b11e398dc80327a1c8e7f78c596a49344f012eda2d4efad8a050cc4c19afa97c59045a99cac7827271cb41c65e590e09da3275600c2f09b8367793a9aca3db71cc30c58179ec3e87c14c01d5c1f3434f1d87',
  },
  {
    ikm: '0b'.repeat(22), salt: '', info: '', len: 42,
    okm: '8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8',
  },
]

async function hkdfProtocol(z: string, salt: string, S: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const name of ['k-hs-d2h', 'k-hs-h2d', 'k-d2h', 'k-h2d'] as const) out[name] = toHex(await hkdf(fromHex(z), fromHex(salt), LBL(name), 32))
  out.sas = toHex(await hkdf(fromHex(z), fromHex(salt), LBL('sas'), 4))
  out['pair-confirm'] = toHex(await hkdf(fromHex(z), fromHex(salt), concat(LBL('pair-confirm'), lp8(fromHex(S))), 32))
  return out
}

async function idsOf(pub: string): Promise<Vectors['v2_ids']> {
  const p = fromHex(pub)
  const houseId = await houseIdOf(p)
  return {
    pub, houseId: toHex(houseId), houseIdText: houseIdText(houseId), fingerprint: houseFingerprint(houseId),
    deviceId: toHex(await deviceIdOf(p)), keyId: toHex(await keyIdOf(p)),
  }
}

const RECORD_PADDING: [number, number][] = [
  [0, 64], [59, 64], [60, 128], [123, 128], [124, 256], [251, 256], [252, 512], [507, 512], [508, 1024], [1019, 1024],
  [1020, 2048], [2043, 2048], [2044, 3072],
]

async function recordCases(key: string, sessionId: string): Promise<Vectors['v6_record']['cases']> {
  const k = await aesKey(fromHex(key), 'encrypt')
  const sid = fromHex(sessionId)
  const out: Vectors['v6_record']['cases'] = []
  for (const dir of [1, 2] as const) {
    for (const ctr of [0, 1, 2 ** 32]) {
      const plaintext = padPlaintext('PING', encodePing(ctr))
      out.push({
        dir, ctr, nonce: toHex(recordNonce(ctr)), aad: toHex(recordAad(sid, dir, ctr)), plaintext: toHex(plaintext),
        frame: toHex(await sealRecordAt(k, sid, dir, ctr, plaintext)),
      })
    }
  }
  return out
}

async function admissionOf(
  a: Pick<Vectors['v7_admission'], 'keys' | 'aud' | 'nowS' | 'r' | 'c' | 'nR' | 'nD' | 'ticketId'>,
  k: { kH: RoleKey; kR: RoleKey; kT: RoleKey; kA: RoleKey },
) {
  const certR = await issueKeyCert(k.kH, { role: 1, pub: k.kR.pub, notBefore: a.nowS, notAfter: a.nowS + 86_400 * 30 })
  const certT = await issueKeyCert(k.kH, { role: 2, pub: k.kT.pub, notBefore: a.nowS, notAfter: a.nowS + 86_400 * 90 })
  const houseId = await houseIdOf(k.kH.pub)
  const hAuth = await buildHouseAuth({
    r: fromHex(a.r), aud: a.aud, pubH: k.kH.pub, certR, certsT: [certT], kR: k.kR, nowS: a.nowS, entropy: fixedEntropy({ randoms: [fromHex(a.c)] }),
  })
  const ticket = await issueAdmitTicket(k.kT, {
    certT, pubA: k.kA.pub, aud: a.aud, notBefore: a.nowS, exp: a.nowS + 86_400 * 30, entropy: fixedEntropy({ randoms: [fromHex(a.ticketId)] }),
  })
  const dAdmit = await buildDeviceAdmit({ ticket, aud: a.aud, nR: fromHex(a.nR), kA: k.kA, entropy: fixedEntropy({ randoms: [fromHex(a.nD)] }) })
  return {
    certR: toHex(certR), certT: toHex(certT), hAuth: toHex(hAuth), ticket: toHex(ticket), dAdmit: toHex(dAdmit),
    relayAuthBody: toHex(relayAuthBody(a.aud, houseId, fromHex(a.r), fromHex(a.c), a.nowS)),
    relayPopBody: toHex(relayPopBody(a.aud, houseId, fromHex(a.ticketId), fromHex(a.nR), fromHex(a.nD))),
  }
}

async function presenceOf(p: Pick<Vectors['v9_presence'], 'sessionId' | 'deviceId' | 'pubD' | 'uvCtr' | 'op' | 'actId' | 'body'>) {
  const sid = fromHex(p.sessionId)
  const eDigest = await elevateDigest(fromHex(p.deviceId))
  const aDigest = await actDigest(p.op, fromHex(p.actId), fromHex(p.body))
  return {
    unlock: toHex(await uvChallenge(sid, p.uvCtr, UV_PURPOSE.unlock, unlockDigest())),
    elevateDigest: toHex(eDigest), elevate: toHex(await uvChallenge(sid, p.uvCtr, UV_PURPOSE.elevate, eDigest)),
    actDigest: toHex(aDigest), act: toHex(await uvChallenge(sid, p.uvCtr, UV_PURPOSE.act, aDigest)),
    reg: toHex(await uvRegChallenge(sid, fromHex(p.pubD))),
  }
}

async function pointsOf(): Promise<Vectors['v11_points']> {
  const out: Vectors['v11_points'] = []
  for (const name of ['valid', 'offCurve', 'compressed', 'hybrid', 'badPrefix', 'short64'] as const) {
    const point = SELF_TEST_POINTS[name]()
    out.push({ name, point: toHex(point), accepted: await isValidPoint(point) })
  }
  return out
}

/** Produces a fresh vector file: new test keys, real signatures recorded as input, everything else derived. */
export async function generateVectors(): Promise<Vectors> {
  const nowMs = 1_795_000_000_000
  const nowS = nowMs / 1000
  const aud = 'relay.example:8443'

  // V-4
  const sKeys = { kH: await generateTestKey(), kD: await generateTestKey(), eD: await generateTestKey(), eH: await generateTestKey() }
  const sInputs: SessionInputs = { ...sKeys, nD: toHex(pattern(32, 1)), nH: toHex(pattern(32, 2)), nowMs, sigs: {} }
  const sFrames = await runSession(sInputs, await recordingSigner('house', sKeys.kH, sInputs.sigs), await recordingSigner('device', sKeys.kD, sInputs.sigs))
  const v4: Vectors['v4_session'] = { inputs: sInputs, computed: await computeSession(sInputs), frames: sFrames }

  // V-5: one by the typed code, and one by the QR whose SAS starts with a zero.
  const v5: Vectors['v5_pairing'] = []
  for (const variant of ['typed code', 'qr, SAS with a leading zero'] as const) {
    const keys = {
      kH: await generateTestKey(), kT: await generateTestKey(), kD: await generateTestKey(), kA: await generateTestKey(),
      eD: await generateTestKey(), eH: await generateTestKey(),
    }
    const inputs: PairInputs = {
      ...keys, access: variant === 'typed code' ? 'code' : 'qr', name: 'Aparelho dos vetores', aud, nowMs,
      pairId: toHex(pattern(16, 3)), codeRPool: toHex(pattern(12, 4)), codeSPool: toHex(pattern(12, 5)), qrR: toHex(pattern(16, 6)),
      qrS: toHex(pattern(16, 7)), nH: toHex(pattern(32, 8)), nD: toHex(pattern(32, 9)), ticketId: toHex(pattern(16, 10)), sigs: {},
    }
    if (variant !== 'typed code') {
      // Only N_D is varied until the SAS starts with '0'; about one try in ten does.
      for (let seed = 100; ; seed++) {
        inputs.nD = toHex(pattern(32, seed))
        if ((await computePairSas(inputs)).sas.startsWith('0')) break
      }
    }
    const frames = await runPairing(inputs, {
      kH: await recordingSigner('house', keys.kH, inputs.sigs), kT: await recordingSigner('ticket', keys.kT, inputs.sigs),
      kD: await recordingSigner('device', keys.kD, inputs.sigs), kA: await recordingSigner('admission', keys.kA, inputs.sigs),
    })
    v5.push({ name: variant, inputs, computed: await computePairing(inputs), frames })
  }

  // V-7
  const aKeys = { kH: await generateTestKey(), kR: await generateTestKey(), kT: await generateTestKey(), kA: await generateTestKey() }
  const aSigs: SigLog = {}
  const aBase = {
    keys: aKeys, aud, nowS, r: toHex(pattern(32, 11)), c: toHex(pattern(32, 12)), nR: toHex(pattern(32, 13)), nD: toHex(pattern(32, 14)),
    ticketId: toHex(pattern(16, 15)),
  }
  const aOut = await admissionOf(aBase, {
    kH: await recordingSigner('house', aKeys.kH, aSigs), kR: await recordingSigner('relay', aKeys.kR, aSigs),
    kT: await recordingSigner('ticket', aKeys.kT, aSigs), kA: await recordingSigner('admission', aKeys.kA, aSigs),
  })

  // V-8
  const rKeys = { old: await generateTestKey(), next: await generateTestKey() }
  const rSigs: SigLog = {}
  const rBody = encodeKeyRotateBody({
    oldHouseId: await houseIdOf(fromHex(rKeys.old.pub)), newPub: fromHex(rKeys.next.pub), seq: 1, issuedAt: nowS, overlapUntil: nowS + 86_400 * 31,
  })
  const sigOld = await (await recordingSigner('house', rKeys.old, rSigs)).sign('key-rotate', rBody)
  const sigNew = await (await recordingSigner('house', rKeys.next, rSigs)).sign('key-rotate-accept', concat(rBody, sigOld))

  // V-9, V-10
  const pBase = {
    sessionId: v4.computed.sessionId, deviceId: v4.computed.deviceId, pubD: sKeys.kD.pub, uvCtr: 3, op: 0x0601, actId: toHex(pattern(16, 16)),
    body: toHex(utf8('{"deviceId":"00112233445566778899aabbccddeeff"}')),
  }
  const typedInput = '314 159-265 358'
  const typed = parseTypedCode(typedInput)
  const qr = { maxVer: 1, relayHost: aud, houseId: await houseIdOf(fromHex(sKeys.kH.pub)), R: pattern(16, 17), S: pattern(16, 18) }
  const recordKey = toHex(pattern(32, 19))
  const recordSid = toHex(pattern(16, 20))
  const z = toHex(pattern(32, 21))
  const salt = toHex(pattern(32, 22))
  const S = toHex(typed.S)

  return {
    about: 'Fixed vectors of the remote wire v1 (fio-spec 9.1). Test keys only. Regenerate with REMOTE_VECTORS_UPDATE=1.',
    v1_labels: Object.fromEntries(LABEL_NAMES.map(n => [n, toHex(LBL(n))])),
    v2_ids: await idsOf(sKeys.kH.pub),
    v3_hkdf: { rfc5869: RFC5869, protocol: { z, salt, S, out: await hkdfProtocol(z, salt, S) } },
    v4_session: v4,
    v5_pairing: v5,
    v6_record: { key: recordKey, sessionId: recordSid, cases: await recordCases(recordKey, recordSid), padding: RECORD_PADDING },
    v7_admission: { ...aBase, sigs: aSigs, ...aOut },
    v8_rotate: { keys: rKeys, seq: 1, body: toHex(rBody), sigOld: toHex(sigOld), sigNew: toHex(sigNew) },
    v9_presence: { ...pBase, ...(await presenceOf(pBase)) },
    v10_access: {
      typed: { input: typedInput, R: toHex(typed.R), S: toHex(typed.S), rv: toHex(await PTH.rv(typed.R)) },
      qr: {
        blob: toHex(encodeQrBlob(qr)), fragment: qrFragment(qr), maxVer: qr.maxVer, relayHost: qr.relayHost, houseId: toHex(qr.houseId),
        R: toHex(qr.R), S: toHex(qr.S), rv: toHex(await PTH.rv(qr.R)),
      },
    },
    v11_points: await pointsOf(),
  }
}

export interface VectorResult { name: string; ok: boolean; detail?: string }

/** Verifies a vector file against this module, on whatever platform runs it. Every line of the result must be ok. */
export async function checkVectors(v: Vectors): Promise<VectorResult[]> {
  const out: VectorResult[] = []
  const same = (name: string, actual: unknown, expected: unknown): void => {
    const [a, e] = [JSON.stringify(actual), JSON.stringify(expected)]
    out.push(a === e ? { name, ok: true } : { name, ok: false, detail: `got ${a.slice(0, 160)} expected ${e.slice(0, 160)}` })
  }
  const section = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try { await fn() } catch (e) { out.push({ name, ok: false, detail: `threw ${String(e)}` }) }
  }

  await section('V-1', async () => {
    same('V-1 label names', Object.keys(v.v1_labels), [...LABEL_NAMES])
    for (const n of LABEL_NAMES) same(`V-1 LBL(${n})`, toHex(LBL(n as LabelName)), v.v1_labels[n])
  })
  await section('V-2', async () => same('V-2 identifiers', await idsOf(v.v2_ids.pub), v.v2_ids))
  await section('V-3', async () => {
    for (const [i, c] of v.v3_hkdf.rfc5869.entries()) {
      same(`V-3 RFC 5869 case ${i + 1}`, toHex(await hkdf(fromHex(c.ikm), fromHex(c.salt), fromHex(c.info), c.len)), c.okm)
    }
    const p = v.v3_hkdf.protocol
    same('V-3 protocol derivations', await hkdfProtocol(p.z, p.salt, p.S), p.out)
  })
  await section('V-4', async () => {
    const s = v.v4_session
    const computed = await computeSession(s.inputs)
    same('V-4 transcript, Z, keys and sessionId', computed, s.computed)
    same('V-4 both ends agree on Z and the recorded signatures verify', [computed.zAgree, computed.sigsValid], [true, true])
    const frames = await runSession(s.inputs, fixedSigner('house', s.inputs.kH.pub, s.inputs.sigs), fixedSigner('device', s.inputs.kD.pub, s.inputs.sigs))
    same('V-4 frames written by the state machines', frames, s.frames)
    same('V-4 machines and straight-line computation agree', [frames.hs1, frames.hs2, frames.hs3], [computed.hs1, computed.hs2, computed.hs3])
    // HS_DONE is record 0 of the house under k_h2d: sealing the same plaintext with the vector's key gives the frame.
    const hsDonePt = padPlaintext('HS_DONE', encodeHsDone({ houseMaxVer: 1, now: Math.floor(s.inputs.nowMs / 1000), presence: 1, elevUntil: 0 }))
    const sealed = await sealRecordAt(await aesKey(fromHex(computed.kH2d), 'encrypt'), fromHex(computed.sessionId), 2, 0, hsDonePt)
    same('V-4 HS_DONE under the derived k_h2d', toHex(sealed), s.frames.hsDone)
  })
  await section('V-5', async () => {
    same('V-5 has a SAS with a leading zero', v.v5_pairing.some(p => p.computed.sas.startsWith('0')), true)
    for (const p of v.v5_pairing) {
      const computed = await computePairing(p.inputs)
      same(`V-5 (${p.name}) commit, transcript, Z, keys, SAS and houseConfirm`, computed, p.computed)
      same(`V-5 (${p.name}) recorded signatures verify`, computed.sigsValid, true)
      const i = p.inputs
      const frames = await runPairing(i, {
        kH: fixedSigner('house', i.kH.pub, i.sigs), kT: fixedSigner('ticket', i.kT.pub, i.sigs),
        kD: fixedSigner('device', i.kD.pub, i.sigs), kA: fixedSigner('admission', i.kA.pub, i.sigs),
      })
      same(`V-5 (${p.name}) frames written by the state machines`, frames, p.frames)
      same(`V-5 (${p.name}) machines and straight-line computation agree`,
        [frames.p1, frames.p2, frames.p3, frames.p4, frames.sasShown], [computed.p1, computed.p2, computed.p3, computed.p4, computed.sas])
    }
  })
  await section('V-6', async () => {
    const r = v.v6_record
    same('V-6 nonce, AAD and ciphertext', await recordCases(r.key, r.sessionId), r.cases)
    same('V-6 counters cross 32 bits', r.cases.map(c => c.ctr).includes(2 ** 32), true)
    same('V-6 padding ladder', r.padding.map(([clen]) => [clen, paddedSize(5 + clen)]), r.padding)
  })
  await section('V-7', async () => {
    const a = v.v7_admission
    const k = a.keys
    const got = await admissionOf(a, {
      kH: fixedSigner('house', k.kH.pub, a.sigs), kR: fixedSigner('relay', k.kR.pub, a.sigs),
      kT: fixedSigner('ticket', k.kT.pub, a.sigs), kA: fixedSigner('admission', k.kA.pub, a.sigs),
    })
    same('V-7 key-cert of both roles, relay-auth, AdmitTicket and relay-pop',
      got, { certR: a.certR, certT: a.certT, hAuth: a.hAuth, ticket: a.ticket, dAdmit: a.dAdmit, relayAuthBody: a.relayAuthBody, relayPopBody: a.relayPopBody })
    const auth = decodeOuter('house', 'end', fromHex(a.hAuth))
    const admit = decodeOuter('device', 'end', fromHex(a.dAdmit))
    if (auth.type !== 'H_AUTH' || admit.type !== 'D_ADMIT') return fail('malformed', 'vector frames')
    const house = await verifyHouseAuth({ auth, r: fromHex(a.r), aud: a.aud, nowS: a.nowS })
    same('V-7 the relay accepts the H_AUTH', house.ok, true)
    if (!house.ok) return
    const verdict = await verifyDeviceAdmit({ admit, nR: fromHex(a.nR), aud: a.aud, nowS: a.nowS, house: house.house, deny: undefined })
    same('V-7 the relay admits the device', verdict.ok, true)
    same('V-7 ticketId', toHex(parseAdmitTicket(fromHex(a.ticket)).ticketId), a.ticketId)
  })
  await section('V-8', async () => {
    const r = v.v8_rotate
    const verdict = await verifyKeyRotate({
      body: fromHex(r.body), sigOld: fromHex(r.sigOld), sigNew: fromHex(r.sigNew), pinnedPubH: fromHex(r.keys.old.pub), currentSeq: r.seq - 1,
    })
    same('V-8 key-rotate with both signatures', verdict.ok, true)
    same('V-8 a replayed declaration is refused', (await verifyKeyRotate({
      body: fromHex(r.body), sigOld: fromHex(r.sigOld), sigNew: fromHex(r.sigNew), pinnedPubH: fromHex(r.keys.old.pub), currentSeq: r.seq,
    })).ok, false)
  })
  await section('V-9', async () => {
    const p = v.v9_presence
    same('V-9 presence challenges', await presenceOf(p),
      { unlock: p.unlock, elevateDigest: p.elevateDigest, elevate: p.elevate, actDigest: p.actDigest, act: p.act, reg: p.reg })
  })
  await section('V-10', async () => {
    const t = v.v10_access.typed
    const parsed = parseTypedCode(t.input)
    same('V-10 typed code', { R: toHex(parsed.R), S: toHex(parsed.S), rv: toHex(await PTH.rv(parsed.R)) }, { R: t.R, S: t.S, rv: t.rv })
    const q = v.v10_access.qr
    const blob = decodeQrBlob(fromHex(q.blob))
    same('V-10 QR blob', {
      blob: toHex(encodeQrBlob(blob)), fragment: qrFragment(blob), maxVer: blob.maxVer, relayHost: blob.relayHost, houseId: toHex(blob.houseId),
      R: toHex(blob.R), S: toHex(blob.S), rv: toHex(await PTH.rv(blob.R)),
    }, q)
  })
  await section('V-11', async () => {
    same('V-11 points', await pointsOf(), v.v11_points)
    same('V-11 only the valid point is accepted', v.v11_points.filter(p => p.accepted).map(p => p.name), ['valid'])
  })
  // The whole point of a hash: two different inputs of the file must not collapse to one.
  await section('sanity', async () => same('sanity: SHA-256 of the empty string', toHex(await sha256()), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'))
  return out
}

// ---------------------------------------------------------------------------------------------------------------
// WebAuthn fixed vectors of the house (spec 7.4, step 2.4): the `house` block of test/unit/remote.webauthn.vectors.json.
// The checker is pure over the file and the module, so Node and a browser run the same vectors through the same code.
// ---------------------------------------------------------------------------------------------------------------

type WebAuthnRefused = { ok: false; reason: string }
export type WebAuthnRegExpect =
  | { ok: true; credentialId: string; publicKey: string; signCount: number; backupEligible: boolean; backedUp: boolean }
  | WebAuthnRefused
export type WebAuthnAssertExpect = { ok: true; signCount: number; backedUp: boolean } | WebAuthnRefused

export interface WebAuthnRegCase { name: string; challenge: string; clientDataJSON: string; attestationObject: string; expect: WebAuthnRegExpect }
export interface WebAuthnAssertCase {
  name: string; challenge: string; publicKey: string; storedSignCount: number
  authenticatorData: string; clientDataJSON: string; signature: string; expect: WebAuthnAssertExpect
}

/** The house block: the relying party, the context the challenges are built from, and every recorded ceremony. */
export interface WebAuthnHouse {
  rp: { origin: string; rpId: string }
  context: { sessionId: string; otherSessionId: string; pubD: string; deviceId: string; otherDeviceId: string; uvCtr: number; op: number; actId: string; body: string }
  challenges: { registration: string; unlock: string; elevate: string; act: string }
  registrations: WebAuthnRegCase[]
  assertions: WebAuthnAssertCase[]
}

async function runRegistration(h: WebAuthnHouse, c: WebAuthnRegCase): Promise<WebAuthnRegExpect> {
  const v = await verifyRegistration({
    rp: h.rp, challenge: fromHex(c.challenge), clientDataJSON: fromHex(c.clientDataJSON), attestationObject: fromHex(c.attestationObject),
  })
  if (!v.ok) return { ok: false, reason: v.reason }
  const k = v.credential
  return { ok: true, credentialId: toHex(k.credentialId), publicKey: toHex(k.publicKey), signCount: k.signCount, backupEligible: k.backupEligible, backedUp: k.backedUp }
}

async function runAssertion(h: WebAuthnHouse, c: WebAuthnAssertCase): Promise<WebAuthnAssertExpect> {
  const v = await verifyAssertion({
    rp: h.rp, challenge: fromHex(c.challenge),
    proof: { authenticatorData: fromHex(c.authenticatorData), clientDataJSON: fromHex(c.clientDataJSON), signature: fromHex(c.signature) },
    credential: { publicKey: fromHex(c.publicKey), signCount: c.storedSignCount },
  })
  return v.ok ? { ok: true, signCount: v.signCount, backedUp: v.backedUp } : { ok: false, reason: v.reason }
}

/** Checks the house block against this module: the four challenges, then every registration and assertion verdict. */
export async function checkWebAuthnHouse(h: WebAuthnHouse): Promise<VectorResult[]> {
  const out: VectorResult[] = []
  const same = (name: string, got: unknown, want: unknown): void => {
    const a = JSON.stringify(got)
    const b = JSON.stringify(want)
    out.push(a === b ? { name, ok: true } : { name, ok: false, detail: `got ${a}, want ${b}` })
  }
  const sid = fromHex(h.context.sessionId)
  const act = { purpose: 'act', op: h.context.op, actId: fromHex(h.context.actId), body: fromHex(h.context.body) } as const
  same('challenge: registration', toHex(await registrationChallenge(sid, fromHex(h.context.pubD))), h.challenges.registration)
  same('challenge: unlock', toHex(await assertionChallenge(sid, h.context.uvCtr, { purpose: 'unlock' })), h.challenges.unlock)
  same('challenge: elevate', toHex(await assertionChallenge(sid, h.context.uvCtr, { purpose: 'elevate', deviceId: fromHex(h.context.deviceId) })), h.challenges.elevate)
  same('challenge: act', toHex(await assertionChallenge(sid, h.context.uvCtr, act)), h.challenges.act)
  for (const c of h.registrations) same(c.name, await runRegistration(h, c), c.expect)
  for (const c of h.assertions) same(c.name, await runAssertion(h, c), c.expect)
  return out
}
