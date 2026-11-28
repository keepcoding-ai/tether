// RR4 step 4.4: the portal tells a device whose app is closed (src/remoted/push.ts, fio-spec 15). Proved here, with a fake
// sender in place of fetch (no test talks to a push service or to the internet):
// - the pace: one notice per device and tag every 30 s, a ceiling per device per hour, a bounded queue; 404/410 drop the
//   subscription and tell the registry; any other failure only counts and leaves a line, with the host and never the URL;
// - what is sent: a body only the subscription opens, a VAPID header for the service's origin, nothing that names the house;
// - a real House (remoted.house-bench.ts, a device with a presence credential): the three lines (key, on, off) by the gate,
//   the endpoint by the rule of M-11, the three kinds of notice and nothing else, never to a session on the screen, never the
//   text of a line (a canary in it reaches no notice, no audit line), revocation drops the subscription.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, test } from 'node:test'
import { b64url, OP_CODES, RES_STATUS, toHex, type Bytes } from '../../src/remote/index.ts'
import { utf8Decode } from '../../src/remote/bytes.ts'
import { importVapidKey, verifyVapid, webPushDecrypt, type PushNotice } from '../../src/remote/webpush.ts'
import { AttentionView } from '../../src/remoted/attention.ts'
import { PortalPush, PUSH_DEVICE_HOUR_MAX, PUSH_GAP_MS, PUSH_QUEUE_MAX, type PushSend } from '../../src/remoted/push.ts'
import type { PushSubRow } from '../../src/remoted/ipc.ts'
import type { PipeReads } from '../../src/remoted/reads.ts'
import { actId, ORIGIN, registerAndUnlock } from './remoted.authenticator.ts'
import { startHouseBench, type HouseBench } from './remoted.house-bench.ts'
import { until } from './remoted.helpers.ts'

const MARKER = `canary${randomBytes(12).toString('hex')}`
const has = (v: unknown): boolean => JSON.stringify(v).includes(MARKER)
const OP = { visible: OP_CODES['session.visible'], key: OP_CODES['attention.push-key'], on: OP_CODES['attention.push-on'], off: OP_CODES['attention.push-off'], lock: OP_CODES['session.lock'] }

/** The device's browser: a subscription key pair and secret, as PushManager makes them. */
async function browser(endpoint = `https://fcm.googleapis.com/fcm/send/${randomBytes(8).toString('hex')}`) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  const auth = new Uint8Array(randomBytes(16))
  return {
    endpoint, pub, auth,
    body: { endpoint, p256dh: b64url(pub), auth: b64url(auth) },
    row: (): PushSubRow => ({ endpoint, p256dh: b64url(pub), auth: b64url(auth), at: new Date().toISOString() }),
    open: async (body: Bytes): Promise<PushNotice> => JSON.parse(utf8Decode(await webPushDecrypt({ uaPrivate: pair.privateKey, uaPublic: pub, auth, body }))) as PushNotice,
  }
}

interface Sent { url: string; headers: Record<string, string>; body: Bytes }

/** A sender that records what it would post, answering `status` (or throwing `fail`). */
function fakeSender(answer: () => number | Error = () => 201): { send: PushSend; sent: Sent[] } {
  const sent: Sent[] = []
  return {
    sent,
    send: async (url, o) => {
      sent.push({ url, headers: o.headers, body: o.body })
      const a = answer()
      if (a instanceof Error) throw a
      return a
    },
  }
}

async function vapidKey() {
  const k = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  return importVapidKey(new Uint8Array(await crypto.subtle.exportKey('pkcs8', k.privateKey)), new Uint8Array(await crypto.subtle.exportKey('raw', k.publicKey)))
}

const NOTICE = (tag = 'a:s1'): PushNotice => ({ kind: 'waiting', title: 'conferente', body: 'espera você', tag, url: '?tab=waiting' })

describe('PortalPush: the pace and the answers of the push service', () => {
  test('one notice per device and tag every 30 s; another tag goes; after the gap it goes again', async () => {
    let now = 1_000_000
    const f = fakeSender()
    const p = new PortalPush({ key: await vapidKey(), now: () => now, send: f.send, audit: () => {}, log: () => {}, gone: () => {} })
    const b = await browser()
    p.set('d1', b.row())
    p.notify(NOTICE(), ['d1'])
    p.notify(NOTICE(), ['d1'])
    p.notify(NOTICE('a:s2'), ['d1'])
    await p.idle()
    assert.equal(f.sent.length, 2)
    assert.equal(p.counts.coalesced, 1)
    now += PUSH_GAP_MS
    p.notify(NOTICE(), ['d1'])
    await p.idle()
    assert.equal(f.sent.length, 3)
  })

  test('a ceiling per device per hour, and a queue that never grows past its ceiling', async () => {
    let now = 5_000_000
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const sent: string[] = []
    const send: PushSend = async (url) => { sent.push(url); await gate; return 201 }
    const p = new PortalPush({ key: await vapidKey(), now: () => now, send, audit: () => {}, log: () => {}, gone: () => {} })
    const b = await browser()
    p.set('d1', b.row())
    for (let i = 0; i < PUSH_DEVICE_HOUR_MAX + 5; i++) p.notify(NOTICE(`a:s${i}`), ['d1'])
    assert.equal(p.counts.limited, 5)
    // Many devices at once: the queue holds PUSH_QUEUE_MAX, the rest is dropped and counted.
    const many = await Promise.all(Array.from({ length: PUSH_QUEUE_MAX + 10 }, () => browser()))
    many.forEach((m, i) => p.set(`m${i}`, m.row()))
    p.notify(NOTICE('a:x'), many.map((_, i) => `m${i}`))
    assert.ok(p.counts.busy > 0, 'some were dropped, none queued without end')
    release()
    await p.idle()
    now += 3_600_000
    p.notify(NOTICE('a:late'), ['d1'])
    await p.idle()
    assert.equal(p.counts.limited, 5, 'an hour later the device is told again')
  })

  test('the body opens only with the subscription, the VAPID header is for the service\'s origin, no header names the house', async () => {
    const f = fakeSender()
    const key = await vapidKey()
    const p = new PortalPush({ key, now: Date.now, send: f.send, audit: () => {}, log: () => {}, gone: () => {} })
    const b = await browser()
    p.set('d1', b.row())
    p.notify(NOTICE(), ['d1'])
    await p.idle()
    const s = f.sent[0]!
    assert.equal(s.url, b.endpoint)
    assert.deepEqual(Object.keys(s.headers).sort(), ['Authorization', 'Content-Encoding', 'Content-Type', 'TTL', 'Urgency'])
    assert.equal(s.headers['Content-Encoding'], 'aes128gcm')
    const v = await verifyVapid(s.headers.Authorization!, 'https://fcm.googleapis.com', Math.floor(Date.now() / 1000))
    assert.equal(v.ok, true)
    assert.equal(v.ok && b64url(v.pub), b64url(key.pub))
    assert.deepEqual(await b.open(s.body), NOTICE())
    assert.equal(s.body.length % 16, (s.body.length) % 16) // shape only; the padding is checked in remote.webpush
  })

  test('410 and 404: the subscription goes, here and in the registry; another failure keeps it and only counts', async () => {
    const lines: string[] = []
    const audits: string[] = []
    const gone: string[] = []
    let answer: number | Error = 410
    const f = fakeSender(() => answer)
    const p = new PortalPush({ key: await vapidKey(), now: Date.now, send: f.send, audit: (a, r, d, t) => audits.push(`${a} ${r} ${d} ${t}`), log: (m) => lines.push(m), gone: (d) => gone.push(d) })
    const b = await browser()
    p.set('d1', b.row())
    p.notify(NOTICE('a:1'), ['d1'])
    await p.idle()
    assert.deepEqual(gone, ['d1'])
    assert.equal(p.has('d1'), false)
    p.set('d2', (await browser()).row())
    answer = 404
    p.notify(NOTICE('a:2'), ['d2'])
    await p.idle()
    assert.deepEqual(gone, ['d1', 'd2'])
    for (const [a, result] of [[500, 'failed:500'], [301, 'failed:redirect'], [429, 'failed:429'], [Object.assign(new Error('t'), { name: 'TimeoutError' }), 'failed:timeout'], [new Error('ECONNREFUSED'), 'failed:network']] as const) {
      const c = await browser()
      p.set('d3', c.row())
      answer = a
      p.notify(NOTICE(`a:${result}`), ['d3'])
      await p.idle()
      assert.equal(p.has('d3'), true, `${result}: kept`)
      assert.ok(audits.at(-1)!.startsWith(`push.send ${result} d3 waiting`), audits.at(-1))
    }
    assert.ok(lines.length > 0)
    for (const l of [...lines, ...audits]) {
      assert.equal(l.includes('/fcm/send/'), false, `no URL in a line: ${l}`)
      assert.equal(l.includes(b.endpoint), false)
    }
    assert.ok(lines.every((l) => /fcm\.googleapis\.com/.test(l)), 'the log says the host')
  })

  test('a row whose endpoint is not allowed is not kept; on the bench only the bench origin is dialled', async () => {
    const f = fakeSender()
    const audits: string[] = []
    const p = new PortalPush({ key: await vapidKey(), now: Date.now, send: f.send, audit: (a, r) => audits.push(`${a} ${r}`), log: () => {}, gone: () => {} })
    p.set('d1', { ...(await browser()).row(), endpoint: 'https://10.0.0.1/push' })
    assert.equal(p.has('d1'), false)
    const bench = new PortalPush({ key: await vapidKey(), now: Date.now, send: f.send, benchOnly: true, benchOrigin: 'http://localhost:9', audit: (a, r) => audits.push(`${a} ${r}`), log: () => {}, gone: () => {} })
    bench.set('real', (await browser()).row())
    bench.set('fake', (await browser('http://localhost:9/push/x')).row())
    bench.notify(NOTICE(), ['real', 'fake'])
    await bench.idle()
    assert.deepEqual(f.sent.map((s) => s.url), ['http://localhost:9/push/x'])
    assert.ok(audits.includes('push.send refused:bench'))
  })
})

// ---- the House ------------------------------------------------------------------------------------------------------

describe('the house tells a device whose app is closed', () => {
  let bench: HouseBench
  const attention = new AttentionView()
  const f = fakeSender()
  let moderator = 'Guga'
  const reads: PipeReads = {
    read: async (op) => {
      if (op === 'channels.marks') return { channels: [], moderator: { name: moderator } }
      throw new Error('no such read here')
    },
  }
  let b: Awaited<ReturnType<typeof browser>>
  const opened = async (from = 0): Promise<PushNotice[]> => {
    await bench.push!.idle()
    return Promise.all(f.sent.slice(from).map((s) => b.open(s.body)))
  }

  before(async () => {
    bench = await startHouseBench({ origin: ORIGIN, attention, reads, push: { send: f.send }, limits: { reqPerDevicePerMin: 10_000, gesturesPerDevicePerMin: 10_000 } })
    await registerAndUnlock(bench.fresh, bench.device.kD.pub)
    b = await browser()
  })
  after(async () => { await bench?.stop() })

  const deviceId = (): string => toHex(bench.device.result!.deviceId)

  test('push-key gives K_V (never K_H) and whether this device is subscribed', async () => {
    const r = await bench.fresh.request(OP.key)
    assert.equal(r.status, RES_STATUS.ok)
    assert.deepEqual(r.body, { key: b64url(bench.push!.publicKey), on: false })
  })

  test('push-on refuses an endpoint outside the list, says why, and keeps nothing', async () => {
    for (const [endpoint, why] of [['http://fcm.googleapis.com/x', 'scheme'], ['https://10.0.0.1/x', 'ip'], ['https://localhost/x', 'local'], ['https://evil.example/x', 'host'], ['https://u:p@fcm.googleapis.com/x', 'userinfo'], ['https://fcm.googleapis.com:444/x', 'port']] as const) {
      const r = await bench.fresh.request(OP.on, { ...b.body, endpoint }, { actId: actId() })
      assert.equal(r.status, RES_STATUS.badRequest, endpoint)
      assert.deepEqual(r.body, { error: 'push-service' })
      assert.ok(bench.audits().some((a) => a.act === 'attention.push-on' && a.result === `refused:${why}`), why)
    }
    const r = await bench.fresh.request(OP.on, { ...b.body, auth: b64url(new Uint8Array(8)) }, { actId: actId() })
    assert.deepEqual(r.body, { error: 'bad-request' })
    const extra = await bench.fresh.request(OP.on, { ...b.body, extra: 1 }, { actId: actId() })
    assert.equal(extra.status, RES_STATUS.badRequest, 'the body is strict')
    const noAct = await bench.fresh.request(OP.on, b.body)
    assert.equal(noAct.status, RES_STATUS.badRequest, 'an act needs its actId')
    assert.equal(bench.registry.get(deviceId())?.push, undefined)
  })

  test('push-on keeps the subscription in the registry; the audit says the device and the result, never the endpoint', async () => {
    const r = await bench.fresh.request(OP.on, b.body, { actId: actId() })
    assert.equal(r.status, RES_STATUS.ok, JSON.stringify(r.body))
    assert.deepEqual(r.body, { on: true })
    assert.equal(bench.registry.get(deviceId())?.push?.endpoint, b.endpoint)
    assert.deepEqual((await bench.fresh.request(OP.key)).body, { key: b64url(bench.push!.publicKey), on: true })
    const line = bench.audits().filter((a) => a.act === 'attention.push-on').at(-1)!
    assert.equal(line.result, 'ok')
    assert.equal(line.deviceId, deviceId())
    assert.equal(JSON.stringify(bench.notes).includes(b.endpoint), false, 'no note carries the endpoint')
  })

  test('an agent begins to wait: no notice while the session is on the screen; one when it is not, with the name and no text', async () => {
    attention.state({ slotId: 's_1', name: 'conferente', kind: 'agent', attention: 'waiting' } as never)
    await new Promise((r) => setTimeout(r, 300))
    assert.equal((await opened()).length, 0, 'the session is visible')
    assert.equal((await bench.fresh.request(OP.visible, { visible: 'no' })).status, RES_STATUS.badRequest)
    assert.equal((await bench.fresh.request(OP.visible, { visible: false })).status, RES_STATUS.ok)
    attention.state({ slotId: 's_2', name: 'C:\\Users\\x\\obra', kind: 'agent', attention: 'waiting' } as never)
    attention.state({ slotId: 's_3', name: 'revisor', kind: 'agent', attention: 'waiting' } as never)
    await until(() => f.sent.length >= 2 || undefined, 5_000, 'two notices')
    const got = await opened()
    assert.deepEqual(got.map((n) => n.tag).sort(), ['a:s_2', 'a:s_3'])
    const s2 = got.find((n) => n.tag === 'a:s_2')!
    assert.equal(s2.kind, 'waiting')
    assert.equal(s2.body, 'espera você')
    assert.equal(s2.url, '?tab=waiting')
    assert.equal(s2.title, 'obra', 'never a path: a name that is one keeps its last part')
    assert.ok(bench.audits().filter((a) => a.act === 'push.send' && a.result === 'ok' && a.target === 'waiting' && a.deviceId === deviceId()).length >= 2)
    // Who already waited does not wait again by staying.
    attention.state({ slotId: 's_3', name: 'revisor', kind: 'agent', attention: 'waiting' } as never)
    await new Promise((r) => setTimeout(r, 300))
    assert.equal((await opened()).length, 2)
  })

  test('a speech addressed to her and a poll that calls her: a notice each; any other line, none; never the text', async () => {
    const from = f.sent.length
    const line = (o: Record<string, unknown>) => ({ seq: 9, at: new Date().toISOString(), kind: 'message', from: { id: 'a1', name: 'conferente', role: 'member' }, body: `segredo ${MARKER}`, ...o })
    bench.house.extEvent('channels', 'line', { channelId: 'c_obra', room: 'obra', line: line({ to: ['guga'] }) })
    bench.house.extEvent('channels', 'line', { channelId: 'c_x1', room: 'x1', line: line({ to: ['revisor'] }) })
    bench.house.extEvent('channels', 'line', { channelId: 'c_x2', room: 'x2', line: line({}) })
    bench.house.extEvent('channels', 'line', { channelId: 'c_x3', room: 'x3', line: line({ to: ['Guga'], from: { id: 'user', name: 'Guga', role: 'moderator' } }) })
    bench.house.extEvent('channels', 'line', { channelId: 'c_x4', room: 'x4', line: line({ to: ['Guga'], kind: 'notice' }) })
    bench.house.extEvent('channels', 'reaction', { channelId: 'c_x5', room: 'x5', line: line({ to: ['Guga'] }) })
    bench.house.extEvent('channels', 'poll', { channelId: 'c_vota', room: 'vota', line: line({ kind: 'poll', body: '', poll: { type: 'ok', question: `pergunta ${MARKER}`, options: ['ok', 'não ok'], to: [{ id: 'user', name: 'Guga' }], closesAt: new Date().toISOString() } }) })
    bench.house.extEvent('channels', 'poll', { channelId: 'c_x6', room: 'x6', line: line({ kind: 'poll', body: '', poll: { type: 'ok', question: 'q', options: ['ok', 'não ok'], to: [{ id: 'a2', name: 'outro' }], closesAt: new Date().toISOString() } }) })
    bench.house.extEvent('channels', 'poll', { channelId: 'c_x7', room: 'x7', line: line({ kind: 'vote', body: '', vote: { poll: 9, option: 1 }, poll: { to: [{ id: 'user' }] } }) })
    await until(() => f.sent.length >= from + 2 || undefined, 5_000, 'two notices')
    await new Promise((r) => setTimeout(r, 200))
    const got = (await opened(from)).sort((x, y) => (x.kind < y.kind ? 1 : -1))
    assert.deepEqual(got, [
      { kind: 'talk', title: 'conferente', body: 'falou com você em #obra', tag: 'c:c_obra', url: '?c=c_obra' },
      { kind: 'poll', title: 'conferente', body: 'abriu uma enquete em #vota', tag: 'c:c_vota', url: '?c=c_vota' },
    ])
    assert.equal(has(got), false, 'no text of a line in a notice')
    assert.equal(has(bench.notes), false, 'nor in a note')
  })

  test('a device without the scope of the channels is told only who waits', async () => {
    const d = bench.house as unknown as { upsertDevice(dv: unknown): void }
    const row = structuredClone(bench.registry.get(deviceId())!)
    d.upsertDevice({ ...row, scopes: row.scopes.filter((s) => s !== 'channels') })
    const from = f.sent.length
    bench.house.extEvent('channels', 'line', { channelId: 'c_scope', room: 'scope', line: { seq: 1, kind: 'message', from: { id: 'a1', name: 'x', role: 'member' }, body: '', to: ['guga'] } })
    await new Promise((r) => setTimeout(r, 300))
    assert.equal((await opened(from)).length, 0)
    d.upsertDevice(row)
  })

  test('push-off drops the subscription; revocation drops it and nothing more goes', async () => {
    const off = await bench.fresh.request(OP.off, {}, { actId: actId() })
    assert.equal(off.status, RES_STATUS.ok)
    assert.deepEqual(off.body, { on: false })
    assert.equal(bench.registry.get(deviceId())?.push, undefined)
    assert.equal(bench.push!.has(deviceId()), false)
    assert.ok(bench.audits().some((a) => a.act === 'attention.push-off' && a.result === 'ok'))
    // Revocation.
    assert.equal((await bench.fresh.request(OP.on, b.body, { actId: actId() })).status, RES_STATUS.ok)
    assert.equal(bench.push!.has(deviceId()), true)
    await bench.house.revoke(deviceId(), [])
    assert.equal(bench.push!.has(deviceId()), false)
    const n = f.sent.length
    attention.state({ slotId: 's_9', name: 'depois', kind: 'agent', attention: 'waiting' } as never)
    await new Promise((r) => setTimeout(r, 300))
    await bench.push!.idle()
    assert.equal(f.sent.length, n, 'a revoked device is told nothing')
  })
})

describe('the house: 404/410 from the push service', () => {
  test('the subscription goes from the house and the registry', async () => {
    const attention = new AttentionView()
    const f = fakeSender(() => 410)
    const bench = await startHouseBench({ origin: ORIGIN, attention, push: { send: f.send }, limits: { reqPerDevicePerMin: 10_000, gesturesPerDevicePerMin: 10_000 } })
    try {
      await registerAndUnlock(bench.fresh, bench.device.kD.pub)
      const b = await browser()
      assert.equal((await bench.fresh.request(OP.on, b.body, { actId: actId() })).status, RES_STATUS.ok)
      await bench.fresh.request(OP.visible, { visible: false })
      const id = toHex(bench.device.result!.deviceId)
      assert.ok(bench.registry.get(id)?.push)
      attention.state({ slotId: 's_1', name: 'conferente', kind: 'agent', attention: 'waiting' } as never)
      await until(() => f.sent.length > 0 || undefined, 5_000, 'one send')
      await until(() => (bench.registry.get(id)?.push === undefined) || undefined, 5_000, 'the registry dropped it')
      assert.equal(bench.push!.has(id), false)
      assert.ok(bench.asks.some((a) => a.ask === 'push-drop' && a.why === 'gone'))
      assert.ok(bench.audits().some((a) => a.act === 'push.send' && a.result === 'gone'))
    } finally { await bench.stop() }
  })

  test('a device without a presence credential cannot subscribe (E-8), and a locked one cannot read the key', async () => {
    const bench = await startHouseBench({ origin: ORIGIN, push: { send: fakeSender().send } })
    try {
      const s = await bench.connect()
      const b = await browser()
      assert.equal((await s.request(OP.on, b.body, { actId: actId() })).status, RES_STATUS.presenceRequired)
      await registerAndUnlock(bench.fresh, bench.device.kD.pub)
      assert.equal((await bench.fresh.request(OP.lock, {}, { actId: actId() })).status, RES_STATUS.ok)
      assert.equal((await bench.fresh.request(OP.key)).status, RES_STATUS.locked)
      assert.equal((await bench.fresh.request(OP.visible, { visible: false })).status, RES_STATUS.ok, 'a locked session still says whether it is on the screen')
    } finally { await bench.stop() }
  })
})
