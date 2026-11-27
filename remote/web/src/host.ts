// The remote hosts of the shared screen: the Regency's pane (`RegencyHost`) and the channel's view (`ChannelHost`) over what
// a house answers through the relay, reading only. The screen is the app's own (extensions/regency/renderer/pane.ts,
// extensions/channels/renderer/channel-pane.ts); the model runs here, on the device, over the tree the house publishes.
//
// The source (`RemoteSource`) is the three readings and the two thin notices of the house, in the shape of the contract
// (`regency.tree`, `channels.marks`, `channels.page`; `regency.changed`, `channels.changed`). This module does not know the
// wire: the session gives a source that asks the relay, the bench gives a made-up one. What a source returns is already
// checked data; every text of it reaches the page as a text node, because the shared screen never writes HTML.
//
// Nothing here acts on the house: every gesture of the shared screen that would (speak, react, vote, create, rename, a
// menu) is off in the screen itself (`readOnly`) and answers nothing here.
import type { IdentityInput } from '../../../app/renderer/agent-identity.ts'
import type { PaneEmblem } from '../../../app/renderer/ext-api.ts'
import { HUE_NAMES } from '../../../app/shared/palette.ts'
import type { ChannelSummary, MemberInfo, MessageReactions, PollState } from '../../../extensions/channels/daemon/requests.ts'
import type { ChannelMarks } from '../../../extensions/channels/mark-board.ts'
import type { Line } from '../../../extensions/channels/rules.ts'
import type { EmbeddedChannel, EmbedOptions } from '../../../extensions/channels/renderer/embed.ts'
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
}
export interface MarksAnswer { channels: MarkRow[]; more: number }

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
}

/** `channels.page`. `before`: the cursor of the page before this one (absent: the channel starts here). */
export interface PageAnswer {
  channel: { id: string; name: string; title: string; closed?: true }
  lines: PageLine[]
  reactions: MessageReactions[]
  polls: PollState[]
  last: number
  before?: number
}

/** Who is in a channel, as much as a remote reading may know. */
export interface RemoteMember { id: string; name: string; muted?: boolean }

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
  /**
   * Who is in the channel. Not a reading of the contract yet: absent, the view shows who spoke in the page it holds (so the
   * count may fall short of the channel's).
   */
  members?(channel: string): Promise<RemoteMember[]>
  onNotice(listener: (n: RemoteNotice) => void): { dispose(): void }
}

// ---------------------------------------------------------------- the house as the device holds it (memory only)

const EMPTY_INPUT: RegencyInput = { desks: { desks: [] }, owners: { desk: {}, pane: {} }, channels: [], channelMarks: {}, agents: [], since: {}, collapsed: [] }
const PAGE_LINES = 50
/** The most pages asked to cover one page of the view when the house cut its answers by size. */
const PAGE_HOPS = 6

/**
 * What the device knows of the house now: the tree and the marks, read at start and again at each notice. Kept in memory
 * only: nothing of the house is written to the device.
 */
export class RemoteHouse {
  private readonly source: RemoteSource
  private treeAnswer: TreeAnswer | undefined
  private readonly marks = new Map<string, MarkRow>()
  private marksLoaded = false
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
      id: m.channel, name: m.name || m.channel, title: m.name || m.channel, owner: { kind: 'user' }, members: 0, seenByUser: 0, createdAt: '',
    }))
    return { ...EMPTY_INPUT, channels }
  }

  markOf(channelId: string): MarkRow | undefined { return this.channelsProblem ? undefined : this.marks.get(channelId) }

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
        this.marksLoaded = true
        this.channelsProblem = undefined
        this.notify()
      } while (this.marksAgain)
    } catch (e) { this.lostChannels(e) /* else the next notice asks again */ } finally { this.readingMarks = false }
  }

  page(channel: string, before?: number): Promise<PageAnswer> {
    return this.source.page(channel, before).catch((e: unknown) => { this.lostChannels(e); throw e })
  }
  members(channel: string): Promise<RemoteMember[]> | undefined { return this.source.members?.(channel) }
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

function lineOf(l: PageLine): Line {
  return {
    seq: l.seq, at: l.at, kind: l.kind, from: l.from, body: l.cut ? `${l.body}…` : l.body,
    ...(l.to ? { to: l.to } : {}), ...(l.replyTo !== undefined ? { replyTo: l.replyTo } : {}), ...(l.event ? { event: l.event } : {}),
    ...(l.poll ? { poll: l.poll } : {}),
    // The path stays in the house: the name stands for it (the card shows the name and the size, and opens nothing).
    ...(l.files?.length ? { files: l.files.map(f => ({ name: f.name, path: f.name, size: f.size, type: f.type })) } : {}),
  }
}

/** What the acts of the shared screen that remain in a reading (a click on an agent's name, a link) ask of the web's shell. */
export interface RemoteActs {
  /** The reading card of a pane or an agent, by its pane id. */
  quick(paneId: string): void
}

/** The channel's view over the house, reading only. */
export function remoteChannelHost(house: RemoteHouse, acts: RemoteActs): ChannelHost {
  /** Who spoke in the pages read of each channel, in order of appearance: the members shown when the source has no list. */
  const spoke = new Map<string, Map<string, string>>()

  const summaryOf = (channelId: string, from?: PageAnswer['channel']): ChannelSummary => {
    const known = house.input().channels.find(c => c.id === channelId)
    if (known) return known
    return {
      id: channelId, name: from?.name ?? channelId, title: from?.title ?? '', owner: { kind: 'user' }, members: 0, seenByUser: 0, createdAt: '',
      ...(from?.closed ? { closed: { at: '', by: '' } } : {}),
    }
  }

  const note = (channelId: string, lines: readonly PageLine[]): void => {
    let m = spoke.get(channelId)
    if (!m) { m = new Map(); spoke.set(channelId, m) }
    for (const l of lines) {
      const role = l.from.role
      if (l.kind === 'notice' || role === 'moderator' || role === 'system' || l.from.id === 'user' || l.from.id === 'tether') continue
      if (!m.has(l.from.id)) m.set(l.from.id, l.from.name)
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
    note(channelId, lines)
    return { channel: summaryOf(channelId, answer.channel), lines: lines.map(lineOf), reactions, polls, more: answer.before !== undefined, last: answer.last }
  }

  const members = async (channelId: string): Promise<MembersAnswer> => {
    const listed = await house.members(channelId)?.catch(() => undefined)
    const list: RemoteMember[] = listed ?? [...(spoke.get(channelId) ?? new Map<string, string>())].map(([id, name]) => ({ id, name }))
    const info = (m: RemoteMember): MemberInfo => ({ id: m.id, name: m.name, muted: m.muted === true, since: '', by: '', alive: true, path: 'inside' })
    return { channel: summaryOf(channelId), members: list.map(info), removed: [] }
  }

  const marksOf = (channelId: string): ChannelMarks => {
    const m = house.markOf(channelId)
    return m ? { unread: m.unread, toMe: m.toMe, seen: m.seen, ...(m.firstToMe !== undefined ? { firstToMe: m.firstToMe } : {}) } : { unread: 0, toMe: 0, seen: 0 }
  }

  return {
    readOnly: true,
    request: async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
      const channel = String(args.channel ?? '')
      if (name === 'history') return await history(channel, typeof args.before === 'number' ? args.before : undefined) as T
      if (name === 'members') return await members(channel) as T
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
      // Seeing a line from afar marks nothing as seen in the house.
      viewed: () => {},
      attended: () => {},
      paneChanged: () => {},
      onDidChange: listener => house.onDidChange(listener),
    },
    channels: () => house.input().channels,
    agent: id => { const a = house.input().agents.find(x => x.id === id); return a ? { kind: a.kind } : undefined },
    personEmblem: id => emblemOf(house.input().agents.find(x => x.id === id)),
    onDidChangeEmblems: listener => house.onDidChange(() => listener(undefined)),
    // The name the house's person goes by in the channels is not published: the default stands.
    moderatorName: () => undefined,
    files: {
      inspect: async () => [],
      pick: async () => [],
      stageImage: async () => undefined,
      discard: () => {},
      pathOf: () => '',
      // A file is in the house: here it is a name and a size, never "gone" and never a picture.
      look: async paths => paths.map(path => ({ path, missing: false })),
      view: async path => ({ path, missing: true }),
    },
    // Only an address of the web opens, in another tab, with no way back to this page; a place of the app has no door here.
    follow: target => { if (target.kind === 'external' && /^https?:\/\//i.test(target.url)) window.open(target.url, '_blank', 'noopener,noreferrer') },
    linkMenu: () => {},
    menu: () => {},
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
  return {
    readOnly: true,
    view,
    quickView: target => parts.quick.open(target),
    toggleQuick: target => parts.quick.toggle(target),
    quicked: () => parts.quick.shown(),
    closeQuick: () => parts.quick.close(),
    rowMenu: () => {},
    talk: target => parts.quick.open(target),
    sleepDesk: () => {},
    renameRefused: () => {},
    loading: () => !house.loaded,
    identity,
    // What a pane's seal says is not published (it may quote the terminal).
    lines: () => undefined,
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
    create: (_fixed, restore) => restore(),
    system: noSystem(),
  }
}
