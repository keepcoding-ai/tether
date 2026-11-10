// The frames of the panel pad ("prancheta do painel"), as pure rules: no DOM, unit-tested. The core (main.ts) feeds them
// what it has (every saved frame of the panel pad, the live panels, the desks) and the panel-pad-manager extension draws
// the result.
//
// Vocabulary: the panel pad has one frame ("quadro") per focusable panel, and a frame holds panes of any kind (a note, a
// terminal, an agent, a browser tab). A frame is "loose" ("solto") when its panel is gone (closed); it is "empty" when
// every pane it holds is an empty pane (the blank view the pad is seeded with). The desk pad and the global pad are other
// pads and not looked after here. The manager's item is the PANEL (the frame's content only tells which panel it is), and
// it works one desk at a time: `forDesk`.
//
// Each frame may carry a small record (`PanelFrameMeta`) written while its panel lives: the panel's label and desk, and
// when its content last changed. A loose frame keeps it, so the manager can still say "antes em <painel>".
import type { SerializedDockview } from 'dockview-core'
import { EMPTY_COMPONENT } from '../shared/empty.ts'
import { noteParams } from '../shared/notes.ts'
import { isDrawerLayout, isLayoutV1, type DrawerLayout } from './layout.ts'

/** What the core keeps per frame key while the panel lives (layout.json `sidebars.meta`). */
export interface PanelFrameMeta {
  /** The panel's name as its tab showed it. */
  ownerLabel: string
  /** The desk the panel lived in. */
  deskId?: string
  /** When the frame's content last changed (ms since epoch). */
  updatedAt: number
}

/** One frame as the core hands it in: its key, its pad, the panel it belongs to and its saved state. */
export interface FrameSource {
  key: string
  padId: string
  panelId: string
  state: unknown
}

/** A pane of a frame, as the manager lists it. */
export interface FramePane {
  id: string
  title: string
  component: string
  /** The file a note pane shows. */
  file?: string
  /** The address a browser pane shows. */
  url?: string
}

export interface PanelFrameRow {
  key: string
  padId: string
  panelId: string
  /** The panel's name now (alive) or as last recorded (loose); '' when never recorded. */
  label: string
  deskId?: string
  loose: boolean
  empty: boolean
  panes: FramePane[]
  /** The panes that are not empty panes. */
  tabs: number
  /** The first real pane's title, or '' for an empty frame. */
  title: string
  updatedAt?: number
  /** The panel the Foco de Mesa is on owns it. */
  focused: boolean
}

export interface FrameDeskGroup {
  id: string
  name: string
  panels: PanelFrameRow[]
}

export interface PanelFrameTree {
  /** The desk on screen: the manager shows this desk's panels and loose frames (`forDesk`). */
  activeDeskId: string
  /** The frames whose panel is gone: content before empty, most recent first. */
  loose: PanelFrameRow[]
  /** Each desk (desk order) with the frames of its live panels. */
  desks: FrameDeskGroup[]
  /** The frames of live panels outside every desk (the drawer, a pad). */
  elsewhere: PanelFrameRow[]
}

export interface PanelFrameTreeInput {
  sources: readonly FrameSource[]
  meta: Readonly<Record<string, PanelFrameMeta>>
  desks: readonly { id: string; name: string }[]
  /** The panels alive now (anywhere in the window): their label and desk. */
  livePanels: ReadonlyMap<string, { label: string; deskId?: string }>
  focusedPanel?: string
  activeDeskId: string
}

export type FrameFilter = 'loose' | 'all'

/** The panes of a saved frame state (frames → views → panels), in view order. */
export function panesOf(state: unknown): FramePane[] {
  if (!isDrawerLayout(state)) return []
  const out: FramePane[] = []
  for (const view of Object.values(state.frames.views)) {
    if (!isLayoutV1(view)) continue
    for (const [id, p] of Object.entries(view.panels)) {
      const file = noteParams(p.params)?.path
      const url = typeof (p.params as Record<string, unknown> | undefined)?.url === 'string' ? (p.params as Record<string, string>).url : undefined
      out.push({ id, title: p.title ?? id, component: p.contentComponent ?? 'terminal', ...(file ? { file } : {}), ...(url ? { url } : {}) })
    }
  }
  return out
}

/** A frame has content when one of its panes is not an empty pane. */
export function hasContent(state: unknown): boolean {
  return panesOf(state).some(p => p.component !== EMPTY_COMPONENT)
}

function row(src: FrameSource, input: PanelFrameTreeInput): PanelFrameRow {
  const panes = panesOf(src.state)
  const real = panes.filter(p => p.component !== EMPTY_COMPONENT)
  const meta = input.meta[src.key]
  const live = input.livePanels.get(src.panelId)
  const label = live?.label ?? meta?.ownerLabel ?? ''
  const deskId = live ? live.deskId : meta?.deskId
  return {
    key: src.key, padId: src.padId, panelId: src.panelId, label, ...(deskId ? { deskId } : {}), loose: !live, empty: real.length === 0,
    panes, tabs: real.length, title: real[0]?.title ?? '', ...(meta ? { updatedAt: meta.updatedAt } : {}),
    focused: src.panelId === input.focusedPanel,
  }
}

/** Most recent first; never-recorded ones last, in their given order. */
const byRecent = (a: PanelFrameRow, b: PanelFrameRow): number => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)

/**
 * The map the manager shows: the loose frames first (with content before empty, most recent first), then each desk with
 * the frames of its panels (desk order), then the frames of panels outside every desk.
 */
export function buildFrameTree(input: PanelFrameTreeInput): PanelFrameTree {
  const rows = input.sources.map(s => row(s, input))
  const loose = rows.filter(r => r.loose).sort((a, b) => Number(a.empty) - Number(b.empty) || byRecent(a, b))
  const desks = input.desks.map((d): FrameDeskGroup => ({ id: d.id, name: d.name, panels: rows.filter(r => !r.loose && r.deskId === d.id) }))
  const elsewhere = rows.filter(r => !r.loose && !input.desks.some(d => d.id === r.deskId))
  return { activeDeskId: input.activeDeskId, loose, desks, elsewhere }
}

/** Every row of a tree, in tree order. */
export function allRows(tree: PanelFrameTree): PanelFrameRow[] {
  return [...tree.loose, ...tree.desks.flatMap(d => d.panels), ...tree.elsewhere]
}

/**
 * One desk's share of the tree (what the manager shows: the desk on screen): the loose frames whose panel lived in that
 * desk (a loose frame keeps its desk in its record; one never recorded has no desk and shows in every desk, so it is
 * never lost), then the frames of the desk's live panels.
 */
export function forDesk(tree: PanelFrameTree, deskId: string): { loose: PanelFrameRow[]; panels: PanelFrameRow[] } {
  return { loose: tree.loose.filter(r => !r.deskId || r.deskId === deskId), panels: tree.desks.find(d => d.id === deskId)?.panels ?? [] }
}

/** The rows a filter shows for a desk, in order. A live panel's empty frame (the blank a pad starts with) is not listed: nothing to look after. */
export function visibleRows(tree: PanelFrameTree, filter: FrameFilter, deskId: string = tree.activeDeskId): PanelFrameRow[] {
  const d = forDesk(tree, deskId)
  if (filter === 'loose') return d.loose
  return [...d.loose, ...d.panels.filter(r => !r.empty)]
}

/** How many loose frames have content (the warning dot) and how many frames have content at all. */
export function frameCounts(tree: PanelFrameTree): { loose: number; looseEmpty: number; withContent: number } {
  return { loose: tree.loose.filter(r => !r.empty).length, looseEmpty: tree.loose.filter(r => r.empty).length, withContent: allRows(tree).filter(r => !r.empty).length }
}

/** The keys "Limpar vazios" (and the automatic clean-up) removes: the loose frames with nothing in them. */
export function emptyLooseKeys(tree: PanelFrameTree): string[] {
  return tree.loose.filter(r => r.empty).map(r => r.key)
}

// ---------- operations on the stored frames ----------

/** The frames as stored: state and record per key. */
export interface FrameStore {
  pads: Readonly<Record<string, unknown>>
  meta: Readonly<Record<string, PanelFrameMeta>>
}

/** What an operation changed, to undo it: each touched key's state and record before it (undefined = absent). */
export interface FrameSnapshot {
  entries: { key: string; state: unknown; meta: PanelFrameMeta | undefined }[]
}

function snapshotOf(store: FrameStore, keys: readonly string[]): FrameSnapshot {
  return { entries: [...new Set(keys)].map(key => ({ key, state: store.pads[key], meta: store.meta[key] })) }
}

function without<T>(rec: Readonly<Record<string, T>>, keys: readonly string[]): Record<string, T> {
  const out = { ...rec }
  for (const k of keys) delete out[k]
  return out
}

/** Closes frames: their states and records go; the snapshot brings them back. */
export function closeFrames(store: FrameStore, keys: readonly string[]): { store: FrameStore; undo: FrameSnapshot } {
  const present = keys.filter(k => k in store.pads || k in store.meta)
  return { store: { pads: without(store.pads, present), meta: without(store.meta, present) }, undo: snapshotOf(store, present) }
}

/** Puts back what a snapshot recorded (an absent entry is removed again). */
export function restoreFrames(store: FrameStore, snap: FrameSnapshot): FrameStore {
  const pads: Record<string, unknown> = { ...store.pads }
  const meta: Record<string, PanelFrameMeta> = { ...store.meta }
  for (const e of snap.entries) {
    if (e.state === undefined) delete pads[e.key]; else pads[e.key] = e.state
    if (e.meta === undefined) delete meta[e.key]; else meta[e.key] = e.meta
  }
  return { pads, meta }
}

/** "Limpar vazios": closes every loose frame with nothing in it. */
export function cleanEmptyFrames(store: FrameStore, tree: PanelFrameTree): { store: FrameStore; undo: FrameSnapshot; keys: string[] } {
  const keys = emptyLooseKeys(tree)
  return { ...closeFrames(store, keys), keys }
}

/** The records with only the keys that still have a frame state. */
export function pruneMeta(meta: Readonly<Record<string, PanelFrameMeta>>, keys: Iterable<string>): Record<string, PanelFrameMeta> {
  const alive = new Set(keys)
  return Object.fromEntries(Object.entries(meta).filter(([k]) => alive.has(k)))
}

/** The record read tolerantly from layout.json (anything malformed is dropped). */
export function readFrameMeta(raw: unknown): Record<string, PanelFrameMeta> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, PanelFrameMeta> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== 'object' || v === null) continue
    const m = v as Record<string, unknown>
    if (typeof m.ownerLabel !== 'string' || typeof m.updatedAt !== 'number' || !Number.isFinite(m.updatedAt)) continue
    out[k] = { ownerLabel: m.ownerLabel, ...(typeof m.deskId === 'string' && m.deskId ? { deskId: m.deskId } : {}), updatedAt: m.updatedAt }
  }
  return out
}

/** "agora", "13:05", "ontem", "seg", "3/11": when a frame last changed, short. */
export function whenLabel(at: number | undefined, now: number): string {
  if (at === undefined) return ''
  const d = new Date(at)
  const n = new Date(now)
  if (now - at < 60_000) return 'agora'
  const day = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((day(n) - day(d)) / 86_400_000)
  if (days <= 0) return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (days === 1) return 'ontem'
  if (days < 7) return ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'][d.getDay()]!
  return `${d.getDate()}/${d.getMonth() + 1}`
}
