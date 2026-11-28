// The remote hosts of the shared screen: the Regency's pane (`RegencyHost`) and the channel's view (`ChannelHost`) over what
// a house answers through the relay, reading only. The screen is the app's own (extensions/regency/renderer/pane.ts,
// extensions/channels/renderer/channel-pane.ts); the model runs here, on the device, over the tree the house publishes.
//
// The source (`RemoteSource`) is the three readings and the two thin notices of the house, in the shape of the contract
// (`regency.tree`, `channels.marks`, `channels.page`; `regency.changed`, `channels.changed`). This module does not know the
// wire: the session gives a source that asks the relay, the bench gives a made-up one. What a source returns is already
// checked data; every text of it reaches the page as a text node, because the shared screen never writes HTML.
//
// A device that only reads acts on nothing: every gesture of the shared screen that would (speak, react, vote, create,
// rename, a menu) is off in the screen itself (`readOnly`) and answers nothing here. A device that may converse (RR4 4.2b)
// gives the channel's host its talker (`RemoteTalk`): the view speaks, reacts, votes, opens a poll and tells "seen"
// (`talkOnly`), and managing the channel (calling, muting, taking out, closing, reopening, closing a poll) stays absent.
import type { IdentityInput } from '../../../app/renderer/agent-identity.ts'
import type { ContextMenuEntry, PaneEmblem } from '../../../app/renderer/ext-api.ts'
import { HUE_NAMES } from '../../../app/shared/palette.ts'
import type { ChannelSummary, MemberInfo, MessageReactions, PollState } from '../../../extensions/channels/daemon/requests.ts'
import type { ChannelMarks } from '../../../extensions/channels/mark-board.ts'
import type { Line } from '../../../extensions/channels/rules.ts'
import type { EmbeddedChannel, EmbedOptions } from '../../../extensions/channels/renderer/embed.ts'
import { fileRef, parseFileRef } from './file-rules.ts'
import { remoteFiles, type RemoteFiles } from './files.ts'
import type { ChannelHost } from '../../../extensions/channels/renderer/host.ts'
import type { HistoryPage, MembersAnswer } from '../../../extensions/channels/renderer/view-model.ts'
import { regencyModelOf, stateCounts, type AgentRef, type RegencyInput, type RegencyModel, type StateCounts, type Target } from '../../../extensions/regency/model.ts'
import type { RegencyHost, TreeQuery } from '../../../extensions/regency/renderer/pane.ts'
import type { SystemViewHost } from '../../../extensions/regency/renderer/system-view.ts'
import { systemModelOf } from '../../../extensions/regency/system-rules.ts'

// ---------------------------------------------------------------- the source (the contract's shapes)

/** `regency.tree`: the model's entry as the house keeps it. `live`: the app is open and publishing; else `asOf` says when it last did. */
export interface TreeAnswer { input: RegencyInput; live: boolean; asOf?: number; sig?: string }

/** One row of `channels.marks`. */
export interface MarkRow {
  channel: string
  name: string
  unread: number
  toMe: number
  seen: number
  asks: number
  owed: number
  firstToMe?: number
  firstCall?: { why: 'to-you' | 'reaction-asks' | 'poll-owed'; text: string }
  /** The ids of the agents in the channel now (the panes' ids of the tree), in the order they came in; never the person. */
  members: string[]
  /** How many ids were left out of `members`. */
  membersMore?: number
}
/** `moderator.name`: the person's name in the channels (`''`: an old house that does not say it). */
export interface MarksAnswer { channels: MarkRow[]; more: number; moderator: { name: string } }

/** A line of `channels.page`: a speech, a notice or a poll (reactions, votes and closes come summed, never as lines). */
export interface PageLine {
  seq: number
  at: string
  kind: 'message' | 'notice' | 'poll'
  from: Line['from']
  body: string
  /** The body was cut at the house's ceiling. */
  cut?: true
  to?: string[]
  replyTo?: number
  event?: Line['event']
  poll?: Line['poll']
  /** Name, size and type only: the path never leaves the house. */
  files?: { name: string; size: number; type: string }[]
  /** Said from a device ("de longe"); the house writes it, never the body. */
  afar?: true
}

/** `channels.page`. `before`: the cursor of the page before this one (absent: the channel starts here). */
export interface PageAnswer {
  channel: { id: string; name: string; title: string; closed?: true }
  lines: PageLine[]
  reactions: MessageReactions[]
  polls: PollState[]
  last: number
  before?: number
  /** Who is in the channel now (the channel's, the same on every page of it), in the order they came in; never the person. */
  members: RemoteMember[]
  /** How many were left out of `members`. */
  membersMore?: number
  /** The person's name in the channels, as in `channels.marks`. */
  moderator: { name: string }
}

/** Who is in a channel. */
export interface RemoteMember { id: string; name: string; muted?: true }

/** A thin notice of the house: it brings no content, only what to read again. */
export type RemoteNotice = { what: 'regency' } | { what: 'channels'; channels: readonly string[]; all?: boolean }

/**
 * Why a reading did not come. `no-scope`: the device lacks the scope of the reading (status 0x03); `too-large`: the answer
 * would pass the portal's ceiling; `locked`: the session asks for presence; `limit`: the device's pace ran out; `not-found`:
 * the channel is not known; `malformed`: the body did not have the contract's shape and was thrown away; `gone`: the
 * session ended before the answer; `failed`: anything else.
 */
export type RefusedWhy = 'no-scope' | 'too-large' | 'locked' | 'limit' | 'not-found' | 'malformed' | 'failed' | 'gone'

/** What a source throws when a reading does not come. */
export class SourceRefused extends Error {
  readonly why: RefusedWhy
  constructor(why: RefusedWhy) {
    super(why)
    this.name = 'SourceRefused'
    this.why = why
  }
}

const refusedWhy = (e: unknown): RefusedWhy | undefined => (e instanceof SourceRefused ? e.why : undefined)

export interface RemoteSource {
  tree(): Promise<TreeAnswer>
  marks(): Promise<MarksAnswer>
  /** A page of a channel: the newest, or the lines before `before`. */
  page(channel: string, before?: number): Promise<PageAnswer>
  /** One chunk of the `file`-th file of the line `seq` (step 4.3), from `offset`. Absent: the files are names and sizes only. */
  file?(channel: string, seq: number, file: number, offset: number): Promise<{ size: number; type: string; offset: number; data: string }>
  onNotice(listener: (n: RemoteNotice) => void): { dispose(): void }
}

// ---------------------------------------------------------------- the house as the device holds it (memory only)

const EMPTY_INPUT: RegencyInput = { desks: { desks: [] }, owners: { desk: {}, pane: {} }, channels: [], channelMarks: {}, agents: [], since: {}, collapsed: [] }
const PAGE_LINES = 50
/** The most pages asked to cover one page of the view when the house cut its answers by size. */
const PAGE_HOPS = 6
/** The core's line of a pane that waits for the person (extensions/regency/renderer/columns.ts skips it the same way). */
const CORE_WAITING_LINE = 'Esperando você'

/** What a pane's seal says the agent is doing: its first line that is not the core's "waiting" (the app's rule). */
export const sealSays = (lines: readonly string[] | undefined): string | undefined => lines?.find(l => l !== CORE_WAITING_LINE)

/**
 * What the device knows of the house now: the tree and the marks, read at start and again at each notice. Kept in memory
 * only: nothing of the house is written to the device.
 */
export class RemoteHouse {
  private readonly source: RemoteSource
  private treeAnswer: TreeAnswer | undefined
  private readonly marks = new Map<string, MarkRow>()
  private marksLoaded = false
  /** The person's name in the channels (`''`: not said). */
  private moderator = ''
  /** Who is in each channel, from its last page read (the members are the channel's, not the page's). */
  private readonly pageMembers = new Map<string, RemoteMember[]>()
  /** The newest page of each channel being read now. */
  private readonly newest = new Map<string, Promise<PageAnswer>>()
  private readonly changed = new Set<() => void>()
  private readonly stale = new Set<(channelId: string) => void>()
  private sub: { dispose(): void } | undefined
  private readingTree = false
  private treeAgain = false
  private readingMarks = false
  private marksAgain = false
  /** The last reading failed (the session ended, the house refused): the screen keeps what it has. */
  failed = false
  /**
   * Why the desks are not shown: the device lacks `regency:read` (the tree never comes; the channels stand on the marks), or
   * the tree is too big to come (the last one read, if any, stays).
   */
  treeProblem: 'no-scope' | 'too-large' | undefined
  /** The device lacks `channels`: the channels' part goes (no channel, no mark, no page). */
  channelsProblem: 'no-scope' | undefined

  constructor(source: RemoteSource) { this.source = source }

  /** Reads the tree and the marks and hears the notices. */
  start(): void {
    if (this.sub) return
    this.sub = this.source.onNotice(n => {
      if (n.what === 'regency') { void this.readTree(); return }
      void this.readMarks()
      const ids = n.all ? [...this.openViews] : n.channels
      for (const id of ids) for (const l of [...this.stale]) l(id)
    })
    void this.readTree()
    void this.readMarks()
  }

  dispose(): void {
    this.sub?.dispose()
    this.sub = undefined
    this.changed.clear()
    this.stale.clear()
  }

  /** The channels with a view open (a notice with `all` reads each again). */
  readonly openViews = new Set<string>()

  /** The first reading of the tree ended: it came, or the house said why it will not. */
  get loaded(): boolean { return this.treeAnswer !== undefined || this.treeProblem !== undefined }
  /** A tree is held (without one, whether the app is open on the machine is not known). */
  get hasTree(): boolean { return this.treeAnswer !== undefined }
  /** The app is open on the machine and publishing. */
  get live(): boolean { return this.treeAnswer?.live === true }
  /** When the app last published (epoch ms), while it is closed; undefined when it is open or never published. */
  get asOf(): number | undefined { return this.treeAnswer && !this.treeAnswer.live ? this.treeAnswer.asOf : undefined }

  /** The model's entry: the house's tree with the marks the house counts now over the ones the app last published. */
  input(): RegencyInput {
    if (this.channelsProblem === 'no-scope') return { ...(this.treeAnswer?.input ?? EMPTY_INPUT), channels: [], channelMarks: {} }
    const base = this.treeAnswer?.input ?? (this.treeProblem === 'no-scope' ? this.channelsOfMarks() : EMPTY_INPUT)
    if (!this.marksLoaded) return base
    const channelMarks: RegencyInput['channelMarks'] = { ...base.channelMarks }
    for (const [id, m] of this.marks) {
      channelMarks[id] = { unread: m.unread, toMe: m.toMe, asks: m.asks, owed: m.owed, ...(m.firstCall ? { first: m.firstCall } : {}) }
    }
    return { ...base, channelMarks }
  }

  /** Without the tree (no `regency:read`), the open channels are the ones the marks name. */
  private channelsOfMarks(): RegencyInput {
    const channels: ChannelSummary[] = [...this.marks.values()].map(m => ({
      id: m.channel, name: m.name || m.channel, title: m.name || m.channel, owner: { kind: 'user' }, members: m.members.length + (m.membersMore ?? 0), seenByUser: 0, createdAt: '',
    }))
    return { ...EMPTY_INPUT, channels }
  }

  markOf(channelId: string): MarkRow | undefined { return this.channelsProblem ? undefined : this.marks.get(channelId) }

  /**
   * Which channels are open is known: the tree came (its list), or the marks did, or the device lacks `channels` (none). Until
   * then a channel the address names can be neither found nor refused.
   */
  get channelsKnown(): boolean { return this.channelsProblem !== undefined || this.treeAnswer !== undefined || this.marksLoaded }

  /** The person's name in the channels, as the house said it last (undefined: not said, an old house). */
  moderatorName(): string | undefined { return this.channelsProblem ? undefined : this.moderator || undefined }

  /** Who is in the channel, as its last page read said (undefined: no page of it read yet). */
  membersOf(channelId: string): readonly RemoteMember[] | undefined { return this.channelsProblem ? undefined : this.pageMembers.get(channelId) }

  /** The seal's lines of a pane, only while the app publishes (a closed app's tree says what the agent WAS doing). */
  lines(paneId: string): readonly string[] | undefined {
    if (!this.live) return undefined
    for (const d of this.treeAnswer!.input.desks.desks) for (const p of d.panes) if (p.id === paneId) return p.lines?.length ? p.lines : undefined
    return undefined
  }

  /** The open channels an agent is in, by its pane id: the marks whose members name it, in the marks' order. */
  channelsOf(agentId: string): MarkRow[] {
    if (this.channelsProblem) return []
    return [...this.marks.values()].filter(m => m.members.includes(agentId))
  }

  onDidChange(listener: () => void): { dispose(): void } {
    this.changed.add(listener)
    return { dispose: () => { this.changed.delete(listener) } }
  }

  /** A channel changed in the house: its view reads its newest page again. */
  onStale(listener: (channelId: string) => void): { dispose(): void } {
    this.stale.add(listener)
    return { dispose: () => { this.stale.delete(listener) } }
  }

  private notify(): void {
    for (const l of [...this.changed]) { try { l() } catch (e) { console.error('remote house listener', e) } }
  }

  // One reading of each kind at a time; a notice that comes meanwhile asks once more when it ends (the last state wins).
  private async readTree(): Promise<void> {
    if (this.readingTree) { this.treeAgain = true; return }
    this.readingTree = true
    try {
      do {
        this.treeAgain = false
        this.treeAnswer = await this.source.tree()
        this.treeProblem = undefined
        this.failed = false
        this.notify()
      } while (this.treeAgain)
    } catch (e) {
      const why = refusedWhy(e)
      if (why === 'no-scope') { this.treeAnswer = undefined; this.treeProblem = 'no-scope' } else if (why === 'too-large') this.treeProblem = 'too-large'
      this.failed = true
      this.notify()
    } finally { this.readingTree = false }
  }

  private lostChannels(e: unknown): void {
    if (refusedWhy(e) !== 'no-scope' || this.channelsProblem) return
    this.channelsProblem = 'no-scope'
    this.marks.clear()
    this.marksLoaded = false
    this.pageMembers.clear()
    this.moderator = ''
    this.notify()
  }

  private async readMarks(): Promise<void> {
    if (this.readingMarks) { this.marksAgain = true; return }
    this.readingMarks = true
    try {
      do {
        this.marksAgain = false
        const answer = await this.source.marks()
        this.marks.clear()
        for (const row of answer.channels) this.marks.set(row.channel, row)
        this.moderator = answer.moderator.name
        this.marksLoaded = true
        this.channelsProblem = undefined
        this.notify()
      } while (this.marksAgain)
    } catch (e) { this.lostChannels(e) /* else the next notice asks again */ } finally { this.readingMarks = false }
  }

  page(channel: string, before?: number): Promise<PageAnswer> {
    // The newest page asked again while it is read is the same reading (the view asks its lines and its members together).
    const known = before === undefined ? this.newest.get(channel) : undefined
    if (known) return known
    const p = this.source.page(channel, before).then(
      a => {
        this.pageMembers.set(channel, a.members)
        if (a.moderator.name) this.moderator = a.moderator.name
        return a
      },
      (e: unknown) => { this.lostChannels(e); throw e },
    )
    if (before === undefined) {
      this.newest.set(channel, p)
      const done = (): void => { if (this.newest.get(channel) === p) this.newest.delete(channel) }
      p.then(done, done)
    }
    return p
  }

  /** Who is in the channel now: the newest page being read says it, else the last one read, else a page is read for it. */
  /** One chunk of a file of a line, through the session's source (a source without files refuses it). */
  fileChunk(channel: string, seq: number, file: number, offset: number): Promise<{ size: number; type: string; offset: number; data: string }> {
    return this.source.file ? this.source.file(channel, seq, file, offset) : Promise.reject(new SourceRefused('failed'))
  }

  async members(channel: string): Promise<readonly RemoteMember[]> {
    const reading = this.newest.get(channel)
    if (reading) return (await reading).members
    return this.membersOf(channel) ?? (await this.page(channel)).members
  }
}

/** An agent's emblem as the house published it, when its colour is one of the 12 hues (anything else: no emblem, the letter stands). */
export function emblemOf(agent: AgentRef | undefined): PaneEmblem | undefined {
  const e = agent?.emblem
  const color = e ? HUE_NAMES.find(h => h === e.color) : undefined
  return e && color ? { name: e.name, color, icon: e.icon } : undefined
}

// ---------------------------------------------------------------- the channel's view

const NOTHING = { dispose: (): void => {} }
const readOnlyError = (): Error => new Error('Daqui você só acompanha.')

function lineOf(l: PageLine, channelId: string, files: RemoteFiles): Line {
  return {
    seq: l.seq, at: l.at, kind: l.kind, from: l.from, body: l.cut ? `${l.body}…` : l.body,
    ...(l.to ? { to: l.to } : {}), ...(l.replyTo !== undefined ? { replyTo: l.replyTo } : {}), ...(l.event ? { event: l.event } : {}),
    ...(l.poll ? { poll: l.poll } : {}), ...(l.afar ? { afar: true as const } : {}),
    // The path stays in the house: a reference to the line and the index stands for it (step 4.3), and the files ask by it.
    ...(l.files?.length ? {
      files: l.files.map((f, i) => {
        const path = fileRef(channelId, l.seq, i)
        files.known(path, { name: f.name, size: f.size, type: f.type })
        return { name: f.name, path, size: f.size, type: f.type }
      }),
    } : {}),
  }
}

/** What the acts of the shared screen that remain in a reading (a click on an agent's name, a link) ask of the web's shell. */
export interface RemoteActs {
  /** The reading card of a pane or an agent, by its pane id. */
  quick(paneId: string): void
  /** A floating menu at page coordinates (a speech's reactions and "Copiar", a poll's votes): the web's own. */
  menu?(x: number, y: number, entries: ContextMenuEntry[]): void
}

/**
 * What the channel's view asks of a device that may converse (talk.ts `Talker`): the four gestures, "seen", and the pages
 * that confirm the speeches on their way. Absent: the view only reads.
 */
export interface RemoteTalk {
  say(channel: string, text: string, to: readonly string[], files?: readonly { file: Blob; name: string }[]): Promise<void>
  react(channel: string, seq: number, reaction: string, remove: boolean): Promise<{ changed: boolean }>
  vote(channel: string, poll: number, vote: number, reason?: string): Promise<unknown>
  poll(channel: string, args: { question: string; options?: readonly string[]; to?: readonly string[]; timeoutMs?: number }): Promise<unknown>
  seen(channel: string, seq: number): void
  confirmed(channel: string, last: number): void
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/**
 * The channel's view over the house: reading only, or, with `talk`, conversing (`talkOnly`: speaking, reacting, voting,
 * opening a poll and "seen"; managing the channel stays at the machine).
 */
export function remoteChannelHost(house: RemoteHouse, acts: RemoteActs, talk?: RemoteTalk, files: RemoteFiles = remoteFiles(house)): ChannelHost {
  const summaryOf = (channelId: string, from?: PageAnswer['channel']): ChannelSummary => {
    const known = house.input().channels.find(c => c.id === channelId)
    if (known) return known
    return {
      id: channelId, name: from?.name ?? channelId, title: from?.title ?? '', owner: { kind: 'user' }, members: 0, seenByUser: 0, createdAt: '',
      ...(from?.closed ? { closed: { at: '', by: '' } } : {}),
    }
  }

  /**
   * One page of the view (up to PAGE_LINES lines). The house cuts an answer that is too big and gives the cursor of what
   * is left: the rest is asked until the page the view counts on is whole.
   */
  const history = async (channelId: string, before: number | undefined): Promise<HistoryPage> => {
    let answer = await house.page(channelId, before)
    const lines = [...answer.lines]
    const reactions = [...answer.reactions]
    const polls = [...answer.polls]
    const floor = Math.max(1, (before ?? answer.last + 1) - PAGE_LINES)
    for (let hop = 0; hop < PAGE_HOPS && answer.before !== undefined && answer.before > floor && lines.length < PAGE_LINES; hop++) {
      answer = await house.page(channelId, answer.before)
      lines.unshift(...answer.lines)
      reactions.unshift(...answer.reactions)
      polls.unshift(...answer.polls)
    }
    // The newest page holds what landed up to its last line: the speeches on their way that are there now leave the outbox.
    if (before === undefined) talk?.confirmed(channelId, answer.last)
    return { channel: summaryOf(channelId, answer.channel), lines: lines.map(l => lineOf(l, channelId, files)), reactions, polls, more: answer.before !== undefined, last: answer.last }
  }

  const members = async (channelId: string): Promise<MembersAnswer> => {
    // The house says who is in the channel now (not who spoke): the agents, never the person.
    const list = await house.members(channelId)
    const info = (m: RemoteMember): MemberInfo => ({ id: m.id, name: m.name, muted: m.muted === true, since: '', by: '', alive: true, path: 'inside' })
    return { channel: summaryOf(channelId), members: list.map(info), removed: [] }
  }

  const marksOf = (channelId: string): ChannelMarks => {
    const m = house.markOf(channelId)
    return m ? { unread: m.unread, toMe: m.toMe, seen: m.seen, ...(m.firstToMe !== undefined ? { firstToMe: m.firstToMe } : {}) } : { unread: 0, toMe: 0, seen: 0 }
  }

  /** The gestures of a device that converses, in the arguments the view gives (channel-pane.ts `ask`). */
  const write = async (t: RemoteTalk, name: string, channel: string, a: Record<string, unknown>): Promise<unknown> => {
    const int = (v: unknown): number => (typeof v === 'number' && Number.isSafeInteger(v) ? v : 0)
    switch (name) {
      case 'say': {
        // The box's files are this page's (files.ts `local`): the speech carries their bytes, the house never a path of here.
        const paths = Array.isArray(a.files) ? a.files.flatMap(f => (f && typeof (f as { path?: unknown }).path === 'string' ? [(f as { path: string }).path] : [])) : []
        await t.say(channel, typeof a.text === 'string' ? a.text : '', strings(a.to), files.local(paths))
        return {}
      }
      case 'react': return t.react(channel, int(a.seq), typeof a.reaction === 'string' ? a.reaction : '', a.remove === true)
      case 'vote': return t.vote(channel, int(a.poll), int(a.vote), typeof a.reason === 'string' ? a.reason : undefined)
      case 'poll': return t.poll(channel, {
        question: typeof a.question === 'string' ? a.question : '',
        ...(Array.isArray(a.options) ? { options: strings(a.options) } : {}),
        ...(Array.isArray(a.to) ? { to: strings(a.to) } : {}),
        ...(typeof a.timeoutMs === 'number' ? { timeoutMs: a.timeoutMs } : {}),
      })
      default: throw readOnlyError()
    }
  }

  return {
    readOnly: talk === undefined,
    talkOnly: talk !== undefined,
    // A device that converses attaches files too (step 4.3), by its own picker and within the limits from afar.
    attachTalk: talk !== undefined,
    request: async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
      const channel = String(args.channel ?? '')
      if (name === 'history') return await history(channel, typeof args.before === 'number' ? args.before : undefined) as T
      if (name === 'members') return await members(channel) as T
      if (talk) return await write(talk, name, channel, args) as T
      throw readOnlyError()
    },
    onEvent: <T>(name: string, listener: (ev: T) => void) => {
      // The house's notices are thin: a channel that changed is read again (the view's `stale`); no line ever comes alone.
      if (name === 'stale') return house.onStale(channelId => (listener as (ev: { channelId: string }) => void)({ channelId }))
      return NOTHING
    },
    marks: {
      of: marksOf,
      // The house counts the asks and the polls owed; which speech each is on is not told to a reading device.
      asksOf: () => [],
      owedOf: () => [],
      // A device that converses tells the house what the person saw, as the app does; one that only reads marks nothing.
      viewed: (channelId, seq) => { talk?.seen(channelId, seq) },
      attended: () => {},
      paneChanged: () => {},
      onDidChange: listener => house.onDidChange(listener),
    },
    channels: () => house.input().channels,
    agent: id => { const a = house.input().agents.find(x => x.id === id); return a ? { kind: a.kind } : undefined },
    personEmblem: id => emblemOf(house.input().agents.find(x => x.id === id)),
    onDidChangeEmblems: listener => house.onDidChange(() => listener(undefined)),
    // The person's name in the channels, as the house says it: the lines' `to` name her by it ("para você").
    moderatorName: () => house.moderatorName(),
    // The files of the speeches come through the session by reference, and the box's are this page's (./files.ts).
    files,
    // Only an address of the web opens, in another tab, with no way back to this page; a place of the app has no door here.
    // A file of a speech is downloaded (step 4.3): its reference names a line of the house, never a path.
    follow: target => {
      if (target.kind === 'external' && /^https?:\/\//i.test(target.url)) window.open(target.url, '_blank', 'noopener,noreferrer')
      else if (target.kind === 'file' && parseFileRef(target.path)) void files.download(target.path).catch(() => {})
    },
    linkMenu: () => {},
    // The rows are the view's: a device that only reads gets "Copiar" alone (the "⋯" of a speech is never a dead button).
    menu: (x, y, entries) => { acts.menu?.(x, y, entries) },
    ask: () => Promise.reject(readOnlyError()),
    run: async () => undefined,
    peek: paneId => acts.quick(paneId),
    copyLink: () => {},
    emblemMenu: () => {},
    movePane: () => {},
    closePane: () => {},
    tabMenu: () => {},
    writeClipboard: text => { void navigator.clipboard?.writeText(text).catch(() => {}) },
    keyTable: () => ({ bindingsOf: () => [], hint: () => '' }),
  }
}

// ---------------------------------------------------------------- the Regency's pane

/** What the Regency's host asks of the web's shell: the channel's mount and the reading card. */
export interface RemoteRegencyParts {
  mount(place: HTMLElement, channelId: string, opts: EmbedOptions): EmbeddedChannel | undefined
  /** The reading card of a pane or an agent (the place of the app's quick view). */
  quick: {
    open(target: Target): void
    toggle(target: Target): void
    /** The pane id in the card now. */
    shown(): string | undefined
    close(): void
  }
  /** The Regency is on screen (not behind the offline notice). */
  visible(): boolean
  /** The casing's width: the tier is the screen's, not the framed pane's. */
  width?(): number
  /** A device that may manage (RR5 5.4): the rows' menus, the desk's moon, "+ Nova mesa" and "Sistema" act through it. */
  manage?: RemoteManageParts
}

/** What managing from afar gives the Regency's pane (manage-view.ts). Absent: the pane only reads. */
export interface RemoteManageParts {
  rowMenu(target: Target, anchor: HTMLElement, at?: { x: number; y: number }): void
  sleepDesk(deskId: string, wake: boolean): void
  renameRefused(what: 'desk' | 'pane'): void
  /** "+ Nova mesa": a desk's name and colour (the app's "+ Novo" card has no road from afar). */
  create(restore: () => void): void
  system: SystemViewHost
}

/** "Sistema" is out of the reading Regency: an empty model and no act (the pane's sheet takes its door away). */
function noSystem(): SystemViewHost {
  const model = systemModelOf({ now: 0, procs: [], agents: [], profiles: [], folders: [] })
  const refused = { refusal: 'Daqui você só acompanha.' } as const
  const off = { ok: false, code: 'read-only', message: refused.refusal } as const
  return {
    model: () => model,
    procsActive: () => false,
    identity: () => undefined,
    proc: async () => refused,
    peekLog: () => refused,
    logOnDesk: async () => undefined,
    seen: () => {},
    setRonda: async () => off,
    offRonda: async () => off,
    editProfile: () => {},
    newProcess: restore => restore(),
    createHere: (_what, _cwd, restore) => restore(),
    togglePin: () => {},
    openScreen: () => {},
    showStatus: () => false,
    menu: () => {},
    tick: () => {},
  }
}

/** The Regency's pane over the house, reading only: the model runs here, on the tree the house publishes. */
export function remoteRegencyHost(house: RemoteHouse, parts: RemoteRegencyParts): RegencyHost {
  const view = (q: TreeQuery): { model: RegencyModel; counts: StateCounts } => {
    const input = house.input()
    return { model: regencyModelOf({ ...input, collapsed: [...q.collapsed], filter: q.filter, query: q.query }), counts: stateCounts(input) }
  }
  const identity = (paneId: string): IdentityInput | undefined => {
    const a = house.input().agents.find(x => x.id === paneId)
    return a ? { kind: a.kind, name: a.name, seed: a.id, emblem: emblemOf(a) } : undefined
  }
  const openChannels = (): ChannelSummary[] => house.input().channels.filter(c => !c.closed)
  const manage = parts.manage
  return {
    readOnly: manage === undefined,
    view,
    quickView: target => parts.quick.open(target),
    toggleQuick: target => parts.quick.toggle(target),
    quicked: () => parts.quick.shown(),
    closeQuick: () => parts.quick.close(),
    rowMenu: (target, anchor, at) => manage?.rowMenu(target, anchor, at),
    talk: target => parts.quick.open(target),
    sleepDesk: (deskId, wake) => manage?.sleepDesk(deskId, wake),
    renameRefused: what => manage?.renameRefused(what),
    loading: () => !house.loaded,
    identity,
    // The seal's lines, only while the app publishes them (cleaned as a title by the house's projector).
    lines: id => house.lines(id),
    channel: id => house.input().channels.find(c => c.id === id),
    openChannels,
    mount: (place, channelId, opts) => parts.mount(place, channelId, opts),
    // There is no tab to go to from afar: a pane or an agent shows its reading card.
    go: target => { if (target.kind === 'pane' || target.kind === 'agent') parts.quick.open(target) },
    // "Escolher canal…": the open channel that calls the person first, else the first one.
    pickChannel: async () => {
      const open = openChannels()
      const calls = (id: string): number => { const m = house.markOf(id); return m ? m.toMe + m.asks + m.owed : 0 }
      return (open.find(c => calls(c.id) > 0) ?? open[0])?.id
    },
    // The layout (the view, the filter, the place) lives while the page does: nothing is written to the device.
    saved: () => {},
    visible: () => parts.visible(),
    ...(parts.width ? { tierWidth: () => parts.width!() } : {}),
    gone: () => {},
    immersionKey: () => '',
    // Only a desk is made from afar: the heading's "+" (a desk row's "+" and "Criar canal" have no road and are not drawn).
    create: (fixed, restore, what) => { if (manage && fixed.deskId === undefined && fixed.forAgent === undefined && what === undefined) manage.create(restore); else restore() },
    system: manage?.system ?? noSystem(),
  }
}
