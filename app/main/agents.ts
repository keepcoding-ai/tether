// The agents main knows (TetherMain.agents): the daemon's slot states it already receives for the tray, reduced to
// AgentInfo (app/shared/agent-info.ts). No layout here (desk, drawer, colour live in the renderer). Pure: main.ts feeds it.
import type { SlotState } from '../../src/daemon/protocol.ts'
import { agentInfoOf, diffAgents, type AgentInfo } from '../shared/agent-info.ts'
import { toDisposable, type IDisposable } from '../shared/vscode-lifecycle.ts'

export type { AgentInfo } from '../shared/agent-info.ts'

/** Why an agent stopped being alive. */
export type AgentExitReason = 'exited' | 'removed' | 'daemon-lost'

export interface AgentExit extends AgentInfo {
  reason: AgentExitReason
}

/** A slot that is gone for good, with the name it had when it went (empty when it was never known as an agent). */
export interface AgentRemoval {
  slotId: string
  name: string
}

export interface MainAgents {
  list(): AgentInfo[]
  get(slotId: string): AgentInfo | undefined
  /** An agent appeared, was renamed, changed profile, exited or was removed (the snapshot after the change). */
  onDidChange(listener: (agent: AgentInfo) => void): IDisposable
  /** An agent that was alive is not any more: its process ended, its slot was removed, or the daemon connection was lost. */
  onDidExit(listener: (e: AgentExit) => void): IDisposable
  /**
   * The daemon removed the slot for good (the pane closed, the slot forgotten), once per slot, alive or not. Unlike `onDidExit`,
   * a restart in place, a stop to resume later or a lost daemon never fire it.
   */
  onDidRemove(listener: (e: AgentRemoval) => void): IDisposable
}

export class AgentTracker implements MainAgents {
  private agents = new Map<string, AgentInfo>()
  private readonly changeListeners = new Set<(agent: AgentInfo) => void>()
  private readonly exitListeners = new Set<(e: AgentExit) => void>()
  private readonly removeListeners = new Set<(e: AgentRemoval) => void>()

  list(): AgentInfo[] { return [...this.agents.values()] }
  get(slotId: string): AgentInfo | undefined { return this.agents.get(slotId) }

  onDidChange(listener: (agent: AgentInfo) => void): IDisposable {
    this.changeListeners.add(listener)
    return toDisposable(() => { this.changeListeners.delete(listener) })
  }

  onDidExit(listener: (e: AgentExit) => void): IDisposable {
    this.exitListeners.add(listener)
    return toDisposable(() => { this.exitListeners.delete(listener) })
  }

  onDidRemove(listener: (e: AgentRemoval) => void): IDisposable {
    this.removeListeners.add(listener)
    return toDisposable(() => { this.removeListeners.delete(listener) })
  }

  /** A state event from the daemon. */
  apply(slot: SlotState): void {
    const info = agentInfoOf(slot)
    const next = new Map(this.agents)
    if (info) next.set(slot.slotId, info)
    else next.delete(slot.slotId)
    this.commit(next, 'exited')
  }

  /** The daemon removed the slot. */
  remove(slotId: string): void {
    const name = this.agents.get(slotId)?.name ?? ''
    const next = new Map(this.agents)
    next.delete(slotId)
    this.commit(next, 'removed')
    this.fire(this.removeListeners, { slotId, name }, 'onDidRemove')
  }

  /**
   * The list the daemon answered at connect time replaces what is known. The change listeners hear it (the answer arrives after
   * the app is up, so a listener that read the list before it, as the browser process's mirror does at its hello, would keep an
   * empty one: its agents alive in the slots, ended in the pad), but no exit is announced: a fresh connection ends nothing.
   */
  reset(slots: readonly SlotState[]): void {
    const next = new Map(slots.flatMap(s => { const a = agentInfoOf(s); return a ? [[s.slotId, a] as const] : [] }))
    const diff = diffAgents(this.list(), [...next.values()])
    this.agents = next
    for (const a of [...diff.added, ...diff.changed]) this.fire(this.changeListeners, a, 'onDidChange')
    for (const a of diff.removed) this.fire(this.changeListeners, { ...a, alive: false }, 'onDidChange')
  }

  /** The daemon connection closed: its agents are gone with it. */
  lost(): void {
    this.commit(new Map(), 'daemon-lost')
  }

  private commit(next: Map<string, AgentInfo>, reason: AgentExitReason): void {
    const diff = diffAgents(this.list(), [...next.values()])
    this.agents = next
    for (const a of [...diff.added, ...diff.changed, ...diff.removed.filter(r => !diff.exited.includes(r))]) this.fire(this.changeListeners, a, 'onDidChange')
    for (const a of diff.exited) {
      const gone = !next.has(a.slotId)
      const info = next.get(a.slotId) ?? { ...a, alive: false }
      if (gone) this.fire(this.changeListeners, info, 'onDidChange')
      this.fire(this.exitListeners, { ...info, reason: gone ? reason : 'exited' }, 'onDidExit')
    }
  }

  private fire<T>(set: Set<(x: T) => void>, x: T, what: string): void {
    for (const l of [...set]) { try { l(x) } catch (err) { console.error(`agents.${what}`, err) } }
  }
}
