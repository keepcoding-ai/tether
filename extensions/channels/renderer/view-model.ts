// What the channel's pane shows, as pure functions (no DOM, no daemon): the history becomes rows, a say and a system notice are
// drawn apart, the members come with the state of each, and the page of the history merges into what is held. The pane only
// paints these. Words on the screen are Portuguese (P12: dono, membro, moderador, calado); the code says owner, member, moderator,
// muted. Nothing here is orange: the "to me" mark is the U3's.
import { agentHue } from '../../../app/shared/agent-color.ts'
import { tabUrl } from '../../../app/shared/tether-url.ts'
import type { PaneEmblem } from '../../../app/renderer/ext-api.ts'
import { kindOf, KIND_LABEL, sizeLabel, type FileKind } from '../attachments.ts'
import type { Line, LineEventType, LineFile } from '../rules.ts'
import type { ChannelSummary, MemberInfo, MessageReactions, PollState } from '../daemon/requests.ts'

/** The answer of the `history` request. `polls`: the state of each poll line of the page (open, or its result). */
export interface HistoryPage { channel: ChannelSummary; lines: Line[]; reactions?: MessageReactions[]; polls?: PollState[]; more: boolean; last: number }
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

/**
 * The `before` of the next older page, or undefined when there is none. `floor`: the lowest `seq` the pages asked so far cover.
 * A page made only of reactions brings no line, so the first held line would not move and the same page would be asked again:
 * the floor is what advances (the page of `before` N covers N-PAGE..N-1).
 */
export function olderCursor(t: Timeline, floor?: number): number | undefined {
  if (!t.more) return undefined
  const first = t.lines[0]?.seq
  if (floor === undefined) return first
  return first === undefined ? floor : Math.min(first, floor)
}

/**
 * A new line from the `line` event. `gap`: the pane missed some (its `seq` is not the next one), so it asks the newest page again.
 * A line already held (or older than what is) changes nothing.
 */
export function applyLine(t: Timeline, line: Line, quiet?: ReadonlySet<number>): { timeline: Timeline; added: boolean; gap: boolean } {
  if (line.seq <= t.last) return { timeline: t, added: false, gap: false }
  // `quiet`: the `seq`s of reactions heard live (they take a number but are no line of the conversation): not a hole.
  let next = t.last + 1
  while (quiet?.has(next)) next++
  const gap = t.last > 0 && line.seq !== next
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

/** The tag shown beside a speaker: only what departs from the default ("dono"); an agent's "membro" and the person's "moderador" are empty. */
export type SpeakerRole = 'dono' | ''
const ROLE_TEXT: Record<'owner' | 'member' | 'moderator', SpeakerRole> = { owner: 'dono', member: '', moderator: '' }

export interface Addressee { name: string; hue?: number; you: boolean }

/** A file of a speech as the conversation draws it: its kind decides a thumbnail (image) or a card; `label` is "PDF · 2,3 MB". */
export interface ViewFile { name: string; path: string; size: number; kind: FileKind; label: string }

export function viewFile(f: LineFile): ViewFile {
  const kind = kindOf(f.name)
  return { name: f.name, path: f.path, size: f.size, kind, label: `${KIND_LABEL[kind]} · ${sizeLabel(f.size)}` }
}

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
  /** The speech's files, in order: images are thumbnails, the others cards (the pane draws them). */
  files?: ViewFile[]
  /** Said from a device ("de longe"). */
  afar?: true
  /** The id of the author ('user' for the person). */
  authorId: string
  /** The same author, to the same people, right after: no header. */
  continued: boolean
}

export interface NoticeRow { kind: 'notice'; seq: number; at: string; time: string; glyph: NoticeGlyph; text: string }
export interface DayRow { kind: 'day'; key: string; label: string }
/** "novas para você · 14:05": drawn right before the first unseen line addressed to the person (the orange line of the conversation). */
export interface UnseenRow { kind: 'unseen'; seq: number; label: string }
/** A poll in the conversation: who opened it (drawn like a speech's header) and the question; the card is drawn from its state. */
export interface PollRow {
  kind: 'poll'
  seq: number
  at: string
  time: string
  name: string
  hue?: number
  role: SpeakerRole
  crown: boolean
  mine: boolean
  authorId: string
  question: string
  /** Opened from a device ("de longe"). */
  afar?: true
}
export type Row = SayRow | PollRow | NoticeRow | DayRow | UnseenRow

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
    if (l.kind === 'poll' && l.poll) {
      rows.push({
        kind: 'poll', seq: l.seq, at: l.at, time: timeOf(l.at), name: mine ? 'Você' : l.from.name, ...(mine ? {} : { hue: agentHue(l.from.id) }),
        role: ROLE_TEXT[mine ? 'moderator' : l.from.role === 'owner' ? 'owner' : 'member'],
        crown: !mine && (l.from.role === 'owner' || (opts.ownerId !== undefined && l.from.id === opts.ownerId)),
        mine, authorId: mine ? 'user' : l.from.id, question: l.poll.question,
        ...(l.afar ? { afar: true as const } : {}),
      })
      prev = undefined
      continue
    }
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
      ...(l.files?.length ? { files: l.files.map(viewFile) } : {}),
      ...(l.afar ? { afar: true as const } : {}),
      authorId: mine ? 'user' : l.from.id,
      continued: prev !== undefined && prev.afar === (l.afar ? true : undefined) && prev.authorId === (mine ? 'user' : l.from.id) && prev.to.map(t => t.name).join('\u0000') === toKey,
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
  role: 'dono' | ''
  crown: boolean
  muted: boolean
  route: MemberInfo['path']
  /** What the member does right now with what is said: how a line reaches it. */
  state: string
  /** 'on' it hears, 'wait' it will hear later, 'off' its process does not run. */
  tone: 'on' | 'wait' | 'off'
  /** What the state means in full, for the tooltip (only where the short text leaves a question). */
  hint?: string
  /** It came into the channel by the desk. */
  fromDesk: boolean
  /** The emblem the person put on this member's tab, when it wears one. */
  emblem?: PaneEmblem
  /** A live agent no pane shows: there is no tab to go to, only the peek card. */
  noDesk: boolean
}

/** Why a member on the `wait` route does not hear now (the row's tooltip). */
export const WAIT_HINT = 'A guia deste agente está com você e ele não recebe falas por dentro. As falas ficam na fila até a guia ser dada a um agente.'
/**
 * The same, for a member with no pane. `wait` means no stream inside and no agent holding a live pane: the lines queue and reach it
 * together in one notice once it can hear. (A member that hears inside shows no hint.)
 */
export const NO_DESK_WAIT_HINT = 'Este agente está sem mesa e não ouve por dentro: as falas ficam em espera e chegam juntas quando ele puder ouvir.'

const ROUTE_TEXT: Record<MemberInfo['path'], { state: string; tone: MemberRow['tone']; hint?: string }> = {
  inside: { state: 'ouvindo', tone: 'on' },
  terminal: { state: 'ouve pelo terminal', tone: 'on' },
  wait: { state: 'não ouve agora · falas em espera', tone: 'wait', hint: WAIT_HINT },
  away: { state: 'parado', tone: 'off' },
}

/** Reads the emblem the person put on the tab of the pane with this id (the agent's slot id): `ui.panes.personEmblem`. */
export type EmblemReader = (id: string) => PaneEmblem | undefined

/** Whether the agent with this id is a live session no pane shows (`ui.agents.get(id)?.placed === false`). */
export type NoDeskReader = (id: string) => boolean

/** The owner first, then the others in the order the daemon gave. `emblemOf` adds the emblem of each member that wears one. */
export function memberRows(answer: MembersAnswer, emblemOf?: EmblemReader, noDeskOf?: NoDeskReader): MemberRow[] {
  const ownerId = answer.channel.owner.kind === 'agent' ? answer.channel.owner.id : undefined
  const rows = answer.members.map((m): MemberRow => {
    const route = ROUTE_TEXT[m.path]
    const emblem = emblemOf?.(m.id)
    const noDesk = noDeskOf?.(m.id) === true
    const hint = m.path === 'wait' && noDesk ? NO_DESK_WAIT_HINT : route.hint
    return {
      id: m.id, name: m.name, hue: agentHue(m.id), role: m.id === ownerId ? 'dono' : '', crown: m.id === ownerId,
      muted: m.muted, route: m.path, state: route.state, tone: route.tone, ...(hint !== undefined ? { hint } : {}),
      fromDesk: m.by === 'desk', ...(emblem ? { emblem } : {}), noDesk,
    }
  })
  return [...rows.filter(r => r.crown), ...rows.filter(r => !r.crown)]
}

/** The whole sentence of a member's row for a screen reader: who, the role, "calado" when muted, how it hears ("claude · conferente, membro, calado, ouvindo"). */
export function memberAria(m: Pick<MemberRow, 'name' | 'role' | 'muted' | 'state'>): string {
  return [m.name, ...(m.role ? [m.role] : []), ...(m.muted ? ['calado'] : []), m.state].join(', ')
}

/** The person's own row in the list. */
export const MODERATOR_ARIA = 'Você lê tudo e fala em qualquer canal'

export const membersCount = (n: number): string => (n === 1 ? '1 membro' : `${n} membros`)

/**
 * The tether://tab link of an agent's pane (a member's id is its pane's id). The person ("user") and the tether's own lines have no
 * pane: no link, so no clickable name.
 */
export function agentLinkOf(id: string | undefined): string | undefined {
  return id === undefined || id === '' || id === 'user' || id === 'tether' ? undefined : tabUrl(id)
}

export interface Header {
  /** The owner agent's id (its pane id); absent when the person owns the channel. */
  ownerId?: string
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
  return { title: `#${c.name}`, sub: parts.join(' · '), closed: c.closed !== undefined, ownerName: owner.name, ...(c.owner.kind === 'agent' ? { ownerId: c.owner.id } : {}), ...('hue' in owner ? { ownerHue: owner.hue } : {}), mutedCount }
}

/** How many emblems the folded strip of the narrow composition stacks (the rest is in the count). */
export const FOLD_MARKS = 4

export interface FoldMark { id: string; hue: number; crown: boolean }

/** What the narrow strip says of the members while folded: who (the first emblems), how many, how many muted, how many do not hear now. */
export interface Fold {
  count: number
  muted: number
  /** Members that do not hear now (the `wait` route): the strip keeps a warning on them even folded. */
  waiting: number
  marks: FoldMark[]
  /** "3 membros" */
  label: string
}

export function foldOf(answer: MembersAnswer): Fold {
  const rows = memberRows(answer)
  return {
    count: rows.length,
    muted: rows.filter(r => r.muted).length,
    waiting: rows.filter(r => r.tone === 'wait').length,
    marks: rows.slice(0, FOLD_MARKS).map(r => ({ id: r.id, hue: r.hue, crown: r.crown })),
    label: membersCount(rows.length),
  }
}

/** The accessible name of the strip's button: the numbers, then what it does. */
export function foldAria(f: Fold, open: boolean): string {
  const parts = [f.label]
  if (f.muted > 0) parts.push(f.muted === 1 ? '1 calado' : `${f.muted} calados`)
  if (f.waiting > 0) parts.push(f.waiting === 1 ? '1 não ouve agora' : `${f.waiting} não ouvem agora`)
  return `${parts.join(', ')}. ${open ? 'Recolher membros' : 'Mostrar membros'}`
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

// ---------- what the person really sees (the "seen" rule) ----------
// A row is seen only when it is in the conversation's view AND nothing of the tether covers it: the docked quick view, a modal,
// a menu over the conversation. The pane asks the page what is on top at a few points of the row (elementFromPoint), these
// rules decide from the answers.

export interface Box { left: number; top: number; width: number; height: number }

/** Where to ask what is on top of a row: three points across its middle line, inside the part of it in the view. None: out of view. */
export function seenProbes(row: Box, view: Box): { x: number; y: number }[] {
  const top = Math.max(row.top, view.top)
  const bottom = Math.min(row.top + row.height, view.top + view.height)
  const left = Math.max(row.left, view.left)
  const right = Math.min(row.left + row.width, view.left + view.width)
  if (bottom - top < 1 || right - left < 1) return []
  const y = (top + bottom) / 2
  return [1 / 6, 1 / 2, 5 / 6].map(f => ({ x: left + (right - left) * f, y }))
}

/** A row is shown when most of its probes find the conversation itself on top (`hits`: one per probe). */
export const rowShown = (hits: readonly boolean[]): boolean => hits.length > 0 && hits.filter(Boolean).length * 2 > hits.length

/**
 * At the end of the conversation, how far it is seen: up to `last`, unless a row newer than `seen` that is in the view is
 * covered; then only up to the line before the first such row (the rows below it wait until the cover goes). Rows above the
 * view, scrolled away at the end, count as read, as always. `rows`: the rows in the view newer than `seen`, any order.
 */
export function seenUpTo(last: number, seen: number, rows: readonly { seq: number; shown: boolean }[]): number {
  let upTo = last
  for (const r of rows) if (r.seq > seen && !r.shown && r.seq - 1 < upTo) upTo = r.seq - 1
  return upTo
}

/** The bar for the lines addressed to the person (the only orange of the channels, P1). */
/** The bar and the tab's tooltip for reactions of agents that ask the person (❓ doubt, ❌ disagree) on her speeches. */
export const asksLabel = (n: number): string => (n === 1 ? '1 reação pede você' : `${n} reações pedem você`)
/** Open polls that call the person and wait for her vote. */
export const owedLabel = (n: number): string => (n === 1 ? '1 enquete espera o seu voto' : `${n} enquetes esperam o seu voto`)
/** The bar and the tab's tooltip for what asks her besides a line: reactions and polls in one text (each part only when there is one). */
export const waitsLabel = (asks: number, owed: number): string => [asks > 0 ? asksLabel(asks) : '', owed > 0 ? owedLabel(owed) : ''].filter(Boolean).join(' · ')
export const forYouLabel =(n: number): string => (n === 1 ? '1 nova para você' : `${n} novas para você`)

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
    const plain = Math.max(0, m.unread - m.toMe)
    const text = m.toMe > 0 ? (m.toMe === 1 ? 'para você' : `${m.toMe} para você`) : plain > 0 ? unreadLabel(plain) : ''
    return { id: c.id, name: c.name, members: membersCount(c.members), unread: m.unread, toMe: m.toMe, text }
  }).sort((a, b) => (b.toMe > 0 ? 1 : 0) - (a.toMe > 0 ? 1 : 0) || b.unread - a.unread || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}
