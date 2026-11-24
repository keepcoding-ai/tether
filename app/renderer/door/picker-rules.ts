// The list picker's rules (the `pick` block of TetherUi), free of the DOM: which rows a query leaves and in what order, where the
// selection goes on a key, and how one or two asks turn into an answer (Esc in the second goes back to the first, in the first
// closes). picker.ts draws; this file decides, so the unit tests load it.
import type { PickItem, PickManySpec, PickSpec } from '../ext-api.ts'
import { fuzzyMatch, highlightRuns } from '../fuzzy.ts'
import { engineOf as pickEngine } from '../agent-ui.ts'

/** True when some row names an engine: the list is of agents, so every row reserves the engine column and the emblem slot. */
export function hasEngineColumn<T>(items: readonly PickItem<T>[], featured?: PickItem<T>): boolean {
  return featured?.engine !== undefined || items.some(i => i.engine !== undefined)
}

/** Rows moved by PageUp and PageDown. */
export const PICK_PAGE = 8

export interface PickRow<T> {
  item: PickItem<T>
  /** The row on top, apart from the rest. */
  featured: boolean
  /** The label split for the highlight (one plain run when nothing in the label matched). */
  runs: { text: string; hit: boolean }[]
}

/**
 * The rows for a query: the featured item first (when it matches), then the others, the way fuzzy.ts ranks them (a match in the
 * label before one only in the detail; ties keep the list's order). An empty query keeps everything in the list's order. The
 * featured item is not repeated when the list holds it too. Rows with a `group` stay together: the groups keep the order in which
 * they first appear in the list, and the ranking orders the rows inside each group.
 */
export function rankPicks<T>(featured: PickItem<T> | undefined, items: readonly PickItem<T>[], query: string): PickRow<T>[] {
  const rows: PickRow<T>[] = []
  const rest = featured ? items.filter(i => !Object.is(i.value, featured.value)) : items
  const rank = (item: PickItem<T>, isFeatured: boolean): { row: PickRow<T>; key: number } | undefined => {
    const label = fuzzyMatch(query, item.label)
    const detail = label || !item.detail ? undefined : fuzzyMatch(query, item.detail)
    // The emblem's name is the last place a query can match, ranked like a detail-only match.
    const emblem = label || detail || !item.emblem ? undefined : fuzzyMatch(query, item.emblem.name)
    // The engine's name ("Soul", "Claude") is matched last too: typing "soul" finds the Soul agents whatever their names.
    const engine = label || detail || emblem || !item.engine ? undefined : fuzzyMatch(query, pickEngine(item.engine).label)
    if (!label && !detail && !emblem && !engine) return undefined
    const runs = label && label.positions.length > 0 ? highlightRuns(item.label, label.positions) : [{ text: item.label, hit: false }]
    return { row: { item, featured: isFeatured, runs }, key: label ? 1000 + label.score : (detail ?? emblem ?? engine)!.score }
  }
  const top = featured && rank(featured, true)
  if (top) rows.push(top.row)
  const ranked = rest.map((item, order) => ({ ...rank(item, false), order })).filter((r): r is { row: PickRow<T>; key: number; order: number } => r.row !== undefined)
  if (query.trim() !== '') ranked.sort((a, b) => b.key - a.key || a.order - b.order)
  const groupAt = new Map<string | undefined, number>()
  for (const item of rest) if (!groupAt.has(item.group)) groupAt.set(item.group, groupAt.size)
  if (groupAt.size > 1) {
    const at = ranked.map((r, i) => ({ r, i }))
    at.sort((a, b) => groupAt.get(a.r.row.item.group)! - groupAt.get(b.r.row.item.group)! || a.i - b.i)
    ranked.splice(0, ranked.length, ...at.map(x => x.r))
  }
  for (const r of ranked) rows.push(r.row)
  return rows
}

/** The heading drawn above row `i`: its group's, when it opens that group (never above the featured row). */
export function groupHeading<T>(rows: readonly PickRow<T>[], i: number): string | undefined {
  const row = rows[i]
  const group = row && !row.featured ? row.item.group : undefined
  if (typeof group !== 'string' || group === '') return undefined
  const before = rows[i - 1]
  return before && !before.featured && before.item.group === group ? undefined : group
}

/** How many rows answer to a number key (1 to 9). */
export const PICK_NUMBERED = 9

/** The row a key chooses: '1' to '9' while the filter is empty, when that row exists; otherwise undefined (the key types). */
export function numberedRow(key: string, query: string, count: number): number | undefined {
  if (query !== '' || key.length !== 1 || key < '1' || key > '9') return undefined
  const i = Number(key) - 1
  return i < count ? i : undefined
}

/** The selected row after a navigation key; `current` when the key does not navigate or there are no rows. */
export function moveSelection(current: number, count: number, key: string): number {
  if (count <= 0) return 0
  switch (key) {
    case 'ArrowDown': return (current + 1) % count
    case 'ArrowUp': return (current - 1 + count) % count
    case 'PageDown': return Math.min(count - 1, current + PICK_PAGE)
    case 'PageUp': return Math.max(0, current - PICK_PAGE)
    default: return current
  }
}

/** The selection to keep when the rows are drawn again (a new query): the row of the same item, else the first. */
export function reselect<T>(rows: readonly PickRow<T>[], previous: PickItem<T> | undefined): number {
  const at = previous ? rows.findIndex(r => Object.is(r.item.value, previous.value)) : -1
  return at < 0 ? 0 : at
}

/** What one ask of the picker came back with. */
export type PickAnswer<T> =
  | { kind: 'pick'; item: PickItem<T>; query: string }
  /** `pick.many`: the confirmed items, in the list's order. */
  | { kind: 'many'; items: PickItem<T>[]; query: string }
  /** Esc in a later step. */
  | { kind: 'back' }
  /** Esc in the first step, a click outside, or a newer picker taking the place. */
  | { kind: 'close' }

/** Where an ask stands: the picker shows "1 de 2", a way back, and what was chosen before. */
export interface AskContext {
  step: number
  steps: number
  /** The label chosen in the step before (shown on top of the second). */
  chosen?: string
  /** What was typed the last time this step was open (coming back restores it), and the item that was picked then. */
  query?: string
  previous?: PickItem<unknown>
  /** Present when the ask marks several (`pick.many`). */
  many?: ManyOptions
}

/** The words of a `pick.many` box. */
export interface ManyOptions {
  confirmLabel: string
  confirmHint: string
}

export const MANY_CONFIRM_LABEL = 'Confirmar'
export const MANY_CONFIRM_HINT = 'confirma'

export function manyOptions(spec: PickManySpec<unknown>): ManyOptions {
  return { confirmLabel: spec.confirmLabel?.trim() || MANY_CONFIRM_LABEL, confirmHint: spec.confirmHint?.trim() || MANY_CONFIRM_HINT }
}

/** The footer of a `pick.many` box: the keys, said in writing. */
export function manyFooter(o: ManyOptions): string {
  return `Espaço marca vários · Enter ${o.confirmHint} · Esc fecha`
}

/** The marks after Space (or a click) on `value`: a new set, the mark added or taken away. */
export function toggleMark(marks: ReadonlySet<unknown>, value: unknown): Set<unknown> {
  const next = new Set(marks)
  if (!next.delete(value)) next.add(value)
  return next
}

/** The items to answer with: no mark, the row under the cursor alone; with marks, the marked ones in the list's order (a mark outlives a filter that hides its row). */
export function manyChosen<T>(ordered: readonly PickItem<T>[], marks: ReadonlySet<unknown>, cursor: PickItem<T> | undefined): PickItem<T>[] {
  if (marks.size === 0) return cursor ? [cursor] : []
  return ordered.filter(i => marks.has(i.value))
}

/** How many the Enter key (and the button) would answer with: the marks, else the cursor row, else none. */
export function manyCount(marks: ReadonlySet<unknown>, hasCursor: boolean): number {
  return marks.size > 0 ? marks.size : hasCursor ? 1 : 0
}

/** The confirm button's text: the verb and the count ("Juntar 3"); the verb alone when there is nothing to answer with. */
export function confirmText(o: ManyOptions, count: number): string {
  return count > 0 ? `${o.confirmLabel} ${count}` : o.confirmLabel
}

/** The list the marks are read against: the featured item (once) and then the items, as given. */
export function orderedItems<T>(featured: PickItem<T> | undefined, items: readonly PickItem<T>[]): PickItem<T>[] {
  return featured ? [featured, ...items.filter(i => !Object.is(i.value, featured.value))] : [...items]
}

export type Ask = <T>(spec: PickSpec<T>, ctx: AskContext) => Promise<PickAnswer<T>>

/** One step: the picked value, or undefined when the person closed it. */
export async function runList<T>(ask: Ask, spec: PickSpec<T>): Promise<T | undefined> {
  const answer = await ask(spec, { step: 1, steps: 1 })
  return answer.kind === 'pick' ? answer.item.value : undefined
}

/** Several at once: the confirmed values, or undefined when the person closed it. */
export async function runMany<T>(ask: Ask, spec: PickManySpec<T>): Promise<T[] | undefined> {
  const answer = await ask(spec, { step: 1, steps: 1, many: manyOptions(spec as PickManySpec<unknown>) })
  return answer.kind === 'many' ? answer.items.map(i => i.value) : undefined
}

/** Two steps. Esc in the second goes back to the first with its query and choice kept; closing anywhere resolves undefined. */
export async function runSteps<A, B>(ask: Ask, first: PickSpec<A>, second: (a: A) => PickSpec<B>): Promise<{ first: A; second: B } | undefined> {
  let again: { query: string; item: PickItem<A> } | undefined
  for (;;) {
    const a = await ask(first, { step: 1, steps: 2, ...(again ? { query: again.query, previous: again.item as PickItem<unknown> } : {}) })
    if (a.kind !== 'pick') return undefined
    again = { query: a.query, item: a.item }
    const b = await ask(second(a.item.value), { step: 2, steps: 2, chosen: a.item.label })
    if (b.kind === 'back') continue
    if (b.kind !== 'pick') return undefined
    return { first: a.item.value, second: b.item.value }
  }
}
