// The persisted layout (<home>/layout.json), pure and unit-tested:
//   v1  a single SerializedDockview (the whole app was one frame);
//   v2  desks → frames (a gridview of frames, each frame its own dockview) → panes. `drawer` is the quick desk
//        (same shape as a desk without name/colour; null in files written before it existed).
// Reading migrates v1 → v2 without touching the frame's dockview JSON (byte for byte the old file: the user's
// panes come back exactly). Pruning drops the panes the daemon no longer knows, frame by frame, and the frames
// that end up empty; a frame's root must stay a branch (dockview refuses a leaf there).
import type { SerializedDockview, SerializedGridviewComponent } from 'dockview-core'
import type { Direction } from './create.ts'
import { isSlotlessPanelId } from '../shared/empty.ts'
import { type DeskHue, DEFAULT_DESK_HUE, readDeskColor } from './desks.ts'

export const LAYOUT_VERSION = 2
export const FRAME_COMPONENT = 'frame'

/** The gridview JSON of a desk (frames as leaves), as dockview-core serializes it. */
export type FrameGrid = SerializedGridviewComponent['grid']
type GridNode = FrameGrid['root']
type GridLeaf = { type: 'leaf'; data: { id: string; component: string; [k: string]: unknown }; size?: number; visible?: boolean }
type GridBranch = { type: 'branch'; data: GridNode[]; size?: number; visible?: boolean }

export interface DeskLayout {
  id: string
  name: string
  /** The desk's hue name (palette.ts). Files from before the 12-hue palette hold a number: an index of the old 8 (`readDeskColor`). */
  color: DeskHue
  frames: { grid: FrameGrid; views: Record<string, SerializedDockview> }
  activeFrame?: string
}

/** The drawer's content: the frames of a desk, without the identity (the drawer is one, shared by all desks). */
export interface DrawerLayout {
  frames: DeskLayout['frames']
  activeFrame?: string
}

export interface LayoutV2 {
  v: 2
  desks: DeskLayout[]
  activeDesk: string
  /** null = never used (files from before the drawer): reads as an empty drawer (`migrateLayout`). */
  drawer: DrawerLayout | null
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)

/** A v1 file: dockview's own serialization (a grid with a root, and a panels map). */
export function isLayoutV1(raw: unknown): raw is SerializedDockview {
  return isObject(raw) && !('v' in raw) && isObject(raw.grid) && isObject(raw.grid.root) && isObject(raw.panels)
}

export function isLayoutV2(raw: unknown): raw is LayoutV2 {
  return isObject(raw) && raw.v === LAYOUT_VERSION && Array.isArray(raw.desks) && typeof raw.activeDesk === 'string'
}

/** A grid with a single frame filling the desk; sizes follow dockview's convention (root size = the orthogonal extent). */
export function singleFrameGrid(frameId: string, width: number, height: number): FrameGrid {
  return {
    root: { type: 'branch', data: [{ type: 'leaf', data: { id: frameId, component: FRAME_COMPONENT }, size: width }], size: height },
    width, height,
    orientation: 'HORIZONTAL' as FrameGrid['orientation'],
  }
}

/** A desk with one empty frame (a fresh app, or everything pruned). */
export function emptyDesk(id = 'desk-1', name = 'Mesa 1'): DeskLayout {
  const frameId = 'frame-1'
  return { id, name, color: DEFAULT_DESK_HUE, frames: { grid: singleFrameGrid(frameId, 1200, 800), views: {} }, activeFrame: frameId }
}

/** A drawer with one empty frame. */
export function emptyDrawer(): DrawerLayout {
  const d = emptyDesk('drawer', 'Gaveta')
  return { frames: d.frames, activeFrame: d.activeFrame }
}

export function isDrawerLayout(raw: unknown): raw is DrawerLayout {
  return isObject(raw) && isObject(raw.frames) && isObject(raw.frames.grid) && isObject(raw.frames.grid.root) && isObject(raw.frames.views)
}

/** The drawer of a layout; a missing or malformed one is an empty drawer. */
export function drawerOf(layout: Pick<LayoutV2, 'drawer'>): DrawerLayout {
  return isDrawerLayout(layout.drawer) ? layout.drawer : emptyDrawer()
}

export function emptyLayout(): LayoutV2 {
  const desk = emptyDesk()
  return { v: 2, desks: [desk], activeDesk: desk.id, drawer: emptyDrawer() }
}

/**
 * Every desk with its colour read as a hue name (a number is the old palette's index, anything unknown is blue).
 * The same array comes back when nothing needed reading, so an up-to-date file stays the very same object.
 */
export function readDeskColors(desks: readonly DeskLayout[]): DeskLayout[] {
  if (desks.every(d => readDeskColor(d.color) === d.color)) return desks as DeskLayout[]
  return desks.map(d => readDeskColor(d.color) === d.color ? d : { ...d, color: readDeskColor(d.color) })
}

/**
 * The layout in v2 form. A v1 file becomes "Mesa 1" with one frame whose view IS the old file; `migrated` says
 * the caller must keep a `layout.v1.bak` before the first v2 write. Anything else (empty, corrupt) is null.
 */
export function migrateLayout(raw: unknown): { layout: LayoutV2; migrated: boolean } | null {
  if (isLayoutV2(raw)) return { layout: { ...raw, desks: readDeskColors(raw.desks), drawer: drawerOf(raw) }, migrated: false }
  if (isLayoutV1(raw)) {
    const frameId = 'frame-1'
    const width = typeof raw.grid.width === 'number' && raw.grid.width > 0 ? raw.grid.width : 1200
    const height = typeof raw.grid.height === 'number' && raw.grid.height > 0 ? raw.grid.height : 800
    const desk: DeskLayout = { id: 'desk-1', name: 'Mesa 1', color: DEFAULT_DESK_HUE, frames: { grid: singleFrameGrid(frameId, width, height), views: { [frameId]: raw } }, activeFrame: frameId }
    return { layout: { v: 2, desks: [desk], activeDesk: desk.id, drawer: emptyDrawer() }, migrated: true }
  }
  return null
}

// ---------- pruning ----------

type DockNode = SerializedDockview['grid']['root']
type DockLeaf = { type: 'leaf'; data: { views: string[]; activeView?: string; id: string }; size?: number; visible?: boolean }

/** `root`: the grid root must stay a branch (dockview refuses a leaf there), even with a single child left. */
function pruneDock(node: DockNode, known: Set<string>, root = false): DockNode | null {
  if (node.type === 'leaf') {
    const leaf = node as DockLeaf
    const views = leaf.data.views.filter(v => known.has(v))
    if (views.length === 0) return null
    const activeView = leaf.data.activeView && views.includes(leaf.data.activeView) ? leaf.data.activeView : views[0]!
    return { ...leaf, data: { ...leaf.data, views, activeView } }
  }
  const children = (node.data as DockNode[]).map(c => pruneDock(c, known)).filter((c): c is DockNode => c !== null)
  if (children.length === 0) return null
  if (children.length === 1 && !root) return { ...children[0]!, ...(node.size !== undefined ? { size: node.size } : {}) }
  return { ...node, data: children }
}

/** A frame's dockview restricted to `known` panel ids, or null when nothing survives. */
export function pruneLayout(layout: SerializedDockview, known: Set<string>): SerializedDockview | null {
  const root = pruneDock(layout.grid.root, known, true)
  if (!root) return null
  const panels: SerializedDockview['panels'] = {}
  for (const [id, p] of Object.entries(layout.panels)) if (known.has(id)) panels[id] = p
  const groupIds = new Set<string>()
  const collect = (n: DockNode): void => {
    if (n.type === 'leaf') groupIds.add((n as DockLeaf).data.id)
    else for (const c of n.data as DockNode[]) collect(c)
  }
  collect(root)
  const out: SerializedDockview = { grid: { ...layout.grid, root }, panels }
  if (layout.activeGroup && groupIds.has(layout.activeGroup)) out.activeGroup = layout.activeGroup
  return out
}

export function panelIdsOf(layout: SerializedDockview): string[] {
  return Object.keys(layout.panels)
}

/** The frame ids in a grid, in reading order. */
export function frameIdsOf(grid: FrameGrid): string[] {
  const out: string[] = []
  const walk = (n: GridNode): void => {
    if (n.type === 'leaf') out.push((n as GridLeaf).data.id)
    else for (const c of (n as GridBranch).data) walk(c)
  }
  walk(grid.root)
  return out
}

/** Same collapse as the dockview prune: a leaf stays when `keep` says so; the root stays a branch. */
function pruneGrid(node: GridNode, keep: (frameId: string) => boolean, root = false): GridNode | null {
  if (node.type === 'leaf') return keep((node as GridLeaf).data.id) ? node : null
  const children = (node as GridBranch).data.map(c => pruneGrid(c, keep)).filter((c): c is GridNode => c !== null)
  if (children.length === 0) return null
  if (children.length === 1 && !root) return { ...children[0]!, ...(node.size !== undefined ? { size: node.size } : {}) }
  return { ...node, data: children }
}

/**
 * The desk restricted to `known` panel ids: every frame's dockview is pruned; a frame left without panels (or
 * without a view at all) is removed from the grid; when no frame survives, the desk is one empty frame.
 */
export function pruneDesk(desk: DeskLayout, known: Set<string>): DeskLayout {
  const views: Record<string, SerializedDockview> = {}
  for (const id of frameIdsOf(desk.frames.grid)) {
    const view = desk.frames.views[id]
    if (!view || !isLayoutV1(view)) continue
    const pruned = pruneLayout(view, known)
    if (pruned) views[id] = pruned
  }
  const root = pruneGrid(desk.frames.grid.root, id => id in views, true)
  if (!root) return { ...desk, frames: emptyDesk(desk.id, desk.name).frames, activeFrame: 'frame-1' }
  const grid: FrameGrid = { ...desk.frames.grid, root }
  const activeFrame = desk.activeFrame && desk.activeFrame in views ? desk.activeFrame : frameIdsOf(grid)[0]
  return { ...desk, frames: { grid, views }, activeFrame }
}

/** The drawer restricted to `known` panel ids (an empty result is an empty drawer). */
export function pruneDrawer(drawer: DrawerLayout, known: Set<string>): DrawerLayout {
  const d = pruneDesk({ id: 'drawer', name: 'Gaveta', color: DEFAULT_DESK_HUE, frames: drawer.frames, activeFrame: drawer.activeFrame }, known)
  return { frames: d.frames, ...(d.activeFrame ? { activeFrame: d.activeFrame } : {}) }
}

/** The panel ids of a set of frames' views. */
function viewIds(frames: DeskLayout['frames']): string[] {
  return Object.values(frames.views).flatMap(v => (isLayoutV1(v) ? panelIdsOf(v) : []))
}

/**
 * The layout restricted to `known` panel ids, desk by desk and then the drawer; `kept` = how many panels survived
 * in total. A pane lives in one place only: an id the desks hold is dropped from the drawer (a hand-edited or
 * half-written file must not mount one terminal twice).
 */
export function pruneLayoutV2(layout: LayoutV2, known: Set<string>): { layout: LayoutV2; kept: number; total: number } {
  const total = allPanelIds(layout).length
  const desks = layout.desks.map(d => pruneDesk(d, known))
  const activeDesk = desks.some(d => d.id === layout.activeDesk) ? layout.activeDesk : desks[0]!.id
  const inDesks = new Set(desks.flatMap(d => viewIds(d.frames)))
  const drawer = pruneDrawer(drawerOf(layout), new Set([...known].filter(id => !inDesks.has(id))))
  const pruned: LayoutV2 = { ...layout, desks, activeDesk, drawer }
  return { layout: pruned, kept: allPanelIds(pruned).length, total }
}

/** Every panel id in the layout, across desks, frames and the drawer. */
export function allPanelIds(layout: LayoutV2): string[] {
  const out: string[] = []
  for (const d of layout.desks) out.push(...viewIds(d.frames))
  if (isDrawerLayout(layout.drawer)) out.push(...viewIds(layout.drawer.frames))
  return out
}

// ---------- inserting a frame at a desk edge ----------

type Orientation = 'HORIZONTAL' | 'VERTICAL'
const orthogonal = (o: Orientation): Orientation => o === 'HORIZONTAL' ? 'VERTICAL' : 'HORIZONTAL'
const orientationOf = (d: Direction): Orientation => d === 'left' || d === 'right' ? 'HORIZONTAL' : 'VERTICAL'
const after = (d: Direction): boolean => d === 'right' || d === 'below'

/**
 * How to add a frame at a desk edge so it spans the whole desk (gridview's `addPanel` only knows "beside a
 * frame" or "at a location"): `location` is a gridview path; `wrapRoot` first puts the root inside a new
 * orthogonal branch (the same move dockview makes for its own edge drops); `beside` splits a lone frame.
 */
export type FrameInsertion =
  | { kind: 'location'; location: number[]; wrapRoot: boolean }
  | { kind: 'beside'; referenceFrame: string; direction: Direction }

export function frameInsertion(grid: FrameGrid, direction: Direction): FrameInsertion {
  const wanted = orientationOf(direction)
  const rootOrientation = grid.orientation as Orientation
  // Descend through single-child wrappers (a branch whose only child is a branch): the visible grid is the inner one.
  let node: GridNode = grid.root
  let path: number[] = []
  while (node.type === 'branch' && (node as GridBranch).data.length === 1 && (node as GridBranch).data[0]!.type === 'branch') {
    node = (node as GridBranch).data[0]!
    path = [...path, 0]
  }
  if (node.type === 'leaf') return { kind: 'beside', referenceFrame: (node as GridLeaf).data.id, direction }
  const children = (node as GridBranch).data
  const orientation = path.length % 2 === 0 ? rootOrientation : orthogonal(rootOrientation)
  if (children.length === 0) return { kind: 'location', location: [...path, 0], wrapRoot: false }
  if (orientation === wanted) return { kind: 'location', location: [...path, after(direction) ? children.length : 0], wrapRoot: false }
  if (children.length === 1) return { kind: 'beside', referenceFrame: (children[0] as GridLeaf).data.id, direction }
  // ≥ 2 frames laid out across the wanted axis: the new frame must sit beside all of them, as a sibling of this node.
  if (path.length > 0) {
    const parent = path.slice(0, -1)
    return { kind: 'location', location: [...parent, after(direction) ? 1 : 0], wrapRoot: false }
  }
  return { kind: 'location', location: [after(direction) ? 1 : 0], wrapRoot: true }
}

/** A frame id not used by the grid. */
export function nextFrameId(grid: FrameGrid): string {
  const used = new Set(frameIdsOf(grid))
  for (let i = 1; ; i++) if (!used.has(`frame-${i}`)) return `frame-${i}`
}

// ---------- restore policy ----------
// layout.json is the person's arrangement and the one file the app cannot rebuild. A slot the daemon does not
// list right now is not a change the person made: pruning is for display only and is never written back by the
// app; an empty (or failed) list is not trusted at all.

/**
 * Panel ids the daemon does not know, given what it answered. An empty list is never trusted: a daemon that
 * just came back (or a `list` that failed upstream) must not make the app drop every panel it is showing.
 * A note pane (app/shared/notes.ts) or an empty pane (app/shared/empty.ts) has no slot by design: never an orphan.
 */
export function orphanedPanels(panelIds: Iterable<string>, known: Set<string>): string[] {
  if (known.size === 0) return []
  return [...panelIds].filter(id => !known.has(id) && !isSlotlessPanelId(id))
}

/** `known` plus every slotless pane (notes, empty panes) of the layout: what pruning keeps. */
function knownWithSlotless(layout: LayoutV2, known: Set<string>): Set<string> {
  const out = new Set(known)
  for (const id of allPanelIds(layout)) if (isSlotlessPanelId(id)) out.add(id)
  return out
}

export interface RestorePlan {
  /** What to show (v2, a v1 file migrated); null when there is nothing restorable. */
  layout: LayoutV2 | null
  /** The file was v1 (the caller keeps a layout.v1.bak copy; the file itself is not rewritten for it). */
  migrated: boolean
  /** Panels left out of the display because the daemon does not know their slot. Never a reason to save. */
  orphaned: string[]
}

/**
 * Decides what the saved layout (v1 or v2) becomes on screen. Every pane known: the layout as read (the same
 * object). Some unknown: pruned desk by desk and frame by frame (pruneLayoutV2) for display, the input left
 * untouched. No known slot at all: shown untouched (each pane says "slot desconhecido" until the daemon knows it).
 */
export function planRestore(saved: unknown, known: Set<string>): RestorePlan {
  const read = migrateLayout(saved)
  if (!read) return { layout: null, migrated: false, orphaned: [] }
  const orphaned = orphanedPanels(allPanelIds(read.layout), known)
  // Nothing to prune: the saved v2 object itself (its `drawer` may be null; drawerOf reads that as empty).
  if (orphaned.length === 0) return { layout: isLayoutV2(saved) && read.layout.desks === saved.desks ? saved : read.layout, migrated: read.migrated, orphaned }
  return { layout: pruneLayoutV2(read.layout, knownWithSlotless(read.layout, known)).layout, migrated: read.migrated, orphaned }
}

/**
 * Layout-change reasons that come from the app, not the person: a pane's parameters (the loading hint kept in
 * step with the slot) and its title (the agent's session title). Alone they never schedule a save; they are
 * written along with the next change the person makes. No reasons (the desk's own frame removal) = a change.
 */
const APP_REASONS: ReadonlySet<string> = new Set(['panelParameters', 'panelTitle'])

export function isPersonChange(reasons: ReadonlySet<string> | undefined): boolean {
  if (!reasons || reasons.size === 0) return true
  for (const r of reasons) if (!APP_REASONS.has(r)) return true
  return false
}
