// Every limit of the portal in one place (fio-spec 5.8; plano §2, threat "DoS na casa pelo relay": tickets, limits at the
// relay per house and IP, ceilings at the portal per device). The values that already existed are unchanged; the two
// per-device rates and the strike count are new. Pure: no node:*.
import { ADMIT_TTL_S, ROUTES_PER_HOUSE, SESSIONS_PER_DEVICE } from '../remote/index.ts'
import { FILE_CHUNKS_PER_DEVICE_PER_MIN } from '../remote/files.ts'

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
   * Bytes of the frames waiting on one route (B-3 of the RR2 gate): the frame count alone let a relay hold 32 frames of
   * MAX_INNER on each of 32 routes, 256 MiB. 1 MiB is the relay's own queue per route (fio-spec 5.7); over it the route goes.
   */
  routeQueueBytesMax: number
  /** Bytes waiting on every route of the house together: 8 MiB, the relay's queue of the house socket (5.7). Over it, the route that would pass it goes. */
  houseQueueBytesMax: number
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
   * Speeches (channels.say) per minute per device (RR4 4.2a). The channels' rules pace a reaction, a vote change and a poll,
   * never a speech, and a speech reaches every agent of the channel: its own ceiling, which stays when the gestures' grows
   * (typing in a terminal will be a gesture too). Refused with `limit` and `slow-down`; it counts as a strike like the others.
   */
  speechPerDevicePerMin: number
  /**
   * Chunk requests of files (channels.file, channels.upload) per minute per device (RR4 4.3): they are counted here and NOT
   * against `reqPerDevicePerMin`, each as a whole chunk, so this is the device's bytes of files a minute
   * (src/remote/files.ts FILE_BYTES_PER_DEVICE_PER_MIN). Over it, `limit` with `slow-down`, a strike like the others.
   */
  fileChunksPerDevicePerMin: number
  /**
   * Requests refused by the two rates above, within one minute, before the session is closed (CLOSE 0x07). Five is the
   * number of attempts a pairing ticket tolerates (plano §2): enough for a bug or a retry, not for insisting.
   */
  strikesMax: number
  /**
   * admit.renew is exempt from proof (a device without a credential must keep its admission), never from a ceiling: each
   * accepted renewal writes the registry and adds a deny entry at the relay for 30 days. At most one per device in this
   * long. Kept in the portal's memory; across a restart the ticket's own age (below) still holds, it is on disk.
   */
  renewMinGapS: number
  /** A renewal is accepted only once the device's live ticket lived this long: half of ADMIT_TTL. */
  renewMinAgeS: number
  /**
   * Superseded tickets of one device still alive (denied until their exp), in the registry and in the relay's list. With
   * the two rules above a device reaches at most 30 d / 20 h = 36; a person's device, renewing past half its ticket, holds
   * one or two. A renewal that would pass the ceiling is refused: the list never grows because of one device.
   */
  deniedPerDevice: number
  /** keyIds of past admission keys kept per device (E-2), as the registry keeps them. */
  usedKeyIdsPerDevice: number
  /** Live deny entries the handshake rate (hsRateDenyS) may hold at the relay: the hint is unauthenticated. */
  rateDenyMax: number
  /**
   * Room of the relay's list (DENY_MAX) that renewals and the handshake rate never take: a revocation always fits. Budget:
   * 32 devices × deniedPerDevice (512) + rateDenyMax (256) + this (256) = DENY_MAX.
   */
  denyRevokeReserve: number
  /** The native notice of a refused deny list (R_NOTICE 0x02) at most once in this long; the audit gets every one. */
  relayNoticeEveryS: number
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
  routeQueueBytesMax: 1024 * 1024,
  houseQueueBytesMax: 8 * 1024 * 1024,
  reqPerDevicePerMin: 120,
  gesturesPerDevicePerMin: 30,
  speechPerDevicePerMin: 30,
  fileChunksPerDevicePerMin: FILE_CHUNKS_PER_DEVICE_PER_MIN,
  strikesMax: 5,
  renewMinGapS: 20 * 3600,
  renewMinAgeS: ADMIT_TTL_S / 2,
  deniedPerDevice: 16,
  usedKeyIdsPerDevice: 64,
  rateDenyMax: 256,
  denyRevokeReserve: 256,
  relayNoticeEveryS: 3600,
})

const WINDOW_MS = 60_000

/** `limit`: refuse this request (answer 0x07 and audit); `close`: the device insisted, end the session. */
export type LimitVerdict = 'ok' | 'limit' | 'close'

/**
 * The per-device rate of one minute, sliding. Memory is bounded by the limits themselves (never more than the ceiling of
 * instants per list), so a device cannot grow it. A refused request does not count against the window (the device
 * recovers when it stops) but is a strike; the strikes also slide over a minute.
 */
type LimiterLimits = Pick<Limits, 'reqPerDevicePerMin' | 'gesturesPerDevicePerMin' | 'strikesMax'> & Partial<Pick<Limits, 'speechPerDevicePerMin' | 'fileChunksPerDevicePerMin'>>

export class DeviceLimiter {
  readonly #lim: LimiterLimits
  readonly #reqs: number[] = []
  readonly #gestures: number[] = []
  readonly #speech: number[] = []
  readonly #files: number[] = []
  readonly #strikes: number[] = []

  constructor(lim: LimiterLimits = LIMITS) { this.#lim = lim }

  /** Every request, before it is looked at. */
  request(nowMs: number): LimitVerdict { return this.#take(this.#reqs, this.#lim.reqPerDevicePerMin, nowMs) }

  /** A request the gate let through whose line is a gesture. */
  gesture(nowMs: number): LimitVerdict { return this.#take(this.#gestures, this.#lim.gesturesPerDevicePerMin, nowMs) }

  /** A new speech (not a repeat of an act already done), once the body is checked. */
  speech(nowMs: number): LimitVerdict { return this.#take(this.#speech, this.#lim.speechPerDevicePerMin ?? LIMITS.speechPerDevicePerMin, nowMs) }

  /** A chunk request of a file (in place of `request`): the device's bytes of files a minute, by whole chunks. */
  fileChunk(nowMs: number): LimitVerdict { return this.#take(this.#files, this.#lim.fileChunksPerDevicePerMin ?? LIMITS.fileChunksPerDevicePerMin, nowMs) }

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
