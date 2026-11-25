// The ownership data of tether for agents in the daemon: reads the desk and pane objects of this extension's space
// (door `objects`) into the facts `effective()` takes, and writes the gestures (give, revoke, take, give back, pause in the
// three scopes, the forgotten owner's mark, the last act). It holds no rule of its own: who commands what is rules.ts; who
// may give or revoke is `mayGiveOrRevoke`; a desk that takes no owner is `deskAcceptsOwner`. Every write is one key of one
// object, so the reconciler (reconcile.ts) learns of it from `objects.onDidChange` like it learns of the app's writes.
import type { DoorDesks, DoorObjects } from '../../../src/daemon/ext-api.ts'
import {
  OBJECT_KEYS, deskAcceptsOwner, effective, mayGiveOrRevoke,
  type DeskFacts, type Effective, type Frozen, type Hand, type Inventory, type LastAct, type OwnerId, type Ownership, type PaneFacts,
} from '../rules.ts'

/** Who makes a gesture: the person (a menu of the app, a command) or an agent (its slotId, through a verb). */
export type Who = 'user' | OwnerId

/** Why a gesture was refused. The verbs map these to their own error table. */
export type OwnershipRefusalCode = 'not-owner' | 'not-given' | 'system-desk' | 'unknown-desk'

export class OwnershipRefusal extends Error {
  readonly code: OwnershipRefusalCode
  constructor(code: OwnershipRefusalCode, message: string) {
    super(message)
    this.code = code
  }
}

/** Where a hand is put: one pane, or a desk (it then counts for every pane the desk commands, rules.ts). */
export type HandTarget = { pane: string } | { desk: string }

/**
 * Whether the person's typing into a pane takes it: a pane an owner commands from outside (given, or inherited from the
 * desk) with the hand still with that owner. The agent's own pane ("de si") is where the person talks to that agent, so
 * typing there does not take it; the tether's own typing into it still waits for her through the gate and the delivery.
 */
export function takesByTyping(eff: Effective): boolean {
  return eff.commander !== undefined && eff.hand === 'owner' && eff.via !== 'self'
}

const isRecord =(v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** What the store holds under 'owner', when it has the shape; anything else reads as no owner (the app writes the same file). */
function asOwnership(v: unknown): Ownership | undefined {
  if (!isRecord(v) || typeof v.owner !== 'string' || !v.owner) return undefined
  return v as unknown as Ownership
}

function asHand(v: unknown): Hand | undefined {
  if (!isRecord(v) || v.with !== 'user' || (v.why !== 'taken' && v.why !== 'paused')) return undefined
  return v as unknown as Hand
}

function asInventory(v: unknown): Inventory | undefined {
  return isRecord(v) ? v as Inventory : undefined
}

export class OwnershipStore {
  private readonly objects: DoorObjects
  private readonly desks: DoorDesks
  private readonly now: () => string
  /** The owners paused everywhere ('frozen' on their own pane). Kept from the change events; `refreshFrozen` rebuilds it. */
  private readonly frozenSet = new Set<OwnerId>()

  private readonly log: (msg: string) => void
  /** The 'owner' keys (`kind:id`) this store is writing now: their change event is its own, already logged. */
  private readonly ownWrites = new Set<string>()

  constructor(objects: DoorObjects, desks: DoorDesks, now: () => string = () => new Date().toISOString(), log: (msg: string) => void = () => {}) {
    this.objects = objects
    this.desks = desks
    this.now = now
    this.log = log
  }

  // ---- the trace of ownership in the log -------------------------------------------------------
  // One line per give or revoke: the verb, the target (desk or pane), the relation (self or agent), who did it and by which way.
  // Only ids and fixed words, never a user's text.

  private traceOwner(verb: 'deu' | 'tirou', kind: 'desk' | 'pane', id: string, owner: OwnerId | undefined, by: string, via: string): void {
    const target = `${kind === 'desk' ? 'a mesa' : 'a guia'} ${id}`
    const rel = owner === undefined ? '' : ` (relação ${owner === id ? 'self' : 'agente'}, por ${by}, via ${via})`
    const who = owner === undefined ? ` (por ${by}, via ${via})` : rel
    this.log(`posse: ${verb} ${target}${verb === 'deu' ? ` a ${owner}` : owner === undefined ? '' : ` de ${owner}`}${who}`)
  }

  /** `by` of a gesture of this store: the person's gesture, or an agent's verb. */
  private route(by: Who): string { return by === 'user' ? 'gesto' : 'verbo' }

  private async writeOwner(kind: 'desk' | 'pane', id: string, value: Ownership | undefined): Promise<void> {
    const key = `${kind}:${id}`
    this.ownWrites.add(key)
    try { await this.objects.set(kind, id, OBJECT_KEYS.owner, value) } finally { this.ownWrites.delete(key) }
  }

  /** The door's change event: an 'owner' written by someone else (the app's gesture) leaves its line; this store's writes do not. */
  ownerChanged(e: { kind: 'desk' | 'pane'; id: string; key: string; value: unknown }): void {
    if (e.key !== OBJECT_KEYS.owner || this.ownWrites.has(`${e.kind}:${e.id}`)) return
    const o = asOwnership(e.value)
    if (o) this.traceOwner('deu', e.kind, e.id, o.owner, String(o.givenBy ?? 'user'), 'gesto do app')
    else this.traceOwner('tirou', e.kind, e.id, undefined, 'a pessoa', 'gesto do app')
  }

  /** The door's drop event: a pane (or desk) that vanished with an owner of its own loses it; says why. */
  ownerDropped(e: { kind: 'desk' | 'pane'; id: string; data: Record<string, unknown> }): void {
    const o = asOwnership(e.data[OBJECT_KEYS.owner])
    if (!o) return
    this.traceOwner('tirou', e.kind, e.id, o.owner, e.kind === 'pane' ? 'o slot esquecido' : 'a mesa fora do mapa', e.kind === 'pane' ? 'esquecimento do slot' : 'mapa de mesas')
  }

  // ---- reads ------------------------------------------------------------------------------------

  paneFacts(paneId: string): PaneFacts {
    return {
      id: paneId,
      owner: asOwnership(this.objects.get('pane', paneId, OBJECT_KEYS.owner)),
      hand: asHand(this.objects.get('pane', paneId, OBJECT_KEYS.hand)),
    }
  }

  deskFacts(deskId: string): DeskFacts {
    return {
      id: deskId,
      owner: asOwnership(this.objects.get('desk', deskId, OBJECT_KEYS.owner)),
      hand: asHand(this.objects.get('desk', deskId, OBJECT_KEYS.hand)),
    }
  }

  /** The facts of the desk the pane sits in now (desk map), undefined in the drawer or with no map. */
  deskOfPane(paneId: string): DeskFacts | undefined {
    const desk = this.desks.deskOf(paneId)
    return desk ? this.deskFacts(desk.id) : undefined
  }

  frozen(): ReadonlySet<OwnerId> { return this.frozenSet }

  /** Rebuilds the frozen owners from the store (start, and after a change of a 'frozen' key). */
  refreshFrozen(): void {
    this.frozenSet.clear()
    for (const [id, v] of this.objects.entries<Frozen>('pane', OBJECT_KEYS.frozen)) if (isRecord(v)) this.frozenSet.add(id)
  }

  /** The effective ownership of a pane now: the pane's data, the desk it sits in, the frozen owners. */
  effectiveOf(paneId: string): Effective {
    return effective(this.paneFacts(paneId), this.deskOfPane(paneId), this.frozenSet)
  }

  /** The two inventories a pane's capability is read from (rules.ts `capabilityOn`). */
  inventoryOf(paneId: string): { desk?: Inventory; pane?: Inventory } {
    const desk = this.desks.deskOf(paneId)
    const deskInv = desk ? asInventory(this.objects.get('desk', desk.id, OBJECT_KEYS.inventory)) : undefined
    const paneInv = asInventory(this.objects.get('pane', paneId, OBJECT_KEYS.inventory))
    return { ...(deskInv ? { desk: deskInv } : {}), ...(paneInv ? { pane: paneInv } : {}) }
  }

  /** Every pane (by id) with an 'owner' of its own, and every desk with one: what the start pass and a forgotten owner walk. */
  ownedPanes(): [string, Ownership][] { return this.owned('pane') }
  ownedDesks(): [string, Ownership][] { return this.owned('desk') }

  private owned(kind: 'pane' | 'desk'): [string, Ownership][] {
    const out: [string, Ownership][] = []
    for (const [id, v] of this.objects.entries<unknown>(kind, OBJECT_KEYS.owner)) {
      const o = asOwnership(v)
      if (o) out.push([id, o])
    }
    return out
  }

  /**
   * The panes `owner` may command, whatever the hand: the panes given to it (its own pane included, when it is "de si"),
   * and the panes of the desks it owns. A superset is fine: the reconciler applies each one through `effective()`.
   */
  panesOf(owner: OwnerId): Set<string> {
    const out = new Set<string>([owner])
    for (const [id, o] of this.ownedPanes()) if (o.owner === owner) out.add(id)
    const map = this.desks.map()
    for (const [deskId, o] of this.ownedDesks()) {
      if (o.owner !== owner) continue
      for (const p of map?.desks.find((d) => d.id === deskId)?.panes ?? []) out.add(p.id)
    }
    return out
  }

  // ---- gestures ---------------------------------------------------------------------------------

  /**
   * The person gives a desk (or passes it: a desk that has an owner changes owner and keeps its inventory and its hand).
   * Only the person gives a desk; a system desk takes no owner; with no desk map the desk cannot be checked.
   */
  async giveDesk(deskId: string, owner: OwnerId, by: Who = 'user'): Promise<Ownership> {
    if (by !== 'user') throw new OwnershipRefusal('not-owner', 'só a pessoa dá uma mesa')
    const desk = this.desks.map()?.desks.find((d) => d.id === deskId)
    if (!desk) throw new OwnershipRefusal('unknown-desk', `a mesa ${deskId} não existe`)
    if (!deskAcceptsOwner(desk.kind)) throw new OwnershipRefusal('system-desk', `a mesa ${desk.name} é de sistema: não recebe dono`)
    const value: Ownership = { owner, since: this.now(), givenBy: 'user' }
    await this.writeOwner('desk', deskId, value)
    this.traceOwner('deu', 'desk', deskId, owner, by, this.route(by))
    return value
  }

  /** The person takes a desk back from its owner (also how a forgotten owner's struck mark is cleared: "Ficar com a mesa"). */
  async revokeDesk(deskId: string, by: Who = 'user'): Promise<void> {
    if (by !== 'user') throw new OwnershipRefusal('not-owner', 'só a pessoa revoga uma mesa')
    const was = asOwnership(this.objects.get('desk', deskId, OBJECT_KEYS.owner))
    if (!was) throw new OwnershipRefusal('not-given', `a mesa ${deskId} não tem dono`)
    await this.writeOwner('desk', deskId, undefined)
    this.traceOwner('tirou', 'desk', deskId, was.owner, by, this.route(by))
  }

  /**
   * Gives a pane to `to` (an agent's slotId; the pane's own id makes it the agent's own pane, "de si"). The person always
   * may; an agent only as the live owner of the desk the pane is in. Giving again changes the owner. The hand is left as
   * it is: a pane the person took stays with the person until she gives it back.
   */
  async givePane(paneId: string, to: OwnerId, by: Who = 'user'): Promise<Ownership> {
    if (!mayGiveOrRevoke(by, this.deskOfPane(paneId))) throw new OwnershipRefusal('not-owner', `só a pessoa ou o dono da mesa dá a guia ${paneId}`)
    const value: Ownership = { owner: to, since: this.now(), givenBy: by }
    await this.writeOwner('pane', paneId, value)
    this.traceOwner('deu', 'pane', paneId, to, by, this.route(by))
    return value
  }

  /** Takes a pane's own owner away (it falls back to the desk's owner, or to the person). Same permission as giving. */
  async revokePane(paneId: string, by: Who = 'user'): Promise<void> {
    if (!mayGiveOrRevoke(by, this.deskOfPane(paneId))) throw new OwnershipRefusal('not-owner', `só a pessoa ou o dono da mesa revoga a guia ${paneId}`)
    const was = asOwnership(this.objects.get('pane', paneId, OBJECT_KEYS.owner))
    if (!was) throw new OwnershipRefusal('not-given', `a guia ${paneId} não foi dada a ninguém`)
    await this.writeOwner('pane', paneId, undefined)
    this.traceOwner('tirou', 'pane', paneId, was.owner, by, this.route(by))
  }

  /** The person takes (`why: 'taken'`) or pauses (`why: 'paused'`) a pane or a desk. Typing into a commanded pane is `by: 'typing'`. */
  async take(target: HandTarget, why: Hand['why'], by: Hand['by'] = 'gesture'): Promise<Hand> {
    const value: Hand = { with: 'user', why, by, since: this.now() }
    await this.objects.set(...this.handKey(target), value)
    return value
  }

  /** Gives the hand back (taken or paused): the owner commands there again. Always a gesture of the person. */
  async giveBack(target: HandTarget): Promise<void> {
    await this.objects.set(...this.handKey(target), undefined)
  }

  /** "Pausar <dono> em tudo": the mark on the owner's own pane; every pane it commands goes to the person, paused. */
  async freeze(owner: OwnerId): Promise<Frozen> {
    const value: Frozen = { since: this.now() }
    await this.objects.set('pane', owner, OBJECT_KEYS.frozen, value)
    return value
  }

  async unfreeze(owner: OwnerId): Promise<void> {
    await this.objects.set('pane', owner, OBJECT_KEYS.frozen, undefined)
  }

  /** The owner was forgotten: every live 'owner' that names it, on desks and panes, gets the struck mark. */
  async markEnded(owner: OwnerId, name: string): Promise<string[]> {
    const at = this.now()
    const touched: string[] = []
    for (const kind of ['desk', 'pane'] as const) {
      for (const [id, o] of this.owned(kind)) {
        if (o.owner !== owner || o.ended) continue
        await this.writeOwner(kind, id, { ...o, ended: { at, name } } satisfies Ownership)
        this.log(`posse: dono ${owner} esquecido; marca de fim em ${kind === 'desk' ? 'a mesa' : 'a guia'} ${id} (via esquecimento do slot)`)
        touched.push(`${kind}:${id}`)
      }
    }
    return touched
  }

  /** The last thing an owner did on a pane (the line "Atrium pela mesa · enviou pedido 14:02"). */
  async recordLast(paneId: string, by: OwnerId, verb: string): Promise<LastAct> {
    const value: LastAct = { by, verb, at: this.now() }
    await this.objects.set('pane', paneId, OBJECT_KEYS.last, value)
    return value
  }

  // ---- the outcome of the owner's sends ---------------------------------------------------------
  // In memory on purpose: it only decides whether the core's silence heuristic (a typed Enter marks the turn busy, a redrawn
  // box then reads as `done`) may be told as "terminou". It is about the moment, not a fact worth keeping across a restart.

  private readonly sends = new Map<string, { inFlight: number; failedAt: number | undefined; waiters: (() => void)[] }>()

  /** A send to the pane starts; call the returned function once with whether it failed (text left in the box, unconfirmed). */
  beginSend(paneId: string): (failed: boolean) => void {
    let e = this.sends.get(paneId)
    if (!e) this.sends.set(paneId, e = { inFlight: 0, failedAt: undefined, waiters: [] })
    const entry = e
    entry.inFlight++
    let ended = false
    return (failed) => {
      if (ended) return
      ended = true
      entry.inFlight--
      entry.failedAt = failed ? Date.now() : undefined
      if (entry.inFlight === 0) for (const w of entry.waiters.splice(0)) w()
    }
  }

  /** Resolves when no send to the pane is in flight (at most `capMs`: a stuck send never holds a notice for good). */
  sendSettled(paneId: string, capMs = 20_000): Promise<void> {
    const e = this.sends.get(paneId)
    if (!e || e.inFlight === 0) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const t = setTimeout(resolve, capMs)
      t.unref?.()
      e.waiters.push(() => { clearTimeout(t); resolve() })
    })
  }

  /**
   * True when the owner's last finished send to the pane failed, no send succeeded after it, and it ended within `windowMs`
   * (the heuristic's false `done` comes seconds after the Enter). Taking it clears it: it explains one `done`, not the next turns.
   */
  takeSendFailure(paneId: string, windowMs = 10_000): boolean {
    const e = this.sends.get(paneId)
    if (!e || e.failedAt === undefined) return false
    const recent = Date.now() - e.failedAt <= windowMs
    e.failedAt = undefined
    return recent
  }

  private handKey(target: HandTarget): ['pane' | 'desk', string, string] {
    return 'pane' in target ? ['pane', target.pane, OBJECT_KEYS.hand] : ['desk', target.desk, OBJECT_KEYS.hand]
  }
}
