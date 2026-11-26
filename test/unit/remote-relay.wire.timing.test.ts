// Relay over real sockets (fio-spec 5, 9.2; passo 1.2): the relay on an ephemeral port, houses and devices as `ws`
// clients. Timing-sensitive (the uniform refusal is measured), so it runs in the serial stage of the unit runner.
import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  encodeOuter, FAIL_DELAY_MS, MAX_OUTER, randomBytes, toHex, WS_SUBPROTOCOL, b64url,
  type Bytes, type OuterFrame,
} from '../../src/remote/index.ts'
import { startRelay, type RelayServer } from '../../remote/relay/src/shell.ts'
import { RELAY_LIMITS } from '../../remote/relay/src/limits.ts'
import {
  connect, data, deviceAdmit, deviceTry, dPair, houseAuth, houseOnline, makeDevice, makeHome, nowS, routeData, sleep,
  terminateClients, until, type Client,
} from '../../remote/relay/test/fixtures.ts'

// A failed assertion skips the test's own close: the hook closes what is left, so the file never hangs.
const relays: RelayServer[] = []
afterEach(async () => {
  terminateClients()
  await Promise.all(relays.splice(0).map(r => r.close()))
})

type Frame<T extends OuterFrame['type']> = Extract<OuterFrame, { type: T }>

async function relay(o: Parameters<typeof startRelay>[0] extends infer P ? Partial<P> : never = {}): Promise<{ r: RelayServer; logs: string[] }> {
  const logs: string[] = []
  const r = await startRelay({ port: 0, log: (e, f) => logs.push(JSON.stringify({ e, ...f })), ...o })
  relays.push(r)
  return { r, logs }
}

/** Answers every LINK_PING of the relay, as a live house does. */
function answerPings(c: Client): void {
  c.ws.on('message', (b: Buffer) => {
    if (b[0] === 0x01 && b[1] === 0x3e) c.send(encodeOuter({ type: 'LINK_PONG', echo: new Uint8Array(b.subarray(2, 10)) }))
  })
}

async function routeOpen(c: Client): Promise<Frame<'ROUTE_OPEN'>> {
  const f = await c.frame()
  assert.equal(f.type, 'ROUTE_OPEN')
  return f as Frame<'ROUTE_OPEN'>
}

const R_FAIL = '0105'

describe('relay over sockets: uniform refusal', () => {
  test('29: offline house, unknown house, expired ticket, denied ticket, ticket of another relay, rv with no listen: the same bytes, the same instant', async () => {
    const { r } = await relay()
    const aud = r.aud
    const online = await makeHome()
    const offline = await makeHome()
    const H = await houseOnline(r.port, online, aud)
    const t = nowS()
    const denied = await makeDevice(online, aud)
    H.send(encodeOuter({ type: 'H_DENY', entries: [{ ticketId: denied.ticketId, exp: t + 3600 }], overflow: false }))
    await sleep(50)
    const cases: Record<string, (nR: Bytes) => Promise<Uint8Array>> = {
      'casa offline': async nR => deviceAdmit(await makeDevice(offline, aud), nR, aud),
      'casa inexistente': async nR => {
        const f = await deviceAdmit(await makeDevice(offline, aud), nR, aud)
        f.set(randomBytes(32), 2)
        return f
      },
      'bilhete vencido': async nR => deviceAdmit(await makeDevice(online, aud, { notBefore: t - 5000, exp: t - 1000 }), nR, aud),
      'bilhete negado': async nR => deviceAdmit(denied, nR, aud),
      'bilhete de outro relay': async nR => {
        const d = await makeDevice(online, 'other.relay')
        return deviceAdmit(d, nR, aud)
      },
      'rv sem escuta': async () => dPair(randomBytes(16)),
    }
    const times: Record<string, number[]> = {}
    for (let round = 0; round < 3; round++) {
      for (const [name, build] of Object.entries(cases)) {
        const { c, reply, ms } = await deviceTry(r.port, build)
        const closed = await c.closed
        assert.equal(toHex(reply), R_FAIL, name)
        assert.equal(c.received.length, 2, `${name}: R_HELLO and R_FAIL, nothing else`)
        assert.deepEqual([closed.code, closed.reason], [1000, ''], name)
        ;(times[name] ??= []).push(ms)
      }
    }
    const all = Object.values(times).flat()
    const min = Math.min(...all)
    const max = Math.max(...all)
    const summary = Object.entries(times).map(([k, v]) => `${k}: ${v.map(x => x.toFixed(0)).join('/')}`).join('; ')
    assert.ok(min >= FAIL_DELAY_MS - 2, `no refusal before FAIL_DELAY (${summary})`)
    assert.ok(max <= FAIL_DELAY_MS + 80, `every refusal close to FAIL_DELAY (${summary})`)
    assert.ok(max - min <= 60, `spread ${(max - min).toFixed(1)} ms (${summary})`)
    // The valid ticket, for contrast, is admitted without the delay.
    const ok = await deviceTry(r.port, async nR => deviceAdmit(await makeDevice(online, aud), nR, aud))
    assert.equal(toHex(ok.reply), '0104')
    assert.ok(ok.ms < FAIL_DELAY_MS, `R_OK in ${ok.ms.toFixed(0)} ms`)
    await r.close()
  })

  test('37: a revoked device with a live session drops in under 1 s; its next D_ADMIT gets the R_FAIL of an offline house', async () => {
    const { r } = await relay()
    const h = await makeHome()
    const H = await houseOnline(r.port, h, r.aud)
    const d = await makeDevice(h, r.aud)
    const live = await deviceTry(r.port, nR => deviceAdmit(d, nR, r.aud))
    assert.equal(toHex(live.reply), '0104')
    await routeOpen(H)
    const t0 = performance.now()
    H.send(encodeOuter({ type: 'H_DENY', entries: [{ ticketId: d.ticketId, exp: nowS() + 3600 }], overflow: false }))
    const closed = await live.c.closed
    assert.ok(closed.at - t0 < 1000, `closed in ${(closed.at - t0).toFixed(0)} ms`)
    const again = await deviceTry(r.port, nR => deviceAdmit(d, nR, r.aud))
    const offline = await deviceTry(r.port, async nR => deviceAdmit(await makeDevice(await makeHome(), r.aud), nR, r.aud))
    assert.equal(toHex(again.reply), toHex(offline.reply))
    assert.equal(toHex(again.reply), R_FAIL)
    assert.ok(Math.abs(again.ms - offline.ms) < 60, `${again.ms.toFixed(0)} vs ${offline.ms.toFixed(0)} ms`)
    await r.close()
  })
})

describe('relay over sockets: isolation and contest', () => {
  test('two houses and two devices: frames cross only inside their own pair, both ways', async () => {
    const { r } = await relay()
    const [hA, hB] = [await makeHome(), await makeHome()]
    const A = await houseOnline(r.port, hA, r.aud)
    const B = await houseOnline(r.port, hB, r.aud)
    const dA = (await deviceTry(r.port, async nR => deviceAdmit(await makeDevice(hA, r.aud), nR, r.aud))).c
    const dB = (await deviceTry(r.port, async nR => deviceAdmit(await makeDevice(hB, r.aud), nR, r.aud))).c
    const rA = (await routeOpen(A)).routeId
    const rB = (await routeOpen(B)).routeId
    dA.send(data(Uint8Array.of(0x20, 0xa1)))
    dB.send(data(Uint8Array.of(0x20, 0xb1)))
    assert.deepEqual(await A.frame(), { type: 'ROUTE_DATA', routeId: rA, inner: Uint8Array.of(0x20, 0xa1) })
    assert.deepEqual(await B.frame(), { type: 'ROUTE_DATA', routeId: rB, inner: Uint8Array.of(0x20, 0xb1) })
    A.send(routeData(rA, Uint8Array.of(0x20, 0xa2)))
    B.send(routeData(rB, Uint8Array.of(0x20, 0xb2)))
    assert.deepEqual(await dA.frame(), { type: 'DATA', inner: Uint8Array.of(0x20, 0xa2) })
    assert.deepEqual(await dB.frame(), { type: 'DATA', inner: Uint8Array.of(0x20, 0xb2) })
    await sleep(50)
    assert.deepEqual([A.received.length, B.received.length, dA.received.length, dB.received.length], [4, 4, 3, 3])
    await r.close()
  })

  test('30: ROUTE_DATA of house B to the routeId of house A is dropped; the third closes B; A and its device stay', async () => {
    const { r } = await relay()
    const [hA, hB] = [await makeHome(), await makeHome()]
    const A = await houseOnline(r.port, hA, r.aud)
    const B = await houseOnline(r.port, hB, r.aud)
    const dA = (await deviceTry(r.port, async nR => deviceAdmit(await makeDevice(hA, r.aud), nR, r.aud))).c
    const rA = (await routeOpen(A)).routeId
    for (let i = 0; i < 3; i++) B.send(routeData(rA, Uint8Array.of(0x20, 0x66)))
    assert.equal((await B.closed).code, 1008)
    A.send(routeData(rA, Uint8Array.of(0x20, 0x01)))
    assert.deepEqual(await dA.frame(), { type: 'DATA', inner: Uint8Array.of(0x20, 0x01) }, 'the only DATA the device sees is of its house')
    assert.equal(r.stats().houses, 1)
    await r.close()
  })

  test('31: a second house with the same key, the first alive: refused with notice to the first; the first dead: accepted', async () => {
    const { r } = await relay()
    const h = await makeHome()
    const first = await houseOnline(r.port, h, r.aud)
    answerPings(first)
    const second = await connect(r.port, 'house')
    const ch = await second.frame() as Frame<'R_CHALLENGE'>
    second.send(await houseAuth(h, ch.r, r.aud))
    assert.deepEqual(await second.frame(6000), { type: 'R_AUTH_FAIL', code: 0 })
    assert.equal((await second.closed).code, 1000)
    await until(() => first.received.some(b => toHex(b) === '012801'), 2000, 'R_NOTICE 0x01 on the first')

    // The first stops answering (a dead link): after the 5 s of the spec it is closed and a third socket takes over.
    first.ws.removeAllListeners('message')
    first.ws.pause()
    const t0 = performance.now()
    const third = await connect(r.port, 'house')
    const ch3 = await third.frame() as Frame<'R_CHALLENGE'>
    third.send(await houseAuth(h, ch3.r, r.aud))
    assert.deepEqual(await third.frame(8000), { type: 'R_AUTH_OK' })
    const waited = performance.now() - t0
    assert.ok(waited >= RELAY_LIMITS.secondHousePingMs - 50, `waited ${waited.toFixed(0)} ms`)
    assert.equal(r.stats().houses, 1)
    await r.close()
  })
})

describe('relay over sockets: transport limits', () => {
  test('32: 2 MiB before admission is dropped, a text frame is dropped, permessage-deflate is not accepted, the subprotocol is echoed', async () => {
    const { r } = await relay()
    const big = await connect(r.port, 'device')
    await big.next()
    big.send(new Uint8Array(2 * 1024 * 1024))
    // ws closes with 1009 as soon as the length header passes maxPayload; the client, still writing, may only see
    // the TCP reset (1006). Either way the socket is gone and the relay never buffered the frame.
    assert.ok([1006, 1009].includes((await big.closed).code))
    await until(() => r.stats().peers === 0, 2000, 'the dropped socket leaves the core')

    const text = await connect(r.port, 'device')
    await text.next()
    text.ws.send('hello')
    assert.equal((await text.closed).code, 1003)

    const deflate = await connect(r.port, 'house', { deflate: true })
    assert.equal(deflate.ws.extensions, '', 'no extension negotiated')
    assert.equal(deflate.ws.protocol, WS_SUBPROTOCOL)
    deflate.ws.close()

    await assert.rejects(connect(r.port, 'device', { protocol: null }), /400/)
    await assert.rejects(connect(r.port, 'device', { protocol: 'other' }), /400/)
    await r.close()
  })

  test('the Origin list of the device leg, the health check, and the frame cap after admission', async () => {
    const { r } = await relay({ origins: ['https://pwa.test'] })
    await assert.rejects(connect(r.port, 'device', { origin: 'https://evil.test' }), /403/)
    await assert.rejects(connect(r.port, 'device'), /403/)
    const ok = await connect(r.port, 'device', { origin: 'https://pwa.test' })
    assert.equal((await ok.frame()).type, 'R_HELLO')
    const house = await connect(r.port, 'house', { origin: 'https://evil.test' })
    assert.equal((await house.frame()).type, 'R_CHALLENGE', 'the house leg is not a browser')
    const res = await fetch(`http://localhost:${r.port}/healthz`)
    assert.equal(await res.text(), 'ok')
    await r.close()
  })

  test('a frame above MAX_OUTER after admission is dropped', async () => {
    const { r } = await relay()
    const h = await makeHome()
    const H = await houseOnline(r.port, h, r.aud)
    const d = (await deviceTry(r.port, async nR => deviceAdmit(await makeDevice(h, r.aud), nR, r.aud))).c
    await routeOpen(H)
    const over = new Uint8Array(MAX_OUTER + 1).fill(0x20)
    over.set([0x01, 0x10])
    d.send(over)
    assert.ok([1006, 1009].includes((await d.closed).code), 'above MAX_OUTER after admission')
    await until(() => r.stats().routes === 0, 2000, 'the route of the dropped device closes')
    await r.close()
  })

  test('33: no D_ADMIT within AUTH_DEADLINE is dropped (real 10 s)', async () => {
    const { r } = await relay()
    const t0 = performance.now()
    const d = await connect(r.port, 'device')
    const h = await connect(r.port, 'house')
    const [cd, ch] = await Promise.all([d.closed, h.closed])
    for (const c of [cd, ch]) {
      assert.equal(c.code, 1008)
      const ms = c.at - t0
      assert.ok(ms >= RELAY_LIMITS.authDeadlineMs - 50 && ms < RELAY_LIMITS.authDeadlineMs + 1000, `${ms.toFixed(0)} ms`)
    }
    assert.equal(r.stats().peers, 0)
    await r.close()
  })
})

describe('relay over sockets: backpressure and shutdown', () => {
  test('35: a slow route overflows its queue and only it falls; the map empties when the relay stops', async () => {
    const { r } = await relay()
    const h = await makeHome()
    const H = await houseOnline(r.port, h, r.aud)
    const slow = (await deviceTry(r.port, async nR => deviceAdmit(await makeDevice(h, r.aud), nR, r.aud))).c
    const fast = (await deviceTry(r.port, async nR => deviceAdmit(await makeDevice(h, r.aud), nR, r.aud))).c
    const rSlow = (await routeOpen(H)).routeId
    const rFast = (await routeOpen(H)).routeId
    slow.ws.pause()
    const chunk = new Uint8Array(64 * 1024).fill(0x20)
    for (let i = 0; i < 512 && slow.ws.readyState === slow.ws.OPEN; i++) {
      H.send(routeData(rSlow, chunk))
      if (i % 16 === 15) await sleep(5)
    }
    await until(() => H.received.some(b => toHex(b) === `0132${rSlow.toString(16).padStart(8, '0')}`), 10_000, 'ROUTE_CLOSE of the slow route')
    assert.ok(r.stats().peakBuffered <= RELAY_LIMITS.routeQueueBytes + MAX_OUTER, `peak ${r.stats().peakBuffered}`)
    H.send(routeData(rFast, Uint8Array.of(0x20, 0x07)))
    await until(() => fast.received.some(b => toHex(b) === '01102007'), 3000, 'the fast route still works')
    assert.equal(r.stats().routes, 1)
    assert.equal(r.stats().houses, 1)
    const closing = [H.closed, fast.closed]
    await r.close()
    await Promise.all(closing)
    assert.deepEqual(r.stats(), { ...r.stats(), peers: 0, houses: 0, routes: 0, listens: 0, ips: 0, queued: 0 })
  })

  test('a flood towards a house that does not read: the route is dropped and the relay never holds more than the cap', async () => {
    const { r } = await relay()
    const h = await makeHome()
    const H = await houseOnline(r.port, h, r.aud)
    const d = (await deviceTry(r.port, async nR => deviceAdmit(await makeDevice(h, r.aud), nR, r.aud))).c
    await routeOpen(H)
    H.ws.pause()
    const chunk = new Uint8Array(256 * 1024 - 8).fill(0x20)
    const heap0 = process.memoryUsage().arrayBuffers
    for (let i = 0; i < 400 && d.ws.readyState === d.ws.OPEN; i++) {
      d.send(data(chunk))
      if (i % 8 === 7) await sleep(5)
    }
    const closed = await d.closed
    assert.equal(closed.code, 1006, 'terminated, not a closing handshake')
    assert.ok(r.stats().peakBuffered <= RELAY_LIMITS.houseQueueBytes + MAX_OUTER, `peak ${r.stats().peakBuffered}`)
    const grew = process.memoryUsage().arrayBuffers - heap0
    assert.ok(grew < 64 * 1024 * 1024, `array buffers grew ${(grew / 1048576).toFixed(1)} MiB for a 100 MiB flood`)
    assert.equal(r.stats().routes, 0)
    assert.equal(r.stats().houses, 1, 'the house stays')
    await r.close()
  })
})

describe('relay over sockets: what the log keeps', () => {
  test('36: after a battery with baits, the log has no ticket, rv, proof of possession, nonce, houseId or IP', async () => {
    const { r, logs } = await relay()
    const h = await makeHome()
    const H = await houseOnline(r.port, h, r.aud)
    const rv = randomBytes(16)
    H.send(encodeOuter({ type: 'H_PAIR_LISTEN', ttl: 60, rvs: [rv] }))
    await H.frame()
    const baits: string[] = [toHex(h.houseId), toHex(rv), b64url(rv), '::1', '127.0.0.1']
    const good = await makeDevice(h, r.aud)
    const bad = await makeDevice(h, 'other.relay')
    for (const d of [good, bad]) {
      let sent: Uint8Array = new Uint8Array(0)
      let nonce: Uint8Array = new Uint8Array(0)
      await deviceTry(r.port, async nR => { nonce = nR; sent = await deviceAdmit(d, nR, r.aud); return sent })
      baits.push(toHex(d.ticket), toHex(d.ticketId), b64url(d.ticketId), toHex(sent.subarray(sent.length - 64)), toHex(nonce))
    }
    await deviceTry(r.port, async () => dPair(rv))
    await deviceTry(r.port, async () => dPair(randomBytes(16)))
    const text = await connect(r.port, 'device')
    await text.next()
    text.ws.send(toHex(good.ticket))
    await text.closed
    await r.close()
    assert.ok(logs.length >= 4, `the battery did log (${logs.length} lines)`)
    const joined = logs.join('\n').toLowerCase()
    for (const b of baits) assert.equal(joined.includes(b.toLowerCase()), false, `bait ${b.slice(0, 12)}… found in the log`)
  })
})
