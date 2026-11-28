// The portal's Web Push (RR4 step 4.4; plano §2 "Push", fio-spec 15): the house tells a device, whose app is closed, that
// an agent began to wait for the person, that a speech was addressed to her or that a poll calls her. The portal dials the
// device's push service itself (never through the relay), with the house's VAPID key (K_V) and a body only that device
// opens (RFC 8291, src/remote/webpush.ts). This file is the sending: who gets a notice, how often, and what happens with
// the answer. Who is eligible (an active device, its scopes, no session live and visible) is the house's to say.
//
// The portal now dials out to an address a device gave, so the boundary is drawn here:
//   - the endpoint passes pushEndpointCheck when taken AND before every send (a row of the registry is no proof);
//   - no redirect is followed, a send has a short deadline, the answer's body is thrown away unread;
//   - no header names the house but VAPID (no `From`, no custom header; the `sub` claim is an .invalid address);
//   - a failure only counts and leaves a line: the log says the host, never the URL; the audit says the device, the kind
//     of the notice and the outcome, never the endpoint nor a name.
// Pace (memory stays bounded whatever the house does): at most one notice per device and tag every PUSH_GAP_MS (the
// rest coalesce: the notice on the device already says it, and the tag makes a new one replace it), PUSH_DEVICE_HOUR_MAX
// per device per hour, PUSH_INFLIGHT_MAX sends at once and PUSH_QUEUE_MAX waiting for the whole portal; over a ceiling
// the notice is dropped and counted, never queued without end. 404/410: the subscription is gone; it is dropped here
// and the registry's writer is asked to forget it.
import { fromB64url, utf8, type Bytes } from '../remote/bytes.ts'
import {
  checkPushSubscription, pushEndpointCheck, vapidAuthorization, webPushEncrypt, type PushNotice, type PushSubscriptionVerdict, type VapidKey,
} from '../remote/webpush.ts'
import type { PushSubRow } from './ipc.ts'

export const PUSH_GAP_MS = 30_000
export const PUSH_DEVICE_HOUR_MAX = 20
export const PUSH_INFLIGHT_MAX = 4
export const PUSH_QUEUE_MAX = 32
export const PUSH_TIMEOUT_MS = 5_000
/** How long the push service keeps a notice for a device that is offline: a notice older than this says nothing anymore. */
export const PUSH_TTL_S = 3_600
/** The plaintext is padded to a multiple of this, so the service does not tell one kind of notice from another by length. */
const PAD_TO = 256

/** One POST, as the sender makes it: the status the service answered. Throws on a network failure or the deadline. */
export type PushSend = (url: string, init: { headers: Record<string, string>; body: Bytes; timeoutMs: number }) => Promise<number>

/** The real sender: Node's fetch, no redirect followed, a deadline, the body of the answer discarded unread. */
export const fetchSend: PushSend = async (url, o) => {
  const res = await fetch(url, { method: 'POST', headers: o.headers, body: o.body, redirect: 'manual', signal: AbortSignal.timeout(o.timeoutMs) })
  void res.body?.cancel().catch(() => { /* gone already */ })
  return res.status
}

export interface PushDeps {
  key: VapidKey
  now(): number
  send?: PushSend
  /** Bench only (src/remoted/main.ts): the fake push service's origin, and no other, may be dialled. */
  benchOrigin?: string
  /** True on the bench: then only `benchOrigin` is dialled, so no test ever reaches a real push service. */
  benchOnly?: boolean
  /** Bench: a shorter gap between two notices of one device and tag (PUSH_GAP_MS). */
  gapMs?: number
  audit(act: string, result: string, deviceId?: string, target?: string): void
  log(msg: string): void
  /** The service said the subscription is gone: the registry's writer forgets it (the portal already did). */
  gone(deviceId: string): void
}

/** What happened to notices since the portal started (diagnostics and tests). */
export interface PushCounts { sent: number; failed: number; gone: number; coalesced: number; limited: number; busy: number }

interface Job { deviceId: string; sub: PushSubRow; notice: PushNotice }

export class PortalPush {
  readonly #d: PushDeps
  readonly #send: PushSend
  readonly #subs = new Map<string, PushSubRow>()
  /** `<deviceId> <tag>` → when its last notice was let through; entries older than PUSH_GAP_MS are swept. */
  readonly #last = new Map<string, number>()
  /** deviceId → the instants of its notices of the last hour (at most PUSH_DEVICE_HOUR_MAX each). */
  readonly #hour = new Map<string, number[]>()
  readonly #queue: Job[] = []
  #inflight = 0
  #idle: (() => void)[] = []
  readonly counts: PushCounts = { sent: 0, failed: 0, gone: 0, coalesced: 0, limited: 0, busy: 0 }

  constructor(deps: PushDeps) {
    this.#d = deps
    this.#send = deps.send ?? fetchSend
  }

  get publicKey(): Bytes { return this.#d.key.pub }

  /** Whether the portal would POST to this endpoint now. */
  allowed(endpoint: string): boolean { return pushEndpointCheck(endpoint, this.#d.benchOrigin).ok }

  /** The body of attention.push-on, checked by the rule of the endpoint and of the keys (src/remote/webpush.ts). */
  check(body: Record<string, unknown>): Promise<PushSubscriptionVerdict> { return checkPushSubscription(body, this.#d.benchOrigin) }

  /** The subscription of a device, from the registry or a push-on (undefined: none). A row whose endpoint is not allowed is not kept. */
  set(deviceId: string, sub: PushSubRow | undefined): void {
    if (sub && this.allowed(sub.endpoint)) this.#subs.set(deviceId, sub)
    else this.#subs.delete(deviceId)
  }

  has(deviceId: string): boolean { return this.#subs.has(deviceId) }

  /** The devices that have a subscription. */
  devices(): string[] { return [...this.#subs.keys()] }

  /** Revocation or forget: nothing more goes to this device, and what waited for it is dropped. */
  forget(deviceId: string): void {
    this.#subs.delete(deviceId)
    this.#hour.delete(deviceId)
    for (const k of [...this.#last.keys()]) if (k.startsWith(`${deviceId} `)) this.#last.delete(k)
    for (let i = this.#queue.length - 1; i >= 0; i--) if (this.#queue[i]!.deviceId === deviceId) this.#queue.splice(i, 1)
  }

  /** One notice to each of these devices (already eligible by the house's rule), by the pace of this file. */
  notify(notice: PushNotice, deviceIds: readonly string[]): void {
    const now = this.#d.now()
    const gap = this.#d.gapMs ?? PUSH_GAP_MS
    for (const [k, t] of this.#last) if (now - t >= gap) this.#last.delete(k)
    for (const deviceId of deviceIds) {
      const sub = this.#subs.get(deviceId)
      if (!sub) continue
      const key = `${deviceId} ${notice.tag}`
      if (this.#last.has(key)) { this.counts.coalesced++; continue }
      const hour = (this.#hour.get(deviceId) ?? []).filter((t) => now - t < 3_600_000)
      if (hour.length >= PUSH_DEVICE_HOUR_MAX) { this.#hour.set(deviceId, hour); this.counts.limited++; continue }
      if (this.#queue.length >= PUSH_QUEUE_MAX) {
        this.counts.busy++
        this.#d.log('push: a notice dropped, the queue is full')
        continue
      }
      hour.push(now)
      this.#hour.set(deviceId, hour)
      this.#last.set(key, now)
      this.#queue.push({ deviceId, sub, notice })
    }
    this.#pump()
  }

  /** Resolves when nothing waits and nothing is in flight (tests). */
  idle(): Promise<void> {
    if (this.#inflight === 0 && this.#queue.length === 0) return Promise.resolve()
    return new Promise((resolve) => this.#idle.push(resolve))
  }

  #pump(): void {
    while (this.#inflight < PUSH_INFLIGHT_MAX && this.#queue.length > 0) {
      const job = this.#queue.shift()!
      this.#inflight++
      void this.#deliver(job).finally(() => {
        this.#inflight--
        this.#pump()
        if (this.#inflight === 0 && this.#queue.length === 0) for (const r of this.#idle.splice(0)) r()
      })
    }
  }

  async #deliver(job: Job): Promise<void> {
    const { deviceId, sub, notice } = job
    // The row may have changed or gone while this waited: the subscription of now is the one that counts.
    if (this.#subs.get(deviceId) !== sub) return
    const check = pushEndpointCheck(sub.endpoint, this.#d.benchOrigin)
    if (!check.ok || (this.#d.benchOnly === true && check.origin !== this.#d.benchOrigin)) {
      this.counts.failed++
      this.#d.audit('push.send', `refused:${check.ok ? 'bench' : check.why}`, deviceId, notice.kind)
      return
    }
    let result: string
    try {
      const body = await webPushEncrypt({ uaPublic: fromB64url(sub.p256dh), auth: fromB64url(sub.auth), plaintext: utf8(JSON.stringify(notice)), padTo: PAD_TO })
      const headers = {
        Authorization: await vapidAuthorization(this.#d.key, check.origin, Math.floor(this.#d.now() / 1000)),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(PUSH_TTL_S),
        Urgency: 'high',
      }
      const status = await this.#send(sub.endpoint, { headers, body, timeoutMs: PUSH_TIMEOUT_MS })
      if (status >= 200 && status < 300) { result = 'ok'; this.counts.sent++ }
      else if (status === 404 || status === 410) {
        result = 'gone'
        this.counts.gone++
        if (this.#subs.get(deviceId) === sub) {
          this.#subs.delete(deviceId)
          this.#d.gone(deviceId)
        }
      } else {
        result = `failed:${status >= 300 && status < 400 ? 'redirect' : String(status)}`
        this.counts.failed++
        this.#d.log(`push: ${check.host} answered ${status}`)
      }
    } catch (e) {
      const why = (e as Error)?.name === 'TimeoutError' || (e as Error)?.name === 'AbortError' ? 'timeout' : 'network'
      result = `failed:${why}`
      this.counts.failed++
      this.#d.log(`push: ${check.host} ${why}`)
    }
    this.#d.audit('push.send', result, deviceId, notice.kind)
  }
}
