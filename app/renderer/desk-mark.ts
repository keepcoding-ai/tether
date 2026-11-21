// A desk's (or the drawer's) mark: a pane asking for attention (orange count) beats any busy pane (quiet green dot)
// beats nothing. Same hierarchy as the tab's dot (turn-rules.ts tabMark). Pure.
import type { SlotState } from '../../src/daemon/protocol.ts'
import { agentHue } from '../shared/agent-color.ts'

export interface MarkAttention { done: number; waiting: number }
/** `routedHue`: a pane of the desk waits for an agent owner (hue of the first one); it is not counted. `busy`: the quiet dot, when only the diamond makes the mark an object. */
export type DeskMark = { attention: MarkAttention; routedHue?: number; busy?: boolean } | 'busy' | ''

export function deskMark(slots: Iterable<Pick<SlotState, 'attention' | 'turn'> | undefined>): DeskMark {
  const attention = { done: 0, waiting: 0 }
  let busy = false
  for (const s of slots) {
    if (s?.attention === 'done') attention.done++
    else if (s?.attention === 'waiting') attention.waiting++
    else if (s?.turn === 'busy') busy = true
  }
  if (attention.done + attention.waiting > 0) return { attention }
  return busy ? 'busy' : ''
}

/** The attention counts of a mark (zero when it is busy or empty). */
export function markAttention(m: DeskMark): MarkAttention {
  return typeof m === 'object' ? m.attention : { done: 0, waiting: 0 }
}

/** The hue of the first owner a pane of the desk waits for (`attentionFor`), undefined when none. Orange (the person's attention on the pane) wins, as on the tab. */
export function routedHue(slots: Iterable<Pick<SlotState, 'attention' | 'attentionFor'> | undefined>): number | undefined {
  for (const s of slots) if (s?.attentionFor && !s.attention) return agentHue(s.attentionFor.slotId)
  return undefined
}
