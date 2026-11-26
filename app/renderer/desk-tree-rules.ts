// The tree of desks and panes an extension may read (`TetherUi.desks.tree`), as pure rules (no DOM, unit-tested):
// main.ts gathers the sources (the desk set, the drawer, the seals, the slots) and this file puts them in order and
// shape. The order is fixed: the queue desks as the queue has them, then the system desks as they were declared, then
// the drawer. The signature tells whether the tree changed, so the extensions hear only an actual change.
import type { DeskTree, TreeDesk, TreePane } from './ext-api.ts'

/** What main.ts knows of one pane; absent flags are left out of the tree. */
export interface TreePaneFacts {
  type: string
  icon: string
  title: string
  /** The terminal's attention merged with the extensions' seals (`paneAttention`). */
  attention?: 'done' | 'waiting'
  /** What the seal says (`attentionLines`): the terminal's line and the extensions' messages. */
  lines?: readonly string[]
  busy?: boolean
  asleep?: boolean
  exited?: boolean
}

/** One desk with the ids of the panes it holds, in the order the tree shows them. */
export interface TreeDeskSource {
  id: string
  name: string
  color: string
  asleep?: boolean
  icon?: string
  panes: readonly string[]
}

export interface DeskTreeInput {
  queue: readonly TreeDeskSource[]
  system: readonly TreeDeskSource[]
  drawer?: TreeDeskSource
  /** The facts of a pane by id; `undefined` leaves the pane out (it is gone). */
  pane(id: string): TreePaneFacts | undefined
  /** Desks to leave out (the caller's own: a desk shows what it holds, not itself). */
  skip?: readonly string[]
}

/** A pane of the tree: the flags that are set, the others absent (so a quiet pane's signature is short and stable). */
export function treePaneOf(id: string, f: TreePaneFacts): TreePane {
  const out: TreePane = { id, type: f.type, icon: f.icon, title: f.title }
  if (f.attention) out.attention = f.attention
  if (f.lines && f.lines.length) out.lines = [...f.lines]
  if (f.busy) out.busy = true
  if (f.asleep) out.asleep = true
  if (f.exited) out.exited = true
  return out
}

function deskOf(src: TreeDeskSource, kind: TreeDesk['kind'], input: DeskTreeInput): TreeDesk {
  const panes: TreePane[] = []
  for (const id of src.panes) {
    const f = input.pane(id)
    if (f) panes.push(treePaneOf(id, f))
  }
  return { id: src.id, name: src.name, color: src.color, kind, asleep: src.asleep === true, ...(src.icon ? { icon: src.icon } : {}), panes }
}

/** The tree: queue desks, then system desks, then the drawer. */
export function deskTreeOf(input: DeskTreeInput): DeskTree {
  const skip = new Set(input.skip ?? [])
  const desks: TreeDesk[] = []
  for (const d of input.queue) if (!skip.has(d.id)) desks.push(deskOf(d, 'queue', input))
  for (const d of input.system) if (!skip.has(d.id)) desks.push(deskOf(d, 'system', input))
  if (input.drawer && !skip.has(input.drawer.id)) desks.push(deskOf(input.drawer, 'drawer', input))
  return { desks }
}

/** Equal trees have equal signatures (the objects are built in a fixed key order). */
export function treeSignature(tree: DeskTree): string {
  return JSON.stringify(tree)
}
