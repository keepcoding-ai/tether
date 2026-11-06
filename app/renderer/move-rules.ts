// The "Mover…" dialog's rules, pure (no DOM, no dockview objects): the destination tree built from the desks,
// their frames and the drawer (each frame with a mini-map of its real split layout), the search filter, which
// drop zones make sense for the thing being moved, the placement → move-op mapping the renderer executes, and
// the words of the summary line. app/renderer/move-dialog.ts draws it; app/renderer/main.ts runs the op.
import type { Direction } from './create.ts'
import type { DeskHue } from './desks.ts'

export type Edge = 'left' | 'right' | 'top' | 'bottom'
export type Zone = Edge | 'tab'
export type MoveMode = 'pane' | 'frame'
export const EDGES: readonly Edge[] = ['left', 'right', 'top', 'bottom']
export const DRAWER_SCOPE = 'drawer'

export interface MiniPane { id: string; title: string }
/** A frame's layout as drawn: a group is one dockview group (its tabs), a split lays children in a row or a column. */
export type MiniNode =
  | { kind: 'group'; id: string; size: number; panes: MiniPane[]; active?: string }
  | { kind: 'split'; dir: 'row' | 'column'; size: number; children: MiniNode[] }

export interface FrameModel { id: string; name: string; layout: MiniNode; panes: MiniPane[] }
/** The drawer or a desk: where a frame lives. */
export interface ScopeModel { id: string; kind: 'drawer' | 'pad' | 'desk'; name: string; color?: DeskHue; current: boolean; frames: FrameModel[]; /** A pad's icon (app/renderer/icons.ts). */ icon?: string }

/** What is being moved: a pane, which lives in a frame of a scope. */
export interface MoveSource { slotId: string; title: string; scope: string; frameId: string }

/** What the dialog chose: a scope (its edges: a new frame), or a frame (a group's zones, or the frame's sides). */
export interface Placement { scope: string; frameId?: string; group?: string; zone: Zone }

export type MoveOp =
  /** The pane next to (or as a tab of) `reference`'s group, in frame `frameId` of `scope`. */
  | { op: 'pane-beside'; slotId: string; from: string; scope: string; frameId: string; reference: string; direction: Direction | 'within' }
  /** The pane alone in a new frame at the scope's edge. */
  | { op: 'pane-new-frame'; slotId: string; from: string; scope: string; direction: Direction }
  /** The whole frame beside another frame of `scope`. */
  | { op: 'frame-beside'; frameId: string; from: string; scope: string; referenceFrame: string; direction: Direction }
  /** The whole frame at the scope's edge. */
  | { op: 'frame-new'; frameId: string; from: string; scope: string; direction: Direction }

export const EDGE_DIRECTION: Record<Edge, Direction> = { left: 'left', right: 'right', top: 'above', bottom: 'below' }

// ---------- the mini-map from a dockview frame's JSON ----------

/** The parts of dockview's serialized grid the mini-map reads (SerializedDockview['grid']). */
interface GridNodeJSON { type: 'branch' | 'leaf'; size?: number; data: unknown }
export interface FrameViewJSON {
  grid: { root: GridNodeJSON; orientation: string }
  panels: Record<string, { title?: string }>
}

/**
 * The frame's split layout: dockview's root orientation is the root branch's (HORIZONTAL = children side by side)
 * and each nested branch turns the other way. `titleOf` gives the live title (the JSON's may lag behind).
 */
export function miniLayout(view: FrameViewJSON, titleOf: (id: string) => string | undefined = () => undefined): MiniNode {
  const walk = (node: GridNodeJSON, row: boolean): MiniNode => {
    if (node.type === 'leaf') {
      const d = node.data as { id?: string; views?: string[]; activeView?: string }
      const panes = (d.views ?? []).map(id => ({ id, title: titleOf(id) ?? view.panels[id]?.title ?? id }))
      return { kind: 'group', id: d.id ?? panes[0]?.id ?? '?', size: node.size ?? 1, panes, ...(d.activeView ? { active: d.activeView } : {}) }
    }
    const children = (node.data as GridNodeJSON[]).map(c => walk(c, !row)).filter(c => paneCount(c) > 0)
    return { kind: 'split', dir: row ? 'row' : 'column', size: node.size ?? 1, children }
  }
  return walk(view.grid.root, view.grid.orientation === 'HORIZONTAL')
}

function paneCount(n: MiniNode): number {
  return n.kind === 'group' ? n.panes.length : n.children.reduce((s, c) => s + paneCount(c), 0)
}

export function groupsOf(n: MiniNode): Extract<MiniNode, { kind: 'group' }>[] {
  return n.kind === 'group' ? [n] : n.children.flatMap(groupsOf)
}

export function panesOfLayout(n: MiniNode): MiniPane[] {
  return groupsOf(n).flatMap(g => g.panes)
}

// ---------- the tree ----------

export interface TreeInput {
  drawer: { frames: { id: string; view: FrameViewJSON }[] }
  /** The frames pads offered as destinations (the current desk's desk pad, the global pad). */
  pads?: { id: string; name: string; icon: string; frames: { id: string; view: FrameViewJSON }[] }[]
  desks: { id: string; name: string; color: DeskHue; frames: { id: string; view: FrameViewJSON }[] }[]
  /** The desk the user is on (the drawer is never "atual"). */
  currentDesk: string
  titleOf?: (id: string) => string | undefined
}

/** The drawer first, then the pads, then the desks in their order; frames named "Quadro N" by their place in the desk. */
export function buildTree(input: TreeInput): ScopeModel[] {
  const frames = (list: TreeInput['drawer']['frames']): FrameModel[] => list.map((f, i) => {
    const layout = miniLayout(f.view, input.titleOf)
    return { id: f.id, name: `Quadro ${i + 1}`, layout, panes: panesOfLayout(layout) }
  }).filter(f => f.panes.length > 0) // an empty desk's placeholder frame is no destination: the desk's edges are
  return [
    { id: DRAWER_SCOPE, kind: 'drawer', name: 'Gaveta', current: false, frames: frames(input.drawer.frames) },
    ...(input.pads ?? []).map(p => ({ id: p.id, kind: 'pad' as const, name: p.name, icon: p.icon, current: false, frames: frames(p.frames) })),
    ...input.desks.map(d => ({ id: d.id, kind: 'desk' as const, name: d.name, color: d.color, current: d.id === input.currentDesk, frames: frames(d.frames) })),
  ]
}

/** Case- and accent-insensitive text for the search. */
export function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

export type TreeRow =
  | { kind: 'scope'; scope: ScopeModel; open: boolean }
  | { kind: 'frame'; scope: ScopeModel; frame: FrameModel; matches: MiniPane[] }

/**
 * The rows on screen. Without a query: every scope, and the frames of the open ones. With one: a scope stays when its
 * name, a frame's name or a pane's title matches; a matching scope shows all its frames, else only the matching
 * frames (or the frames holding a matching pane, which are listed under it); every scope shown is open.
 */
export function visibleRows(scopes: readonly ScopeModel[], query: string, open: ReadonlySet<string>): TreeRow[] {
  const q = fold(query.trim())
  const rows: TreeRow[] = []
  for (const scope of scopes) {
    if (!q) {
      const isOpen = open.has(scope.id)
      rows.push({ kind: 'scope', scope, open: isOpen })
      if (isOpen) for (const frame of scope.frames) rows.push({ kind: 'frame', scope, frame, matches: [] })
      continue
    }
    const scopeHit = fold(scope.name).includes(q)
    const frames = scope.frames.map(frame => ({ frame, frameHit: fold(frame.name).includes(q), matches: frame.panes.filter(p => fold(p.title).includes(q)) }))
      .filter(x => scopeHit || x.frameHit || x.matches.length > 0)
    if (!scopeHit && frames.length === 0) continue
    rows.push({ kind: 'scope', scope, open: true })
    for (const x of frames) rows.push({ kind: 'frame', scope, frame: x.frame, matches: x.matches })
  }
  return rows
}

/** Where a query hits a text (for the highlight): [start, end) in the original string, or undefined. */
export function matchRange(text: string, query: string): [number, number] | undefined {
  const q = fold(query.trim())
  if (!q) return undefined
  // fold() may change lengths (decomposed accents are dropped, so the folded text has one char per original char
  // for Latin text); find on the folded text and map back by walking the original.
  const folded = [...text].map(c => fold(c))
  const joined = folded.join('')
  const at = joined.indexOf(q)
  if (at < 0) return undefined
  let pos = 0, start = -1, end = -1, i = 0
  for (const piece of folded) {
    if (start < 0 && pos + piece.length > at) start = i
    pos += piece.length
    i++
    if (pos >= at + q.length) { end = i; break }
  }
  return start < 0 ? undefined : [start, end < 0 ? text.length : end]
}

// ---------- the zones ----------

export function findScope(scopes: readonly ScopeModel[], id: string): ScopeModel | undefined {
  return scopes.find(s => s.id === id)
}

export function findFrame(scopes: readonly ScopeModel[], scope: string, frameId: string | undefined): FrameModel | undefined {
  return frameId ? findScope(scopes, scope)?.frames.find(f => f.id === frameId) : undefined
}

/**
 * Whether a zone can be chosen. Pane mode, on a frame: every group's five zones, except "Como aba" on the source's own
 * group, and the edges of a group that is the source alone (that would leave it where it is). Frame mode, on a frame:
 * only the frame's sides ("ao lado do quadro"), never on the source frame itself; "Como aba" never. On a scope: the
 * four edges (a new frame), except the source frame at the edge of its own scope when it is the only frame there.
 */
export function zoneAllowed(scopes: readonly ScopeModel[], mode: MoveMode, source: MoveSource, p: Placement): boolean {
  const scope = findScope(scopes, p.scope)
  if (!scope) return false
  if (!p.frameId) {
    if (p.zone === 'tab') return false
    if (mode === 'frame' && p.scope === source.scope && scope.frames.length <= 1) return false
    return true
  }
  const frame = findFrame(scopes, p.scope, p.frameId)
  if (!frame) return false
  if (mode === 'frame') return p.zone !== 'tab' && p.group === undefined && !(p.scope === source.scope && p.frameId === source.frameId)
  const group = groupsOf(frame.layout).find(g => g.id === p.group)
  if (!group) return false
  const hasSource = group.panes.some(x => x.id === source.slotId)
  if (p.zone === 'tab') return !hasSource
  return !(hasSource && group.panes.length === 1)
}

/** The move to run for a placement (undefined when the zone is not allowed). */
export function moveOpOf(scopes: readonly ScopeModel[], mode: MoveMode, source: MoveSource, p: Placement): MoveOp | undefined {
  if (!zoneAllowed(scopes, mode, source, p)) return undefined
  if (mode === 'frame') {
    const direction = EDGE_DIRECTION[p.zone as Edge]
    return p.frameId
      ? { op: 'frame-beside', frameId: source.frameId, from: source.scope, scope: p.scope, referenceFrame: p.frameId, direction }
      : { op: 'frame-new', frameId: source.frameId, from: source.scope, scope: p.scope, direction }
  }
  if (!p.frameId) return { op: 'pane-new-frame', slotId: source.slotId, from: source.scope, scope: p.scope, direction: EDGE_DIRECTION[p.zone as Edge] }
  const group = groupsOf(findFrame(scopes, p.scope, p.frameId)!.layout).find(g => g.id === p.group)!
  // The group is named through one of its panes that is not the source (the source leaves before the add).
  const reference = (group.panes.find(x => x.id === group.active && x.id !== source.slotId) ?? group.panes.find(x => x.id !== source.slotId))!.id
  return { op: 'pane-beside', slotId: source.slotId, from: source.scope, scope: p.scope, frameId: p.frameId, reference, direction: p.zone === 'tab' ? 'within' : EDGE_DIRECTION[p.zone] }
}

// ---------- words ----------

export const ZONE_LABEL: Record<Zone, string> = { tab: 'Como aba', left: 'À esquerda', right: 'À direita', top: 'Acima', bottom: 'Abaixo' }
export const NEW_FRAME_ZONE: Record<Edge, string> = { left: 'Novo quadro à esquerda', right: 'Novo quadro à direita', top: 'Novo quadro acima', bottom: 'Novo quadro abaixo' }
export const SIDE_ZONE: Record<Edge, string> = { left: 'Quadro à esquerda', right: 'Quadro à direita', top: 'Quadro acima', bottom: 'Quadro abaixo' }
export const BESIDE_ZONE: Record<Edge, string> = { left: 'À esquerda do quadro', right: 'À direita do quadro', top: 'Acima do quadro', bottom: 'Abaixo do quadro' }

/** The label of a zone where it is drawn (a group's zone, a frame's side in frame mode, a scope's edge). */
export function zoneLabel(mode: MoveMode, onFrame: boolean, zone: Zone): string {
  if (zone === 'tab') return ZONE_LABEL.tab
  if (!onFrame) return (mode === 'pane' ? NEW_FRAME_ZONE : SIDE_ZONE)[zone]
  return mode === 'frame' ? BESIDE_ZONE[zone] : ZONE_LABEL[zone]
}

export const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/**
 * The summary line, as pieces the dialog styles: "<subject> → <scope> › <frame> (<pane>), <zone>[ de a mesa]".
 * Without a zone, the tail invites to choose one.
 */
export function summaryOf(scopes: readonly ScopeModel[], mode: MoveMode, source: MoveSource, p: { scope: string; frameId?: string; group?: string; zone?: Zone }): { subject: string; scope: string; where: string; zone: string | undefined; tail: string } {
  const srcScope = findScope(scopes, source.scope)
  const srcFrame = findFrame(scopes, source.scope, source.frameId)
  const subject = mode === 'pane' ? source.title : `${srcScope?.name ?? ''} › ${srcFrame?.name ?? 'Quadro'}`
  const scope = findScope(scopes, p.scope)
  const frame = findFrame(scopes, p.scope, p.frameId)
  let where = frame ? ` › ${frame.name}` : ''
  if (frame && mode === 'pane' && p.group && frame.panes.length > 1) {
    const g = groupsOf(frame.layout).find(x => x.id === p.group)
    const name = g?.panes.find(x => x.id === g.active)?.title ?? g?.panes[0]?.title
    if (name) where += ` (${name})`
  }
  if (!p.zone) return { subject, scope: scope?.name ?? '', where, zone: undefined, tail: 'escolha uma zona' }
  const label = zoneLabel(mode, !!frame, p.zone)
  const zone = label.charAt(0).toLowerCase() + label.slice(1)
  const tail = frame ? '' : scope?.kind === 'drawer' ? ' da gaveta' : scope?.kind === 'pad' ? ' da prancheta' : ' da mesa'
  return { subject, scope: scope?.name ?? '', where, zone, tail }
}
