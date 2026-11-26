// The one registry of remote operations (spec 7.2) and the deduplication of acts. The type of a request is the
// 16-bit `op` outside the JSON: the portal decides scope and presence by this table before it parses the body.
// There is no tunnel operation, and a parameter never changes the class of a line.
import { fail, toHex } from './bytes.ts'
import { ACT_CACHE_MAX, ACT_CACHE_TTL_MS } from './constants.ts'

/** Scopes of the lines fixed in this version. `session` is the family that remains when the session is locked. */
export type OpScope = 'session' | 'attention' | 'manage:destructive'

/** Presence classes (spec 7.3). `fresh-pair`: only in the session that concluded the pairing. */
export type PresenceClass = 'none' | 'unlocked' | 'window' | 'per-act' | 'fresh-pair'

export interface OpLine {
  readonly code: number
  readonly name: string
  /** A line without a declared scope does not compile. */
  readonly scope: OpScope
  readonly presence: PresenceClass
  /** A line that changes state must come with an `actId` (rule 7). */
  readonly mutates: boolean
  /** Only a line triggered by the person's input resets the idle clock (rule 8, E-11). Decided here, not by the PWA. */
  readonly gesture: boolean
  /** Declared exception to E-8: allowed to a device without a presence credential although it changes state. */
  readonly allowedWithoutCredential?: boolean
}

/** Ranges of `op`: 0x0001–0x00FF session; 0x01xx attention; 0x02xx channels; 0x03xx regency; 0x04xx management; 0x05xx peek; 0x06xx devices. */
export const OPS: readonly OpLine[] = [
  { code: 0x0001, name: 'session.info', scope: 'session', presence: 'none', mutates: false, gesture: false },
  { code: 0x0002, name: 'admit.renew', scope: 'session', presence: 'none', mutates: true, gesture: false },
  { code: 0x0003, name: 'uv.challenge', scope: 'session', presence: 'none', mutates: false, gesture: false },
  { code: 0x0004, name: 'uv.assert', scope: 'session', presence: 'none', mutates: true, gesture: true },
  { code: 0x0005, name: 'uv.register', scope: 'session', presence: 'fresh-pair', mutates: true, gesture: true },
  { code: 0x0006, name: 'device.revoke-self', scope: 'session', presence: 'none', mutates: true, gesture: true },
  { code: 0x0007, name: 'session.lock', scope: 'session', presence: 'none', mutates: true, gesture: true },
  { code: 0x0008, name: 'house.key-rotate.ack', scope: 'session', presence: 'unlocked', mutates: true, gesture: false, allowedWithoutCredential: true },
  { code: 0x0100, name: 'attention.list', scope: 'attention', presence: 'unlocked', mutates: false, gesture: false },
  { code: 0x0101, name: 'attention.watch', scope: 'attention', presence: 'unlocked', mutates: false, gesture: false },
  { code: 0x0600, name: 'device.list', scope: 'manage:destructive', presence: 'unlocked', mutates: false, gesture: false },
  { code: 0x0601, name: 'device.revoke', scope: 'manage:destructive', presence: 'per-act', mutates: true, gesture: true },
]

/** An event (house → device, spec 7.2 rule 6): like an operation, it has a line with the scope a device needs to get it. */
export interface EvtLine {
  readonly code: number
  readonly name: string
  readonly scope: OpScope
}

/** Events fixed in this version. The portal emits one only to a session whose device has its scope. */
export const EVT = {
  attentionChanged: { code: 0x0100, name: 'attention.changed', scope: 'attention' },
} as const satisfies Record<string, EvtLine>

const EVT_BY_CODE = new Map<number, EvtLine>(Object.values(EVT).map(l => [l.code, l]))

/** The line of an event code, or undefined for an event this version does not know. */
export const evtByCode = (code: number): EvtLine | undefined => EVT_BY_CODE.get(code)

const BY_CODE = new Map<number, OpLine>(OPS.map(l => [l.code, l]))
const BY_NAME = new Map<string, OpLine>(OPS.map(l => [l.name, l]))

/** The line of an `op`, or undefined: an `op` without a line is answered with status 0x02 (rule 3). */
export const opByCode = (code: number): OpLine | undefined => BY_CODE.get(code)
export const opByName = (name: string): OpLine | undefined => BY_NAME.get(name)

/**
 * The acts one device already executed, with their answers (spec 7.2 rule 7): up to 1024, for 15 minutes. A repeated
 * `actId` gets the same answer and the act is not executed again. This is what makes a cut right after a request
 * safe to retry after reconnecting.
 */
export class ActCache<R> {
  readonly #acts = new Map<string, { atMs: number; response: R }>()

  get size(): number { return this.#acts.size }

  #prune(nowMs: number): void {
    for (const [id, a] of this.#acts) {
      if (nowMs - a.atMs < ACT_CACHE_TTL_MS) break // insertion order is time order
      this.#acts.delete(id)
    }
  }

  /** The stored answer of an act already executed, or undefined when the act is new. */
  get(actId: Uint8Array, nowMs: number): R | undefined {
    if (actId.length !== 16) fail('malformed', 'actId must be 16 bytes')
    this.#prune(nowMs)
    return this.#acts.get(toHex(actId))?.response
  }

  /** Records the answer of an act just executed. The first answer of an `actId` is the one that stays. */
  put(actId: Uint8Array, response: R, nowMs: number): void {
    if (actId.length !== 16) fail('malformed', 'actId must be 16 bytes')
    this.#prune(nowMs)
    const id = toHex(actId)
    if (this.#acts.has(id)) return
    this.#acts.set(id, { atMs: nowMs, response })
    while (this.#acts.size > ACT_CACHE_MAX) this.#acts.delete(this.#acts.keys().next().value!)
  }
}
