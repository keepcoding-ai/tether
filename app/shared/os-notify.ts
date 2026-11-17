// System notifications (Windows toasts) for a terminal's attention while the person is outside tether: an agent finished
// its turn ('done') or waits for them ('waiting') and the window is not in focus (another app in front, minimized, or
// closed to the tray). Inside tether the tab's seal is enough, so nothing pops up. The main process feeds every slot state
// to `OsNotifyRules.apply`, which answers whether that slot just *gained* attention worth a toast; a short window
// coalesces a burst (three agents ending together) into one toast. Pure: main.ts owns the Notification and the clock.
import type { SlotState } from '../../src/daemon/protocol.ts'

export const OS_NOTIFY_LEVELS = ['all', 'waiting', 'off'] as const
export type OsNotifyLevel = (typeof OS_NOTIFY_LEVELS)[number]
export const DEFAULT_OS_NOTIFY: OsNotifyLevel = 'all'
/** How long a toast waits for others before showing: a burst of turns ending becomes one toast. */
export const OS_NOTIFY_COALESCE_MS = 1500

export function normalizeOsNotify(v: unknown): OsNotifyLevel {
  return (OS_NOTIFY_LEVELS as readonly unknown[]).includes(v) ? v as OsNotifyLevel : DEFAULT_OS_NOTIFY
}

export interface PendingToast { slotId: string; label: string; kind: 'done' | 'waiting' }

/** Tracks each slot's last attention and answers which transitions deserve a toast. */
export class OsNotifyRules {
  private readonly last = new Map<string, 'done' | 'waiting' | undefined>()

  /**
   * A new state for a slot. Returns the toast to queue, or undefined. A toast is due when the attention rises
   * (none → done/waiting, or done → waiting), the level allows it and the window is not focused. The first state seen for
   * a slot (connect-time list, reconnect) only records it: old attention is not news.
   */
  apply(slot: SlotState, label: string, level: OsNotifyLevel, focused: boolean): PendingToast | undefined {
    const known = this.last.has(slot.slotId)
    const before = this.last.get(slot.slotId)
    const now = slot.attention
    this.last.set(slot.slotId, now)
    if (!known || !now || level === 'off' || focused) return undefined
    if (now === before || (before === 'waiting' && now === 'done')) return undefined
    if (level === 'waiting' && now !== 'waiting') return undefined
    return { slotId: slot.slotId, label, kind: now }
  }

  /** Records a slot without judging it (the connect-time list). */
  seed(slot: SlotState): void { this.last.set(slot.slotId, slot.attention) }
  remove(slotId: string): void { this.last.delete(slotId) }
  clear(): void { this.last.clear() }
}

/**
 * The toast for a batch (one slot each, latest kind wins). `waiting` leads: it is the one that blocks the agent.
 * Clicking it opens the slot when there is a single one (or the first one waiting).
 */
export function toastFor(batch: readonly PendingToast[]): { title: string; body: string; slotId: string } | undefined {
  const bySlot = new Map<string, PendingToast>()
  for (const t of batch) bySlot.set(t.slotId, t)
  const all = [...bySlot.values()]
  if (!all.length) return undefined
  const waiting = all.filter(t => t.kind === 'waiting')
  const done = all.filter(t => t.kind === 'done')
  const first = waiting[0] ?? done[0]!
  if (all.length === 1) {
    return first.kind === 'waiting'
      ? { title: `${first.label} precisa de você`, body: 'O agente está esperando sua resposta.', slotId: first.slotId }
      : { title: `${first.label} terminou`, body: 'O agente concluiu a vez dele.', slotId: first.slotId }
  }
  const parts: string[] = []
  if (waiting.length) parts.push(waiting.length === 1 ? '1 esperando você' : `${waiting.length} esperando você`)
  if (done.length) parts.push(done.length === 1 ? '1 terminou' : `${done.length} terminaram`)
  return { title: `${all.length} agentes pedem atenção`, body: `${parts.join(', ')}: ${all.map(t => t.label).join(', ')}`, slotId: first.slotId }
}

// ---------- the bell (top bar): recent attention, muting ----------

/** How many recent notices the bell keeps. */
export const ATTENTION_HISTORY_MAX = 20

export interface AttentionEntry { slotId: string; label: string; kind: 'done' | 'waiting'; at: number; seen: boolean }
export interface AttentionState { items: AttentionEntry[]; unseen: number; mutedUntil?: number }

/**
 * The bell's short history, fed by the same transitions that queue a toast. Newest first; a slot appears once (a new
 * notice for it replaces the old one and comes to the top). `unseen` counts the notices not yet looked at in the menu.
 */
export class AttentionHistory {
  private items: AttentionEntry[] = []
  private readonly max: number
  constructor(max = ATTENTION_HISTORY_MAX) { this.max = max }

  add(t: PendingToast, at: number): void {
    this.items = [{ slotId: t.slotId, label: t.label, kind: t.kind, at, seen: false }, ...this.items.filter(e => e.slotId !== t.slotId)].slice(0, this.max)
  }

  /** Marks the notices as looked at: one slot's (its pane was visited) or, without a slot, all of them (the menu opened). Answers whether anything changed. */
  markSeen(slotId?: string): boolean {
    let changed = false
    this.items = this.items.map(e => e.seen || (slotId !== undefined && e.slotId !== slotId) ? e : (changed = true, { ...e, seen: true }))
    return changed
  }

  /** A slot's attention as the daemon reports it now: once it is gone (the person answered, the agent resumed), its notice leaves the list. Answers whether anything changed. */
  settle(slotId: string, attention: 'done' | 'waiting' | undefined): boolean {
    if (attention || !this.items.some(e => e.slotId === slotId)) return false
    this.remove(slotId)
    return true
  }
  remove(slotId: string): void { this.items = this.items.filter(e => e.slotId !== slotId) }
  get unseen(): number { return this.items.filter(e => !e.seen).length }
  list(): AttentionEntry[] { return this.items.map(e => ({ ...e })) }
}

export const MUTE_CHOICES = ['30m', '1h', 'tomorrow'] as const
export type MuteChoice = (typeof MUTE_CHOICES)[number]
/** The hour "até amanhã" ends at: tomorrow morning, local time. */
export const MUTE_TOMORROW_HOUR = 8

export function isMuteChoice(v: unknown): v is MuteChoice { return (MUTE_CHOICES as readonly unknown[]).includes(v) }

/** When a mute picked at `now` ends (epoch ms). Muting is temporary and never touches `notifications.os`. */
export function muteUntil(choice: MuteChoice, now: number): number {
  if (choice === '30m') return now + 30 * 60_000
  if (choice === '1h') return now + 60 * 60_000
  const d = new Date(now)
  d.setDate(d.getDate() + 1)
  d.setHours(MUTE_TOMORROW_HOUR, 0, 0, 0)
  return d.getTime()
}

/** Whether a mute ending at `until` still holds at `now`; an expired mute is simply gone (the level comes back by itself). */
export function isMuted(until: number | undefined, now: number): boolean {
  return until !== undefined && now < until
}

/** The bell's icon state: the level, or muted while a mute holds. */
export type BellState = OsNotifyLevel | 'muted'
export function bellState(level: OsNotifyLevel, mutedUntil: number | undefined, now: number): BellState {
  return isMuted(mutedUntil, now) ? 'muted' : level
}
