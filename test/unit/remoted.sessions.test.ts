// The sessions per device in the portal (RR2.2b): the status and the notes say, per device, since when it is live and one
// word of what it does (never content); `endSessions` closes the live sessions of one device with CLOSE(0x01) and nothing
// else (no deny, no revocation), so the device connects again. A House in this process (remoted.house-bench.ts).
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { RES_STATUS, toHex } from '../../src/remote/index.ts'
import { LIVE_DOING, type PortalNote } from '../../src/remoted/ipc.ts'
import { PortalError } from '../../src/remoted/house.ts'
import { startHouseBench, type HouseBench } from './remoted.house-bench.ts'
import { until, type DeviceSession } from './remoted.helpers.ts'

const OP = { info: 0x0001, watch: 0x0101 }

describe('sessions per device', () => {
  let bench: HouseBench
  let id: string
  before(async () => {
    bench = await startHouseBench()
    id = toHex(bench.device.result!.deviceId)
    // The pairing left its own session open: the tests start from none.
    await bench.house.endSessions(id)
    await until(() => bench.house.status().sessions === 0 || undefined, 5_000, 'the pairing session gone')
  })
  after(async () => { await bench.stop() })

  const lastLive = (): Extract<PortalNote, { note: 'sessions' }>['live'] | undefined =>
    bench.notes.filter((n): n is Extract<PortalNote, { note: 'sessions' }> => n.note === 'sessions').at(-1)?.live

  test('the status and the notes say the device is live, since its oldest session; a watching session says `watching`', async () => {
    const t0 = Date.now()
    const a = await bench.connect()
    const b = await bench.connect()
    await until(() => bench.house.status().sessions >= 2 || undefined, 5_000, 'two sessions')
    const st = bench.house.status()
    assert.equal(st.live.length, 1, 'one device, however many sessions')
    assert.equal(st.live[0]!.deviceId, id)
    assert.ok(Date.parse(st.live[0]!.since) <= t0 + 50, 'since the oldest live session')
    assert.equal(st.live[0]!.doing, undefined)
    assert.deepEqual(Object.keys(st.live[0]!).sort(), ['deviceId', 'since'], 'nothing else of the session')
    assert.equal((await b.request(OP.watch)).status, RES_STATUS.ok)
    assert.equal(bench.house.status().live[0]!.doing, 'watching')
    assert.equal(lastLive()?.[0]?.doing, 'watching', 'the change of what it does is noted too')
    assert.ok((LIVE_DOING as readonly string[]).includes('watching'))
    a.leg.close()
    b.leg.close()
    await until(() => bench.house.status().sessions === 0 || undefined, 5_000, 'both gone')
    assert.deepEqual(bench.house.status().live, [])
    assert.deepEqual(lastLive(), [])
  })

  test('endSessions closes every live session of the device with CLOSE(0x01), leaves a line each, and the device comes back', async () => {
    const a = await bench.connect()
    const b = await bench.connect()
    await until(() => bench.house.status().sessions === 2 || undefined, 5_000, 'two sessions')
    const before = bench.audits().length
    assert.deepEqual(await bench.house.endSessions(id), { deviceId: id, ended: 2 })
    await until(() => (a.closed && b.closed) || undefined, 3_000, 'both closed by the house')
    assert.deepEqual([a.closed, b.closed], [{ by: 'peer', code: 0x01 }, { by: 'peer', code: 0x01 }])
    assert.deepEqual(bench.house.status().live, [])
    const lines = bench.audits().slice(before)
    assert.deepEqual(lines.map((l) => [l.act, l.result, l.deviceId]), [['session.end', 'closed by the house', id], ['session.end', 'closed by the house', id]])
    // Not revoked, not denied: the same device connects again and is served.
    const again: DeviceSession = await bench.connect()
    assert.equal((await again.request(OP.info)).status, RES_STATUS.ok)
    await until(() => bench.house.status().live.length === 1 || undefined, 3_000, 'live again')
    assert.deepEqual(await bench.house.endSessions(id), { deviceId: id, ended: 1 })
    assert.deepEqual(await bench.house.endSessions(id), { deviceId: id, ended: 0 }, 'nothing live: nothing to end')
  })

  test('a device the house does not know is refused', async () => {
    await assert.rejects(bench.house.endSessions('00'.repeat(16)), (e: unknown) => e instanceof PortalError && e.code === 'not-found')
  })
})
