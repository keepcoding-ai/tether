// Every limit of the portal in one place (fio-spec 5.8; plano §2, threat "DoS na casa pelo relay": tickets, limits at the
// relay per house and IP, ceilings at the portal per device). The values that already existed are unchanged; the two
// per-device rates and the strike count are new. Pure: no node:*.
import { ROUTES_PER_HOUSE, SESSIONS_PER_DEVICE } from '../remote/index.ts'

export interface Limits {
  /** Routes the relay may hold open on the house's socket (admissions, pairing and sessions together). */
  routesPerHouse: number
  /** Live sessions of one device. */
  sessionsPerDevice: number
  /** Every session of the portal, all devices together. */
  sessionsMax: number
  /** Spec 5.8: handshakes per minute per ticketId hint. */
  hsPerTicketPerMin: number
  /** Spec 5.8: handshakes pending in total. */
  hsPendingMax: number
  /** A ticketId that went over its rate stays in H_DENY this long (spec 5.8: 10 minutes). */
  hsRateDenyS: number
  /** Requests in flight per session; above it the request is answered `limit`. */
  inflightMax: number
  /**
   * Frames waiting on one route. A device keeps at most `inflightMax` requests open, plus a handshake frame or a CLOSE:
   * twice that leaves room for an honest burst; more is a relay or device flooding the house's memory, and the route goes.
   */
  routeQueueMax: number
  /**
   * Requests per minute per device, all its sessions together. The app asks for the attention list when it opens and
   * then watches; a person tapping through screens makes a few per second at most. 120 is two per second sustained:
   * far above a person, far below a loop.
   */
  reqPerDevicePerMin: number
  /**
   * Gestures (E-11: what the person's own input does: lock, revoke, and later typing) per minute per device. A gesture
   * is slower than a read and costs the machine more, so the ceiling is a quarter of the requests': one every 2 s.
   */
  gesturesPerDevicePerMin: number
  /**
   * Requests refused by the two rates above, within one minute, before the session is closed (CLOSE 0x07). Five is the
   * number of attempts a pairing ticket tolerates (plano §2): enough for a bug or a retry, not for insisting.
   */
  strikesMax: number
}

export const LIMITS: Readonly<Limits> = Object.freeze({
  routesPerHouse: ROUTES_PER_HOUSE,
  sessionsPerDevice: SESSIONS_PER_DEVICE,
  sessionsMax: 32,
  hsPerTicketPerMin: 6,
  hsPendingMax: 32,
  hsRateDenyS: 600,
  inflightMax: 16,
  routeQueueMax: 2 * 16,
  reqPerDevicePerMin: 120,
  gesturesPerDevicePerMin: 30,
  strikesMax: 5,
})

const WINDOW_MS = 60_000

/** `limit`: refuse this request (answer 0x07 and audit); `close`: the device insisted, end the session. */
export type LimitVerdict = 'ok' | 'limit' | 'close'

/**
 * The per-device rate of one minute, sliding. Memory is bounded by the limits themselves (never more than the ceiling of
 * instants per list), so a device cannot grow it. A refused request does not count against the window (the device
 * recovers when it stops) but is a strike; the strikes also slide over a minute.
 */
export class DeviceLimiter {
  readonly #lim: Pick<Limits, 'reqPerDevicePerMin' | 'gesturesPerDevicePerMin' | 'strikesMax'>
  readonly #reqs: number[] = []
  readonly #gestures: number[] = []
  readonly #strikes: number[] = []

  constructor(lim: Pick<Limits, 'reqPerDevicePerMin' | 'gesturesPerDevicePerMin' | 'strikesMax'> = LIMITS) { this.#lim = lim }

  /** Every request, before it is looked at. */
  request(nowMs: number): LimitVerdict { return this.#take(this.#reqs, this.#lim.reqPerDevicePerMin, nowMs) }

  /** A request the gate let through whose line is a gesture. */
  gesture(nowMs: number): LimitVerdict { return this.#take(this.#gestures, this.#lim.gesturesPerDevicePerMin, nowMs) }

  #take(list: number[], max: number, nowMs: number): LimitVerdict {
    prune(list, nowMs)
    if (list.length < max) { list.push(nowMs); return 'ok' }
    prune(this.#strikes, nowMs)
    if (this.#strikes.length < this.#lim.strikesMax) this.#strikes.push(nowMs)
    return this.#strikes.length >= this.#lim.strikesMax ? 'close' : 'limit'
  }
}

function prune(list: number[], nowMs: number): void {
  let n = 0
  while (n < list.length && nowMs - list[n]! >= WINDOW_MS) n++
  if (n) list.splice(0, n)
}
