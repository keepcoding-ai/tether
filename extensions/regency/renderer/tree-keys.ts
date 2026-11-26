// The tree's rows as a flat list with stable focus keys, and its keyboard as a pure function: given the focused row and the
// key, the next focus or the action to run. No DOM; everything in and out is JSON.
import { CLOSED_ID, type RegencyModel, type Target, type TreeFilter } from '../model.ts'

export type RowKind = 'desk' | 'group' | 'pane' | 'closed-head' | 'closed'

/**
 * One visible row of the tree. `key` is the row's focus id and is unique in the list: a group header and the pane of the
 * agent it is named after carry the same `target` but never the same `key`.
 */
export interface FlatRow {
  key: string
  kind: RowKind
  target: Target
  /** aria-level: 1 for desks, groups and the "Fechadas" head; 2 under them. */
  level: 1 | 2
  /** The row folds (desk, group or "Fechadas" with something inside). */
  expandable: boolean
  expanded?: boolean
  /** The `collapsed` id this row folds by (expandable rows only). */
  foldId?: string
  /** The key of the row it sits under. */
  parent?: string
}

export const deskRowKey = (id: string): string => `desk:${id}`
export const groupRowKey = (id: string): string => `group:${id}`
export const paneRowKey = (t: Target): string => `pane:${t.kind}:${t.id}`
export const CLOSED_HEAD_KEY = 'closed-head'
export const closedRowKey = (id: string): string => `closed:${id}`

/** The rows on screen, in order, for the chosen view. What is folded gives no children. */
export function flatRows(model: RegencyModel, view: 'desk' | 'agent'): FlatRow[] {
  const rows: FlatRow[] = []
  if (view === 'desk') {
    for (const d of model.tree) {
      const key = deskRowKey(d.target.id)
      rows.push({ key, kind: 'desk', target: d.target, level: 1, expandable: d.paneCount > 0, expanded: !d.collapsed, foldId: d.target.id })
      for (const p of d.panes) rows.push({ key: paneRowKey(p.target), kind: 'pane', target: p.target, level: 2, expandable: false, parent: key })
    }
  } else {
    for (const g of model.byAgent) {
      const key = groupRowKey(g.target.id)
      rows.push({ key, kind: 'group', target: g.target, level: 1, expandable: g.paneCount > 0, expanded: !g.collapsed, foldId: g.target.id })
      for (const p of g.panes) rows.push({ key: paneRowKey(p.target), kind: 'pane', target: p.target, level: 2, expandable: false, parent: key })
    }
  }
  if (model.closed.count > 0) {
    rows.push({
      key: CLOSED_HEAD_KEY, kind: 'closed-head', target: { kind: 'session', id: CLOSED_ID }, level: 1,
      expandable: true, expanded: !model.closed.collapsed, foldId: CLOSED_ID,
    })
    for (const c of model.closed.rows) {
      rows.push({ key: closedRowKey(c.target.id), kind: 'closed', target: c.target, level: 2, expandable: false, parent: CLOSED_HEAD_KEY })
    }
  }
  return rows
}

/** The slice of a keyboard event the rules read (a DOM `KeyboardEvent` fits). */
export interface KeyInput { key: string; shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean }

/** What a key asks for. `undefined` means the key is not the tree's: the caller does not prevent it. */
export type TreeStep =
  | { type: 'focus'; key: string }
  | { type: 'toggle'; key: string; foldId: string; open: boolean }
  | { type: 'quick'; key: string; target: Target }
  | { type: 'go'; key: string; target: Target }
  | { type: 'menu'; key: string; target: Target }
  | { type: 'clear-search' }
  | { type: 'clear-filter' }

export interface TreeKeyState { query: string; filter: TreeFilter }

/**
 * The tree's keys: arrows walk (Up/Down by row, Home/End to the ends, Right opens or enters, Left closes or climbs); Space is
 * the quick look on a pane; Enter goes to a pane and folds a desk, a group or "Fechadas"; the Menu key and Shift+F10 open the
 * row's menu; Esc clears the search, then the filter. A `focused` that is not in `rows` counts as no focus.
 */
export function treeKeyStep(rows: readonly FlatRow[], focused: string | undefined, ev: KeyInput, state: TreeKeyState): TreeStep | undefined {
  const { key } = ev
  if (ev.ctrlKey || ev.altKey || ev.metaKey) return undefined
  if (key === 'Escape') {
    if (state.query.trim() !== '') return { type: 'clear-search' }
    if (state.filter !== 'all') return { type: 'clear-filter' }
    return undefined
  }
  if (rows.length === 0) return undefined
  const i = focused === undefined ? -1 : rows.findIndex(r => r.key === focused)
  const row = i >= 0 ? rows[i]! : undefined
  const at = (n: number): TreeStep => ({ type: 'focus', key: rows[Math.max(0, Math.min(rows.length - 1, n))]!.key })

  const menu = key === 'ContextMenu' || (key === 'F10' && ev.shiftKey === true)
  if (ev.shiftKey && !menu) return undefined
  if (key === 'ArrowDown') return at(i + 1)
  if (key === 'ArrowUp') return row ? at(i - 1) : at(0)
  if (key === 'Home') return at(0)
  if (key === 'End') return at(rows.length - 1)
  if (!row) return undefined

  if (key === 'ArrowRight') {
    if (!row.expandable) return undefined
    if (!row.expanded) return { type: 'toggle', key: row.key, foldId: row.foldId!, open: true }
    const child = rows.find(r => r.parent === row.key)
    return child ? { type: 'focus', key: child.key } : undefined
  }
  if (key === 'ArrowLeft') {
    if (row.expandable && row.expanded) return { type: 'toggle', key: row.key, foldId: row.foldId!, open: false }
    return row.parent !== undefined ? { type: 'focus', key: row.parent } : undefined
  }
  if (menu) return { type: 'menu', key: row.key, target: row.target }
  if (key === ' ' || key === 'Spacebar') return row.kind === 'pane' ? { type: 'quick', key: row.key, target: row.target } : undefined
  if (key === 'Enter') {
    if (row.kind === 'pane') return { type: 'go', key: row.key, target: row.target }
    if (row.kind === 'closed') return { type: 'menu', key: row.key, target: row.target }
    if (row.expandable) return { type: 'toggle', key: row.key, foldId: row.foldId!, open: !row.expanded }
    return undefined
  }
  return undefined
}
