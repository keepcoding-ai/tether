// The search results tree's pure rules: how the results model becomes the rows of the tree, the keyboard's targets, the
// next/previous match (F4 / Shift+F4), where the focus goes when its row is gone, the adaptive redraw interval and the
// accessible label of each row. No DOM: read by the renderer's SearchResults and by the unit tests.
// Origin (behaviour): https://github.com/microsoft/vscode, commit 9cc2376778e119f759ff710c1238fdc58d402d7a
//   src/vs/workbench/contrib/search/browser/searchView.ts         createResultIterator / createFolderIterator /
//                                                                  createFileIterator (the tree elements and their collapse),
//                                                                  selectNextMatch, selectPreviousMatch (tree order, wrapping,
//                                                                  expanding what hides the match)
//   src/vs/workbench/contrib/search/browser/searchResultsView.ts  FolderMatchRenderer / FileMatchRenderer (the count badges),
//                                                                  MatchRenderer (the replace preview, the title, line numbers),
//                                                                  SearchAccessibilityProvider (the row labels)
// Changes: a collapsed element carries no children in the tree (they are built when it expands), so a redraw costs the
// rows in view of the person's expansion, not the whole result; the collapse decided for an element the first time it is
// drawn is remembered by its id() (VS Code's tree keeps it by identity) until the results are reset; labels are Portuguese.
import type { ITreeElement } from '../../../app/shared/vscode-index-tree-model.ts'
import {
  childrenOf, FileMatch, FolderMatch, hasChildren, Match, SearchResult, shouldCollapse,
  type CollapseResults, type RenderableMatch, type SearchModel, type SearchSortOrder,
} from '../../../app/shared/vscode-search-model.ts'

export type ResultKind = 'folder' | 'file' | 'match'

/** One row of the tree as the tree model keeps it. Its count is read when it is built (a redraw builds it again). */
export interface ResultItem {
  readonly kind: ResultKind
  readonly id: string
  readonly element: RenderableMatch
  /** 1 for the top rows. */
  readonly level: number
  /** A folder's matches below it (recursiveMatchCount), a file's matches; 0 for a match. */
  readonly count: number
}

export interface BuildOptions {
  /** Tree view (folders and their direct children) instead of the list view (each root lists all its files). */
  readonly tree: boolean
  readonly sortOrder: SearchSortOrder
  readonly collapseResults: CollapseResults
}

/** Per element id, whether it is collapsed: decided by `shouldCollapse` the first time, then by the person. */
export type CollapseMemory = Map<string, boolean>

export function kindOf(element: RenderableMatch): ResultKind {
  return element instanceof Match ? 'match' : element instanceof FileMatch ? 'file' : 'folder'
}

export function countOf(element: RenderableMatch): number {
  if (element instanceof Match) return 0
  if (element instanceof FileMatch) return element.count()
  return element.recursiveMatchCount()
}

/** Whether a folder or file row is collapsed; the first decision (the setting's rule) is remembered. */
export function isCollapsed(element: RenderableMatch, memory: CollapseMemory, collapseResults: CollapseResults): boolean {
  if (element instanceof Match) return false
  const id = element.id()
  let collapsed = memory.get(id)
  if (collapsed === undefined) {
    collapsed = shouldCollapse(element, collapseResults)
    memory.set(id, collapsed)
  }
  return collapsed
}

export function itemOf(element: RenderableMatch, level: number): ResultItem {
  return { kind: kindOf(element), id: element.id(), element, level, count: countOf(element) }
}

/** The tree elements under `parent` (the result, a folder or a file); an expanded child brings its own, a collapsed one none. */
export function treeElements(parent: SearchResult | RenderableMatch, level: number, opts: BuildOptions, memory: CollapseMemory): ITreeElement<ResultItem>[] {
  const out: ITreeElement<ResultItem>[] = []
  for (const child of childrenOf(parent, opts)) {
    const item = itemOf(child, level)
    if (child instanceof Match || !hasChildren(child)) { out.push({ element: item }); continue }
    const collapsed = isCollapsed(child, memory, opts.collapseResults)
    out.push(collapsed
      ? { element: item, collapsible: true, collapsed: true, children: [] }
      : { element: item, collapsible: true, collapsed: false, children: treeElements(child, level + 1, opts, memory) })
  }
  return out
}

/** A row of the flat list, as the tests read it. */
export interface FlatRow { kind: ResultKind; id: string; level: number; count: number; expanded?: boolean }

/** The rows the tree shows, top to bottom (what the list holds after a build). */
export function flatRows(elements: Iterable<ITreeElement<ResultItem>>): FlatRow[] {
  const out: FlatRow[] = []
  const walk = (els: Iterable<ITreeElement<ResultItem>>): void => {
    for (const e of els) {
      const { kind, id, level, count } = e.element
      out.push(e.collapsible ? { kind, id, level, count, expanded: !e.collapsed } : { kind, id, level, count })
      if (e.children && !e.collapsed) walk(e.children)
    }
  }
  walk(elements)
  return out
}

/** Every element in tree order (the parent before its children), collapsed or not; `matches: false` skips the matches. */
export function* preorder(result: SearchResult, opts: { tree: boolean; sortOrder: SearchSortOrder }, matches = true): Generator<RenderableMatch> {
  function* walk(parent: SearchResult | RenderableMatch): Generator<RenderableMatch> {
    for (const child of childrenOf(parent, opts)) {
      if (child instanceof Match) { if (matches) yield child; continue }
      yield child
      if (child instanceof FileMatch && !matches) continue
      yield* walk(child)
    }
  }
  yield* walk(result)
}

/**
 * F4 / Shift+F4 (selectNextMatch / selectPreviousMatch): the first match after `from` in tree order (a file or folder's own
 * matches come after it), or the last one before it, wrapping around. `from` gone or undefined: the first (last) match.
 */
export function stepMatch(result: SearchResult, opts: { tree: boolean; sortOrder: SearchSortOrder }, from: string | undefined, backwards: boolean): Match | undefined {
  let first: Match | undefined
  let last: Match | undefined
  let found = false
  for (const element of preorder(result, opts)) {
    const isFrom = !found && from !== undefined && element.id() === from
    if (isFrom) {
      found = true
      if (backwards && last) return last
    }
    if (!(element instanceof Match)) continue
    if (found && !isFrom && !backwards) return element
    first ??= element
    last = element
  }
  // Wrapping (or nothing to start from).
  return backwards ? last : first
}

/** The element ids from the top row down to `element` that must be expanded for it to show (itself excluded). */
export function ancestorIds(element: RenderableMatch): string[] {
  const out: string[] = []
  let parent: SearchResult | FolderMatch | FileMatch = element.parent()
  while (!(parent instanceof SearchResult)) {
    out.push(parent.id())
    parent = parent.parent()
  }
  return out.reverse()
}

// ---------- the keyboard ----------

/** What the keyboard needs of a row. */
export interface NavRow { level: number; collapsible: boolean; expanded: boolean }

/** A read-only sequence read one item at a time (the virtual list builds only the row asked for). */
export interface Indexed<T> { readonly length: number; at(index: number): T | undefined }

export type NavAction =
  | { type: 'focus'; index: number }
  | { type: 'expand' | 'collapse' | 'toggle' | 'open' | 'leave' }
  | { type: 'none' }

const NONE: NavAction = { type: 'none' }

/** The index of the parent of row `i` (the nearest earlier row of a lower level), or -1. */
export function parentIndex(rows: Indexed<NavRow>, i: number): number {
  const row = rows.at(i)
  if (!row) return -1
  for (let j = i - 1; j >= 0; j--) if ((rows.at(j)?.level ?? 0) < row.level) return j
  return -1
}

/**
 * What a key does on row `i`: ↑/↓ move (↑ on the first row leaves the tree for the input above), Home/End jump, → expands or
 * goes to the first child, ← collapses or goes to the parent, Enter opens a match or toggles a folder/file.
 */
export function navigate(rows: Indexed<NavRow>, i: number, key: string): NavAction {
  const row = rows.at(i)
  if (!row) return NONE
  const last = rows.length - 1
  switch (key) {
    case 'ArrowDown': return i < last ? { type: 'focus', index: i + 1 } : NONE
    case 'ArrowUp': return i > 0 ? { type: 'focus', index: i - 1 } : { type: 'leave' }
    case 'Home': return i > 0 ? { type: 'focus', index: 0 } : NONE
    case 'End': return i < last ? { type: 'focus', index: last } : NONE
    case 'ArrowRight':
      if (!row.collapsible) return NONE
      if (!row.expanded) return { type: 'expand' }
      return i < last && (rows.at(i + 1)?.level ?? 0) > row.level ? { type: 'focus', index: i + 1 } : NONE
    case 'ArrowLeft': {
      if (row.collapsible && row.expanded) return { type: 'collapse' }
      const p = parentIndex(rows, i)
      return p >= 0 ? { type: 'focus', index: p } : NONE
    }
    case 'Enter': return row.collapsible ? { type: 'toggle' } : { type: 'open' }
    default: return NONE
  }
}

/**
 * PageUp/PageDown on row `i` with rows `first..last` in view and `page` rows per view: the first press goes to the edge of the
 * view, the next one a page further (VS Code's list). Clamped to the list; -1 for an empty list.
 */
export function pageTarget(i: number, count: number, first: number, last: number, page: number, down: boolean): number {
  if (count === 0) return -1
  const step = Math.max(1, page - 1)
  const t = down ? (i < last ? last : i + step) : (i > first ? first : i - step)
  return Math.max(0, Math.min(count - 1, t))
}

// ---------- where the focus goes ----------

/** A row being dismissed at `i`: the focus goes to the first row after its subtree, else to the one above it; -1 if none. */
export function afterDismiss(rows: Indexed<NavRow>, i: number): number {
  const row = rows.at(i)
  if (!row) return -1
  let j = i + 1
  while (j < rows.length && (rows.at(j)?.level ?? 0) > row.level) j++
  if (j < rows.length) return j
  return i > 0 ? i - 1 : -1
}

/**
 * The focused row's id is gone after a redraw (a match's id carries its position, which a replace can change): the focus
 * stays at the same index of the flat list, capped at its end; -1 only when the list is empty.
 */
export function survivor(index: number, length: number): number {
  return length <= 0 ? -1 : Math.max(0, Math.min(index, length - 1))
}

// ---------- the redraw's pace ----------

export const REDRAW_MIN_MS = 100
export const REDRAW_MAX_MS = 800
/** A rebuild slower than this doubles the interval between rebuilds. */
export const REDRAW_SLOW_MS = 50

/** The interval after a rebuild that took `tookMs`: doubled when it was slow, capped; otherwise unchanged. */
export function nextInterval(current: number, tookMs: number): number {
  return tookMs > REDRAW_SLOW_MS ? Math.min(REDRAW_MAX_MS, current * 2) : current
}

/** How long a rebuild asked for at `now` waits: none when the last one is at least `interval` ago. */
export function redrawDelay(now: number, lastBuild: number | undefined, interval: number): number {
  if (lastBuild === undefined) return 0
  return Math.max(0, lastBuild + interval - now)
}

// ---------- what a row shows and says ----------

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** The name of a folder or file row ("Outros arquivos" for the files outside every project root). */
export function nameOf(element: FolderMatch | FileMatch): string {
  if (element instanceof FileMatch) return element.name()
  return element.resource ? element.name() : 'Outros arquivos'
}

/** The count pill's tooltip. */
export function countTitle(count: number): string {
  return plural(count, 'resultado', 'resultados')
}

/** Whether the rows show the replace preview: replace on and a replace text typed (MatchRenderer). */
export function showsReplace(model: SearchModel): boolean {
  return model.replaceActive && !!model.replaceString && model.replacePattern !== null
}

/** The match row's text parts, the replacement when previewed, and the line it starts on (with the lines it spans beyond). */
export interface MatchParts { before: string; inside: string; after: string; replacement?: string; line: number; extraLines: number; title: string }

export function matchParts(match: Match, replace: boolean): MatchParts {
  const p = match.preview()
  const range = match.range()
  const replacement = replace ? match.replaceString : undefined
  const title = (p.fullBefore + (replacement ?? p.inside) + p.after).trim().slice(0, 999)
  return {
    before: p.before, inside: p.inside, after: p.after, ...(replacement !== undefined ? { replacement } : {}),
    line: range.startLineNumber, extraLines: range.endLineNumber - range.startLineNumber, title,
  }
}

/** The label assistive technology reads for a row (SearchAccessibilityProvider). */
export function ariaLabel(element: RenderableMatch, replace: boolean): string {
  if (element instanceof Match) {
    const range = element.range()
    const text = element.text().slice(0, range.endColumn + 150).trim()
    const head = `linha ${range.startLineNumber}: ${text}`
    return replace ? `${head}, substituir "${element.getMatchString()}" por "${element.replaceString}"` : head
  }
  if (element instanceof FileMatch) return `${plural(element.count(), 'resultado', 'resultados')} no arquivo ${element.name()}`
  const count = element.recursiveMatchCount()
  return element.resource
    ? `${plural(count, 'resultado', 'resultados')} na pasta ${element.name()}`
    : `${plural(count, 'resultado', 'resultados')} fora dos projetos`
}

/** The label of the row's replace action. */
export function replaceLabel(kind: ResultKind): string {
  return kind === 'match' ? 'Substituir' : kind === 'file' ? 'Substituir tudo neste arquivo' : 'Substituir tudo nesta pasta'
}

export const DISMISS_LABEL = 'Dispensar'
