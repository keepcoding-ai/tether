// A House (src/remoted/house.ts) in this process, on the real RelayLink and the FakeRelay of remoted.helpers.ts, with a
// device paired through it: the same path the portal runs, without the process, the pipe and the registry (the asks are
// answered at once and the notes are kept). For tests that need to see what the house says about a request.
import { buildHouseAuth } from '../../src/remote/index.ts'
import { AttentionView } from '../../src/remoted/attention.ts'
import { House } from '../../src/remoted/house.ts'
import type { PortalNote } from '../../src/remoted/ipc.ts'
import { loadKeys } from '../../src/remoted/keyfiles.ts'
import type { Limits } from '../../src/remoted/limits.ts'
import { audOf, RelayLink } from '../../src/remoted/relay.ts'
import { ensureKeys } from '../../extensions/remote/daemon/keys.ts'
import { FakeRelay, TestDevice, until, type DeviceSession } from './remoted.helpers.ts'

export interface HouseBench {
  house: House
  relay: FakeRelay
  device: TestDevice
  /** Every note the house sent the extension, in order. */
  notes: PortalNote[]
  /** The audit lines among them. */
  audits(): Extract<PortalNote, { note: 'audit' }>[]
  /** A normal session of the paired device (admission + handshake). */
  connect(): Promise<DeviceSession>
  stop(): Promise<void>
}

export async function startHouseBench(o: { limits?: Partial<Limits> } = {}): Promise<HouseBench> {
  const nowS = Math.floor(Date.now() / 1000)
  const texts = await ensureKeys({}, nowS)
  const keys = await loadKeys({ house: texts.house!, relay: texts.relay!, ticket: texts.ticket! })
  const relay = await FakeRelay.start()
  const aud = audOf(relay.url)
  const notes: PortalNote[] = []
  let link: RelayLink | undefined
  const house = new House({
    keys, aud, houseName: 'bench', attention: new AttentionView(), log: () => {}, now: Date.now, ask: async () => {},
    send: (f) => link?.send(f), note: (n) => notes.push(n), notice: () => {}, ...(o.limits ? { limits: o.limits } : {}),
  })
  await house.init([], [])
  link = new RelayLink({
    url: relay.url, log: () => {},
    auth: (r) => buildHouseAuth({ r, aud, pubH: keys.kH.pub, certR: keys.certR, certsT: keys.certsT, kR: keys.kR, nowS: Math.floor(Date.now() / 1000) }),
    up: () => house.linkUp(), down: () => house.linkDown(), frame: (b) => house.onFrame(b),
  })
  link.start()
  const tick = setInterval(() => { void house.tick().catch(() => {}) }, 100)
  await until(() => relay.linkUp, 10_000, 'the house at the relay')

  const device = await TestDevice.make(relay)
  const begun = await house.pairBegin()
  const { sas, done } = await device.pair(begun.code, { name: 'Telefone de teste' })
  const digits = await sas
  await until(() => house.pairState(begun.pairId).state === 'waiting-sas' || undefined, 5_000, 'waiting for the SAS')
  await house.pairSas(begun.pairId, digits)
  const first = await done
  if ('failed' in first) throw new Error(`pairing failed: ${first.failed}`)
  await until(() => house.pairState(begun.pairId).state === 'done' || undefined, 5_000, 'pairing done')

  let stopped = false
  return {
    house, relay, device, notes,
    audits: () => notes.filter((n): n is Extract<PortalNote, { note: 'audit' }> => n.note === 'audit'),
    async connect() {
      const s = await device.connect()
      if ('failed' in s) throw new Error(`connect failed: ${s.failed}`)
      return s
    },
    async stop() {
      if (stopped) return
      stopped = true
      clearInterval(tick)
      link?.stop()
      await house.shutdown()
      await relay.close()
    },
  }
}
