// Layout persistence helpers: drop panels the daemon does not know from a saved dockview layout,
// collapsing the grid so dockview can restore what is left.
import type { SerializedDockview } from 'dockview-core'

type Node = SerializedDockview['grid']['root']
type Leaf = { type: 'leaf'; data: { views: string[]; activeView?: string; id: string }; size?: number; visible?: boolean }

function prune(node: Node, known: Set<string>): Node | null {
  if (node.type === 'leaf') {
    const leaf = node as Leaf
    const views = leaf.data.views.filter(v => known.has(v))
    if (views.length === 0) return null
    const activeView = leaf.data.activeView && views.includes(leaf.data.activeView) ? leaf.data.activeView : views[0]!
    return { ...leaf, data: { ...leaf.data, views, activeView } }
  }
  const children = (node.data as Node[]).map(c => prune(c, known)).filter((c): c is Node => c !== null)
  if (children.length === 0) return null
  if (children.length === 1) return { ...children[0]!, ...(node.size !== undefined ? { size: node.size } : {}) }
  return { ...node, data: children }
}

/** Returns the layout restricted to `known` panel ids, or null when nothing survives. */
export function pruneLayout(layout: SerializedDockview, known: Set<string>): SerializedDockview | null {
  const root = prune(layout.grid.root, known)
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
