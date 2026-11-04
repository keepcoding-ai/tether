// The command filter of VS Code's palette (WORD_FILTER = or(matchesPrefix, matchesWords, matchesContiguousSubString)),
// ported to run on accent-free, lowercase text: the user types "direita" and finds "à direita". It only
// filters and yields the ranges to highlight; it never scores (the palette orders by recency and title).
// Letter-apart matching (fuzzy.ts) is not used here; it is reserved for the file quick open.

export interface Range { start: number; end: number }

const SEPARATORS = new Set([...' \t~!@#$%^&*()-=+[{]}\\|;:\'",.<>/?'])
const isSeparator = (ch: string): boolean => SEPARATORS.has(ch)

/** Lowercase, accent-free, one character per UTF-16 unit (so ranges index the original text). */
export function fold(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; i++) out += (text[i]!.normalize('NFD')[0] ?? '').toLowerCase()[0] ?? ''
  return out
}

/** Adjacent ranges become one. */
function join(head: Range, tail: Range[]): Range[] {
  const first = tail[0]
  if (first && head.end === first.start) return [{ start: head.start, end: first.end }, ...tail.slice(1)]
  return [head, ...tail]
}

function nextWord(target: string, from: number): number {
  for (let i = from; i < target.length; i++) if (isSeparator(target[i]!) || (i > 0 && isSeparator(target[i - 1]!))) return i
  return target.length
}

const charactersMatch = (a: string, b: string): boolean => a === b || (isSeparator(a) && isSeparator(b))

function wordsAt(word: string, target: string, wi: number, ti: number): Range[] | null {
  if (wi === word.length) return []
  if (ti === target.length) return null
  if (!charactersMatch(word[wi]!, target[ti]!)) return null
  let rest = wordsAt(word, target, wi + 1, ti + 1)
  let next = ti + 1
  while (!rest && (next = nextWord(target, next)) < target.length) {
    rest = wordsAt(word, target, wi + 1, next)
    next++
  }
  return rest ? join({ start: ti, end: ti + 1 }, rest) : null
}

/** The query's characters match the start of the target's words, in order ("dup dir" → "Duplicar à direita"). */
export function matchesWords(query: string, target: string): Range[] | null {
  if (!target) return null
  const w = fold(query), t = fold(target)
  let ti = 0
  while (ti < t.length) {
    const r = wordsAt(w, t, 0, ti)
    if (r) return r
    ti = nextWord(t, ti + 1)
  }
  return null
}

function matchesPrefix(query: string, target: string): Range[] | null {
  const w = fold(query), t = fold(target)
  if (!t.startsWith(w)) return null
  return w.length > 0 ? [{ start: 0, end: w.length }] : []
}

function matchesContiguousSubString(query: string, target: string): Range[] | null {
  const w = fold(query), t = fold(target)
  const i = t.indexOf(w)
  return i < 0 ? null : [{ start: i, end: i + w.length }]
}

/** Prefix, then words, then contiguous substring; the first that fits wins. Null when none does. */
export function wordFilter(query: string, target: string): Range[] | null {
  return matchesPrefix(query, target) ?? matchesWords(query, target) ?? matchesContiguousSubString(query, target)
}

/** The part of `ranges` inside [from, to), shifted to start at 0. */
export function clipRanges(ranges: readonly Range[], from: number, to: number): Range[] {
  const out: Range[] = []
  for (const r of ranges) {
    const start = Math.max(r.start, from), end = Math.min(r.end, to)
    if (start < end) out.push({ start: start - from, end: end - from })
  }
  return out
}

/** The text split into plain and matched runs, for rendering without innerHTML. */
export function rangeRuns(text: string, ranges: readonly Range[]): { text: string; hit: boolean }[] {
  const runs: { text: string; hit: boolean }[] = []
  let at = 0
  for (const r of [...ranges].sort((a, b) => a.start - b.start)) {
    if (r.start > at) runs.push({ text: text.slice(at, r.start), hit: false })
    if (r.end > Math.max(r.start, at)) runs.push({ text: text.slice(Math.max(r.start, at), r.end), hit: true })
    at = Math.max(at, r.end)
  }
  if (at < text.length) runs.push({ text: text.slice(at), hit: false })
  return runs.length ? runs : [{ text, hit: false }]
}
