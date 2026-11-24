// What the pane shows of the reactions, as pure functions (no DOM, no daemon): the pills of a message, the sum kept when a
// reaction line is heard, the person's gesture shown before the daemon answers, and the words of the refusals. A reaction is a
// signal, not a speech: nothing here touches the timeline's lines, the unread count or the "seen" mark.
import { ASK_EMOJIS, parseReaction, reactionKey, REACTION_SENSES, REACTIONS_PER_LINE, REACTIONS_PER_MEMBER, USER, type Line, type ReactionTally } from '../rules.ts'

/** The five agreed reactions as the person reads them (the agent writes the `name`). */
export const SENSE_TEXT: Record<string, { emoji: string; label: string; sense: string }> = Object.fromEntries(REACTION_SENSES.map((s) => [s.name, {
  emoji: s.emoji,
  label: { seen: 'Vi', agree: 'Concordo', done: 'Feito', disagree: 'Discordo', question: 'Dúvida' }[s.name] ?? s.name,
  sense: { seen: 'vi', agree: 'concordo', done: 'feito', disagree: 'discordo', question: 'dúvida' }[s.name] ?? s.name,
}]))

/** The five, in the order of the bar and of the menu. */
export const FIVE: ReadonlyArray<{ name: string; emoji: string; label: string; sense: string }> =
  REACTION_SENSES.map((s) => ({ name: s.name, emoji: s.emoji, label: SENSE_TEXT[s.name]!.label, sense: SENSE_TEXT[s.name]!.sense }))

/** The sum of the reactions of each message the pane holds. */
export type Tallies = Map<number, ReactionTally[]>

/** `add`/`remove` of one emoji by `who` over the tallies of one message (a repeated `add` and a `remove` without `add` change nothing). */
export function applyReaction(tallies: readonly ReactionTally[] | undefined, line: Line): ReactionTally[] {
  const list = (tallies ?? []).map((t) => ({ ...t, by: [...t.by] }))
  const r = line.react
  if (line.kind !== 'reaction' || !r) return list
  const key = reactionKey(r.emoji)
  const at = list.findIndex((t) => reactionKey(t.emoji) === key)
  const who = line.from.id
  if (r.op === 'add') {
    if (at < 0) {
      const sense = REACTION_SENSES.find((s) => reactionKey(s.emoji) === key)
      list.push({ emoji: r.emoji, ...(sense ? { name: sense.name } : {}), by: [{ id: who as ReactionTally['by'][number]['id'], name: line.from.name }] })
    } else if (!list[at]!.by.some((b) => b.id === who)) list[at]!.by.push({ id: who as ReactionTally['by'][number]['id'], name: line.from.name })
  } else if (at >= 0) {
    list[at]!.by = list[at]!.by.filter((b) => b.id !== who)
    if (list[at]!.by.length === 0) list.splice(at, 1)
  }
  return list
}

/** One pill. `mine`: the person reacted with it; `pending`: her gesture is on its way to the daemon. */
export interface Pill { emoji: string; name?: string; count: number; by: Array<{ id: string; name: string }>; mine: boolean; pending: boolean }

/** The gestures of the person the daemon has not answered yet, by `reactionKey(emoji)`. */
export type Pending = ReadonlyMap<string, 'add' | 'remove'>

const isMe = (id: string): boolean => id === USER

/** The pills of a message: the tallies in the order they came, with the person's pending gesture laid over them. */
export function pillsOf(tallies: readonly ReactionTally[] | undefined, pending?: Pending): Pill[] {
  const pills: Pill[] = (tallies ?? []).map((t) => ({
    emoji: t.emoji, ...(t.name ? { name: t.name } : {}), count: t.by.length, by: t.by.map((b) => ({ id: b.id, name: b.name })),
    mine: t.by.some((b) => isMe(b.id)), pending: false,
  }))
  for (const [key, op] of pending ?? []) {
    const at = pills.findIndex((p) => reactionKey(p.emoji) === key)
    if (op === 'add') {
      if (at >= 0) {
        if (!pills[at]!.mine) pills[at] = { ...pills[at]!, count: pills[at]!.count + 1, by: [...pills[at]!.by, { id: USER, name: 'Você' }], mine: true, pending: true }
      } else {
        const sense = REACTION_SENSES.find((s) => reactionKey(s.emoji) === key)
        pills.push({ emoji: sense?.emoji ?? key, ...(sense ? { name: sense.name } : {}), count: 1, by: [{ id: USER, name: 'Você' }], mine: true, pending: true })
      }
    } else if (at >= 0 && pills[at]!.mine) {
      const rest = pills[at]!.by.filter((b) => !isMe(b.id))
      if (rest.length === 0) pills.splice(at, 1)
      else pills[at] = { ...pills[at]!, count: rest.length, by: rest, mine: false, pending: true }
    }
  }
  return pills
}

/** "Você e codex · conferência" / "Você, A e B": the person first. */
export function whoText(by: ReadonlyArray<{ id: string; name: string }>): string {
  const names = [...by.filter((b) => isMe(b.id)).map(() => 'Você'), ...by.filter((b) => !isMe(b.id)).map((b) => b.name)]
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} e ${names[names.length - 1]}`
}

/** The hover text of a pill: who reacted and the agreed meaning, when it has one ("Você e codex · conferência: concordo"). */
export function pillTitle(p: Pick<Pill, 'by' | 'name' | 'emoji'>): string {
  const sense = p.name ? SENSE_TEXT[p.name]?.sense : undefined
  return `${whoText(p.by)}${sense ? `: ${sense}` : ''}`
}

/**
 * What the person is told when her ❓ or ❌ lands on an agent's speech: it wakes nobody, the agent reads it with the next message of the
 * channel. Undefined for any other reaction, for another's, and for her own speeches.
 */
export function seesNextText(p: Pick<Pill, 'emoji' | 'mine'>, author: { id: string; name: string; role?: string } | undefined): string | undefined {
  if (!p.mine || !author || author.id === USER || author.role === 'moderator') return undefined
  return ASK_EMOJIS.includes(reactionKey(p.emoji)) ? `${author.name} vê isto na próxima mensagem do canal` : undefined
}

/** What a screen reader says of a pill (a toggle button): "concordo, 2 reações: Você e codex. Você reagiu." */
export function pillAria(p: Pick<Pill, 'by' | 'name' | 'emoji' | 'count' | 'mine'>, readOnly = false): string {
  const sense = (p.name ? SENSE_TEXT[p.name]?.sense : undefined) ?? p.emoji
  return `${sense}, ${p.count === 1 ? '1 reação' : `${p.count} reações`}: ${whoText(p.by)}.${p.mine ? ' Você reagiu.' : ''}${readOnly ? '' : p.mine ? ' Clique para tirar.' : ' Clique para reagir também.'}`
}

/** The five an author's reactions of the person on one message (`reactionKey`s) — what the bar and the menu mark. */
export function minesOf(tallies: readonly ReactionTally[] | undefined, pending?: Pending): Set<string> {
  return new Set(pillsOf(tallies, pending).filter((p) => p.mine).map((p) => reactionKey(p.emoji)))
}

/** What a screen reader hears of a message's reactions: "concordo, 2; 🎉, 1" (the agreed meaning when there is one, the emoji otherwise). */
export function pillsSummary(pills: ReadonlyArray<Pick<Pill, 'name' | 'emoji' | 'count'>>): string {
  return pills.map(p => `${(p.name ? SENSE_TEXT[p.name]?.sense : undefined) ?? p.emoji}, ${p.count}`).join('; ')
}

/** The name of a focused message: who, when, to whom, the text, then its reactions ("claude · nic, 09:15, para Guga. Terminei. Reações: concordo, 2."). */
export function msgAria(m: { who: string; time: string; to: readonly string[]; body: string }, pills: ReadonlyArray<Pick<Pill, 'name' | 'emoji' | 'count'>>): string {
  const head = `${m.who}${m.time ? `, ${m.time}` : ''}, ${m.to.length === 0 ? 'para todos' : `para ${m.to.join(', ')}`}`
  const rx = pills.length === 0 ? '' : ` Reações: ${pillsSummary(pills)}.`
  const body = m.body.trimEnd()
  return `${head}. ${body}${/[.!?…:;]$/.test(body) ? '' : '.'}${rx}`
}

/** What is said aloud when a reaction changes (never the whole conversation): "nic reagiu com concordo à fala de Guga". */
export function announceText(a: { who: string; emoji: string; name?: string; op: 'add' | 'remove'; author: string }): string {
  const what = (a.name ? SENSE_TEXT[a.name]?.sense : undefined) ?? a.emoji
  return a.op === 'add' ? `${a.who} reagiu com ${what} à fala de ${a.author}.` : `${a.who} tirou ${what} da fala de ${a.author}.`
}

/** The pills that fit before "+N": the rest are listed by the "+N" button (more room in a wide pane). */
export const PILLS_SHOWN = { wide: 6, narrow: 4 } as const
export function splitPills<T>(pills: readonly T[], narrow: boolean): { shown: T[]; hidden: T[] } {
  const max = narrow ? PILLS_SHOWN.narrow : PILLS_SHOWN.wide
  return pills.length <= max ? { shown: [...pills], hidden: [] } : { shown: pills.slice(0, max), hidden: pills.slice(max) }
}

/** The recent emojis of the person (newest first, the five agreed ones left out: they have their own row), kept short. */
export const RECENTS_MAX = 6
export function pushRecent(list: readonly string[], emoji: string): string[] {
  const key = reactionKey(emoji)
  if (REACTION_SENSES.some(s => reactionKey(s.emoji) === key)) return [...list]
  return [emoji, ...list.filter(e => reactionKey(e) !== key)].slice(0, RECENTS_MAX)
}
/** The recents as saved (a JSON list of texts); anything else is no recents. */
export function readRecents(raw: string | null | undefined): string[] {
  try {
    const v: unknown = JSON.parse(raw ?? '[]')
    return Array.isArray(v) ? v.filter((e): e is string => typeof e === 'string' && parseReaction(e) !== undefined).slice(0, RECENTS_MAX) : []
  } catch { return [] }
}

/** The "other emoji" field: exactly one emoji (never a text, never one of the five's names), or the notice. */
export const OTHER_EMOJI_REFUSAL = 'Use um emoji só.'
export function otherEmoji(text: string): { emoji: string } | { error: string } {
  const t = text.trim()
  const r = parseReaction(t)
  return r === undefined || r.name === t.toLowerCase() ? { error: OTHER_EMOJI_REFUSAL } : { emoji: r.emoji }
}

/** Where the system's own emoji picker lives, for the field's hint. */
export function emojiKeyHint(platform: string): string {
  return /^Win/i.test(platform) ? 'cole ou use Win + .' : /^Mac/i.test(platform) ? 'cole ou use Ctrl + Cmd + Espaço' : 'cole um emoji'
}

/** The short notice for a refusal of the daemon (the plan's words); `mine`/`kinds` tell the two meanings of `limit` apart. */
export function refusalText(code: string | undefined, ctx: { mine: number; kinds: number } = { mine: 0, kinds: 0 }): string {
  switch (code) {
    case 'closed': return 'A reação não entrou: o canal foi encerrado.'
    case 'too-old': return 'A reação não entrou: a fala é antiga demais (só as últimas 500 linhas aceitam reação).'
    case 'limit':
      return ctx.mine >= REACTIONS_PER_MEMBER ? `Você já tem ${REACTIONS_PER_MEMBER} reações nesta fala: tire uma para pôr outra.`
        : ctx.kinds >= REACTIONS_PER_LINE ? `Esta fala já tem ${REACTIONS_PER_LINE} emojis diferentes.`
        : 'A reação não entrou: a fala já tem o máximo de reações.'
    case 'slow-down': return 'Calma: reações demais em pouco tempo. Tente de novo em instantes.'
    case 'unknown-line': case 'not-a-message': return 'A reação não entrou: só uma fala aceita reação.'
    case 'unknown-channel': return 'A reação não entrou: este canal não existe mais.'
    default: return 'A reação não entrou.'
  }
}
