// Who is waiting for the person, as the portal may tell a device (RR1 step 1.3, item 4): the slots in `waiting`, from
// what the pipe already gives (the `list` reply and the `state` / `removed` events). The projection is an ALLOW list:
// id, name, kind and since when; nothing of the slot leaves whole, and never the text of what the agent asks, its
// folder, its args, its profile or its env. Names are hostile text (sanitized, capped). The projection itself is the one
// of src/remote/projection.ts, where every body that leaves for a device is built.
import { ATTENTION_MAX, attentionItem, type AttentionItem } from '../remote/projection.ts'
import type { SlotState } from '../daemon/protocol.ts'

export { ATTENTION_MAX, type AttentionItem }

export const projectWaiting = (slot: SlotState, since: string): AttentionItem | undefined => attentionItem(slot, since)

/**
 * The waiting list, kept from the pipe's events. `onChange` fires (coalesced by the caller's tick) when the projected
 * list changed. Memory: one entry per slot of the tetherd, dropped on `removed`.
 */
export class AttentionView {
  readonly #slots = new Map<string, SlotState>()
  /** When the portal first saw each slot waiting (its "since" when the slot gives no better clock). */
  readonly #since = new Map<string, string>()
  #dirty = false
  #lastKey = ''
  readonly #now: () => number

  constructor(now: () => number = Date.now) { this.#now = now }

  reset(slots: readonly SlotState[]): void {
    this.#slots.clear()
    for (const s of slots) this.#apply(s)
    this.#dirty = true
  }

  state(slot: SlotState): void { this.#apply(slot); this.#dirty = true }

  removed(slotId: string): void {
    this.#slots.delete(slotId)
    this.#since.delete(slotId)
    this.#dirty = true
  }

  #apply(slot: SlotState): void {
    this.#slots.set(slot.slotId, slot)
    if (slot.attention === 'waiting') {
      if (!this.#since.has(slot.slotId)) this.#since.set(slot.slotId, new Date(this.#now()).toISOString())
    } else this.#since.delete(slot.slotId)
  }

  items(): { items: AttentionItem[]; more: number } {
    const all: AttentionItem[] = []
    for (const s of this.#slots.values()) {
      const it = projectWaiting(s, this.#since.get(s.slotId) ?? new Date(this.#now()).toISOString())
      if (it) all.push(it)
    }
    all.sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : a.id < b.id ? -1 : 1))
    return { items: all.slice(0, ATTENTION_MAX), more: Math.max(0, all.length - ATTENTION_MAX) }
  }

  /** True once after the projected list changed (for the watchers); false when nothing a device sees changed. */
  takeChange(): boolean {
    if (!this.#dirty) return false
    this.#dirty = false
    const key = JSON.stringify(this.items())
    if (key === this.#lastKey) return false
    this.#lastKey = key
    return true
  }
}
