// The channels' marks in tetherd (RR3 step 3.3): what a remote device shows of each channel (unread, said to her, reactions
// that ask her, polls that wait for her vote, the first call) with the very rule of the app (../mark-board.ts). The app keeps
// its board live from the events; here a board is built when asked, from what the record already keeps: the channel's
// `seenByUser` (the person's "seen", the same number the app raises with `seen`), the lines after it and the open polls of
// the index. A restart of tetherd changes nothing: what is held between requests is only a memo of the answer.
//
// Cost (RR3 gate M-1): a channel's board reads ONE window, the last max(MAX_HELD, REACTION_WINDOW) lines, once (the reactions
// that ask her and the lines after "seen" are both inside it), plus one line per owed poll older than that; never the whole
// channel. The reads go by `peekTail` / `peek`, which leave the store's tail cache as the app left it. `allMarks` keeps, per
// channel, the last marks with what they were built from (last seq, "seen", the owed polls, the name): a channel that did not
// change is not read again. Memory: one row per open channel of the store, dropped when the channel closes or goes.
import { MAX_HELD, MarkBoard, type ChannelMarks, type FirstCall, type PollOwed } from '../mark-board.ts'
import { isCalled, personAsks, REACTION_WINDOW, USER, type Ask, type Channel, type ChannelId } from '../rules.ts'
import type { ChannelStore } from './store.ts'

/** What the remote marks read of the store: never the app's tail cache order. */
export type PeekStore = Pick<ChannelStore, 'peekTail' | 'peek'>
export type MarksStore = Pick<ChannelStore, 'channels' | 'peekTail' | 'peek' | 'knownLast'>

/** What calls the person now beyond the lines: the reactions that ask her (after "seen") and the open polls that wait for her vote. */
export interface Pending { last: number; asks: Ask[]; polls: PollOwed[] }

/** The open polls of the index that wait for her vote. No "seen" mark clears a poll. */
function owedOf(ch: Channel): PollOwed[] {
  return ch.closed ? [] : Object.values(ch.polls ?? {})
    .filter((p) => isCalled(ch, p, USER) && !Object.hasOwn(p.votes, USER)).map((p) => ({ seq: p.seq, closesAt: p.closesAt }))
}

/** The `asks` request's answer (the app's): the channel's tail (one read) and the open polls of the index. */
export async function pendingOf(store: Pick<ChannelStore, 'lastSeq' | 'since'>, ch: Channel): Promise<Pending> {
  const last = await store.lastSeq(ch.id)
  const tail = last > ch.seenByUser ? await store.since(ch.id, Math.max(0, last - REACTION_WINDOW), REACTION_WINDOW) : []
  return { last, asks: personAsks(tail).filter((k) => k.seq > ch.seenByUser), polls: owedOf(ch) }
}

/** One channel's marks as the `marks` request gives them: counts, never the lists (the device asks the channel for those). */
export interface RemoteMarks extends ChannelMarks {
  channel: ChannelId
  name: string
  /** The reactions that ask her and she has not seen. */
  asks: number
  /** The open polls that wait for her vote. */
  owed: number
  firstCall?: FirstCall
  /** The ids of the agents in the channel now (the person is in every one): a remote screen lists an agent's channels by them. */
  members: string[]
}

/** The lines one board reads: both the reaction window and the lines after "seen" end at the last line. */
const WINDOW = Math.max(MAX_HELD, REACTION_WINDOW)

async function build(store: PeekStore, ch: Channel, moderator: string, polls: PollOwed[]): Promise<{ last: number; marks: RemoteMarks }> {
  const board = new MarkBoard()
  const id = ch.id
  board.baseline(id, ch.seenByUser)
  const { last, lines } = await store.peekTail(id, WINDOW)
  const asks = last > ch.seenByUser ? personAsks(lines.filter((l) => l.seq > last - REACTION_WINDOW)).filter((k) => k.seq > ch.seenByUser) : []
  board.setOwed(id, polls)
  const from = Math.max(ch.seenByUser, last - MAX_HELD)
  // A poll that waits for her vote keeps its question for the first call even when its line is older than the window.
  for (const p of polls) {
    if (p.seq > from) continue
    const [line] = await store.peek(id, p.seq, p.seq)
    if (line?.seq === p.seq) board.hear(id, line, moderator)
  }
  for (const line of lines) if (line.seq > from) board.hear(id, line, moderator)
  board.setAsks(id, asks)
  const call = board.firstCall(id)
  return {
    last,
    marks: {
      channel: id, name: ch.name, ...board.of(id),
      asks: board.asksOf(id).length, owed: board.owedOf(id).length, ...(call ? { firstCall: call } : {}),
      members: Object.keys(ch.members),
    },
  }
}

/** The marks of one channel, by the app's rule over the lines after the person's "seen". */
export async function marksOf(store: PeekStore, ch: Channel, moderator: string): Promise<RemoteMarks> {
  return (await build(store, ch, moderator, owedOf(ch))).marks
}

interface Memo { key: string; marks: RemoteMarks }
/** Per store, per channel: the last marks and what they were built from. */
const memos = new WeakMap<object, Map<ChannelId, Memo>>()
const keyOf = (ch: Channel, last: number, seen: number, polls: readonly PollOwed[], moderator: string): string =>
  JSON.stringify([last, seen, ch.name, moderator, polls.map((p) => [p.seq, p.closesAt]), Object.keys(ch.members)])

/** The marks of every open channel of the person, one channel at a time; a channel that did not change is not read again. */
export async function allMarks(store: MarksStore, moderator: string): Promise<RemoteMarks[]> {
  let memo = memos.get(store)
  if (!memo) memos.set(store, (memo = new Map()))
  const out: RemoteMarks[] = []
  const open = new Set<ChannelId>()
  for (const ch of store.channels()) {
    if (ch.closed) continue
    open.add(ch.id)
    const polls = owedOf(ch)
    const known = store.knownLast(ch.id)
    const held = memo.get(ch.id)
    const seen = ch.seenByUser
    if (held && known !== undefined && held.key === keyOf(ch, known, seen, polls, moderator)) { out.push(held.marks); continue }
    const { last, marks } = await build(store, ch, moderator, polls)
    memo.set(ch.id, { key: keyOf(ch, last, seen, polls, moderator), marks })
    out.push(marks)
  }
  for (const id of memo.keys()) if (!open.has(id)) memo.delete(id)
  return out
}
