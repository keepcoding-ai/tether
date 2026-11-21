// The one link between ownership and the door: for each pane of a slot, `apply` reads its effective ownership and leaves
// `slots.setHeld` and `attention.route` exactly as `portOf()` says. Nothing else in the extension calls those two.
//
// It is idempotent: `apply` compares what the door shows now (the slot's `held`, `routeOf`) with what it should show and
// acts only on a difference, so applying twice emits nothing the second time, and the order the events come in (an
// object write, a desk map, a forgotten owner, a key of the person, a restart) does not matter: the last apply of a pane
// reads the state as it is when it runs. Panes are applied one at a time, from a set of dirty ids, so two events about
// the same pane never interleave their door calls.
//
// When it runs, with no sweep per event: a change of a pane object (that pane), of a desk object (the panes of that desk),
// of a 'frozen' mark (the panes of that owner), a new desk map (the panes whose desk changed), a forgotten owner (what
// carried its name), the card of a pane coming or going (that pane, F12), and the start (what has an owner or a hold).
// Its memory: the previous desk map (pane -> desk) and the panes with a card on the screen. No timer.
import type { DeskMap, DoorAttention, DoorDesks, DoorSlots } from '../../../src/daemon/ext-api.ts'
import { EXT_ID } from '../manifest.ts'
import { OBJECT_KEYS, capabilityOn, portOf, type Effective, type OwnerId } from '../rules.ts'
import type { OwnershipStore } from './ownership.ts'

export interface ReconcilerDeps {
  slots: DoorSlots
  attention: DoorAttention
  desks: DoorDesks
  store: OwnershipStore
  log: (msg: string) => void
}

/** What the door should show for one pane of a slot. */
export interface PortTarget { heldBy?: OwnerId; routeTo?: OwnerId }

/** A change of this extension's objects, as `objects.onDidChange` gives it. */
export interface ObjectChange { kind: 'desk' | 'pane'; id: string; key: string; value: unknown }

/** The desk of a pane in the drawer (no layout desk id can be this). */
const NO_DESK = '\u0000'

/** The keys whose change can move a pane's port: who owns, the hand, the inventory (F12). 'last' moves nothing. */
const PORT_KEYS: ReadonlySet<string> = new Set([OBJECT_KEYS.owner, OBJECT_KEYS.hand, OBJECT_KEYS.inventory])

/** The capability F12 reads: with it off, a permission request on the screen goes to the person. */
export const ANSWER_CAPABILITY = 'answer'

export class Reconciler {
  private readonly slots: DoorSlots
  private readonly attention: DoorAttention
  private readonly desks: DoorDesks
  private readonly store: OwnershipStore
  private readonly log: (msg: string) => void
  /** pane -> desk id (NO_DESK for the drawer) of the last map seen; undefined before the first one. */
  private prevMap: Map<string, string> | undefined
  /** Panes with a permission card on the screen now (told by `setCard`; F12). */
  private readonly cards = new Set<string>()
  private readonly dirty = new Set<string>()
  private draining: Promise<void> | undefined
  private stopped = false
  /** Panes held by another extension: logged once, never touched. */
  private readonly foreignTold = new Set<string>()

  constructor(deps: ReconcilerDeps) {
    this.slots = deps.slots
    this.attention = deps.attention
    this.desks = deps.desks
    this.store = deps.store
    this.log = deps.log
  }

  // ---- what the door should show ----------------------------------------------------------------

  /**
   * The target of one pane, or undefined when it cannot be known yet: a pane with no owner of its own inherits from its
   * desk, and before any desk map the desk is unknown, so the hold kept in the meta stays as it is (a restart keeps it).
   */
  targetOf(paneId: string): PortTarget | undefined {
    if (!this.store.paneFacts(paneId).owner && this.desks.map() === undefined) return undefined
    return this.targetFrom(paneId, this.store.effectiveOf(paneId))
  }

  private targetFrom(paneId: string, eff: Effective): PortTarget {
    const want: PortTarget = { ...portOf(eff) }
    // F12: with "Responder pedido de permissão" off here, the request on the screen goes to the person while it is there.
    if (want.routeTo !== undefined && this.cards.has(paneId)) {
      const inv = this.store.inventoryOf(paneId)
      if (!capabilityOn(ANSWER_CAPABILITY, inv.desk, inv.pane)) delete want.routeTo
    }
    return want
  }

  // ---- the events -------------------------------------------------------------------------------

  objectChanged(e: ObjectChange): void {
    if (e.key === OBJECT_KEYS.frozen && e.kind === 'pane') {
      this.store.refreshFrozen()
      this.schedule(this.store.panesOf(e.id))
      return
    }
    if (!PORT_KEYS.has(e.key)) return
    if (e.kind === 'pane') this.schedule([e.id])
    else this.schedule(this.panesOfDesk(e.id))
  }

  /** A new desk map: the panes whose desk changed (moved, arrived, left every desk). The first map counts as all new. */
  deskMapChanged(map: DeskMap): void {
    const next = mapIndex(map)
    const prev = this.prevMap
    this.prevMap = next
    const changed: string[] = []
    for (const [pane, desk] of next) if (prev?.get(pane) !== desk) changed.push(pane)
    if (prev) for (const pane of prev.keys()) if (!next.has(pane)) changed.push(pane)
    this.schedule(changed)
  }

  /** A pane object was dropped (its slot forgotten, or a non-slot pane gone from the map): nothing of it stays here. */
  paneDropped(paneId: string): void {
    this.cards.delete(paneId)
    this.foreignTold.delete(paneId)
    this.store.refreshFrozen()
  }

  /**
   * F12's entry: a permission card came onto a pane's screen (`shown: true`) or left it. Who tells it is the watch (another
   * slice); the reconciler only keeps the set and applies that pane.
   */
  setCard(paneId: string, shown: boolean): void {
    if (shown === this.cards.has(paneId)) return
    if (shown) this.cards.add(paneId)
    else this.cards.delete(paneId)
    this.schedule([paneId])
  }

  /**
   * The start: the hold and the route are already in the metas; this pass only mends a divergence. It walks what has an
   * owner (panes, and the panes of owned desks) and what the door shows as ours (a hold of this extension, a route).
   */
  start(): void {
    this.store.refreshFrozen()
    const map = this.desks.map()
    if (map) this.prevMap = mapIndex(map)
    const ids = new Set<string>()
    for (const [id] of this.store.ownedPanes()) ids.add(id)
    for (const [deskId] of this.store.ownedDesks()) for (const id of this.panesOfDesk(deskId)) ids.add(id)
    for (const id of this.ours()) ids.add(id)
    this.schedule(ids)
  }

  /** The extension is turned off: every hold of this extension and every route goes; the data stays in the file. */
  undo(): Promise<void> {
    this.stopped = true
    this.dirty.clear()
    const ids = this.ours()
    const run = async (): Promise<void> => {
      for (const id of ids) {
        await this.call(id, 'setHeld', () => this.slots.get(id)?.held?.ext === EXT_ID ? this.slots.setHeld(id, undefined) : undefined)
        await this.call(id, 'unroute', () => this.attention.routeOf(id) !== undefined ? this.attention.unroute(id) : undefined)
      }
    }
    const done: Promise<void> = (this.draining ?? Promise.resolve()).then(run).finally(() => { if (this.draining === done) this.draining = undefined })
    this.draining = done
    return done
  }

  // ---- applying ---------------------------------------------------------------------------------

  schedule(ids: Iterable<string>): void {
    if (this.stopped) return
    for (const id of ids) this.dirty.add(id)
    if (this.dirty.size > 0 && !this.draining) this.draining = this.drain()
  }

  /** Resolves when nothing is left to apply (tests, and the callers that want the door settled). */
  async idle(): Promise<void> {
    while (this.draining) await this.draining
  }

  /** Applies every pane that has an owner or a hold now, again: the second call of two in a row changes nothing. */
  reconcileAll(): Promise<void> {
    this.start()
    return this.idle()
  }

  private async drain(): Promise<void> {
    try {
      while (this.dirty.size > 0 && !this.stopped) {
        const id = this.dirty.values().next().value as string
        this.dirty.delete(id)
        await this.apply(id)
      }
    } finally {
      this.draining = undefined
    }
  }

  /** One pane: only a slot has a hold and a route (a note or a browser pane keeps just its data). */
  private async apply(paneId: string): Promise<void> {
    const slot = this.slots.get(paneId)
    if (!slot) return
    if (slot.held && slot.held.ext !== EXT_ID) {
      if (!this.foreignTold.has(paneId)) { this.foreignTold.add(paneId); this.log(`a guia ${paneId} está segura por ${slot.held.ext}: não mexo`) }
      return
    }
    const want = this.targetOf(paneId)
    if (!want) return
    // The hold first, in both directions: taking it away is what stops the tether typing; a route without a hold never stays.
    if ((slot.held?.by) !== want.heldBy) {
      await this.call(paneId, 'setHeld', () => this.slots.setHeld(paneId, want.heldBy !== undefined ? { ext: EXT_ID, by: want.heldBy } : undefined))
    }
    if (this.attention.routeOf(paneId) !== want.routeTo) {
      await this.call(paneId, 'route', () => want.routeTo !== undefined ? this.attention.route(paneId, want.routeTo) : this.attention.unroute(paneId))
    }
  }

  private async call(paneId: string, what: string, run: () => Promise<void> | undefined): Promise<void> {
    try { await run() } catch (e) { this.log(`reconciliar ${paneId} (${what}) falhou: ${e instanceof Error ? e.message : String(e)}`) }
  }

  // ---- reads ------------------------------------------------------------------------------------

  private panesOfDesk(deskId: string): string[] {
    return this.desks.map()?.desks.find((d) => d.id === deskId)?.panes.map((p) => p.id) ?? []
  }

  /** The slots the door shows as this extension's: a hold of ours, or a route (only this extension routes). */
  private ours(): string[] {
    return this.slots.list().filter((s) => s.held?.ext === EXT_ID || this.attention.routeOf(s.slotId) !== undefined).map((s) => s.slotId)
  }
}

function mapIndex(map: DeskMap): Map<string, string> {
  const out = new Map<string, string>()
  for (const d of map.desks) for (const p of d.panes) out.set(p.id, d.id)
  for (const p of map.drawer) out.set(p.id, NO_DESK)
  return out
}
