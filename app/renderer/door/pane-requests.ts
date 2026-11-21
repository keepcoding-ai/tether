// A pane the daemon asked for (SlotState.paneRequest): when the app creates it, ignores the request or waits. Pure rules plus
// the one loop that applies them through a port; main.ts supplies the port (what only it can do: find a pane, add one).
import type { SlotState } from '../../../src/daemon/protocol.ts'

export interface PaneRequestInput {
  /** The slot's `paneRequest`. */
  deskId: string | undefined
  /** The slot already has a pane somewhere (any desk, the drawer, a pad's frame). */
  hasPane: boolean
  /** layout.json was read and applied: before that a pane added now would be lost (restore may rebuild the desks). */
  layoutRestored: boolean
  /** The requested desk, when it is mounted. */
  desk: { asleep: boolean } | undefined
}

export type PaneRequestDecision =
  | { action: 'create'; deskId: string; asleep: boolean }
  /** `resend`: the daemon clears the request on a desk map that shows the slot, so a map must go even if it did not change. */
  | { action: 'ignore'; reason: 'no-request' | 'has-pane' | 'no-desk'; resend: boolean }
  | { action: 'defer'; reason: 'layout-not-restored' }

export function decidePaneRequest(i: PaneRequestInput): PaneRequestDecision {
  if (!i.deskId) return { action: 'ignore', reason: 'no-request', resend: false }
  if (!i.layoutRestored) return { action: 'defer', reason: 'layout-not-restored' }
  if (i.hasPane) return { action: 'ignore', reason: 'has-pane', resend: true }
  if (!i.desk) return { action: 'ignore', reason: 'no-desk', resend: false }
  return { action: 'create', deskId: i.deskId, asleep: i.desk.asleep }
}

/** What applying a request needs from main.ts. */
export interface PaneRequestPort {
  layoutRestored(): boolean
  hasPane(slotId: string): boolean
  /** The desk's state when it is mounted (queue or system desk), else undefined. */
  desk(deskId: string): { asleep: boolean } | undefined
  /**
   * Adds the slot's pane to the desk without activating it or changing desk (`desk.addPanel({ ...slotPanelOptions(slot), inactive: true })`).
   * `asleep`: the desk is hibernated, so the pane joins `asleepPanes` and `deskSleptPanes` (the process already runs).
   * Saves the layout afterwards.
   */
  addPane(slot: SlotState, deskId: string, asleep: boolean): void
  /** Sends the desk map now, changed or not. */
  resendMap(): void
  log(message: string): void
}

/** Applies the pending requests of `slots`; returns the ones that wait (layout not restored yet). */
export function applyPaneRequests(slots: Iterable<SlotState>, port: PaneRequestPort): string[] {
  const waiting: string[] = []
  let resend = false
  for (const slot of slots) {
    if (!slot.paneRequest) continue
    const d = decidePaneRequest({
      deskId: slot.paneRequest.deskId,
      hasPane: port.hasPane(slot.slotId),
      layoutRestored: port.layoutRestored(),
      desk: port.desk(slot.paneRequest.deskId),
    })
    if (d.action === 'defer') waiting.push(slot.slotId)
    else if (d.action === 'create') port.addPane(slot, d.deskId, d.asleep)
    else if (d.reason === 'no-desk') port.log(`painel pedido para ${slot.slotId}: a mesa ${slot.paneRequest.deskId} não existe; o slot fica sem guia`)
    else if (d.resend) resend = true
  }
  if (resend) port.resendMap()
  return waiting
}
