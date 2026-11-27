// admit.renew with a rhythm of its own (temper RR2, M-1). The attack: a paired device, locked or without a credential,
// sends renewals with a fresh key each, twice a second; each one rewrote devices.json and, a minute later, put a 30-day
// entry in the relay's deny list, until the list reached DENY_MAX and the relay refused the revocation of that device.
// Here the burst stops at the portal (nothing issued, nothing written, nothing denied), the ceilings per device and of the
// list hold, the revocation that follows still reaches the relay, and an R_NOTICE 0x02 is audited and shown to the person.
// A House in this process (remoted.house-bench.ts), on the FakeRelay with the relay's real DenyList.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, test } from 'node:test'
import { b64url, DENY_MAX, encodeOuter, fromB64url, fromHex, generateRoleKey, NOTICE, RES_STATUS, toHex } from '../../src/remote/index.ts'
import type { Limits } from '../../src/remoted/limits.ts'
import { startHouseBench, type HouseBench } from './remoted.house-bench.ts'
import { TestDevice, until, type DeviceSession } from './remoted.helpers.ts'

const RENEW = 0x0002

async function renew(s: DeviceSession, pub?: Uint8Array): Promise<{ status: number; ticket?: string; kA?: Awaited<ReturnType<typeof generateRoleKey>>['key'] }> {
  const kA = pub ? undefined : (await generateRoleKey('admission')).key
  const r = await s.request(RENEW, { pubA: b64url(pub ?? kA!.pub) }, { actId: new Uint8Array(randomBytes(16)) })
  return { status: r.status, ...(typeof r.body.ticket === 'string' ? { ticket: r.body.ticket } : {}), ...(kA ? { kA } : {}) }
}

const renewAudits = (bench: HouseBench): string[] => bench.audits().filter((a) => a.act === 'admit.renew').map((a) => a.result)
const relayDeny = (bench: HouseBench): number => bench.relay.house?.deny.size ?? -1

async function revoke(bench: HouseBench, deviceId: string): Promise<void> {
  const d = bench.registry.get(deviceId)!
  d.state = 'revoked'
  await bench.house.revoke(deviceId, d.tickets.map((t) => ({ ticketId: t.ticketId, exp: t.exp })))
}

async function bench(o: { limits?: Partial<Limits>; renewDenyAfterMs?: number } = {}): Promise<{ bench: HouseBench; id: string; s: DeviceSession }> {
  const b = await startHouseBench(o)
  return { bench: b, id: toHex(b.device.result!.deviceId), s: await b.connect() }
}

describe('M-1: the attack, with the portal at its real limits', () => {
  let b: HouseBench, id: string, s: DeviceSession
  before(async () => { ({ bench: b, id, s } = await bench({ renewDenyAfterMs: 100 })) })
  after(async () => { await b.stop() })

  test('a burst of renewals with fresh keys issues nothing, writes nothing and denies nothing; each refusal is audited', async () => {
    const tickets = structuredClone(b.registry.get(id)!.tickets)
    const statuses: number[] = []
    for (let i = 0; i < 20; i++) statuses.push((await renew(s)).status)
    assert.deepEqual(new Set(statuses), new Set([RES_STATUS.limit]), 'a ticket just issued is not renewed')
    assert.equal(b.asks.filter((a) => a.ask === 'renew').length, 0, 'the registry was never asked')
    assert.deepEqual(b.registry.get(id)!.tickets, tickets)
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(relayDeny(b), 0, 'the relay list did not grow')
    assert.deepEqual(renewAudits(b), Array(20).fill('limit:age'))
    assert.equal(s.closed, undefined, 'a refused renewal is not a strike: the session stays')
  })

  test('the revocation that follows reaches the relay: its live ticket is denied there and no notice comes back', async () => {
    const live = b.registry.get(id)!.tickets[0]!
    await revoke(b, id)
    await until(() => b.relay.house?.deny.has(fromHex(live.ticketId)) || undefined, 5_000, 'the ticket denied at the relay')
    assert.equal(b.audits().filter((a) => a.act === 'relay.notice').length, 0)
    assert.deepEqual(b.notices.filter((n) => /lista de bloqueio/.test(n)), [])
  })
})

describe('M-1: one renewal per device in renewMinGapS; the old ticket denied when due [47] [61]', () => {
  let b: HouseBench, id: string, s: DeviceSession
  before(async () => { ({ bench: b, id, s } = await bench({ limits: { renewMinAgeS: 0 }, renewDenyAfterMs: 200 })) })
  after(async () => { await b.stop() })

  test('pub_A = pub_D refused [47]; the first renewal goes, the next one within the gap is limit; the old ticket is refused at the relay', async () => {
    assert.equal((await renew(s, b.device.kD.pub)).status, RES_STATUS.failed, 'pub_A = pub_D refused [47]')
    const first = await renew(s)
    assert.equal(first.status, RES_STATUS.ok)
    const second = await renew(s)
    assert.equal(second.status, RES_STATUS.limit)
    assert.deepEqual(renewAudits(b).slice(-2), ['ok', 'limit:gap'])
    assert.equal(b.asks.filter((a) => a.ask === 'renew').length, 1)
    const oldTicket = b.device.result!.admitTicket
    const oldKA = b.device.kA
    b.device.renewed(fromB64url(first.ticket!), first.kA!)
    await until(() => relayDeny(b) === 1 || undefined, 5_000, 'the old ticket denied')
    const withOld = new TestDevice(b.relay)
    withOld.kD = b.device.kD
    withOld.kA = oldKA
    withOld.result = { ...b.device.result!, admitTicket: oldTicket }
    assert.deepEqual(await withOld.connect(), { failed: 'relay-refused' })
    const again = await b.connect()
    again.leg.close()
    assert.equal(b.registry.get(id)!.denied?.length, 1)
  })
})

describe('M-1: the ceilings hold even with the rhythm off', () => {
  test('superseded tickets per device stop at deniedPerDevice; the registry and the relay list stay there; revocation still lands', async () => {
    const { bench: b, id, s } = await bench({ limits: { renewMinAgeS: 0, renewMinGapS: 0, deniedPerDevice: 3 }, renewDenyAfterMs: 100 })
    try {
      const statuses: number[] = []
      for (let i = 0; i < 10; i++) statuses.push((await renew(s)).status)
      assert.deepEqual(statuses, [...Array(3).fill(RES_STATUS.ok), ...Array(7).fill(RES_STATUS.limit)])
      assert.deepEqual(renewAudits(b).slice(3), Array(7).fill('limit:denied'))
      const d = b.registry.get(id)!
      assert.equal(d.denied?.length, 3)
      assert.equal(d.usedKeyIds.length, 4)
      await until(() => relayDeny(b) === 3 || undefined, 5_000, 'three old tickets denied')
      await new Promise((r) => setTimeout(r, 300))
      assert.equal(relayDeny(b), 3)
      const live = d.tickets[0]!
      await revoke(b, id)
      await until(() => b.relay.house?.deny.has(fromHex(live.ticketId)) || undefined, 5_000, 'the revocation at the relay')
      assert.equal(relayDeny(b), 4)
    } finally { await b.stop() }
  })

  test('renewals never take the revocations\' reserve of the relay list', async () => {
    const { bench: b, s } = await bench({ limits: { renewMinAgeS: 0, renewMinGapS: 0, deniedPerDevice: 100, denyRevokeReserve: DENY_MAX - 2 }, renewDenyAfterMs: 2_000 })
    try {
      // Two renewals inside the minute promise two places; the third finds no room, though nothing is at the relay yet.
      assert.deepEqual([(await renew(s)).status, (await renew(s)).status, (await renew(s)).status], [RES_STATUS.ok, RES_STATUS.ok, RES_STATUS.limit])
      assert.equal(renewAudits(b).at(-1), 'limit:deny-list')
    } finally { await b.stop() }
  })
})

describe('M-1: R_NOTICE 0x02 from the relay', () => {
  let b: HouseBench, id: string
  before(async () => { ({ bench: b, id } = await bench()) })
  after(async () => { await b.stop() })

  test('a revocation the relay refuses (its list full) is audited and the person gets one native notice per hour', async () => {
    const nowS = Math.floor(Date.now() / 1000)
    const fill = Array.from({ length: DENY_MAX }, () => ({ ticketId: new Uint8Array(randomBytes(16)), exp: nowS + 3600 }))
    assert.deepEqual(b.relay.house!.deny.apply({ entries: fill, overflow: false }, nowS), { ok: true })
    await revoke(b, id)
    await until(() => b.audits().some((a) => a.act === 'relay.notice') || undefined, 5_000, 'the notice audited')
    assert.deepEqual(b.audits().filter((a) => a.act === 'relay.notice').map((a) => a.result), ['deny-full'])
    assert.equal(b.notices.filter((n) => /lista de bloqueio/.test(n)).length, 1)
    // A second refusal within the hour: one more line, no second notice.
    b.house.onFrame(encodeOuter({ type: 'R_NOTICE', code: NOTICE.limit }))
    assert.equal(b.audits().filter((a) => a.act === 'relay.notice').length, 2)
    assert.equal(b.notices.filter((n) => /lista de bloqueio/.test(n)).length, 1)
  })
})
