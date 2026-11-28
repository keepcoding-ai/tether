// The Regency's source over a live session (RR3 step 3.4c): the three readings of the contract (`regency.tree`,
// `channels.marks`, `channels.page`) asked through the session, and its two thin notices (`regency.changed`,
// `channels.changed`) handed on as "read again". Every body is checked for the contract's shape before the screen sees it:
// a body of the wrong shape is thrown away (the reading fails as `malformed`, the screen keeps what it has), and one of the
// right shape goes through the house's own projectors (src/remote/projection.ts), so a field the contract does not name,
// a control character or a machine's path does not reach the page even if the house sent it.
//
// Pace (the portal counts 120 requests a minute per device, every session together, and closes the session that insists):
// one reading of each family in flight, a call made meanwhile joins the next one (the last state wins); at most
// READS_PER_MIN readings in a rolling minute, the rest waits; an answer "limit" (0x07) holds every reading for
// LIMIT_HOLD_MS and asks once more. Nothing is kept on the device: what is read lives in the memory of the screen.
import { EVT, opByName, RES_STATUS } from '../../../src/remote/index.ts'
import {
  channelsChanged, channelsMarks, channelsPage, PAGE_LINES_MAX, regencyChanged, regencyTree,
  type ChannelsChangedSource, type MarksSource, type PagePollState, type RegencyChanged,
} from '../../../src/remote/projection.ts'
import type { PollState } from '../../../extensions/channels/daemon/requests.ts'
import { SourceRefused, type MarksAnswer, type PageAnswer, type RefusedWhy, type RemoteNotice, type RemoteSource, type TreeAnswer } from './host.ts'
import type { Reply } from './live.ts'

/** What the source needs of a session: one request, answered with its status and its JSON body (status -1: it ended). */
export interface SourceSession { request(op: number, body: Record<string, unknown>): Promise<Reply> }

export interface SessionSourceOptions {
  now?: () => number
  wait?: (ms: number) => Promise<void>
  /** A reading answered "trancado" (0x04): the session asks for presence before it reads again. */
  onLocked?: () => void
  /** The house answered: it was seen alive now. */
  onContact?: () => void
}

export interface SessionSource extends RemoteSource {
  /** An event of the session. True when it was one of the Regency's (taken here), false when it belongs to someone else. */
  heard(evt: number, body: Record<string, unknown>): boolean
  /** The session is over: every reading still waiting fails as `gone`, and nothing more is asked. */
  dispose(): void
}

/** Readings a rolling minute may hold: under the portal's 120, leaving room for the session's other requests. */
export const READS_PER_MIN = 90
const MINUTE_MS = 60_000
/** How long every reading waits after the portal said "limit". */
export const LIMIT_HOLD_MS = 10_000

const OP = {
  tree: opByName('regency.tree')!.code,
  marks: opByName('channels.marks')!.code,
  page: opByName('channels.page')!.code,
}

const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const isInt = (v: unknown, min = 0): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min
const malformed = (): SourceRefused => new SourceRefused('malformed')

// ---- the shapes (a body that does not have them is thrown away)

export function treeOf(b: Record<string, unknown>): TreeAnswer {
  const i = b.input
  if (!isRec(i) || typeof b.live !== 'boolean' || !isRec(i.desks) || !Array.isArray(i.desks.desks) || !Array.isArray(i.channels)
    || !Array.isArray(i.agents) || (b.asOf !== undefined && !isInt(b.asOf)) || (b.sig !== undefined && typeof b.sig !== 'string')) throw malformed()
  // The house already left out what the device's scopes do not cover: keep what came.
  return regencyTree({ view: b, channels: true })
}

/** `moderator` of an answer: absent from an old house (the name is then `''`), else a record with a string name. */
const moderatorOk = (v: unknown): boolean => v === undefined || (isRec(v) && typeof v.name === 'string')
/** A list the contract says is always there: absent from an old house, else a list. */
const listOk = (v: unknown): boolean => v === undefined || Array.isArray(v)

export function marksOf(b: Record<string, unknown>): MarksAnswer {
  if (!Array.isArray(b.channels) || !isInt(b.more) || !moderatorOk(b.moderator)
    || !b.channels.every(r => !isRec(r) || listOk(r.members))) throw malformed()
  const m = channelsMarks(b as unknown as MarksSource)
  return { channels: m.channels, more: b.more, moderator: m.moderator }
}

/** The app's pane holds an open poll's votes by who voted; the wire sends them as a list. */
function pollOf(p: PagePollState): PollState {
  const open = p.open
  return {
    seq: p.seq,
    ...(open ? {
      open: {
        seq: p.seq, type: open.type, question: open.question, options: open.options, to: open.to, closesAt: open.closesAt, author: open.author,
        votes: Object.fromEntries(open.votes.filter(v => v.id !== '').map(v => [v.id, { option: v.option, name: v.name, at: '', ...(v.reason ? { reason: v.reason } : {}) }])),
      },
    } : {}),
    ...(p.result ? { result: p.result } : {}),
    ...(p.closedAt ? { closedAt: p.closedAt } : {}),
  }
}

export function pageOf(b: Record<string, unknown>, channel: string, before: number | undefined): PageAnswer {
  const ch = b.channel
  if (!isRec(ch) || ch.id !== channel || !Array.isArray(b.lines) || !Array.isArray(b.reactions) || !Array.isArray(b.polls)
    || !isInt(b.last) || (b.before !== undefined && !isInt(b.before, 1)) || !listOk(b.members) || !moderatorOk(b.moderator)
    || (b.membersMore !== undefined && !isInt(b.membersMore, 1))) throw malformed()
  // The projector reads an open poll's votes as tetherd keeps them (by who voted); the wire carries them as a list. The
  // projector is not idempotent: run on its own output it reads the list's indexes as voters. So the list goes back to
  // tetherd's map before the cleaning (the first vote of an id stands), and pollOf gives the pane its map after. Keep this
  // while src/remote/projection.ts reads `votes` as a map (test/unit/remote.web-source.test.ts holds it).
  const polls = b.polls.map(p0 => {
    if (!isRec(p0) || !isRec(p0.open) || !Array.isArray(p0.open.votes)) return p0
    const votes: Record<string, unknown> = {}
    for (const v of p0.open.votes) if (isRec(v) && typeof v.id === 'string' && !Object.hasOwn(votes, v.id)) votes[v.id] = v
    return { ...p0, open: { ...p0.open, votes } }
  })
  const p = channelsPage({ answer: { ...b, polls }, limit: PAGE_LINES_MAX, ...(before !== undefined ? { before } : {}) })
  // The cursor is the house's (it may have cut the page by size); one that does not go back is no cursor (no loop on it).
  const cursor = b.before as number | undefined
  const ceiling = before ?? p.last + 1
  return {
    channel: p.channel, lines: p.lines, reactions: p.reactions, polls: p.polls.map(pollOf), last: p.last,
    members: p.members, moderator: p.moderator, ...(p.membersMore !== undefined ? { membersMore: p.membersMore } : {}),
    ...(cursor !== undefined && cursor < ceiling ? { before: cursor } : {}),
  }
}

/**
 * A poll's card as a write answers it (`state` of channels.vote and channels.poll, the page's own shape), through the same
 * checks as a page's poll: undefined when it does not have the shape.
 */
export function pollStateOf(channel: string, state: unknown): PollState | undefined {
  if (!isRec(state)) return undefined
  try { return pageOf({ channel: { id: channel }, lines: [], reactions: [], polls: [state], last: 0 }, channel, undefined).polls[0] } catch { return undefined }
}

// ---- one family in flight

/** One call in flight; the calls made meanwhile share the one that follows it. */
class Lane<T> {
  private running: Promise<T> | undefined
  private queued: Promise<T> | undefined

  run(f: () => Promise<T>): Promise<T> {
    if (!this.running) return this.start(f)
    if (!this.queued) {
      const after = this.running.then(() => undefined, () => undefined)
      this.queued = after.then(() => { this.queued = undefined; return this.start(f) })
    }
    return this.queued
  }

  private start(f: () => Promise<T>): Promise<T> {
    const p = f()
    this.running = p
    const clear = (): void => { if (this.running === p) this.running = undefined }
    p.then(clear, clear)
    return p
  }
}

// ---- the source

export function sessionSource(session: SourceSession, o: SessionSourceOptions = {}): SessionSource {
  const now = o.now ?? Date.now
  const wait = o.wait ?? ((ms: number) => new Promise<void>(done => setTimeout(done, ms)))
  const listeners = new Set<(n: RemoteNotice) => void>()
  const stamps: number[] = []
  let holdUntil = 0
  let disposed = false
  /** Ends every request still in flight when the source is disposed (the session may never answer them). */
  let kill: () => void = () => {}
  const dead = new Promise<Reply>(done => { kill = () => done({ status: -1, body: {} }) })
  /** The tree held: a `regency.changed` with its `sig` and its `live` is the same tree (skipped). */
  let held: { sig?: string; live: boolean } | undefined

  const gone = (): SourceRefused => new SourceRefused('gone')

  const pace = async (): Promise<void> => {
    for (;;) {
      if (disposed) throw gone()
      const t = now()
      while (stamps.length > 0 && stamps[0]! <= t - MINUTE_MS) stamps.shift()
      const until = Math.max(holdUntil, stamps.length >= READS_PER_MIN ? stamps[0]! + MINUTE_MS : 0)
      if (until <= t) { stamps.push(t); return }
      await wait(until - t)
    }
  }

  const whyOf = (r: Reply): RefusedWhy => {
    switch (r.status) {
      case RES_STATUS.noScope: return 'no-scope'
      case RES_STATUS.locked: return 'locked'
      case RES_STATUS.notFound: return 'not-found'
      case RES_STATUS.limit: return 'limit'
      case RES_STATUS.badRequest: return 'malformed'
      default: return r.body.error === 'too-large' ? 'too-large' : 'failed'
    }
  }

  const ask = async (op: number, body: Record<string, unknown>): Promise<Record<string, unknown>> => {
    for (let attempt = 0; ; attempt++) {
      await pace()
      const r = await Promise.race([session.request(op, body), dead])
      if (disposed || r.status === -1) throw gone()
      o.onContact?.()
      if (r.status === RES_STATUS.ok) return r.body
      if (r.status === RES_STATUS.limit && attempt === 0) { holdUntil = Math.max(holdUntil, now() + LIMIT_HOLD_MS); continue }
      const why = whyOf(r)
      if (why === 'locked') o.onLocked?.()
      throw new SourceRefused(why)
    }
  }

  const treeLane = new Lane<TreeAnswer>()
  const marksLane = new Lane<MarksAnswer>()
  // Pages go one at a time; the same page asked again while it waits is the same reading.
  let pageChain: Promise<unknown> = Promise.resolve()
  const pagesWaiting = new Map<string, Promise<PageAnswer>>()

  const readTree = async (): Promise<TreeAnswer> => {
    const t = treeOf(await ask(OP.tree, {}))
    held = { live: t.live, ...(t.sig !== undefined ? { sig: t.sig } : {}) }
    return t
  }

  const readPage = async (channel: string, before: number | undefined): Promise<PageAnswer> =>
    pageOf(await ask(OP.page, { channel, ...(before !== undefined ? { before } : {}) }), channel, before)

  const emit = (n: RemoteNotice): void => {
    for (const l of [...listeners]) { try { l(n) } catch (e) { console.error('remote source listener', e) } }
  }

  return {
    tree: () => treeLane.run(readTree),
    marks: () => marksLane.run(async () => marksOf(await ask(OP.marks, {}))),
    page: (channel, before) => {
      if (disposed) return Promise.reject(gone())
      const key = `${channel}\u0000${before ?? ''}`
      const known = pagesWaiting.get(key)
      if (known) return known
      const p = pageChain.then(() => undefined, () => undefined).then(() => { pagesWaiting.delete(key); return readPage(channel, before) })
      pageChain = p
      pagesWaiting.set(key, p)
      return p
    },
    onNotice: listener => { listeners.add(listener); return { dispose: () => { listeners.delete(listener) } } },
    heard: (evt, body) => {
      if (evt === EVT.channelsChanged.code) {
        if (disposed || !Array.isArray(body.channels)) return true
        const n = channelsChanged(body as unknown as ChannelsChangedSource)
        emit({ what: 'channels', channels: n.channels, ...(n.all ? { all: true } : {}) })
        return true
      }
      if (evt === EVT.regencyChanged.code) {
        if (disposed || typeof body.live !== 'boolean') return true
        const n = regencyChanged(body as unknown as RegencyChanged)
        if (held && n.sig !== undefined && n.sig === held.sig && n.live === held.live) return true
        emit({ what: 'regency' })
        return true
      }
      return false
    },
    dispose: () => { disposed = true; listeners.clear(); kill() },
  }
}
