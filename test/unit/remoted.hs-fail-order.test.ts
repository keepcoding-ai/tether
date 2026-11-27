// The uniform failure of a session handshake (spec 4.2 rule 7) is HS_FAIL and then ROUTE_CLOSE, both at one instant. The
// house must send them in that order whatever the clock does between them: when the clock crossed that instant between the
// two effects, the close left at once, the route went, and the HS_FAIL was dropped (the device saw `route-closed`, not
// `hs-fail`). The clock here moves 300 ms per reading once HS3 is on its way, so the crossing happens on every run.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import {
  CERT_ROLE_TICKET, decodeOuter, DeviceHandshake, encodeOuter, FAIL_DELAY_MS, generateRoleKey, issueKeyCert, ROUTE_KIND,
  type Bytes, type DeviceHsEffect,
} from '../../src/remote/index.ts'
import { AttentionView } from '../../src/remoted/attention.ts'
import { House } from '../../src/remoted/house.ts'
import { until } from './remoted.helpers.ts'

test('a refused handshake gets HS_FAIL before its route closes, even when the clock crosses the instant between them', async () => {
  const kH = (await generateRoleKey('house')).key
  const kT = (await generateRoleKey('ticket')).key
  const nowS = Math.floor(Date.now() / 1000)
  const certT = await issueKeyCert(kH, { role: CERT_ROLE_TICKET, pub: kT.pub, notBefore: nowS - 60, notAfter: nowS + 86_400 })
  let t = Date.now()
  let step = 0
  const inbox: Bytes[] = []
  let closed = false
  const house = new House({
    keys: { kH, kT, certT }, aud: 'localhost:9', houseName: 'Casa de teste', attention: new AttentionView(),
    send: (b) => {
      const f = decodeOuter('house', 'end', b)
      if (f.type === 'ROUTE_DATA' && f.routeId === 1) inbox.push(f.inner)
      else if (f.type === 'ROUTE_CLOSE' && f.routeId === 1) closed = true
    },
    ask: async () => {}, note: () => {}, notice: () => {}, log: () => {}, now: () => (t += step),
  })
  await house.init([], [])
  house.linkUp()
  const data = (inner: Bytes): void => house.onFrame(encodeOuter({ type: 'ROUTE_DATA', routeId: 1, inner }))
  const next = async (): Promise<Bytes> => {
    await until(() => inbox.length > 0 || closed, 10_000, 'a frame on route 1')
    const f = inbox.shift()
    if (!f) throw new Error('route 1 closed by the house with no frame before it')
    return f
  }

  // A device the house does not know: its HS3 meets the uniform failure.
  const kD = (await generateRoleKey('device')).key
  house.onFrame(encodeOuter({ type: 'ROUTE_OPEN', routeId: 1, kind: ROUTE_KIND.admit, hint: new Uint8Array(randomBytes(16)) }))
  const hs = await DeviceHandshake.start({ pinnedPubH: kH.pub, kD, nowMs: Date.now() })
  for (const e of hs.effects) if (e.t === 'send') data(e.frame)
  const afterHs2: DeviceHsEffect[] = await hs.hs.onFrame(await next(), Date.now())
  const hs3 = afterHs2.filter((e) => e.t === 'send')
  assert.equal(hs3.length, 1, 'the device answers HS2 with HS3')
  step = FAIL_DELAY_MS * 0.6
  data((hs3[0] as { frame: Bytes }).frame)
  assert.deepEqual(await hs.hs.onFrame(await next(), Date.now()), [{ t: 'failed', reason: 'hs-fail', hard: false }])
  await until(() => closed, 5_000, 'the route closed after the HS_FAIL')
  await house.shutdown()
})
