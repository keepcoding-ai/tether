// The toolbar's session search (pure): which sessions match the typed text and in what order. The DOM is
// session-search.ts; main.ts feeds it the sessions that have a tab, with the tab's title and the desk's name.
import { fuzzyMatch } from './fuzzy.ts'

export interface SearchSession {
  slotId: string
  /** What the tab shows; may be empty (then the row falls back to the slot id). */
  title: string
  /** Where the tab lives ("Mesa 1", "Gaveta"). */
  place: string
}

export interface SearchHit {
  slotId: string
  /** The text the row shows (the title, or the slot id when there is none). */
  label: string
  place: string
  /** Indexes into `label` to highlight. */
  positions: number[]
  score: number
}

/** Rows shown at most: the box is a jump, not a listing. */
export const SEARCH_LIMIT = 12

/** Bonus that puts a slot id prefix match above any fuzzy match of a title. */
const ID_PREFIX = 1000

/**
 * The matching sessions, best first: the fuzzy score on the label, or a slot id prefix (case-insensitive) which ranks
 * on top. An empty query lists nothing. Ties keep the input order (the desks' order).
 */
export function searchSessions(query: string, sessions: readonly SearchSession[], limit = SEARCH_LIMIT): SearchHit[] {
  const q = query.trim()
  if (q === '') return []
  const lowered = q.toLowerCase()
  const hits: { hit: SearchHit; index: number }[] = []
  sessions.forEach((s, index) => {
    const label = s.title.trim() || s.slotId
    const fm = fuzzyMatch(q, label)
    const idPrefix = s.slotId.toLowerCase().startsWith(lowered)
    if (!fm && !idPrefix) return
    const score = (fm?.score ?? 0) + (idPrefix ? ID_PREFIX : 0)
    const positions = fm?.positions ?? []
    hits.push({ hit: { slotId: s.slotId, label, place: s.place, positions, score }, index })
  })
  hits.sort((a, b) => b.hit.score - a.hit.score || a.index - b.index)
  return hits.slice(0, limit).map(h => h.hit)
}

/** The next selected row for ↑ (-1) / ↓ (+1), wrapping; -1 when there are no rows. */
export function moveSelection(current: number, delta: number, count: number): number {
  if (count === 0) return -1
  if (current < 0) return delta > 0 ? 0 : count - 1
  return (current + delta + count) % count
}
