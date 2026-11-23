// What the channel's pane shows, as pure functions (no DOM, no daemon): the history becomes rows, a say and a system notice are
// drawn apart, the members come with the state of each, and the page of the history merges into what is held. The pane only
// paints these. Words on the screen are Portuguese (P12: dono, membro, moderador, calado); the code says owner, member, moderator,
// muted. Nothing here is orange: the "to me" mark is the U3's.
import { agentHue } from '../../../app/shared/agent-color.ts'
import type { PaneEmblem } from '../../../app/renderer/ext-api.ts'
import type { Line, LineEventType } from '../rules.ts'
import type { ChannelSummary, MemberInfo } from '../daemon/requests.ts'

/** The answer of the `history` request. */
export interface HistoryPage { channel: ChannelSummary; lines: Line[]; more: boolean; last: number }
/** The answer of the `members` request. */
export interface MembersAnswer { channel: ChannelSummary; members: MemberInfo[]; removed: string[] }

/** The moderator's default display name in a line's `to` (setting `extensions.channels.moderatorName`). */
export const DEFAULT_MODERATOR_NAME = 'usuário'
/** How far from the bottom (px) the pane still counts as "reading the end". */
export const BOTTOM_SLACK_PX = 24

// ---------- the timeline held by one pane ----------

/** The lines the pane holds, ascending by `seq`, with no repeat. `more`: older lines exist; `last`: the newest `seq` known. */
export interface Timeline { lines: readonly Line[]; more: boolean; last: number }

export const emptyTimeline = (): Timeline => ({ lines: [], more: false, last: 0 })

/** Merges lines into an ascending list without repeats (a `seq` already held keeps the held one). */
function mergeLines(held: readonly Line[], incoming: readonly Line[]): Line[] {
  const bySeq = new Map<number, Line>()
  for (const l of incoming) bySeq.set(l.seq, l)
  for (const l of held) bySeq.set(l.seq, l)
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}

/** The first page (the newest) replaces what is held; an older page (`before`) goes on top. */
export function applyPage(t: Timeline, page: Pick<HistoryPage, 'lines' | 'more' | 'last'>, older: boolean): Timeline {
  if (!older) return { lines: mergeLines([], page.lines), more: page.more, last: Math.max(page.last, page.lines.at(-1)?.seq ?? 0) }
  return { lines: mergeLines(t.lines, page.lines), more: page.more, last: Math.max(t.last, page.last) }
}

/**
 * The newest page again, over what a pane already holds (it came back to a desk, or it missed lines): the held lines stay, and
 * the page fills the end. A page that does not touch what is held (more than a page was missed) replaces it.
 */
export function mergeNewest(t: Timeline, page: Pick<HistoryPage, 'lines' | 'more' | 'last'>): Timeline {
  const held = t.lines
  const first = page.lines[0]?.seq
  if (held.length === 0 || first === undefined || first > t.last + 1) return applyPage(emptyTimeline(), page, false)
  return { lines: mergeLines(held, page.lines), more: held[0]!.seq <= first ? t.more : page.more, last: Math.max(t.last, page.last) }
}

/** The `before` of the next older page, or undefined when there is none. */
export function olderCursor(t: Timeline): number | undefined {
  return t.more && t.lines.length > 0 ? t.lines[0]!.seq : undefined
}

/**
 * A new line from the `line` event. `gap`: the pane missed some (its `seq` is not the next one), so it asks the newest page again.
 * A line already held (or older than what is) changes nothing.
 */
export function applyLine(t: Timeline, line: Line): { timeline: Timeline; added: boolean; gap: boolean } {
  if (line.seq <= t.last) return { timeline: t, added: false, gap: false }
  const gap = t.last > 0 && line.seq !== t.last + 1
  return { timeline: { lines: mergeLines(t.lines, [line]), more: t.more, last: line.seq }, added: true, gap }
}

// ---------- rows ----------

export type NoticeGlyph = 'join' | 'leave' | 'remove' | 'mute' | 'unmute' | 'close' | 'reopen' | 'owner' | 'create' | 'info'

export const noticeGlyph = (type: LineEventType | undefined): NoticeGlyph => {
  switch (type) {
    case 'join': return 'join'
    case 'leave': return 'leave'
    case 'remove': return 'remove'
    case 'mute': return 'mute'
    case 'unmute': return 'unmute'
    case 'close': return 'close'
    case 'reopen': return 'reopen'
    case 'create': return 'create'
    case 'owner-ended': case 'owner-changed': return 'owner'
    default: return 'info'
  }
}

export type SpeakerRole = 'dono' | 'membro' | 'moderador'
const ROLE_TEXT: Record<'owner' | 'member' | 'moderator', SpeakerRole> = { owner: 'dono', member: 'membro', moderator: 'moderador' }

export interface Addressee { name: string; hue?: number; you: boolean }

export interface SayRow {
  kind: 'say'
  seq: number
  at: string
  time: string
  /** The name on the line; the person's own is "Você". */
  name: string
  hue?: number
  role: SpeakerRole
  /** The owner of the channel (draws the crown). */
  crown: boolean
  /** The person's own line. */
  mine: boolean
  /** Empty = "para todos". */
  to: Addressee[]
  body: string
  replyTo?: number
  /** The id of the author ('user' for the person). */
  authorId: string
  /** The same author, to the same people, right after: no header. */
  continued: boolean
}

export interface NoticeRow { kind: 'notice'; seq: number; at: string; time: string; glyph: NoticeGlyph; text: string }
export interface DayRow { kind: 'day'; key: string; label: string }
/** "novas para você · 14:05": drawn right before the first unseen line addressed to the person (the orange line of the conversation). */
export interface UnseenRow { kind: 'unseen'; seq: number; label: string }
export type Row = SayRow | NoticeRow | DayRow | UnseenRow

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** "14:03" in the local time of the window. */
export function timeOf(at: string): string {
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? '' : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

const dayKey = (d: Date): string => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`

/** "hoje", "ontem" or "23/11" (with the year when it is not this one). */
export function dayLabel(at: string, now: Date): string {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return ''
  const key = dayKey(d)
  if (key === dayKey(now)) return 'hoje'
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  if (key === dayKey(yesterday)) return 'ontem'
  const base = `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}`
  return d.getFullYear() === now.getFullYear() ? base : `${base}/${d.getFullYear()}`
}

/**
 * A system line names the person by her moderator name ("usuário abriu #obra", "calado por usuário"); on the screen she is "Você"
 * (P12). Whole words only, capital at the start of a sentence; a room (`#usuário`) or a longer word is left alone.
 */
export function nameYou(text: string, moderator: string): string {
  const name = moderator.trim()
  if (name === '') return text
  const re = new RegExp(`(?<![\\p{L}\\p{N}_#@-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_-])`, 'gu')
  return text.replace(re, (m, offset: number, whole: string) => (offset === 0 || /[.!?:]\s+$/.test(whole.slice(0, offset)) ? 'Você' : 'você'))
}

/**
 * The record's own lines are the same text the agents read, which still says "owner" in two of them (the desk channel's birth and
 * the owner ending). The screen says "dono" (P12): swapped here by the line's type, anchored on the fixed phrase of that line, so
 * a name or a room that happens to hold the word is left alone.
 */
export function screenText(type: LineEventType | undefined, text: string): string {
  if (type === 'create') return text.replace(/^(#\S+ nasceu com a mesa · )owner:/, '$1dono:')
  if (type === 'owner-ended') return text.replace(/^(.+ deixou de ser o )owner( de #\S+;)/, '$1dono$2')
  return text
}

export interface RowsOptions {
  /** The `seq` of the first unseen line addressed to the person (marks.ts): the separator goes right before it. */
  firstToMe?: number
  /** name → agent id of the members (to give a name in a `to` its hue). */
  idByName?: ReadonlyMap<string, string>
  /** The id of the channel's owner agent (draws the crown on its lines even if the line says member). */
  ownerId?: string
  moderatorName?: string
  now?: Date
}

/** The history as rows: a day separator when the day changes, a notice for the tether's lines, a say for the rest. */
export function rowsOf(lines: readonly Line[], opts: RowsOptions = {}): Row[] {
  const moderator = opts.moderatorName ?? DEFAULT_MODERATOR_NAME
  const now = opts.now ?? new Date()
  const rows: Row[] = []
  let lastDay = ''
  let prev: SayRow | undefined
  for (const l of lines) {
    const day = dayKey(new Date(l.at))
    if (day !== lastDay && !day.includes('NaN')) { rows.push({ kind: 'day', key: day, label: dayLabel(l.at, now) }); lastDay = day; prev = undefined }
    if (l.kind === 'notice') {
      rows.push({ kind: 'notice', seq: l.seq, at: l.at, time: timeOf(l.at), glyph: noticeGlyph(l.event?.type), text: nameYou(screenText(l.event?.type, l.body), moderator) })
      prev = undefined
      continue
    }
    if (opts.firstToMe !== undefined && l.seq === opts.firstToMe) {
      rows.push({ kind: 'unseen', seq: l.seq, label: `novas para você · ${timeOf(l.at)}` })
      prev = undefined
    }
    const mine = l.from.id === 'user' || l.from.role === 'moderator'
    const to: Addressee[] = (l.to ?? []).map(n => {
      if (n === moderator) return { name: 'você', you: true }
      const id = opts.idByName?.get(n)
      return { name: n, you: false, ...(id !== undefined ? { hue: agentHue(id) } : {}) }
    })
    const toKey = to.map(t => t.name).join('\u0000')
    const role = mine ? 'moderator' : l.from.role === 'owner' ? 'owner' : 'member'
    const row: SayRow = {
      kind: 'say', seq: l.seq, at: l.at, time: timeOf(l.at),
      name: mine ? 'Você' : l.from.name,
      ...(mine ? {} : { hue: agentHue(l.from.id) }),
      role: ROLE_TEXT[role],
      crown: !mine && (l.from.role === 'owner' || (opts.ownerId !== undefined && l.from.id === opts.ownerId)),
      mine, to, body: l.body,
      ...(l.replyTo !== undefined ? { replyTo: l.replyTo } : {}),
      authorId: mine ? 'user' : l.from.id,
      continued: prev !== undefined && prev.authorId === (mine ? 'user' : l.from.id) && prev.to.map(t => t.name).join('\u0000') === toKey,
    }
    rows.push(row)
    prev = row
  }
  return rows
}

// ---------- the header and the members ----------

export interface MemberRow {
  id: string
  name: string
  hue: number
  role: 'dono' | 'membro'
  crown: boolean
  muted: boolean
  route: MemberInfo['path']
  /** What the member does right now with what is said: how a line reaches it. */
  state: string
  /** 'on' it hears, 'wait' it will hear later, 'off' its process does not run. */
  tone: 'on' | 'wait' | 'off'
  /** The emblem the person put on this member's tab, when it wears one. */
  emblem?: PaneEmblem
}

const ROUTE_TEXT: Record<MemberInfo['path'], { state: string; tone: MemberRow['tone'] }> = {
  inside: { state: 'ouvindo', tone: 'on' },
  terminal: { state: 'ouve pelo terminal', tone: 'on' },
  wait: { state: 'ouve quando a guia ficar livre', tone: 'wait' },
  away: { state: 'parado', tone: 'off' },
}

/** Reads the emblem the person put on the tab of the pane with this id (the agent's slot id): `ui.panes.personEmblem`. */
export type EmblemReader = (id: string) => PaneEmblem | undefined

/** The owner first, then the others in the order the daemon gave. `emblemOf` adds the emblem of each member that wears one. */
export function memberRows(answer: MembersAnswer, emblemOf?: EmblemReader): MemberRow[] {
  const ownerId = answer.channel.owner.kind === 'agent' ? answer.channel.owner.id : undefined
  const rows = answer.members.map((m): MemberRow => {
    const route = ROUTE_TEXT[m.path]
    const emblem = emblemOf?.(m.id)
    return {
      id: m.id, name: m.name, hue: agentHue(m.id), role: m.id === ownerId ? 'dono' : 'membro', crown: m.id === ownerId,
      muted: m.muted, route: m.path, state: route.state, tone: route.tone, ...(emblem ? { emblem } : {}),
    }
  })
  return [...rows.filter(r => r.crown), ...rows.filter(r => !r.crown)]
}

export const membersCount = (n: number): string => (n === 1 ? '1 membro' : `${n} membros`)

export interface Header {
  title: string
  /** "4 membros · dono: Atrium" */
  sub: string
  closed: boolean
  /** The owner's name and hue (the person's own: "Você", no hue). */
  ownerName: string
  ownerHue?: number
  mutedCount: number
}

export function headerOf(answer: MembersAnswer): Header {
  const c = answer.channel
  const owner = c.owner.kind === 'agent' ? { name: c.owner.name, hue: agentHue(c.owner.id) } : { name: 'Você' }
  const mutedCount = answer.members.filter(m => m.muted).length
  const parts = [membersCount(answer.members.length), `dono: ${owner.name}`]
  if (c.closed) parts.push('encerrado')
  return { title: `#${c.name}`, sub: parts.join(' · '), closed: c.closed !== undefined, ownerName: owner.name, ...('hue' in owner ? { ownerHue: owner.hue } : {}), mutedCount }
}

/** name → id of the members (the hue of the names a line addresses). */
export const idByName = (answer: MembersAnswer): Map<string, string> => new Map(answer.members.map(m => [m.name, m.id]))

/** The "calado" bar under the conversation: who is muted. Empty when nobody is. */
export function muteBar(answer: MembersAnswer): string {
  const names = answer.members.filter(m => m.muted).map(m => m.name)
  if (names.length === 0) return ''
  return `${names.length === 1 ? '1 calado' : `${names.length} calados`} neste canal: ${names.join(', ')}. Ouve tudo e não fala.`
}

// ---------- scroll ----------

/** Whether the pane is reading the end of the conversation: a new line then scrolls into view; otherwise it only counts. */
export const isNearBottom = (scrollTop: number, clientHeight: number, scrollHeight: number, slack = BOTTOM_SLACK_PX): boolean =>
  scrollHeight - (scrollTop + clientHeight) <= slack

export const unreadLabel = (n: number): string => (n === 1 ? '1 fala nova' : `${n} falas novas`)

/** The bar for the lines addressed to the person (the only orange of the channels, P1). */
export const forYouLabel = (n: number): string => (n === 1 ? '1 nova para você' : `${n} novas para você`)

// ---------- the top bar icon (U3) ----------

export type StatusLook = 'idle' | 'normal' | 'warn'

/** What the marks hold of a channel (marks.ts), as far as the popover needs. */
export interface MarksOf { unread: number; toMe: number }

/** Grey with nothing, normal with unread lines, amber (`warn`) only for a line addressed to her. */
export const stateOf = (t: MarksOf): StatusLook => (t.toMe > 0 ? 'warn' : t.unread > 0 ? 'normal' : 'idle')

export const titleOf = (t: MarksOf): string =>
  t.toMe > 0 ? `Canais: ${t.toMe === 1 ? '1 fala' : `${t.toMe} falas`} para você` : t.unread > 0 ? `Canais: ${unreadLabel(t.unread)}` : 'Canais'

export interface PopRow { id: string; name: string; members: string; unread: number; toMe: number; text: string }

/** The popover's rows: the open channels, the ones with a line for her first, then the most unread, then by name. */
export function popRows(list: readonly ChannelSummary[], marksOf: (id: string) => MarksOf): PopRow[] {
  return list.filter(c => !c.closed).map((c): PopRow => {
    const m = marksOf(c.id)
    const plain = m.unread - m.toMe
    const text = m.toMe > 0 ? (m.toMe === 1 ? 'para você' : `${m.toMe} para você`) : plain > 0 ? unreadLabel(plain) : ''
    return { id: c.id, name: c.name, members: membersCount(c.members), unread: m.unread, toMe: m.toMe, text }
  }).sort((a, b) => (b.toMe > 0 ? 1 : 0) - (a.toMe > 0 ? 1 : 0) || b.unread - a.unread || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}
