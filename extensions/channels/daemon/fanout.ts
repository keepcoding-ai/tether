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
//   - `woke`: the members a delivery of ours woke from idle (2.6). The next `done` of that turn is cleared (`attention.seen`)
//     unless the person typed in it; `waiting` is never cleared, and a commanded pane (`attentionFor`) is never touched.
// All of it is lost on a tetherd restart (the record and the core's queue stay on disk): at worst one return notice is missed.
import { slotIsLive, slotTitle } from '../../../app/shared/agent-info.ts'
import { DisposableStore, toDisposable, type IDisposable } from '../../../app/shared/vscode-lifecycle.ts'
import type { DeliveryMessage, DeliveryReceipt, TetherDaemon } from '../../../src/daemon/ext-api.ts'
import type { SlotState } from '../../../src/daemon/protocol.ts'
import {
  closeRefusal, deliveryRoleOf, joinRefusal, mayModerate, reopenRefusal, roleIn, sayRefusal, USER,
  type AgentId, type Channel, type ChannelId, type Line, type LineEventType, type Who,
} from '../rules.ts'
import type { ChannelStore, NewLine, StoreError } from './store.ts'
import {
  closedLine, createdLine, createdNotice, forgottenLine, joinedLine, joinedNotice, leftLine, mergedNotice, MODERATOR_NAME,
  mutedLine, mutedNotice, ownerEndedLine, removedLine, removedNotice, reopenedLine, returnNotice, SYSTEM_FROM, unmutedLine,
  unmutedNotice, type Tally,
} from './notices.ts'

/** What the fan-out uses of the daemon API. */
export type ChannelsApi = Pick<TetherDaemon, 'slots' | 'delivery' | 'attention' | 'events' | 'settings' | 'log'>

/** The moderator's name setting. */
export const MODERATOR_NAME_KEY = 'extensions.channels.moderatorName'

/** Per member, what became of a line: the core's path, or `away` (its process does not run: nothing was delivered). */
export type LineReceipt = 'inside' | 'typed' | 'queued' | 'away'

export type Refusal =
  | StoreError
  | 'closed' | 'not-member' | 'muted' | 'not-owner' | 'removed' | 'desk' | 'not-closed'
  | 'unknown-agent' | 'bad-request'

export type Outcome<T> = ({ ok: true } & T) | { ok: false; error: Refusal }

export interface SayInput {
  body: string
  /** Names the line addresses (an address, not a secret: every member hears it). */
  to?: readonly string[]
  /** The seq of the line it answers, in the same channel. */
  replyTo?: number
}

export interface Channels {
  readonly store: ChannelStore
  /** A common channel. An agent creator joins as its member and owner; the person creates a channel she owns. */
  create(who: Who, input: { name: string; title?: string }): Promise<Outcome<{ channel: Channel; line: Line }>>
  /** A line from a member (role `member`, the owner too) or the moderator (`who: 'user'`). Delivered to every member but the speaker. */
  say(who: Who, id: ChannelId, input: SayInput): Promise<Outcome<{ line: Line; receipts: Record<AgentId, LineReceipt> }>>
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
  dispose(): void
}

/** Event `channel`: the channel after a structure change (create, join, leave, remove, mute, unmute, close, reopen, forget). */
export interface ChannelEvent { channel: Channel }
/** Event `line`: a line appended to a channel. */
export interface LineEvent { channelId: ChannelId; room: string; line: Line }

interface Waiting extends Tally {
  receipt: string
}

const keyOf = (agent: AgentId, id: ChannelId): string => `${agent} ${id}`

export function createChannels(api: ChannelsApi, store: ChannelStore): Channels {
  const own = new DisposableStore()
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
  const woke = new Map<AgentId, { at: number; armed: boolean }>()

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

  const envelopeOf = (ch: Channel, line: Line): DeliveryMessage => {
    const ref = `${ch.name}#${line.seq}`
    if (line.kind === 'notice') return { kind: 'notice', room: ch.name, from: { ...SYSTEM_FROM }, body: line.body, ref }
    const msg: DeliveryMessage = {
      kind: 'message', room: ch.name, body: line.body, ref,
      from: { name: line.from.name, id: line.from.id, role: deliveryRoleOf(line.from.role) },
    }
    if (line.to?.length) msg.to = line.to
    if (line.replyTo !== undefined) msg.inReplyTo = `${ch.name}#${line.replyTo}`
    return msg
  }
  const noticeOf = (ch: Channel, body: string, ref?: number): DeliveryMessage =>
    ({ kind: 'notice', room: ch.name, from: { ...SYSTEM_FROM }, body, ...(ref !== undefined ? { ref: `${ch.name}#${ref}` } : {}) })

  /** Delivers; a refusal of the core (the slot vanished) is logged and reads as `away`. */
  async function send(agent: AgentId, msg: DeliveryMessage): Promise<DeliveryReceipt | undefined> {
    try {
      return await api.delivery.deliver(agent, msg)
    } catch (e) {
      api.log(`entrega para ${agent} em #${msg.room ?? '?'} falhou: ${(e as Error).message}`)
      return undefined
    }
  }
  /** Whether the receipt still waits in the core's queue (it may have gone out while the answer came back). */
  const stillWaits = (r: DeliveryReceipt): boolean => r.state === 'queued' && api.delivery.pending(r.slotId).some((p) => p.id === r.id)

  function track(agent: AgentId, id: ChannelId, r: DeliveryReceipt, t: Tally): void {
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

  /** One line to one member, with the rule of one waiting delivery per (member, channel). */
  async function deliverLine(agent: AgentId, ch: Channel, line: Line): Promise<LineReceipt> {
    if (isAway(agent)) { remember(agent, ch.id, line); return 'away' }
    const key = keyOf(agent, ch.id)
    const w = untrack(key)
    if (w && api.delivery.cancel(w.receipt)) {
      count(w, line)
      const r = await send(agent, noticeOf(ch, mergedNotice(ch.name, w), line.seq))
      if (!r) return 'away'
      track(agent, ch.id, r, w)
      return receiptState(r)
    }
    const r = await send(agent, envelopeOf(ch, line))
    if (!r) return 'away'
    track(agent, ch.id, r, tallyOf(line))
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
    await Promise.all(Object.keys(ch.members).map(async (agent) => {
      if (agent === except) return
      const text = personal?.get(agent)
      if (text !== undefined) { await tell(agent, ch, text, line); return }
      out[agent] = await deliverLine(agent, ch, line)
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
  own.add(api.delivery.onDidDeliver((r) => {
    const key = byReceipt.get(r.id)
    if (key !== undefined && pending.get(key)?.receipt === r.id) untrack(key)
    if (r.unsent || (r.state !== 'inside' && r.state !== 'typed')) return
    const s = slotOf(r.slotId)
    if (!s) return
    // The terminal path only types into an idle pane; inside, a busy agent takes the line between tools (no new turn).
    if (r.state === 'inside' && (s.turn === 'busy' || s.attention === 'waiting')) return
    woke.set(r.slotId, { at: Date.now(), armed: s.attention !== 'done' })
  }))
  own.add(api.slots.onState((s) => {
    const w = woke.get(s.slotId)
    if (!w) return
    if (s.attentionFor) { woke.delete(s.slotId); return }
    if (s.attention !== 'done') { w.armed = true; return }
    if (!w.armed) return
    woke.delete(s.slotId)
    const typed = api.slots.userTypedAt(s.slotId)
    if (typed === undefined || typed < w.at) {
      try { api.attention.seen(s.slotId) } catch (e) { api.log(`attention.seen ${s.slotId}: ${(e as Error).message}`) }
    }
  }))

  const fail = (error: Refusal): { ok: false; error: Refusal } => ({ ok: false, error })

  const channels: Channels = {
    store,
    nameOf,

    async create(who, input) {
      if (who !== USER && !isAgent(who)) return fail('unknown-agent')
      const owner = who === USER ? { kind: 'user' as const } : { kind: 'agent' as const, id: who, name: nameOf(who) }
      const made = await store.create({ name: input.name, ...(input.title !== undefined ? { title: input.title } : {}), owner, createdBy: who })
      if (!made.ok) return made
      const ch = made.channel
      return lane(ch.id, async () => {
        const line = await notice(ch, createdLine(ch.name, nameOf(who)), 'create', who === USER ? undefined : who, who)
        emitChannel(ch)
        if (who !== USER) await tell(who, ch, createdNotice(ch.name), line)
        return { ok: true as const, channel: ch, line }
      })
    },

    say(who, id, input) {
      return lane(id, async () => {
        const ch = store.get(id)
        if (!ch) return fail('unknown-channel')
        if (typeof input.body !== 'string' || input.body.trim() === '') return fail('bad-request')
        const refusal = sayRefusal(who, ch)
        if (refusal) return fail(refusal)
        const role = roleIn(who, ch)!
        const line = await append(ch, {
          kind: 'message', from: { id: who, name: nameOf(who), role }, body: input.body,
          ...(input.to?.length ? { to: [...input.to] } : {}), ...(input.replyTo !== undefined ? { replyTo: input.replyTo } : {}),
        })
        const receipts = await fanout(ch, line, who === USER ? undefined : who)
        return { ok: true as const, line, receipts }
      })
    },

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
        const text = joinedNotice(ch.name, who === target ? undefined : nameOf(who), members, api.delivery.pathOf(target))
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
      woke.delete(agent)
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
      })))
    },

    async spawned(agent) {
      const per = missed.get(agent)
      if (!per) return
      missed.delete(agent)
      await Promise.all([...per].map(([id, t]) => lane(id, async () => {
        const ch = store.get(id)
        if (!ch || !Object.hasOwn(ch.members, agent)) return
        // What still waited from before it stopped joins the same notice.
        const w = untrack(keyOf(agent, id))
        if (w && api.delivery.cancel(w.receipt)) merge(t, w)
        const r = await send(agent, noticeOf(ch, returnNotice(ch.name, t)))
        if (r) track(agent, id, r, t)
      })))
    },

    dispose() {
      own.dispose()
      pending.clear()
      byReceipt.clear()
      missed.clear()
      woke.clear()
    },
  }
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
