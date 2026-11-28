// "Avisos neste aparelho" (RR4 step 4.4): the browser's half of Web Push. The house's VAPID key comes by a read
// (attention.push-key); the person turns the notices on with a tap, which asks the browser's permission there and then,
// subscribes the service worker's registration and sends the subscription to the house (attention.push-on, an act with
// its actId); off sends attention.push-off and drops the browser's subscription. Nothing of a subscription is kept by the
// page: the browser keeps it, the house keeps its copy. The service worker only shows what came encrypted for it.
import { fromB64url, opByName, RES_STATUS } from '../../../src/remote/index.ts'
import type { Live } from './live.ts'
import { isIos, pushModel, sameKey, type PushFacts, type PushModel } from './push-rules.ts'

const KEY = opByName('attention.push-key')!.code
const ON = opByName('attention.push-on')!.code
const OFF = opByName('attention.push-off')!.code
/** How long the page waits for its service worker to be active before it gives up on subscribing. */
const READY_MS = 10_000

export interface DevicePush {
  /** What the item says now (`tv`: the screen is the TV's). */
  model(tv: boolean): PushModel
  /** The session is up: read the house's key and whether this device is subscribed. */
  attach(live: Live): void
  detach(): void
  /** The person's tap: on or off. */
  turn(to: 'on' | 'off'): Promise<void>
  /** Something the item shows changed. */
  onChange: () => void
}

const supported = (): boolean => typeof navigator !== 'undefined' && 'serviceWorker' in navigator && typeof PushManager !== 'undefined' && typeof Notification !== 'undefined'

function ready(): Promise<ServiceWorkerRegistration> {
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('no service worker')), READY_MS)),
  ])
}

export function createPush(): DevicePush {
  let live: Live | undefined
  let key: string | undefined
  let houseOn = false
  let browserOn = false
  let busy = false
  let fail: PushFacts['fail']

  const facts = (tv: boolean): PushFacts => {
    const nav = navigator as Navigator & { standalone?: boolean }
    return {
      tv,
      supported: supported(),
      ios: isIos(nav.userAgent, nav.platform, nav.maxTouchPoints ?? 0),
      standalone: nav.standalone === true || (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches),
      permission: supported() ? Notification.permission : 'default',
      on: houseOn && browserOn,
      busy,
      ...(fail ? { fail } : {}),
    }
  }

  const self: DevicePush = {
    onChange: () => {},
    model: (tv) => pushModel(facts(tv)),
    attach(l) {
      live = l
      void refresh(l)
    },
    detach() { live = undefined },
    async turn(to) {
      const l = live
      if (!l || busy || !supported()) return
      busy = true
      fail = undefined
      self.onChange()
      try {
        if (to === 'on') await turnOn(l)
        else await turnOff(l)
      } catch { fail = to === 'on' ? 'failed' : undefined } finally {
        busy = false
        self.onChange()
      }
    },
  }

  async function refresh(l: Live): Promise<void> {
    if (!supported()) { self.onChange(); return }
    const r = await l.request(KEY)
    if (live !== l) return
    if (r.status !== RES_STATUS.ok || typeof r.body.key !== 'string') { key = undefined; houseOn = false; self.onChange(); return }
    key = r.body.key
    houseOn = r.body.on === true
    try {
      const reg = await navigator.serviceWorker.getRegistration()
      const sub = await reg?.pushManager.getSubscription()
      browserOn = !!sub && sameKey(sub.options.applicationServerKey, key)
    } catch { browserOn = false }
    self.onChange()
  }

  async function turnOn(l: Live): Promise<void> {
    // The permission first, inside the tap (some browsers ask only from a gesture).
    const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission
    if (permission !== 'granted') return
    if (!key) await refresh(l)
    if (!key) { fail = 'failed'; return }
    const reg = await ready()
    let sub = await reg.pushManager.getSubscription()
    if (sub && !sameKey(sub.options.applicationServerKey, key)) { await sub.unsubscribe(); sub = null }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64url(key) })
    const j = sub.toJSON()
    const r = await l.request(ON, { endpoint: j.endpoint ?? '', p256dh: j.keys?.p256dh ?? '', auth: j.keys?.auth ?? '' }, { mutates: true })
    if (r.status === RES_STATUS.ok) { houseOn = true; browserOn = true; return }
    if (r.body.error === 'push-service') {
      // The house will not post there: the browser's subscription serves nothing, it goes.
      fail = 'service'
      await sub.unsubscribe().catch(() => false)
      browserOn = false
      return
    }
    fail = 'failed'
  }

  async function turnOff(l: Live): Promise<void> {
    const r = await l.request(OFF, {}, { mutates: true })
    if (r.status === RES_STATUS.ok) houseOn = false
    const reg = await navigator.serviceWorker.getRegistration()
    const sub = await reg?.pushManager.getSubscription()
    if (sub) await sub.unsubscribe().catch(() => false)
    browserOn = false
  }

  return self
}
