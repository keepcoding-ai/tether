// The presence of one device in the portal's memory (fio-spec 6.2, 7.3, 7.4): destrancado, the elevation window, the
// lockout after invalid assertions, and the serial lane that verifies and stores one assertion of the device at a time.
// It lives per device (deviceId), never per session: a reconnection neither unlocks nor renews a deadline, because the
// handshake proves the browser, not the person. A portal restart forgets it all (the window ends at restart, 6.2).
// The clock is the portal's: every expiry is computed against `nowMs` when the state is read. Pure: no node:*.
import { ABS_LOCK_MS, ELEV_WINDOW_S, IDLE_LOCK_MS, PRESENCE, UV_CHALLENGE_TTL_MS, type Presence } from '../remote/index.ts'

/** Invalid assertions that lock the device out (spec 7.4 point 6), and for how long. */
export const UV_INVALID_MAX = 5
export const UV_LOCKOUT_MS = 5 * 60_000

/** A refusal by the signature counter is not an attack on the proof: it gets its own audit line and does not count here. */
export type UvOutcome = 'ok' | 'invalid' | 'locked-out'

export interface PresenceClock { idleMs: number; absMs: number }
export const PRESENCE_CLOCK: Readonly<PresenceClock> = Object.freeze({ idleMs: IDLE_LOCK_MS, absMs: ABS_LOCK_MS })

export class DevicePresence {
  readonly #clock: PresenceClock
  #unlockedAtMs: number | undefined
  #lastGestureMs = 0
  #elevUntilS = 0
  #invalid = 0
  #lockedOutUntilMs = 0
  #tail: Promise<unknown> = Promise.resolve()

  constructor(clock: PresenceClock = PRESENCE_CLOCK) { this.#clock = clock }

  /**
   * One verification of this device at a time, all its sessions together: the stored signature counter is read, compared
   * and written inside the lane, so two assertions never both pass against the same stored value.
   */
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(fn, fn)
    this.#tail = run.catch(() => undefined)
    return run
  }

  /** `locked` or `unlocked` of a device that holds a credential; idle (no gesture) and the absolute ceiling lock it again. */
  presence(nowMs: number): Presence {
    if (this.#unlockedAtMs === undefined) return PRESENCE.locked
    if (nowMs - this.#lastGestureMs >= this.#clock.idleMs || nowMs - this.#unlockedAtMs >= this.#clock.absMs) {
      this.lock()
      return PRESENCE.locked
    }
    return PRESENCE.unlocked
  }

  /** Unix seconds of the end of the elevation window, 0 when there is none. Read after `presence`, which may close it. */
  elevUntilS(nowMs: number): number {
    if (this.presence(nowMs) !== PRESENCE.unlocked) return 0
    return this.#elevUntilS * 1000 > nowMs ? this.#elevUntilS : 0
  }

  /** An accepted request of a gesture line (E-11): the idle clock starts again. Nothing to renew while locked. */
  gesture(nowMs: number): void {
    if (this.presence(nowMs) === PRESENCE.unlocked) this.#lastGestureMs = nowMs
  }

  unlock(nowMs: number): void {
    this.#unlockedAtMs = nowMs
    this.#lastGestureMs = nowMs
    this.#invalid = 0
  }

  /** An elevation also renews the unlock (spec 7.4 point 3). */
  elevate(nowMs: number): void {
    this.unlock(nowMs)
    this.#elevUntilS = Math.floor(nowMs / 1000) + ELEV_WINDOW_S
  }

  /** Back to `locked`: the window goes with it. */
  lock(): void {
    this.#unlockedAtMs = undefined
    this.#elevUntilS = 0
  }

  /** A proof that verified: the count of invalid ones starts again. */
  accepted(): void { this.#invalid = 0 }

  /** One invalid assertion. The fifth locks the device out and drops its presence; the caller closes its sessions. */
  invalid(nowMs: number): UvOutcome {
    this.#invalid++
    if (this.#invalid < UV_INVALID_MAX) return 'invalid'
    this.#invalid = 0
    this.#lockedOutUntilMs = nowMs + UV_LOCKOUT_MS
    this.lock()
    return 'locked-out'
  }

  lockedOut(nowMs: number): boolean { return nowMs < this.#lockedOutUntilMs }
}

export type UvPurposeName = 'unlock' | 'elevate' | 'act'

/** The one pending challenge of a session (spec 7.4 point 6): it is taken at the first use, and dies after UV_CHALLENGE_TTL. */
export interface PendingChallenge { uvCtr: number; purpose: UvPurposeName; op?: number; issuedMs: number }

export const challengeLive = (p: PendingChallenge, nowMs: number): boolean => nowMs - p.issuedMs < UV_CHALLENGE_TTL_MS
