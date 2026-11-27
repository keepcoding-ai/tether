// Presence in the portal (RR2.4b; fio-spec 7.3, 7.4, 6.2; E-8, E-10, E-12): uv.register only in the pairing session and
// once, a device without a credential only reads, uv.challenge / uv.assert unlock and elevate, the per-act proof of an
// elevated act recomputed from the request received, one use per challenge, the lockout after invalid proofs (a refusal
// by the signature counter is not one), one proof per device at a time, and the credential read back after a restart.
// A House in this process (remoted.house-bench.ts) and a software authenticator.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, test } from 'node:test'
import { ascii, b64url, concat, fromB64url, toHex, u16, u32, u8, utf8, type Bytes } from '../../src/remote/bytes.ts'
import { sha256 } from '../../src/remote/crypto.ts'
import { assertionChallenge, CLOSE, PRESENCE, registrationChallenge, RES_STATUS, type UvProof } from '../../src/remote/index.ts'
import { AUTH_FLAG } from '../../src/remote/webauthn.ts'
import { deviceView, parseRegistry, serializeRegistry, type DeviceEntry } from '../../extensions/remote/rules.ts'
import { startHouseBench, type HouseBench } from './remoted.house-bench.ts'
import { until, type DeviceSession, type TestDevice } from './remoted.helpers.ts'

const ORIGIN = 'https://pwa.example'
const RP_ID = 'pwa.example'
const OP = { info: 0x0001, renew: 0x0002, challenge: 0x0003, assert: 0x0004, register: 0x0005, lock: 0x0007, list: 0x0100, watch: 0x0101, revoke: 0x0601 }
const { UP, UV, AT } = AUTH_FLAG
const subtle = globalThis.crypto.subtle
const actId = (): Bytes => new Uint8Array(randomBytes(16))

// ---- a software authenticator (the encodings of test/unit/remote.webauthn.test.ts) -----------------------------------

const cborHead = (major: number, n: number): Bytes =>
  n < 24 ? u8((major << 5) | n) : n < 0x100 ? concat(u8((major << 5) | 24), u8(n)) : concat(u8((major << 5) | 25), u16(n))
const cInt = (v: number): Bytes => (v >= 0 ? cborHead(0, v) : cborHead(1, -1 - v))
const cBytes = (b: Uint8Array): Bytes => concat(cborHead(2, b.length), b)
const cText = (s: string): Bytes => concat(cborHead(3, s.length), ascii(s))
const cMap = (...pairs: (readonly [Uint8Array, Uint8Array])[]): Bytes => concat(cborHead(5, pairs.length), ...pairs.flatMap((p) => [p[0], p[1]]))
const coseEc2 = (pub: Uint8Array): Bytes =>
  cMap([cInt(1), cInt(2)], [cInt(3), cInt(-7)], [cInt(-1), cInt(1)], [cInt(-2), cBytes(pub.subarray(1, 33))], [cInt(-3), cBytes(pub.subarray(33))])
const clientData = (type: string, challenge: Uint8Array, origin: string): Bytes =>
  utf8(`{"type":"${type}","challenge":"${b64url(challenge)}","origin":"${origin}","crossOrigin":false}`)
const derInt = (x: Uint8Array): Bytes => {
  let i = 0
  while (i < x.length - 1 && x[i] === 0) i++
  const mag = x.subarray(i)
  const body = mag[0]! & 0x80 ? concat(u8(0), mag) : concat(mag)
  return concat(u8(0x02), u8(body.length), body)
}
const toDer = (sig: Uint8Array): Bytes => {
  const c = concat(derInt(sig.subarray(0, 32)), derInt(sig.subarray(32)))
  return concat(u8(0x30), u8(c.length), c)
}

class SoftAuthenticator {
  readonly credentialId: Bytes = new Uint8Array(randomBytes(16))
  pub!: Bytes
  #key!: CryptoKeyPair

  static async make(): Promise<SoftAuthenticator> {
    const a = new SoftAuthenticator()
    a.#key = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
    a.pub = new Uint8Array(await subtle.exportKey('raw', a.#key.publicKey))
    return a
  }

  async #authData(flags: number, signCount: number, attested?: Uint8Array): Promise<Bytes> {
    return concat(await sha256(ascii(RP_ID)), u8(flags), u32(signCount), attested ?? new Uint8Array(0))
  }

  /** The answer of navigator.credentials.create, as the body of uv.register. */
  async register(challenge: Uint8Array, o: { origin?: string } = {}): Promise<{ clientDataJSON: string; attestationObject: string }> {
    const attested = concat(new Uint8Array(16), u16(this.credentialId.length), this.credentialId, coseEc2(this.pub))
    const ad = await this.#authData(UP | UV | AT, 0, attested)
    const att = cMap([cText('fmt'), cText('none')], [cText('attStmt'), cMap()], [cText('authData'), cBytes(ad)])
    return { clientDataJSON: b64url(clientData('webauthn.create', challenge, o.origin ?? ORIGIN)), attestationObject: b64url(att) }
  }

  /** The answer of navigator.credentials.get, as the uvProof of the envelope. */
  async assert(challenge: Uint8Array, uvCtr: number, o: { signCount?: number; origin?: string } = {}): Promise<UvProof> {
    const authenticatorData = await this.#authData(UP | UV, o.signCount ?? 0)
    const clientDataJSON = clientData('webauthn.get', challenge, o.origin ?? ORIGIN)
    const raw = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.#key.privateKey, concat(authenticatorData, await sha256(clientDataJSON))))
    return { uvCtr, authenticatorData, clientDataJSON, signature: toDer(raw) }
  }
}

// ---- the ceremonies as the PWA runs them -------------------------------------------------------------------------

async function challenge(s: DeviceSession, purpose: 'unlock' | 'elevate'): Promise<{ uvCtr: number; challenge: Bytes }> {
  const c = await s.request(OP.challenge, { purpose })
  assert.equal(c.status, RES_STATUS.ok, `uv.challenge ${purpose}`)
  return { uvCtr: c.body.uvCtr as number, challenge: fromB64url(c.body.challenge as string) }
}

async function present(s: DeviceSession, a: SoftAuthenticator, purpose: 'unlock' | 'elevate' = 'unlock', o: { signCount?: number; origin?: string } = {}) {
  const c = await challenge(s, purpose)
  return s.request(OP.assert, {}, { actId: actId(), uvProof: await a.assert(c.challenge, c.uvCtr, o) })
}

/** An act with its proof: the challenge computed by the device from the exact bytes it sends. */
async function act(s: DeviceSession, a: SoftAuthenticator, op: number, body: Record<string, unknown>, o: { signCount?: number; proof?: boolean } = {}) {
  const raw = utf8(JSON.stringify(body))
  const id = actId()
  if (o.proof === false) return s.request(op, {}, { actId: id, raw })
  const c = await s.request(OP.challenge, { purpose: 'act', op })
  assert.equal(c.status, RES_STATUS.ok, 'uv.challenge act')
  assert.equal(c.body.challenge, undefined, 'an act challenge is computed from the request, not handed out')
  const chal = await assertionChallenge(s.session.sessionId, c.body.uvCtr as number, { purpose: 'act', op, actId: id, body: raw })
  return s.request(op, {}, { actId: id, raw, uvProof: await a.assert(chal, c.body.uvCtr as number, o) })
}

const lastAudit = (bench: HouseBench, act: string) => bench.audits().filter((l) => l.act === act).at(-1)

describe('presence in the portal', () => {
  let bench: HouseBench
  let auth: SoftAuthenticator
  let id: string
  let tv: { device: TestDevice; id: string }
  /** A new session once the closed ones are gone from the house (at most 3 live per device). */
  const connect = async (d?: TestDevice): Promise<DeviceSession> => {
    await until(() => bench.house.status().sessions < 3 || undefined, 5_000, 'room for one more session')
    return bench.connect(d)
  }
  before(async () => {
    bench = await startHouseBench({
      origin: ORIGIN, askDelayMs: 30,
      limits: { reqPerDevicePerMin: 10_000, gesturesPerDevicePerMin: 10_000, hsPerTicketPerMin: 1_000 },
    })
    auth = await SoftAuthenticator.make()
    id = toHex(bench.device.result!.deviceId)
  })
  after(async () => { await bench?.stop() })

  test('uv.register only in the session of the pairing, born locked [E-10], and once; then the device has a credential', async () => {
    const fresh = bench.fresh
    assert.equal((await fresh.request(OP.info)).body.presence, PRESENCE.locked, 'the pairing session is born locked')
    assert.equal((await fresh.request(OP.list)).status, RES_STATUS.locked, 'only the session family while locked')
    const normal = await connect()
    assert.equal(normal.info!.presence, PRESENCE.noCredential, 'no credential yet: a normal session only reads')
    const outside = await normal.request(OP.register, await auth.register(await registrationChallenge(normal.session.sessionId, bench.device.kD.pub)), { actId: actId() })
    assert.equal(outside.status, RES_STATUS.presenceRequired, 'uv.register outside the pairing session')
    normal.leg.close()

    const wrong = await fresh.request(OP.register, await auth.register(await registrationChallenge(new Uint8Array(randomBytes(16)), bench.device.kD.pub)), { actId: actId() })
    assert.deepEqual([wrong.status, wrong.body.error], [RES_STATUS.failed, 'refused'])
    assert.equal(lastAudit(bench, 'uv.register')?.result, 'refused:challenge')
    const origin = await fresh.request(OP.register, await auth.register(await registrationChallenge(fresh.session.sessionId, bench.device.kD.pub), { origin: 'https://evil.example' }), { actId: actId() })
    assert.equal(origin.status, RES_STATUS.failed)
    assert.equal(lastAudit(bench, 'uv.register')?.result, 'refused:origin')
    assert.equal(bench.registry.get(id)?.credential, undefined, 'a refused authenticator leaves the device without credential')

    const ok = await fresh.request(OP.register, await auth.register(await registrationChallenge(fresh.session.sessionId, bench.device.kD.pub)), { actId: actId() })
    assert.equal(ok.status, RES_STATUS.ok)
    assert.deepEqual(ok.body, { presence: PRESENCE.locked, elevUntil: 0 }, 'registered: locked until the first uv.assert')
    const stored = bench.registry.get(id)?.credential
    assert.deepEqual([stored?.credentialId, stored?.publicKey, stored?.signCount], [b64url(auth.credentialId), toHex(auth.pub), 0])
    assert.equal(lastAudit(bench, 'uv.register')?.result, 'ok')

    const again = await fresh.request(OP.register, await auth.register(await registrationChallenge(fresh.session.sessionId, bench.device.kD.pub)), { actId: actId() })
    assert.deepEqual([again.status, lastAudit(bench, 'uv.register')?.result], [RES_STATUS.failed, 'refused:already'], 'once per device')
    assert.equal((await fresh.request(OP.register, { clientDataJSON: 'x'.repeat(9000) }, { actId: actId() })).status, RES_STATUS.badRequest, 'the ceiling of the body')

    assert.deepEqual((await present(fresh, auth)).body, { presence: PRESENCE.unlocked, elevUntil: 0 }, 'the first unlock')
    assert.equal((await fresh.request(OP.list)).status, RES_STATUS.ok)
    fresh.leg.close()
  })

  test('a device without a credential only reads [E-8]: no challenge, no act; the session family stays', async () => {
    const paired = await bench.pair('TV da sala')
    tv = { device: paired.device, id: toHex(paired.device.result!.deviceId) }
    paired.fresh.leg.close()
    const s = await connect(tv.device)
    assert.equal(s.info!.presence, PRESENCE.noCredential)
    assert.equal((await s.request(OP.list)).status, RES_STATUS.ok, 'it reads')
    assert.equal((await s.request(OP.challenge, { purpose: 'unlock' })).status, RES_STATUS.presenceRequired, 'nothing to prove with')
    assert.equal((await act(s, auth, OP.revoke, { deviceId: id }, { proof: false })).status, RES_STATUS.presenceRequired)
    assert.equal((await s.request(OP.lock, {}, { actId: actId() })).status, RES_STATUS.ok, 'session.lock only lowers power')
    assert.equal((await s.request(OP.info)).body.presence, PRESENCE.noCredential)
    s.leg.close()
  })

  test('with a credential, the elevated act without its proof is refused; with it, it runs', async () => {
    const s = await connect()
    assert.equal(s.info!.presence, PRESENCE.unlocked, 'the unlock of the pairing session holds for the device')
    assert.equal((await act(s, auth, OP.revoke, { deviceId: tv.id }, { proof: false })).status, RES_STATUS.presenceRequired)
    assert.equal(bench.registry.get(tv.id)?.state, 'active')
    const tvSession = await connect(tv.device)
    const done = await act(s, auth, OP.revoke, { deviceId: tv.id })
    assert.equal(done.status, RES_STATUS.ok)
    assert.deepEqual([lastAudit(bench, 'device.revoke')?.result, lastAudit(bench, 'device.revoke')?.target], ['ok', tv.id])
    assert.ok(bench.notes.some((n) => n.note === 'revoke-device' && n.deviceId === id && n.target === tv.id))
    await until(() => tvSession.closed || undefined, 5_000, 'the revoked device closed')
    assert.equal(tvSession.closed!.code, CLOSE.revoked)
    assert.equal((await act(s, auth, OP.revoke, { deviceId: tv.id })).status, RES_STATUS.notFound, 'a revoked target is not found, after its proof')

    // The proof of one body does not serve another: the portal hashes the request it received.
    const c = await s.request(OP.challenge, { purpose: 'act', op: OP.revoke })
    const aid = actId()
    const chal = await assertionChallenge(s.session.sessionId, c.body.uvCtr as number, { purpose: 'act', op: OP.revoke, actId: aid, body: utf8(JSON.stringify({ deviceId: '00'.repeat(16) })) })
    const swapped = await s.request(OP.revoke, {}, { actId: aid, raw: utf8(JSON.stringify({ deviceId: id })), uvProof: await auth.assert(chal, c.body.uvCtr as number) })
    assert.equal(swapped.status, RES_STATUS.presenceRequired)
    assert.equal(lastAudit(bench, 'device.revoke')?.result, 'refused:challenge')
    assert.equal(bench.registry.get(id)?.state, 'active')
    s.leg.close()
  })

  test('a proof used twice (the same uvCtr) is refused; a proof of another session is refused', async () => {
    const a = await connect()
    const b = await connect()
    const c = await challenge(a, 'unlock')
    const proof = await auth.assert(c.challenge, c.uvCtr)
    assert.equal((await a.request(OP.assert, {}, { actId: actId(), uvProof: proof })).status, RES_STATUS.ok)
    assert.equal((await a.request(OP.assert, {}, { actId: actId(), uvProof: proof })).status, RES_STATUS.presenceRequired, 'the challenge is gone')
    assert.equal(lastAudit(bench, 'uv.assert')?.result, 'refused:challenge')

    // B's pending challenge has this counter; the proof signs the challenge of the same counter in session A.
    const cb = await challenge(b, 'unlock')
    const forA = await auth.assert(await assertionChallenge(a.session.sessionId, cb.uvCtr, { purpose: 'unlock' }), cb.uvCtr)
    assert.equal((await b.request(OP.assert, {}, { actId: actId(), uvProof: forA })).status, RES_STATUS.presenceRequired, 'another session')
    assert.equal(lastAudit(bench, 'uv.assert')?.result, 'refused:challenge')
    assert.equal((await b.request(OP.info, {}, { uvProof: forA })).status, RES_STATUS.badRequest, 'a proof where none is checked')
    // A valid proof clears the count of invalid ones, so the later tests start from zero.
    assert.equal((await present(a, auth)).status, RES_STATUS.ok)
    a.leg.close()
    b.leg.close()
  })

  test('elevation: a window of 15 min that a reconnection neither opens nor renews; session.lock closes it for every session', async () => {
    const s = await connect()
    const t0 = Math.floor(Date.now() / 1000)
    const el = await present(s, auth, 'elevate')
    assert.equal(el.status, RES_STATUS.ok)
    const until15 = el.body.elevUntil as number
    assert.ok(until15 >= t0 + 15 * 60 && until15 <= t0 + 15 * 60 + 2, 'ELEV_WINDOW from the assertion')
    const again = await connect()
    assert.deepEqual([again.info!.presence, again.info!.elevUntil], [PRESENCE.unlocked, until15], 'HS_DONE says the same window')
    assert.deepEqual((await again.request(OP.lock, {}, { actId: actId() })).body, { presence: PRESENCE.locked, elevUntil: 0 })
    assert.equal((await s.request(OP.list)).status, RES_STATUS.locked, 'the lock holds for the whole device')
    s.leg.close()
    again.leg.close()
    const third = await connect()
    assert.deepEqual([third.info!.presence, third.info!.elevUntil], [PRESENCE.locked, 0], 'reconnecting does not unlock')
    assert.equal((await present(third, auth)).status, RES_STATUS.ok)
    third.leg.close()
  })

  test('two assertions of the same device at once are verified one after the other: the second meets the counter the first wrote', async () => {
    const a = await connect()
    const b = await connect()
    const [ca, cb] = await Promise.all([challenge(a, 'unlock'), challenge(b, 'unlock')])
    const [pa, pb] = await Promise.all([auth.assert(ca.challenge, ca.uvCtr, { signCount: 5 }), auth.assert(cb.challenge, cb.uvCtr, { signCount: 5 })])
    const before = bench.audits().length
    const answers = await Promise.all([
      a.request(OP.assert, {}, { actId: actId(), uvProof: pa }),
      b.request(OP.assert, {}, { actId: actId(), uvProof: pb }),
    ])
    assert.deepEqual(answers.map((r) => r.status).sort(), [RES_STATUS.ok, RES_STATUS.presenceRequired])
    const lines = bench.audits().slice(before)
    assert.equal(lines.filter((l) => l.act === 'uv.sign-count').length, 1, 'the counter refusal has its own line')
    assert.deepEqual(lines.filter((l) => l.act === 'uv.assert').map((l) => l.result).sort(), ['ok:unlock', 'refused:sign-count'])
    assert.equal(bench.registry.get(id)?.credential?.signCount, 5, 'written before the answer')
    assert.equal(bench.asks.filter((x) => x.ask === 'sign-count').length, 1)
    a.leg.close()
    b.leg.close()
  })

  test('the credential outlives a restart of the portal; the presence does not', async () => {
    await bench.restart()
    const s = await connect()
    assert.deepEqual([s.info!.presence, s.info!.elevUntil], [PRESENCE.locked, 0], 'a credential, and locked: the memory went with the portal')
    assert.equal((await present(s, auth, 'unlock', { signCount: 5 })).status, RES_STATUS.presenceRequired, 'the stored counter came back too')
    assert.deepEqual((await present(s, auth, 'unlock', { signCount: 6 })).body, { presence: PRESENCE.unlocked, elevUntil: 0 })
    s.leg.close()
  })

  test('refusals by the counter do not lock out; five invalid proofs close the sessions and lock the device out for 5 min', async () => {
    const s = await connect()
    for (let i = 0; i < 4; i++) assert.equal((await present(s, auth, 'unlock', { signCount: 3 })).status, RES_STATUS.presenceRequired)
    for (let i = 0; i < 4; i++) assert.equal((await present(s, auth, 'unlock', { signCount: 7, origin: 'https://evil.example' })).status, RES_STATUS.presenceRequired)
    assert.equal(lastAudit(bench, 'uv.lockout'), undefined, 'four counter refusals and four invalid proofs: no lockout')
    assert.equal((await present(s, auth, 'unlock', { signCount: 7 })).status, RES_STATUS.ok, 'a valid proof starts the count again')
    const other = await connect()
    for (let i = 0; i < 4; i++) assert.equal((await present(s, auth, 'unlock', { signCount: 8, origin: 'https://evil.example' })).status, RES_STATUS.presenceRequired)
    assert.equal((await present(s, auth, 'unlock', { signCount: 8, origin: 'https://evil.example' })).status, RES_STATUS.presenceRequired)
    await until(() => (s.closed && other.closed) || undefined, 5_000, 'every session of the device closed')
    assert.deepEqual([s.closed!.code, other.closed!.code], [CLOSE.limit, CLOSE.limit])
    assert.deepEqual([lastAudit(bench, 'uv.lockout')?.result, lastAudit(bench, 'uv.lockout')?.deviceId], ['locked', id])
    const back = await connect()
    assert.equal(back.info!.presence, PRESENCE.locked, 'the lockout dropped the unlock')
    assert.equal((await back.request(OP.challenge, { purpose: 'unlock' })).status, RES_STATUS.limit, 'locked out')
    back.leg.close()
  })
})

// Test 56 of fio-spec 9.2 (E-11): only a gesture resets the idle clock. A PWA that follows who waits and reads in the
// background for 16 min, by the portal's clock, is locked at IDLE_LOCK; the session family stays, and a proof unlocks.
describe('idle by background reads (fio-spec 9.2 test 56)', () => {
  let bench: HouseBench
  let offsetMs = 0
  const STEP_MS = 30_000 // under HB_TIMEOUT: every step carries a record, so the session lives while the clock runs
  before(async () => {
    bench = await startHouseBench({
      origin: ORIGIN, now: () => Date.now() + offsetMs,
      limits: { reqPerDevicePerMin: 10_000, gesturesPerDevicePerMin: 10_000, hsPerTicketPerMin: 1_000 },
    })
  })
  after(async () => { await bench?.stop() })

  test('16 min of attention.watch, attention.list, session.info and uv.challenge without a gesture: locked; uv.assert unlocks', async () => {
    const auth = await SoftAuthenticator.make()
    const fresh = bench.fresh
    const reg = await fresh.request(OP.register, await auth.register(await registrationChallenge(fresh.session.sessionId, bench.device.kD.pub)), { actId: actId() })
    assert.equal(reg.status, RES_STATUS.ok)
    fresh.leg.close()
    const s = await bench.connect()
    assert.equal((await present(s, auth)).status, RES_STATUS.ok, 'the last gesture: the unlock')
    assert.equal((await s.request(OP.watch)).status, RES_STATUS.ok)

    const steps = 32 // 16 min
    const idleSteps = 15 * 60_000 / STEP_MS
    for (let i = 1; i <= steps; i++) {
      offsetMs += STEP_MS
      const want = i < idleSteps ? RES_STATUS.ok : RES_STATUS.locked
      assert.equal((await s.request(i % 2 ? OP.list : OP.watch)).status, want, `background read at ${i * STEP_MS / 1000} s`)
      assert.equal((await s.request(OP.info)).status, RES_STATUS.ok, 'the session family answers')
      assert.equal((await s.request(OP.challenge, { purpose: 'unlock' })).status, RES_STATUS.ok, 'a challenge is no gesture')
    }
    assert.equal(s.closed, undefined, 'background reads keep the session, never the unlock')
    assert.equal((await s.request(OP.info)).body.presence, PRESENCE.locked)
    assert.equal((await s.request(OP.list)).status, RES_STATUS.locked)

    assert.deepEqual((await present(s, auth)).body, { presence: PRESENCE.unlocked, elevUntil: 0 }, 'uv.challenge + uv.assert unlock again')
    assert.equal((await s.request(OP.list)).status, RES_STATUS.ok)
    s.leg.close()
  })
})

describe('the registry keeps the credential (extensions/remote/rules.ts)', () => {
  const entry = (o: Partial<DeviceEntry> = {}): DeviceEntry => ({
    deviceId: 'ab'.repeat(16), pubD: '04' + '11'.repeat(64), name: 'x', access: 'code', state: 'active', scopes: [], createdAt: '2026-11-27T00:00:00.000Z',
    maxVerUsed: 1, tickets: [], usedKeyIds: [], denied: [], ...o,
  })
  const credential = { credentialId: b64url(new Uint8Array(16)), publicKey: '04' + '22'.repeat(64), signCount: 3, backupEligible: true }

  test('it reads back what it wrote; a malformed credential drops the entry; the screen sees only whether there is one', () => {
    const back = parseRegistry(serializeRegistry([entry({ credential })]))
    assert.deepEqual([back.dropped, back.devices[0]?.credential], [0, credential])
    assert.equal(parseRegistry(serializeRegistry([entry({ credential: { ...credential, publicKey: '04' } })])).dropped, 1)
    assert.equal(deviceView(entry({ credential })).biometrics, true)
    assert.equal(deviceView(entry()).biometrics, false)
    assert.doesNotMatch(JSON.stringify(deviceView(entry({ credential }))), /2222|credentialId/)
  })
})
