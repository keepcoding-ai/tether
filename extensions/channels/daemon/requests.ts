// The moderator's requests (contract 5.2) over the extension seam of the pipe (N1): the channel's pane asks, the daemon answers.
// A thin shell over the fan-out (fanout.ts): every refusal of the rules comes back as the request's error with the same code
// as the verbs (`not-owner`, `closed`, `unknown-channel`...). Reading (`list`, `members`, `history`) is open to every client;
// the gestures and the speech are the person's, so only the `app` client makes them (`not-moderator` otherwise).
// Memory: one timer for every channel (`seen`), cleared on dispose.
import { slotIsLive } from '../../../app/shared/agent-info.ts'
import { toDisposable, type IDisposable } from '../../../app/shared/vscode-lifecycle.ts'
import { DoorError } from '../../../src/daemon/door/port.ts'
import type { ExtRequestContext } from '../../../src/daemon/door/types.ts'
import type { TetherDaemon } from '../../../src/daemon/ext-api.ts'
import type { ErrorCode } from '../../../src/daemon/protocol.ts'
import { personAsks, REACTION_WINDOW, sumReactions, USER, type Channel, type ChannelId, type Line, type OpenPoll, type PollResult, type ReactionTally } from '../rules.ts'
import type { Channels, Outcome } from './fanout.ts'
import { PAGE } from './store.ts'

/** How long `seen` waits before it writes the index: a pane that scrolls sends many. */
export const SEEN_DELAY_MS = 1500

export type RequestsApi = Pick<TetherDaemon, 'requests' | 'slots' | 'delivery'>

/** The channel as the pane lists it. */
export interface ChannelSummary {
  id: ChannelId
  name: string
  title: string
  desk?: string
  owner: { kind: 'user' } | { kind: 'agent'; id: string; name: string }
  ownerEnded?: Channel['ownerEnded']
  closed?: Channel['closed']
  /** How many members. */
  members: number
  seenByUser: number
  createdAt: string
}

export interface MemberInfo {
  id: string
  name: string
  muted: boolean
  since: string
  by: string
  alive: boolean
  path: 'inside' | 'terminal' | 'wait' | 'away'
}

export function summaryOf(ch: Channel): ChannelSummary {
  return {
    id: ch.id, name: ch.name, title: ch.title, ...(ch.desk !== undefined ? { desk: ch.desk } : {}),
    owner: ch.owner, ...(ch.ownerEnded ? { ownerEnded: ch.ownerEnded } : {}), ...(ch.closed ? { closed: ch.closed } : {}),
    members: Object.keys(ch.members).length, seenByUser: ch.seenByUser, createdAt: ch.createdAt,
  }
}

/** The reactions of one message as the pane draws them: who gave which emoji, in the order they came. */
export interface MessageReactions { seq: number; tallies: ReactionTally[] }

/** An open poll as the pane gets it: the votes now, never the receipts of the deliveries. */
export type PollOpenView = Omit<OpenPoll, 'asked' | 'changes'>

/**
 * What the pane draws of one poll line: the poll still open (`open`), or its result (`result`, with the close line's time), or
 * neither when it closed long ago (the index keeps the last POLLS_CLOSED_KEPT results): then the card only says it closed.
 */
export interface PollState { seq: number; open?: PollOpenView; result?: PollResult; closedAt?: string }

export const openView = (p: OpenPoll): PollOpenView => {
  const { asked: _asked, changes: _changes, ...rest } = p
  return rest
}

/** A line the pane never draws as a row of the conversation: a reaction, a vote and a poll's close (the card shows them). */
const apart = (l: Line): boolean => l.kind === 'reaction' || l.kind === 'vote' || (l.kind === 'notice' && l.event?.type === 'poll-close')

/**
 * The sum of the reactions of the messages of a page. A reaction to a message sits within REACTION_WINDOW lines after it, so the page
 * and that much past its end are read (the same bound as `channels read`: never the whole channel, a file or two).
 */
function reactionsOf(page: readonly Line[], after: readonly Line[], lines: readonly Line[]): MessageReactions[] {
  if (!lines.some((l) => l.kind === 'message')) return []
  const sums = sumReactions([...page, ...after])
  const out: MessageReactions[] = []
  for (const l of lines) {
    const tallies = l.kind === 'message' ? sums.get(l.seq) : undefined
    if (tallies?.length) out.push({ seq: l.seq, tallies })
  }
  return out
}

/**
 * The state of each poll among `lines`: the index for an open one; for a closed one its result line, found among the page and what
 * follows it, or where the index says the last closed ones are (one line read each, never a scan).
 */
async function pollsOf(c: Channels, ch: Channel, lines: readonly Line[], near: readonly Line[]): Promise<PollState[]> {
  const results = new Map<number, Line>()
  for (const l of near) if (l.kind === 'notice' && l.event?.type === 'poll-close' && l.result) results.set(l.result.poll, l)
  const out: PollState[] = []
  for (const l of lines) {
    if (l.kind !== 'poll') continue
    const open = ch.polls?.[String(l.seq)]
    if (open) { out.push({ seq: l.seq, open: openView(open) }); continue }
    let closed = results.get(l.seq)
    const at = closed ? undefined : ch.pollsClosed?.find((p) => p.poll === l.seq)?.line
    if (at !== undefined) closed = (await c.store.since(ch.id, at - 1, 1)).find((x) => x.seq === at)
    out.push({ seq: l.seq, ...(closed?.result ? { result: closed.result, closedAt: closed.at } : {}) })
  }
  return out
}

const refuse =(code: string, message: string): DoorError => new DoorError(code as ErrorCode, message)

const asRecord = (args: unknown): Record<string, unknown> => {
  if (args === undefined || args === null) return {}
  if (typeof args !== 'object' || Array.isArray(args)) throw refuse('bad-request', 'os argumentos do pedido são um objeto')
  return args as Record<string, unknown>
}
const text = (a: Record<string, unknown>, key: string, optional = false): string => {
  const v = a[key]
  if (typeof v === 'string' && v !== '') return v
  if (optional && v === undefined) return ''
  throw refuse('bad-request', `o argumento ${key} é um texto`)
}
const int = (a: Record<string, unknown>, key: string): number | undefined => {
  const v = a[key]
  if (v === undefined) return undefined
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw refuse('bad-request', `o argumento ${key} é um inteiro`)
  return v
}
const names = (a: Record<string, unknown>, key: string): string[] | undefined => {
  const v = a[key]
  if (v === undefined) return undefined
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw refuse('bad-request', `o argumento ${key} é uma lista de textos`)
  return v as string[]
}

/** Registers the requests; they wait for `ready` (the record opens once tetherd owns its pipe). */
export function registerChannelRequests(api: RequestsApi, ready: Promise<Channels>, delayMs = SEEN_DELAY_MS): IDisposable[] {
  let timer: NodeJS.Timeout | undefined
  let channels: Channels | undefined
  void ready.then((c) => { channels = c }, () => {})

  const live = async (): Promise<Channels> => channels ?? ready
  const moderator = (ctx: ExtRequestContext): void => {
    if (ctx.client !== 'app') throw refuse('not-moderator', 'só o app fala e age como moderador')
  }
  const channelOf = (c: Channels, a: Record<string, unknown>): Channel => {
    const ch = c.store.get(text(a, 'channel'))
    if (!ch) throw refuse('unknown-channel', 'não há canal com esse id')
    return ch
  }
  const done = <T extends object>(r: Outcome<T>): { ok: true } & T => {
    if (!r.ok) throw refuse(r.error, `recusado: ${r.error}`)
    return r
  }
  const agentOf = (a: Record<string, unknown>): string => text(a, 'agent')

  const handlers: Array<[string, (c: Channels, a: Record<string, unknown>, ctx: ExtRequestContext) => unknown | Promise<unknown>]> = [
    ['list', (c, a) => ({
      channels: c.store.channels().filter((ch) => a.closed === true || !ch.closed).map(summaryOf),
    })],

    ['members', (c, a) => {
      const ch = channelOf(c, a)
      const members: MemberInfo[] = Object.entries(ch.members).map(([id, m]) => {
        const slot = api.slots.get(id)
        const alive = slot !== undefined && slotIsLive(slot)
        return { id, name: c.nameOf(id), muted: m.muted !== undefined, since: m.since, by: m.by, alive, path: alive ? api.delivery.routeOf(id) : 'away' }
      })
      return { channel: summaryOf(ch), members, removed: ch.removed ?? [] }
    }],

    ['history', async (c, a) => {
      const ch = channelOf(c, a)
      const before = int(a, 'before')
      const limit = Math.min(Math.max(int(a, 'limit') ?? PAGE, 1), PAGE)
      const page: Line[] = await c.store.history(ch.id, before, limit)
      // Reaction lines are not conversation: the pane gets the messages and, apart, the sum of the reactions of each of them.
      // A poll is: its opening line stays, with its state apart (`polls`); the votes and the close are no row (the card shows them).
      const lines = page.filter((l) => !apart(l))
      const wants = lines.some((l) => l.kind === 'message' || l.kind === 'poll')
      const after = wants ? await c.store.since(ch.id, page[page.length - 1]!.seq, REACTION_WINDOW) : []
      return {
        channel: summaryOf(ch), lines, reactions: reactionsOf(page, after, lines), polls: await pollsOf(c, ch, lines, [...page, ...after]),
        more: page.length > 0 && page[0]!.seq > 1, last: await c.store.lastSeq(ch.id),
      }
    }],

    // The person votes (she must be called): the same rules as an agent's `vote`; a vote or a change takes the poll in the answer.
    ['vote', async (c, a, ctx) => {
      moderator(ctx)
      const ch = channelOf(c, a)
      const poll = int(a, 'poll')
      if (poll === undefined) throw refuse('bad-request', 'o argumento poll é um inteiro')
      const vote = typeof a.vote === 'number' ? a.vote : text(a, 'vote')
      const reason = typeof a.reason === 'string' && a.reason !== '' ? a.reason : undefined
      if (a.reason !== undefined && typeof a.reason !== 'string') throw refuse('bad-request', 'o argumento reason é um texto')
      const r = done(await c.vote(USER, ch.id, { poll, vote, ...(reason !== undefined ? { reason } : {}) }))
      // A vote that closed the poll (the last one): the result goes with the answer, the card turns at once.
      return { changed: r.changed, option: r.option, poll: openView(r.poll), ...(r.closed ? { result: r.closed.result, closedAt: r.closed.line.at } : {}) }
    }],

    // The person closes a poll before its time (she may close any): the result is the answer.
    ['poll-close', async (c, a, ctx) => {
      moderator(ctx)
      const ch = channelOf(c, a)
      const poll = int(a, 'poll')
      if (poll === undefined) throw refuse('bad-request', 'o argumento poll é um inteiro')
      const r = done(await c.pollClose(USER, ch.id, poll))
      return { result: r.result, closedAt: r.line.at }
    }],

    // The person reacts (as the moderator): the same rules as an agent's `react`, every refusal comes back as the request's error code.
    ['react', async (c, a, ctx) => {
      moderator(ctx)
      const ch = channelOf(c, a)
      const seq = int(a, 'seq')
      if (seq === undefined) throw refuse('bad-request', 'o argumento seq é um inteiro')
      if (a.remove !== undefined && typeof a.remove !== 'boolean') throw refuse('bad-request', 'o argumento remove é verdadeiro ou falso')
      const r = done(await c.react(USER, ch.id, { seq, reaction: text(a, 'reaction'), ...(a.remove === true ? { remove: true } : {}) }))
      return { changed: r.changed, emoji: r.reaction.emoji, ...(r.reaction.name ? { name: r.reaction.name } : {}) }
    }],

    ['say', async (c, a, ctx) => {
      moderator(ctx)
      const ch = channelOf(c, a)
      const to = names(a, 'to')
      const reply = int(a, 'reply')
      const r = done(await c.say(USER, ch.id, { body: text(a, 'text'), ...(to ? { to } : {}), ...(reply !== undefined ? { replyTo: reply } : {}) }))
      return { line: r.line, receipts: r.receipts }
    }],

    ['create', async (c, a, ctx) => {
      moderator(ctx)
      const title = typeof a.title === 'string' && a.title !== '' ? a.title : undefined
      const r = done(await c.create(USER, { name: text(a, 'name'), ...(title !== undefined ? { title } : {}) }))
      return { channel: summaryOf(r.channel) }
    }],

    ['join', async (c, a, ctx) => {
      moderator(ctx)
      const ch = channelOf(c, a)
      const r = done(await c.join(USER, ch.id, agentOf(a)))
      return { channel: summaryOf(r.channel), already: r.already }
    }],

    ['remove', async (c, a, ctx) => {
      moderator(ctx)
      const ch = channelOf(c, a)
      return { channel: summaryOf(done(await c.remove(USER, ch.id, agentOf(a))).channel) }
    }],

    ['mute', async (c, a, ctx) => {
      moderator(ctx)
      const ch = channelOf(c, a)
      const r = done(await c.mute(USER, ch.id, agentOf(a)))
      return { channel: summaryOf(r.channel), already: !r.changed }
    }],

    ['unmute', async (c, a, ctx) => {
      moderator(ctx)
      const ch = channelOf(c, a)
      const r = done(await c.unmute(USER, ch.id, agentOf(a)))
      return { channel: summaryOf(r.channel), already: !r.changed }
    }],

    ['close', async (c, a, ctx) => {
      moderator(ctx)
      const ch = channelOf(c, a)
      return { channel: summaryOf(done(await c.close(USER, ch.id)).channel) }
    }],

    ['reopen', async (c, a, ctx) => {
      moderator(ctx)
      const ch = channelOf(c, a)
      return { channel: summaryOf(done(await c.reopen(USER, ch.id)).channel) }
    }],

    // The reactions that ask the person (❓/❌ of an agent on her speeches) and she has not seen: the tail of the channel, one read.
    ['asks', async (c, a) => {
      const ch = channelOf(c, a)
      const last = await c.store.lastSeq(ch.id)
      const tail = await c.store.since(ch.id, Math.max(0, last - REACTION_WINDOW), REACTION_WINDOW)
      return { asks: personAsks(tail).filter((k) => k.seq > ch.seenByUser) }
    }],

    // The person saw up to `seq`: raised in memory now, written once after a delay (one timer for every channel).
    ['seen', async (c, a, ctx) => {
      moderator(ctx)
      const ch = channelOf(c, a)
      const seq = int(a, 'seq')
      if (seq === undefined) throw refuse('bad-request', 'o argumento seq é um inteiro')
      c.store.markSeen(ch.id, seq)
      if (!timer) {
        timer = setTimeout(() => {
          timer = undefined
          void c.store.flush().catch(() => {})
        }, delayMs)
        timer.unref?.()
      }
      return { seenByUser: ch.seenByUser }
    }],
  ]

  const disposables: IDisposable[] = handlers.map(([name, fn]) =>
    api.requests.handle<unknown>(name, async (args, ctx) => fn(await live(), asRecord(args), ctx)))
  disposables.push(toDisposable(() => { if (timer) { clearTimeout(timer); timer = undefined } }))
  return disposables
}
