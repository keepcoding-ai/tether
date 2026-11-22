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
import { USER, type Channel, type ChannelId, type Line } from '../rules.ts'
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

const refuse = (code: string, message: string): DoorError => new DoorError(code as ErrorCode, message)

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
        return { id, name: c.nameOf(id), muted: m.muted !== undefined, since: m.since, by: m.by, alive, path: alive ? api.delivery.pathOf(id) : 'away' }
      })
      return { channel: summaryOf(ch), members, removed: ch.removed ?? [] }
    }],

    ['history', async (c, a) => {
      const ch = channelOf(c, a)
      const before = int(a, 'before')
      const limit = Math.min(Math.max(int(a, 'limit') ?? PAGE, 1), PAGE)
      const lines: Line[] = await c.store.history(ch.id, before, limit)
      return { channel: summaryOf(ch), lines, more: lines.length > 0 && lines[0]!.seq > 1, last: await c.store.lastSeq(ch.id) }
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
