// `@name` in what the moderator writes becomes the line's `to` (slice U1b). Pure: no DOM, no daemon.
// A name resolves by whole segment of a member's name, case-blind, the way the daemon's `say` resolves `to`
// ("soul · bancada" answers to `@soul` and to `@bancada`). A mention that matches no member, or more than one,
// stays plain text and addresses nobody.

/** A mention starts at the line start or after a character that cannot be part of a word, and runs over letters, digits, `_` and `-`. */
const MENTION = /(^|[^\p{L}\p{N}_@-])@([\p{L}\p{N}_-]+)/gu
const SEGMENT_SPLIT = /[^\p{L}\p{N}_-]+/u

const fold = (s: string): string => s.toLocaleLowerCase('pt-BR')

/** The segments of a display name, folded: "soul · bancada" -> ["soul", "bancada"]. */
export const segmentsOf = (name: string): string[] => fold(name).split(SEGMENT_SPLIT).filter(s => s !== '')

/** The member a token names, when exactly one does (by segment, or by the whole name with its spaces removed). */
export function resolveMention(token: string, names: readonly string[]): string | undefined {
  const t = fold(token)
  const hits = names.filter(n => segmentsOf(n).includes(t) || fold(n).replace(/\s+/g, '') === t)
  return hits.length === 1 ? hits[0] : undefined
}

/** The display names a text addresses, in order of appearance, each once. */
export function mentionedNames(text: string, names: readonly string[]): string[] {
  const out: string[] = []
  for (const m of text.matchAll(MENTION)) {
    const n = resolveMention(m[2]!, names)
    if (n !== undefined && !out.includes(n)) out.push(n)
  }
  return out
}

/** The final `to`: what the person picked in the box first, then the mentions; empty means "for everyone". */
export const addresseesOf = (picked: string | undefined, text: string, names: readonly string[]): string[] =>
  [...new Set([...(picked !== undefined && picked !== '' ? [picked] : []), ...mentionedNames(text, names)])]
