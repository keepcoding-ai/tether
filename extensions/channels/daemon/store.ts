// The channels' record, on disk and in memory. It applies what the rules (../rules.ts) already allowed and writes it down; it
// never refuses for a role reason. All disk goes through `api.io` (asynchronous, no node:fs here: the sync ratchet counts it).
//
//   <home>/channels/index.json           { version: 1, channels }   atomic, rewritten only when the structure changes
//   <home>/channels/<channelId>/000001.jsonl   lines 1..500; 000002.jsonl lines 501..1000, and so on
//
// Memory is bounded by the number of channels, never by the number of lines: the index (small), the reverse index agent ->
// channels, one `{ seq, needsNewline }` per channel that was touched, and the tail (the last TAIL_LINES lines) of at most
// TAIL_CHANNELS channels, the least recently used one leaving when a 17th arrives. No timer lives here. The index also keeps
// each channel's open polls with their current votes (at most POLLS_OPEN_PER_CHANNEL x members) and where the last
// POLLS_CLOSED_KEPT results are: the lines of a poll are in the record like any other, the index is what is open now.
import { randomInt } from 'node:crypto'
import type { DaemonIo } from '../../../src/daemon/ext-api.ts'
import { FILES_DIR } from '../attachments.ts'
import {
  endsOwnership, isRoomName, POLLS_CLOSED_KEPT, type AgentId, type Channel, type ChannelId, type ChannelOwner, type Line, type Member, type OpenPoll, type Who,
  USER, deskChannelId,
} from '../rules.ts'

export const INDEX_VERSION = 1
/** Lines per file: the 501st opens the next one. */
export const LINES_PER_FILE = 500
/** Lines of a channel kept in memory. */
export const TAIL_LINES = 200
/** Channels whose tail is kept in memory. */
export const TAIL_CHANNELS = 16
/** The default page of `history` and `since`. */
export const PAGE = 200

export type StoreError = 'unknown-channel' | 'name-taken' | 'bad-name' | 'exists' | 'not-member' | 'unknown-poll'
export type Failure = { ok: false; error: StoreError }
export type Done<T> = ({ ok: true } & T) | Failure

/** A line to append: the store gives it `seq` and, unless given, `at`. */
export type NewLine = Omit<Line, 'seq' | 'at'> & { at?: string }

export interface StoreOptions {
  now?: () => Date
  /** A fresh channel id; tests make it predictable. Default 'c_<base36>'. */
  newId?: () => ChannelId
  log?: (msg: string) => void
  linesPerFile?: number
  tailLines?: number
  tailChannels?: number
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
  /** A new room name (a desk channel reopening while another open channel took its name). `name-taken` when an open one has it. */
  rename(id: ChannelId, name: string): Promise<Done<{ channel: Channel; changed: boolean }>>
  /** Raises `seenByUser` in memory; `flush` writes it. */
  markSeen(id: ChannelId, seq: number): void
  /** Raises the member's `reactionsSeen` (the ride's cursor) in memory; `flush` writes it. */
  markReactionsSeen(id: ChannelId, agent: AgentId, seq: number): void
  /** Writes the index when `markSeen` or `markReactionsSeen` left it dirty. */
  flush(): Promise<void>
  /** A poll opened (its line already written): it goes into the channel's open polls. */
  openPoll(id: ChannelId, poll: OpenPoll): Promise<Done<{ channel: Channel; poll: OpenPoll }>>
  /** The vote of `who` on the open poll `seq` (its line already written): it replaces the previous one; `change` counts a change. */
  setVote(id: ChannelId, seq: number, who: Who, vote: OpenPoll['votes'][string], change: boolean): Promise<Done<{ channel: Channel; poll: OpenPoll }>>
  /** The request of the open poll `seq` was handed to these agents (receipt ids): merged into its `asked`, one index write. */
  setAsked(id: ChannelId, seq: number, asked: Readonly<Record<Who, string>>): Promise<Done<{ channel: Channel; poll: OpenPoll }>>
  /** The open poll `seq` closed, its result at the line `line`: it leaves the open polls and joins the last closed ones. */
  closePoll(id: ChannelId, seq: number, line: number): Promise<Done<{ channel: Channel; poll: OpenPoll }>>

  /** Appends one line (the next `seq`), after it is on disk it is in the tail. */
  append(id: ChannelId, line: NewLine): Promise<Line>
  /** The last seq of the channel (0: no line yet). */
  lastSeq(id: ChannelId): Promise<number>
  /** Up to `limit` lines with seq < `before` (the latest ones when absent), ascending. Crosses files. */
  history(id: ChannelId, before?: number, limit?: number): Promise<Line[]>
  /** Up to `limit` lines with seq > `since`, ascending (`channels read --since`). */
  since(id: ChannelId, since: number, limit?: number): Promise<Line[]>
  /**
   * The last `count` lines of the channel and its last seq, for a reader that is not the app (the marks a remote device
   * reads, daemon/marks.ts): from the tail when it is in memory and covers them, else from the files they live in, each file
   * read once. The tail cache is neither filled nor reordered, so such a reader never pushes out the tails the app uses.
   */
  peekTail(id: ChannelId, count: number): Promise<{ last: number; lines: Line[] }>
  /** Lines lo..hi, ascending, under the same rule as `peekTail` (the tail cache untouched). */
  peek(id: ChannelId, lo: number, hi: number): Promise<Line[]>
  /** The last seq when the store already knows it, without reading anything; undefined when it would have to read. */
  knownLast(id: ChannelId): number | undefined
  /** Channels whose tail is in memory, least recently used first. */
  cachedChannels(): ChannelId[]
  /** The channel's folder of files (attachments): `<home>/channels/<id>/files`, made when the first file comes. */
  filesDir(id: ChannelId): string
}

interface IndexFile {
  version: number
  channels: Record<ChannelId, Channel>
}

interface Cold {
  seq: number
  /** The newest file does not end with a newline (a torn write): the next append starts one. */
  needsNewline: boolean
}

const fileName = (n: number): string => `${String(n).padStart(6, '0')}.jsonl`
const FILE_RE = /^(\d{6})\.jsonl$/

function parseLines(text: string): Line[] {
  const out: Line[] = []
  for (const raw of text.split('\n')) {
    if (!raw) continue
    try {
      const v = JSON.parse(raw) as Line
      if (v && typeof v.seq === 'number') out.push(v)
    } catch {
      // a torn line: it is skipped, never repaired
    }
  }
  return out
}

const missing = (e: unknown): boolean => (e as { code?: string } | undefined)?.code === 'ENOENT'

export async function openStore(io: DaemonIo, home: string, options: StoreOptions = {}): Promise<ChannelStore> {
  const now = options.now ?? (() => new Date())
  const perFile = options.linesPerFile ?? LINES_PER_FILE
  const tailLines = options.tailLines ?? TAIL_LINES
  const tailChannels = options.tailChannels ?? TAIL_CHANNELS
  const log = options.log ?? (() => {})
  const root = `${home.replace(/[\\/]+$/, '')}/channels`
  const indexPath = `${root}/index.json`
  const dirOf = (id: ChannelId): string => `${root}/${id}`
  const fileNo = (seq: number): number => Math.floor((seq - 1) / perFile) + 1

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

  // ---- the lines ----
  const lanes = new Map<ChannelId, Promise<void>>()
  /** One at a time per channel: an append never races a tail load of the same channel. */
  function lane<T>(id: ChannelId, fn: () => Promise<T>): Promise<T> {
    const run = (lanes.get(id) ?? Promise.resolve()).then(fn)
    const settled = run.then(() => {}, () => {})
    lanes.set(id, settled)
    void settled.then(() => { if (lanes.get(id) === settled) lanes.delete(id) })
    return run
  }

  const colds = new Map<ChannelId, Cold>()
  /** Map order is the use order: first is the least recently used. */
  const tails = new Map<ChannelId, Line[]>()
  const touch = (id: ChannelId, lines: Line[]): void => {
    tails.delete(id)
    tails.set(id, lines)
    while (tails.size > tailChannels) tails.delete(tails.keys().next().value as ChannelId)
  }

  async function fileNumbers(id: ChannelId): Promise<number[]> {
    let entries: Array<{ name: string; isFile: boolean }>
    try {
      entries = await io.readdir(dirOf(id))
    } catch (e) {
      if (missing(e)) return []
      throw e
    }
    const nums: number[] = []
    for (const e of entries) {
      const m = e.isFile ? FILE_RE.exec(e.name) : null
      if (m) nums.push(Number(m[1]))
    }
    return nums.sort((a, b) => a - b)
  }

  /** The last lines of the channel from disk (newest files first until enough), and what the newest file needs. */
  async function loadTail(id: ChannelId): Promise<{ lines: Line[]; cold: Cold }> {
    const nums = await fileNumbers(id)
    let lines: Line[] = []
    let needsNewline = false
    for (let i = nums.length - 1; i >= 0 && lines.length < tailLines; i--) {
      const body = (await io.tryReadText(`${dirOf(id)}/${fileName(nums[i]!)}`)) ?? ''
      if (i === nums.length - 1) needsNewline = body.length > 0 && !body.endsWith('\n')
      lines = parseLines(body).concat(lines)
    }
    if (lines.length > tailLines) lines = lines.slice(lines.length - tailLines)
    return { lines, cold: { seq: lines.length ? lines[lines.length - 1]!.seq : 0, needsNewline } }
  }

  /** The channel's tail: from memory, or read once and kept. Inside the lane. */
  async function warm(id: ChannelId): Promise<Line[]> {
    const have = tails.get(id)
    if (have) {
      touch(id, have)
      return have
    }
    const { lines, cold } = await loadTail(id)
    colds.set(id, cold)
    touch(id, lines)
    return lines
  }

  /** Lines lo..hi from the files they live in. Inside the lane. */
  async function range(id: ChannelId, lo: number, hi: number): Promise<Line[]> {
    const out: Line[] = []
    for (let n = fileNo(lo); n <= fileNo(hi); n++) {
      const body = await io.tryReadText(`${dirOf(id)}/${fileName(n)}`)
      if (body) for (const l of parseLines(body)) if (l.seq >= lo && l.seq <= hi) out.push(l)
    }
    return out.sort((a, b) => a.seq - b.seq)
  }

  async function slice(id: ChannelId, lo: number, hi: number): Promise<Line[]> {
    if (hi < lo || hi < 1) return []
    const tail = await warm(id)
    const first = tail.length ? tail[0]!.seq : 1
    if (lo >= first || first === 1) return tail.filter((l) => l.seq >= lo && l.seq <= hi)
    return range(id, lo, hi)
  }

  /** Lines lo..hi from the tail when it is in memory and covers them (left where it is in the LRU), else from the files. Inside the lane. */
  async function peekRange(id: ChannelId, lo: number, hi: number): Promise<Line[]> {
    if (hi < lo || hi < 1) return []
    const tail = tails.get(id)
    const first = tail?.length ? tail[0]!.seq : 1
    if (tail && (lo >= first || first === 1)) return tail.filter((l) => l.seq >= lo && l.seq <= hi)
    return range(id, lo, hi)
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

    async rename(id, name) {
      const ch = need(id)
      if (!ch) return failure('unknown-channel')
      if (ch.name === name) return { ok: true, channel: ch, changed: false }
      if (!isRoomName(name)) return failure('bad-name')
      if (findOpen(name)) return failure('name-taken')
      ch.name = name
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

    markReactionsSeen(id, agent, seq) {
      const m = channels.get(id)?.members[agent]
      if (m && Object.hasOwn(channels.get(id)!.members, agent) && seq > (m.reactionsSeen ?? 0)) {
        m.reactionsSeen = seq
        dirty = true
      }
    },

    async flush() {
      if (dirty) await persist()
    },

    async openPoll(id, poll) {
      const ch = need(id)
      if (!ch) return failure('unknown-channel')
      ch.polls = { ...(ch.polls ?? {}), [String(poll.seq)]: poll }
      await persist()
      return { ok: true, channel: ch, poll }
    },

    async setVote(id, seq, who, vote, change) {
      const ch = need(id)
      if (!ch) return failure('unknown-channel')
      const poll = ch.polls?.[String(seq)]
      if (!poll) return failure('unknown-poll')
      poll.votes[who] = vote
      if (change) poll.changes = { ...(poll.changes ?? {}), [who]: (poll.changes?.[who] ?? 0) + 1 }
      await persist()
      return { ok: true, channel: ch, poll }
    },

    async setAsked(id, seq, asked) {
      const ch = need(id)
      if (!ch) return failure('unknown-channel')
      const poll = ch.polls?.[String(seq)]
      if (!poll) return failure('unknown-poll')
      poll.asked = { ...(poll.asked ?? {}), ...asked }
      await persist()
      return { ok: true, channel: ch, poll }
    },

    async closePoll(id, seq, line) {
      const ch = need(id)
      if (!ch) return failure('unknown-channel')
      const poll = ch.polls?.[String(seq)]
      if (!poll) return failure('unknown-poll')
      delete ch.polls![String(seq)]
      if (Object.keys(ch.polls!).length === 0) delete ch.polls
      ch.pollsClosed = [...(ch.pollsClosed ?? []), { poll: seq, line }].slice(-POLLS_CLOSED_KEPT)
      await persist()
      return { ok: true, channel: ch, poll }
    },

    append(id, input) {
      return lane(id, async () => {
        let cold = colds.get(id)
        if (!cold) {
          await io.mkdirp(dirOf(id))
          await warm(id)
          cold = colds.get(id)!
        } else if (cold.seq === 0) {
          // A read before the first line warmed it without the folder.
          await io.mkdirp(dirOf(id))
        }
        const line: Line = { ...input, seq: cold.seq + 1, at: input.at ?? stamp() }
        const prefix = cold.needsNewline ? '\n' : ''
        await io.appendText(`${dirOf(id)}/${fileName(fileNo(line.seq))}`, `${prefix}${JSON.stringify(line)}\n`)
        cold.seq = line.seq
        cold.needsNewline = false
        const tail = tails.get(id)
        if (tail) {
          tail.push(line)
          if (tail.length > tailLines) tail.splice(0, tail.length - tailLines)
          touch(id, tail)
        }
        return line
      })
    },

    lastSeq(id) {
      return lane(id, async () => {
        if (!colds.has(id)) await warm(id)
        return colds.get(id)!.seq
      })
    },

    history(id, before, limit = PAGE) {
      return lane(id, async () => {
        await warm(id)
        const last = colds.get(id)!.seq
        const hi = before === undefined ? last : Math.min(before - 1, last)
        return slice(id, Math.max(1, hi - limit + 1), hi)
      })
    },

    since(id, since, limit = PAGE) {
      return lane(id, async () => {
        await warm(id)
        const last = colds.get(id)!.seq
        const lo = Math.max(1, since + 1)
        return slice(id, lo, Math.min(last, lo + limit - 1))
      })
    },

    peekTail(id, count) {
      return lane(id, async () => {
        const cold = colds.get(id)
        if (cold) return { last: cold.seq, lines: await peekRange(id, Math.max(1, cold.seq - count + 1), cold.seq) }
        // Never read before: the newest files first until the window is covered. The newest one also says the last seq and
        // whether it ends torn, which the store keeps (`colds`, one entry per channel) so the next read knows without disk.
        const nums = await fileNumbers(id)
        let lines: Line[] = []
        let needsNewline = false
        let last: number | undefined
        for (let i = nums.length - 1; i >= 0; i--) {
          const body = (await io.tryReadText(`${dirOf(id)}/${fileName(nums[i]!)}`)) ?? ''
          if (i === nums.length - 1) needsNewline = body.length > 0 && !body.endsWith('\n')
          lines = parseLines(body).concat(lines)
          if (last === undefined && lines.length) last = lines[lines.length - 1]!.seq
          if (last !== undefined && lines[0]!.seq <= last - count + 1) break
        }
        const seq = last ?? 0
        colds.set(id, { seq, needsNewline })
        return { last: seq, lines: lines.filter((l) => l.seq > seq - count) }
      })
    },

    peek(id, lo, hi) {
      return lane(id, () => peekRange(id, lo, hi))
    },

    knownLast: (id) => colds.get(id)?.seq,

    cachedChannels: () => [...tails.keys()],
    filesDir: (id) => `${dirOf(id)}/${FILES_DIR}`,
  }
  return store
}
