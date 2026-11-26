// The pure rules of channels: rooms where agents of any engine and the person talk. Read by both hosts: the daemon decides
// from them (the verbs, the moderator's requests, the desk channel following its desk), the renderer draws from them. This is
// the only place the roles are written. No imports at all: a module both the daemon (Node) and the renderer (the bundle) load
// without pulling anything of one into the other, and nothing runs at load beyond declarations.
//
// Roles are derived, never stored. The moderator is the person, always, in every channel: never in `members`, never muted,
// never removed. The owner commands the channel (join, remove, mute, close, reopen) and speaks as a member. An agent owner
// whose pane is forgotten, who leaves or who is removed gives the channel up for good (`ownerEnded`): coming back, it is only
// a member, and the channel falls to the person, the moderator then being its only owner. A desk channel follows its desk.

/** Who is a member or an owner: the slotId of the PANE the agent runs in, never its session. */
export type AgentId = string

/** The channel's stable id: 'c_<base36>' for a created channel, 'desk_<deskId>' for the desk channel (one per desk, forever). */
export type ChannelId = string

/** Who acts: the person (as moderator or as a user owner) or an agent's pane. */
export type Who = 'user' | AgentId

/** The person's id wherever a `Who` is written. It never collides with a slotId (8 hex digits). */
export const USER = 'user'

/** The longest room name. */
export const ROOM_NAME_MAX = 40

/** The prefix of a desk channel's id. The NAME of a desk channel has no prefix: it is the slug of the desk's name. */
export const DESK_CHANNEL_PREFIX = 'desk_'

export type ChannelOwner = { kind: 'user' } | { kind: 'agent'; id: AgentId; name: string }

export interface Channel {
  id: ChannelId
  /** The room: what goes in `room` and what the verbs accept. isRoomName; unique among the open channels. Fixed at birth, but a desk channel reopening while an open channel took its name gets a suffix (slugOf). */
  name: string
  /** What the channel's pane shows. A desk channel's follows the desk's name. */
  title: string
  /** Who created it and commands it: the person, or an agent's pane. On a desk channel, the desk's owner. */
  owner: ChannelOwner
  /**
   * The agent owner gave the channel up for good: its pane was forgotten, it left, or it was removed (endsOwnership). The
   * channel goes on and only the moderator has the owner's power in it; the agent, joined again, is a member. Cleared only
   * when a desk channel gets a new owner from its desk.
   */
  ownerEnded?: { at: string; name: string; why: 'forgotten' | 'left' | 'removed' }
  /** Only on a desk channel: the desk's id in the layout. This, not the name, is what makes it the desk's. */
  desk?: string
  createdAt: string
  createdBy: Who
  /** Closed: nobody speaks; the history stays readable and the owner or the moderator may reopen it (a desk channel only follows its desk). */
  closed?: { at: string; by: Who }
  members: Record<AgentId, Member>
  /**
   * Agents the owner or the moderator removed: they do not join themselves again, and the desk does not bring them back. They
   * leave the list when the owner or the moderator joins them again, and, on a desk channel, when the pane leaves the desk.
   */
  removed?: AgentId[]
  /** The last `seq` the person saw (the channel's pane visible): what she has not read is counted from here. */
  seenByUser: number
  /**
   * The open polls by their seq (a JSON key), with the current vote of each one called. At most POLLS_OPEN_PER_CHANNEL, so
   * the votes kept are at most that many times the members. A closed poll leaves this map; the record keeps every line.
   */
  polls?: Record<string, OpenPoll>
  /** The last POLLS_CLOSED_KEPT polls closed and the seq of each one's result line (read finds a result without a scan). */
  pollsClosed?: Array<{ poll: number; line: number }>
}

export interface Member {
  since: string
  /** Who joined it: the person, the agent itself, the desk (desk channel), or an agent (the owner). */
  by: 'user' | 'self' | 'desk' | AgentId
  /** The pane's name when it joined (the label the history keeps if the pane is forgotten). */
  name: string
  /** Muted: still hears, no longer speaks. */
  muted?: { since: string; by: Who }
  /** The seq of the newest line whose reactions already rode to it (reactionRide); absent: none yet. */
  reactionsSeen?: number
}

/** A role in a channel. The envelope carries 'member' for an owner who speaks (deliveryRoleOf). */
export type ChannelRole = 'owner' | 'member' | 'moderator'

export type LineEventType = 'create' | 'join' | 'leave' | 'remove' | 'mute' | 'unmute' | 'close' | 'reopen' | 'owner-ended' | 'owner-changed' | 'poll-close'

/** One line of a channel's record (<home>/channels/<channelId>/NNNNNN.jsonl, 500 lines per file). */
export interface Line {
  /** 1, 2, 3… per channel; the envelope's `ref` is `<name>#<seq>`. */
  seq: number
  at: string
  /**
   * A `reaction` is a light signal on a message (`react`): it takes a seq, is never delivered and opens no turn in anyone. A
   * `poll` opens a poll (`poll` says what), a `vote` is one called's vote on it (the latest one counts); the poll's close is a
   * `notice` with `event.type: 'poll-close'` and `result`. None of the three is a line of the conversation (isPollLine).
   */
  kind: 'message' | 'notice' | 'reaction' | 'poll' | 'vote'
  /** Who spoke, with the role IN THE CHANNEL. */
  from: { id: AgentId | 'user' | 'tether'; name: string; role: ChannelRole | 'system' }
  body: string
  /** Whom the line addresses: names of members and/or the moderator's name. */
  to?: string[]
  replyTo?: number
  /** Only on a notice: the gesture, so the pane draws it without reading the text. */
  event?: { type: LineEventType; who?: AgentId; by?: Who }
  /** Only on a reaction: the message it is on and the gesture (put or take away). `body` is ''. */
  react?: { seq: number; emoji: string; op: 'add' | 'remove' }
  /** Only on a poll: written by the tether from the verb's arguments, never from a body. `body` is ''. */
  poll?: PollSpec
  /** Only on a vote: the poll's seq and the option's number (1-based). `body` is ''. */
  vote?: PollVote
  /** Only on a poll's close notice (`event.type: 'poll-close'`): the result. */
  result?: PollResult
  /** Only on a message: its files, copied into the channel's folder (attachments.ts); `body` may then be ''. */
  files?: LineFile[]
}

/** One file of a speech, as the line keeps it: the name shown, its absolute path in the channel's folder, its size and type. */
export interface LineFile { name: string; path: string; size: number; type: string }

// ---- polls --------------------------------------------------------------------------------------

/** `ok` (the default: 1 ok, 2 não ok) or a single choice among 2 to 6 options the author writes. */
export type PollType = 'ok' | 'choice'
/** The options of an `ok` poll, in order. */
export const OK_OPTIONS: readonly string[] = ['ok', 'não ok']
export const POLL_QUESTION_MAX = 300
export const POLL_OPTIONS_MIN = 2
export const POLL_OPTIONS_MAX = 6
export const POLL_OPTION_MAX = 60
/** A vote's reason: optional, one line. */
export const POLL_REASON_MAX = 140
export const POLL_TIMEOUT_MIN_MS = 60_000
export const POLL_TIMEOUT_MAX_MS = 24 * 3_600_000
export const POLL_TIMEOUT_DEFAULT_MS = 10 * 60_000
/** Open polls one channel may have at once (`limit`). */
export const POLLS_OPEN_PER_CHANNEL = 3
/** Open polls one author may have in one channel at once (`limit`). */
export const POLLS_OPEN_PER_AUTHOR = 1
/** Polls one member may open per hour in one channel (`slow-down`). */
export const POLL_OPENS_PER_HOUR = 5
/** Times one called may change its vote on one poll (`slow-down`); the first vote is not a change. */
export const POLL_VOTE_CHANGES = 5
/** Closed polls whose result line the index points at. */
export const POLLS_CLOSED_KEPT = 50

export interface PollPerson { id: Who; name: string }

/** What a poll line carries. */
export interface PollSpec {
  type: PollType
  question: string
  options: string[]
  /** Who is called to vote: the agent members but the author by default; the person only when named. */
  to: PollPerson[]
  /** The deadline, an absolute time (ISO): a restart never resets it. */
  closesAt: string
}

export interface PollVote { poll: number; option: number; reason?: string }

/** Why a poll closed: every one still called voted, the deadline passed, its author (or the person) closed it, the channel closed. */
export type PollClosedBy = 'all-voted' | 'timeout' | 'author' | 'channel-closed'
/**
 * Why one called has no vote: it did not answer, its process does not run, its desk sleeps, the person has its pane (the
 * request waited in the queue), or it is no longer in the channel.
 */
export type PollMissingWhy = 'no-answer' | 'stopped' | 'asleep' | 'with-user' | 'left'

export interface PollTally { option: number; text: string; voters: Array<PollPerson & { reason?: string }> }

export interface PollResult {
  poll: number
  by: PollClosedBy
  /** Who closed it, when `by` is 'author' (the author or the person). */
  closer?: PollPerson
  /** The deadline passed while the tether was down: it closed as soon as the tether came back. */
  away?: true
  tally: PollTally[]
  missing: Array<PollPerson & { why: PollMissingWhy }>
}

/** An open poll as the index keeps it. */
export interface OpenPoll extends PollSpec {
  seq: number
  author: PollPerson
  /** The current vote of each one who voted (the latest counts). */
  votes: Record<Who, { option: number; reason?: string; at: string; name: string }>
  /** How many times each one changed its vote. */
  changes?: Record<Who, number>
  /**
   * Each agent called that was handed the request, and the core's receipt of it: asked once, ever (a restart or its process
   * coming back never asks again), and what still waits in the queue is cancelled when the poll closes.
   */
  asked?: Record<Who, string>
}

/** Options as the request carries them: `1 ok | 2 não ok`. */
export function numberedOptions(options: readonly string[], sep = ' | '): string {
  return options.map((o, i) => `${i + 1} ${o}`).join(sep)
}

/** Whether `who` is still owed the request of `p`: called, an agent, no vote, never handed it. */
export function owesRequest(ch: Channel, p: OpenPoll, who: Who): boolean {
  return who !== USER && isCalled(ch, p, who) && !Object.hasOwn(p.votes, who) && !Object.hasOwn(p.asked ?? {}, who)
}

/** A line of a poll (open, vote, close): never a line of the conversation; only the request and the result are delivered. */
export function isPollLine(l: Line): boolean {
  return l.kind === 'poll' || l.kind === 'vote' || (l.kind === 'notice' && l.event?.type === 'poll-close')
}

/** The open polls of a channel, oldest first. */
export function openPolls(ch: Channel): OpenPoll[] {
  return Object.values(ch.polls ?? {}).sort((a, b) => a.seq - b.seq)
}

/** One line of text: every run of whitespace (a line break included) one space, trimmed. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * A deadline as written: minutes as a number, or a text with a unit (`90s`, `10m`, `10min`, `1h`, `2h30m`; a bare number is
 * minutes). The time in ms, or undefined when unreadable or out of 1 min..24 h.
 */
export function parsePollTimeout(value: unknown): number | undefined {
  let ms: number | undefined
  if (typeof value === 'number') ms = value * 60_000
  else if (typeof value === 'string') {
    const t = value.trim().toLowerCase().replace(/\s+/g, '')
    if (/^\d+(?:\.\d+)?$/.test(t)) ms = Number(t) * 60_000
    else {
      const m = /^(?:(\d+)h)?(?:(\d+)(?:m|min))?(?:(\d+)s)?$/.exec(t)
      if (m && t !== '') ms = (Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)) * 1000
    }
  }
  if (ms === undefined || !Number.isFinite(ms) || ms < POLL_TIMEOUT_MIN_MS || ms > POLL_TIMEOUT_MAX_MS) return undefined
  return Math.round(ms)
}

/** Lower case, no accents, one line: how an option is compared with what a voter wrote. */
const foldText = (s: string): string => oneLine(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

/**
 * The options of a new poll: none given is the `ok` poll; given, 2 to 6 distinct ones of up to 60 characters (one line each).
 * The refusal otherwise: `bad-request` (count, empty, repeated) or `too-long`.
 */
export function pollOptions(options?: readonly string[]): { type: PollType; options: string[] } | 'bad-request' | 'too-long' {
  if (options === undefined || options.length === 0) return { type: 'ok', options: [...OK_OPTIONS] }
  const clean = options.map((o) => (typeof o === 'string' ? oneLine(o) : ''))
  if (clean.length < POLL_OPTIONS_MIN || clean.length > POLL_OPTIONS_MAX || clean.some((o) => o === '')) return 'bad-request'
  if (clean.some((o) => o.length > POLL_OPTION_MAX)) return 'too-long'
  if (new Set(clean.map(foldText)).size !== clean.length) return 'bad-request'
  return { type: 'choice', options: clean }
}

/** The option a voter means (1-based): its number, or its text (any case, accents or not). Undefined: `bad-option`. */
export function parseVoteOption(options: readonly string[], vote: unknown): number | undefined {
  if (typeof vote === 'number') return Number.isInteger(vote) && vote >= 1 && vote <= options.length ? vote : undefined
  if (typeof vote !== 'string') return undefined
  const t = vote.trim()
  if (/^\d+$/.test(t)) return parseVoteOption(options, Number(t))
  const i = options.findIndex((o) => foldText(o) === foldText(t))
  return i >= 0 ? i + 1 : undefined
}

/** Whether `p` calls `who`: named in `to`, and still in the channel (the person always is). The author is never called. */
export function isCalled(ch: Channel, p: OpenPoll, who: Who): boolean {
  // An agent author is never called; the person who opens a poll may include herself ("incluir você") and then votes by the card.
  if ((who === p.author.id && who !== USER) || !p.to.some((t) => t.id === who)) return false
  return who === USER || isMember(ch, who)
}

/** Those `p` still calls: who left the channel no longer counts. */
export function stillCalled(ch: Channel, p: OpenPoll): PollPerson[] {
  return p.to.filter((t) => isCalled(ch, p, t.id))
}

/** Every one still called voted (a poll whose called all left counts as voted too). */
export function allVoted(ch: Channel, p: OpenPoll): boolean {
  return stillCalled(ch, p).every((t) => Object.hasOwn(p.votes, t.id))
}

/** The open polls of the channel that call `who` and do not have its vote yet. */
export function owedPolls(ch: Channel, who: Who): OpenPoll[] {
  return openPolls(ch).filter((p) => isCalled(ch, p, who) && !Object.hasOwn(p.votes, who))
}

/**
 * Why `who` may not open a poll in the channel now, or undefined when it may. The person opens in every open channel; an agent
 * speaks (a member not muted). Who owes a vote in the channel votes first. `opensLastHour`: how many `who` opened there in the
 * last hour.
 */
export function pollOpenRefusal(who: Who, ch: Channel, opensLastHour: number): 'closed' | 'not-member' | 'muted' | 'vote-first' | 'limit' | 'slow-down' | undefined {
  const say = sayRefusal(who, ch)
  if (say) return say
  if (owedPolls(ch, who).length) return 'vote-first'
  const open = openPolls(ch)
  if (open.length >= POLLS_OPEN_PER_CHANNEL || open.filter((p) => p.author.id === who).length >= POLLS_OPEN_PER_AUTHOR) return 'limit'
  if (opensLastHour >= POLL_OPENS_PER_HOUR) return 'slow-down'
  return undefined
}

/** Who may close a poll before its time: its author, or the person. */
export function mayClosePoll(who: Who, p: OpenPoll): boolean {
  return isModerator(who) || p.author.id === who
}

/** The votes of `p` per option, in the options' order; each voter with its reason. */
export function pollTally(p: Pick<OpenPoll, 'options' | 'votes'>): PollTally[] {
  const out: PollTally[] = p.options.map((text, i) => ({ option: i + 1, text, voters: [] }))
  for (const [id, v] of Object.entries(p.votes)) {
    const cell = out[v.option - 1]
    if (cell) cell.voters.push({ id, name: v.name, ...(v.reason ? { reason: v.reason } : {}) })
  }
  return out
}

/** `ok 3 · não ok 1`: every option and its count, zeros too. */
export function tallyText(tally: readonly PollTally[]): string {
  return tally.map((t) => `${t.text} ${t.voters.length}`).join(' · ')
}

/** `ok 3: nic, Guga · não ok 1: bancada ("a ata…")`: the options with votes, each with its voters and their reasons. */
export function votersText(tally: readonly PollTally[]): string {
  return tally.filter((t) => t.voters.length).map((t) => `${t.text} ${t.voters.length}: ${t.voters.map((v) => `${v.name}${v.reason ? ` (${JSON.stringify(v.reason)})` : ''}`).join(', ')}`).join(' · ')
}

export const MISSING_TEXT: Record<PollMissingWhy, string> = {
  'no-answer': 'não respondeu', stopped: 'parado', asleep: 'mesa hibernando', 'with-user': 'com a pessoa', left: 'saiu do canal',
}

/** `sem resposta 2: bancada (parado), nic (não respondeu)`, '' when nobody is missing. */
export function missingText(missing: PollResult['missing']): string {
  return missing.length ? `sem resposta ${missing.length}: ${missing.map((m) => `${m.name} (${MISSING_TEXT[m.why]})`).join(', ')}` : ''
}

/** Why it closed, in the words of the record: `todos votaram`, `o prazo venceu`, `encerrada por Guga`, `o canal foi encerrado`. */
export function closedByText(r: Pick<PollResult, 'by' | 'closer' | 'away'>): string {
  switch (r.by) {
    case 'all-voted': return 'todos votaram'
    case 'timeout': return r.away ? 'o prazo venceu enquanto o tether estava fora' : 'o prazo venceu'
    case 'author': return `encerrada por ${r.closer?.name ?? 'o autor'}`
    case 'channel-closed': return 'o canal foi encerrado'
  }
}

/**
 * The result of `p` closing now. `whyOf` says why one called has no vote (the caller knows who runs); who left the channel is
 * `left` without asking.
 */
export function pollResult(ch: Channel, p: OpenPoll, how: Pick<PollResult, 'by' | 'closer' | 'away'>, whyOf: (id: Who) => PollMissingWhy): PollResult {
  const missing = p.to.filter((t) => t.id !== p.author.id && !Object.hasOwn(p.votes, t.id))
    .map((t) => ({ id: t.id, name: t.name, why: isCalled(ch, p, t.id) ? whyOf(t.id) : 'left' as const }))
  return { poll: p.seq, by: how.by, ...(how.closer ? { closer: how.closer } : {}), ...(how.away ? { away: true as const } : {}), tally: pollTally(p), missing }
}

/** The close notice's body: `Enquete obra#57 fechou: todos votaram.` and the voters line, and who has no vote. */
export function pollResultText(room: string, r: PollResult): string {
  const rest = [votersText(r.tally) || 'nenhum voto', missingText(r.missing)].filter(Boolean).join(' · ')
  return `Enquete ${room}#${r.poll} fechou: ${closedByText(r)}.\n${rest}`
}

/** The nearest deadline among the open polls of every channel (ms since the epoch), undefined when none is open. */
export function nextPollDeadline(channels: Iterable<Channel>): number | undefined {
  let at: number | undefined
  for (const ch of channels) for (const p of Object.values(ch.polls ?? {})) {
    const t = Date.parse(p.closesAt)
    if (Number.isFinite(t) && (at === undefined || t < at)) at = t
  }
  return at
}

// ---- reactions ----------------------------------------------------------------------------------

/** A reaction reaches only a message among the last this-many lines of the channel; older ones answer `too-old`. */
export const REACTION_WINDOW = 500
/** Different emojis one member may have on one message. */
export const REACTIONS_PER_MEMBER = 3
/** Different emojis one message may carry (the 13th answers `limit`). */
export const REACTIONS_PER_LINE = 12
/** Reactions (puts and takes) one member may give per minute in one channel (`slow-down`). */
export const REACTIONS_PER_MINUTE = 10

/** The five agreed meanings: the name the agent writes, the emoji it stands for. */
export const REACTION_SENSES: ReadonlyArray<{ name: string; emoji: string }> = [
  { name: 'seen', emoji: '👀' },
  { name: 'agree', emoji: '👍' },
  { name: 'done', emoji: '✅' },
  { name: 'disagree', emoji: '❌' },
  { name: 'question', emoji: '❓' },
]

export interface Reaction {
  emoji: string
  /** The agreed meaning's name, when the emoji is one of the five. */
  name?: string
}

/** Two spellings of one emoji (with or without the emoji-presentation selector) are the same reaction. */
export function reactionKey(emoji: string): string {
  return emoji.replace(/️/g, '')
}

const MOD = '(?:\\uFE0F|[\\u{1F3FB}-\\u{1F3FF}]|[\\u{E0020}-\\u{E007F}])*'
const EMOJI_RE = new RegExp(`^(?:[#*0-9]\\uFE0F?\\u20E3|\\p{Regional_Indicator}{2}|\\p{Extended_Pictographic}${MOD}(?:\\u200D\\p{Extended_Pictographic}${MOD})*)$`, 'u')

/**
 * What an agent wrote as a reaction: the name of one of the five (any case) or ONE emoji (a grapheme: skin tone, flag, family
 * and keycap count as one). Anything else, text included, is undefined (`bad-reaction`).
 */
export function parseReaction(text: unknown): Reaction | undefined {
  if (typeof text !== 'string') return undefined
  const t = text.trim()
  if (t === '' || t.length > 40) return undefined
  const named = REACTION_SENSES.find((s) => s.name === t.toLowerCase())
  if (named) return { emoji: named.emoji, name: named.name }
  const parts = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(t)]
  if (parts.length !== 1 || !EMOJI_RE.test(t)) return undefined
  const sense = REACTION_SENSES.find((s) => reactionKey(s.emoji) === reactionKey(t))
  return sense ? { emoji: sense.emoji, name: sense.name } : { emoji: t }
}

/** Why `who` may not react in the channel, or undefined when it may. The person reacts in every open channel; a muted member only with the five. */
export function reactRefusal(who: Who, ch: Channel, reaction?: Reaction): 'closed' | 'not-member' | 'muted' | undefined {
  if (ch.closed) return 'closed'
  if (isModerator(who)) return undefined
  if (!isMember(ch, who)) return 'not-member'
  if (reaction && reaction.name === undefined && isMuted(ch, who)) return 'muted'
  return undefined
}

/** One emoji on one message and who gave it, in the order they came. */
export interface ReactionTally {
  emoji: string
  name?: string
  by: Array<{ id: Who; name: string }>
}

/**
 * The reactions per message: the reaction lines of `lines` (ascending) summed in order. A repeated `add` and a `remove`
 * without `add` change nothing; one reaction per member per emoji. Lines of other kinds are ignored.
 */
export function sumReactions(lines: readonly Line[]): Map<number, ReactionTally[]> {
  const work = new Map<number, Map<string, { emoji: string; by: Map<Who, string> }>>()
  for (const l of lines) {
    if (l.kind !== 'reaction' || !l.react) continue
    const key = reactionKey(l.react.emoji)
    let per = work.get(l.react.seq)
    if (!per) work.set(l.react.seq, (per = new Map()))
    let cell = per.get(key)
    if (l.react.op === 'add') {
      if (!cell) per.set(key, (cell = { emoji: l.react.emoji, by: new Map() }))
      if (!cell.by.has(l.from.id as Who)) cell.by.set(l.from.id as Who, l.from.name)
    } else if (cell) {
      cell.by.delete(l.from.id as Who)
      if (cell.by.size === 0) per.delete(key)
    }
    if (per.size === 0) work.delete(l.react.seq)
  }
  const out = new Map<number, ReactionTally[]>()
  for (const [seq, per] of work) {
    out.set(seq, [...per.values()].map((c) => {
      const sense = REACTION_SENSES.find((s) => reactionKey(s.emoji) === reactionKey(c.emoji))
      return { emoji: c.emoji, ...(sense ? { name: sense.name } : {}), by: [...c.by].map(([id, name]) => ({ id, name })) }
    }))
  }
  return out
}

/** Entries (one emoji on one message) a ride carries at most; the rest is counted (`+N, veja channels_read`). */
export const RIDE_ENTRIES = 5
/** Characters a ride carries at most (~60 tokens): an entry that would pass it is counted with the rest. */
export const RIDE_CHARS = 200

export interface ReactionRide {
  /** `38 ❓ soul · bancada, 👍 Guga; 36 ✅ Guga` (newest message first; several names joined by ` + `), undefined when nothing new. */
  text?: string
  /** The newest seq looked at: the member's cursor once the ride is delivered. */
  last: number
}

/**
 * The reactions that ride on the next delivery to `agent`: those given after the cursor `after`, by anyone but `agent`, on a
 * message of `agent` that is among `lines` (ascending, the channel's tail up to the line delivered). A reaction put and taken
 * after the cursor is not there; a take away of one already ridden says nothing. Pure.
 */
export function reactionRide(lines: readonly Line[], agent: AgentId, after: number): ReactionRide {
  const last = lines.length ? Math.max(after, lines[lines.length - 1]!.seq) : after
  const mine = new Set<number>()
  for (const l of lines) if (l.kind === 'message' && l.from.id === agent) mine.add(l.seq)
  const fresh = lines.filter((l) => l.seq > after && l.kind === 'reaction' && l.react && l.from.id !== agent && mine.has(l.react.seq))
  if (fresh.length === 0) return { last }
  const sums = [...sumReactions(fresh)].sort((a, b) => b[0] - a[0])
  const total = sums.reduce((n, [, t]) => n + t.length, 0)
  if (total === 0) return { last }
  const groups: string[] = []
  let used = 0
  let size = 0
  for (const [seq, tallies] of sums) {
    const parts: string[] = []
    for (const t of tallies) {
      if (used >= RIDE_ENTRIES) break
      const part = `${t.emoji} ${t.by.map((b) => b.name).join(' + ')}`
      const extra = parts.length ? part.length + 2 : `${seq} `.length + part.length + (groups.length ? 2 : 0)
      if (size + extra > RIDE_CHARS) break
      parts.push(part)
      size += extra
      used++
    }
    if (parts.length) groups.push(`${seq} ${parts.join(', ')}`)
    if (used >= RIDE_ENTRIES || parts.length < tallies.length) break
  }
  const rest = total - used
  const text = groups.join('; ') + (rest > 0 ? `${groups.length ? '; ' : ''}+${rest}, veja channels_read` : '')
  return { text, last }
}

/** `limit` when `who` putting `reaction` on a message that carries `tallies` would pass a cap, else undefined. */
export function reactionLimit(tallies: readonly ReactionTally[], who: Who, reaction: Reaction): 'limit' | undefined {
  const key = reactionKey(reaction.emoji)
  const mine = tallies.filter((t) => t.by.some((b) => b.id === who)).length
  if (mine >= REACTIONS_PER_MEMBER) return 'limit'
  if (tallies.length >= REACTIONS_PER_LINE && !tallies.some((t) => reactionKey(t.emoji) === key)) return 'limit'
  return undefined
}

/** The two reactions that ask something of the person when an agent puts them on her speech: ❓ (doubt) and ❌ (disagree). */
export const ASK_EMOJIS: readonly string[] = ['❓', '❌']

/** One reaction that asks the person: `seq` is the reaction's own number (what "seen" is compared with), `on` the speech of hers it is on. */
export interface Ask { seq: number; on: number; emoji: string; by: string }

/**
 * The reactions that ask the person, from `lines` (ascending, the channel's tail): a ❓ or ❌ an AGENT put on a speech of the
 * PERSON and nobody took back. Every other reaction, on any speech, asks nothing. Pure.
 */
export function personAsks(lines: readonly Line[]): Ask[] {
  const hers = new Set<number>()
  const live = new Map<string, Ask>()
  for (const l of lines) {
    if (l.kind === 'message' && l.from.id === USER) hers.add(l.seq)
    if (l.kind !== 'reaction' || !l.react || l.from.id === USER || !hers.has(l.react.seq)) continue
    const key = reactionKey(l.react.emoji)
    if (!ASK_EMOJIS.includes(key)) continue
    const id = `${l.react.seq}|${key}|${l.from.id}`
    if (l.react.op === 'add') { if (!live.has(id)) live.set(id, { seq: l.seq, on: l.react.seq, emoji: key, by: l.from.name }) }
    else live.delete(id)
  }
  return [...live.values()].sort((a, b) => a.seq - b.seq)
}

/** The person is the moderator of every channel. */
export function isModerator(who: Who): boolean {
  return who === USER
}

export function isMember(ch: Channel, id: Who): boolean {
  return id !== USER && Object.hasOwn(ch.members, id)
}

export function isMuted(ch: Channel, id: AgentId): boolean {
  return isMember(ch, id) && ch.members[id]!.muted !== undefined
}

export function isDeskChannel(ch: Channel): boolean {
  return ch.desk !== undefined
}

export function deskChannelId(deskId: string): ChannelId {
  return DESK_CHANNEL_PREFIX + deskId
}

export function isRemoved(ch: Channel, id: AgentId): boolean {
  return (ch.removed ?? []).includes(id)
}

/**
 * Who commands the channel now. The agent owner until it gives the channel up (`ownerEnded`), and only while a member;
 * otherwise, and when the person created it, the person.
 */
export function ownerOf(ch: Channel): ChannelOwner {
  const o = ch.owner
  if (o.kind === 'agent' && !ch.ownerEnded && isMember(ch, o.id)) return o
  return { kind: 'user' }
}

/** The agent that owns the channel now, or undefined when the person does. */
export function agentOwnerOf(ch: Channel): AgentId | undefined {
  const o = ownerOf(ch)
  return o.kind === 'agent' ? o.id : undefined
}

/** Whether `id` leaving, being removed or being forgotten gives the channel up: it is the agent owner now. The caller then writes `ownerEnded`. */
export function endsOwnership(ch: Channel, id: AgentId): boolean {
  return agentOwnerOf(ch) === id
}

/** Who may join another agent, remove, mute, unmute and close: the owner and the moderator. Says nothing about open or closed. */
export function mayModerate(who: Who, ch: Channel): boolean {
  return isModerator(who) || agentOwnerOf(ch) === who
}

/** Every channel, open or closed, is readable by every agent, member or not, and by the person. */
export function mayRead(_who: Who, _ch: Channel): boolean {
  return true
}

/** Why `who` may not speak in the channel, or undefined when it may. The moderator speaks in every open channel; a muted member hears only. */
export function sayRefusal(who: Who, ch: Channel): 'closed' | 'not-member' | 'muted' | undefined {
  if (ch.closed) return 'closed'
  if (isModerator(who)) return undefined
  if (!isMember(ch, who)) return 'not-member'
  if (isMuted(ch, who)) return 'muted'
  return undefined
}

export function maySay(who: Who, ch: Channel): boolean {
  return sayRefusal(who, ch) === undefined
}

/**
 * Why `who` may not join `agent` (itself when absent) to the channel, or undefined when it may. An agent joins itself to any
 * open channel it was not removed from; joining another, a removed one included, takes the owner or the moderator.
 */
export function joinRefusal(who: Who, ch: Channel, agent?: AgentId): 'closed' | 'not-owner' | 'removed' | undefined {
  if (ch.closed) return 'closed'
  const self = agent === undefined || agent === who
  if (self && !isModerator(who)) return isRemoved(ch, who) ? 'removed' : undefined
  return mayModerate(who, ch) ? undefined : 'not-owner'
}

/** The desk brings this pane of its desk into the desk channel: not already a member and not removed from it. */
export function joinsByDesk(ch: Channel, id: AgentId): boolean {
  return isDeskChannel(ch) && !isMember(ch, id) && !isRemoved(ch, id)
}

/** Why `who` may not close the channel, or undefined when it may. A desk channel is never closed by hand ('desk'): it follows its desk. */
export function closeRefusal(who: Who, ch: Channel): 'desk' | 'closed' | 'not-owner' | undefined {
  if (isDeskChannel(ch)) return 'desk'
  if (ch.closed) return 'closed'
  return mayModerate(who, ch) ? undefined : 'not-owner'
}

/**
 * Why `who` may not reopen the channel, or undefined when it may. A common channel: the owner (as `ownerOf` reads it while
 * closed) or the moderator. A desk channel is never reopened by hand ('desk', the moderator included): it reopens with its
 * desk getting an owner again.
 */
export function reopenRefusal(who: Who, ch: Channel): 'desk' | 'not-closed' | 'not-owner' | undefined {
  if (isDeskChannel(ch)) return 'desk'
  if (!ch.closed) return 'not-closed'
  return mayModerate(who, ch) ? undefined : 'not-owner'
}

/** The role of `who` in the channel: the moderator (the person), the owner, a member, or none. */
export function roleIn(who: Who, ch: Channel): ChannelRole | undefined {
  if (isModerator(who)) return 'moderator'
  if (agentOwnerOf(ch) === who) return 'owner'
  return isMember(ch, who) ? 'member' : undefined
}

/** The role the envelope carries for a line's speaker: an owner speaks as a member; the moderator and the tether keep theirs. */
export function deliveryRoleOf(role: ChannelRole | 'system'): 'member' | 'moderator' | 'system' {
  return role === 'owner' ? 'member' : role
}

/** A room name: lowercase letters, digits and hyphens, 1 to 40, starting and ending with a letter or a digit. */
export function isRoomName(name: string): boolean {
  return name.length <= ROOM_NAME_MAX && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name)
}

/**
 * The room name for a free text (a desk's name, a title): accents dropped, lowercase, every run of other characters one
 * hyphen, at most 40. Empty after that: 'canal'. When `taken` has it, the first free of `-2`, `-3`… (the base cut to fit).
 */
export function slugOf(text: string, taken?: { has(name: string): boolean }): string {
  const trim = (s: string): string => s.replace(/^-+|-+$/g, '')
  const base = trim(trim(text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-')).slice(0, ROOM_NAME_MAX)) || 'canal'
  if (!taken?.has(base)) return base
  for (let n = 2; ; n++) {
    const suffix = `-${n}`
    const name = trim(base.slice(0, ROOM_NAME_MAX - suffix.length)) + suffix
    if (!taken.has(name)) return name
  }
}
