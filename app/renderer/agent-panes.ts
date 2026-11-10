// The agent panes an extension sees (TetherUi.agents.list): the shared agent view (app/shared/agent-info.ts) plus where the
// pane lives. Pure: main.ts passes the slot and the place it found.
import type { SlotState } from '../../src/daemon/protocol.ts'
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

/** An agent's pane: the info every host has, plus the renderer's layout. */
export interface AgentPane extends AgentInfo, PanePlace {}

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
  }
}

/** What changed between two snapshots: the listener hears each added, changed or removed pane (a removed one as not alive). */
export function agentPaneChanges(before: readonly AgentPane[], after: readonly AgentPane[]): AgentPane[] {
  const d: AgentDiff<AgentPane> = diffAgents(before, after)
  return [...d.added, ...d.changed, ...d.removed.map(a => ({ ...a, alive: false }))]
}
