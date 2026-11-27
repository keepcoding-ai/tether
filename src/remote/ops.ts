// The deduplication of acts (spec 7.2 rule 7), and the address of the registry of operations the spec names: the table
// itself lives in scopes.ts, its one source, and is re-exported here. The type of a request is the 16-bit `op` outside the
// JSON: the portal decides scope and presence by that table before it parses the body. There is no tunnel operation, and
// a parameter never changes the class of a line.
import { fail, toHex } from './bytes.ts'
import { ACT_CACHE_MAX, ACT_CACHE_TTL_MS } from './constants.ts'

export { OPS, OP_CODES, OP_TABLE, opByCode, opByName, EVT, evtByCode } from './scopes.ts'
export type { OpLine, OpName, OpRule, OpScope, PresenceClass, EvtLine, EvtName } from './scopes.ts'

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
