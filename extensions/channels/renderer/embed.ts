// Feed C: what another extension (the Regency) reads of the channels and how it embeds a channel's view outside the dockview.
// Pure: no DOM at runtime, no import of the renderer host; it knows nothing of its readers. The channels extension publishes
// its directory, its marks and the mount of the channel's view here in `activate`; with channels off the feed is inactive:
// `list()` is empty, `marksOf` says zero and `mount` gives `undefined`. The same pattern as for-agents/desk-owners.ts.
import type { ChannelSummary } from '../daemon/requests.ts'
import type { MemberRow } from './view-model.ts'

/** The marks of one channel, as counts: unseen lines, the ones to the person, reactions that ask her, polls owing her vote. */
export interface EmbedMarks {
  unread: number
  toMe: number
  asks: number
  owed: number
  /** The oldest call not yet answered, in one line ("conferente: Posso seguir?"), and which of the three it is. */
  first?: { why: 'to-you' | 'reaction-asks' | 'poll-owed'; text: string }
}

export interface EmbedOptions {
  /** Where the members' column goes (the Regency's "Neste canal"). Given, the narrow composition no longer folds it. */
  membersHost?: HTMLElement
}

/** A channel's view mounted outside the dockview. Changing channel is `dispose()` and a new `mount`. */
export interface EmbeddedChannel {
  readonly element: HTMLElement
  readonly channelId: string
  /** The members as the column draws them (empty until the first `members` answer). */
  members(): readonly MemberRow[]
  onDidChangeMembers(listener: () => void): { dispose(): void }
  /** Puts the keyboard in the conversation. */
  focus(): void
  /** Takes the view (and the members' column) out of the page; its reading place is kept like a closed tab's. */
  dispose(): void
}

/** An act of the feed: done, or refused in plain words (pt-BR, ready to show). */
export type EmbedAct<T = object> = ({ ok: true } & T) | { refusal: string }

/** The acts the Regency's "+ Novo" asks of the channels; the same rules and requests as the channel commands. */
export interface ChannelEmbedActs {
  /** Creates a channel with this name (the rule of names is the daemon's); the id, or the refusal (name taken, invalid...). */
  create(name: string): Promise<EmbedAct<{ id: string }>>
  /** Joins an agent (slot id) to a channel. */
  join(channelId: string, agent: string): Promise<EmbedAct>
  /** Opens the channel as a tab on a desk, without taking the person there; refused when the desk is unknown or the channel already has a tab. */
  openOn(channelId: string, deskId: string): EmbedAct
}

/** What the channels extension gives the feed while it is on. */
export interface ChannelEmbedSource extends ChannelEmbedActs {
  list(): readonly ChannelSummary[]
  marksOf(channelId: string): EmbedMarks
  /** The directory or the marks changed. */
  onDidChange(listener: () => void): { dispose(): void }
  mount(host: HTMLElement, channelId: string, opts?: EmbedOptions): EmbeddedChannel | undefined
}

export interface ChannelEmbedFeed extends ChannelEmbedActs {
  /** channels is on and publishing in this process. */
  readonly active: boolean
  /** The channels the app knows, open and closed. */
  list(): readonly ChannelSummary[]
  marksOf(channelId: string): EmbedMarks
  /** The list or the marks changed, or the feed turned on or off. A listener lives across publications. */
  onDidChange(listener: () => void): { dispose(): void }
  /** Mounts the channel's view in `host`; `undefined` while the feed is inactive. */
  mount(host: HTMLElement, channelId: string, opts?: EmbedOptions): EmbeddedChannel | undefined
}

export interface ChannelEmbedPublisher extends ChannelEmbedFeed {
  /** Turns the feed on with `source`, replacing any earlier one; the returned handle turns it off (if it is still the current one). */
  publish(source: ChannelEmbedSource): { dispose(): void }
}

const NO_MARKS: EmbedMarks = { unread: 0, toMe: 0, asks: 0, owed: 0 }
const OFF = { refusal: 'Os canais estão desligados.' } as const

export function createChannelEmbeds(): ChannelEmbedPublisher {
  const listeners = new Set<() => void>()
  let source: ChannelEmbedSource | undefined
  let sub: { dispose(): void } | undefined
  const notify = (): void => {
    for (const l of [...listeners]) { try { l() } catch (e) { console.error('channel embeds listener', e) } }
  }
  const unpublish = (): void => {
    sub?.dispose()
    sub = undefined
    source = undefined
  }
  return {
    get active() { return source !== undefined },
    list: () => source?.list() ?? [],
    marksOf: (channelId) => source?.marksOf(channelId) ?? { ...NO_MARKS },
    onDidChange(listener) {
      listeners.add(listener)
      return { dispose: () => { listeners.delete(listener) } }
    },
    mount: (host, channelId, opts) => source?.mount(host, channelId, opts),
    create: async name => source ? source.create(name) : OFF,
    join: async (channelId, agent) => source ? source.join(channelId, agent) : OFF,
    openOn: (channelId, deskId) => source ? source.openOn(channelId, deskId) : OFF,
    publish(next) {
      unpublish()
      source = next
      sub = next.onDidChange(notify)
      notify()
      let live = true
      return {
        dispose: () => {
          if (!live) return
          live = false
          if (source !== next) return
          unpublish()
          notify()
        },
      }
    },
  }
}

/** The one of the process: channels feeds it, the Regency reads it. */
export const channelEmbeds: ChannelEmbedPublisher = createChannelEmbeds()
