// The marks of the channels (slice U3): what the person has not read, and what is said to her.
//   - A line from an agent is "unread" until the person sees the end of the conversation: it counts on the channel's tab (a quiet
//     ring, no colour; drawn by the tab itself) and in the top bar's popover. It never activates a pane, switches a desk, takes focus or throws a toast.
//   - A line whose `to` includes the moderator also lights the attention seal on the channel's pane (when it is open) and the
//     top bar icon's state (open or not). The seal is sticky: seeing the pane does not clear it, reaching the end does (P1).
//   - Nothing is ever marked on the pane of whoever spoke: only the channel's own pane gets a mark.
// `MarkBoard` is pure and lives in ../mark-board.ts (tetherd holds the same rule for remote devices, daemon/marks.ts);
// `createMarks` wires it to the daemon's `line` events and to the app's seal and emblem.
// Memory: one small map per channel, at most MAX_HELD entries; reconciled once from the newest page of each open channel.
import type { AttentionHandle, Disposable, TetherUi } from '../../../app/renderer/ext-api.ts'
import type { LineEvent, PollEvent, ReactionEvent } from '../daemon/fanout.ts'
import type { ChannelSummary } from '../daemon/requests.ts'
import { ASK_EMOJIS, reactionKey, type Ask } from '../rules.ts'
import { channelPaneId } from '../manifest.ts'
import { MarkBoard, type ChannelMarks, type FirstCall, type PollOwed } from '../mark-board.ts'
import { DEFAULT_MODERATOR_NAME, type HistoryPage } from './view-model.ts'

export { MAX_HELD, MarkBoard, SAID_MAX, classify, firstLineOf } from '../mark-board.ts'
export type { ChannelMarks, FirstCall, Heard, Said } from '../mark-board.ts'

/** Channels read once at start to know what came while the app was closed. */
const RECONCILE_MAX = 30
const RECONCILE_PAGE = 50
const SYNC_DELAY_MS = 250
const START_RETRIES = 10
const START_RETRY_MS = 500

// ---------- the effects ----------

export interface Totals { unread: number; toMe: number }

export interface Marks {
  disposables: Disposable[]
  of(channelId: string): ChannelMarks
  /** The ❓/❌ reactions of agents on her speeches that she has not seen: they light the same seal as a line for her. */
  asksOf(channelId: string): Ask[]
  /** The open polls that call her and wait for her vote: they light the same seal (orange) and go when she votes or the poll closes. */
  owedOf(channelId: string): PollOwed[]
  /** The oldest call she has not answered, in one line (MarkBoard.firstCall). */
  firstCall(channelId: string): FirstCall | undefined
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
    firstCall: channelId => board.firstCall(channelId),
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
