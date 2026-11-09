// What an extension may know about an AI agent's slot, on both hosts (TetherUi.agents, TetherMain.agents). Pure: it maps the
// daemon's SlotState (the one source of truth, keyed by `slotId`) to a small read-only view, and diffs two snapshots. The
// slot id is minted by the daemon (SlotMeta.slotId, persisted in <home>/slots), so it is the same in the daemon, in main and
// in the renderer (a pane's id is its slot id), and survives an app or daemon restart.
import type { SlotState } from '../../src/daemon/protocol.ts'

export interface AgentProfile { id: string; name: string }

/** The part of an agent every host can answer. */
export interface AgentInfo {
  slotId: string
  /** The agent's kind ('claude', 'soul'…); never 'shell'. */
  kind: string
  /** The short name the pane's tab shows: the slot's name, else its session title, else its folder's name. */
  name: string
  profile?: AgentProfile
  /** A process runs (or is about to: queued, starting). False once it exited, failed or waits for the person's choice. */
  alive: boolean
}

export function folderNameOf(cwd: string): string {
  const parts = cwd.replace(/[\/]+$/, '').split(/[\/]/)
  return parts[parts.length - 1] || cwd
}

/** The slot has a process (or is about to get one). */
export function slotIsLive(s: Pick<SlotState, 'status'>): boolean {
  return s.status === 'running' || s.status === 'starting' || s.status === 'queued'
}

/** The text a pane's tab shows for the slot. */
export function slotTitle(s: Pick<SlotState, 'name' | 'title' | 'cwd'>): string {
  return s.name ?? s.title ?? folderNameOf(s.cwd)
}

/** The agent behind a slot; undefined for a plain shell. */
export function agentInfoOf(s: SlotState): AgentInfo | undefined {
  if (s.kind === 'shell') return undefined
  const profile = s.profileId ? { id: s.profileId, name: s.profileName ?? s.profileId } : undefined
  return { slotId: s.slotId, kind: s.kind, name: slotTitle(s), ...(profile ? { profile } : {}), alive: slotIsLive(s) }
}

export interface AgentDiff<T extends { slotId: string; alive: boolean }> {
  added: T[]
  removed: T[]
  /** Present in both with any field different (renamed, moved, recoloured…), including the ones that exited. */
  changed: T[]
  /** Was alive before and is not now: gone from the snapshot or no longer alive. */
  exited: T[]
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/** Compares two snapshots by `slotId`. Field order inside an item is the builder's, so it is stable. */
export function diffAgents<T extends { slotId: string; alive: boolean }>(before: readonly T[], after: readonly T[]): AgentDiff<T> {
  const prev = new Map(before.map(a => [a.slotId, a]))
  const next = new Map(after.map(a => [a.slotId, a]))
  const out: AgentDiff<T> = { added: [], removed: [], changed: [], exited: [] }
  for (const a of after) {
    const p = prev.get(a.slotId)
    if (!p) { out.added.push(a); continue }
    if (!same(p, a)) out.changed.push(a)
    if (p.alive && !a.alive) out.exited.push(a)
  }
  for (const p of before) if (!next.has(p.slotId)) { out.removed.push(p); if (p.alive) out.exited.push(p) }
  return out
}
