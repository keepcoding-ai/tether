// The frames of one route reach the house in order (RR2.0): the device writes the frame that closes the pairing (or the
// session handshake) and, in the same synchronous burst, its first requests. The house must handle each frame only after
// the previous one and its effects (the pairing route becoming a session), or the session's AES-GCM counter breaks and
// the requests are lost. The House is driven in process, with no relay and no portal: frames in by onFrame, out by send.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import {
  accessFromCode, CERT_ROLE_TICKET, decodeOuter, decodeRes, DeviceHandshake, DevicePairing, encodeOuter, encodeReq,
  generateRoleKey, issueKeyCert, PAIR_STATE, RES_STATUS, ROUTE_KIND, type Bytes, type PairResult, type Session, type SessionEffect,
} from '../../src/remote/index.ts'
import { AttentionView } from '../../src/remoted/attention.ts'
import { House } from '../../src/remoted/house.ts'
import { until } from './remoted.helpers.ts'

const OP = { info: 0x0001, register: 0x0005 }

async function bench() {
  const kH = (await generateRoleKey('house')).key
  const kT = (await generateRoleKey('ticket')).key
  const nowS = Math.floor(Date.now() / 1000)
  const certT = await issueKeyCert(kH, { role: CERT_ROLE_TICKET, pub: kT.pub, notBefore: nowS - 60, notAfter: nowS + 86_400 })
  const inbox = new Map<number, Bytes[]>()
  const closed = new Set<number>()
  const house: House = new House({
    keys: { kH, kT, certT }, aud: 'localhost:9', houseName: 'Casa de teste', attention: new AttentionView(),
    send: (b) => {
      const f = decodeOuter('house', 'end', b)
      if (f.type === 'ROUTE_DATA') { const q = inbox.get(f.routeId) ?? []; q.push(f.inner); inbox.set(f.routeId, q) }
      else if (f.type === 'ROUTE_CLOSE') closed.add(f.routeId)
      else if (f.type === 'H_PAIR_LISTEN') queueMicrotask(() => house.onFrame(encodeOuter({ type: 'R_PAIR_STATE', code: PAIR_STATE.listening })))
    },
    ask: async () => {}, note: () => {}, notice: () => {}, log: () => {}, now: Date.now,
  })
  await house.init([], [])
  house.linkUp()
  const data = (route: number, inner: Bytes): void => house.onFrame(encodeOuter({ type: 'ROUTE_DATA', routeId: route, inner }))
  const next = async (route: number): Promise<Bytes> => {
    await until(() => (inbox.get(route)?.length ?? 0) > 0 || closed.has(route), 10_000, `a frame on route ${route}`)
    const f = inbox.get(route)?.shift()
    if (!f) throw new Error(`route ${route} closed by the house`)
    return f
  }
  return { house, data, next, closed }
}

const sends = (fx: { t: string; frame?: Bytes }[]): Bytes[] => fx.filter((e) => e.t === 'send').map((e) => e.frame!)

/** The device's REQ frames, encrypted in order before any of them is delivered. */
async function burst(s: Session): Promise<Bytes[]> {
  const reqs = [
    encodeReq({ reqId: 1, op: OP.register, actId: new Uint8Array(randomBytes(16)), body: new TextEncoder().encode('{}') }),
    encodeReq({ reqId: 2, op: OP.info, body: new TextEncoder().encode('{}') }),
    encodeReq({ reqId: 3, op: OP.info, body: new TextEncoder().encode('{}') }),
  ]
  const out: Bytes[] = []
  for (const c of reqs) out.push(...sends(await s.send('REQ', c, Date.now())))
  return out
}

/** Reads the three answers through the device's session (in the order the house encrypted them) by reqId. */
async function answers(s: Session, next: () => Promise<Bytes>): Promise<Map<number, { status: number; body: Record<string, unknown> }>> {
  const got = new Map<number, { status: number; body: Record<string, unknown> }>()
  while (got.size < 3) {
    const fx: SessionEffect[] = await s.receive(await next(), Date.now())
    for (const e of fx) {
      if (e.t === 'closed') throw new Error(`the session closed: ${JSON.stringify(e)}`)
      if (e.t === 'record' &&e.ctype === 'RES') {
        const r = decodeRes(e.content)
        got.set(r.reqId, { status: r.status, body: JSON.parse(new TextDecoder().decode(r.body)) as Record<string, unknown> })
      }
    }
  }
  return got
}

test('a burst right after the frame that closes the pairing, and a burst after a session handshake, are handled in order', async () => {
  const { house, data, next, closed } = await bench()
  const kD = (await generateRoleKey('device')).key
  const kA = (await generateRoleKey('admission')).key

  // Pairing on route 1: the PAIR_ACK and three requests reach the house in the same synchronous turn.
  const begun = await house.pairBegin()
  const access = await accessFromCode(begun.code)
  house.onFrame(encodeOuter({ type: 'ROUTE_OPEN', routeId: 1, kind: ROUTE_KIND.pair, hint: access.rv }))
  const started = await DevicePairing.start({ access, kD, kA, name: 'Telefone', caps: 0, nowMs: Date.now() })
  let fx = started.effects
  let result: PairResult | undefined
  let fresh: Session | undefined
  for (;;) {
    const paired = fx.find((e) => e.t === 'paired')
    if (paired && paired.t === 'paired') { result = paired.result; fresh = paired.session; break }
    for (const e of fx) {
      if (e.t === 'send') data(1, e.frame)
      else if (e.t === 'failed') throw new Error(`pairing failed: ${e.reason}`)
      else if (e.t === 'show-sas') {
        const sas = e.sas
        void (async () => {
          await until(() => house.pairState(begun.pairId).state === 'waiting-sas' || undefined, 10_000, 'waiting-sas')
          await house.pairSas(begun.pairId, sas)
        })()
      }
    }
    fx = await started.pairing.onFrame(await next(1), Date.now())
  }
  const ack = sends(fx)
  const reqs = await burst(fresh)
  for (const f of [...ack, ...reqs]) data(1, f)
  const a1 = await answers(fresh, () => next(1))
  assert.deepEqual([a1.get(1)!.status, a1.get(1)!.body.error], [RES_STATUS.failed, 'refused'], 'uv.register passes the gate in the fresh-pair session (and, with no PWA origin, registers nothing)')
  assert.equal(a1.get(2)!.status, RES_STATUS.ok)
  assert.equal(a1.get(3)!.status, RES_STATUS.ok)
  assert.ok(!closed.has(1))

  // A normal session on route 2: the last handshake frame and three requests in the same synchronous turn.
  house.onFrame(encodeOuter({ type: 'ROUTE_OPEN', routeId: 2, kind: ROUTE_KIND.admit, hint: new Uint8Array(randomBytes(16)) }))
  const hs = await DeviceHandshake.start({ pinnedPubH: result.pubH, kD, nowMs: Date.now(), pinnedVer: result.pinnedVer })
  let hfx = hs.effects
  let normal: Session | undefined
  for (;;) {
    const done = hfx.find((e) => e.t !== 'send' && e.t !== 'failed')
    if (done && 'session' in done) { normal = done.session; break }
    for (const e of hfx) {
      if (e.t === 'send') data(2, e.frame)
      else if (e.t === 'failed') throw new Error(`handshake failed: ${e.reason}`)
    }
    hfx = await hs.hs.onFrame(await next(2), Date.now())
  }
  const last = sends(hfx)
  const reqs2 = await burst(normal)
  for (const f of [...last, ...reqs2]) data(2, f)
  const a2 = await answers(normal, () => next(2))
  assert.equal(a2.get(1)!.status, RES_STATUS.presenceRequired, 'uv.register is refused outside the fresh-pair session')
  assert.equal(a2.get(2)!.status, RES_STATUS.ok)
  assert.equal(a2.get(3)!.status, RES_STATUS.ok)
  await house.shutdown()
})
