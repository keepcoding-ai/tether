// The history of closed tabs ("Fechadas" in the pad Guias): every agent's tab that closes (by its agent, by the person, by the
// clean-up of an ended agent's tabs, or because its agent ended) is kept with its owner, title, address, when and by whom, so
// the person can open the address again. Closing is safe because of it.
//   - an address that carried a credential (tab-rules.ts `storableUrl`, the same rule as layout.json) never enters: the entry
//     is not kept at all, since its only use is to open the address again;
//   - expiry (`extensions.browser.closedHistory`: 1d, 7d, 30d or never) is applied when the list is read and at start, never by
//     a timer per item; at most CLOSED_HISTORY_MAX entries are kept, the oldest go first (with `never` too);
//   - on disk: `<home>/browser/closed-tabs.json` ({ v: 1, items: [...] }, newest first), written in one move with owner-only
//     mode inside the owner-only folder. Addresses never go to the log.
// The pure rules (no node import: the renderer bundle uses them too); `ClosedHistory` (closed-history.ts) is the file around them.
import { cleanTitle, isId, storableUrl } from './tab-rules.ts'

/** The ceiling of kept entries, whatever the expiry. */
export const CLOSED_HISTORY_MAX = 500

/** Who closed the tab: its agent (WebCloseTab), the person, the clean-up of an ended agent's tabs, or the agent's end. */
export type ClosedBy = 'agent' | 'user' | 'cleanup' | 'ended'
const BY: readonly ClosedBy[] = ['agent', 'user', 'cleanup', 'ended']

export interface ClosedTab {
  /** The entry's own id (the closed tab's id: a tab closes once). */
  id: string
  ownerSlotId: string
  /** The owner's name when the tab closed (the agent may be gone when the person reads the list). */
  ownerName: string
  title: string
  url: string
  closedAt: number
  by: ClosedBy
}

/** The setting's values (manifest `closedHistory`). */
export const CLOSED_HISTORY_KEEP = ['1d', '7d', '30d', 'never'] as const
export type ClosedHistoryKeep = (typeof CLOSED_HISTORY_KEEP)[number]
export const CLOSED_HISTORY_DEFAULT: ClosedHistoryKeep = '7d'

const DAY = 24 * 60 * 60 * 1000
const KEEP_MS: Record<ClosedHistoryKeep, number | undefined> = { '1d': DAY, '7d': 7 * DAY, '30d': 30 * DAY, never: undefined }

/** The setting as read (anything may be in settings.json): an unknown value is the default. */
export function keepOf(v: unknown): ClosedHistoryKeep {
  return (CLOSED_HISTORY_KEEP as readonly unknown[]).includes(v) ? v as ClosedHistoryKeep : CLOSED_HISTORY_DEFAULT
}

/** How long an entry lives, in ms; undefined: until the ceiling pushes it out. */
export const keepMs = (keep: ClosedHistoryKeep): number | undefined => KEEP_MS[keep]

/**
 * The entry for a tab that closed, or undefined when it is not kept: an address that is not a web address (the blank page, a
 * tab that never loaded) or that carried a credential, or ids that are not ids.
 */
export function closedEntryOf(f: { tabId: unknown; ownerSlotId: unknown; ownerName?: unknown; title?: unknown; url: unknown; closedAt: number; by: ClosedBy }): ClosedTab | undefined {
  if (!isId(f.tabId) || !isId(f.ownerSlotId) || !storableUrl(f.url) || !Number.isFinite(f.closedAt)) return undefined
  return { id: f.tabId, ownerSlotId: f.ownerSlotId, ownerName: cleanTitle(f.ownerName).slice(0, 120), title: cleanTitle(f.title), url: f.url, closedAt: f.closedAt, by: f.by }
}

/** The list as kept: newest first, the expired gone, no entry twice, at most `max`. */
export function pruneClosed(items: readonly ClosedTab[], now: number, keep: ClosedHistoryKeep, max = CLOSED_HISTORY_MAX): ClosedTab[] {
  const ms = keepMs(keep)
  const seen = new Set<string>()
  const out: ClosedTab[] = []
  for (const it of [...items].sort((a, b) => b.closedAt - a.closedAt)) {
    if (ms !== undefined && now - it.closedAt > ms) continue
    if (seen.has(it.id)) continue
    seen.add(it.id)
    out.push(it)
    if (out.length >= max) break
  }
  return out
}

/** The file's content read back (anything may be there): only well-formed entries, credentials dropped again. */
export function parseClosed(raw: unknown): ClosedTab[] {
  const items = raw && typeof raw === 'object' && (raw as { v?: unknown }).v === 1 ? (raw as { items?: unknown }).items : undefined
  if (!Array.isArray(items)) return []
  const out: ClosedTab[] = []
  for (const v of items.slice(0, CLOSED_HISTORY_MAX * 2)) {
    if (!v || typeof v !== 'object') continue
    const o = v as Record<string, unknown>
    const by = BY.includes(o.by as ClosedBy) ? o.by as ClosedBy : 'user'
    const e = closedEntryOf({ tabId: o.id, ownerSlotId: o.ownerSlotId, ownerName: o.ownerName, title: o.title, url: o.url, closedAt: typeof o.closedAt === 'number' ? o.closedAt : NaN, by })
    if (e) out.push(e)
  }
  return out
}

export interface ClosedGroup { slotId: string; name: string; items: ClosedTab[] }

/** The list by owner, owners in the order of their newest entry, each owner's entries newest first. */
export function closedGroups(items: readonly ClosedTab[]): ClosedGroup[] {
  const groups = new Map<string, ClosedGroup>()
  for (const it of [...items].sort((a, b) => b.closedAt - a.closedAt)) {
    const g = groups.get(it.ownerSlotId)
    if (g) g.items.push(it)
    else groups.set(it.ownerSlotId, { slotId: it.ownerSlotId, name: it.ownerName, items: [it] })
  }
  return [...groups.values()]
}

/**
 * The tabs of an agent that ended that close with it: every one but those with the person (she took it, a help request is open,
 * or one ran out and she still holds it). Those stay with her.
 */
export function tabsToCloseOnEnd<T extends { tabId: string; ownerSlotId: string }>(
  tabs: readonly T[], slotId: string, controlOf: (tabId: string) => { holder: 'agent' | 'user'; asking: boolean } | undefined,
): T[] {
  return tabs.filter(t => {
    if (t.ownerSlotId !== slotId) return false
    const c = controlOf(t.tabId)
    return !c || (c.holder !== 'user' && !c.asking)
  })
}

// ---- the texts ----

export const PAD_CLOSED = 'Fechadas'
export const PAD_REOPEN = 'Reabrir'
export const PAD_CLEAR_CLOSED = 'Limpar histórico'
const BY_TEXT: Record<ClosedBy, string> = { agent: 'fechada pelo agente', user: 'fechada por você', cleanup: 'fechada na limpeza', ended: 'agente encerrado' }
export const closedByText = (by: ClosedBy): string => BY_TEXT[by]
