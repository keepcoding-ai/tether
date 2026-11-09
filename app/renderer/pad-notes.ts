// The notes of the frames pads ("pranchetas"), as pure rules: no DOM, unit-tested. The core (main.ts) feeds them what it
// has (every pad frame's saved state, the live panels, the desks) and the pad-notes extension draws the result.
//
// Vocabulary: a note is one pad frame (the panel pad's frame of one panel, the desk pad's frame of one desk, the global
// pad's frame). It is "loose" ("solta") when its owner is gone: a panel pad's frame whose panel was closed. It is "empty"
// when every pane it holds is an empty pane (the blank view the pad is seeded with).
//
// Each note may carry a small record (`PadNoteMeta`) written while its owner lives: the owner's label and desk, and when
// its content last changed. A loose note keeps it, so the manager can still say "antes em <painel>".
import type { SerializedDockview } from 'dockview-core'
import { EMPTY_COMPONENT } from '../shared/empty.ts'
import { noteParams } from '../shared/notes.ts'
import { isDrawerLayout, isLayoutV1, type DrawerLayout } from './layout.ts'

/** What the core keeps per note key while the owner lives (layout.json `sidebars.meta`). */
export interface PadNoteMeta {
  /** The owner's name as its tab showed it (a panel) or the desk's name. */
  ownerLabel: string
  /** The desk the owner lived in. */
  deskId?: string
  /** When the note's content last changed (ms since epoch). */
  updatedAt: number
}

export type NoteOwner = { kind: 'panel'; panelId: string } | { kind: 'desk'; deskId: string } | { kind: 'global' }

/** One note as the core hands it in: its key, its pad, whose it is and its saved frame state. */
export interface NoteSource {
  key: string
  padId: string
  owner: NoteOwner
  state: unknown
}

/** A pane of a note's frame, as the manager lists it. */
export interface NotePane {
  id: string
  title: string
  component: string
  /** The file a note pane shows. */
  file?: string
}

export interface NoteRow {
  key: string
  padId: string
  owner: NoteOwner
  /** The owner's name now (alive) or as last recorded (loose); '' when never recorded. */
  label: string
  deskId?: string
  loose: boolean
  empty: boolean
  panes: NotePane[]
  /** The panes that are not empty panes. */
  tabs: number
  /** The first real pane's title, or '' for an empty note. */
  title: string
  updatedAt?: number
  /** The panel the Foco de Mesa is on owns it. */
  focused: boolean
}

export interface NoteDeskGroup {
  id: string
  name: string
  deskPad?: NoteRow
  panels: NoteRow[]
}

export interface NoteTree {
  loose: NoteRow[]
  desks: NoteDeskGroup[]
  global: NoteRow[]
}

export interface NoteTreeInput {
  sources: readonly NoteSource[]
  meta: Readonly<Record<string, PadNoteMeta>>
  desks: readonly { id: string; name: string }[]
  /** The panels alive now (anywhere in the window): their label and desk. */
  livePanels: ReadonlyMap<string, { label: string; deskId?: string }>
  focusedPanel?: string
}

export type NoteFilter = 'loose' | 'all'

/** The panes of a saved frame state (frames → views → panels), in view order. */
export function panesOf(state: unknown): NotePane[] {
  if (!isDrawerLayout(state)) return []
  const out: NotePane[] = []
  for (const view of Object.values(state.frames.views)) {
    if (!isLayoutV1(view)) continue
    for (const [id, p] of Object.entries(view.panels)) {
      const file = noteParams(p.params)?.path
      out.push({ id, title: p.title ?? id, component: p.contentComponent ?? 'terminal', ...(file ? { file } : {}) })
    }
  }
  return out
}

/** A note has content when one of its panes is not an empty pane. */
export function hasContent(state: unknown): boolean {
  return panesOf(state).some(p => p.component !== EMPTY_COMPONENT)
}

function row(src: NoteSource, input: NoteTreeInput): NoteRow {
  const panes = panesOf(src.state)
  const real = panes.filter(p => p.component !== EMPTY_COMPONENT)
  const meta = input.meta[src.key]
  let label = meta?.ownerLabel ?? ''
  let deskId = meta?.deskId
  let loose = false
  if (src.owner.kind === 'panel') {
    const live = input.livePanels.get(src.owner.panelId)
    if (live) { label = live.label; deskId = live.deskId } else loose = true
  } else if (src.owner.kind === 'desk') {
    const desk = input.desks.find(d => d.id === (src.owner as { deskId: string }).deskId)
    if (desk) { label = desk.name; deskId = desk.id } else loose = true
  }
  return {
    key: src.key, padId: src.padId, owner: src.owner, label, ...(deskId ? { deskId } : {}), loose, empty: real.length === 0,
    panes, tabs: real.length, title: real[0]?.title ?? '', ...(meta ? { updatedAt: meta.updatedAt } : {}),
    focused: src.owner.kind === 'panel' && src.owner.panelId === input.focusedPanel,
  }
}

/** Most recent first; never-recorded ones last, in their given order. */
const byRecent = (a: NoteRow, b: NoteRow): number => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)

/**
 * The map the manager shows: the loose notes first (with content before empty, most recent first), then each desk with
 * its desk pad and its panels' notes (desk order), then the global pad.
 */
export function buildNoteTree(input: NoteTreeInput): NoteTree {
  const rows = input.sources.map(s => row(s, input))
  const loose = rows.filter(r => r.loose).sort((a, b) => Number(a.empty) - Number(b.empty) || byRecent(a, b))
  const desks = input.desks.map((d): NoteDeskGroup => {
    const deskPad = rows.find(r => !r.loose && r.owner.kind === 'desk' && r.owner.deskId === d.id)
    const panels = rows.filter(r => !r.loose && r.owner.kind === 'panel' && r.deskId === d.id)
    return { id: d.id, name: d.name, ...(deskPad ? { deskPad } : {}), panels }
  })
  // A live panel outside every desk (the drawer, a pad) is listed with no desk: under the global group.
  const homeless = rows.filter(r => !r.loose && r.owner.kind === 'panel' && !input.desks.some(d => d.id === r.deskId))
  const global = [...rows.filter(r => r.owner.kind === 'global'), ...homeless]
  return { loose, desks, global }
}

/** The rows a filter shows, in tree order. A live owner's empty note (the blank a pad starts with) is not listed: nothing to look after. */
export function visibleRows(tree: NoteTree, filter: NoteFilter): NoteRow[] {
  if (filter === 'loose') return tree.loose
  const live = (r: NoteRow): boolean => !r.empty
  return [...tree.loose, ...tree.desks.flatMap(d => [...(d.deskPad ? [d.deskPad] : []), ...d.panels]).filter(live), ...tree.global.filter(live)]
}

/** How many loose notes have content (the counter's warning dot) and how many notes have content at all. */
export function noteCounts(tree: NoteTree): { loose: number; looseEmpty: number; withContent: number } {
  const all = [...tree.loose, ...tree.desks.flatMap(d => [...(d.deskPad ? [d.deskPad] : []), ...d.panels]), ...tree.global]
  return { loose: tree.loose.filter(r => !r.empty).length, looseEmpty: tree.loose.filter(r => r.empty).length, withContent: all.filter(r => !r.empty).length }
}

/** The keys "Limpar vazias" (and the automatic clean-up) removes: the loose notes with nothing in them. */
export function emptyLooseKeys(tree: NoteTree): string[] {
  return tree.loose.filter(r => r.empty).map(r => r.key)
}

// ---------- operations on the stored notes ----------

/** The notes as stored: frame state and record per key. */
export interface NoteStore {
  pads: Readonly<Record<string, unknown>>
  meta: Readonly<Record<string, PadNoteMeta>>
}

/** What an operation changed, to undo it: each touched key's state and record before it (undefined = absent). */
export interface NoteSnapshot {
  entries: { key: string; state: unknown; meta: PadNoteMeta | undefined }[]
}

function snapshotOf(store: NoteStore, keys: readonly string[]): NoteSnapshot {
  return { entries: [...new Set(keys)].map(key => ({ key, state: store.pads[key], meta: store.meta[key] })) }
}

function without<T>(rec: Readonly<Record<string, T>>, keys: readonly string[]): Record<string, T> {
  const out = { ...rec }
  for (const k of keys) delete out[k]
  return out
}

/** Closes notes: their frames and records go; the snapshot brings them back. */
export function closeNotes(store: NoteStore, keys: readonly string[]): { store: NoteStore; undo: NoteSnapshot } {
  const present = keys.filter(k => k in store.pads || k in store.meta)
  return { store: { pads: without(store.pads, present), meta: without(store.meta, present) }, undo: snapshotOf(store, present) }
}

/** Puts back what a snapshot recorded (an absent entry is removed again). */
export function restoreNotes(store: NoteStore, snap: NoteSnapshot): NoteStore {
  const pads: Record<string, unknown> = { ...store.pads }
  const meta: Record<string, PadNoteMeta> = { ...store.meta }
  for (const e of snap.entries) {
    if (e.state === undefined) delete pads[e.key]; else pads[e.key] = e.state
    if (e.meta === undefined) delete meta[e.key]; else meta[e.key] = e.meta
  }
  return { pads, meta }
}

/** "Limpar vazias": closes every loose note with nothing in it. */
export function cleanEmptyNotes(store: NoteStore, tree: NoteTree): { store: NoteStore; undo: NoteSnapshot; keys: string[] } {
  const keys = emptyLooseKeys(tree)
  return { ...closeNotes(store, keys), keys }
}

type Leaf = { type: 'leaf'; data: { views: string[]; activeView?: string; id: string } }
type Node = Leaf | { type: 'branch'; data: Node[] }

function firstLeaf(n: Node): Leaf | undefined {
  if (n.type === 'leaf') return n
  for (const c of n.data) { const l = firstLeaf(c); if (l) return l }
  return undefined
}

/** The first view of a frame state and its first group: where moved panes go (a pad has one frame). */
function firstGroup(state: DrawerLayout): { view: SerializedDockview; leaf: Leaf } | undefined {
  for (const view of Object.values(state.frames.views)) {
    if (!isLayoutV1(view)) continue
    const leaf = firstLeaf(view.grid.root as unknown as Node)
    if (leaf) return { view, leaf }
  }
  return undefined
}

/**
 * Moves a note to another owner's key: the source's real panes become tabs of the target's frame (the tabs add up; the
 * target's empty panes give way), and the source note closes. A target with no state takes the source's as it is.
 * Unchanged (and an empty snapshot) when the source has nothing to move or the keys are the same.
 */
export function moveNote(store: NoteStore, from: string, to: string, now: number): { store: NoteStore; undo: NoteSnapshot } {
  const src = store.pads[from]
  if (from === to || !hasContent(src)) return { store, undo: { entries: [] } }
  const undo = snapshotOf(store, [from, to])
  const target = store.pads[to]
  let next: unknown
  const moving = panesOf(src).filter(p => p.component !== EMPTY_COMPONENT)
  const into = isDrawerLayout(target) ? structuredClone(target) : undefined
  const group = into ? firstGroup(into) : undefined
  if (!into || !group) {
    next = structuredClone(src)
  } else {
    const srcPanels = Object.assign({}, ...Object.values((src as DrawerLayout).frames.views).filter(isLayoutV1).map(v => v.panels)) as SerializedDockview['panels']
    // The target's empty panes give way to what arrives.
    for (const [id, p] of Object.entries(group.view.panels)) {
      if ((p.contentComponent ?? 'terminal') !== EMPTY_COMPONENT) continue
      delete group.view.panels[id]
      group.leaf.data.views = group.leaf.data.views.filter(v => v !== id)
    }
    for (const p of moving) {
      group.view.panels[p.id] = srcPanels[p.id]!
      group.leaf.data.views.push(p.id)
    }
    group.leaf.data.activeView = moving[0]!.id
    next = into
  }
  const fromMeta = store.meta[from]
  const toMeta = store.meta[to]
  const meta = without(store.meta, [from])
  meta[to] = { ownerLabel: toMeta?.ownerLabel ?? fromMeta?.ownerLabel ?? '', ...(toMeta?.deskId ?? fromMeta?.deskId ? { deskId: toMeta?.deskId ?? fromMeta?.deskId } : {}), updatedAt: now }
  return { store: { pads: { ...without(store.pads, [from]), [to]: next }, meta }, undo }
}

/** The records with only the keys that still have a frame state. */
export function pruneMeta(meta: Readonly<Record<string, PadNoteMeta>>, keys: Iterable<string>): Record<string, PadNoteMeta> {
  const alive = new Set(keys)
  return Object.fromEntries(Object.entries(meta).filter(([k]) => alive.has(k)))
}

/** The record read tolerantly from layout.json (anything malformed is dropped). */
export function readNoteMeta(raw: unknown): Record<string, PadNoteMeta> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, PadNoteMeta> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== 'object' || v === null) continue
    const m = v as Record<string, unknown>
    if (typeof m.ownerLabel !== 'string' || typeof m.updatedAt !== 'number' || !Number.isFinite(m.updatedAt)) continue
    out[k] = { ownerLabel: m.ownerLabel, ...(typeof m.deskId === 'string' && m.deskId ? { deskId: m.deskId } : {}), updatedAt: m.updatedAt }
  }
  return out
}

/** "agora", "13:05", "ontem", "seg", "3/11": when a note last changed, short. */
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
