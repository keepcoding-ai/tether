// Who is waiting for the person, as the portal may tell a device (RR1 step 1.3, item 4): the slots in `waiting`, from
// what the pipe already gives (the `list` reply and the `state` / `removed` events). The projection is an ALLOW list:
// id, name, kind and since when; nothing of the slot leaves whole, and never the text of what the agent asks, its
// folder, its args, its profile or its env. Names are hostile text (sanitized, capped).
import { sanitizeDeclaredName } from '../remote/index.ts'
import type { SlotState } from '../daemon/protocol.ts'

export interface AttentionItem {
  /** The slot's id (only ids of the shape `^[\w.:-]{1,64}$` are shown). */
  id: string
  /** The slot's own name, else its kind. Sanitized, at most 64 characters. */
  name: string
  /** The kind of pane: `claude`, `soul`, `codex`, `shell`… */
  kind: string
  /** Since when it waits (ISO), as far as the portal knows. */
  since: string
}

const ID_RE = /^[\w.:-]{1,64}$/
const KIND_RE = /^[a-z][a-z0-9-]{0,31}$/
/** At most this many items in one list: the rest is counted, not sent. */
export const ATTENTION_MAX = 64

export function projectWaiting(slot: SlotState, since: string): AttentionItem | undefined {
  if (slot.attention !== 'waiting' || !ID_RE.test(slot.slotId)) return undefined
  const kind = typeof slot.kind === 'string' && KIND_RE.test(slot.kind) ? slot.kind : 'agent'
  const own = typeof slot.name === 'string' ? sanitizeDeclaredName(slot.name).slice(0, 64) : ''
  return { id: slot.slotId, name: own || kind, kind, since }
}

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
