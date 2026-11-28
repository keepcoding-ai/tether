// A House (src/remoted/house.ts) in this process, on the real RelayLink and the FakeRelay of remoted.helpers.ts, with a
// device paired through it: the same path the portal runs, without the process, the pipe and the extension. The asks are
// answered as the extension answers them, on a registry kept here (so a restart of the house reads back what it wrote),
// and the notes are kept. For tests that need to see what the house says about a request.
import { buildHouseAuth, relyingParty, toHex, type RelyingParty } from '../../src/remote/index.ts'
import { AttentionView } from '../../src/remoted/attention.ts'
import { DEFAULT_SCOPES, House } from '../../src/remoted/house.ts'
import type { PortalAsk, PortalDevice, PortalNote } from '../../src/remoted/ipc.ts'
import { loadKeys, loadVapidKey } from '../../src/remoted/keyfiles.ts'
import { PortalPush, type PushSend } from '../../src/remoted/push.ts'
import type { Limits } from '../../src/remoted/limits.ts'
import { audOf, RelayLink } from '../../src/remoted/relay.ts'
import type { PipeReads } from '../../src/remoted/reads.ts'
import type { PipeWrites } from '../../src/remoted/writes.ts'
import type { PipeActs } from '../../src/remoted/acts.ts'
import type { PortalFiles } from '../../src/remoted/files.ts'
import type { PresenceClock } from '../../src/remoted/uv.ts'
import { ensureKeys } from '../../extensions/remote/daemon/keys.ts'
import { FakeRelay, TestDevice, until, type DeviceSession } from './remoted.helpers.ts'

export interface HouseBenchOptions {
  limits?: Partial<Limits>
  /** The origin of the PWA (the remote's webUrl): with it, a device can register a presence credential. */
  origin?: string
  /** Every answer of the registry waits this long (a slow disk): what the lanes per device must survive. */
  askDelayMs?: number
  presenceClock?: Partial<PresenceClock>
  /** The old ticket of a renewal is denied this long after it (the portal's default is a minute). */
  renewDenyAfterMs?: number
  /** The portal's clock (the house's `now`); absent, Date.now. A test moves it to let the presence clocks run. */
  now?: () => number
  /** The reads of tetherd's extensions (src/remoted/reads.ts); absent, the read lines answer not-implemented. */
  reads?: PipeReads
  /** The writes to tetherd's extensions (src/remoted/writes.ts); absent, the write lines answer not-implemented. */
  writes?: PipeWrites
  /** How long a repeat of a write in flight waits for it (the write path's deadline). */
  writeTimeoutMs?: number
  /** The management acts on tetherd (src/remoted/acts.ts); absent, the management lines answer not-implemented. */
  acts?: PipeActs
  /** How long a repeat of an act in flight waits for it (the act path's deadline). */
  actTimeoutMs?: number
  /** The gestures the app does (RR5 5.1): the write path to `regency/act`; absent, those lines answer not-implemented. */
  appActs?: PipeWrites
  appActTimeoutMs?: number
  noticeGapsMs?: Partial<{ channels: number; regency: number }>
  /** The files of a speech from afar (src/remoted/files.ts); absent, the file lines answer not-implemented. */
  files?: PortalFiles
  /** Web Push (src/remoted/push.ts) with this sender instead of fetch; absent, the push lines answer not-implemented. */
  push?: { send: PushSend; benchOrigin?: string; now?: () => number }
  /** The waiting list the house reads (a test feeds it slots); absent, an empty one. */
  attention?: AttentionView
}

export interface PairedDevice { device: TestDevice; fresh: DeviceSession }

export interface HouseBench {
  /** The house now (a restart replaces it). */
  house: House
  relay: FakeRelay
  device: TestDevice
  /** The session that concluded the pairing of `device`. */
  fresh: DeviceSession
  rp: RelyingParty | undefined
  /** What the extension would hold in devices.json, written only through the house's asks and notes. */
  registry: Map<string, PortalDevice>
  /** Every ask the house made, in order. */
  asks: PortalAsk[]
  /** Every note the house sent the extension, in order. */
  notes: PortalNote[]
  /** Every native notice the house gave the person. */
  notices: string[]
  /** The audit lines among them. */
  audits(): Extract<PortalNote, { note: 'audit' }>[]
  /** The house's Web Push (with `push`), the same one across restarts. */
  push: PortalPush | undefined
  /** A normal session of the paired device (admission + handshake). */
  connect(d?: TestDevice): Promise<DeviceSession>
  /** Pairs one more device through the house. */
  pair(name?: string): Promise<PairedDevice>
  /** The portal goes and comes back: a new House on the same keys and relay, initialized from the registry. */
  restart(): Promise<void>
  stop(): Promise<void>
}

export async function startHouseBench(o: HouseBenchOptions = {}): Promise<HouseBench> {
  const nowS = Math.floor(Date.now() / 1000)
  const texts = await ensureKeys({}, nowS)
  const keys = await loadKeys({ house: texts.house!, relay: texts.relay!, ticket: texts.ticket! })
  const relay = await FakeRelay.start()
  const aud = audOf(relay.url)
  const rp = o.origin ? relyingParty(o.origin) : undefined
  const notes: PortalNote[] = []
  const asks: PortalAsk[] = []
  const registry = new Map<string, PortalDevice>()
  const notices: string[] = []

  const answer = async (a: PortalAsk): Promise<void> => {
    asks.push(a)
    if (o.askDelayMs) await new Promise((r) => setTimeout(r, o.askDelayMs))
    switch (a.ask) {
      case 'paired':
        registry.set(a.device.deviceId, {
          deviceId: a.device.deviceId, pubD: a.device.pubD, state: 'pending', maxVerUsed: a.device.ver, scopes: [...DEFAULT_SCOPES],
          tickets: [a.ticket], usedKeyIds: [a.ticket.keyId],
        })
        return
      case 'renew': {
        const d = registry.get(a.deviceId)
        if (!d || d.state !== 'active') throw new Error('device not active')
        d.denied = [...(d.denied ?? []), ...d.tickets.map((t) => ({ ticketId: t.ticketId, exp: t.exp }))]
        d.tickets = [a.ticket]
        d.usedKeyIds.push(a.ticket.keyId)
        return
      }
      case 'credential': {
        const d = registry.get(a.deviceId)
        if (!d || d.state === 'revoked' || d.credential) throw new Error('refused')
        d.credential = { ...a.credential }
        return
      }
      case 'sign-count': {
        const d = registry.get(a.deviceId)
        if (!d?.credential) throw new Error('no credential')
        d.credential = { ...d.credential, signCount: a.signCount }
        return
      }
      case 'push-sub': {
        const d = registry.get(a.deviceId)
        if (!d || d.state !== 'active') throw new Error('device not active')
        d.push = { ...a.sub }
        return
      }
      case 'push-drop': {
        const d = registry.get(a.deviceId)
        if (d) delete d.push
      }
    }
  }
  const vapid = o.push ? await loadVapidKey(texts.vapid!) : undefined
  let pushNow: House | undefined
  const push = o.push && vapid
    ? new PortalPush({
      key: vapid, now: o.push.now ?? o.now ?? Date.now, send: o.push.send, log: () => {},
      ...(o.push.benchOrigin ? { benchOrigin: o.push.benchOrigin } : {}),
      audit: (act, result, deviceId, target) => { notes.push({ note: 'audit', act, result, ...(deviceId ? { deviceId } : {}), ...(target ? { target } : {}) }) },
      gone: (deviceId) => pushNow?.pushGone(deviceId),
    })
    : undefined
  let current: House | undefined
  const onNote = (n: PortalNote): void => {
    notes.push(n)
    if (n.note === 'acked') { const d = registry.get(n.deviceId); if (d) d.state = 'active' }
    // A revocation from another device as the extension runs it (spec 6.1): the registry first, then the portal closes and
    // denies. `revoke-self` stays a note here: the tests that walk the table keep their device.
    const d = n.note === 'revoke-device' ? registry.get(n.target) : undefined
    if (d && d.state !== 'revoked') {
      d.state = 'revoked'
      void current?.revoke(d.deviceId, d.tickets.map((t) => ({ ticketId: t.ticketId, exp: t.exp })))
    }
  }

  let link: RelayLink | undefined
  let tick: NodeJS.Timeout | undefined
  const up = async (devices: PortalDevice[]): Promise<House> => {
    const house = new House({
      keys, aud, houseName: 'bench', attention: o.attention ?? new AttentionView(), log: () => {}, now: o.now ?? Date.now, ask: answer,
      ...(push ? { push } : {}),
      send: (f) => link?.send(f), note: onNote, notice: (t) => { notices.push(t) },
      ...(o.limits ? { limits: o.limits } : {}), ...(o.renewDenyAfterMs ? { renewDenyAfterMs: o.renewDenyAfterMs } : {}), ...(rp ? { rp } : {}), ...(o.presenceClock ? { presenceClock: o.presenceClock } : {}),
      ...(o.reads ? { reads: o.reads } : {}), ...(o.noticeGapsMs ? { noticeGapsMs: o.noticeGapsMs } : {}),
      ...(o.writes ? { writes: o.writes } : {}), ...(o.writeTimeoutMs ? { writeTimeoutMs: o.writeTimeoutMs } : {}),
      ...(o.acts ? { acts: o.acts } : {}), ...(o.actTimeoutMs ? { actTimeoutMs: o.actTimeoutMs } : {}),
      ...(o.appActs ? { appActs: o.appActs } : {}), ...(o.appActTimeoutMs ? { appActTimeoutMs: o.appActTimeoutMs } : {}),
      ...(o.files ? { files: o.files } : {}),
    })
    await house.init(devices, [])
    current = house
    pushNow = house
    const auths = relay.houseAuths
    link = new RelayLink({
      url: relay.url, log: () => {},
      auth: (r) => buildHouseAuth({ r, aud, pubH: keys.kH.pub, certR: keys.certR, certsT: keys.certsT, kR: keys.kR, nowS: Math.floor(Date.now() / 1000) }),
      up: () => house.linkUp(), down: () => house.linkDown(), frame: (b) => house.onFrame(b),
    })
    link.start()
    tick = setInterval(() => { void house.tick().catch(() => {}) }, 100)
    await until(() => (relay.linkUp && relay.houseAuths > auths) || undefined, 10_000, 'the house at the relay')
    return house
  }

  const bench: HouseBench = {
    house: await up([]),
    relay, rp, registry, asks, notes, notices, push,
    device: undefined as unknown as TestDevice,
    fresh: undefined as unknown as DeviceSession,
    audits: () => notes.filter((n): n is Extract<PortalNote, { note: 'audit' }> => n.note === 'audit'),
    async connect(d = bench.device) {
      const s = await d.connect()
      if ('failed' in s) throw new Error(`connect failed: ${s.failed}`)
      return s
    },
    async pair(name = 'Telefone de teste') {
      const device = await TestDevice.make(relay)
      const begun = await bench.house.pairBegin()
      const { sas, done } = await device.pair(begun.code, { name })
      const digits = await sas
      await until(() => bench.house.pairState(begun.pairId).state === 'waiting-sas' || undefined, 5_000, 'waiting for the SAS')
      await bench.house.pairSas(begun.pairId, digits)
      const first = await done
      if ('failed' in first) throw new Error(`pairing failed: ${first.failed}`)
      await until(() => bench.house.pairState(begun.pairId).state === 'done' || undefined, 5_000, 'pairing done')
      await until(() => registry.get(toHex(device.result!.deviceId))?.state === 'active' || undefined, 5_000, 'the device active')
      return { device, fresh: first }
    },
    async restart() {
      clearInterval(tick)
      link?.stop()
      await bench.house.shutdown()
      await until(() => !relay.linkUp || undefined, 5_000, 'the old house gone from the relay')
      bench.house = await up([...registry.values()].map((d) => structuredClone(d)))
    },
    async stop() {
      if (stopped) return
      stopped = true
      clearInterval(tick)
      link?.stop()
      await bench.house.shutdown()
      await relay.close()
    },
  }
  let stopped = false
  const first = await bench.pair()
  bench.device = first.device
  bench.fresh = first.fresh
  return bench
}
