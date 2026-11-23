// The gate of raw typing (contract 2.3): `slots.write` and `slots.keys` have no lock of their own, so every conductor writes
// through `guardedWrite` and never calls them directly. A chunk goes only when, right before it: the caller is the pane's
// effective commander, the hand is with the owner, and the person is free there (no draft of hers in the box and the
// quiet time of USER_QUIET_MS passed: `slots.userFree`). Otherwise nothing more is written and the answer is the reason.
// The check runs again before every chunk, so a key of the person during a wait stops the rest (the Enter included).
import type { DoorSlots, KeyName } from '../../../src/daemon/ext-api.ts'
import type { OwnerId } from '../rules.ts'
import type { OwnershipStore } from './ownership.ts'

/** One step of a raw write: bytes as text, named keys, or a pause (the engines' delay before the Enter). */
export type WriteChunk =
  | { text: string }
  | { keys: readonly KeyName[]; gapMs?: number }
  | { waitMs: number }

/** Why nothing (more) was written: the caller does not command the pane, or the pane is with the person now. */
export type GateRefusal = 'not-commanded' | 'with-user'

export type GuardedWrite =
  | { ok: true }
  /** `written`: how many chunks (pauses included) were done before the stop (0: not a byte). */
  | { ok: false; why: GateRefusal; written: number }

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export class WriteGate {
  private readonly store: OwnershipStore
  private readonly slots: DoorSlots

  constructor(store: OwnershipStore, slots: DoorSlots) {
    this.store = store
    this.slots = slots
  }

  /**
   * Whether `caller` may type into `paneId` now; undefined = yes. `userFree` answers for the person alone (an agent's writes
   * through the door do not count there), so it is read before every chunk. `presence: false` skips it (kept for callers
   * that check only the command).
   */
  check(paneId: string, caller: OwnerId, opts: { presence?: boolean } = {}): GateRefusal | undefined {
    const eff = this.store.effectiveOf(paneId)
    if (eff.commander !== caller) return 'not-commanded'
    if (eff.hand !== 'owner') return 'with-user'
    if (opts.presence !== false && !this.slots.userFree(paneId)) return 'with-user'
    return undefined
  }

  /**
   * Writes the chunks in order. Before every chunk the whole gate is checked (commander, hand, the person free): a key of
   * the person during the write stops the rest (the Enter included), in a pane commanded from outside (which she also takes,
   * `onUserTyped`) and in the agent's own pane alike. A door error (no process) rejects as it is.
   */
  async write(paneId: string, caller: OwnerId, chunks: readonly WriteChunk[], opts: { answer?: boolean } = {}): Promise<GuardedWrite> {
    // The mark goes to the door only when set, so every other write reaches it exactly as before.
    const mark = opts.answer ? { answer: true } : undefined
    let written = 0
    const gate = (): GateRefusal | undefined => this.check(paneId, caller)
    for (const chunk of chunks) {
      if ('waitMs' in chunk) { await sleep(chunk.waitMs); written++; continue }
      if ('text' in chunk) {
        const why = gate()
        if (why) return { ok: false, why, written }
        if (mark) await this.slots.write(paneId, chunk.text, mark)
        else await this.slots.write(paneId, chunk.text)
      } else {
        // Keys with a gap between them are checked one by one: the person may start typing in the gap.
        const step = chunk.gapMs !== undefined && chunk.gapMs > 0 ? 1 : Math.max(1, chunk.keys.length)
        for (let i = 0; i < chunk.keys.length; i += step) {
          if (i > 0) await sleep(chunk.gapMs ?? 0)
          const why = gate()
          if (why) return { ok: false, why, written }
          if (mark) await this.slots.keys(paneId, chunk.keys.slice(i, i + step), mark)
          else await this.slots.keys(paneId, chunk.keys.slice(i, i + step))
        }
      }
      written++
    }
    return { ok: true }
  }
}

/** The contract's name for the gate's write. */
export function guardedWrite(gate: WriteGate, paneId: string, caller: OwnerId, chunks: readonly WriteChunk[], opts?: { answer?: boolean }): Promise<GuardedWrite> {
  return gate.write(paneId, caller, chunks, opts)
}
