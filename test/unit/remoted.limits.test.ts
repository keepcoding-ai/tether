// The limits of the portal in one place (src/remoted/limits.ts; fio-spec 5.8; plano §2 "DoS na casa pelo relay"): the
// values that existed stay what they were, the house keeps none of its own, and a device that goes over its rate is
// answered `limit`, leaves a line and, if it insists, loses the session.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  CERT_ROLE_TICKET, CLOSE, decodeOuter, encodeOuter, generateRoleKey, issueKeyCert, MAX_INNER, RES_STATUS, ROUTE_KIND, ROUTES_PER_HOUSE,
  SESSIONS_PER_DEVICE,
} from '../../src/remote/index.ts'
import { AttentionView } from '../../src/remoted/attention.ts'
import { House } from '../../src/remoted/house.ts'
import { DeviceLimiter, LIMITS } from '../../src/remoted/limits.ts'
import { startHouseBench, type HouseBench } from './remoted.house-bench.ts'
import { until } from './remoted.helpers.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const OP = { info: 0x0001, lock: 0x0007 }
const actId = (): Uint8Array<ArrayBuffer> => crypto.getRandomValues(new Uint8Array(16))

describe('the limits that already existed keep their values and live in one place', () => {
  test('values of spec 5.8 and of the portal, unchanged', () => {
    assert.deepEqual(
      { r: LIMITS.routesPerHouse, d: LIMITS.sessionsPerDevice, s: LIMITS.sessionsMax, h: LIMITS.hsPerTicketPerMin, p: LIMITS.hsPendingMax, deny: LIMITS.hsRateDenyS, i: LIMITS.inflightMax, q: LIMITS.routeQueueMax },
      { r: ROUTES_PER_HOUSE, d: SESSIONS_PER_DEVICE, s: 32, h: 6, p: 32, deny: 600, i: 16, q: 32 },
    )
    assert.ok(Object.isFrozen(LIMITS))
  })

  test('the house declares no limit of its own', () => {
    const src = readFileSync(join(ROOT, 'src', 'remoted', 'house.ts'), 'utf8')
    assert.doesNotMatch(src, /\bconst (HS_PER_TICKET_PER_MIN|HS_PENDING_MAX|HS_RATE_DENY_S|INFLIGHT_MAX|SESSIONS_MAX|ROUTE_QUEUE_MAX)\b/)
  })
})

// B-3 of the RR2 gate (B10): the queue of a route was counted in frames only, so a relay could hold 32 frames of MAX_INNER
// on each of 32 routes (256 MiB) in the portal. Now bytes per route and per house, too; over either, the route goes.
describe('the frames waiting in the portal have a ceiling in bytes, per route and for the house', () => {
  test('a relay that sends 32 frames of MAX_INNER on 32 routes without waiting: the routes are cut, the memory stays under the ceiling', async () => {
    assert.deepEqual([LIMITS.routeQueueBytesMax, LIMITS.houseQueueBytesMax], [1024 * 1024, 8 * 1024 * 1024])
    const kH = (await generateRoleKey('house')).key
    const kT = (await generateRoleKey('ticket')).key
    const nowS = Math.floor(Date.now() / 1000)
    const certT = await issueKeyCert(kH, { role: CERT_ROLE_TICKET, pub: kT.pub, notBefore: nowS - 60, notAfter: nowS + 86_400 })
    const closed = new Set<number>()
    const house = new House({
      keys: { kH, kT, certT }, aud: 'localhost:9', houseName: 'Casa de teste', attention: new AttentionView(),
      send: (b) => { const f = decodeOuter('house', 'end', b); if (f.type === 'ROUTE_CLOSE') closed.add(f.routeId) },
      ask: async () => {}, note: () => {}, notice: () => {}, log: () => {}, now: Date.now,
      // Every route an admission, so the 32 of them fit: the handshake ceilings are not what this test is about.
      limits: { hsPerTicketPerMin: 1_000, hsPendingMax: 64 },
    })
    await house.init([], [])
    house.linkUp()
    const frame = (route: number): Uint8Array => encodeOuter({ type: 'ROUTE_DATA', routeId: route, inner: new Uint8Array(MAX_INNER) })
    let peak = 0
    // One synchronous burst: nothing is dispatched before the relay's last frame is in (the worst case for the queue).
    for (let route = 1; route <= ROUTES_PER_HOUSE; route++) {
      house.onFrame(encodeOuter({ type: 'ROUTE_OPEN', routeId: route, kind: ROUTE_KIND.admit, hint: crypto.getRandomValues(new Uint8Array(16)) }))
      const f = frame(route)
      for (let i = 0; i < 32; i++) { house.onFrame(f); peak = Math.max(peak, house.queuedBytes) }
    }
    assert.ok(peak <= LIMITS.houseQueueBytesMax, `the portal held ${peak} bytes at most`)
    assert.equal(closed.size, ROUTES_PER_HOUSE, 'every route went: four frames fill one, eight routes fill the house')
    await until(() => house.queuedBytes === 0 || undefined, 10_000, 'the frames of the cut routes released')

    // Within the ceilings, nothing is cut: four frames of MAX_INNER fit one route exactly.
    closed.clear()
    house.onFrame(encodeOuter({ type: 'ROUTE_OPEN', routeId: 100, kind: ROUTE_KIND.admit, hint: crypto.getRandomValues(new Uint8Array(16)) }))
    for (let i = 0; i < 4; i++) house.onFrame(frame(100))
    assert.equal(house.queuedBytes, 4 * MAX_INNER)
    assert.equal(closed.has(100), false, 'four fit')
    house.onFrame(frame(100))
    assert.equal(closed.has(100), true, 'the fifth passes 1 MiB: the route goes')
    await house.shutdown()
  })
})

describe('the rate of one device', () => {
  const lim = { reqPerDevicePerMin: 3, gesturesPerDevicePerMin: 2, strikesMax: 3 }

  test('over the ceiling → limit, a third strike → close; a refused request does not use the window; a minute later it is fresh', () => {
    const l = new DeviceLimiter(lim)
    assert.deepEqual([0, 1, 2].map((t) => l.request(t)), ['ok', 'ok', 'ok'])
    assert.deepEqual([3, 4, 5].map((t) => l.request(t)), ['limit', 'limit', 'close'])
    assert.equal(l.request(60_002), 'ok', 'the first window ended; the strikes slide too')
  })

  test('gestures have their own, lower ceiling', () => {
    const l = new DeviceLimiter(lim)
    assert.deepEqual([0, 1, 2].map((t) => l.gesture(t)), ['ok', 'ok', 'limit'])
    assert.equal(l.request(3), 'ok', 'a gesture over its rate does not use the request window')
  })

  test('memory does not grow with the flood: a thousand refused requests keep the lists at their ceilings', () => {
    const l = new DeviceLimiter(lim)
    for (let t = 0; t < 1000; t++) l.request(t)
    assert.equal(l.request(1001), 'close')
  })

  test('the defaults are the ones of limits.ts', () => {
    assert.ok(LIMITS.reqPerDevicePerMin > LIMITS.gesturesPerDevicePerMin)
    assert.ok(LIMITS.strikesMax >= 2)
  })
})

describe('a device over its rate, on a house in this process: limit, a line, then the session ends', () => {
  let bench: HouseBench
  after(async () => { await bench?.stop() })

  test('requests: the ones over the ceiling answer 0x07 and leave `limit.req`; the one that insists closes the session with CLOSE(0x07)', async () => {
    bench = await startHouseBench({ limits: { reqPerDevicePerMin: 4, gesturesPerDevicePerMin: 2, strikesMax: 3 } })
    const s = await bench.connect()
    const statuses: number[] = []
    for (let i = 0; i < 6; i++) statuses.push((await s.request(OP.info)).status)
    assert.deepEqual(statuses, [0, 0, 0, 0, RES_STATUS.limit, RES_STATUS.limit])
    // The third strike has no answer: the session goes.
    void s.request(OP.info).catch(() => undefined) // never answered: the session ends instead
    await until(() => s.closed || undefined, 5_000, 'the session closed by the house')
    assert.equal(s.closed!.code, CLOSE.limit)
    const lines = bench.audits().filter((a) => a.act === 'limit.req')
    assert.deepEqual(lines.map((a) => a.result), ['limit', 'limit', 'close'])
    assert.ok(lines.every((a) => a.deviceId && a.target === 'session.info'))
    assert.ok(bench.audits().some((a) => a.act === 'session.end' && a.deviceId === lines[0]!.deviceId), 'the end of the session is recorded')
  })

  test('the counters outlive the session: the same device, reconnecting at once, is closed again at its first request', async () => {
    const s = await bench.connect()
    void s.request(OP.info).catch(() => undefined)
    await until(() => s.closed || undefined, 5_000, 'the second session closed by the house')
    assert.equal(s.closed!.code, CLOSE.limit)
  })

  // B-1 of the RR3 gate: the ceiling of requests in flight came before the rate, so a device holding its slow reads open
  // was answered `limit` for every further REQ without it counting, and "insisting closes the session" never came.
  test('in flight: a request over the ceiling still counts in the rate, and insisting closes the session', async () => {
    await bench.stop()
    const held: Array<() => void> = []
    const reads = { read: () => new Promise<unknown>((res) => { held.push(() => res({ channels: [] })) }) }
    bench = await startHouseBench({ reads, limits: { reqPerDevicePerMin: 4, gesturesPerDevicePerMin: 2, strikesMax: 3, inflightMax: 2 } })
    const s = await bench.connect()
    // Two reads that tetherd does not answer fill the session's ceiling (a page each: the marks are shared by the portal).
    const open = [s.request(0x0201, { channel: 'c_1' }), s.request(0x0201, { channel: 'c_2' })].map((p) => p.catch(() => undefined))
    await until(() => held.length === 2 || undefined, 5_000, 'both reads at the pipe')
    const statuses: number[] = []
    for (let i = 0; i < 4; i++) statuses.push((await s.request(OP.info)).status)
    assert.deepEqual(statuses, [RES_STATUS.limit, RES_STATUS.limit, RES_STATUS.limit, RES_STATUS.limit], 'two over the flight, then two over the rate')
    void s.request(OP.info).catch(() => undefined)
    await until(() => s.closed || undefined, 5_000, 'the session closed by the rate')
    assert.equal(s.closed!.code, CLOSE.limit)
    assert.deepEqual(bench.audits().filter((a) => a.act === 'limit.req').map((a) => a.result), ['limit', 'limit', 'close'])
    for (const h of held.splice(0)) h()
    await Promise.allSettled(open)
  })

  test('gestures: a lower ceiling of their own, recorded with the operation they were', async () => {
    await bench.stop()
    bench = await startHouseBench({ limits: { reqPerDevicePerMin: 100, gesturesPerDevicePerMin: 2, strikesMax: 5 } })
    const s = await bench.connect()
    const st: number[] = []
    for (let i = 0; i < 3; i++) st.push((await s.request(OP.lock, {}, { actId: actId() })).status)
    assert.deepEqual(st, [RES_STATUS.ok, RES_STATUS.ok, RES_STATUS.limit], 'session.lock, then limit')
    const line = bench.audits().find((a) => a.act === 'limit.gesture')
    assert.deepEqual({ target: line?.target, result: line?.result }, { target: 'session.lock', result: 'limit' })
  })
})
