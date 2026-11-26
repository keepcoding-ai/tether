// The Regency's model: who waits for the person, the conversations and the tree of desks and panes. Pure: no DOM, no `ui`,
// nothing from the app or the daemon but types. Everything in and out is JSON (the app's screen reads it today; a remote
// interface reads it later), and every item carries an explicit target `{ kind, id }`, never "the active one".
import type { DeskTree } from '../../app/renderer/ext-api.ts'
import type { ChannelSummary } from '../channels/daemon/requests.ts'

export type TargetKind = 'desk' | 'pane' | 'channel' | 'agent'
export interface Target { kind: TargetKind; id: string }

/** The marks of one channel, as counts (same shape as the channels feed). */
export interface ChannelMarksInput { unread: number; toMe: number; asks: number; owed: number }

/** Who owns a desk or a pane: the agent's id (its pane id) and the name to show. */
export interface OwnerRef { id: string; name: string }

/** A pane that is an agent's. `id` is the pane id. */
export interface AgentRef {
  id: string
  kind: string
  name: string
  emblem?: { name: string; color: string; icon: string }
}

export interface RegencyInput {
  desks: DeskTree
  /** The owner boards, as plain data (by desk id and by pane id). */
  owners: { desk: Record<string, OwnerRef>; pane: Record<string, OwnerRef> }
  channels: ChannelSummary[]
  /** By channel id. A channel with no entry has no marks. */
  channelMarks: Record<string, ChannelMarksInput>
  agents: AgentRef[]
  /**
   * When each thing began to wait the person (epoch ms), by `"<kind>:<id>"` of its target (`pane:x`, `agent:x`, `channel:c`).
   * What has no time goes after what has, in the order it came.
   */
  since: Record<string, number>
  /** Desks (or, by agent, groups) folded in the tree, by id. */
  collapsed: string[]
  /** The Regency's own desk, left out of the tree and of "Esperam você". */
  selfDeskId?: string
}

export type WaitingReason = 'agent-waiting' | 'seal' | 'to-you' | 'reaction-asks' | 'poll-owed'

export interface WaitingItem {
  /** Unique in the list: `"<kind>:<id>:<reason>"`. */
  key: string
  target: Target
  reason: WaitingReason
  /** The pane's title or `#channel`. */
  label: string
  /** How many (lines, reactions, polls) for the channel reasons. */
  count?: number
  since?: number
  /** The desk of a pane. */
  desk?: Target
}

export interface ConvRow {
  target: Target
  name: string
  title: string
  closed: boolean
  /** The desk the channel belongs to, when it is a desk's. */
  desk?: Target
  owner: string
  members: number
  marks: ChannelMarksInput
}

export interface Identity { kind: string; name: string; emblem?: AgentRef['emblem'] }

export interface TreePaneRow {
  target: Target
  desk: Target
  type: string
  icon: string
  title: string
  attention?: 'done' | 'waiting'
  busy?: true
  asleep?: true
  exited?: true
  identity?: Identity
  /** The owner's name, only when it differs from the desk's owner. */
  ownerBadge?: string
}

export interface TreeDeskRow {
  target: Target
  name: string
  color: string
  kind: 'queue' | 'system' | 'drawer'
  icon?: string
  asleep: boolean
  collapsed: boolean
  paneCount: number
  /** Empty when collapsed. */
  panes: TreePaneRow[]
  owner?: string
}

/** A pane in the by-agent view: it also says the desk it sits in. */
export interface AgentPaneRow extends Omit<TreePaneRow, 'ownerBadge'> {
  deskName: string
  deskColor: string
}

export interface AgentGroupRow {
  /** `{ kind: 'agent', id }` for an agent; `{ kind: 'agent', id: YOU_ID }` for the person. */
  target: Target
  name: string
  you: boolean
  collapsed: boolean
  paneCount: number
  panes: AgentPaneRow[]
}

export interface RegencyModel {
  waiting: WaitingItem[]
  conversations: { open: ConvRow[]; closed: ConvRow[] }
  /** "Por mesa". */
  tree: TreeDeskRow[]
  /** "Por agente". */
  byAgent: AgentGroupRow[]
}

/** The id of the group of panes that have no agent. */
export const YOU_ID = 'you'
export const YOU_NAME = 'Você'

const key = (t: Target): string => `${t.kind}:${t.id}`
const NO_MARKS: ChannelMarksInput = { unread: 0, toMe: 0, asks: 0, owed: 0 }

function visibleDesks(input: RegencyInput): DeskTree['desks'] {
  return input.desks.desks.filter(d => d.id !== input.selfDeskId)
}

function agentOf(input: RegencyInput, paneId: string): AgentRef | undefined {
  return input.agents.find(a => a.id === paneId)
}

/** Those who wait the person, the one that waits longest first. Done is not here: it is a state in the tree. */
export function waitingOf(input: RegencyInput): WaitingItem[] {
  const items: WaitingItem[] = []
  for (const desk of visibleDesks(input)) {
    for (const pane of desk.panes) {
      if (pane.attention !== 'waiting') continue
      const isAgent = agentOf(input, pane.id) !== undefined
      const target: Target = { kind: isAgent ? 'agent' : 'pane', id: pane.id }
      const reason: WaitingReason = isAgent ? 'agent-waiting' : 'seal'
      items.push({
        key: `${key(target)}:${reason}`, target, reason, label: pane.title,
        ...(input.since[key(target)] !== undefined ? { since: input.since[key(target)] } : {}),
        desk: { kind: 'desk', id: desk.id },
      })
    }
  }
  for (const ch of input.channels) {
    if (ch.closed) continue
    const marks = input.channelMarks[ch.id] ?? NO_MARKS
    const target: Target = { kind: 'channel', id: ch.id }
    const since = input.since[key(target)]
    const add = (reason: WaitingReason, count: number): void => {
      if (count <= 0) return
      items.push({ key: `${key(target)}:${reason}`, target, reason, label: `#${ch.name}`, count, ...(since !== undefined ? { since } : {}) })
    }
    add('to-you', marks.toMe)
    add('reaction-asks', marks.asks)
    add('poll-owed', marks.owed)
  }
  // Array.prototype.sort is stable: equal and untimed items keep the order they came.
  return items
    .map((item, order) => ({ item, order }))
    .sort((a, b) => {
      const x = a.item.since, y = b.item.since
      if (x !== undefined && y !== undefined && x !== y) return x - y
      if (x !== undefined && y === undefined) return -1
      if (x === undefined && y !== undefined) return 1
      return a.order - b.order
    })
    .map(e => e.item)
}

/** The channels as rows: the open ones, then the closed ones. */
export function conversationsOf(input: RegencyInput): { open: ConvRow[]; closed: ConvRow[] } {
  const open: ConvRow[] = []
  const closed: ConvRow[] = []
  for (const ch of input.channels) {
    const row: ConvRow = {
      target: { kind: 'channel', id: ch.id }, name: ch.name, title: ch.title, closed: !!ch.closed,
      ...(ch.desk !== undefined ? { desk: { kind: 'desk' as const, id: ch.desk } } : {}),
      owner: ch.owner.kind === 'agent' ? ch.owner.name : YOU_NAME,
      members: ch.members, marks: { ...(input.channelMarks[ch.id] ?? NO_MARKS) },
    }
    ;(ch.closed ? closed : open).push(row)
  }
  return { open, closed }
}

function paneRow(input: RegencyInput, deskId: string, pane: DeskTree['desks'][number]['panes'][number]): Omit<TreePaneRow, 'ownerBadge'> {
  const agent = agentOf(input, pane.id)
  return {
    target: { kind: agent ? 'agent' : 'pane', id: pane.id },
    desk: { kind: 'desk', id: deskId },
    type: pane.type, icon: pane.icon, title: pane.title,
    ...(pane.attention ? { attention: pane.attention } : {}),
    ...(pane.busy ? { busy: true as const } : {}),
    ...(pane.asleep ? { asleep: true as const } : {}),
    ...(pane.exited ? { exited: true as const } : {}),
    ...(agent ? { identity: { kind: agent.kind, name: agent.name, ...(agent.emblem ? { emblem: agent.emblem } : {}) } } : {}),
  }
}

/** "Por mesa": every desk of the queue, then the system ones and the drawer, the Regency's own left out. */
export function treeOf(input: RegencyInput): TreeDeskRow[] {
  const folded = new Set(input.collapsed)
  return visibleDesks(input).map(desk => {
    const deskOwner = input.owners.desk[desk.id]
    const collapsed = folded.has(desk.id)
    const panes: TreePaneRow[] = collapsed ? [] : desk.panes.map(pane => {
      const own = input.owners.pane[pane.id]
      const differs = own !== undefined && own.id !== deskOwner?.id
      return { ...paneRow(input, desk.id, pane), ...(differs ? { ownerBadge: own.name } : {}) }
    })
    return {
      target: { kind: 'desk' as const, id: desk.id }, name: desk.name, color: desk.color, kind: desk.kind,
      ...(desk.icon !== undefined ? { icon: desk.icon } : {}),
      asleep: desk.asleep, collapsed, paneCount: desk.panes.length, panes,
      ...(deskOwner ? { owner: deskOwner.name } : {}),
    }
  })
}

/**
 * "Por agente": each pane once, under whoever owns it (the pane's owner, else its desk's), with the desk's badge. Panes with
 * no agent go under "Você", the first group. Agents follow in the order they first appear in the tree.
 */
export function agentTreeOf(input: RegencyInput): AgentGroupRow[] {
  const folded = new Set(input.collapsed)
  const groups = new Map<string, { name: string; you: boolean; panes: AgentPaneRow[] }>()
  groups.set(YOU_ID, { name: YOU_NAME, you: true, panes: [] })
  for (const desk of visibleDesks(input)) {
    for (const pane of desk.panes) {
      const owner = input.owners.pane[pane.id] ?? input.owners.desk[desk.id]
      const id = owner?.id ?? YOU_ID
      let group = groups.get(id)
      if (!group) { group = { name: owner!.name, you: false, panes: [] }; groups.set(id, group) }
      group.panes.push({ ...paneRow(input, desk.id, pane), deskName: desk.name, deskColor: desk.color })
    }
  }
  return [...groups].map(([id, g]) => {
    const collapsed = folded.has(id)
    return {
      target: { kind: 'agent' as const, id }, name: g.name, you: g.you, collapsed,
      paneCount: g.panes.length, panes: collapsed ? [] : g.panes,
    }
  })
}

export function regencyModelOf(input: RegencyInput): RegencyModel {
  return { waiting: waitingOf(input), conversations: conversationsOf(input), tree: treeOf(input), byAgent: agentTreeOf(input) }
}

/** Equal models give equal signatures (the builders write keys in a fixed order): the screen repaints only on a change. */
export function modelSignature(model: RegencyModel): string {
  return JSON.stringify(model)
}
