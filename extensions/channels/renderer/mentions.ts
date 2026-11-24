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

// ---------- the "@" autocomplete (pure) ----------

/** The word the person is typing after an `@`: where the `@` is and what follows it up to the caret. */
export interface MentionTrigger { start: number; term: string }

const WORD_CHAR = /[\p{L}\p{N}_-]/u

/** The mark that opens a list: `@` lists the members, `#` lists the channels. */
export type TriggerMark = '@' | '#'
/** A trigger of either list. */
export interface ListTrigger extends MentionTrigger { mark: TriggerMark }

/** The `<mark>term` the caret sits in the end of: the mark must open the text or follow whitespace (an e-mail's `@` does not trigger). */
export function listTrigger(text: string, caret: number): ListTrigger | undefined {
  let i = caret
  while (i > 0 && WORD_CHAR.test(text[i - 1]!)) i--
  const mark = i > 0 ? text[i - 1] : undefined
  if (mark !== '@' && mark !== '#') return undefined
  const at = i - 1
  if (at > 0 && !/\s/u.test(text[at - 1]!)) return undefined
  return { mark, start: at, term: text.slice(i, caret) }
}

/** The `@term` the caret sits in the end of: the `@` must open the text or follow whitespace (an e-mail's `@` does not trigger). */
export function mentionTrigger(text: string, caret: number): MentionTrigger | undefined {
  const t = listTrigger(text, caret)
  return t && t.mark === '@' ? { start: t.start, term: t.term } : undefined
}

/** Case- and accent-blind form of a text, for matching what the person types. */
export const plain = (s: string): string => fold(s).normalize('NFD').replace(/\p{M}+/gu, '')

/** The name of the "everyone" row: it addresses nobody in particular (the default). */
export const EVERYONE = 'todos'

/** One row of the list. `all` is the "todos" row. */
export interface MentionOption { name: string; all: boolean }

/** "todos" first, then the members; kept when the term is found anywhere in the name. An empty term keeps all. */
export function filterMentionOptions(term: string, names: readonly string[]): MentionOption[] {
  const t = plain(term)
  return [{ name: EVERYONE, all: true }, ...names.map(name => ({ name, all: false }))].filter(o => plain(o.name).includes(t))
}

/**
 * What goes after the `@` for a member: its first segment that names it alone (so that the mention resolves back to it), else the
 * first segment. "todos" is itself.
 */
export function mentionToken(name: string, names: readonly string[]): string {
  if (name === EVERYONE) return EVERYONE
  const segs = segmentsOf(name)
  return segs.find(s => resolveMention(s, names) === name) ?? segs[0] ?? name
}

/** The text with the `<mark>term` at `trigger` (up to `caret`) replaced by `<mark>token `, and where the caret goes. */
export function applyPick(text: string, trigger: MentionTrigger, caret: number, token: string, mark: TriggerMark = '@'): { text: string; caret: number } {
  const insert = `${mark}${token} `
  return { text: text.slice(0, trigger.start) + insert + text.slice(caret), caret: trigger.start + insert.length }
}

/** The text with the `@term` at `trigger` (up to `caret`) replaced by `@token `, and where the caret goes. */
export const applyMention = (text: string, trigger: MentionTrigger, caret: number, token: string): { text: string; caret: number } =>
  applyPick(text, trigger, caret, token, '@')

// ---------- the "#" channel references (pure) ----------

/** What the "#" list knows of a channel: its name and whether it is the one the box belongs to. */
export interface ChannelChoice { name: string; current: boolean }

/** The channels whose name holds the term anywhere (case- and accent-blind); the current channel goes last. */
export function filterChannelOptions(term: string, channels: readonly ChannelChoice[]): ChannelChoice[] {
  const t = plain(term)
  const kept = channels.filter(c => plain(c.name).includes(t))
  return [...kept.filter(c => !c.current), ...kept.filter(c => c.current)]
}

const CHANNEL_REF = /(^|[^\p{L}\p{N}_#@-])#([\p{L}\p{N}_-]+)/gu

/** The spans (with the `#`) of the references in a text that name one of the known channels (whole name, case-blind). */
export function channelSpans(text: string, names: readonly string[]): Array<{ start: number; end: number; name: string }> {
  const out: Array<{ start: number; end: number; name: string }> = []
  for (const m of text.matchAll(CHANNEL_REF)) {
    const token = fold(m[2]!)
    const name = names.find(n => fold(n) === token)
    if (name === undefined) continue
    const start = m.index! + m[1]!.length
    out.push({ start, end: start + 1 + m[2]!.length, name })
  }
  return out
}

/** The text of the "#" list as the person reads it. */
export const HASH_TEXT = { listLabel: 'Canais abertos', current: 'este canal', open: (name: string): string => `Abrir #${name}` } as const

/** The spans (with the `@`) of the mentions in a text that name a member: what the conversation highlights. */
export function mentionSpans(text: string, names: readonly string[]): Array<{ start: number; end: number; name: string }> {
  const out: Array<{ start: number; end: number; name: string }> = []
  for (const m of text.matchAll(MENTION)) {
    const name = resolveMention(m[2]!, names)
    if (name === undefined) continue
    const start = m.index! + m[1]!.length
    out.push({ start, end: start + 1 + m[2]!.length, name })
  }
  return out
}

/** The final `to`: what the person picked in the box first, then the mentions; empty means "for everyone". */
export const addresseesOf = (picked: string | undefined, text: string, names: readonly string[]): string[] =>
  [...new Set([...(picked !== undefined && picked !== '' ? [picked] : []), ...mentionedNames(text, names)])]
