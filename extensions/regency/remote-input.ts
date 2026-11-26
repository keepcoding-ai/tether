// The Regency's floor for a remote screen: a minimal `RegencyInput` built only from what tetherd knows through the pipe (the slots
// and the desk map). Pure: no DOM, no `ui`, no `node:`; the daemon's types come in as types only. Whatever the pipe does not carry
// (desk colour, pane icon, emblems, seals, channels, ownership, folds) stays in the neutral default the model accepts, until the
// app publishes the real tree.
//
// Projection rule: an ALLOW LIST. Each field is copied by name; no object from the pipe is ever spread, so a field the pipe adds
// later (env, args, a request's text) cannot reach the result. The folder is reduced to its last segment, and only as a fallback title.
import type { DeskMap, SlotState } from '../../src/daemon/protocol.ts'
import type { AgentRef, RegencyInput } from './model.ts'

type Desk = RegencyInput['desks']['desks'][number]
type Pane = Desk['panes'][number]

/** What tetherd tells without the app: the slots and, when it has one, the desk map the app last told it. */
export interface RemoteState {
  slots?: readonly SlotState[]
  deskMap?: DeskMap
}

/** The neutral desk colour (the model only carries it; the remote screen picks its own when it is empty). */
const NEUTRAL_COLOR = ''
const UNPLACED_ID = 'remote:slots'
const UNPLACED_NAME = 'Sessões'

const GONE: ReadonlySet<string> = new Set(['exited', 'error', 'unconfirmed'])

/** The last segment of a folder path, the only part of it that leaves the daemon. */
export function lastSegment(path: string | undefined): string | undefined {
  if (typeof path !== 'string') return undefined
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1]
}

const text = (v: unknown): string | undefined => typeof v === 'string' && v.trim() !== '' ? v : undefined

function titleOf(slot: SlotState): string {
  return text(slot.title) ?? text(slot.name) ?? lastSegment(text(slot.folder) ?? text(slot.cwd)) ?? String(slot.kind)
}

/** The pane of a slot: its attention (rerouted included) and turn become the flags the model's one state rule reads. */
function slotPane(slot: SlotState, asleep: boolean): Pane {
  const attention = slot.attention ?? slot.attentionFor?.value
  return {
    id: slot.slotId,
    type: 'terminal',
    icon: 'terminal',
    title: titleOf(slot),
    ...(attention === 'done' || attention === 'waiting' ? { attention } : {}),
    ...(slot.turn === 'busy' ? { busy: true as const } : {}),
    ...(asleep ? { asleep: true as const } : {}),
    ...(GONE.has(slot.status) ? { exited: true as const } : {}),
  }
}

/** A pane that is not a slot's (a note, a browser tab): the daemon knows its type and sleep, nothing else. */
function otherPane(p: DeskMap['drawer'][number]): Pane {
  return { id: String(p.id), type: String(p.type), icon: String(p.type), title: String(p.type), ...(p.asleep ? { asleep: true as const } : {}) }
}

export function remoteInputOf(state: RemoteState = {}): RegencyInput {
  const slots = Array.isArray(state.slots) ? state.slots : []
  const bySlot = new Map<string, SlotState>()
  for (const s of slots) if (typeof s?.slotId === 'string') bySlot.set(s.slotId, s)

  const placed = new Set<string>()
  const paneOf = (p: DeskMap['drawer'][number]): Pane => {
    const slot = p.type === 'terminal' ? bySlot.get(p.id) : undefined
    if (slot) { placed.add(slot.slotId); return slotPane(slot, !!p.asleep) }
    return otherPane(p)
  }

  const desks: Desk[] = (state.deskMap?.desks ?? []).map(d => ({
    id: String(d.id), name: String(d.name), color: NEUTRAL_COLOR, kind: d.kind === 'system' ? 'system' : 'queue',
    asleep: !!d.asleep, panes: (d.panes ?? []).map(paneOf),
  }))
  const drawer = (state.deskMap?.drawer ?? []).map(paneOf)
  if (drawer.length > 0) desks.push({ id: 'drawer', name: 'Gaveta', color: NEUTRAL_COLOR, kind: 'drawer', asleep: false, panes: drawer })

  // Slots the map does not place (no map yet, app closed) stay visible in one neutral desk.
  const loose = [...bySlot.values()].filter(s => !placed.has(s.slotId)).map(s => slotPane(s, false))
  if (loose.length > 0) desks.push({ id: UNPLACED_ID, name: UNPLACED_NAME, color: NEUTRAL_COLOR, kind: 'queue', asleep: false, panes: loose })

  // Every slot that is not a plain shell is an agent: the model then says "agent waiting" rather than a seal.
  const agents: AgentRef[] = [...bySlot.values()]
    .filter(s => s.kind !== 'shell')
    .map(s => ({ id: s.slotId, kind: String(s.kind), name: titleOf(s) }))

  return { desks: { desks }, owners: { desk: {}, pane: {} }, channels: [], channelMarks: {}, agents, since: {}, collapsed: [] }
}
