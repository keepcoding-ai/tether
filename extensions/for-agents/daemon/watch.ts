// The screen watch (tether for agents, contract 4.2): for what the engine does not tell. Soul and Codex do not report a
// permission card that is on the screen, and Claude reports it late; the watch reads the screen of the panes an owner is
// commanding in a turn, asks the conductor's `detect` whether a card is there, and tells the core with `attention.signal`.
// From there the path is the notices' (notices.ts): the core routes the attention to the owner and the delivery by terminal
// respects the card on every engine.
//
// One timer for all of it (decision 9): armed only while at least one pane is commanded by an owner (the hand with the owner),
// in a turn (`busy`) and conducted by a conductor that declares `watch: true`; with none, no timer is alive. Each beat reads
// each of those panes once, with the reader's own `since` (only what came in), so the cost follows the panes in a turn and not
// the total. A card is signalled once: it is remembered by its text until a beat sees the pane without it.
//
// F12 rides on it: the card is also told to the reconciler (`setCard`), which takes the route away when "responder permissão"
// is off in the inventory; the signal waits for that, so the request reaches the person and not the owner.
import { slotIsLive } from '../../../app/shared/agent-info.ts'
import { toDisposable, type IDisposable } from '../../../app/shared/vscode-lifecycle.ts'
import type { TetherDaemon } from '../../../src/daemon/ext-api.ts'
import type { SlotState } from '../../../src/daemon/protocol.ts'
import { conductorRegistry, type ConductorTarget, type Detected } from '../conductor-api.ts'
import { OBJECT_KEYS } from '../rules.ts'
import { createScreenReaders, type ScreenReaders } from '../screen/index.ts'
import { buildContext } from './context.ts'
import type { WriteGate } from './guard.ts'
import type { OwnershipStore } from './ownership.ts'
import type { Reconciler } from './reconcile.ts'

export type WatchApi = Pick<TetherDaemon, 'slots' | 'desks' | 'attention' | 'objects' | 'agents' | 'io' | 'home' | 'log' | 'onSlot'>

export interface WatchWiring {
  store: OwnershipStore
  gate: WriteGate
  reconciler: Pick<Reconciler, 'setCard' | 'idle'>
}

/** The beat of the watch (contract 4.2). */
export const WATCH_INTERVAL_MS = 2000

export interface WatchTimers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

const realTimers: WatchTimers = {
  set: (fn, ms) => { const h = setInterval(fn, ms); h.unref?.(); return h },
  clear: (h) => clearInterval(h as ReturnType<typeof setInterval>),
}

/** A fresh target for a conductor: the pane's type in the desk map, the slot as it is now. */
export function targetFor(api: Pick<TetherDaemon, 'slots' | 'desks'>, paneId: string): ConductorTarget {
  const map = api.desks.map()
  const hit = map?.desks.flatMap((d) => d.panes).find((p) => p.id === paneId) ?? map?.drawer.find((p) => p.id === paneId)
  const slot = api.slots.get(paneId)
  return { paneId, type: hit?.type ?? (slot ? 'terminal' : 'unknown'), ...(slot ? { slot } : {}) }
}

/** What the conductor that knows says the screen shows; undefined when none can say (no `detect`, or it failed). */
export async function detectOn(api: WatchApi, wiring: Pick<WatchWiring, 'gate'>, readers: ScreenReaders, paneId: string, owner: string): Promise<Detected | undefined> {
  const target = targetFor(api, paneId)
  const conductor = conductorRegistry.pick(target, 'detect')
  if (!conductor) return undefined
  try {
    return await conductor.detect!(buildContext({ api, gate: wiring.gate, readers }, owner, target))
  } catch (e) {
    api.log(`vigia: detect de ${paneId} falhou: ${(e as Error).message}`)
    return undefined
  }
}

/** The panes whose ownership an object change can move: the pane, the panes of a desk, the panes of a frozen owner. */
export function panesAffected(api: Pick<TetherDaemon, 'desks'>, store: OwnershipStore, e: { kind: 'desk' | 'pane'; id: string; key: string }): string[] {
  if (e.key === OBJECT_KEYS.frozen && e.kind === 'pane') return [...store.panesOf(e.id)]
  if (e.key !== OBJECT_KEYS.owner && e.key !== OBJECT_KEYS.hand) return []
  if (e.kind === 'pane') return [e.id]
  return api.desks.map()?.desks.find((d) => d.id === e.id)?.panes.map((p) => p.id) ?? []
}

const isCard = (d: Detected | undefined): d is Extract<Detected, { card: unknown }> => d !== undefined && 'card' in d

export class ScreenWatch {
  private readonly api: WatchApi
  private readonly wiring: WatchWiring
  private readonly readers: ScreenReaders
  private readonly timers: WatchTimers
  private readonly intervalMs: number
  /** The panes in a turn under an owner's hand, with a conductor that watches. */
  private readonly watched = new Set<string>()
  /** pane -> the card (by its text) already signalled; absent = no card seen. */
  private readonly cards = new Map<string, string>()
  private timer: unknown
  private ticking: Promise<void> | undefined
  private disposed = false

  constructor(api: WatchApi, wiring: WatchWiring, opts: { timers?: WatchTimers; intervalMs?: number; readers?: ScreenReaders } = {}) {
    this.api = api
    this.wiring = wiring
    this.timers = opts.timers ?? realTimers
    this.intervalMs = opts.intervalMs ?? WATCH_INTERVAL_MS
    this.readers = opts.readers ?? createScreenReaders({ joinWrapped: false })
  }

  /** Whether a timer is alive now (tests prove it is not, with nothing to watch). */
  get armed(): boolean { return this.timer !== undefined }
  get size(): number { return this.watched.size }

  // ---- membership -------------------------------------------------------------------------------

  /** A slot's state changed (the turn began or ended, the process left): the pane joins or leaves. */
  stateChanged(s: SlotState): void { this.refresh(s.slotId, s) }

  /** The ownership of these panes may have changed. */
  ownershipChanged(paneIds: Iterable<string>): void {
    for (const id of paneIds) this.refresh(id, this.api.slots.get(id))
  }

  /** The slots already running when the watch starts. */
  seed(): void {
    for (const s of this.api.slots.list()) this.refresh(s.slotId, s)
  }

  private watchable(s: SlotState): boolean {
    if (s.turn !== 'busy' || !slotIsLive(s)) return false
    const eff = this.wiring.store.effectiveOf(s.slotId)
    if (eff.commander === undefined || eff.hand !== 'owner') return false
    return conductorRegistry.pick(targetFor(this.api, s.slotId), 'detect')?.watch === true
  }

  private refresh(paneId: string, s: SlotState | undefined): void {
    if (this.disposed) return
    if (s && this.watchable(s)) this.watched.add(paneId)
    else this.leave(paneId)
    this.sync()
  }

  private leave(paneId: string): void {
    if (!this.watched.delete(paneId) && !this.cards.has(paneId)) return
    this.forgetCard(paneId)
    this.readers.drop(paneId)
  }

  /** The timer exists exactly while something is watched. */
  private sync(): void {
    if (this.watched.size > 0 && this.timer === undefined) this.timer = this.timers.set(() => { void this.beat() }, this.intervalMs)
    else if (this.watched.size === 0 && this.timer !== undefined) { this.timers.clear(this.timer); this.timer = undefined }
  }

  // ---- the beat ---------------------------------------------------------------------------------

  /** One beat: every watched pane read once. A beat still running is not started again. */
  beat(): Promise<void> {
    if (this.ticking) return this.ticking
    const run = (async (): Promise<void> => {
      for (const id of [...this.watched]) {
        if (this.disposed) return
        await this.look(id)
      }
    })().finally(() => { this.ticking = undefined })
    this.ticking = run
    return run
  }

  private async look(paneId: string): Promise<void> {
    const s = this.api.slots.get(paneId)
    if (!s || !this.watchable(s)) { this.refresh(paneId, s); return }
    const owner = this.wiring.store.effectiveOf(paneId).commander!
    const seen = await detectOn(this.api, this.wiring, this.readers, paneId, owner)
    // The pane may have left while the screen was read.
    if (this.disposed || !this.watched.has(paneId)) return
    if (!isCard(seen)) {
      if (this.cards.has(paneId)) this.forgetCard(paneId)
      return
    }
    const fingerprint = `${seen.card.title}\n${seen.card.text}`
    if (this.cards.get(paneId) === fingerprint) return
    this.cards.set(paneId, fingerprint)
    this.wiring.reconciler.setCard(paneId, true)
    // The route (or its absence, F12) is applied before the core is told, so the request goes where it should.
    await this.wiring.reconciler.idle()
    if (this.disposed || this.cards.get(paneId) !== fingerprint) return
    try {
      this.api.attention.signal(paneId, 'waiting')
    } catch (e) {
      this.api.log(`vigia: sinalizar ${paneId} falhou: ${(e as Error).message}`)
    }
  }

  private forgetCard(paneId: string): void {
    this.cards.delete(paneId)
    this.wiring.reconciler.setCard(paneId, false)
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== undefined) { this.timers.clear(this.timer); this.timer = undefined }
    this.watched.clear()
    this.cards.clear()
    this.readers.dispose()
  }
}

/**
 * Wiring in daemon.ts, one line after `wire` builds the pieces:
 *   `disposables.push(...registerWatch(api, { store, gate, reconciler }))`
 */
export function registerWatch(api: WatchApi & Pick<TetherDaemon, 'onSlot'>, wiring: WatchWiring): IDisposable[] {
  const watch = new ScreenWatch(api, wiring)
  // What was running before the data loaded joins once it is there.
  Promise.all([api.objects.ready, api.desks.ready]).then(() => watch.seed()).catch(() => {})
  return [
    api.slots.onState((s) => watch.stateChanged(s)),
    api.objects.onDidChange((e) => watch.ownershipChanged(panesAffected(api, wiring.store, e))),
    api.onSlot((ev) => { if (ev.kind === 'removed') watch.ownershipChanged([ev.slot.slotId]) }),
    toDisposable(() => watch.dispose()),
  ]
}
