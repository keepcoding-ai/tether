// The marks of the channels (slice U3): what the person has not read, and what is said to her.
//   - A line from an agent is "unread" until the person sees the end of the conversation: it counts on the channel's tab (a quiet
//     ring, no colour) and in the top bar's popover. It never activates a pane, switches a desk, takes focus or throws a toast.
//   - A line whose `to` includes the moderator also lights the attention seal on the channel's pane (when it is open) and the
//     top bar icon's state (open or not). The seal is sticky: seeing the pane does not clear it, reaching the end does (P1).
//   - Nothing is ever marked on the pane of whoever spoke: only the channel's own pane gets a mark.
// `MarkBoard` is pure (no DOM, no daemon); `createMarks` wires it to the daemon's `line` events and to the app's seal and emblem.
// Memory: one small map per channel, at most MAX_HELD entries; reconciled once from the newest page of each open channel.
import type { AttentionHandle, Disposable, TetherUi } from '../../../app/renderer/ext-api.ts'
import type { LineEvent } from '../daemon/fanout.ts'
import type { ChannelSummary } from '../daemon/requests.ts'
import type { Line } from '../rules.ts'
import { channelPaneId } from '../manifest.ts'
import { DEFAULT_MODERATOR_NAME, unreadLabel, type HistoryPage } from './view-model.ts'

/** Unseen lines kept per channel (the count stops growing past it). */
export const MAX_HELD = 500
/** Channels read once at start to know what came while the app was closed. */
const RECONCILE_MAX = 30
const RECONCILE_PAGE = 50
const SYNC_DELAY_MS = 250

export type Heard = 'plain' | 'toMe'

const norm = (s: string): string => s.trim().toLowerCase()

/** What a line is to the person: undefined (not counted), a line for everyone, or one addressed to her. */
export function classify(line: Line, moderator: string): Heard | undefined {
  if (line.kind !== 'message') return undefined
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

interface Held { seen: number; lines: Map<number, Heard> }

export class MarkBoard {
  private readonly held = new Map<string, Held>()

  private entry(channelId: string): Held {
    let h = this.held.get(channelId)
    if (!h) { h = { seen: 0, lines: new Map() }; this.held.set(channelId, h) }
    return h
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

  forget(channelId: string): void { this.held.delete(channelId) }
}

// ---------- the effects ----------

export interface Totals { unread: number; toMe: number }

export interface Marks {
  disposables: Disposable[]
  of(channelId: string): ChannelMarks
  /** Open channels with something unseen, and the sums (what the popover and the icon say). */
  totals(): Totals
  /** The pane shows the end of the conversation to the person (active, visible, window in front): up to `seq` is seen. */
  viewed(channelId: string, seq: number): void
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
    const plain = m.unread - m.toMe
    try {
      // The quiet ring: lines for everyone that nobody has seen. Never a colour; the seal says the rest.
      if (open) ui.panes.setEmblems(paneId, plain > 0 ? [{ icon: 'circle', tooltip: unreadLabel(plain) }] : undefined)
    } catch (e) { console.error('channels emblem', e) }
    const handle = seals.get(channelId)
    if (open && m.toMe > 0) {
      const message = `#${nameOf(channelId)}: ${m.toMe === 1 ? 'uma fala para você' : `${m.toMe} falas para você`}`
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

  const reconcile = async (c: ChannelSummary): Promise<void> => {
    try {
      const page = await ui.daemon.request<HistoryPage>('history', { channel: c.id, limit: RECONCILE_PAGE })
      known.add(c.id)
      sent.set(c.id, Math.max(sent.get(c.id) ?? 0, c.seenByUser))
      if (board.load(c.id, page.lines, c.seenByUser, moderator())) schedule(c.id)
    } catch { /* the next sync tries again */ }
  }

  const sync = async (): Promise<void> => {
    if (syncing) { again = true; return }
    syncing = true
    try {
      do {
        again = false
        let list: readonly ChannelSummary[] = []
        try { list = await deps.refresh() } catch { break }
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

  const disposables: Disposable[] = [
    ui.daemon.onEvent<LineEvent>('line', onLine),
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
      toMe += m.toMe
    }
    return { unread, toMe }
  }

  ui.test.expose('marks', (channelId: string): ChannelMarks & { seal: boolean } => ({ ...board.of(channelId), seal: seals.has(channelId) }))

  return {
    disposables,
    of: channelId => board.of(channelId),
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
    paneChanged: channelId => schedule(channelId),
    onDidChange: listener => { listeners.add(listener); return { dispose: () => { listeners.delete(listener) } } },
  }
}
