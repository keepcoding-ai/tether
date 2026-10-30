// Layout persistence helpers: drop panels the daemon does not know from a saved dockview layout,
// collapsing the grid so dockview can restore what is left.
import type { SerializedDockview } from 'dockview-core'

type Node = SerializedDockview['grid']['root']
type Leaf = { type: 'leaf'; data: { views: string[]; activeView?: string; id: string }; size?: number; visible?: boolean }

/** `root`: the grid root must stay a branch (dockview refuses a leaf there), even with a single child left. */
function prune(node: Node, known: Set<string>, root = false): Node | null {
  if (node.type === 'leaf') {
    const leaf = node as Leaf
    const views = leaf.data.views.filter(v => known.has(v))
    if (views.length === 0) return null
    const activeView = leaf.data.activeView && views.includes(leaf.data.activeView) ? leaf.data.activeView : views[0]!
    return { ...leaf, data: { ...leaf.data, views, activeView } }
  }
  const children = (node.data as Node[]).map(c => prune(c, known)).filter((c): c is Node => c !== null)
  if (children.length === 0) return null
  if (children.length === 1 && !root) return { ...children[0]!, ...(node.size !== undefined ? { size: node.size } : {}) }
  return { ...node, data: children }
}

/** Returns the layout restricted to `known` panel ids, or null when nothing survives. */
export function pruneLayout(layout: SerializedDockview, known: Set<string>): SerializedDockview | null {
  const root = prune(layout.grid.root, known, true)
  if (!root) return null
  const panels: SerializedDockview['panels'] = {}
  for (const [id, p] of Object.entries(layout.panels)) if (known.has(id)) panels[id] = p
  const groupIds = new Set<string>()
  const collect = (n: Node): void => {
    if (n.type === 'leaf') groupIds.add((n as Leaf).data.id)
    else for (const c of n.data as Node[]) collect(c)
  }
  collect(root)
  const out: SerializedDockview = { grid: { ...layout.grid, root }, panels }
  if (layout.activeGroup && groupIds.has(layout.activeGroup)) out.activeGroup = layout.activeGroup
  return out
}

export function panelIdsOf(layout: SerializedDockview): string[] {
  return Object.keys(layout.panels)
}

/**
 * Panel ids the daemon does not know, given what it answered. An empty list is never trusted: a daemon that
 * just came back (or a `list` that failed upstream) must not make the app drop every panel it is showing.
 */
export function orphanedPanels(panelIds: Iterable<string>, known: Set<string>): string[] {
  if (known.size === 0) return []
  return [...panelIds].filter(id => !known.has(id))
}

export interface RestorePlan {
  /** What to show; null when there is nothing restorable. */
  layout: SerializedDockview | null
  /** Panels left out of the display because the daemon does not know their slot. Never a reason to save. */
  orphaned: string[]
}

/**
 * Decides what the saved layout becomes on screen. Pruning is for display only: a slot the daemon does not
 * list right now is not a change the person made, so nothing here is ever written back. With no known slots
 * at all the layout is shown untouched (each panel renders as "slot desconhecido" until the daemon knows it).
 */
export function planRestore(saved: unknown, known: Set<string>): RestorePlan {
  if (!isSerializedLayout(saved)) return { layout: null, orphaned: [] }
  const orphaned = orphanedPanels(panelIdsOf(saved), known)
  if (orphaned.length === 0) return { layout: saved, orphaned }
  return { layout: pruneLayout(saved, known), orphaned }
}

export function isSerializedLayout(x: unknown): x is SerializedDockview {
  if (typeof x !== 'object' || x === null) return false
  const l = x as Partial<SerializedDockview>
  return typeof l.grid === 'object' && l.grid !== null && typeof l.grid.root === 'object' && typeof l.panels === 'object' && l.panels !== null
}
