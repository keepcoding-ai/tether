// Approximate matching for the palette: the query is a subsequence of the text (letters may be apart), case
// and accents do not matter ("proxima" finds "Próxima mesa"), spaces in the query are ignored. The score prefers
// runs of consecutive letters and letters that start a word, so "nm" ranks "Nova mesa" above "Renomear".
// `positions` are indexes into the original text, for the highlight.

export interface FuzzyMatch {
  /** Higher is better; 0 for the empty query (which matches everything). */
  score: number
  positions: number[]
}

const COMBINING = /[̀-ͯ]/g

/** One lowercase, accent-free character per index of `text` ('' where the original character was only a mark). */
export function foldChars(text: string): string[] {
  const out: string[] = []
  for (const ch of text) {
    const folded = ch.normalize('NFD').replace(COMBINING, '').toLowerCase()
    out.push(folded.length > 0 ? folded[0]! : '')
  }
  return out
}

/** The query as folded characters, spaces dropped. */
export function foldQuery(query: string): string[] {
  return foldChars(query).filter(c => c !== '' && c !== ' ')
}

const isWordChar = (c: string): boolean => c !== '' && /[\p{L}\p{N}]/u.test(c)

const CONSECUTIVE = 3
const WORD_START = 2
const MATCH = 1
const GAP_PENALTY = 0.05

/**
 * The best way to place `query` inside `text` as a subsequence, or undefined when it does not fit.
 * Memoised search over (query index, text index, previous match was the character before): small inputs
 * (titles under a hundred characters), so the table stays tiny.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | undefined {
  const q = foldQuery(query)
  if (q.length === 0) return { score: 0, positions: [] }
  const t = foldChars(text)
  // Code points vs UTF-16 indexes: the positions must index the string the highlight slices.
  const offsets: number[] = []
  let off = 0
  for (const ch of text) { offsets.push(off); off += ch.length }
  const n = q.length
  const m = t.length
  if (n > m) return undefined
  const memo = new Map<number, { score: number; next: number[] } | null>()
  const key = (i: number, j: number, cons: boolean): number => (i * (m + 1) + j) * 2 + (cons ? 1 : 0)

  const best = (i: number, j: number, cons: boolean): { score: number; next: number[] } | null => {
    if (i === n) return { score: 0, next: [] }
    if (m - j < n - i) return null
    const k = key(i, j, cons)
    const hit = memo.get(k)
    if (hit !== undefined) return hit
    let result: { score: number; next: number[] } | null = null
    for (let p = j; p <= m - (n - i); p++) {
      if (t[p] !== q[i]) continue
      const rest = best(i + 1, p + 1, true)
      if (!rest) continue
      let s = MATCH
      if (cons && p === j) s += CONSECUTIVE
      if (p === 0 || !isWordChar(t[p - 1]!)) s += WORD_START
      s -= GAP_PENALTY * (p - j)
      const total = s + rest.score
      if (!result || total > result.score) result = { score: total, next: [p, ...rest.next] }
    }
    memo.set(k, result)
    return result
  }

  const r = best(0, 0, false)
  if (!r) return undefined
  // A match that starts the text reads as "the" result: a small nudge keeps "Nova mesa" above "Renomear mesa" for "n".
  const score = r.score + (r.next[0] === 0 ? 1 : 0)
  return { score, positions: r.next.map(p => offsets[p]!) }
}

/** The text split into plain and matched runs, for rendering without innerHTML: [{ text, hit }]. */
export function highlightRuns(text: string, positions: readonly number[]): { text: string; hit: boolean }[] {
  const runs: { text: string; hit: boolean }[] = []
  const hits = new Set(positions)
  let i = 0
  for (const ch of text) {
    const hit = hits.has(i)
    const last = runs[runs.length - 1]
    if (last && last.hit === hit) last.text += ch
    else runs.push({ text: ch, hit })
    i += ch.length
  }
  return runs
}
