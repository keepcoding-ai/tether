// The pure rules of ownership (tether for agents): who commands a pane, who only sees it, and who has the hand. Read by
// both hosts: the daemon decides from it (the reconciler turns `effective()` into `slots.setHeld` and `attention.route`),
// the renderer draws from it. This is the only place "the pane beats the desk" is written. No imports at all: a module
// both the daemon (Node) and the renderer (the bundle) load without pulling anything of one into the other.
//
// The data lives in the door's per-object store (`objects`, this extension's space): a pane object is keyed by its slotId
// (terminal pane) or its pane id (note, browser); a desk object by the layout's desk id. The keys are OBJECT_KEYS.

/** Who owns: the slotId of the PANE the agent runs in, never its session (compact, /clear, restarts change nothing). */
export type OwnerId = string

/** What a capability of the inventory is called. The conductors declare theirs; the desk ones are this extension's. */
export type CapabilityId = string

/** The keys this extension keeps on a desk or pane object. */
export const OBJECT_KEYS = {
  owner: 'owner',
  hand: 'hand',
  inventory: 'inventory',
  last: 'last',
  frozen: 'frozen',
} as const

/** Key 'owner' on a desk or pane object. Absent: no declared owner. */
export interface Ownership {
  owner: OwnerId
  since: string
  /** Who gave it: the person, or the desk's owner (its slotId). */
  givenBy: 'user' | OwnerId
  /** The owner was forgotten (its pane closed for good): it commands nothing; the struck mark stays until the person chooses. */
  ended?: { at: string; name: string }
}

/** Key 'hand' on a desk or pane object. Absent: the hand is with the owner. */
export interface Hand {
  with: 'user'
  /** 'taken': the person took it to act. 'paused': the person stopped the owner there. Same state of the door, another why. */
  why: 'taken' | 'paused'
  /** 'typing': taken by typing in the pane. 'gesture': from a menu. */
  by: 'typing' | 'gesture'
  since: string
}

/** Key 'inventory'. On a desk: only what is OFF (absent = everything on). On a pane: only what DIFFERS from the desk. */
export type Inventory = Record<CapabilityId, boolean>

/** Key 'last' on a pane: the last thing an owner did there. */
export interface LastAct { by: OwnerId; verb: string; at: string }

/** Key 'frozen' on the OWNER's own pane: the person paused that owner everywhere. */
export interface Frozen { since: string }

/** What `effective()` reads of a pane: its id (slotId or pane id) and its two ownership keys. */
export interface PaneFacts {
  id: string
  owner?: Ownership | undefined
  hand?: Hand | undefined
}

/** What `effective()` reads of the desk the pane is in now (undefined: the drawer, or a pane in no desk). */
export interface DeskFacts {
  id: string
  owner?: Ownership | undefined
  hand?: Hand | undefined
}

export interface Effective {
  /** Who commands now; undefined = the person. */
  commander?: OwnerId
  /** Through what: the pane was given ('pane'), inherits from its desk ('desk'), or is the agent's own pane ('self'). */
  via?: 'pane' | 'desk' | 'self'
  /** The desk's live owner when it does NOT command this pane: it only sees. */
  viewer?: OwnerId
  /** Who has the hand. 'owner' only when there is a commander and nobody took or paused it. */
  hand: 'owner' | 'user'
  /** Why the hand is with the person, when a commander exists and the person took or paused it. */
  handWhy?: 'taken' | 'paused'
  /**
   * A forgotten owner whose mark still stands on this pane (its own `owner` or, for a pane that would inherit, its desk's):
   * nobody commands through it, and the person decides what to do with it.
   */
  ended?: { owner: OwnerId; name: string; at: string; on: 'pane' | 'desk' }
}

const live = (o: Ownership | undefined): o is Ownership => !!o && !o.ended

/**
 * The effective ownership of one pane, the agreement written as an algorithm:
 * 1. The pane has a live `owner`: that owner commands, `via: 'self'` when it is the pane the agent runs in, else 'pane'.
 * 2. Else the pane has no owner at all, the desk has a live `owner`, and the pane is not that owner's own pane: the desk's
 *    owner commands, `via: 'desk'`. A pane whose own owner was forgotten does NOT fall to the desk: what loses its live
 *    owner goes back to the person, never to another agent.
 * 3. Else nobody: the pane is the person's.
 * The viewer: the desk's live owner whenever it is not the commander (a pane given to another, its own pane, a pane
 * left by a forgotten owner).
 * The hand: the pane's `hand`; else, `via: 'desk'`, the desk's `hand` (taking the desk takes only what the desk commands);
 * else, the commander frozen everywhere, paused; else the owner.
 */
export function effective(pane: PaneFacts, desk: DeskFacts | undefined, frozen: ReadonlySet<OwnerId>): Effective {
  const deskOwner = live(desk?.owner) ? desk.owner.owner : undefined
  let commander: OwnerId | undefined
  let via: Effective['via']
  let ended: Effective['ended']
  const paneOwner = pane.owner
  if (paneOwner) {
    if (paneOwner.ended) {
      ended = { owner: paneOwner.owner, name: paneOwner.ended.name, at: paneOwner.ended.at, on: 'pane' }
    } else {
      commander = paneOwner.owner
      via = paneOwner.owner === pane.id ? 'self' : 'pane'
    }
  } else if (deskOwner !== undefined) {
    if (deskOwner !== pane.id) { commander = deskOwner; via = 'desk' }
  } else if (desk?.owner?.ended && desk.owner.owner !== pane.id) {
    ended = { owner: desk.owner.owner, name: desk.owner.ended.name, at: desk.owner.ended.at, on: 'desk' }
  }

  const out: Effective = { hand: 'user' }
  if (commander !== undefined) {
    out.commander = commander
    out.via = via!
    const hand = pane.hand ?? (via === 'desk' ? desk?.hand : undefined)
    if (hand) { out.hand = 'user'; out.handWhy = hand.why }
    else if (frozen.has(commander)) { out.hand = 'user'; out.handWhy = 'paused' }
    else out.hand = 'owner'
  }
  if (deskOwner !== undefined && deskOwner !== commander) out.viewer = deskOwner
  if (ended) out.ended = ended
  return out
}

/**
 * What the door must say about a pane of a slot, from its effective ownership: `held` while the commander has the hand
 * (its own pane included: that is what lets the tether type into an agent's own pane); the attention routed to the
 * commander only for a pane it commands from outside (the request of an agent's own pane goes to the person: above it
 * there is only the person). The reconciler applies exactly this; nothing else calls `setHeld` or `route`.
 */
export function portOf(eff: Effective): { heldBy?: OwnerId; routeTo?: OwnerId } {
  if (eff.commander === undefined || eff.hand !== 'owner') return {}
  return eff.via === 'self' ? { heldBy: eff.commander } : { heldBy: eff.commander, routeTo: eff.commander }
}

/** What an agent may do on a pane: 'command' (every verb), 'view' (list, read-screen, last-answer), or nothing. */
export function relationOf(eff: Effective, agent: OwnerId): 'command' | 'view' | undefined {
  if (eff.commander === agent) return 'command'
  if (eff.viewer === agent) return 'view'
  return undefined
}

/** The capabilities only a desk has (this extension's own lines in the inventory). */
export const DESK_CAPABILITIES: readonly { id: CapabilityId; label: string }[] = [
  { id: 'open-close', label: 'Abrir e fechar guias nesta mesa' },
  { id: 'give-revoke', label: 'Dar e revogar guias desta mesa' },
]

/** Whether a capability is on for a pane in a desk: the pane's own value, else the desk's, else on (everything is born on). */
export function capabilityOn(cap: CapabilityId, desk: Inventory | undefined, pane?: Inventory): boolean {
  if (DESK_CAPABILITIES.some(c => c.id === cap)) return desk?.[cap] ?? true
  return pane?.[cap] ?? desk?.[cap] ?? true
}

/** The three states of a pane's line on the pad: as its desk, on here, off here. */
export function paneCapabilityState(cap: CapabilityId, pane: Inventory | undefined): 'desk' | 'on' | 'off' {
  const v = pane?.[cap]
  return v === undefined ? 'desk' : v ? 'on' : 'off'
}

/** A desk can be given to an agent unless it is a system desk. */
export function deskAcceptsOwner(kind: 'queue' | 'system'): boolean {
  return kind === 'queue'
}

/**
 * Who may give or revoke a pane: the person always; the live owner of the desk the pane is in, any pane of it (also one
 * the person gave to another agent: `givenBy` stays in sight). A pane's own owner does not pass it on, and nobody but the
 * person gives a desk.
 */
export function mayGiveOrRevoke(who: 'user' | OwnerId, desk: DeskFacts | undefined): boolean {
  if (who === 'user') return true
  return live(desk?.owner) && desk.owner.owner === who
}
