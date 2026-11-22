// The channels' record, on disk and in memory. It applies what the rules (../rules.ts) already allowed and writes it down; it
// never refuses for a role reason. All disk goes through `api.io` (asynchronous, no node:fs here: the sync ratchet counts it).
//
//   <home>/channels/index.json           { version: 1, channels }   atomic, rewritten only when the structure changes
//   <home>/channels/<channelId>/000001.jsonl   lines 1..500; 000002.jsonl lines 501..1000, and so on
//
// Memory is bounded by the number of channels, never by the number of lines: the index (small) and the reverse index
// agent -> channels. No timer lives here.
import { randomInt } from 'node:crypto'
import type { DaemonIo } from '../../../src/daemon/ext-api.ts'
import {
  endsOwnership, isRoomName, type AgentId, type Channel, type ChannelId, type ChannelOwner, type Member, type Who, USER, deskChannelId,
} from '../rules.ts'

export const INDEX_VERSION = 1

export type StoreError = 'unknown-channel' | 'name-taken' | 'bad-name' | 'exists' | 'not-member'
export type Failure = { ok: false; error: StoreError }
export type Done<T> = ({ ok: true } & T) | Failure

export interface StoreOptions {
  now?: () => Date
  /** A fresh channel id; tests make it predictable. Default 'c_<base36>'. */
  newId?: () => ChannelId
  log?: (msg: string) => void
}

export interface CreateInput {
  name: string
  title?: string
  owner: ChannelOwner
  createdBy: Who
  /** The desk's id: the channel is then the desk's, with id `desk_<id>`. */
  desk?: string
}

export interface ChannelStore {
  /** Every channel, open and closed. The objects are live: read them, never write them. */
  channels(): Channel[]
  get(id: ChannelId): Channel | undefined
  /** The OPEN channel with this name (closed ones free the name). */
  findOpen(name: string): Channel | undefined
  /** The open channel names, for `slugOf(text, store.openNames())`. */
  openNames(): { has(name: string): boolean }
  /** The channels (open or closed) `agent` is a member of: the reverse index. */
  channelsOf(agent: AgentId): Channel[]

  create(input: CreateInput): Promise<Done<{ channel: Channel }>>
  /** `already: true` and nothing written when `agent` is a member. Joining clears a removal. */
  join(id: ChannelId, agent: AgentId, name: string, by: Member['by']): Promise<Done<{ channel: Channel; already: boolean }>>
  /** `endedOwner`: the agent was the agent owner and gave the channel up (why 'left'). */
  leave(id: ChannelId, agent: AgentId): Promise<Done<{ channel: Channel; endedOwner: boolean }>>
  /** Like leave, and the agent goes to `removed` (why 'removed'). */
  remove(id: ChannelId, agent: AgentId): Promise<Done<{ channel: Channel; endedOwner: boolean }>>
  /** The pane was forgotten: leaves every channel it is in (why 'forgotten'), one index write. */
  forget(agent: AgentId): Promise<Array<{ channel: Channel; endedOwner: boolean }>>
  /** Takes `agent` out of `removed` (the pane left the desk). */
  clearRemoved(id: ChannelId, agent: AgentId): Promise<Done<{ channel: Channel; changed: boolean }>>
  mute(id: ChannelId, agent: AgentId, by: Who): Promise<Done<{ channel: Channel; changed: boolean }>>
  unmute(id: ChannelId, agent: AgentId): Promise<Done<{ channel: Channel; changed: boolean }>>
  close(id: ChannelId, by: Who): Promise<Done<{ channel: Channel; changed: boolean }>>
  /** `name-taken` when another open channel has the name meanwhile. */
  reopen(id: ChannelId): Promise<Done<{ channel: Channel; changed: boolean }>>
  /** A desk channel's new owner (from the desk): clears `ownerEnded`. */
  setOwner(id: ChannelId, owner: ChannelOwner): Promise<Done<{ channel: Channel }>>
  setTitle(id: ChannelId, title: string): Promise<Done<{ channel: Channel; changed: boolean }>>
  /** Raises `seenByUser` in memory; `flush` writes it. */
  markSeen(id: ChannelId, seq: number): void
  /** Writes the index when `markSeen` left it dirty. */
  flush(): Promise<void>

}

interface IndexFile {
  version: number
  channels: Record<ChannelId, Channel>
}

export async function openStore(io: DaemonIo, home: string, options: StoreOptions = {}): Promise<ChannelStore> {
  const now = options.now ?? (() => new Date())
  const log = options.log ?? (() => {})
  const root = `${home.replace(/[\\/]+$/, '')}/channels`
  const indexPath = `${root}/index.json`

  // ---- the index ----
  const channels = new Map<ChannelId, Channel>()
  const byAgent = new Map<AgentId, Set<ChannelId>>()
  let dirty = false

  const indexAdd = (agent: AgentId, id: ChannelId): void => {
    let set = byAgent.get(agent)
    if (!set) byAgent.set(agent, (set = new Set()))
    set.add(id)
  }
  const indexDrop = (agent: AgentId, id: ChannelId): void => {
    const set = byAgent.get(agent)
    if (!set) return
    set.delete(id)
    if (set.size === 0) byAgent.delete(agent)
  }

  const text = await io.tryReadText(indexPath)
  if (text !== undefined) {
    let parsed: IndexFile | undefined
    try {
      const v = JSON.parse(text) as IndexFile
      if (v && v.version === INDEX_VERSION && v.channels && typeof v.channels === 'object') parsed = v
    } catch {
      // handled below
    }
    if (parsed) {
      for (const [id, ch] of Object.entries(parsed.channels)) {
        channels.set(id, ch)
        for (const agent of Object.keys(ch.members)) indexAdd(agent, id)
      }
    } else {
      // Never silently drop the channels: the unreadable file is kept beside, and the store starts empty.
      const aside = `${indexPath}.unreadable-${now().getTime()}`
      log(`index.json unreadable; kept as ${aside}`)
      await io.rename(indexPath, aside)
    }
  }

  let writing: Promise<void> = Promise.resolve()
  /** Writes the whole index as it is when the write runs, so queued writes coalesce into the latest state. */
  const persist = (): Promise<void> => {
    dirty = false
    const run = writing.then(async () => {
      const file: IndexFile = { version: INDEX_VERSION, channels: Object.fromEntries(channels) }
      await io.writeTextAtomic(indexPath, JSON.stringify(file))
    })
    writing = run.catch(() => {})
    return run
  }

  const stamp = (): string => now().toISOString()
  const freshId = (): ChannelId => {
    for (;;) {
      const id = options.newId ? options.newId() : `c_${randomInt(36 ** 7).toString(36)}`
      if (!channels.has(id)) return id
    }
  }

  const findOpen = (name: string): Channel | undefined => {
    for (const ch of channels.values()) if (!ch.closed && ch.name === name) return ch
    return undefined
  }

  // ---- structure ----
  const need = (id: ChannelId): Channel | undefined => channels.get(id)
  const failure = (error: StoreError): Failure => ({ ok: false, error })

  /** Takes `agent` out of the members; returns whether it gave the channel up. */
  function drop(ch: Channel, agent: AgentId, why: 'left' | 'removed' | 'forgotten'): boolean {
    const ended = endsOwnership(ch, agent)
    const name = ch.members[agent]!.name
    delete ch.members[agent]
    indexDrop(agent, ch.id)
    if (ended) ch.ownerEnded = { at: stamp(), name, why }
    return ended
  }

  const store: ChannelStore = {
    channels: () => [...channels.values()],
    get: (id) => channels.get(id),
    findOpen,
    openNames: () => ({ has: (name: string) => findOpen(name) !== undefined }),
    channelsOf: (agent) => [...(byAgent.get(agent) ?? [])].map((id) => channels.get(id)!),

    async create(input) {
      if (!isRoomName(input.name)) return failure('bad-name')
      if (findOpen(input.name)) return failure('name-taken')
      const id = input.desk !== undefined ? deskChannelId(input.desk) : freshId()
      if (channels.has(id)) return failure('exists')
      const at = stamp()
      const ch: Channel = {
        id, name: input.name, title: input.title ?? input.name, owner: input.owner, createdAt: at, createdBy: input.createdBy, members: {}, seenByUser: 0,
      }
      if (input.desk !== undefined) ch.desk = input.desk
      if (input.owner.kind === 'agent') {
        ch.members[input.owner.id] = { since: at, by: input.createdBy === input.owner.id ? 'self' : input.createdBy === USER ? 'user' : input.createdBy, name: input.owner.name }
        indexAdd(input.owner.id, id)
      }
      channels.set(id, ch)
      await persist()
      return { ok: true, channel: ch }
    },

    async join(id, agent, name, by) {
      const ch = need(id)
      if (!ch) return failure('unknown-channel')
      if (Object.hasOwn(ch.members, agent)) return { ok: true, channel: ch, already: true }
      ch.members[agent] = { since: stamp(), by, name }
      indexAdd(agent, id)
      if (ch.removed?.includes(agent)) {
        ch.removed = ch.removed.filter((a) => a !== agent)
        if (ch.removed.length === 0) delete ch.removed
      }
      await persist()
      return { ok: true, channel: ch, already: false }
    },

    async leave(id, agent) {
      const ch = need(id)
      if (!ch) return failure('unknown-channel')
      if (!Object.hasOwn(ch.members, agent)) return failure('not-member')
      const endedOwner = drop(ch, agent, 'left')
      await persist()
      return { ok: true, channel: ch, endedOwner }
    },

    async remove(id, agent) {
      const ch = need(id)
      if (!ch) return failure('unknown-channel')
      if (!Object.hasOwn(ch.members, agent)) return failure('not-member')
      const endedOwner = drop(ch, agent, 'removed')
      ch.removed = [...(ch.removed ?? []).filter((a) => a !== agent), agent]
      await persist()
      return { ok: true, channel: ch, endedOwner }
    },

    async forget(agent) {
      const out: Array<{ channel: Channel; endedOwner: boolean }> = []
      for (const id of [...(byAgent.get(agent) ?? [])]) {
        const ch = channels.get(id)
        if (ch && Object.hasOwn(ch.members, agent)) out.push({ channel: ch, endedOwner: drop(ch, agent, 'forgotten') })
      }
      if (out.length) await persist()
      return out
    },

    async clearRemoved(id, agent) {
      const ch = need(id)
      if (!ch) return failure('unknown-channel')
      if (!ch.removed?.includes(agent)) return { ok: true, channel: ch, changed: false }
      ch.removed = ch.removed.filter((a) => a !== agent)
      if (ch.removed.length === 0) delete ch.removed
      await persist()
      return { ok: true, channel: ch, changed: true }
    },

    async mute(id, agent, by) {
      const ch = need(id)
      if (!ch) return failure('unknown-channel')
      const m = ch.members[agent]
      if (!m || !Object.hasOwn(ch.members, agent)) return failure('not-member')
      if (m.muted) return { ok: true, channel: ch, changed: false }
      m.muted = { since: stamp(), by }
      await persist()
      return { ok: true, channel: ch, changed: true }
    },

    async unmute(id, agent) {
      const ch = need(id)
      if (!ch) return failure('unknown-channel')
      const m = ch.members[agent]
      if (!m || !Object.hasOwn(ch.members, agent)) return failure('not-member')
      if (!m.muted) return { ok: true, channel: ch, changed: false }
      delete m.muted
      await persist()
      return { ok: true, channel: ch, changed: true }
    },

    async close(id, by) {
      const ch = need(id)
      if (!ch) return failure('unknown-channel')
      if (ch.closed) return { ok: true, channel: ch, changed: false }
      ch.closed = { at: stamp(), by }
      await persist()
      return { ok: true, channel: ch, changed: true }
    },

    async reopen(id) {
      const ch = need(id)
      if (!ch) return failure('unknown-channel')
      if (!ch.closed) return { ok: true, channel: ch, changed: false }
      if (findOpen(ch.name)) return failure('name-taken')
      delete ch.closed
      await persist()
      return { ok: true, channel: ch, changed: true }
    },

    async setOwner(id, owner) {
      const ch = need(id)
      if (!ch) return failure('unknown-channel')
      ch.owner = owner
      delete ch.ownerEnded
      await persist()
      return { ok: true, channel: ch }
    },

    async setTitle(id, title) {
      const ch = need(id)
      if (!ch) return failure('unknown-channel')
      if (ch.title === title) return { ok: true, channel: ch, changed: false }
      ch.title = title
      await persist()
      return { ok: true, channel: ch, changed: true }
    },

    markSeen(id, seq) {
      const ch = channels.get(id)
      if (ch && seq > ch.seenByUser) {
        ch.seenByUser = seq
        dirty = true
      }
    },

    async flush() {
      if (dirty) await persist()
    },

  }
  return store
}
