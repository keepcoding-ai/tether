// The marks of the channels (slice U3): what the person has not read, and what is said to her.
//   - A line from an agent is "unread" until the person sees the end of the conversation: it counts on the channel's tab (a quiet
//     ring, no colour; drawn by the tab itself) and in the top bar's popover. It never activates a pane, switches a desk, takes focus or throws a toast.
//   - A line whose `to` includes the moderator also lights the attention seal on the channel's pane (when it is open) and the
//     top bar icon's state (open or not). The seal is sticky: seeing the pane does not clear it, reaching the end does (P1).
//   - Nothing is ever marked on the pane of whoever spoke: only the channel's own pane gets a mark.
// `MarkBoard` is pure (no DOM, no daemon); `createMarks` wires it to the daemon's `line` events and to the app's seal and emblem.
// Memory: one small map per channel, at most MAX_HELD entries; reconciled once from the newest page of each open channel.
import type { AttentionHandle, Disposable, TetherUi } from '../../../app/renderer/ext-api.ts'
import type { LineEvent, PollEvent, ReactionEvent } from '../daemon/fanout.ts'
import type { ChannelSummary, PollOwed } from '../daemon/requests.ts'
import { ASK_EMOJIS, reactionKey, type Ask, type Line } from '../rules.ts'
import { channelPaneId } from '../manifest.ts'
import { DEFAULT_MODERATOR_NAME, type HistoryPage } from './view-model.ts'

/** Unseen lines kept per channel (the count stops growing past it). */
export const MAX_HELD = 500
/** Channels read once at start to know what came while the app was closed. */
const RECONCILE_MAX = 30
const RECONCILE_PAGE = 50
const SYNC_DELAY_MS = 250
const START_RETRIES = 10
const START_RETRY_MS = 500

export type Heard = 'plain' | 'toMe'

const norm = (s: string): string => s.trim().toLowerCase()

/** What a line is to the person: undefined (not counted), a line for everyone, or one addressed to her. */
export function classify(line: Line, moderator: string): Heard | undefined {
  // The opening of a poll is a new speech; its votes and its close are no line of the conversation (never reach here).
  if (line.kind !== 'message' && line.kind !== 'poll') return undefined
  if (line.from.id === 'user' || line.from.role === 'moderator') return undefined
  const me = norm(moderator)
  return (line.to ?? []).some(n => norm(n) === me) ? 'toMe' : 'plain'
}

export interface ChannelMarks {
  /** Unseen lines from agents (the ones to her included). */
  unread: number
  /** Of those, the ones addressed to her. */
  toMe: number
  /** The `seq` of the first unseen line addressed to her. */
  firstToMe?: number
  /** The newest `seq` the person saw. */
  seen: number
}

interface Held { seen: number; lines: Map<number, Heard>; asks: Map<number, Ask>; dismissed: Set<number>; owed: Map<number, PollOwed> }

export class MarkBoard {
  private readonly held = new Map<string, Held>()

  private entry(channelId: string): Held {
    let h = this.held.get(channelId)
    if (!h) { h = { seen: 0, lines: new Map(), asks: new Map(), dismissed: new Set(), owed: new Map() }; this.held.set(channelId, h) }
    return h
  }

  /**
   * The open polls that wait for her vote, as the daemon counts them now (the whole set replaces the held one: a vote or a close
   * takes the poll out). No "seen" mark clears them: only voting or the close does (a poll she looked at still waits).
   */
  setOwed(channelId: string, owed: readonly PollOwed[]): boolean {
    const h = this.entry(channelId)
    const next = new Map(owed.slice(-MAX_HELD).map(p => [p.seq, p] as const))
    const same = next.size === h.owed.size && [...next.keys()].every(s => h.owed.has(s))
    h.owed = next
    return !same
  }

  owedOf(channelId: string): PollOwed[] {
    const h = this.held.get(channelId)
    return h ? [...h.owed.values()].sort((a, b) => a.seq - b.seq) : []
  }

  /**
   * The reactions that ask the person, as the daemon counts them now (the whole set replaces the held one: a ❓ taken back is gone).
   * What she already saw (up to the "seen" mark, or looked at in place) is not held.
   */
  setAsks(channelId: string, asks: readonly Ask[]): boolean {
    const h = this.entry(channelId)
    const next = new Map(asks.filter(a => a.seq > h.seen && !h.dismissed.has(a.seq)).slice(-MAX_HELD).map(a => [a.seq, a] as const))
    for (const s of [...h.dismissed]) if (!asks.some(a => a.seq === s)) h.dismissed.delete(s)
    const same = next.size === h.asks.size && [...next.keys()].every(s => h.asks.has(s))
    h.asks = next
    return !same
  }

  /**
   * The person has the speech of an ask on her screen. Returns `persist` (the "seen" mark is raised to the ask: nothing unseen lies
   * below it, so no other line or ask is hidden by it) or only forgets it for this session.
   */
  attended(channelId: string, seq: number): { changed: boolean; persist: boolean } {
    const h = this.held.get(channelId)
    if (!h || !h.asks.has(seq)) return { changed: false, persist: false }
    const clear = [...h.lines.keys(), ...h.asks.keys()].every(s => s >= seq)
    if (clear) { this.raise(h, seq); return { changed: true, persist: true } }
    h.asks.delete(seq)
    h.dismissed.add(seq)
    return { changed: true, persist: false }
  }

  /** The channel's `seenByUser` from the daemon: lines up to it are not news. Returns whether the marks changed. */
  baseline(channelId: string, seen: number): boolean { return this.raise(this.entry(channelId), seen) }

  /** A line heard live or read from the history; a repeat or an old one changes nothing. */
  hear(channelId: string, line: Line, moderator: string): boolean {
    const kind = classify(line, moderator)
    const h = this.entry(channelId)
    if (kind === undefined || line.seq <= h.seen || h.lines.get(line.seq) === kind) return false
    h.lines.set(line.seq, kind)
    if (h.lines.size > MAX_HELD) {
      let min = Infinity
      for (const s of h.lines.keys()) if (s < min) min = s
      h.lines.delete(min)
    }
    return true
  }

  /** A page of the history over what is held (the lines the app missed while it was closed). */
  load(channelId: string, lines: readonly Line[], seenByUser: number, moderator: string): boolean {
    let changed = this.baseline(channelId, seenByUser)
    for (const l of lines) if (this.hear(channelId, l, moderator)) changed = true
    return changed
  }

  /** The person saw the conversation up to `seq`. Returns whether the marks changed. */
  viewed(channelId: string, seq: number): boolean { return this.raise(this.entry(channelId), seq) }

  private raise(h: Held, seq: number): boolean {
    if (seq <= h.seen) return false
    h.seen = seq
    for (const s of [...h.lines.keys()]) if (s <= seq) h.lines.delete(s)
    for (const s of [...h.asks.keys()]) if (s <= seq) h.asks.delete(s)
    return true
  }

  of(channelId: string): ChannelMarks {
    const h = this.held.get(channelId)
    if (!h) return { unread: 0, toMe: 0, seen: 0 }
    let toMe = 0
    let first: number | undefined
    for (const [seq, kind] of h.lines) if (kind === 'toMe') { toMe++; if (first === undefined || seq < first) first = seq }
    return { unread: h.lines.size, toMe, ...(first !== undefined ? { firstToMe: first } : {}), seen: h.seen }
  }

  /** The reactions that ask her and she has not seen, oldest first (kept apart from the lines: they are no speech of an agent). */
  asksOf(channelId: string): Ask[] {
    const h = this.held.get(channelId)
    return h ? [...h.asks.values()].sort((a, b) => a.seq - b.seq) : []
  }

  forget(channelId: string): void { this.held.delete(channelId) }
}

// ---------- the effects ----------

export interface Totals { unread: number; toMe: number }

export interface Marks {
  disposables: Disposable[]
  of(channelId: string): ChannelMarks
  /** The ❓/❌ reactions of agents on her speeches that she has not seen: they light the same seal as a line for her. */
  asksOf(channelId: string): Ask[]
  /** The open polls that call her and wait for her vote: they light the same seal (orange) and go when she votes or the poll closes. */
  owedOf(channelId: string): PollOwed[]
  /** Open channels with something unseen, and the sums (what the popover and the icon say). */
  totals(): Totals
  /** The pane shows the end of the conversation to the person (active, visible, window in front): up to `seq` is seen. */
  viewed(channelId: string, seq: number): void
  /** The pane has the speech an ask is on in view (reaction `seq`): it asks no more; the "seen" mark follows when nothing unseen lies below it. */
  attended(channelId: string, seq: number): void
  /** A channel's pane appeared or went: its tab and seal are drawn (or taken down) again. */
  paneChanged(channelId: string): void
  onDidChange(listener: () => void): Disposable
}

export interface MarksDeps {
  /** The channels the app knows (U2's directory); marks only reads it and asks it to refresh. */
  list(): readonly ChannelSummary[]
  refresh(): Promise<readonly ChannelSummary[]>
}

export function createMarks(ui: TetherUi, deps: MarksDeps): Marks {
  const board = new MarkBoard()
  const listeners = new Set<() => void>()
  const dirty = new Set<string>()
  const seals = new Map<string, AttentionHandle>()
  /** Channels whose newest page was read. */
  const known = new Set<string>()
  const sent = new Map<string, number>()
  let syncTimer: ReturnType<typeof setTimeout> | undefined
  let syncing = false
  let again = false
  let disposed = false
  let flushing = false
  let startTries = 0

  const moderator = (): string => ui.settings.get<string>('moderatorName') ?? DEFAULT_MODERATOR_NAME
  const summaryOf = (channelId: string): ChannelSummary | undefined => deps.list().find(c => c.id === channelId)
  const nameOf = (channelId: string): string => summaryOf(channelId)?.name ?? channelId

  /** Drawn in one microtask however many lines came together: a line seen the moment it arrives never flickers. */
  const schedule = (channelId?: string): void => {
    if (channelId !== undefined) dirty.add(channelId)
    if (flushing) return
    flushing = true
    queueMicrotask(() => {
      flushing = false
      const ids = [...dirty]
      dirty.clear()
      if (disposed) return
      for (const id of ids) apply(id)
      for (const l of [...listeners]) { try { l() } catch (e) { console.error('channels marks listener', e) } }
    })
  }

  const apply = (channelId: string): void => {
    const paneId = channelPaneId(channelId)
    const open = ui.panes.find(paneId) !== undefined
    const m = board.of(channelId)
    const asks = board.asksOf(channelId)
    const owed = board.owedOf(channelId)
    // The quiet ring on the tab is the tab's own (channel-pane.ts ChannelTab): the core's emblems fill only its own tab headers.
    const handle = seals.get(channelId)
    if (open && m.toMe + asks.length + owed.length > 0) {
      const parts = [
        ...(m.toMe > 0 ? [m.toMe === 1 ? 'uma fala para você' : `${m.toMe} falas para você`] : []),
        ...(asks.length > 0 ? [asks.length === 1 ? '1 reação pede você' : `${asks.length} reações pedem você`] : []),
        ...(owed.length > 0 ? [owed.length === 1 ? '1 enquete espera o seu voto' : `${owed.length} enquetes esperam o seu voto`] : []),
      ]
      const message = `#${nameOf(channelId)}: ${parts.join(' e ')}`
      if (handle) handle.update({ message })
      else {
        try { seals.set(channelId, ui.attention.raise({ paneId, message, sticky: true })) } catch (e) { console.error('channels seal', e) }
      }
    } else if (handle) {
      handle.resolve()
      seals.delete(channelId)
    }
  }

  // ---------- what the daemon says ----------

  /** The reactions that ask her, as the daemon counts them (one read of the channel's tail); it also answers what was seen. */
  const refreshAsks = async (channelId: string): Promise<void> => {
    try {
      const r = await ui.daemon.request<{ asks: Ask[]; polls?: PollOwed[] }>('asks', { channel: channelId })
      if (disposed) return
      // Both sets are replaced (no short circuit).
      const asksChanged = board.setAsks(channelId, r.asks)
      const owedChanged = board.setOwed(channelId, r.polls ?? [])
      if (asksChanged || owedChanged) schedule(channelId)
    } catch { /* the next reaction or sync asks again */ }
  }

  const reconcile = async (c: ChannelSummary): Promise<void> => {
    try {
      const page = await ui.daemon.request<HistoryPage>('history', { channel: c.id, limit: RECONCILE_PAGE })
      known.add(c.id)
      sent.set(c.id, Math.max(sent.get(c.id) ?? 0, c.seenByUser))
      if (board.load(c.id, page.lines, c.seenByUser, moderator())) schedule(c.id)
      await refreshAsks(c.id)
    } catch { /* the next sync tries again */ }
  }

  const sync = async (): Promise<void> => {
    if (syncing) { again = true; return }
    syncing = true
    try {
      do {
        again = false
        let list: readonly ChannelSummary[] = []
        try { list = await deps.refresh(); startTries = 0 } catch {
          // The daemon may not answer extension requests yet at start: tried again a few times.
          if (startTries++ < START_RETRIES) setTimeout(() => { if (!disposed) void sync() }, START_RETRY_MS)
          break
        }
        if (disposed) return
        const open = list.filter(c => !c.closed)
        // A channel that was closed or is gone has nothing to mark.
        for (const c of list) if (c.closed) { known.delete(c.id); board.forget(c.id); schedule(c.id) }
        let n = 0
        for (const c of open) {
          if (known.has(c.id)) { if (board.baseline(c.id, c.seenByUser)) schedule(c.id); continue }
          if (n++ >= RECONCILE_MAX) break
          await reconcile(c)
          if (disposed) return
        }
        schedule() // the directory changed: the popover draws again
      } while (again)
    } finally { syncing = false }
  }

  const syncSoon = (): void => {
    if (syncTimer || disposed) return
    syncTimer = setTimeout(() => { syncTimer = undefined; void sync() }, SYNC_DELAY_MS)
  }

  const onLine = (ev: LineEvent): void => {
    if (board.hear(ev.channelId, ev.line, moderator())) schedule(ev.channelId)
    if (!known.has(ev.channelId)) syncSoon()
  }

  /**
   * A poll opened: it is a new speech like any other. Any poll event (the opening, a vote, the close) may change whether a poll
   * waits for her vote, so the daemon is asked again (one small read of the channel's index and tail).
   */
  const onPoll = (ev: PollEvent): void => {
    if (ev.line.kind === 'poll' && board.hear(ev.channelId, ev.line, moderator())) schedule(ev.channelId)
    if (!known.has(ev.channelId)) syncSoon()
    else void refreshAsks(ev.channelId)
  }

  /** A ❓ or ❌ put or taken back by an agent: the daemon says whether it is on a speech of hers (every other reaction asks nothing). */
  const onReaction = (ev: ReactionEvent): void => {
    const r = ev.line.react
    if (ev.line.from.id === 'user' || !r || !ASK_EMOJIS.includes(reactionKey(r.emoji))) return
    void refreshAsks(ev.channelId)
  }

  const disposables: Disposable[] = [
    ui.daemon.onEvent<LineEvent>('line', onLine),
    ui.daemon.onEvent<ReactionEvent>('reaction', onReaction),
    ui.daemon.onEvent<PollEvent>('poll', onPoll),
    ui.daemon.onEvent('channel', syncSoon),
    { dispose: () => { disposed = true; if (syncTimer) clearTimeout(syncTimer); for (const h of seals.values()) h.resolve(); seals.clear(); listeners.clear() } },
  ]
  void sync()

  const totals = (): Totals => {
    let unread = 0
    let toMe = 0
    for (const c of deps.list()) {
      if (c.closed) continue
      const m = board.of(c.id)
      unread += m.unread
      toMe += m.toMe + board.asksOf(c.id).length + board.owedOf(c.id).length
    }
    return { unread, toMe }
  }

  ui.test.expose('marks', (channelId: string): ChannelMarks & { seal: boolean; asks: Ask[]; owed: PollOwed[] } => ({ ...board.of(channelId), asks: board.asksOf(channelId), owed: board.owedOf(channelId), seal: seals.has(channelId) }))

  return {
    disposables,
    of: channelId => board.of(channelId),
    asksOf: channelId => board.asksOf(channelId),
    owedOf: channelId => board.owedOf(channelId),
    totals,
    viewed: (channelId, seq) => {
      if (seq <= 0) return
      if (board.viewed(channelId, seq)) schedule(channelId)
      if (seq > (sent.get(channelId) ?? 0)) {
        sent.set(channelId, seq)
        // The daemon holds the number and writes it once after a delay; a refusal is not the person's concern.
        void ui.daemon.request('seen', { channel: channelId, seq }).catch(() => {})
      }
    },
    attended: (channelId, seq) => {
      const r = board.attended(channelId, seq)
      if (!r.changed) return
      schedule(channelId)
      if (r.persist && seq > (sent.get(channelId) ?? 0)) {
        sent.set(channelId, seq)
        void ui.daemon.request('seen', { channel: channelId, seq }).catch(() => {})
      }
    },
    paneChanged: channelId => schedule(channelId),
    onDidChange: listener => { listeners.add(listener); return { dispose: () => { listeners.delete(listener) } } },
  }
}
