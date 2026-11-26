// The Regency's model: who waits for the person, the conversations and the tree of desks and panes. Pure: no DOM, no `ui`,
// nothing from the app or the daemon but types. Everything in and out is JSON (the app's screen reads it today; a remote
// interface reads it later), and every item carries an explicit target `{ kind, id }`, never "the active one".
import type { DeskTree } from '../../app/renderer/ext-api.ts'
import type { ChannelSummary } from '../channels/daemon/requests.ts'

export type TargetKind = 'desk' | 'pane' | 'channel' | 'agent' | 'session'
export interface Target { kind: TargetKind; id: string }

/** The state filter of the tree ("Tudo", "Esperam você", "Trabalham", "Dormem"). */
export type TreeFilter = 'all' | 'waiting' | 'busy' | 'asleep'
export const TREE_FILTERS: readonly TreeFilter[] = ['all', 'waiting', 'busy', 'asleep']

/** The fold id of "Fechadas" in `collapsed` (desks are `desk-…`, groups are a pane id or `you`: no collision). */
export const CLOSED_ID = 'closed'
/** The most rows "Fechadas" holds (the core caps it too; the rest lives in the Sessions menu). */
export const CLOSED_LIMIT = 50

/** An ended session with no tab, as the core hands it over (newest first). */
export interface ClosedInput { slotId: string; kind: string; name: string; title?: string; endedAt?: string }

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
  /** Ended sessions with no tab, newest first. Absent = none. */
  closed?: ClosedInput[]
  /** Which panes the tree shows (default `'all'`). Does not touch `waiting` or `conversations`. */
  filter?: TreeFilter
  /** Search text over the tree (default none). Not kept in the layout. */
  query?: string
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

/**
 * A group of the by-agent view. An agent's group IS its own pane: `target` is `{ kind: 'agent', id: <pane id> }` and `self`
 * carries what the line shows (identity, desk badge, state); the pane is never repeated among `panes`. The group of the
 * person ("Você", `you`) has no `self`; its target is `{ kind: 'agent', id: YOU_ID }` and it is not a pane.
 */
export interface AgentGroupRow {
  group: true
  target: Target
  name: string
  you: boolean
  collapsed: boolean
  /** How many panes sit under the group (the panes that pass the filter and the search). */
  paneCount: number
  /** What the agent has: its panes, never an agent's own pane. Empty when collapsed. */
  panes: AgentPaneRow[]
  /** The agent's own pane (absent for "Você"). */
  self?: AgentPaneRow
  /** Another agent's name, when this agent's pane sits in a desk (or is a pane) that agent owns. */
  inDeskOf?: string
}

/** An ended session (only sessions, never notes or previews). */
export interface ClosedRow {
  target: Target
  name: string
  title: string
  kind: string
  endedAt?: string
}

/** "Fechadas": `count` is the rows that pass the filter, `rows` is empty when folded. */
export interface ClosedSection { collapsed: boolean; count: number; rows: ClosedRow[] }

export interface RegencyModel {
  waiting: WaitingItem[]
  conversations: { open: ConvRow[]; closed: ConvRow[] }
  /** "Por mesa". */
  tree: TreeDeskRow[]
  /** "Por agente". */
  byAgent: AgentGroupRow[]
  /** The foot of the tree. */
  closed: ClosedSection
}

/** The panes counted by state, before any filter or search (the chips). */
export type StateCounts = Record<TreeFilter, number>

/** The id of the group of panes that have no agent. */
export const YOU_ID = 'you'
export const YOU_NAME = 'Você'

/** The longest name the Regency shows (desk, pane, channel, agent); longer ones end in "…". */
export const NAME_SHOWN_MAX = 80

/**
 * The one filter of names that come from outside (a page's title, `rename-slot`, a pipe client): control characters and the
 * format ones (Cc, Cf: bidi overrides as U+202E, zero-width marks) go, except the zero-width joiner that glues emoji; any run
 * of white space (line breaks included) becomes one space; trimmed. With `max`, cut to that many characters with "…". Used
 * where a name is typed (renaming in a row, "+ Novo") and where the Regency's model shows one (the remote reads the same model).
 */
export function safeName(raw: string, max?: number): string {
  const clean = String(raw).replace(/\s+/gu, ' ').replace(/(?!‍)[\p{Cc}\p{Cf}]/gu, '').replace(/ {2,}/g, ' ').trim()
  if (max === undefined) return clean
  const chars = [...clean]
  return chars.length <= max ? clean : `${chars.slice(0, Math.max(1, max - 1)).join('').trimEnd()}…`
}

const shown = (s: string): string => safeName(s, NAME_SHOWN_MAX)
const shownOpt = (s: string | undefined): string | undefined => s === undefined ? undefined : shown(s)

/** The input with every name passed through safeName (what the model's rows show and what the search matches). */
function cleanNames(input: RegencyInput): RegencyInput {
  const owner = (o: OwnerRef): OwnerRef => ({ ...o, name: shown(o.name) })
  const map = (r: Record<string, OwnerRef>): Record<string, OwnerRef> => Object.fromEntries(Object.entries(r).map(([k, o]) => [k, owner(o)]))
  return {
    ...input,
    desks: { ...input.desks, desks: input.desks.desks.map(d => ({ ...d, name: shown(d.name), panes: d.panes.map(p => ({ ...p, title: shown(p.title) })) })) },
    owners: { desk: map(input.owners.desk), pane: map(input.owners.pane) },
    channels: input.channels.map(c => ({
      ...c, name: shown(c.name), title: shown(c.title),
      owner: c.owner.kind === 'agent' ? { ...c.owner, name: shown(c.owner.name) } : c.owner,
    })),
    agents: input.agents.map(a => ({ ...a, name: shown(a.name), ...(a.emblem ? { emblem: { ...a.emblem, name: shown(a.emblem.name) } } : {}) })),
    ...(input.closed ? { closed: input.closed.map(c => ({ ...c, name: shown(c.name), ...(c.title !== undefined ? { title: shownOpt(c.title) } : {}) })) } : {}),
  }
}

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

type RawPane = DeskTree['desks'][number]['panes'][number]

/** Search text: no case, no accent, no edge spaces. */
export function foldText(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim()
}

const queryOf = (input: RegencyInput): string => foldText(input.query ?? '')
const filterOf = (input: RegencyInput): TreeFilter => input.filter ?? 'all'
/** With a filter or a search the folds do not apply: the result stays in view. */
const isActive = (input: RegencyInput): boolean => filterOf(input) !== 'all' || queryOf(input) !== ''

function inState(filter: TreeFilter, pane: RawPane, deskAsleep: boolean): boolean {
  if (filter === 'waiting') return pane.attention === 'waiting'
  if (filter === 'busy') return pane.busy === true
  if (filter === 'asleep') return pane.asleep === true || deskAsleep
  return true
}

const hit = (query: string, texts: Array<string | undefined>): boolean =>
  texts.some(t => t !== undefined && foldText(t).includes(query))

/** What a pane answers to in the search: its title, its agent's name and the emblem's name. */
function paneHit(input: RegencyInput, query: string, pane: RawPane): boolean {
  const agent = agentOf(input, pane.id)
  return hit(query, [pane.title, agent?.name, agent?.emblem?.name])
}

/** The panes by state, before any filter or search: the numbers on the chips. */
export function stateCounts(input: RegencyInput): StateCounts {
  const counts: StateCounts = { all: 0, waiting: 0, busy: 0, asleep: 0 }
  for (const desk of visibleDesks(input)) {
    for (const pane of desk.panes) {
      counts.all++
      for (const f of TREE_FILTERS) if (f !== 'all' && inState(f, pane, desk.asleep)) counts[f]++
    }
  }
  return counts
}

/** "Por mesa": every desk of the queue, then the system ones and the drawer, the Regency's own left out. */
export function treeOf(input: RegencyInput): TreeDeskRow[] {
  const folded = new Set(input.collapsed)
  const filter = filterOf(input), query = queryOf(input), active = isActive(input)
  const rows: TreeDeskRow[] = []
  for (const desk of visibleDesks(input)) {
    const deskOwner = input.owners.desk[desk.id]
    // A desk whose name matches shows all its panes (that pass the filter); a pane that matches shows its desk.
    const deskHit = query !== '' && hit(query, [desk.name])
    const shown = active
      ? desk.panes.filter(p => inState(filter, p, desk.asleep) && (query === '' || deskHit || paneHit(input, query, p)))
      : desk.panes
    if (active && shown.length === 0 && !(filter === 'all' && deskHit)) continue
    const collapsed = !active && folded.has(desk.id)
    const panes: TreePaneRow[] = collapsed ? [] : shown.map(pane => {
      const own = input.owners.pane[pane.id]
      const differs = own !== undefined && own.id !== deskOwner?.id
      return { ...paneRow(input, desk.id, pane), ...(differs ? { ownerBadge: own.name } : {}) }
    })
    rows.push({
      target: { kind: 'desk' as const, id: desk.id }, name: desk.name, color: desk.color, kind: desk.kind,
      ...(desk.icon !== undefined ? { icon: desk.icon } : {}),
      asleep: desk.asleep, collapsed, paneCount: shown.length, panes,
      ...(deskOwner ? { owner: deskOwner.name } : {}),
    })
  }
  return rows
}

interface AgentEntry { row: AgentPaneRow; raw: RawPane; deskHit: boolean; deskAsleep: boolean }
interface AgentBucket { id: string; name: string; self?: AgentEntry; inDeskOf?: string; kids: AgentEntry[] }

/**
 * "Por agente": every agent alive in the tree is a group, even with nothing under it, and the group's line is the agent's own
 * pane (identity, desk badge, state). Under it go the panes it has (the pane's owner, else its desk's) with the desk's badge;
 * a pane of another agent is never a child, that agent is a group of its own (marked `inDeskOf` when this agent owns its desk).
 * Panes with no agent owner go under "Você", the last group. Each pane appears once. Agents keep the order of the tree.
 */
export function agentTreeOf(input: RegencyInput): AgentGroupRow[] {
  const folded = new Set(input.collapsed)
  const filter = filterOf(input), query = queryOf(input), active = isActive(input)
  const alive = new Set<string>()
  for (const desk of visibleDesks(input)) for (const pane of desk.panes) if (agentOf(input, pane.id)) alive.add(pane.id)

  const buckets = new Map<string, AgentBucket>()
  const you: AgentBucket = { id: YOU_ID, name: YOU_NAME, kids: [] }
  const ownerOfPane = (deskId: string, paneId: string): OwnerRef | undefined => input.owners.pane[paneId] ?? input.owners.desk[deskId]
  const entries: Array<{ entry: AgentEntry; deskId: string; paneId: string }> = []
  for (const desk of visibleDesks(input)) {
    const deskHit = query !== '' && hit(query, [desk.name])
    for (const pane of desk.panes) {
      const entry: AgentEntry = {
        row: { ...paneRow(input, desk.id, pane), deskName: desk.name, deskColor: desk.color }, raw: pane, deskHit, deskAsleep: desk.asleep,
      }
      entries.push({ entry, deskId: desk.id, paneId: pane.id })
      if (alive.has(pane.id)) buckets.set(pane.id, { id: pane.id, name: agentOf(input, pane.id)!.name, self: entry, kids: [] })
    }
  }
  for (const { entry, deskId, paneId } of entries) {
    const owner = ownerOfPane(deskId, paneId)
    const ownerBucket = owner !== undefined && owner.id !== paneId ? buckets.get(owner.id) : undefined
    if (alive.has(paneId)) {
      if (ownerBucket) buckets.get(paneId)!.inDeskOf = ownerBucket.name
    } else (ownerBucket ?? you).kids.push(entry)
  }

  const out: AgentGroupRow[] = []
  for (const b of [...buckets.values(), you]) {
    const passing = b.kids.filter(k => !active || inState(filter, k.raw, k.deskAsleep))
    // An agent whose own line matches shows all its panes; so does a pane whose desk's name matches.
    const lineHit = query !== '' && (b.self ? paneHit(input, query, b.self.raw) : hit(query, [b.name]))
    const kids = query === '' || lineHit ? passing : passing.filter(k => k.deskHit || paneHit(input, query, k.raw))
    if (active) {
      const selfShown = b.self !== undefined && inState(filter, b.self.raw, b.self.deskAsleep) && (query === '' || lineHit || b.self.deskHit)
      if (kids.length === 0 && !selfShown) continue
    }
    const collapsed = !active && kids.length > 0 && folded.has(b.id)
    out.push({
      group: true, target: { kind: 'agent' as const, id: b.id }, name: b.name, you: b === you, collapsed,
      paneCount: kids.length, panes: collapsed ? [] : kids.map(k => k.row),
      ...(b.self ? { self: b.self.row } : {}),
      ...(b.inDeskOf !== undefined ? { inDeskOf: b.inDeskOf } : {}),
    })
  }
  return out
}

/** "Fechadas": the ended sessions that fit the search (no state filter applies to them: with one on, none show). */
export function closedOf(input: RegencyInput): ClosedSection {
  const query = queryOf(input)
  const rows: ClosedRow[] = filterOf(input) !== 'all' ? [] : (input.closed ?? [])
    .filter(c => query === '' || hit(query, [c.name, c.title, c.kind]))
    .slice(0, CLOSED_LIMIT)
    .map(c => ({
      target: { kind: 'session' as const, id: c.slotId }, name: c.name, title: c.title ?? c.name, kind: c.kind,
      ...(c.endedAt !== undefined ? { endedAt: c.endedAt } : {}),
    }))
  const collapsed = query === '' && input.collapsed.includes(CLOSED_ID)
  return { collapsed, count: rows.length, rows: collapsed ? [] : rows }
}

export function regencyModelOf(raw: RegencyInput): RegencyModel {
  const input = cleanNames(raw)
  return {
    waiting: waitingOf(input), conversations: conversationsOf(input), tree: treeOf(input), byAgent: agentTreeOf(input),
    closed: closedOf(input),
  }
}

/** The model of one view: the same as `regencyModelOf` with the filter and the search given apart from the input. */
export function filterModel(input: RegencyInput, opts: { filter?: TreeFilter; query?: string }): RegencyModel {
  return regencyModelOf({ ...input, filter: opts.filter ?? 'all', query: opts.query ?? '' })
}

/** Equal models give equal signatures (the builders write keys in a fixed order): the screen repaints only on a change. */
export function modelSignature(model: RegencyModel): string {
  return JSON.stringify(model)
}
