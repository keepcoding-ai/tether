// The pure rules of channels: rooms where agents of any engine and the person talk. Read by both hosts: the daemon decides
// from them (the verbs, the moderator's requests, the desk channel following its desk), the renderer draws from them. This is
// the only place the roles are written. No imports at all: a module both the daemon (Node) and the renderer (the bundle) load
// without pulling anything of one into the other, and nothing runs at load beyond declarations.
//
// Roles are derived, never stored. The moderator is the person, always, in every channel: never in `members`, never muted,
// never removed. The owner commands the channel (join, remove, mute, close, reopen) and speaks as a member. An agent owner
// whose pane is forgotten, who leaves or who is removed gives the channel up for good (`ownerEnded`): coming back, it is only
// a member, and the channel falls to the person, the moderator then being its only owner. A desk channel follows its desk.

/** Who is a member or an owner: the slotId of the PANE the agent runs in, never its session. */
export type AgentId = string

/** The channel's stable id: 'c_<base36>' for a created channel, 'desk_<deskId>' for the desk channel (one per desk, forever). */
export type ChannelId = string

/** Who acts: the person (as moderator or as a user owner) or an agent's pane. */
export type Who = 'user' | AgentId

/** The person's id wherever a `Who` is written. It never collides with a slotId (8 hex digits). */
export const USER = 'user'

/** The longest room name. */
export const ROOM_NAME_MAX = 40

/** The prefix of a desk channel's id. The NAME of a desk channel has no prefix: it is the slug of the desk's name. */
export const DESK_CHANNEL_PREFIX = 'desk_'

export type ChannelOwner = { kind: 'user' } | { kind: 'agent'; id: AgentId; name: string }

export interface Channel {
  id: ChannelId
  /** The room: what goes in `room` and what the verbs accept. isRoomName; unique among the open channels. Fixed at birth, but a desk channel reopening while an open channel took its name gets a suffix (slugOf). */
  name: string
  /** What the channel's pane shows. A desk channel's follows the desk's name. */
  title: string
  /** Who created it and commands it: the person, or an agent's pane. On a desk channel, the desk's owner. */
  owner: ChannelOwner
  /**
   * The agent owner gave the channel up for good: its pane was forgotten, it left, or it was removed (endsOwnership). The
   * channel goes on and only the moderator has the owner's power in it; the agent, joined again, is a member. Cleared only
   * when a desk channel gets a new owner from its desk.
   */
  ownerEnded?: { at: string; name: string; why: 'forgotten' | 'left' | 'removed' }
  /** Only on a desk channel: the desk's id in the layout. This, not the name, is what makes it the desk's. */
  desk?: string
  createdAt: string
  createdBy: Who
  /** Closed: nobody speaks; the history stays readable and the owner or the moderator may reopen it (a desk channel only follows its desk). */
  closed?: { at: string; by: Who }
  members: Record<AgentId, Member>
  /**
   * Agents the owner or the moderator removed: they do not join themselves again, and the desk does not bring them back. They
   * leave the list when the owner or the moderator joins them again, and, on a desk channel, when the pane leaves the desk.
   */
  removed?: AgentId[]
  /** The last `seq` the person saw (the channel's pane visible): what she has not read is counted from here. */
  seenByUser: number
}

export interface Member {
  since: string
  /** Who joined it: the person, the agent itself, the desk (desk channel), or an agent (the owner). */
  by: 'user' | 'self' | 'desk' | AgentId
  /** The pane's name when it joined (the label the history keeps if the pane is forgotten). */
  name: string
  /** Muted: still hears, no longer speaks. */
  muted?: { since: string; by: Who }
}

/** A role in a channel. The envelope carries 'member' for an owner who speaks (deliveryRoleOf). */
export type ChannelRole = 'owner' | 'member' | 'moderator'

export type LineEventType = 'create' | 'join' | 'leave' | 'remove' | 'mute' | 'unmute' | 'close' | 'reopen' | 'owner-ended' | 'owner-changed'

/** One line of a channel's record (<home>/channels/<channelId>/NNNNNN.jsonl, 500 lines per file). */
export interface Line {
  /** 1, 2, 3… per channel; the envelope's `ref` is `<name>#<seq>`. */
  seq: number
  at: string
  kind: 'message' | 'notice'
  /** Who spoke, with the role IN THE CHANNEL. */
  from: { id: AgentId | 'user' | 'tether'; name: string; role: ChannelRole | 'system' }
  body: string
  /** Whom the line addresses: names of members and/or the moderator's name. */
  to?: string[]
  replyTo?: number
  /** Only on a notice: the gesture, so the pane draws it without reading the text. */
  event?: { type: LineEventType; who?: AgentId; by?: Who }
}

/** The person is the moderator of every channel. */
export function isModerator(who: Who): boolean {
  return who === USER
}

export function isMember(ch: Channel, id: Who): boolean {
  return id !== USER && Object.hasOwn(ch.members, id)
}

export function isMuted(ch: Channel, id: AgentId): boolean {
  return isMember(ch, id) && ch.members[id]!.muted !== undefined
}

export function isDeskChannel(ch: Channel): boolean {
  return ch.desk !== undefined
}

export function deskChannelId(deskId: string): ChannelId {
  return DESK_CHANNEL_PREFIX + deskId
}

export function isRemoved(ch: Channel, id: AgentId): boolean {
  return (ch.removed ?? []).includes(id)
}

/**
 * Who commands the channel now. The agent owner until it gives the channel up (`ownerEnded`), and only while a member;
 * otherwise, and when the person created it, the person.
 */
export function ownerOf(ch: Channel): ChannelOwner {
  const o = ch.owner
  if (o.kind === 'agent' && !ch.ownerEnded && isMember(ch, o.id)) return o
  return { kind: 'user' }
}

/** The agent that owns the channel now, or undefined when the person does. */
export function agentOwnerOf(ch: Channel): AgentId | undefined {
  const o = ownerOf(ch)
  return o.kind === 'agent' ? o.id : undefined
}

/** Whether `id` leaving, being removed or being forgotten gives the channel up: it is the agent owner now. The caller then writes `ownerEnded`. */
export function endsOwnership(ch: Channel, id: AgentId): boolean {
  return agentOwnerOf(ch) === id
}

/** Who may join another agent, remove, mute, unmute and close: the owner and the moderator. Says nothing about open or closed. */
export function mayModerate(who: Who, ch: Channel): boolean {
  return isModerator(who) || agentOwnerOf(ch) === who
}

/** Every channel, open or closed, is readable by every agent, member or not, and by the person. */
export function mayRead(_who: Who, _ch: Channel): boolean {
  return true
}

/** Why `who` may not speak in the channel, or undefined when it may. The moderator speaks in every open channel; a muted member hears only. */
export function sayRefusal(who: Who, ch: Channel): 'closed' | 'not-member' | 'muted' | undefined {
  if (ch.closed) return 'closed'
  if (isModerator(who)) return undefined
  if (!isMember(ch, who)) return 'not-member'
  if (isMuted(ch, who)) return 'muted'
  return undefined
}

export function maySay(who: Who, ch: Channel): boolean {
  return sayRefusal(who, ch) === undefined
}

/**
 * Why `who` may not join `agent` (itself when absent) to the channel, or undefined when it may. An agent joins itself to any
 * open channel it was not removed from; joining another, a removed one included, takes the owner or the moderator.
 */
export function joinRefusal(who: Who, ch: Channel, agent?: AgentId): 'closed' | 'not-owner' | 'removed' | undefined {
  if (ch.closed) return 'closed'
  const self = agent === undefined || agent === who
  if (self && !isModerator(who)) return isRemoved(ch, who) ? 'removed' : undefined
  return mayModerate(who, ch) ? undefined : 'not-owner'
}

/** The desk brings this pane of its desk into the desk channel: not already a member and not removed from it. */
export function joinsByDesk(ch: Channel, id: AgentId): boolean {
  return isDeskChannel(ch) && !isMember(ch, id) && !isRemoved(ch, id)
}

/** Why `who` may not close the channel, or undefined when it may. A desk channel is never closed by hand ('desk'): it follows its desk. */
export function closeRefusal(who: Who, ch: Channel): 'desk' | 'closed' | 'not-owner' | undefined {
  if (isDeskChannel(ch)) return 'desk'
  if (ch.closed) return 'closed'
  return mayModerate(who, ch) ? undefined : 'not-owner'
}

/**
 * Why `who` may not reopen the channel, or undefined when it may. A common channel: the owner (as `ownerOf` reads it while
 * closed) or the moderator. A desk channel is never reopened by hand ('desk', the moderator included): it reopens with its
 * desk getting an owner again.
 */
export function reopenRefusal(who: Who, ch: Channel): 'desk' | 'not-closed' | 'not-owner' | undefined {
  if (isDeskChannel(ch)) return 'desk'
  if (!ch.closed) return 'not-closed'
  return mayModerate(who, ch) ? undefined : 'not-owner'
}

/** The role of `who` in the channel: the moderator (the person), the owner, a member, or none. */
export function roleIn(who: Who, ch: Channel): ChannelRole | undefined {
  if (isModerator(who)) return 'moderator'
  if (agentOwnerOf(ch) === who) return 'owner'
  return isMember(ch, who) ? 'member' : undefined
}

/** The role the envelope carries for a line's speaker: an owner speaks as a member; the moderator and the tether keep theirs. */
export function deliveryRoleOf(role: ChannelRole | 'system'): 'member' | 'moderator' | 'system' {
  return role === 'owner' ? 'member' : role
}

/** A room name: lowercase letters, digits and hyphens, 1 to 40, starting and ending with a letter or a digit. */
export function isRoomName(name: string): boolean {
  return name.length <= ROOM_NAME_MAX && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name)
}

/**
 * The room name for a free text (a desk's name, a title): accents dropped, lowercase, every run of other characters one
 * hyphen, at most 40. Empty after that: 'canal'. When `taken` has it, the first free of `-2`, `-3`… (the base cut to fit).
 */
export function slugOf(text: string, taken?: { has(name: string): boolean }): string {
  const trim = (s: string): string => s.replace(/^-+|-+$/g, '')
  const base = trim(trim(text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-')).slice(0, ROOM_NAME_MAX)) || 'canal'
  if (!taken?.has(base)) return base
  for (let n = 2; ; n++) {
    const suffix = `-${n}`
    const name = trim(base.slice(0, ROOM_NAME_MAX - suffix.length)) + suffix
    if (!taken.has(name)) return name
  }
}
