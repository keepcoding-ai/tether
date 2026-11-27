// The limits of the portal in one place (src/remoted/limits.ts; fio-spec 5.8; plano §2 "DoS na casa pelo relay"): the
// values that existed stay what they were, the house keeps none of its own, and a device that goes over its rate is
// answered `limit`, leaves a line and, if it insists, loses the session.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { CLOSE, RES_STATUS, ROUTES_PER_HOUSE, SESSIONS_PER_DEVICE } from '../../src/remote/index.ts'
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

  test('gestures: a lower ceiling of their own, recorded with the operation they were', async () => {
    await bench.stop()
    bench = await startHouseBench({ limits: { reqPerDevicePerMin: 100, gesturesPerDevicePerMin: 2, strikesMax: 5 } })
    const s = await bench.connect()
    const st: number[] = []
    for (let i = 0; i < 3; i++) st.push((await s.request(OP.lock, {}, { actId: actId() })).status)
    assert.deepEqual(st, [RES_STATUS.failed, RES_STATUS.failed, RES_STATUS.limit], 'session.lock has no handler yet: failed, then limit')
    const line = bench.audits().find((a) => a.act === 'limit.gesture')
    assert.deepEqual({ target: line?.target, result: line?.result }, { target: 'session.lock', result: 'limit' })
  })
})
