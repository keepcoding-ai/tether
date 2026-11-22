// What an extension may read of the slot behind a pane (TetherUi.panes.slotFacts): who created it, and its attention (the
// person's, or the one that waits for an agent owner). Pure: no DOM. The daemon stamps no time on an attention, so the app
// stamps the first moment it saw each one (`AttentionStamps`); after a restart of the window the time is the moment the app
// first looked again, which is the best the app can say and is said in the type's comment.
import type { PaneSlotFacts } from '../ext-api.ts'
import { routedAttention } from '../seal-rules.ts'
import type { SlotState } from '../../../src/daemon/protocol.ts'

/** The part of a slot the facts read. */
export type FactsSlot = Pick<SlotState, 'slotId' | 'attention' | 'attentionFor' | 'createdBy'>

/** The identity of an attention (its kind and who it waits for), so a new one gets a new time. */
function keyOf(s: FactsSlot): string {
  if (s.attentionFor) return `for:${s.attentionFor.slotId}:${s.attentionFor.value}`
  if (s.attention) return `own:${s.attention}`
  return ''
}

/** When each slot's attention was first seen. */
export class AttentionStamps {
  private readonly seen = new Map<string, { key: string; since: string }>()
  private readonly now: () => string

  constructor(now: () => string = () => new Date().toISOString()) { this.now = now }

  /** Takes a slot's state in. Returns whether its attention (its kind or its recipient) changed. */
  observe(s: FactsSlot): boolean {
    const key = keyOf(s)
    const prev = this.seen.get(s.slotId)
    if ((prev?.key ?? '') === key) return false
    if (key === '') this.seen.delete(s.slotId)
    else this.seen.set(s.slotId, { key, since: this.now() })
    return true
  }

  sinceOf(slotId: string): string | undefined { return this.seen.get(slotId)?.since }

  forget(slotId: string): void { this.seen.delete(slotId) }

  get size(): number { return this.seen.size }
}

/** The facts of a slot, or undefined when there is none. `ownerName` names the owner a routed attention waits for. */
export function slotFactsOf(s: FactsSlot | undefined, stamps: AttentionStamps, ownerName: (slotId: string) => string | undefined): PaneSlotFacts | undefined {
  if (!s) return undefined
  const since = stamps.sinceOf(s.slotId) ?? ''
  const routed = routedAttention(s, ownerName)
  return {
    ...(s.createdBy ? { createdBy: { ...s.createdBy } } : {}),
    ...(s.attention ? { attention: { value: s.attention, since } } : {}),
    ...(routed && s.attentionFor ? { routed: { owner: s.attentionFor.slotId, value: routed.value, since, hue: routed.hue, tooltip: routed.tooltip } } : {}),
  }
}
