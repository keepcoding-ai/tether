// Limits of the relay (fio-spec 5.7, 5.1, 5.6). The wire constants come from the remote module; the ones that exist
// only at the relay live here. Every structure the relay keeps has a ceiling derived from these numbers.
import {
  AUTH_DEADLINE_MS, FAIL_DELAY_MS, MAX_OUTER, MAX_PRE_AUTH, ROUTES_PER_HOUSE,
} from '../../../src/remote/index.ts'

export const RELAY_LIMITS = {
  /** Biggest frame before the socket is admitted or authenticated (5.7). */
  maxPreAuth: MAX_PRE_AUTH,
  /** Biggest frame after; also the `maxPayload` of the WebSocket server, so a bigger one never gets buffered. */
  maxOuter: MAX_OUTER,
  /** From socket open to the one D_ADMIT, D_PAIR or H_AUTH (5.7). */
  authDeadlineMs: AUTH_DEADLINE_MS,
  /** Every uniform refusal goes out at arrival + this (5.3). */
  failDelayMs: FAIL_DELAY_MS,
  /** No frame received for this long closes the socket (5.7). */
  idleMs: 90_000,
  /** How long the first house has to answer LINK_PING when a second one proves the same key (5.1). */
  secondHousePingMs: 5_000,
  connsPerIp: 20,
  pendingPerIp: 5,
  routesPerHouse: ROUTES_PER_HOUSE,
  /** D_PAIR with no listen, per IP, in `pairMissWindowMs`; beyond it every D_PAIR of that IP is refused (5.7). */
  pairMissPerIp: 5,
  pairMissWindowMs: 60_000,
  /** Bytes waiting towards one device (one route): above it the route is dropped (5.7). */
  routeQueueBytes: 1024 * 1024,
  /** Bytes waiting towards one house: a route that writes while it is above this is dropped (5.7). */
  houseQueueBytes: 8 * 1024 * 1024,
  /** Pair listens: one active per house, this many per hour per house socket (5.7). */
  listensPerHour: 10,
  /** Routes from a house to routeIds that are not its own before its socket closes (5.4). */
  houseDiscards: 3,
  /** Ceiling of sockets on one relay process; the IP table is capped at twice this. */
  maxConns: 10_000,
} as const

export type RelayLimits = { -readonly [K in keyof typeof RELAY_LIMITS]: number }

/** WebSocket close codes the relay uses. A uniform refusal is always 1000 with no reason (5.3). */
export const WS_CLOSE = {
  normal: 1000,
  goingAway: 1001,
  unsupported: 1003,
  policy: 1008,
  tooBig: 1009,
} as const
