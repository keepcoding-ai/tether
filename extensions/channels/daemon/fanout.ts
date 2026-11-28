// The channels in tetherd: every gesture (create, say, join, leave, remove, mute, unmute, close, reopen, a pane forgotten, a
// process back) goes through here. Each one asks the rules (../rules.ts) first, writes through the store, appends the line the
// channel keeps (P9: a structure gesture is a `notice` line too), tells the channel's pane (`api.events`: `line`, `channel`)
// and hands one delivery per member to the core (contract 2). The core picks the path (inside, terminal, queue) with its own
// interlocks: nothing here types or picks a path. The verbs (H3) and the moderator's requests (H4) are thin shells over this.
//
// What lives in memory, all bounded by members x channels and never by lines:
//   - `pending`: at most ONE waiting delivery of a line per (member, channel) (2.4). A second line while the first waits
//     cancels it and goes as one merged notice (counts and names, no body); a cancel that fails (it left meanwhile) lets the
//     new line go as it came.
//   - `missed`: what a member whose process does not run did not get, per channel (2.5): nothing is delivered to it, and ONE
//     notice per channel goes when it runs again.
//   - `turns`: one record per member a delivery of ours reached (2.6), dropped when its pane is forgotten. Who opened a turn
//     is decided at its START edge (`busySince` changes): a line went in (inside or typed) since the previous start edge and
//     the person typed nothing after the latest such line nor since the member went idle, so the line opened it, even a line
//     taken while the agent was busy, which Claude answers in a turn of its own right after its current one ends. The `done`
//     that ends such a turn is cleared (`attention.seen`) unless the person typed in it; a turn she opened by typing is never
//     cleared, lines in the middle or not; `waiting` is never cleared. A commanded pane follows the same rule: its `done`
//     comes as `attentionFor` (routed to the owner) and clearing it is what keeps for-agents' "terminou" from going to the
//     owner (the notice drops an edge whose `attentionFor` is gone, whichever listener runs first). A turn the owner opened
//     with `agents send` brings no line of ours, so its `done` stays and is told.
// All of it is lost on a tetherd restart (the record and the core's queue stay on disk): at worst one return notice is missed.
// The ride (reactions to a member's own lines, carried by a message it gets anyway) keeps its cursor on disk, in the member's
// `reactionsSeen` in the index: it is read from the channel's tail, never alone delivered, and never repeated after a restart.
// Polls: the open ones and their current votes live in the index (store.ts), the deadline is an absolute time, and ONE timer
// for the whole tether points at the nearest deadline of every channel (`arm`), re-pointed when a poll opens or closes; on
// start it rings at once for what passed while the tether was down. Two deliveries only, never a vote:
//   - the REQUEST (`kind: 'request'`), one per agent called, ever: its receipt goes into the poll's `asked` in the index, so a
//     restart or a process coming back never asks twice. It is never in `pending`: a line that finds it waiting does not merge
//     it (the question would be lost), and it does not merge lines. A called whose process does not run gets nothing and is
//     asked when it runs again (`spawned`) if the poll is still open; one the person holds waits in the core's queue. The
//     queued request carries `until` = the deadline (the core drops it then, a restart included) and is cancelled when the
//     poll closes before its time: a closed poll is never asked.
//   - the RESULT, to the author alone (an agent), once, after the poll left the index. The result line is delivered to no one.
import { slotIsLive, slotTitle } from '../../../app/shared/agent-info.ts'
import { DisposableStore, toDisposable, type IDisposable } from '../../../app/shared/vscode-lifecycle.ts'
import type { DeliveryMessage, DeliveryReceipt, TetherDaemon } from '../../../src/daemon/ext-api.ts'
import type { SlotState } from '../../../src/daemon/protocol.ts'
import {
  allVoted, closeRefusal, deliveryRoleOf, deskChannelId, isCalled, isDeskChannel, isMember, joinRefusal, joinsByDesk, mayClosePoll, mayModerate,
  nextPollDeadline, numberedOptions, oneLine, openPolls, owesRequest, parseReaction, parseVoteOption, POLL_QUESTION_MAX, POLL_REASON_MAX,
  POLL_TIMEOUT_DEFAULT_MS, POLL_TIMEOUT_MAX_MS, POLL_TIMEOUT_MIN_MS, POLL_VOTE_CHANGES, pollOpenRefusal, pollOptions, pollResult, pollResultText, reactionKey,
  reactionLimit, reactionRide, reactRefusal, REACTION_WINDOW, REACTIONS_PER_MINUTE, reopenRefusal, roleIn, sayRefusal, slugOf, sumReactions, tallyText, USER,
  type AgentId, type Channel, type ChannelId, type Line, type LineEventType, type OpenPoll, type PollClosedBy, type PollMissingWhy, type PollPerson,
  type PollResult, type Reaction, type ReactionRide, type Who,
} from '../rules.ts'
import { withFiles, type FileRefusal } from '../attachments.ts'
import { storeFiles, type FileSource } from './files.ts'
import { TAIL_LINES, type ChannelStore, type NewLine, type StoreError } from './store.ts'
import {
  clockText, closedLine, createdLine, createdNotice, DESK_JOINER, deskClosedLine, deskCreatedLine, deskReopenedLine, forgottenLine,
  joinedLine, joinedNotice, leftLine, mergedNotice, MODERATOR_NAME, mutedLine, mutedNotice, ownerChangedLine, ownerEndedLine,
  removedLine, removedNotice, reopenedLine, returnNotice, SYSTEM_FROM, unmutedLine, unmutedNotice, withReplyHint, withVoteHint, type DeskClosedWhy, type Tally,
} from './notices.ts'

/** What the fan-out uses of the daemon API (`desks` tells a sleeping desk from a stopped process; without it, "parado"). */
export type ChannelsApi = Pick<TetherDaemon, 'slots' | 'delivery' | 'attention' | 'events' | 'settings' | 'log'> & Partial<Pick<TetherDaemon, 'desks'>>

/** The moderator's name setting. */
export const MODERATOR_NAME_KEY = 'extensions.channels.moderatorName'

/** Per member, what became of a line: the core's path, or `away` (its process does not run: nothing was delivered). */
export type LineReceipt = 'inside' | 'typed' | 'queued' | 'away'

export type Refusal =
  | StoreError
  | 'closed' | 'not-member' | 'muted' | 'not-owner' | 'removed' | 'desk' | 'not-closed'
  | 'unknown-agent' | 'bad-request'
  | 'unknown-line' | 'not-a-message' | 'too-old' | 'bad-reaction' | 'limit' | 'slow-down'
  | 'too-long' | 'vote-first' | 'nobody-called' | 'poll-closed' | 'not-called' | 'bad-option' | 'not-author'
  | FileRefusal

export type Outcome<T> = ({ ok: true } & T) | { ok: false; error: Refusal }

export interface PollInput {
  question: string
  /** None: the `ok` poll (1 ok, 2 não ok). Given: a single choice among them (2 to 6). */
  options?: readonly string[]
  /** Who is called (agent ids, `user` for the person). Absent: every agent member but the author. The author is never called. */
  to?: readonly Who[]
  /** The deadline from now, in ms (1 min to 24 h); absent: 10 min. */
  timeoutMs?: number
}

export interface VoteInput {
  /** The poll's seq. */
  poll: number
  /** The option's number (1-based) or its text. */
  vote: string | number
  reason?: string
}

/** Why a called does not hear now: its process does not run, its desk sleeps, or the person has its pane. */
export type Deaf = Extract<PollMissingWhy, 'stopped' | 'asleep' | 'with-user'>

/** A closed poll: its result and the notice line that carries it. */
export interface PollClosed { line: Line; result: PollResult }

/**
 * The one clock of the polls, for the whole tether: one timer pointed at the nearest deadline of every channel. Tests give a
 * fake one; the default is the process clock with an unref'd setTimeout.
 */
export interface PollClock {
  now(): number
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

const PROCESS_CLOCK: PollClock = {
  now: () => Date.now(),
  set: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t },
  clear: (t) => clearTimeout(t as NodeJS.Timeout),
}

/** setTimeout's largest delay; a farther deadline re-arms when it fires. */
const MAX_DELAY_MS = 2 ** 31 - 1

export interface SayInput {
  body: string
  /** Names the line addresses (an address, not a secret: every member hears it). */
  to?: readonly string[]
  /** The seq of the line it answers, in the same channel. */
  replyTo?: number
  /** Files the speech carries (at most ATTACH_MAX_PER_SAY): copied into the channel's folder; with files the body may be ''. */
  files?: readonly FileSource[]
  /** The files came from a device (the portal's uploads): their copies get the mark of origin. */
  fromAfar?: boolean
}

export interface ReactInput {
  /** The seq of the message reacted to. */
  seq: number
  /** One of the five names (`seen`, `agree`, `done`, `disagree`, `question`) or one emoji. */
  reaction: string
  remove?: boolean
}

export interface Channels {
  readonly store: ChannelStore
  /** A common channel. An agent creator joins as its member and owner; the person creates a channel she owns. */
  create(who: Who, input: { name: string; title?: string }): Promise<Outcome<{ channel: Channel; line: Line }>>
  /** A line from a member (role `member`, the owner too) or the moderator (`who: 'user'`). Delivered to every member but the speaker. */
  say(who: Who, id: ChannelId, input: SayInput): Promise<Outcome<{ line: Line; receipts: Record<AgentId, LineReceipt> }> & { file?: string }>
  /**
   * A reaction (or its removal) on the message `seq`: a line of its own (`kind: 'reaction'`) in the record, the event `reaction`,
   * and NOTHING else: no delivery, no notice, no turn, no change to "seen". `changed: false` (no line) when it was there already
   * (put) or was not there (take away).
   */
  react(who: Who, id: ChannelId, input: ReactInput): Promise<Outcome<{ changed: boolean; reaction: Reaction; line?: Line }>>
  /**
   * Opens a poll: a line of its own (`kind: 'poll'`) and the poll in the channel's index, the event `poll`, and ONE request to
   * each agent called (no line event, no notice). `deaf`: the called that do not hear now and why (asked when they run again,
   * or waiting in the queue while the person has their pane).
   */
  poll(who: Who, id: ChannelId, input: PollInput): Promise<Outcome<{ line: Line; poll: OpenPoll; deaf: Array<PollPerson & { why: Deaf }> }>>
  /**
   * A vote (or a change of it) on an open poll: a line of its own (`kind: 'vote'`), the event `poll`, nothing delivered.
   * `changed: false` (no line) when it is the same option and reason. The last one still called voting closes it (`closed`).
   */
  vote(who: Who, id: ChannelId, input: VoteInput): Promise<Outcome<{ changed: boolean; option: number; poll: OpenPoll; line?: Line; closed?: PollClosed }>>
  /** Its author or the person closes an open poll before its time. */
  pollClose(who: Who, id: ChannelId, poll: number): Promise<Outcome<PollClosed>>
  /** The one clock of the polls: armed or not, and for when (ms since the epoch). For tests and diagnosis. */
  pollClock(): { armed: boolean; at?: number }
  /** `agent` absent: `who` joins itself. `already: true` (and no line) when it was a member. */
  join(who: Who, id: ChannelId, agent?: AgentId): Promise<Outcome<{ channel: Channel; already: boolean; line?: Line }>>
  leave(agent: AgentId, id: ChannelId): Promise<Outcome<{ channel: Channel; line: Line }>>
  remove(who: Who, id: ChannelId, agent: AgentId): Promise<Outcome<{ channel: Channel; line: Line }>>
  /** `changed: false` (and no line) when it was muted already. */
  mute(who: Who, id: ChannelId, agent: AgentId): Promise<Outcome<{ channel: Channel; changed: boolean; line?: Line }>>
  unmute(who: Who, id: ChannelId, agent: AgentId): Promise<Outcome<{ channel: Channel; changed: boolean; line?: Line }>>
  close(who: Who, id: ChannelId): Promise<Outcome<{ channel: Channel; line: Line }>>
  reopen(who: Who, id: ChannelId): Promise<Outcome<{ channel: Channel; line: Line }>>
  /** The pane was forgotten: it leaves every channel (the reverse index). Wired to `onSlot('removed')`. */
  forgotten(agent: AgentId, name?: string): Promise<void>
  /** The process runs again: one notice per channel with what it missed. Wired to `onSlot('spawned')`. */
  spawned(agent: AgentId): Promise<void>
  /** The display name of `who`: the moderator's setting, or the pane's tab. */
  nameOf(who: Who): string
  /** The desk channel's own gestures (desk-channel.ts calls them). */
  readonly desk: DeskGestures
  dispose(): void
}

/**
 * What only the desk does to its channel: it skips the rules' 'desk' refusals (a desk channel is never closed or reopened by
 * hand) and joins with by 'desk'. Each runs in the channel's lane, like every gesture. Who calls decides WHEN (desk-channel.ts);
 * these only do. On a channel that is not a desk's: 'bad-request'.
 */
export interface DeskGestures {
  /**
   * Born as `desk_<deskId>` (name and title given, the person its creator) or, when it exists closed, reopened with the same
   * history: renamed by slugOf with a suffix when an open channel took its name meanwhile. `owner` becomes the owner and joins
   * (out of `removed`, it is the person's new act); every pane of `panes` that is an agent and joinsByDesk joins, by 'desk'. One
   * line (`create` or `reopen`); each joiner gets its join notice. An open channel: 'exists'.
   */
  open(deskId: string, input: { name: string; title: string; owner: AgentId; panes: readonly AgentId[] }):
    Promise<Outcome<{ channel: Channel; created: boolean; reopened: boolean; line: Line }>>
  /**
   * The desk has `owner` (another one, or the same given again after it gave the channel up): it owns the channel, joins by
   * 'desk' when not a member (out of `removed`), the old owner stays a member. Line `owner-changed`. `changed: false` (no line)
   * when it owns it already.
   */
  setOwner(id: ChannelId, owner: AgentId): Promise<Outcome<{ channel: Channel; changed: boolean; line?: Line }>>
  /** A pane came into the desk: joins by 'desk' when it is an agent and joinsByDesk; `joined: false` (no line) otherwise. */
  enter(id: ChannelId, agent: AgentId): Promise<Outcome<{ channel: Channel; joined: boolean; line?: Line }>>
  /**
   * A pane left the desk: out of `removed` always; out of the channel when it joined by 'desk' and is not the desk's owner (the
   * owner leaves only by its own leave, a removal or the forgotten pane). It gets the line apart.
   */
  exit(id: ChannelId, agent: AgentId): Promise<Outcome<{ channel: Channel; left: boolean; line?: Line }>>
  /** The desk lost its owner or is gone: closed by the person, what waited is cancelled, one `close` line. `changed: false` when closed already. */
  close(id: ChannelId, why: DeskClosedWhy): Promise<Outcome<{ channel: Channel; changed: boolean; line?: Line }>>
  /** The desk was renamed: the title follows (no line, the `channel` event); the name stays. */
  retitle(id: ChannelId, title: string): Promise<Outcome<{ channel: Channel; changed: boolean }>>
}

/** Event `channel`: the channel after a structure change (create, join, leave, remove, mute, unmute, close, reopen, forget). */
export interface ChannelEvent { channel: Channel }
/** Event `line`: a line appended to a channel (never a reaction). */
export interface LineEvent { channelId: ChannelId; room: string; line: Line }
/** Event `reaction`: a reaction line appended (kind 'reaction'); a pane that draws `line` events never sees it as a line. */
export interface ReactionEvent { channelId: ChannelId; room: string; line: Line }
/**
 * Event `poll`: a line of a poll appended (open, vote, close), never a `line` event (isPollLine). `poll` is the open poll after
 * it (absent once closed).
 */
export interface PollEvent { channelId: ChannelId; room: string; line: Line; poll?: OpenPoll }

interface Waiting extends Tally {
  receipt: string
  /** Reactions rode on the waiting delivery: the member's cursor before them, so a merge carries them again. */
  rideFrom?: number
}

/** The turn edges of one member and the lines between them (2.6). */
interface TurnWatch {
  /** `busySince` of the turn in progress when last seen; absent while idle. */
  busy?: string
  /** When the member last went idle (ms): the end of its previous turn. */
  idle?: number
  /** The latest line that went in (inside or typed) since the last start edge (ms). */
  line?: number
  /** The turn in progress was opened by a line: its start (ms). */
  opened?: number
}

const keyOf = (agent: AgentId, id: ChannelId): string => `${agent} ${id}`

export function createChannels(api: ChannelsApi, store: ChannelStore, clock: PollClock = PROCESS_CLOCK): Channels {
  const own = new DisposableStore()
  /** When this tetherd opened the record: a deadline before it passed while the tether was down. */
  const bootAt = clock.now()
  const moderatorName = (): string => {
    const v = api.settings.get<string>(MODERATOR_NAME_KEY)
    return typeof v === 'string' && v.trim() ? v.trim() : MODERATOR_NAME
  }
  const slotOf = (id: AgentId): SlotState | undefined => api.slots.get(id)
  const nameOf = (who: Who): string => {
    if (who === USER) return moderatorName()
    const s = slotOf(who)
    if (s) return slotTitle(s)
    for (const ch of store.channelsOf(who)) { const m = ch.members[who]; if (m) return m.name }
    return who
  }

  // ---- memory (see the header) ----
  const pending = new Map<string, Waiting>()
  const byReceipt = new Map<string, string>()
  const missed = new Map<AgentId, Map<ChannelId, Tally>>()
  const turns = new Map<AgentId, TurnWatch>()
  /** When each (member, channel) last reacted, the last minute only: the rate limit of `react`. */
  const rates = new Map<string, number[]>()

  const lanes = new Map<ChannelId, Promise<unknown>>()
  /** One gesture at a time per channel: the pending check and its delivery never race another line of the same channel. */
  function lane<T>(id: ChannelId, fn: () => Promise<T>): Promise<T> {
    const run = (lanes.get(id) ?? Promise.resolve()).then(fn)
    const settled = run.then(() => {}, () => {})
    lanes.set(id, settled)
    void settled.then(() => { if (lanes.get(id) === settled) lanes.delete(id) })
    return run
  }

  const tallyOf = (line: Line): Tally => {
    const t: Tally = { since: line.seq, at: line.at, messages: 0, notices: 0, speakers: [], fromUser: 0 }
    count(t, line)
    return t
  }
  function count(t: Tally, line: Line): void {
    if (line.kind === 'notice') { t.notices++; return }
    t.messages++
    if (line.from.role === 'moderator') t.fromUser++
    else if (!t.speakers.includes(line.from.name)) t.speakers.push(line.from.name)
  }
  function merge(into: Tally, t: Tally): void {
    if (t.since < into.since) { into.since = t.since; into.at = t.at }
    into.messages += t.messages
    into.notices += t.notices
    into.fromUser += t.fromUser
    for (const s of t.speakers) if (!into.speakers.includes(s)) into.speakers.push(s)
  }

  const envelopeOf = (ch: Channel, line: Line, path: 'inside' | 'terminal' | 'wait', tools: boolean): DeliveryMessage => {
    const ref = `${ch.name}#${line.seq}`
    if (line.kind === 'notice') return { kind: 'notice', room: ch.name, from: { ...SYSTEM_FROM }, body: line.body, ref }
    const msg: DeliveryMessage = {
      kind: 'message', room: ch.name, body: withReplyHint(withFiles(line.body, line.files), ch.name, path, tools), ref,
      from: { name: line.from.name, id: line.from.id, role: deliveryRoleOf(line.from.role) },
    }
    if (line.to?.length) msg.to = line.to
    if (line.replyTo !== undefined) msg.inReplyTo = `${ch.name}#${line.replyTo}`
    return msg
  }
  const noticeOf = (ch: Channel, body: string, ref?: number): DeliveryMessage =>
    ({ kind: 'notice', room: ch.name, from: { ...SYSTEM_FROM }, body, ...(ref !== undefined ? { ref: `${ch.name}#${ref}` } : {}) })

  /** Delivers; a refusal of the core (the slot vanished) is logged and reads as `away`. */
  async function send(agent: AgentId, msg: DeliveryMessage, until?: string): Promise<DeliveryReceipt | undefined> {
    try {
      return await api.delivery.deliver(agent, msg, until ? { until } : undefined)
    } catch (e) {
      api.log(`entrega para ${agent} em #${msg.room ?? '?'} falhou: ${(e as Error).message}`)
      return undefined
    }
  }
  /** Whether the receipt still waits in the core's queue (it may have gone out while the answer came back). */
  const stillWaits = (r: DeliveryReceipt): boolean => r.state === 'queued' && api.delivery.pending(r.slotId).some((p) => p.id === r.id)

  function track(agent: AgentId, id: ChannelId, r: DeliveryReceipt, t: Tally & { rideFrom?: number }): void {
    const key = keyOf(agent, id)
    if (!stillWaits(r)) return
    pending.set(key, { ...t, receipt: r.id })
    byReceipt.set(r.id, key)
  }
  function untrack(key: string): Waiting | undefined {
    const w = pending.get(key)
    if (!w) return undefined
    pending.delete(key)
    byReceipt.delete(w.receipt)
    return w
  }
  /** Takes out of the core's queue the line that waited for `agent` in the channel. */
  function cancelWaiting(agent: AgentId, id: ChannelId): void {
    const w = untrack(keyOf(agent, id))
    if (w) api.delivery.cancel(w.receipt)
  }

  const isAway = (agent: AgentId): boolean => {
    const s = slotOf(agent)
    return !s || !slotIsLive(s)
  }
  function remember(agent: AgentId, id: ChannelId, line: Line): void {
    let per = missed.get(agent)
    if (!per) missed.set(agent, (per = new Map()))
    const t = per.get(id)
    if (t) count(t, line)
    else per.set(id, tallyOf(line))
  }
  function forgetMissed(agent: AgentId, id?: ChannelId): void {
    if (id === undefined) { missed.delete(agent); return }
    const per = missed.get(agent)
    if (!per) return
    per.delete(id)
    if (per.size === 0) missed.delete(agent)
  }

  // ---- the ride: reactions to the member's own lines go along with a delivery it gets anyway (never one of their own) ----
  /** The channel's tail up to `upTo`, read once per fan-out and only when some delivery needs it. */
  const tailOnce = (id: ChannelId, upTo?: number): (() => Promise<Line[]>) => {
    let got: Promise<Line[]> | undefined
    return () => (got ??= store.history(id, upTo === undefined ? undefined : upTo + 1, TAIL_LINES))
  }
  const cursorOf = (ch: Channel, agent: AgentId): number => (Object.hasOwn(ch.members, agent) ? ch.members[agent]!.reactionsSeen ?? 0 : 0)
  /** Puts on `msg` the reactions after `from`; the ride, so `rode` moves the cursor once the delivery went to the core. */
  async function ride(agent: AgentId, msg: DeliveryMessage, from: number, tail: () => Promise<Line[]>): Promise<ReactionRide> {
    const r = reactionRide(await tail(), agent, from)
    if (r.text) msg.reactions = r.text
    return r
  }
  /**
   * The ride went with a delivery the core took (inside, typed or queued): the cursor moves past it, on disk, so a restart
   * never repeats it. A queued one that is merged later rides again on the merged notice (`rideFrom`).
   */
  async function rode(agent: AgentId, ch: Channel, r: ReactionRide): Promise<void> {
    if (!r.text) return
    store.markReactionsSeen(ch.id, agent, r.last)
    await store.flush()
  }

  /**
   * One line to one member, with the rule of one waiting delivery per (member, channel). `tail` given (a message): the
   * reactions to the member's lines ride on it.
   */
  async function deliverLine(agent: AgentId, ch: Channel, line: Line, tail?: () => Promise<Line[]>): Promise<LineReceipt> {
    if (isAway(agent)) { remember(agent, ch.id, line); return 'away' }
    const key = keyOf(agent, ch.id)
    const cursor = cursorOf(ch, agent)
    const w = untrack(key)
    if (w && api.delivery.cancel(w.receipt)) {
      count(w, line)
      const msg = noticeOf(ch, mergedNotice(ch.name, w, api.delivery.routeOf(agent), api.delivery.hasTools(agent)), line.seq)
      // What rode on the cancelled delivery rides again, with what came since.
      const from = Math.min(w.rideFrom ?? cursor, cursor)
      const got = tail || w.rideFrom !== undefined ? await ride(agent, msg, from, tail ?? tailOnce(ch.id, line.seq)) : undefined
      const r = await send(agent, msg)
      if (!r) return 'away'
      const { rideFrom: _was, ...tally } = w
      track(agent, ch.id, r, got?.text ? { ...tally, rideFrom: from } : tally)
      if (got && r.state !== 'dropped') await rode(agent, ch, got)
      return receiptState(r)
    }
    const msg = envelopeOf(ch, line, api.delivery.routeOf(agent), api.delivery.hasTools(agent))
    const got = tail ? await ride(agent, msg, cursor, tail) : undefined
    const r = await send(agent, msg)
    if (!r) return 'away'
    track(agent, ch.id, r, got?.text ? { ...tallyOf(line), rideFrom: cursor } : tallyOf(line))
    if (got && r.state !== 'dropped') await rode(agent, ch, got)
    return receiptState(r)
  }
  const receiptState = (r: DeliveryReceipt): LineReceipt => (r.state === 'dropped' ? 'away' : r.state)

  /** A notice of the tether to the agent it is about; not merged (it is about that agent), nothing when it does not run. */
  async function tell(agent: AgentId, ch: Channel, body: string, line: Line): Promise<void> {
    if (isAway(agent)) { remember(agent, ch.id, line); return }
    await send(agent, noticeOf(ch, body, line.seq))
  }

  /** Every member but `except` gets the line; `personal` gives some of them their own text instead. */
  async function fanout(ch: Channel, line: Line, except?: AgentId, personal?: ReadonlyMap<AgentId, string>): Promise<Record<AgentId, LineReceipt>> {
    const out: Record<AgentId, LineReceipt> = {}
    // Reactions ride only on a message (a line that is delivered anyway), never on a notice or a reaction.
    const tail = line.kind === 'message' ? tailOnce(ch.id, line.seq) : undefined
    await Promise.all(Object.keys(ch.members).map(async (agent) => {
      if (agent === except) return
      const text = personal?.get(agent)
      if (text !== undefined) { await tell(agent, ch, text, line); return }
      out[agent] = await deliverLine(agent, ch, line, tail)
    }))
    return out
  }

  async function append(ch: Channel, line: NewLine): Promise<Line> {
    const written = await store.append(ch.id, line)
    api.events.emit('line', { channelId: ch.id, room: ch.name, line: written } satisfies LineEvent)
    return written
  }
  const emitChannel = (ch: Channel): void => { api.events.emit('channel', { channel: ch } satisfies ChannelEvent) }
  const notice = (ch: Channel, body: string, type: LineEventType, who?: AgentId, by?: Who): Promise<Line> =>
    append(ch, { kind: 'notice', from: { ...SYSTEM_FROM }, body, event: { type, ...(who !== undefined ? { who } : {}), ...(by !== undefined ? { by } : {}) } })
  const ownerEnded = (ch: Channel, agent: AgentId, name: string): Promise<Line> => notice(ch, ownerEndedLine(ch.name, name, moderatorName()), 'owner-ended', agent)

  const isAgent = (id: AgentId): boolean => { const s = slotOf(id); return s !== undefined && s.kind !== 'shell' }

  // ---- the done of a turn a line opened (2.6) ----
  /** Follows one state of a watched member: a start edge decides who opened the turn; its end clears a line's `done`. */
  function observe(s: SlotState, w: TurnWatch): void {
    if (s.turn === 'busy') {
      if (!s.busySince || s.busySince === w.busy) return
      const start = Date.parse(s.busySince)
      const line = w.line
      w.busy = s.busySince
      w.line = undefined
      w.opened = undefined
      if (line === undefined) return
      // The turn is hers when she typed after the latest line or since the member went idle (her prompt, even one sent
      // just before a line came in); otherwise the line opened it.
      const typed = api.slots.userTypedAt(s.slotId)
      if (typed === undefined || typed < Math.min(line, w.idle ?? line)) w.opened = start
      return
    }
    w.busy = undefined
    if (s.idleSince) w.idle = Date.parse(s.idleSince)
    const opened = w.opened
    w.opened = undefined
    // `waiting` keeps the turn busy, so only a finished turn gets here; a reset (no `done`) just ends the watch of the turn.
    // The `done` of a commanded pane is in `attentionFor` (routed to its owner).
    if (opened === undefined || (s.attention ?? s.attentionFor?.value) !== 'done') return
    const typed = api.slots.userTypedAt(s.slotId)
    if (typed !== undefined && typed >= opened) return
    try { api.attention.seen(s.slotId) } catch (e) { api.log(`attention.seen ${s.slotId}: ${(e as Error).message}`) }
  }
  own.add(api.delivery.onDidDeliver((r) => {
    const key = byReceipt.get(r.id)
    if (key !== undefined && pending.get(key)?.receipt === r.id) untrack(key)
    if (r.unsent || (r.state !== 'inside' && r.state !== 'typed')) return
    const s = slotOf(r.slotId)
    if (!s) return
    let w = turns.get(r.slotId)
    if (w) observe(s, w) // a start edge not seen yet belongs to the window before this line
    else {
      // First line: the turn in progress (if any) is not this line's; the idle clock comes from the slot.
      w = s.turn === 'busy' ? (s.busySince ? { busy: s.busySince } : {}) : (s.idleSince ? { idle: Date.parse(s.idleSince) } : {})
      turns.set(r.slotId, w)
    }
    w.line = Date.now()
  }))
  own.add(api.slots.onState((s) => {
    const w = turns.get(s.slotId)
    if (w) observe(s, w)
  }))

  const fail = (error: Refusal): { ok: false; error: Refusal } => ({ ok: false, error })

  // ---- polls: lines of their own, the open ones in the index, ONE clock for every channel ----
  // No line of a poll is a `line` event (the event is `poll`); only the request and the result are delivered (see the header).
  let clockTimer: unknown
  let clockAt: number | undefined
  let disposed = false

  const personOf = (who: Who): PollPerson => ({ id: who, name: nameOf(who) })
  const pollEvent = (ch: Channel, line: Line, poll?: OpenPoll): void => {
    api.events.emit('poll', { channelId: ch.id, room: ch.name, line, ...(poll ? { poll } : {}) } satisfies PollEvent)
  }
  /** The pane is on a sleeping desk (or sleeps itself). */
  const asleep = (agent: AgentId): boolean => {
    const d = api.desks?.deskOf(agent)
    return d !== undefined && (d.asleep === true || d.panes.some((p) => p.id === agent && p.asleep === true))
  }
  /** Why an agent does not hear now, or undefined when it does (inside, or a terminal an agent holds). */
  const deafWhy = (agent: AgentId): Deaf | undefined => {
    if (isAway(agent)) return asleep(agent) ? 'asleep' : 'stopped'
    return api.delivery.routeOf(agent) === 'wait' ? 'with-user' : undefined
  }
  const missingWhy = (id: Who): PollMissingWhy => (id === USER ? 'no-answer' : deafWhy(id) ?? 'no-answer')

  /** The request of `p` as `agent` gets it: the question (and how to vote, when typed); the poll's parts are attributes. */
  const requestOf = (ch: Channel, p: OpenPoll, agent: AgentId): DeliveryMessage => ({
    kind: 'request', room: ch.name, ref: `${ch.name}#${p.seq}`,
    from: { name: p.author.name, id: p.author.id, role: deliveryRoleOf(roleIn(p.author.id, ch) ?? 'member') },
    body: withVoteHint(p.question, ch.name, p.seq, api.delivery.routeOf(agent), api.delivery.hasTools(agent)),
    poll: { poll: p.type, options: numberedOptions(p.options), closes: clockText(p.closesAt, clock.now()) },
  })
  /**
   * Hands the request of the open poll `p` to each of `agents` still owed it and running, then writes who got it (`asked`)
   * in one index write. A called that does not run is left for `spawned`. Inside the lane.
   */
  async function ask(ch: Channel, p: OpenPoll, agents: readonly AgentId[]): Promise<void> {
    if (Date.parse(p.closesAt) <= clock.now()) return
    const asked: Record<AgentId, string> = {}
    await Promise.all(agents.map(async (agent) => {
      if (!owesRequest(ch, p, agent) || isAway(agent)) return
      const r = await send(agent, requestOf(ch, p, agent), p.closesAt)
      if (r && r.state !== 'dropped') asked[agent] = r.id
    }))
    if (Object.keys(asked).length) await store.setAsked(ch.id, p.seq, asked)
  }

  /**
   * Closes the open poll `p`: the result notice (a line delivered to no one), the index, the event; what of its requests still
   * waits in the queue is cancelled, and its author (an agent) gets the result, once. Inside the lane.
   */
  async function closePoll(ch: Channel, p: OpenPoll, how: Pick<PollResult, 'by' | 'closer' | 'away'>): Promise<PollClosed> {
    const result = pollResult(ch, p, how, missingWhy)
    const line = await store.append(ch.id, {
      kind: 'notice', from: { ...SYSTEM_FROM }, body: pollResultText(ch.name, result),
      event: { type: 'poll-close', ...(how.closer ? { by: how.closer.id } : {}) }, result,
    })
    await store.closePoll(ch.id, p.seq, line.seq)
    pollEvent(ch, line)
    for (const receipt of Object.values(p.asked ?? {})) api.delivery.cancel(receipt)
    // The author who closed it has the result in the verb's answer: a delivery would only open one more turn.
    if (p.author.id !== USER && how.closer?.id !== p.author.id) {
      await send(p.author.id, {
        kind: 'notice', room: ch.name, from: { ...SYSTEM_FROM }, body: line.body, ref: `${ch.name}#${line.seq}`,
        poll: { poll: `${ch.name}#${p.seq}`, closedBy: result.by, tally: tallyText(result.tally) },
      })
    }
    return { line, result }
  }
  /** The open polls of `ch` all of whose still called voted close (one called left). Inside the lane. */
  async function settlePolls(ch: Channel): Promise<void> {
    let closed = false
    for (const p of openPolls(ch)) if (allVoted(ch, p)) { await closePoll(ch, p, { by: 'all-voted' }); closed = true }
    if (closed) arm()
  }
  /** The channel closes: every open poll closes with it. Inside the lane. */
  async function closeAllPolls(ch: Channel, by: PollClosedBy = 'channel-closed'): Promise<void> {
    const open = openPolls(ch)
    for (const p of open) await closePoll(ch, p, { by })
    if (open.length) arm()
  }
  /** Why the seq is not an open poll: a poll that closed, or no poll at all. Inside the lane. */
  async function notOpen(id: ChannelId, seq: number): Promise<{ ok: false; error: Refusal }> {
    if (!Number.isInteger(seq) || seq < 1 || seq > await store.lastSeq(id)) return fail('unknown-poll')
    const [l] = await store.since(id, seq - 1, 1)
    return fail(l?.seq === seq && l.kind === 'poll' ? 'poll-closed' : 'unknown-poll')
  }

  /**
   * Points the one clock at the nearest deadline of every channel (or disarms it). It reads the index, bounded by channels x
   * POLLS_OPEN_PER_CHANNEL, only when a poll opens or closes, never per line.
   */
  function arm(): void {
    if (disposed) return
    const at = nextPollDeadline(store.channels())
    if (at === clockAt && (at === undefined) === (clockTimer === undefined)) return
    if (clockTimer !== undefined) clock.clear(clockTimer)
    clockTimer = undefined
    clockAt = at
    if (at === undefined) return
    clockTimer = clock.set(() => {
      clockTimer = undefined
      clockAt = undefined
      void due().catch((e: unknown) => api.log(`canais: prazo das enquetes: ${(e as Error).message}`))
    }, Math.min(Math.max(0, at - clock.now()), MAX_DELAY_MS))
  }
  /** The clock rang: every poll whose deadline passed closes by `timeout` (`away` when it passed before this tetherd opened). */
  async function due(): Promise<void> {
    const now = clock.now()
    await Promise.all(store.channels().filter((ch) => openPolls(ch).some((p) => Date.parse(p.closesAt) <= now)).map((ch) => lane(ch.id, async () => {
      for (const p of openPolls(ch)) {
        const at = Date.parse(p.closesAt)
        if (at <= clock.now()) await closePoll(ch, p, { by: 'timeout', ...(at < bootAt ? { away: true } : {}) })
      }
    })))
    arm()
  }

  // ---- the desk channel (DeskGestures) ----
  /** The desk channel `id`, or the refusal. Inside the lane. */
  const deskChannel = (id: ChannelId): Channel | { ok: false; error: Refusal } => {
    const ch = store.get(id)
    if (!ch) return fail('unknown-channel')
    return isDeskChannel(ch) ? ch : fail('bad-request')
  }
  const refused = (v: Channel | { ok: false; error: Refusal }): v is { ok: false; error: Refusal } => 'ok' in v
  /** The join notice of each joiner, for the fan-out of the line that brought them. */
  const joinNotices = (ch: Channel, joined: readonly AgentId[]): Map<AgentId, string> =>
    new Map(joined.map((a) => [a, joinedNotice(ch.name, DESK_JOINER, Object.keys(ch.members).filter((m) => m !== a).map(nameOf), api.delivery.routeOf(a), api.delivery.hasTools(a), nameOf(a))]))
  /** Joins `agent` by 'desk' in the store; whether it is new. Inside the lane. */
  async function deskJoin(ch: Channel, agent: AgentId): Promise<boolean> {
    const done = await store.join(ch.id, agent, nameOf(agent), 'desk')
    if (!done.ok || done.already) return false
    forgetMissed(agent, ch.id)
    return true
  }

  const desk: DeskGestures = {
    open(deskId, input) {
      const id = deskChannelId(deskId)
      return lane(id, async () => {
        if (!isAgent(input.owner)) return fail('unknown-agent')
        let ch = store.get(id)
        let was: string | undefined
        const created = ch === undefined
        if (!ch) {
          const made = await store.create({ name: input.name, title: input.title, owner: { kind: 'user' }, createdBy: USER, desk: deskId })
          if (!made.ok) return made
          ch = made.channel
        } else {
          if (!isDeskChannel(ch)) return fail('bad-request')
          if (!ch.closed) return fail('exists')
          if (store.findOpen(ch.name)) {
            was = ch.name
            const renamed = await store.rename(id, slugOf(ch.name, store.openNames()))
            if (!renamed.ok) return renamed
          }
          const reopened = await store.reopen(id)
          if (!reopened.ok) return reopened
          await store.setTitle(id, input.title)
        }
        await store.setOwner(id, { kind: 'agent', id: input.owner, name: nameOf(input.owner) })
        const joined: AgentId[] = []
        if (await deskJoin(ch, input.owner)) joined.push(input.owner)
        for (const a of input.panes) if (a !== input.owner && isAgent(a) && joinsByDesk(ch, a) && await deskJoin(ch, a)) joined.push(a)
        const owner = nameOf(input.owner)
        const line = created
          ? await notice(ch, deskCreatedLine(ch.name, owner), 'create', input.owner)
          : await notice(ch, deskReopenedLine(ch.name, owner, was), 'reopen', input.owner)
        emitChannel(ch)
        await fanout(ch, line, undefined, joinNotices(ch, joined))
        return { ok: true as const, channel: ch, created, reopened: !created, line }
      })
    },

    setOwner(id, owner) {
      return lane(id, async () => {
        const ch = deskChannel(id)
        if (refused(ch)) return ch
        if (ch.closed) return fail('closed')
        if (!isAgent(owner)) return fail('unknown-agent')
        if (ch.owner.kind === 'agent' && ch.owner.id === owner && !ch.ownerEnded && isMember(ch, owner)) return { ok: true as const, channel: ch, changed: false }
        await store.setOwner(id, { kind: 'agent', id: owner, name: nameOf(owner) })
        const joined = await deskJoin(ch, owner)
        const line = await notice(ch, ownerChangedLine(ch.name, nameOf(owner)), 'owner-changed', owner)
        emitChannel(ch)
        await fanout(ch, line, undefined, joinNotices(ch, joined ? [owner] : []))
        return { ok: true as const, channel: ch, changed: true, line }
      })
    },

    enter(id, agent) {
      return lane(id, async () => {
        const ch = deskChannel(id)
        if (refused(ch)) return ch
        if (ch.closed) return fail('closed')
        if (!isAgent(agent) || !joinsByDesk(ch, agent) || !(await deskJoin(ch, agent))) return { ok: true as const, channel: ch, joined: false }
        const line = await notice(ch, joinedLine(ch.name, nameOf(agent)), 'join', agent)
        emitChannel(ch)
        await fanout(ch, line, undefined, joinNotices(ch, [agent]))
        return { ok: true as const, channel: ch, joined: true, line }
      })
    },

    exit(id, agent) {
      return lane(id, async () => {
        const ch = deskChannel(id)
        if (refused(ch)) return ch
        const cleared = await store.clearRemoved(id, agent)
        if (!cleared.ok) return cleared
        const isOwner = ch.owner.kind === 'agent' && ch.owner.id === agent
        if (isOwner || ch.members[agent]?.by !== 'desk' || !isMember(ch, agent)) {
          if (cleared.changed) emitChannel(ch)
          return { ok: true as const, channel: ch, left: false }
        }
        const name = nameOf(agent)
        const done = await store.leave(id, agent)
        if (!done.ok) return done
        cancelWaiting(agent, id)
        forgetMissed(agent, id)
        const line = await notice(ch, leftLine(ch.name, name), 'leave', agent)
        emitChannel(ch)
        // No longer a member: the desk took it out, so it is told apart.
        if (!ch.closed && !isAway(agent)) await send(agent, noticeOf(ch, line.body, line.seq))
        await fanout(ch, line)
        return { ok: true as const, channel: ch, left: true, line }
      })
    },

    close(id, why) {
      return lane(id, async () => {
        const ch = deskChannel(id)
        if (refused(ch)) return ch
        const done = await store.close(id, USER)
        if (!done.ok) return done
        if (!done.changed) return { ok: true as const, channel: ch, changed: false }
        for (const agent of Object.keys(ch.members)) { cancelWaiting(agent, id); forgetMissed(agent, id) }
        await closeAllPolls(ch)
        const line = await notice(ch, deskClosedLine(ch.name, why), 'close', undefined, USER)
        emitChannel(ch)
        await fanout(ch, line)
        return { ok: true as const, channel: ch, changed: true, line }
      })
    },

    retitle(id, title) {
      return lane(id, async () => {
        const ch = deskChannel(id)
        if (refused(ch)) return ch
        const done = await store.setTitle(id, title)
        if (!done.ok) return done
        if (done.changed) emitChannel(ch)
        return { ok: true as const, channel: ch, changed: done.changed }
      })
    },
  }

  const channels: Channels = {
    store,
    nameOf,
    desk,

    async create(who, input) {
      if (who !== USER && !isAgent(who)) return fail('unknown-agent')
      const owner = who === USER ? { kind: 'user' as const } : { kind: 'agent' as const, id: who, name: nameOf(who) }
      const made = await store.create({ name: input.name, ...(input.title !== undefined ? { title: input.title } : {}), owner, createdBy: who })
      if (!made.ok) return made
      const ch = made.channel
      return lane(ch.id, async () => {
        const line = await notice(ch, createdLine(ch.name, nameOf(who)), 'create', who === USER ? undefined : who, who)
        emitChannel(ch)
        if (who !== USER) await tell(who, ch, createdNotice(ch.name, nameOf(who)), line)
        return { ok: true as const, channel: ch, line }
      })
    },

    say(who, id, input) {
      return lane(id, async () => {
        const ch = store.get(id)
        if (!ch) return fail('unknown-channel')
        const sources = input.files ?? []
        if (typeof input.body !== 'string' || (input.body.trim() === '' && sources.length === 0)) return fail('bad-request')
        const refusal = sayRefusal(who, ch)
        if (refusal) return fail(refusal)
        // The files are checked again here (never trusting the screen) and copied before the line: a line never names a missing file.
        const stored = sources.length ? await storeFiles(store.filesDir(ch.id), sources, undefined, { fromAfar: input.fromAfar === true }) : undefined
        if (stored && !stored.ok) return { ok: false as const, error: stored.error, file: stored.file }
        const files = stored?.ok ? stored.files : []
        const role = roleIn(who, ch)!
        const line = await append(ch, {
          ...(files.length ? { files } : {}),
          kind: 'message', from: { id: who, name: nameOf(who), role }, body: input.body,
          ...(input.to?.length ? { to: [...input.to] } : {}), ...(input.replyTo !== undefined ? { replyTo: input.replyTo } : {}),
        })
        const receipts = await fanout(ch, line, who === USER ? undefined : who)
        return { ok: true as const, line, receipts }
      })
    },

    react(who, id, input) {
      return lane(id, async () => {
        const ch = store.get(id)
        if (!ch) return fail('unknown-channel')
        // Who may react comes first, so a stranger learns `not-member` and nothing about the line.
        const first = reactRefusal(who, ch)
        if (first) return fail(first)
        const reaction = parseReaction(input.reaction)
        if (!reaction) return fail('bad-reaction')
        const muted = reactRefusal(who, ch, reaction)
        if (muted) return fail(muted)
        if (!Number.isInteger(input.seq) || input.seq < 1) return fail('unknown-line')
        const last = await store.lastSeq(id)
        if (input.seq > last) return fail('unknown-line')
        if (input.seq <= last - REACTION_WINDOW) return fail('too-old')
        // The message and every line after it: the reactions to it can only be among them (it is in the window).
        const lines = await store.since(id, input.seq - 1, REACTION_WINDOW + 1)
        const target = lines[0]
        if (!target || target.seq !== input.seq) return fail('unknown-line')
        if (target.kind !== 'message') return fail('not-a-message')
        const tallies = sumReactions(lines).get(input.seq) ?? []
        const key = reactionKey(reaction.emoji)
        const mine = tallies.some((t) => reactionKey(t.emoji) === key && t.by.some((b) => b.id === who))
        const op = input.remove === true ? 'remove' as const : 'add' as const
        if ((op === 'add') === mine) return { ok: true as const, changed: false, reaction }
        if (op === 'add') {
          const capped = reactionLimit(tallies, who, reaction)
          if (capped) return fail(capped)
        }
        const now = Date.now()
        const rateKey = keyOf(who, id)
        const recent = (rates.get(rateKey) ?? []).filter((t) => now - t < 60_000)
        if (recent.length >= REACTIONS_PER_MINUTE) { rates.set(rateKey, recent); return fail('slow-down') }
        recent.push(now)
        rates.set(rateKey, recent)
        // A line of its own and nothing more: no fan-out, no `line` event, no change to the channel's index.
        const line = await store.append(id, {
          kind: 'reaction', from: { id: who, name: nameOf(who), role: roleIn(who, ch)! }, body: '',
          react: { seq: input.seq, emoji: reaction.emoji, op },
        })
        api.events.emit('reaction', { channelId: id, room: ch.name, line } satisfies ReactionEvent)
        return { ok: true as const, changed: true, reaction, line }
      })
    },

    poll(who, id, input) {
      return lane(id, async () => {
        const ch = store.get(id)
        if (!ch) return fail('unknown-channel')
        const now = clock.now()
        const rateKey = `${keyOf(who, id)} poll`
        const recent = (rates.get(rateKey) ?? []).filter((t) => now - t < 3_600_000)
        rates.set(rateKey, recent)
        const refusal = pollOpenRefusal(who, ch, recent.length)
        if (refusal) return fail(refusal)
        const question = typeof input.question === 'string' ? oneLine(input.question) : ''
        if (question === '') return fail('bad-request')
        if (question.length > POLL_QUESTION_MAX) return fail('too-long')
        const kind = pollOptions(input.options)
        if (typeof kind === 'string') return fail(kind)
        const timeout = input.timeoutMs ?? POLL_TIMEOUT_DEFAULT_MS
        if (!Number.isFinite(timeout) || timeout < POLL_TIMEOUT_MIN_MS || timeout > POLL_TIMEOUT_MAX_MS) return fail('bad-request')
        if (input.to?.some((w) => w !== USER && !isMember(ch, w))) return fail('bad-request')
        // The author is never called; by default every agent member but the author, the person only when named.
        const called = [...new Set(input.to?.length ? input.to : Object.keys(ch.members))].filter((w) => w !== who || w === USER)
        if (called.length === 0) return fail('nobody-called')
        recent.push(now)
        const spec = { ...kind, question, to: called.map(personOf), closesAt: new Date(now + timeout).toISOString() }
        const line = await store.append(id, { kind: 'poll', from: { id: who, name: nameOf(who), role: roleIn(who, ch)! }, body: '', poll: spec })
        const poll: OpenPoll = { ...spec, seq: line.seq, author: personOf(who), votes: {} }
        await store.openPoll(id, poll)
        pollEvent(ch, line, poll)
        arm()
        const deaf = spec.to.flatMap((t) => { const why = t.id === USER ? undefined : deafWhy(t.id); return why ? [{ ...t, why }] : [] })
        await ask(ch, poll, spec.to.map((t) => t.id))
        return { ok: true as const, line, poll, deaf }
      })
    },

    vote(who, id, input) {
      return lane(id, async () => {
        const ch = store.get(id)
        if (!ch) return fail('unknown-channel')
        if (ch.closed) return fail('closed')
        const p = ch.polls?.[String(input.poll)]
        if (!p) return notOpen(id, input.poll)
        if (!isCalled(ch, p, who)) return fail('not-called')
        const option = parseVoteOption(p.options, input.vote)
        if (option === undefined) return fail('bad-option')
        const reason = typeof input.reason === 'string' && oneLine(input.reason) !== '' ? oneLine(input.reason) : undefined
        if (reason !== undefined && reason.length > POLL_REASON_MAX) return fail('too-long')
        const prev = p.votes[who]
        if (prev && prev.option === option && prev.reason === reason) return { ok: true as const, changed: false, option, poll: p }
        if (prev && (p.changes?.[who] ?? 0) >= POLL_VOTE_CHANGES) return fail('slow-down')
        const line = await store.append(id, {
          kind: 'vote', from: { id: who, name: nameOf(who), role: roleIn(who, ch)! }, body: '',
          vote: { poll: p.seq, option, ...(reason !== undefined ? { reason } : {}) },
        })
        await store.setVote(id, p.seq, who, { option, ...(reason !== undefined ? { reason } : {}), at: line.at, name: nameOf(who) }, prev !== undefined)
        pollEvent(ch, line, p)
        if (!allVoted(ch, p)) return { ok: true as const, changed: true, option, poll: p, line }
        const closed = await closePoll(ch, p, { by: 'all-voted' })
        arm()
        return { ok: true as const, changed: true, option, poll: p, line, closed }
      })
    },

    pollClose(who, id, seq) {
      return lane(id, async () => {
        const ch = store.get(id)
        if (!ch) return fail('unknown-channel')
        const p = ch.polls?.[String(seq)]
        if (!p) return notOpen(id, seq)
        if (!mayClosePoll(who, p)) return fail('not-author')
        const closed = await closePoll(ch, p, { by: 'author', closer: personOf(who) })
        arm()
        return { ok: true as const, ...closed }
      })
    },

    pollClock: () => ({ armed: clockTimer !== undefined, ...(clockAt !== undefined ? { at: clockAt } : {}) }),

    join(who, id, agent) {
      return lane(id, async () => {
        const ch = store.get(id)
        if (!ch) return fail('unknown-channel')
        const target = agent ?? who
        if (target === USER) return fail('bad-request')
        if (!isAgent(target)) return fail('unknown-agent')
        const refusal = joinRefusal(who, ch, target)
        if (refusal) return fail(refusal)
        const by = who === target ? 'self' as const : who === USER ? 'user' as const : who
        const done = await store.join(id, target, nameOf(target), by)
        if (!done.ok) return done
        if (done.already) return { ok: true as const, channel: ch, already: true }
        forgetMissed(target, id)
        const line = await notice(ch, joinedLine(ch.name, nameOf(target)), 'join', target, who)
        emitChannel(ch)
        const members = Object.keys(ch.members).filter((m) => m !== target).map(nameOf)
        const text = joinedNotice(ch.name, who === target ? undefined : nameOf(who), members, api.delivery.routeOf(target), api.delivery.hasTools(target), nameOf(target))
        await fanout(ch, line, undefined, new Map([[target, text]]))
        return { ok: true as const, channel: ch, already: false, line }
      })
    },

    leave(agent, id) {
      return lane(id, async () => {
        const name = nameOf(agent)
        const done = await store.leave(id, agent)
        if (!done.ok) return done
        const ch = done.channel
        cancelWaiting(agent, id)
        forgetMissed(agent, id)
        const line = await notice(ch, leftLine(ch.name, name), 'leave', agent, agent)
        if (done.endedOwner) await ownerEnded(ch, agent, name)
        emitChannel(ch)
        await fanout(ch, line)
        await settlePolls(ch)
        return { ok: true as const, channel: ch, line }
      })
    },

    remove(who, id, agent) {
      return lane(id, async () => {
        const ch = store.get(id)
        if (!ch) return fail('unknown-channel')
        if (!mayModerate(who, ch)) return fail('not-owner')
        const name = nameOf(agent)
        const done = await store.remove(id, agent)
        if (!done.ok) return done
        cancelWaiting(agent, id)
        forgetMissed(agent, id)
        const line = await notice(ch, removedLine(ch.name, name), 'remove', agent, who)
        if (done.endedOwner) await ownerEnded(ch, agent, name)
        emitChannel(ch)
        // The removed one is no longer a member: it gets its own notice apart from the fan-out.
        if (!isAway(agent)) await send(agent, noticeOf(ch, removedNotice(ch.name, nameOf(who)), line.seq))
        await fanout(ch, line)
        await settlePolls(ch)
        return { ok: true as const, channel: ch, line }
      })
    },

    mute(who, id, agent) {
      return lane(id, async () => {
        const ch = store.get(id)
        if (!ch) return fail('unknown-channel')
        if (!mayModerate(who, ch)) return fail('not-owner')
        const done = await store.mute(id, agent, who)
        if (!done.ok) return done
        if (!done.changed) return { ok: true as const, channel: ch, changed: false }
        const line = await notice(ch, mutedLine(ch.name, nameOf(agent), nameOf(who)), 'mute', agent, who)
        emitChannel(ch)
        // P9: the line is in the conversation for everyone; the notice goes to the one muted.
        await tell(agent, ch, mutedNotice(ch.name, nameOf(who)), line)
        return { ok: true as const, channel: ch, changed: true, line }
      })
    },

    unmute(who, id, agent) {
      return lane(id, async () => {
        const ch = store.get(id)
        if (!ch) return fail('unknown-channel')
        if (!mayModerate(who, ch)) return fail('not-owner')
        const done = await store.unmute(id, agent)
        if (!done.ok) return done
        if (!done.changed) return { ok: true as const, channel: ch, changed: false }
        const line = await notice(ch, unmutedLine(ch.name, nameOf(agent)), 'unmute', agent, who)
        emitChannel(ch)
        await tell(agent, ch, unmutedNotice(ch.name), line)
        return { ok: true as const, channel: ch, changed: true, line }
      })
    },

    close(who, id) {
      return lane(id, async () => {
        const ch = store.get(id)
        if (!ch) return fail('unknown-channel')
        const refusal = closeRefusal(who, ch)
        if (refusal) return fail(refusal)
        const done = await store.close(id, who)
        if (!done.ok) return done
        for (const agent of Object.keys(ch.members)) { cancelWaiting(agent, id); forgetMissed(agent, id) }
        await closeAllPolls(ch)
        const line = await notice(ch, closedLine(ch.name, nameOf(who)), 'close', undefined, who)
        emitChannel(ch)
        await fanout(ch, line, who === USER ? undefined : who)
        return { ok: true as const, channel: ch, line }
      })
    },

    reopen(who, id) {
      return lane(id, async () => {
        const ch = store.get(id)
        if (!ch) return fail('unknown-channel')
        const refusal = reopenRefusal(who, ch)
        if (refusal) return fail(refusal)
        const done = await store.reopen(id)
        if (!done.ok) return done
        const line = await notice(ch, reopenedLine(ch.name, nameOf(who)), 'reopen', undefined, who)
        emitChannel(ch)
        await fanout(ch, line, who === USER ? undefined : who)
        return { ok: true as const, channel: ch, line }
      })
    },

    async forgotten(agent, name) {
      turns.delete(agent)
      for (const key of [...rates.keys()]) if (key.startsWith(`${agent} `)) rates.delete(key)
      forgetMissed(agent)
      for (const key of [...pending.keys()]) if (key.startsWith(`${agent} `)) untrack(key)
      const ids = store.channelsOf(agent).map((c) => c.id)
      if (ids.length === 0) return
      const label = name ?? nameOf(agent)
      // One index write for every channel; then each channel's line and fan-out in its own lane.
      const gone = await store.forget(agent)
      await Promise.all(gone.map(({ channel: ch, endedOwner }) => lane(ch.id, async () => {
        const line = await notice(ch, forgottenLine(ch.name, label), 'leave', agent)
        if (endedOwner) await ownerEnded(ch, agent, label)
        emitChannel(ch)
        await fanout(ch, line)
        await settlePolls(ch)
      })))
    },

    async spawned(agent) {
      // A poll still open that never reached it: the request now, with the time that is left.
      await Promise.all(store.channelsOf(agent).filter((c) => openPolls(c).some((p) => owesRequest(c, p, agent)))
        .map((c) => lane(c.id, async () => { for (const p of openPolls(c)) await ask(c, p, [agent]) })))
      const per = missed.get(agent)
      if (!per) return
      missed.delete(agent)
      await Promise.all([...per].map(([id, t]) => lane(id, async () => {
        const ch = store.get(id)
        if (!ch || !Object.hasOwn(ch.members, agent)) return
        // What still waited from before it stopped joins the same notice.
        const w = untrack(keyOf(agent, id))
        const cancelled = w !== undefined && api.delivery.cancel(w.receipt)
        if (cancelled) merge(t, w)
        const msg = noticeOf(ch, returnNotice(ch.name, t, api.delivery.routeOf(agent), api.delivery.hasTools(agent)))
        // Reactions that rode on the cancelled delivery ride again on the return notice.
        const from = cancelled ? w.rideFrom : undefined
        const got = from !== undefined ? await ride(agent, msg, from, tailOnce(id)) : undefined
        const r = await send(agent, msg)
        if (r) track(agent, id, r, got?.text ? { ...t, rideFrom: from! } : t)
        if (r && got) await rode(agent, ch, got)
      })))
    },

    dispose() {
      disposed = true
      if (clockTimer !== undefined) clock.clear(clockTimer)
      clockTimer = undefined
      clockAt = undefined
      own.dispose()
      pending.clear()
      byReceipt.clear()
      missed.clear()
      turns.clear()
      rates.clear()
    },
  }
  // A deadline that passed while the tether was down rings at once.
  arm()
  // A called that runs and was never asked (it came back while the tether was down) is asked now; `asked` keeps the others.
  void Promise.all(store.channels().filter((c) => openPolls(c).length).map((c) => lane(c.id, async () => {
    for (const p of openPolls(c)) await ask(c, p, p.to.map((t) => t.id))
  }))).catch((e: unknown) => api.log(`canais: pedidos de enquete na volta: ${(e as Error).message}`))
  return channels
}

/** The fan-out wired into the extension: the store opens once tetherd owns its pipe; slot events reach it after that. */
export function wireChannels(
  api: ChannelsApi & Pick<TetherDaemon, 'io' | 'home' | 'onSlot' | 'onStarted'>,
  open: (api: Pick<TetherDaemon, 'io' | 'home' | 'log'>) => Promise<ChannelStore>,
): { ready: Promise<Channels>; disposables: IDisposable[] } {
  let live: Channels | undefined
  let disposed = false
  let resolve!: (c: Channels) => void
  const ready = new Promise<Channels>((r) => { resolve = r })
  const disposables: IDisposable[] = [
    api.onStarted(() => {
      open(api).then((store) => {
        if (disposed) return
        live = createChannels(api, store)
        resolve(live)
      }).catch((e: unknown) => api.log(`o registro dos canais não abriu: ${(e as Error).message}`))
    }),
    api.onSlot((ev) => {
      const id = ev.slot.slotId
      if (ev.kind === 'removed') void ready.then((c) => c.forgotten(id, slotTitle(ev.slot))).catch((e: unknown) => api.log(`canais: guia esquecida ${id}: ${(e as Error).message}`))
      else if (ev.kind === 'spawned') void ready.then((c) => c.spawned(id)).catch((e: unknown) => api.log(`canais: volta de ${id}: ${(e as Error).message}`))
    }),
    toDisposable(() => { disposed = true; live?.dispose() }),
  ]
  return { ready, disposables }
}
