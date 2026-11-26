// The agent panes an extension sees (TetherUi.agents.list): the shared agent view (app/shared/agent-info.ts) plus where the
// pane lives. Pure: main.ts passes the slot and the place it found.
import type { Reply, SlotState } from '../../src/daemon/protocol.ts'
import { agentInfoOf, diffAgents, type AgentDiff, type AgentInfo } from '../shared/agent-info.ts'

export type { AgentInfo } from '../shared/agent-info.ts'

/** Where a pane lives, as main.ts finds it. */
export interface PanePlace {
  paneId: string
  /** The desk holding the pane (a desk pad's pane: its desk); undefined for the drawer and a window-wide pad. */
  deskId?: string
  deskTitle?: string
  isSystemDesk: boolean
  inDrawer: boolean
  /** The pad whose frames hold the pane, if any. */
  padId?: string
}

/**
 * The agent's ronda (tether's nudge clock), as the slot's state carries it: on while present. `nextAt`/`lastAt` are ISO
 * times; `due`: the time has come and tether waits for the agent to be idle; `channel`: whether the agent's CLI listens on
 * the ronda's channel now ('listening') or not ('none'; absent on older daemons). `nudge` is the extra text appended to the
 * default nudge, `criterion` the stop criterion (with one, switching off asks first).
 */
export interface AgentRonda {
  intervalMs: number
  nextAt: string
  lastAt?: string
  nudge?: string
  criterion?: string
  due?: true
  channel?: 'listening' | 'none'
}

/** What `setRonda` changes: `interval` like '10m' or '1h' (absent keeps, 20m when new); `nudge`/`criterion` absent keep, '' clears. */
export interface RondaChange {
  interval?: string
  nudge?: string
  criterion?: string
}

/**
 * The answer of `setRonda`/`offRonda`. A refusal is data, never thrown: `ronda-unavailable` (the agent takes no channel;
 * `message` says why), `ronda-criterion` (off without `force` on a ronda with a criterion: ask the person, then force),
 * `bad-request` (an interval or text the daemon refused; `message` is the sentence to show), or the daemon's other codes.
 */
export type RondaAnswer =
  | { ok: true; ronda: AgentRonda | undefined; outcome: 'created' | 'updated' | 'unchanged' | 'off' | 'was-off' }
  | { ok: false; code: string; message: string }

/**
 * An agent's pane: the info every host has, plus the renderer's layout. `placed: false` marks a live agent with NO pane (a
 * session outside any desk, drawer or pad: "Sem guia"); `paneId` is still its slot id, but nothing shows it. Absent = it has a pane.
 * `ronda`: the agent's ronda while it is on (absent: off).
 */
export interface AgentPane extends AgentInfo, PanePlace {
  placed?: false
  ronda?: AgentRonda
}

/** The slot's ronda as an AgentRonda (undefined: off). Only the fields a screen needs, in a fixed order (the diff compares JSON). */
export function agentRondaOf(r: SlotState['ronda'] | null | undefined): AgentRonda | undefined {
  if (!r) return undefined
  return {
    intervalMs: r.intervalMs,
    nextAt: r.nextAt,
    ...(r.lastAt ? { lastAt: r.lastAt } : {}),
    ...(r.nudge ? { nudge: r.nudge } : {}),
    ...(r.criterion ? { criterion: r.criterion } : {}),
    ...(r.due ? { due: true as const } : {}),
    ...(r.channel ? { channel: r.channel } : {}),
  }
}

/** The daemon's reply to `ronda-set`/`ronda-off` as a RondaAnswer. */
export function rondaAnswerOf(reply: Reply): RondaAnswer {
  if (reply.t === 'error') return { ok: false, code: reply.code, message: reply.message }
  return { ok: true, ronda: agentRondaOf(reply.ronda), outcome: reply.rondaOutcome ?? 'unchanged' }
}

/** The `ronda-set` request of a change: only the fields given (an absent one keeps what the ronda has). */
export function rondaSetRequest(slotId: string, change: RondaChange): { t: 'ronda-set'; slotId: string; interval?: string; nudge?: string; criterion?: string } {
  return {
    t: 'ronda-set', slotId,
    ...(change.interval !== undefined ? { interval: change.interval } : {}),
    ...(change.nudge !== undefined ? { nudge: change.nudge } : {}),
    ...(change.criterion !== undefined ? { criterion: change.criterion } : {}),
  }
}

/** The ronda field of a pane, spread into it (none while off). */
function rondaField(slot: SlotState): { ronda?: AgentRonda } {
  const ronda = agentRondaOf(slot.ronda)
  return ronda ? { ronda } : {}
}

/** The agent of a live slot that no pane shows: it has an identity and a name, but no place. */
export function loosePaneOf(slot: SlotState): AgentPane | undefined {
  const info = agentInfoOf(slot)
  if (!info || !info.alive) return undefined
  return { ...info, paneId: slot.slotId, isSystemDesk: false, inDrawer: false, placed: false, ...rondaField(slot) }
}

/** The pane of a slot; undefined for a plain shell. `color` is left out: the interface gives agents no colour of their own. */
export function agentPaneOf(slot: SlotState, place: PanePlace): AgentPane | undefined {
  const info = agentInfoOf(slot)
  if (!info) return undefined
  return {
    ...info,
    paneId: place.paneId,
    ...(place.deskId !== undefined ? { deskId: place.deskId } : {}),
    ...(place.deskTitle !== undefined ? { deskTitle: place.deskTitle } : {}),
    isSystemDesk: place.isSystemDesk,
    inDrawer: place.inDrawer,
    ...(place.padId !== undefined ? { padId: place.padId } : {}),
    ...rondaField(slot),
  }
}

/** What changed between two snapshots: the listener hears each added, changed or removed pane (a removed one as not alive). */
export function agentPaneChanges(before: readonly AgentPane[], after: readonly AgentPane[]): AgentPane[] {
  const d: AgentDiff<AgentPane> = diffAgents(before, after)
  return [...d.added, ...d.changed, ...d.removed.map(a => ({ ...a, alive: false }))]
}
