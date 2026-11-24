// How the app names and draws each agent (F9 §4.8 AgentUi): the agent extensions register theirs (extensions/claude,
// extensions/soul) through TetherUi.agents; 'shell' is the core's. Pure (no DOM), so the rule modules (chooser, loading,
// situations) read it too. An agent with no AgentUi (its extension is off, or never installed) is still shown, under its
// own name, and its panes say "Agente indisponível" instead of disappearing.
import type { IDisposable } from '../shared/vscode-lifecycle.ts'
import { toDisposable } from '../shared/vscode-lifecycle.ts'

export interface AgentUi {
  /** The daemon's agent name (SlotMeta.agent): 'claude'. */
  name: string
  /** As a person reads it: 'Claude', 'soul'. */
  label: string
  /** An icon name of icons.ts (a string here: this module stays free of the SVG imports). */
  icon: string
  /** Aliases the chooser's search matches for this agent's profiles (folded, never shown). */
  keywords: readonly string[]
  /** The profile form's args placeholder. */
  argsPlaceholder: string
}

const uis = new Map<string, AgentUi>()

export function registerAgentUi(ui: AgentUi): IDisposable {
  if (ui.name === 'shell' || uis.has(ui.name)) throw new Error(`o agente ${ui.name} já tem descrição na interface`)
  uis.set(ui.name, ui)
  return toDisposable(() => { if (uis.get(ui.name) === ui) uis.delete(ui.name) })
}

export function agentUi(name: string): AgentUi | undefined {
  return uis.get(name)
}

/**
 * The engine of an agent kind as lists draw it: the icon name (icons.ts) and the name a person reads ("Soul", "Claude").
 * 'shell' is the terminal; a kind with no AgentUi keeps its own name and the terminal's icon.
 */
export function engineOf(kind: string): { icon: string; label: string } {
  if (kind === 'shell') return { icon: 'terminal-window', label: 'Shell' }
  const ui = uis.get(kind)
  return ui ? { icon: ui.icon, label: ui.label } : { icon: 'terminal-window', label: kind }
}

/** The agents the app can offer (registration order), without 'shell'. */
export function agentUiNames(): string[] {
  return [...uis.keys()]
}

/** A slot or profile of an agent the app has no description for: it is shown, but cannot run here. */
export function isAgentUnavailable(kind: string): boolean {
  return kind !== 'shell' && !uis.has(kind)
}

/**
 * A per-kind table read from the registry: 'shell' answers `shell`, a registered agent `of(ui)`, any other name
 * `fallback(name)`. Indexed like the fixed `Record<SlotKind, T>` tables it replaces.
 */
export function agentTable<T>(shell: T, of: (ui: AgentUi) => T, fallback: (name: string) => T): Record<string, T> {
  return new Proxy({} as Record<string, T>, {
    get: (_t, key) => {
      if (typeof key !== 'string') return undefined
      if (key === 'shell') return shell
      const ui = uis.get(key)
      return ui ? of(ui) : fallback(key)
    },
  })
}
