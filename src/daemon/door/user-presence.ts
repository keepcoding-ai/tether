// The user interlock of the delivery (contract 4.3): per slot, when the person last typed (`typedAt`) and whether a draft of
// theirs sits in the input box (`draft`). The terminal path runs only with no draft and USER_QUIET_MS of silence.
// - What counts: input of the person (the pipe's `input`/`typed`), and also the input of the agent that holds the pane
//   through the door (slots.write/keys): in a given pane the owner's word weighs as the user's, so the delivery never types
//   over the owner's half-typed command either. The delivery's own writes are never fed here (delivery.ts filters them).
// - Who typed is kept apart ('user' for the pipe, 'agent' for the door): the delivery waits for both (no `who`), while the
//   gate of raw typing asks for the person alone (`who: 'user'`), so a writer's own keys never make it refuse itself.
// - Terminal answers are not typing: a chunk that starts with ESC (DA, cursor position, focus reports, and also arrow keys)
//   is ignored, the same rule as AttentionState.input. A bracketed paste (ESC[200~) is typing: it fills the box.
// - The draft is a count of characters in the box (a heuristic): a printable key adds 1, a paste adds its length (at least 1),
//   Backspace (DEL or BS) takes 1 down to zero; Enter (CR or LF), Ctrl+C or Ctrl+U zero it, and so does the turn turning busy
//   (the line was taken). There is a draft while the count is above zero, so typing a letter and erasing it frees the slot.
//   Arrows and Delete in mid-line are not counted: when unsure the count errs toward "a draft" (never type over the person).
// Pure state with the clock passed in; no timer here (delivery.ts keeps the one silence timer).

export const USER_QUIET_MS = 10_000

const PASTE_RE = /\x1b\[200~[\s\S]*?(?:\x1b\[201~|$)/g
// An escape sequence inside a chunk: CSI (ESC [ ... final byte), SS3 (ESC O x), or ESC plus one byte.
const ESCAPE_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|O.|[\s\S])?/g

interface Presence { typedAt: number; draft: number }

/** Who typed: the person (the pipe) or an agent (the door). */
export type Typist = 'user' | 'agent'

/** The draft count after one chunk, given the count before it. */
export function draftAfter(count: number, data: string): number {
  const pasted = data.replace(PASTE_RE, (m) => {
    const text = m.replace(/^\x1b\[200~/, '').replace(/\x1b\[201~$/, '')
    return '\x00' + 'P'.repeat(Math.max(1, [...text].length))
  })
  const plain = pasted.replace(ESCAPE_RE, '')
  for (const ch of plain) {
    if (ch === '\x00') continue // the paste marker's lead byte; its 'P's count below
    if (ch === '\r' || ch === '\n' || ch === '\x03' || ch === '\x15') count = 0
    else if (ch === '\x7f' || ch === '\x08') count = Math.max(0, count - 1)
    else if (ch >= ' ') count += 1
  }
  return count
}

/** Whether a chunk is typing at all (not a terminal answer). */
export function countsAsTyping(data: string): boolean {
  return data.length > 0 && (!data.startsWith('\x1b') || data.startsWith('\x1b[200~'))
}

export class UserPresence {
  private readonly bySlot = new Map<string, Partial<Record<Typist, Presence>>>()
  private readonly quietMs: number

  constructor(quietMs = USER_QUIET_MS) { this.quietMs = quietMs }

  /** Keys of the person (or, `who: 'agent'`, of the pane's holder) reached the slot at `now` (ms). */
  input(slotId: string, data: string, now: number, who: Typist = 'user'): void {
    if (!countsAsTyping(data)) return
    const slot = this.bySlot.get(slotId) ?? {}
    const p = slot[who] ?? { typedAt: now, draft: 0 }
    p.typedAt = now
    p.draft = draftAfter(p.draft, data)
    slot[who] = p
    this.bySlot.set(slotId, slot)
  }

  /** The slot's turn turned busy: whatever was in the box was submitted (by whoever typed it). */
  turnBusy(slotId: string): void {
    const slot = this.bySlot.get(slotId)
    if (slot?.user) slot.user.draft = 0
    if (slot?.agent) slot.agent.draft = 0
  }

  forget(slotId: string): void { this.bySlot.delete(slotId) }

  /** A draft in the box: of `who`, or of either when omitted. */
  draft(slotId: string, who?: Typist): boolean {
    return this.typists(slotId, who).some((p) => p.draft > 0)
  }

  /**
   * When silence frees the slot (ms epoch); undefined when nobody typed; Infinity while a draft is there. With `who`, only
   * that typist counts; without it, both (the later of the two).
   */
  freeAt(slotId: string, who?: Typist): number | undefined {
    const ps = this.typists(slotId, who)
    if (ps.length === 0) return undefined
    return Math.max(...ps.map((p) => p.draft > 0 ? Infinity : p.typedAt + this.quietMs))
  }

  /** No draft and `quietMs` of silence at `now` (of `who`, or of both). */
  isFree(slotId: string, now: number, who?: Typist): boolean {
    const at = this.freeAt(slotId, who)
    return at === undefined || now >= at
  }

  private typists(slotId: string, who: Typist | undefined): Presence[] {
    const slot = this.bySlot.get(slotId)
    if (!slot) return []
    const ps = who ? [slot[who]] : [slot.user, slot.agent]
    return ps.filter((p): p is Presence => p !== undefined)
  }
}
