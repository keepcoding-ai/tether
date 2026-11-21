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

  constructor(objects: DoorObjects, desks: DoorDesks, now: () => string = () => new Date().toISOString()) {
    this.objects = objects
    this.desks = desks
    this.now = now
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
    await this.objects.set('desk', deskId, OBJECT_KEYS.owner, value)
    return value
  }

  /** The person takes a desk back from its owner (also how a forgotten owner's struck mark is cleared: "Ficar com a mesa"). */
  async revokeDesk(deskId: string, by: Who = 'user'): Promise<void> {
    if (by !== 'user') throw new OwnershipRefusal('not-owner', 'só a pessoa revoga uma mesa')
    if (!asOwnership(this.objects.get('desk', deskId, OBJECT_KEYS.owner))) throw new OwnershipRefusal('not-given', `a mesa ${deskId} não tem dono`)
    await this.objects.set('desk', deskId, OBJECT_KEYS.owner, undefined)
  }

  /**
   * Gives a pane to `to` (an agent's slotId; the pane's own id makes it the agent's own pane, "de si"). The person always
   * may; an agent only as the live owner of the desk the pane is in. Giving again changes the owner. The hand is left as
   * it is: a pane the person took stays with the person until she gives it back.
   */
  async givePane(paneId: string, to: OwnerId, by: Who = 'user'): Promise<Ownership> {
    if (!mayGiveOrRevoke(by, this.deskOfPane(paneId))) throw new OwnershipRefusal('not-owner', `só a pessoa ou o dono da mesa dá a guia ${paneId}`)
    const value: Ownership = { owner: to, since: this.now(), givenBy: by }
    await this.objects.set('pane', paneId, OBJECT_KEYS.owner, value)
    return value
  }

  /** Takes a pane's own owner away (it falls back to the desk's owner, or to the person). Same permission as giving. */
  async revokePane(paneId: string, by: Who = 'user'): Promise<void> {
    if (!mayGiveOrRevoke(by, this.deskOfPane(paneId))) throw new OwnershipRefusal('not-owner', `só a pessoa ou o dono da mesa revoga a guia ${paneId}`)
    if (!asOwnership(this.objects.get('pane', paneId, OBJECT_KEYS.owner))) throw new OwnershipRefusal('not-given', `a guia ${paneId} não foi dada a ninguém`)
    await this.objects.set('pane', paneId, OBJECT_KEYS.owner, undefined)
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
        await this.objects.set(kind, id, OBJECT_KEYS.owner, { ...o, ended: { at, name } } satisfies Ownership)
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

  private handKey(target: HandTarget): ['pane' | 'desk', string, string] {
    return 'pane' in target ? ['pane', target.pane, OBJECT_KEYS.hand] : ['desk', target.desk, OBJECT_KEYS.hand]
  }
}
