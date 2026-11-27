// The channels' marks in tetherd (RR3 step 3.3): what a remote device shows of each channel (unread, said to her, reactions
// that ask her, polls that wait for her vote, the first call) with the very rule of the app (../mark-board.ts). The app keeps
// its board live from the events; here a board is built when asked, from what the record already keeps: the channel's
// `seenByUser` (the person's "seen", the same number the app raises with `seen`), the lines after it and the open polls of
// the index. Nothing is held between requests, so a restart of tetherd changes nothing.
// Memory and reads: one channel at a time, at most MAX_HELD lines after "seen" plus the REACTION_WINDOW tail plus one line per
// owed poll older than that; never the whole channel.
import { MAX_HELD, MarkBoard, type ChannelMarks, type FirstCall, type PollOwed } from '../mark-board.ts'
import { isCalled, personAsks, REACTION_WINDOW, USER, type Ask, type Channel, type ChannelId } from '../rules.ts'
import type { ChannelStore } from './store.ts'

export type MarksStore = Pick<ChannelStore, 'channels' | 'lastSeq' | 'since'>

/** What calls the person now beyond the lines: the reactions that ask her (after "seen") and the open polls that wait for her vote. */
export interface Pending { last: number; asks: Ask[]; polls: PollOwed[] }

/** The `asks` request's answer: the channel's tail (one read) and the open polls of the index. No "seen" mark clears a poll. */
export async function pendingOf(store: Pick<ChannelStore, 'lastSeq' | 'since'>, ch: Channel): Promise<Pending> {
  const last = await store.lastSeq(ch.id)
  const tail = last > ch.seenByUser ? await store.since(ch.id, Math.max(0, last - REACTION_WINDOW), REACTION_WINDOW) : []
  const polls: PollOwed[] = ch.closed ? [] : Object.values(ch.polls ?? {})
    .filter((p) => isCalled(ch, p, USER) && !Object.hasOwn(p.votes, USER)).map((p) => ({ seq: p.seq, closesAt: p.closesAt }))
  return { last, asks: personAsks(tail).filter((k) => k.seq > ch.seenByUser), polls }
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
}

/** The marks of one channel, by the app's rule over the lines after the person's "seen". */
export async function marksOf(store: Pick<ChannelStore, 'lastSeq' | 'since'>, ch: Channel, moderator: string): Promise<RemoteMarks> {
  const board = new MarkBoard()
  const id = ch.id
  board.baseline(id, ch.seenByUser)
  const { last, asks, polls } = await pendingOf(store, ch)
  board.setOwed(id, polls)
  const from = Math.max(ch.seenByUser, last - MAX_HELD)
  // A poll that waits for her vote keeps its question for the first call even when its line is older than what is read below.
  for (const p of polls) {
    if (p.seq > from) continue
    const [line] = await store.since(id, p.seq - 1, 1)
    if (line?.seq === p.seq) board.hear(id, line, moderator)
  }
  if (last > from) for (const line of await store.since(id, from, MAX_HELD)) board.hear(id, line, moderator)
  board.setAsks(id, asks)
  const call = board.firstCall(id)
  return {
    channel: id, name: ch.name, ...board.of(id),
    asks: board.asksOf(id).length, owed: board.owedOf(id).length, ...(call ? { firstCall: call } : {}),
  }
}

/** The marks of every open channel of the person, one channel at a time. */
export async function allMarks(store: MarksStore, moderator: string): Promise<RemoteMarks[]> {
  const out: RemoteMarks[] = []
  for (const ch of store.channels()) if (!ch.closed) out.push(await marksOf(store, ch, moderator))
  return out
}
