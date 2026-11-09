// Seals an extension puts on the UI, as pure rules (no DOM, unit-tested):
//   - a badge (count / attention / tooltip) on a pad's icon or a system desk's pill, set by the one that owns it;
//   - an attention seal on a pane (any pane: an extension may warn on an agent's pane that is not its own), with the
//     terminal seal's rules: it goes out when the pane is seen, unless it is sticky (it only goes out when its owner
//     resolves it), several seals on a pane live together and with the terminal's own, and they go with their owner.

/** What a terminal's seal says (the slot's `attention`). */
export type SlotAttention = 'done' | 'waiting'

/** What an extension shows on its pad's icon or its system desk's pill. A zero count is no count; nothing set is no badge. */
export interface Badge {
  count?: number
  attention?: boolean
  tooltip?: string
}

/** The badge as the UI draws it: a clean count (a whole number above zero), the flag only when true, a trimmed tooltip. Undefined when nothing is left. */
export function normalizeBadge(b: Badge | undefined): Badge | undefined {
  if (!b) return undefined
  const count = typeof b.count === 'number' && Number.isFinite(b.count) ? Math.floor(b.count) : 0
  const tooltip = typeof b.tooltip === 'string' ? b.tooltip.trim().slice(0, 200) : ''
  const out: Badge = {
    ...(count > 0 ? { count } : {}),
    ...(b.attention === true ? { attention: true } : {}),
    ...(tooltip ? { tooltip } : {}),
  }
  return out.count === undefined && out.attention === undefined ? undefined : out
}

/** The text of a count on a small badge: "99+" past two digits. */
export function countLabel(n: number): string {
  return n > 99 ? '99+' : String(n)
}

/** What a system desk's pill shows beyond its title: the panes' seals (counted once each) and the extension's badge; undefined when nothing. */
export function pillMark(att: { done: number; waiting: number; lines?: string[] } | undefined, badge: Badge | undefined): { text: string; tone: 'waiting' | 'done' | 'plain'; lines: string[] } | undefined {
  const panes = (att?.done ?? 0) + (att?.waiting ?? 0)
  const count = panes + (badge?.count ?? 0)
  const tone = (att?.waiting ?? 0) > 0 || badge?.attention ? 'waiting' : (att?.done ?? 0) > 0 ? 'done' : 'plain'
  if (count === 0 && !badge?.attention) return undefined
  return { text: count > 0 ? countLabel(count) : '', tone, lines: [...(att?.lines ?? []), ...(badge?.tooltip ? [badge.tooltip] : [])] }
}

/** Badges by target id (a pad id or a system desk id); each keeps who set it. */
export class BadgeBoard {
  private readonly entries = new Map<string, { owner: string; badge: Badge }>()

  /** Sets (or, with nothing to show, clears) the badge of `key` on behalf of `owner`. Returns whether anything changed. */
  set(owner: string, key: string, badge: Badge | undefined): boolean {
    const next = normalizeBadge(badge)
    const prev = this.entries.get(key)
    if (!next) return prev ? this.entries.delete(key) : false
    if (prev && prev.owner === owner && sameBadge(prev.badge, next)) return false
    this.entries.set(key, { owner, badge: next })
    return true
  }

  get(key: string): Badge | undefined { return this.entries.get(key)?.badge }

  /** Takes away everything `owner` set (the extension went). Returns whether anything changed. */
  removeOwner(owner: string): boolean {
    let changed = false
    for (const [k, v] of [...this.entries]) if (v.owner === owner) { this.entries.delete(k); changed = true }
    return changed
  }
}

function sameBadge(a: Badge, b: Badge): boolean {
  return a.count === b.count && a.attention === b.attention && a.tooltip === b.tooltip
}

/** What an extension passes to raise a seal on a pane (`paneId` and `slotId` name the same thing for a slot's pane). */
export interface AttentionRaise {
  paneId?: string
  slotId?: string
  message: string
  sticky?: boolean
}

/** The seal an extension raised: swap its text, resolve it (also dispose), hear the person click it. */
export interface AttentionHandle {
  readonly id: number
  update(patch: { message?: string }): void
  resolve(): void
  dispose(): void
  onDidActivate(listener: () => void): { dispose(): void }
}

/** One seal an extension raised on a pane. */
export interface Seal {
  id: number
  owner: string
  paneId: string
  message: string
  sticky: boolean
}

/** The seals on the panes. Every change tells the listener (the UI draws again). */
export class SealBoard {
  private readonly seals = new Map<number, Seal>()
  private next = 1

  private readonly onChange: () => void

  constructor(onChange: () => void = () => {}) { this.onChange = onChange }

  raise(owner: string, paneId: string, message: string, sticky = false): Seal {
    const seal: Seal = { id: this.next++, owner, paneId, message: cleanMessage(message), sticky }
    this.seals.set(seal.id, seal)
    this.onChange()
    return seal
  }

  /** Swaps the text of a pending seal. False when it is gone. */
  update(id: number, message: string): boolean {
    const s = this.seals.get(id)
    if (!s) return false
    const text = cleanMessage(message)
    if (s.message === text) return true
    s.message = text
    this.onChange()
    return true
  }

  /** The owner is done with it (also what disposing does). False when it was already gone. */
  resolve(id: number): boolean {
    if (!this.seals.delete(id)) return false
    this.onChange()
    return true
  }

  /** The pane was seen (it got the focus): the normal seals go, the sticky ones stay. Returns whether any went. */
  seen(paneId: string): boolean {
    let changed = false
    for (const s of [...this.seals.values()]) if (s.paneId === paneId && !s.sticky) { this.seals.delete(s.id); changed = true }
    if (changed) this.onChange()
    return changed
  }

  /** The extension went: its seals go with it. */
  removeOwner(owner: string): boolean {
    let changed = false
    for (const s of [...this.seals.values()]) if (s.owner === owner) { this.seals.delete(s.id); changed = true }
    if (changed) this.onChange()
    return changed
  }

  get(id: number): Seal | undefined { return this.seals.get(id) }
  onPane(paneId: string): Seal[] { return [...this.seals.values()].filter(s => s.paneId === paneId) }
  has(paneId: string): boolean { return this.onPane(paneId).length > 0 }
  /** The messages on a pane, oldest first (the tooltip lines). */
  messages(paneId: string): string[] { return this.onPane(paneId).map(s => s.message).filter(Boolean) }
}

function cleanMessage(m: string): string {
  return String(m ?? '').trim().slice(0, 300)
}

/** The seal a pane shows: an extension's asks for the person, like a terminal that waits; the terminal's own `waiting` wins over `done`. */
export function effectiveAttention(terminal: SlotAttention | undefined, extSeals: number): SlotAttention | undefined {
  if (extSeals > 0) return 'waiting'
  return terminal
}

/** The tooltip lines of a pane's seal: the terminal's, then each extension message. */
export function attentionLines(terminal: SlotAttention | undefined, messages: readonly string[]): string[] {
  return [...(terminal === 'waiting' ? ['Esperando você'] : terminal === 'done' ? ['Terminou'] : []), ...messages]
}
