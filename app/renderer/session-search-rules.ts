// The toolbar's tab search (pure): which tabs match the typed text and in what order. Every tab counts, of any kind
// (agent, shell, browser, note, previews, screens, empty) and wherever it lives (desks, drawer, pads). The DOM is
// session-search.ts; main.ts feeds it the tabs, with the title and the extra searchable text of each (the place is
// looked up only for the rows shown).
import { fuzzyMatch } from './fuzzy.ts'

export interface SearchTab {
  /** The pane id. */
  id: string
  /** What the tab shows; may be empty (then the row falls back to the id). */
  title: string
  /** More text that finds the tab without being shown highlighted (a browser's URL, a note's file path). */
  extra?: string | undefined
}

export interface SearchHit {
  id: string
  /** The text the row shows (the title, or the id when there is none). */
  label: string
  /** Indexes into `label` to highlight. */
  positions: number[]
  score: number
}

/** Rows shown at most: the box is a jump, not a listing. */
export const SEARCH_LIMIT = 12

/** Bonus that puts an id prefix match above any fuzzy match of a title. */
const ID_PREFIX = 1000

/**
 * The matching tabs, best first: the fuzzy score on the label, or an id prefix (case-insensitive) which ranks on top.
 * A tab whose label does not match may still match on its extra text (substring, case-insensitive), ranked below every
 * label match. An empty query lists nothing. Ties keep the input order (the desks' order).
 */
export function searchTabs(query: string, tabs: readonly SearchTab[], limit = SEARCH_LIMIT): SearchHit[] {
  const q = query.trim()
  if (q === '') return []
  const lowered = q.toLowerCase()
  const hits: { hit: SearchHit; index: number }[] = []
  tabs.forEach((t, index) => {
    const label = t.title.trim() || t.id
    const fm = fuzzyMatch(q, label)
    const idPrefix = t.id.toLowerCase().startsWith(lowered)
    const inExtra = !fm && !idPrefix && !!t.extra && t.extra.toLowerCase().includes(lowered)
    if (!fm && !idPrefix && !inExtra) return
    const score = inExtra ? -1 : (fm?.score ?? 0) + (idPrefix ? ID_PREFIX : 0)
    const positions = fm?.positions ?? []
    hits.push({ hit: { id: t.id, label, positions, score }, index })
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
