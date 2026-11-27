// The Regency's published tree (plano D2 (b), RR3 3.2): the app publishes the model's ENTRY (`RegencyInput`), tetherd keeps
// the last one, and a remote screen runs `regencyModelOf` on it. This file holds the pure rules of both halves: the allow
// list of what is published, its size, its signature, the lease that tells "the app is publishing" from "the app left",
// and the join of the kept tree with the slots tetherd sees live. Pure: no DOM, no `ui`, no `node:`.
//
// Projection rule: an ALLOW LIST, as in src/remote/projection.ts. Every field is copied by name from what the app holds;
// no object is ever spread, so a field added later to a desk, a pane, a channel or an agent (an env, args, a profile, a
// path) cannot be published. Text is capped. The device's own screen state (folds, filter, search) is not published.
import type { ChannelSummary } from '../channels/daemon/requests.ts'
import type { AgentRef, ChannelMarksInput, ClosedInput, OwnerRef, RegencyInput } from './model.ts'
import { remoteInputOf, type RemoteState } from './remote-input.ts'

type Desk = RegencyInput['desks']['desks'][number]
type Pane = Desk['panes'][number]

/**
 * The most bytes (UTF-8 of the JSON) one published tree may have: a bigger one is refused, never cut. Below VIEW_MAX_BYTES
 * with room for the live slots, and that below the portal's ceiling of a read (src/remote/projection.ts READ_BODY_MAX, 224
 * KiB; the test of ext.regency-publish ties the three), so every tree tetherd keeps reaches the phone.
 */
export const TREE_MAX_BYTES = 192 * 1024
/**
 * The most bytes of the view `tree.read` answers (regencyViewOf): with the app closed, the slots born after it go over the
 * tree while they fit; past this, the rest are left out (they are still in the attention list and in the next tree).
 */
export const VIEW_MAX_BYTES = 208 * 1024
/** The app renews its lease this often while it is open (a signature only, no tree). */
export const LEASE_MS = 30_000
/** A tree whose lease was not renewed for this long is the app's last: the app closed (or hangs), nobody publishes. */
export const STALE_MS = 75_000

/** The requests of the daemon half (ext `regency`) and its one event. */
export const TREE_REQ = { publish: 'tree.publish', read: 'tree.read' } as const
export const TREE_CHANGED = 'tree.changed'

/** The answer of `tree.publish`: the signature kept (and when that tree came), or "send me the tree" to a lease. */
export type PublishAnswer = { sig: string; at?: number } | { need: 'tree' }

const ID_MAX = 128
const NAME_MAX = 128
const TITLE_MAX = 256
const TEXT_MAX = 512
const DESKS_MAX = 256
const PANES_MAX = 512
const CHANNELS_MAX = 512
const AGENTS_MAX = 1024
const CLOSED_MAX = 50

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')
const optStr = (v: unknown, max: number): string | undefined => (typeof v === 'string' ? v.slice(0, max) : undefined)
const count = (v: unknown): number => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0)
const list = <T>(v: unknown, max: number): T[] => (Array.isArray(v) ? (v.slice(0, max) as T[]) : [])
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
/** The keys of a record, sorted: the JSON of a projected tree does not depend on the order the app built it in. */
const keysOf = (v: unknown, max: number): string[] => Object.keys(rec(v)).filter(k => k.length <= ID_MAX).sort().slice(0, max)

/**
 * The seal's lines of a pane (the terminal's line and the extensions' messages: what the agent is doing, in a line or two):
 * at most SEAL_LINES_MAX, each cut at SEAL_LINE_MAX characters. Text the agent writes; the portal sanitizes it again.
 */
export const SEAL_LINES_MAX = 3
export const SEAL_LINE_MAX = 160

function sealLines(v: unknown): string[] | undefined {
  const out = (Array.isArray(v) ? v : []).filter((l): l is string => typeof l === 'string' && l !== '').slice(0, SEAL_LINES_MAX).map(l => l.slice(0, SEAL_LINE_MAX))
  return out.length > 0 ? out : undefined
}

function pane(p: Pane): Pane {
  const out: Pane = { id: str(p?.id, ID_MAX), type: str(p?.type, 32), icon: str(p?.icon, 32), title: str(p?.title, TITLE_MAX) }
  if (p?.attention === 'done' || p?.attention === 'waiting') out.attention = p.attention
  if (p?.busy === true) out.busy = true
  if (p?.asleep === true) out.asleep = true
  if (p?.exited === true) out.exited = true
  const lines = sealLines(p?.lines)
  if (lines) out.lines = lines
  return out
}

/** A pane of a tree the app no longer publishes: its seal says what the agent WAS doing, so it goes. */
const withoutLines = (p: Pane): Pane => {
  if (p.lines === undefined) return p
  const { lines: _l, ...rest } = p
  return rest
}

function desk(d: Desk): Desk {
  const kind = d?.kind === 'system' || d?.kind === 'drawer' ? d.kind : 'queue'
  const out: Desk = { id: str(d?.id, ID_MAX), name: str(d?.name, NAME_MAX), color: str(d?.color, 32), kind, asleep: d?.asleep === true, panes: list<Pane>(d?.panes, PANES_MAX).map(pane) }
  const icon = optStr(d?.icon, 32)
  if (icon !== undefined) out.icon = icon
  return out
}

const owner = (o: OwnerRef): OwnerRef => ({ id: str(o?.id, ID_MAX), name: str(o?.name, NAME_MAX) })

function owners(v: unknown): Record<string, OwnerRef> {
  const src = rec(v)
  const out: Record<string, OwnerRef> = {}
  for (const k of keysOf(v, PANES_MAX * 4)) out[k] = owner(src[k] as OwnerRef)
  return out
}

function channel(c: ChannelSummary): ChannelSummary {
  const o = c?.owner
  const out: ChannelSummary = {
    id: str(c?.id, ID_MAX), name: str(c?.name, NAME_MAX), title: str(c?.title, TITLE_MAX),
    owner: o?.kind === 'agent' ? { kind: 'agent', id: str(o.id, ID_MAX), name: str(o.name, NAME_MAX) } : { kind: 'user' },
    members: count(c?.members), seenByUser: count(c?.seenByUser), createdAt: str(c?.createdAt, 32),
  }
  const deskId = optStr(c?.desk, ID_MAX)
  if (deskId !== undefined) out.desk = deskId
  const ended = c?.ownerEnded
  if (ended && typeof ended === 'object') {
    const why = ended.why === 'forgotten' || ended.why === 'left' || ended.why === 'removed' ? ended.why : 'removed'
    out.ownerEnded = { at: str(ended.at, 32), name: str(ended.name, NAME_MAX), why }
  }
  const closed = c?.closed
  if (closed && typeof closed === 'object') out.closed = { at: str(closed.at, 32), by: str(closed.by, ID_MAX) }
  return out
}

function marks(m: ChannelMarksInput): ChannelMarksInput {
  const out: ChannelMarksInput = { unread: count(m?.unread), toMe: count(m?.toMe), asks: count(m?.asks), owed: count(m?.owed) }
  const f = m?.first
  if (f && (f.why === 'to-you' || f.why === 'reaction-asks' || f.why === 'poll-owed')) out.first = { why: f.why, text: str(f.text, TEXT_MAX) }
  return out
}

function agent(a: AgentRef): AgentRef {
  const out: AgentRef = { id: str(a?.id, ID_MAX), kind: str(a?.kind, 32), name: str(a?.name, NAME_MAX) }
  const e = a?.emblem
  if (e && typeof e === 'object') out.emblem = { name: str(e.name, NAME_MAX), color: str(e.color, 32), icon: str(e.icon, 32) }
  return out
}

function closedRow(c: ClosedInput): ClosedInput {
  const out: ClosedInput = { slotId: str(c?.slotId, ID_MAX), kind: str(c?.kind, 32), name: str(c?.name, NAME_MAX) }
  const title = optStr(c?.title, TITLE_MAX)
  if (title !== undefined) out.title = title
  const endedAt = optStr(c?.endedAt, 32)
  if (endedAt !== undefined) out.endedAt = endedAt
  return out
}

/**
 * What of the Regency's entry is published: the tree, the owners, the channels and their marks, the agents, the waiting
 * times and the ended sessions, field by field. The folds, the filter and the search are the screen's, not the house's.
 * Accepts anything (the daemon runs it again on what arrives), and gives the same JSON for the same entry.
 */
export function publishedTreeOf(input: RegencyInput): RegencyInput {
  const i = rec(input) as Partial<RegencyInput>
  const marksSrc = rec(i.channelMarks)
  const channelMarks: Record<string, ChannelMarksInput> = {}
  for (const k of keysOf(i.channelMarks, CHANNELS_MAX)) channelMarks[k] = marks(marksSrc[k] as ChannelMarksInput)
  const sinceSrc = rec(i.since)
  const since: Record<string, number> = {}
  for (const k of keysOf(i.since, PANES_MAX * 4)) {
    const at = sinceSrc[k]
    if (typeof at === 'number' && Number.isFinite(at)) since[k] = at
  }
  const out: RegencyInput = {
    desks: { desks: list<Desk>(rec(i.desks).desks, DESKS_MAX).map(desk) },
    owners: { desk: owners(rec(i.owners).desk), pane: owners(rec(i.owners).pane) },
    channels: list<ChannelSummary>(i.channels, CHANNELS_MAX).map(channel),
    channelMarks,
    agents: list<AgentRef>(i.agents, AGENTS_MAX).map(agent),
    since,
    collapsed: [],
  }
  const self = optStr(i.selfDeskId, ID_MAX)
  if (self !== undefined) out.selfDeskId = self
  if (Array.isArray(i.closed)) out.closed = list<ClosedInput>(i.closed, CLOSED_MAX).map(closedRow)
  return out
}

/** The JSON a published tree travels and is kept as. */
export const treeJson = (tree: RegencyInput): string => JSON.stringify(tree)

/** The UTF-8 size of a string, without TextEncoder (the same count in the app and in tetherd). */
export function utf8Length(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++ }
    else n += 3
  }
  return n
}

/**
 * The signature of a tree: 64 bits (two 32-bit FNV-1a lanes with different seeds) of its JSON, in 16 hex digits. It tells
 * one tree from another (to publish only what changed, and to renew a lease by naming the tree); it proves nothing.
 */
export function signatureOf(json: string): string {
  let a = 0x811c9dc5
  let b = 0x01000193 ^ 0x5bd1e995
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193)
    b = Math.imul(b ^ c, 0x01000193) ^ (b >>> 15)
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0')
}

/** A tree as tetherd keeps it: the one last published, its size, its signature, when it came and when its lease was last renewed. */
export interface KeptTree {
  tree: RegencyInput
  sig: string
  bytes: number
  /** When this tree was published (epoch ms): the time "como estavam às HH:MM" names. */
  at: number
  /** When the app last said "still this tree" (a publish or a lease), epoch ms. */
  seenAt: number
  /** The pipe connection that published it: the only one whose lease counts (daemon.ts). */
  conn?: number
}

/** The app is publishing: its lease is fresh. */
export const isLive = (kept: Pick<KeptTree, 'seenAt'> | undefined, now: number): boolean =>
  kept !== undefined && now - kept.seenAt <= STALE_MS

/** What a remote screen draws: the entry of the model, whether it is live, and when it was true when it is not. */
export interface RegencyView {
  input: RegencyInput
  /** The app is open and publishing: the tree is the app's own, now. */
  live: boolean
  /** Not live: when the kept tree was published (epoch ms). Absent with no tree at all (only the floor). */
  asOf?: number
  sig?: string
}

/** "como estavam às HH:MM", in the clock of whoever draws it. */
export function asOfLabel(at: number, date: (ms: number) => { h: number; m: number } = ms => { const d = new Date(ms); return { h: d.getHours(), m: d.getMinutes() } }): string {
  const { h, m } = date(at)
  return `como estavam às ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

const FLOOR_DESK_ID = 'remote:slots'

/**
 * The kept tree joined with what tetherd sees live. App open: the tree as it is. App closed: the tree as it was, with the
 * live slots over it (attention, turn and end of each pane that is a slot; a slot the tree did not have in its own desk;
 * an agent whose slot is gone, ended). No tree: the floor (remote-input.ts) alone.
 */
export function regencyViewOf(kept: KeptTree | undefined, live: RemoteState, now: number): RegencyView {
  if (!kept) return { input: remoteInputOf(live), live: false }
  if (isLive(kept, now)) return { input: kept.tree, live: true, sig: kept.sig }

  const floor = remoteInputOf(live)
  const slotIds = new Set<string>((Array.isArray(live.slots) ? live.slots : []).map(s => s?.slotId).filter((id): id is string => typeof id === 'string'))
  const floorPanes = new Map<string, Pane>()
  for (const d of floor.desks.desks) for (const p of d.panes) if (slotIds.has(p.id) && !floorPanes.has(p.id)) floorPanes.set(p.id, p)
  const agentIds = new Set(kept.tree.agents.map(a => a.id))
  const knowSlots = Array.isArray(live.slots)

  const seen = new Set<string>()
  const over = (p: Pane): Pane => {
    seen.add(p.id)
    const f = floorPanes.get(p.id)
    if (!f) {
      // An agent's pane whose slot tetherd no longer has: it ended while the app was closed.
      if (!knowSlots || !agentIds.has(p.id)) return withoutLines(p)
      const { attention: _a, busy: _b, lines: _l, ...rest } = p
      return { ...rest, exited: true }
    }
    const out: Pane = { id: p.id, type: p.type, icon: p.icon, title: p.title }
    if (f.attention) out.attention = f.attention
    if (f.busy) out.busy = true
    if (live.deskMap ? f.asleep : p.asleep) out.asleep = true
    if (f.exited) out.exited = true
    return out
  }
  const desks: Desk[] = kept.tree.desks.desks.map(d => ({ ...d, panes: d.panes.map(over) }))
  const agents = [...kept.tree.agents]
  const view: RegencyView = { input: { ...kept.tree, desks: { desks }, agents }, live: false, asOf: kept.at, sig: kept.sig }
  // The view stays under VIEW_MAX_BYTES: the tree with the live state of its own panes first (in a pathological tree whose
  // flags alone pass it, the tree as it was kept), then the newcomers and their agents while they fit.
  let room = VIEW_MAX_BYTES - utf8Length(JSON.stringify(view))
  if (room < 0) return { input: { ...kept.tree, desks: { desks: kept.tree.desks.desks.map(d => ({ ...d, panes: d.panes.map(withoutLines) })) } }, live: false, asOf: kept.at, sig: kept.sig }
  const cost = (v: unknown): number => utf8Length(JSON.stringify(v)) + 1
  const extra: Desk = { id: FLOOR_DESK_ID, name: 'Sessões', color: '', kind: 'queue', asleep: false, panes: [] }
  room -= cost(extra)
  const fit = new Set<string>()
  for (const p of floorPanes.values()) {
    if (seen.has(p.id)) continue
    const n = cost(p)
    if (n > room) break
    room -= n
    extra.panes.push(p)
    fit.add(p.id)
  }
  if (extra.panes.length > 0) desks.push(extra)
  for (const a of floor.agents) {
    if (agentIds.has(a.id) || (!seen.has(a.id) && !fit.has(a.id))) continue
    const n = cost(a)
    if (n > room) break
    room -= n
    agents.push(a)
  }
  return view
}
