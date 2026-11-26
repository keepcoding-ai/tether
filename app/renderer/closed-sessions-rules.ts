// "Fechadas" for a manager, pure (no DOM, no node:*): the sessions that ended and have no tab, newest first, capped.
// Same rule as the Sessões menu (turnState 'ended' and no tab); it does not duplicate sessionRows.
import { turnState, type SessionSlot } from './sessions-rules.ts'

/** The most rows the core hands out; the rest stays in the Sessões menu. */
export const CLOSED_LIMIT = 50

/** An ended session with no tab, as an extension sees it. */
export interface ClosedSession {
  slotId: string
  kind: string
  name: string
  title?: string
  cwd: string
  endedAt?: string
}

function nameOf(s: SessionSlot): string {
  const named = s.name?.trim() || s.title?.trim()
  if (named) return named
  const parts = s.cwd.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? s.slotId
}

/**
 * Ended slots without a tab, most recently ended first (no `endedAt` goes last, in the daemon's order), at most `limit`.
 * `limit` below 1 or not a number falls back to the cap; it never exceeds it.
 */
export function closedSessionsOf(slots: Iterable<SessionSlot>, hasTab: (slotId: string) => boolean, limit: number = CLOSED_LIMIT): ClosedSession[] {
  const cap = Number.isFinite(limit) && limit >= 1 ? Math.min(Math.floor(limit), CLOSED_LIMIT) : CLOSED_LIMIT
  const rows: { at: number | undefined; i: number; row: ClosedSession }[] = []
  let i = 0
  for (const s of slots) {
    const index = i++
    if (turnState(s) !== 'ended' || hasTab(s.slotId)) continue
    const at = Date.parse(s.endedAt ?? '')
    const title = s.title?.trim()
    rows.push({
      at: Number.isNaN(at) ? undefined : at,
      i: index,
      row: {
        slotId: s.slotId,
        kind: s.kind ?? 'terminal',
        name: nameOf(s),
        ...(title ? { title } : {}),
        cwd: s.cwd,
        ...(s.endedAt ? { endedAt: s.endedAt } : {}),
      },
    })
  }
  rows.sort((a, b) => {
    if (a.at !== undefined && b.at !== undefined && a.at !== b.at) return b.at - a.at
    if ((a.at === undefined) !== (b.at === undefined)) return a.at === undefined ? 1 : -1
    return a.i - b.i
  })
  return rows.slice(0, cap).map(r => r.row)
}

/** The list changes only when the ids or their order do; this is the cheap key to compare. */
export function closedSignature(list: readonly ClosedSession[]): string {
  return list.map(c => c.slotId).join('|')
}
