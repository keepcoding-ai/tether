// What a pane of an AI agent is called when the person never named it: "Claude · <folder>". One rule for every reader that
// has to say which pane it means: the Tether Bridge's client name (extensions/web-bridge/agents.ts) and the author of what
// an agent writes through the CLI (src/cli/faults.ts). Pure; the slot's own name, when set, always wins.
import { basename } from 'node:path'
import type { SlotMeta } from './event.ts'

/** The Tether Bridge's own limit for a client name (chrome-extensions/bridge/shared/protocol.ts: CLIENT_NAME_MAX). */
export const PANE_NAME_MAX = 80

/** "Claude · <slot name>" or "Claude · <folder name>", cut at `max` characters. */
export function paneDisplayName(agent: string, slot: Pick<SlotMeta, 'name' | 'cwd'>, max: number = PANE_NAME_MAX): string {
  const who = agent.charAt(0).toUpperCase() + agent.slice(1)
  const where = slot.name?.trim() || basename(slot.cwd.replace(/[\/]+$/, '')) || slot.cwd
  const name = `${who} · ${where}`
  return name.length > max ? `${name.slice(0, max - 1)}…` : name
}

/** Who a write by the agent of this pane is attributed to: the pane's name when it has one, else its display name. */
export function paneAuthor(slot: Pick<SlotMeta, 'agent' | 'name' | 'cwd'>): string {
  return slot.name?.trim() || paneDisplayName(slot.agent, slot)
}
