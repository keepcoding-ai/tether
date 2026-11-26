// Relay core (fio-spec 5, passo 1.2), with no socket: admission, routing between houses and devices, the limits
// and the shutdown. Negative tests of spec 9.2 are named with their number; the socket-level ones (timing, ws
// options, real backpressure) are in remote-relay.wire.timing.test.ts.
import { describe as nodeDescribe, test } from 'node:test'
import assert from 'node:assert/strict'
import { DENY_MAX, encodeOuter, randomBytes, toHex, type OuterFrame } from '../../src/remote/index.ts'
import { RelayCore, type Peer } from '../../remote/relay/src/core.ts'
import { RELAY_LIMITS, type RelayLimits } from '../../remote/relay/src/limits.ts'
import type { Device, Home } from '../../remote/relay/test/fixtures.ts'
import { relayDepsMissing } from '../../remote/relay/test/deps.ts'

// The fixtures load `ws`, a dependency of the relay package only: without `npm ci` there, the file skips.
const SKIP = relayDepsMissing()
const describe = (name: string, fn: () => void): void => { nodeDescribe(name, { skip: SKIP }, fn) }
const fx = SKIP ? ({} as typeof import('../../remote/relay/test/fixtures.ts')) : await import('../../remote/relay/test/fixtures.ts')
const { data, deviceAdmit, dPair, FakeConn, houseAuth, makeDevice, makeHome, routeData, sleep, until } = fx
type FakeConn = InstanceType<typeof fx.FakeConn>

const AUD = 'relay.test:8443'
type Frame<T extends OuterFrame['type']> = Extract<OuterFrame, { type: T }>

function relay(limits: Partial<RelayLimits> = {}): { core: RelayCore; logs: string[] } {
  const logs: string[] = []
  const core = new RelayCore({ aud: AUD, limits: { failDelayMs: 30, ...limits }, log: (e, f) => logs.push(JSON.stringify({ e, ...f })) })
  return { core, logs }
}

let ipSeq = 0
const nextIp = (): string => `10.0.${(++ipSeq >> 8) & 255}.${ipSeq & 255}`

/** `contesting`: the live house of the same key, which gets LINK_PING while this one waits for no verdict. */
async function house(core: RelayCore, h: Home, contesting?: FakeConn): Promise<{ conn: FakeConn; peer: Peer }> {
  const conn = new FakeConn()
  const peer = core.attach(conn, 'house', nextIp())!
  const ch = conn.frames('house')[0]!
  assert.equal(ch.type, 'R_CHALLENGE')
  core.message(peer, await houseAuth(h, (ch as Frame<'R_CHALLENGE'>).r, AUD), true)
  if (contesting) await until(() => contesting.last('house')?.type === 'LINK_PING', 3000, 'LINK_PING to the live house')
  else await until(() => conn.sent.length >= 2, 3000, 'house verdict')
  return { conn, peer }
}

async function device(core: RelayCore, d: Device, o: { ip?: string } = {}): Promise<{ conn: FakeConn; peer: Peer; reply: string }> {
  const conn = new FakeConn()
  const peer = core.attach(conn, 'device', o.ip ?? nextIp())!
  const hello = conn.frames('device')[0] as Frame<'R_HELLO'>
  assert.equal(hello.type, 'R_HELLO')
  core.message(peer, await deviceAdmit(d, hello.nR, AUD), true)
  await until(() => conn.sent.length >= 2, 3000, 'device verdict')
  return { conn, peer, reply: conn.frames('device')[1]!.type }
}

const routeOpens = (conn: FakeConn): Frame<'ROUTE_OPEN'>[] =>
  conn.frames('house').filter((f): f is Frame<'ROUTE_OPEN'> => f.type === 'ROUTE_OPEN')

describe('relay core: admission', () => {
  test('a house proves its key; a device with a ticket of that house gets R_OK and a route', async () => {
    const { core } = relay()
    const h = await makeHome()
    const hs = await house(core, h)
    assert.equal(hs.conn.last('house')?.type, 'R_AUTH_OK')
    const d = await makeDevice(h, AUD)
    const dv = await device(core, d)
    assert.equal(dv.reply, 'R_OK')
    const open = routeOpens(hs.conn)
    assert.equal(open.length, 1)
    assert.equal(open[0]!.kind, 0x01)
    assert.equal(toHex(open[0]!.hint), toHex(d.ticketId), 'the hint of an admission route is the ticketId')
    assert.deepEqual({ houses: core.stats().houses, routes: core.stats().routes }, { houses: 1, routes: 1 })
    core.shutdown()
  })

  test('a house whose H_AUTH does not verify gets the constant R_AUTH_FAIL and a close 1000', async () => {
    const { core } = relay()
    const h = await makeHome()
    const conn = new FakeConn()
    const peer = core.attach(conn, 'house', nextIp())!
    core.message(peer, await houseAuth(h, randomBytes(32), AUD), true) // the answer to another challenge
    await until(() => conn.closedWith !== undefined)
    assert.deepEqual(conn.last('house'), { type: 'R_AUTH_FAIL', code: 0 })
    assert.equal(conn.closedWith, 1000)
    assert.equal(core.stats().houses, 0)
    core.shutdown()
  })

  test('28: D_ADMIT with no proof, a proof of another key, or the n_R of another socket: R_FAIL and close 1000', async () => {
    const { core } = relay()
    const h = await makeHome()
    await house(core, h)
    const d = await makeDevice(h, AUD)
    const other = await makeDevice(h, AUD)
    const cases: [string, (nR: Uint8Array) => Promise<Uint8Array>][] = [
      ['no proof', async nR => { const b = await deviceAdmit(d, nR, AUD); b.fill(0, b.length - 64); return b }],
      ['proof by another key', async nR => {
        const b = await deviceAdmit(other, nR, AUD)
        const mine = await deviceAdmit(d, nR, AUD)
        return Uint8Array.from([...mine.subarray(0, mine.length - 64), ...b.subarray(b.length - 64)])
      }],
      ['n_R of another socket', async () => deviceAdmit(d, randomBytes(32), AUD)],
    ]
    for (const [name, build] of cases) {
      const conn = new FakeConn()
      const peer = core.attach(conn, 'device', nextIp())!
      const hello = conn.frames('device')[0] as Frame<'R_HELLO'>
      core.message(peer, await build(hello.nR), true)
      await until(() => conn.closedWith !== undefined, 3000, name)
      assert.deepEqual(conn.types('device'), ['R_HELLO', 'R_FAIL'], name)
      assert.equal(conn.closedWith, 1000, name)
    }
    assert.equal(core.stats().routes, 0)
    core.shutdown()
  })

  test('before admission only one D_ADMIT or D_PAIR: text, oversize, a DATA or a second frame closes', async () => {
    const { core } = relay({ failDelayMs: 200 })
    const h = await makeHome()
    await house(core, h)
    const d = await makeDevice(h, AUD)
    const open = (): { conn: FakeConn; peer: Peer; nR: Uint8Array } => {
      const conn = new FakeConn()
      const peer = core.attach(conn, 'device', nextIp())!
      return { conn, peer, nR: (conn.frames('device')[0] as Frame<'R_HELLO'>).nR }
    }
    const a = open(); core.message(a.peer, new Uint8Array([1, 3, ...randomBytes(16)]), false)
    assert.equal(a.conn.closedWith, 1003, 'a text frame closes')
    const b = open(); core.message(b.peer, new Uint8Array(4097), true)
    assert.equal(b.conn.closedWith, 1009, 'above MAX_PRE_AUTH')
    const c = open(); core.message(c.peer, data(randomBytes(10)), true)
    assert.equal(c.conn.closedWith, 1008, 'DATA before admission')
    const e = open()
    core.message(e.peer, await deviceAdmit(d, e.nR, AUD), true)
    core.message(e.peer, data(randomBytes(10)), true)
    assert.equal(e.conn.closedWith, 1008, 'anything after the one D_ADMIT, before the verdict')
    await sleep(250)
    assert.deepEqual(e.conn.types('device'), ['R_HELLO'], 'no verdict reaches a dropped socket')
    const hc = new FakeConn()
    const hp = core.attach(hc, 'house', nextIp())!
    core.message(hp, encodeOuter({ type: 'LINK_PING', echo: randomBytes(8) }), true)
    assert.equal(hc.closedWith, 1008, 'a house frame other than H_AUTH before authentication')
    core.shutdown()
  })

  test('33 (core): no request within the auth deadline closes; the default deadline is AUTH_DEADLINE', async () => {
    assert.equal(RELAY_LIMITS.authDeadlineMs, 10_000)
    const { core } = relay({ authDeadlineMs: 60 })
    const dc = new FakeConn(); core.attach(dc, 'device', nextIp())
    const hc = new FakeConn(); core.attach(hc, 'house', nextIp())
    await until(() => dc.closedWith !== undefined && hc.closedWith !== undefined, 2000)
    assert.equal(dc.closedWith, 1008)
    assert.equal(core.stats().peers, 0)
    core.shutdown()
  })
})

describe('relay core: routing and isolation', () => {
  test('two houses, two devices: each DATA reaches only its own house, each ROUTE_DATA only its own device', async () => {
    const { core } = relay()
    const [hA, hB] = [await makeHome(), await makeHome()]
    const A = await house(core, hA)
    const B = await house(core, hB)
    const dA = await device(core, await makeDevice(hA, AUD))
    const dB = await device(core, await makeDevice(hB, AUD))
    assert.equal(dA.reply, 'R_OK')
    assert.equal(dB.reply, 'R_OK')
    const rA = routeOpens(A.conn)[0]!.routeId
    const rB = routeOpens(B.conn)[0]!.routeId
    core.message(dA.peer, data(Uint8Array.of(0x20, 0xaa)), true)
    core.message(dB.peer, data(Uint8Array.of(0x20, 0xbb)), true)
    assert.deepEqual(A.conn.last('house'), { type: 'ROUTE_DATA', routeId: rA, inner: Uint8Array.of(0x20, 0xaa) })
    assert.deepEqual(B.conn.last('house'), { type: 'ROUTE_DATA', routeId: rB, inner: Uint8Array.of(0x20, 0xbb) })
    core.message(A.peer, routeData(rA, Uint8Array.of(0x20, 0x01)), true)
    core.message(B.peer, routeData(rB, Uint8Array.of(0x20, 0x02)), true)
    assert.deepEqual(dA.conn.last('device'), { type: 'DATA', inner: Uint8Array.of(0x20, 0x01) })
    assert.deepEqual(dB.conn.last('device'), { type: 'DATA', inner: Uint8Array.of(0x20, 0x02) })
    assert.equal(dA.conn.types('device').filter(t => t === 'DATA').length, 1)
    assert.equal(dB.conn.types('device').filter(t => t === 'DATA').length, 1)
    core.shutdown()
  })

  test('30: ROUTE_DATA or ROUTE_CLOSE to a routeId of another house is dropped and counted; three close that house', async () => {
    const { core, logs } = relay()
    const [hA, hB] = [await makeHome(), await makeHome()]
    const A = await house(core, hA)
    const B = await house(core, hB)
    const dA = await device(core, await makeDevice(hA, AUD))
    const rA = routeOpens(A.conn)[0]!.routeId
    // House B has no routes, so a guess at A's routeId (both start at 1) is exactly the IDOR of M-2.
    core.message(B.peer, routeData(rA, Uint8Array.of(0x20, 0x66)), true)
    core.message(B.peer, encodeOuter({ type: 'ROUTE_CLOSE', routeId: rA }), true)
    assert.equal(B.conn.closedWith, undefined, 'two discards keep the socket')
    core.message(B.peer, routeData(rA + 7, Uint8Array.of(0x20, 0x66)), true)
    assert.equal(B.conn.closedWith, 1008, 'the third closes the house socket')
    assert.deepEqual(dA.conn.types('device'), ['R_HELLO', 'R_OK'], 'nothing of B reached the device of A')
    assert.equal(dA.conn.closedWith, undefined, 'and its route is still open')
    assert.equal(logs.filter(l => l.includes('route.discard')).length, 3)
    assert.equal(core.stats().houses, 1)
    core.shutdown()
  })

  test('the device closing sends ROUTE_CLOSE to its house; ROUTE_CLOSE from the house closes the device with 1000', async () => {
    const { core } = relay()
    const h = await makeHome()
    const H = await house(core, h)
    const d1 = await device(core, await makeDevice(h, AUD))
    const d2 = await device(core, await makeDevice(h, AUD))
    const [r1, r2] = routeOpens(H.conn).map(f => f.routeId)
    assert.notEqual(r1, r2)
    core.closed(d1.peer)
    assert.deepEqual(H.conn.last('house'), { type: 'ROUTE_CLOSE', routeId: r1 })
    core.message(H.peer, encodeOuter({ type: 'ROUTE_CLOSE', routeId: r2! }), true)
    assert.equal(d2.conn.closedWith, 1000)
    assert.equal(core.stats().routes, 0)
    core.shutdown()
  })

  test('the house going down closes its routes and forgets its listen and deny list', async () => {
    const { core } = relay()
    const h = await makeHome()
    const H = await house(core, h)
    const d = await device(core, await makeDevice(h, AUD))
    core.message(H.peer, encodeOuter({ type: 'H_PAIR_LISTEN', ttl: 60, rvs: [randomBytes(16)] }), true)
    assert.equal(core.stats().listens, 1)
    core.closed(H.peer)
    assert.equal(d.conn.closedWith, 1001)
    assert.deepEqual(
      { houses: core.stats().houses, routes: core.stats().routes, listens: core.stats().listens, peers: core.stats().peers },
      { houses: 0, routes: 0, listens: 0, peers: 0 },
    )
    core.shutdown()
  })

  test(`a house has at most ROUTES_PER_HOUSE routes; one more gets the uniform R_FAIL`, async () => {
    const { core } = relay({ routesPerHouse: 3 })
    const h = await makeHome()
    await house(core, h)
    for (let i = 0; i < 3; i++) assert.equal((await device(core, await makeDevice(h, AUD))).reply, 'R_OK')
    const extra = await device(core, await makeDevice(h, AUD))
    assert.equal(extra.reply, 'R_FAIL')
    assert.equal(extra.conn.closedWith, 1000)
    assert.equal(RELAY_LIMITS.routesPerHouse, 32)
    core.shutdown()
  })
})

describe('relay core: queues', () => {
  test('35 (core): a device whose queue is above 1 MiB loses its route at once; the house and the other route stay', async () => {
    const { core } = relay()
    const h = await makeHome()
    const H = await house(core, h)
    const slow = await device(core, await makeDevice(h, AUD))
    const fast = await device(core, await makeDevice(h, AUD))
    const [rSlow, rFast] = routeOpens(H.conn).map(f => f.routeId)
    slow.conn.bufferedBytes = RELAY_LIMITS.routeQueueBytes - 100
    core.message(H.peer, routeData(rSlow!, new Uint8Array(200).fill(0x20)), true)
    assert.equal(slow.conn.closedWith, 'terminate', 'dropped, not queued')
    assert.deepEqual(H.conn.last('house'), { type: 'ROUTE_CLOSE', routeId: rSlow })
    // Frames the house still had in flight to its own dropped route are the race of a closing route, not a probe.
    for (let i = 0; i < 5; i++) core.message(H.peer, routeData(rSlow!, new Uint8Array(200).fill(0x20)), true)
    core.message(H.peer, encodeOuter({ type: 'ROUTE_CLOSE', routeId: rSlow! }), true)
    core.message(H.peer, routeData(rFast!, new Uint8Array(200).fill(0x20)), true)
    assert.equal(fast.conn.last('device')?.type, 'DATA')
    assert.equal(H.conn.closedWith, undefined)
    core.shutdown()
  })

  test('a route that writes into a house queue above 8 MiB is dropped; the relay does not hold its bytes', async () => {
    const { core } = relay()
    const h = await makeHome()
    const H = await house(core, h)
    const d = await device(core, await makeDevice(h, AUD))
    const before = H.conn.sent.length
    H.conn.bufferedBytes = RELAY_LIMITS.houseQueueBytes
    core.message(d.peer, data(new Uint8Array(1000).fill(0x20)), true)
    assert.equal(d.conn.closedWith, 'terminate')
    assert.deepEqual(H.conn.sent.slice(before).map(b => b[1]), [0x32], 'only the ROUTE_CLOSE went to the house')
    assert.equal(H.conn.closedWith, undefined)
    core.shutdown()
  })
})

describe('relay core: deny list and revocation', () => {
  test('37 (core): H_DENY with the ticket of a live route closes it now; the next D_ADMIT of that ticket gets R_FAIL', async () => {
    const { core } = relay()
    const h = await makeHome()
    const H = await house(core, h)
    const d = await makeDevice(h, AUD)
    const live = await device(core, d)
    assert.equal(live.reply, 'R_OK')
    const exp = Math.floor(Date.now() / 1000) + 3600
    core.message(H.peer, encodeOuter({ type: 'H_DENY', entries: [{ ticketId: d.ticketId, exp }], overflow: false }), true)
    assert.equal(live.conn.closedWith, 1000)
    assert.equal(H.conn.last('house')?.type, 'ROUTE_CLOSE')
    const again = await device(core, d)
    assert.equal(again.reply, 'R_FAIL')
    core.shutdown()
  })

  test('51 (relay): H_DENY that would pass DENY_MAX gets R_NOTICE 0x02 and the list stays at its ceiling', async () => {
    const { core } = relay()
    const h = await makeHome()
    const H = await house(core, h)
    const exp = Math.floor(Date.now() / 1000) + 3600
    const batch = (n: number) => Array.from({ length: n }, () => ({ ticketId: randomBytes(16), exp }))
    core.message(H.peer, encodeOuter({ type: 'H_DENY', entries: batch(DENY_MAX), overflow: false }), true)
    assert.notEqual(H.conn.last('house')?.type, 'R_NOTICE')
    core.message(H.peer, encodeOuter({ type: 'H_DENY', entries: batch(1), overflow: false }), true)
    assert.deepEqual(H.conn.last('house'), { type: 'R_NOTICE', code: 0x02 })
    // A frame announcing more than DENY_MAX is recognised by its size, never materialised.
    const n = DENY_MAX + 1
    const big = new Uint8Array(4 + n * 24)
    big.set([0x01, 0x27, n >> 8, n & 255])
    core.message(H.peer, big, true)
    assert.deepEqual(H.conn.last('house'), { type: 'R_NOTICE', code: 0x02 })
    assert.equal(H.conn.closedWith, undefined)
    core.shutdown()
  })
})

describe('relay core: second house with the same key (31)', () => {
  test('the first answers LINK_PING: the second is refused and the first gets R_NOTICE 0x01', async () => {
    const { core } = relay({ secondHousePingMs: 300 })
    const h = await makeHome()
    const first = await house(core, h)
    const second = await house(core, h, first.conn)
    const ping = first.conn.last('house') as Frame<'LINK_PING'>
    assert.equal(ping.type, 'LINK_PING')
    assert.equal(second.conn.types('house').length, 1, 'the second waits')
    core.message(first.peer, encodeOuter({ type: 'LINK_PONG', echo: ping.echo }), true)
    assert.deepEqual(second.conn.last('house'), { type: 'R_AUTH_FAIL', code: 0 })
    assert.equal(second.conn.closedWith, 1000)
    assert.deepEqual(first.conn.last('house'), { type: 'R_NOTICE', code: 0x01 })
    assert.equal(first.conn.closedWith, undefined)
    core.shutdown()
  })

  test('the first does not answer: it is closed and the second takes its place', async () => {
    const { core } = relay({ secondHousePingMs: 100 })
    const h = await makeHome()
    const first = await house(core, h)
    const d = await device(core, await makeDevice(h, AUD))
    const second = await house(core, h, first.conn)
    core.message(first.peer, encodeOuter({ type: 'LINK_PONG', echo: randomBytes(8) }), true) // a wrong echo is no answer
    await until(() => second.conn.sent.length >= 2, 2000)
    assert.equal(first.conn.closedWith, 1001)
    assert.equal(d.conn.closedWith, 1001, 'the routes of the first go with it')
    assert.equal(second.conn.last('house')?.type, 'R_AUTH_OK')
    assert.equal((await device(core, await makeDevice(h, AUD))).reply, 'R_OK', 'devices now reach the second')
    assert.equal(routeOpens(second.conn).length, 1)
    core.shutdown()
  })

  test('the first closes during the contest: the second is accepted at once', async () => {
    const { core } = relay({ secondHousePingMs: 5000 })
    const h = await makeHome()
    const first = await house(core, h)
    const second = await house(core, h, first.conn)
    core.closed(first.peer)
    assert.equal(second.conn.last('house')?.type, 'R_AUTH_OK')
    assert.equal(core.stats().houses, 1)
    core.shutdown()
  })
})

describe('relay core: pairing rendezvous', () => {
  test('H_PAIR_LISTEN answers 0x00; D_PAIR on that rv opens a pairing route; an rv another house holds answers 0x01', async () => {
    const { core } = relay()
    const [hA, hB] = [await makeHome(), await makeHome()]
    const A = await house(core, hA)
    const B = await house(core, hB)
    const rv = randomBytes(16)
    core.message(A.peer, encodeOuter({ type: 'H_PAIR_LISTEN', ttl: 60, rvs: [rv] }), true)
    assert.deepEqual(A.conn.last('house'), { type: 'R_PAIR_STATE', code: 0x00 })
    core.message(B.peer, encodeOuter({ type: 'H_PAIR_LISTEN', ttl: 60, rvs: [randomBytes(16), rv] }), true)
    assert.deepEqual(B.conn.last('house'), { type: 'R_PAIR_STATE', code: 0x01 })
    const conn = new FakeConn()
    const peer = core.attach(conn, 'device', nextIp())!
    core.message(peer, dPair(rv), true)
    assert.deepEqual(conn.types('device'), ['R_HELLO', 'R_OK'])
    const open = routeOpens(A.conn)[0]!
    assert.equal(open.kind, 0x02)
    assert.equal(toHex(open.hint), toHex(rv))
    assert.equal(routeOpens(B.conn).length, 0)
    core.message(A.peer, encodeOuter({ type: 'H_PAIR_CANCEL' }), true)
    assert.equal(core.stats().listens, 0)
    core.shutdown()
  })

  test('a listen expires with R_PAIR_STATE 0x02; the eleventh listen in an hour gets R_NOTICE 0x02', async () => {
    const { core } = relay()
    const h = await makeHome()
    const H = await house(core, h)
    core.message(H.peer, encodeOuter({ type: 'H_PAIR_LISTEN', ttl: 1, rvs: [randomBytes(16)] }), true)
    await until(() => H.conn.last('house')?.type === 'R_PAIR_STATE' && (H.conn.last('house') as Frame<'R_PAIR_STATE'>).code === 0x02, 2500)
    assert.equal(core.stats().listens, 0)
    for (let i = 1; i < 10; i++) core.message(H.peer, encodeOuter({ type: 'H_PAIR_LISTEN', ttl: 60, rvs: [randomBytes(16)] }), true)
    assert.equal(core.stats().listens, 1, 'one active listen per house: each new one replaced the previous')
    core.message(H.peer, encodeOuter({ type: 'H_PAIR_LISTEN', ttl: 60, rvs: [randomBytes(16)] }), true)
    assert.deepEqual(H.conn.last('house'), { type: 'R_NOTICE', code: 0x02 })
    core.shutdown()
  })

  test('five D_PAIR with no listen from one IP in a minute: the next D_PAIR of that IP is refused even on a live rv', async () => {
    const { core } = relay()
    const h = await makeHome()
    const H = await house(core, h)
    const rv = randomBytes(16)
    core.message(H.peer, encodeOuter({ type: 'H_PAIR_LISTEN', ttl: 60, rvs: [rv] }), true)
    const ip = nextIp()
    const tryPair = async (r: Uint8Array): Promise<string[]> => {
      const conn = new FakeConn()
      const peer = core.attach(conn, 'device', ip)!
      core.message(peer, dPair(r), true)
      await until(() => conn.sent.length >= 2, 1000)
      return conn.types('device')
    }
    for (let i = 0; i < 5; i++) assert.deepEqual(await tryPair(randomBytes(16)), ['R_HELLO', 'R_FAIL'])
    assert.deepEqual(await tryPair(rv), ['R_HELLO', 'R_FAIL'], 'the limit is a uniform refusal too')
    assert.deepEqual(await (async () => {
      const conn = new FakeConn()
      const peer = core.attach(conn, 'device', nextIp())!
      core.message(peer, dPair(rv), true)
      return conn.types('device')
    })(), ['R_HELLO', 'R_OK'], 'another IP still pairs')
    core.shutdown()
  })
})

describe('relay core: ceilings, idleness and shutdown', () => {
  test('per IP: 20 sockets, 5 pending; the relay as a whole: maxConns', async () => {
    const { core } = relay({ maxConns: 30 })
    const ip = nextIp()
    for (let i = 0; i < 5; i++) assert.ok(core.attach(new FakeConn(), 'device', ip))
    assert.equal(core.canAccept(ip), false, 'a sixth pending socket of the same IP')
    const refused = new FakeConn()
    assert.equal(core.attach(refused, 'device', ip), undefined)
    assert.equal(refused.closedWith, 1008)
    for (let i = 0; i < 25; i++) core.attach(new FakeConn(), 'device', nextIp())
    assert.equal(core.stats().peers, 30)
    assert.equal(core.canAccept(nextIp()), false, 'maxConns')
    assert.deepEqual([RELAY_LIMITS.connsPerIp, RELAY_LIMITS.pendingPerIp], [20, 5])
    core.shutdown()
  })

  test('a socket with no frame for the idle time closes', async () => {
    const { core } = relay({ idleMs: 120 })
    const h = await makeHome()
    const H = await house(core, h)
    const d = await device(core, await makeDevice(h, AUD))
    await until(() => H.conn.closedWith !== undefined && d.conn.closedWith !== undefined, 2000)
    assert.equal(core.stats().peers, 0)
    assert.equal(RELAY_LIMITS.idleMs, 90_000)
    core.shutdown()
  })

  test('the shared queues stay bounded under a churn of sockets that never send', async () => {
    const { core } = relay()
    for (let i = 0; i < 5000; i++) core.closed(core.attach(new FakeConn(), 'device', nextIp())!)
    assert.ok(core.stats().queued <= 1024 + 2, `queued ${core.stats().queued}`)
    assert.equal(core.stats().ips, 0)
    core.shutdown()
  })

  test('35 (core): shutdown closes every socket and empties every map', async () => {
    const { core } = relay()
    const h = await makeHome()
    const H = await house(core, h)
    const d = await device(core, await makeDevice(h, AUD))
    core.message(H.peer, encodeOuter({ type: 'H_PAIR_LISTEN', ttl: 60, rvs: [randomBytes(16)] }), true)
    core.attach(new FakeConn(), 'device', nextIp())
    core.shutdown()
    assert.deepEqual(core.stats(), { peers: 0, houses: 0, routes: 0, listens: 0, ips: 0, queued: 0, peakBuffered: 0 })
    assert.equal(H.conn.closedWith, 1001)
    assert.equal(d.conn.closedWith, 1001)
    assert.equal(core.canAccept(nextIp()), false)
  })
})
