/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The explorer tree's pure rules (F8 slice 1b), read by both hosts: main lists, filters and sorts a folder; the renderer
// joins paths, keeps the expanded folders and moves the keyboard. No DOM, no Node.
// Origin: https://github.com/microsoft/vscode, commit 7faf984945fefaceb533ca1d851697a2e72e4e68
//   src/vs/base/common/comparers.ts                                      compareFileNamesDefault (+ compareAndDisambiguateByLength)
//   src/vs/workbench/contrib/files/browser/views/explorerViewer.ts       FileSorter (SortOrder.Default / Mixed)
//   src/vs/workbench/contrib/files/browser/files.contribution.ts         the default `files.exclude`
//   src/vs/workbench/contrib/files/common/files.ts                       SortOrder
// Changes: the collator is created lazily at module level instead of `Lazy`; the sort works on plain entries instead of
// ExplorerItem; `files.exclude` is the set of its default names (every default is a `**/<name>` glob, so a name match is
// the same test); formatting and comments are this project's. `node_modules` is not excluded (VS Code shows it).

/** A folder's entry as main lists it: a file or a folder (a link is typed by its target; `link` says it is one). */
export interface Entry { name: string; kind: 'file' | 'dir'; link?: true }

// VS Code's default `files.exclude`: the globs `**` + `/<name>` for each of these names.
export const DEFAULT_EXCLUDES: ReadonlySet<string> = new Set(['.git', '.svn', '.hg', '.jj', 'CVS', '.DS_Store', 'Thumbs.db'])

export function isExcluded(name: string): boolean { return DEFAULT_EXCLUDES.has(name) }

// ---------- sorting ----------

let fileNameCollator: { collator: Intl.Collator } | undefined
function collator(): Intl.Collator {
  // Numeric (file2 < file10) and accent-sensitive but case-insensitive, as VS Code's `intlFileNameCollator`.
  return (fileNameCollator ??= { collator: new Intl.Collator(undefined, { numeric: true, sensitivity: 'accent' }) }).collator
}

/** comparers.ts compareFileNamesDefault: natural order; names the numeric collator calls equal ("foo1", "foo01") go shorter first. */
export function compareFileNamesDefault(one: string, other: string): number {
  const result = collator().compare(one, other)
  if (result !== 0) return result
  if (one.length !== other.length) return one.length < other.length ? -1 : 1
  return 0
}

/** `files.explorer.sortOrder`: 'default' puts folders first, 'mixed' sorts files and folders together. */
export type SortOrder = 'default' | 'mixed'

/** The explorer's order (FileSorter): folders before files in 'default', then by name; a new array. */
export function sortEntries(entries: readonly Entry[], order: SortOrder = 'default'): Entry[] {
  return [...entries].sort((a, b) => {
    if (order === 'default' && a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
    return compareFileNamesDefault(a.name, b.name)
  })
}

/** What main sends for a folder: the entries without the excluded names, in the explorer's order. */
export function listing(raw: readonly Entry[], order: SortOrder = 'default'): Entry[] {
  return sortEntries(raw.filter(e => !isExcluded(e.name)), order)
}

// ---------- paths ----------

/** The separator a path uses: a Windows path (a drive or a UNC share) has backslashes. */
export function sepOf(path: string): '\\' | '/' { return /^([A-Za-z]:|\\\\)/.test(path) ? '\\' : '/' }

/** `dir` + `name` with `dir`'s separator (no doubling after a drive root such as `C:\`). */
export function joinPath(dir: string, name: string): string {
  const sep = sepOf(dir)
  return dir.endsWith('\\') || dir.endsWith('/') ? dir + name : dir + sep + name
}

/** The folder holding `path` (the path itself for a root with no parent). */
export function parentPath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const i = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  if (i < 0) return path
  const parent = trimmed.slice(0, i)
  return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent === '' ? '/' : parent
}

const norm = (p: string, ci: boolean): string => { const k = p.replace(/[\\/]+/g, '/').replace(/\/$/, ''); return ci ? k.toLowerCase() : k }

/** Whether `dir` is one of `roots` or inside one (main only reads inside the projects the renderer announced). */
export function isInsideAny(roots: readonly string[], dir: string, caseInsensitive: boolean): boolean {
  const d = norm(dir, caseInsensitive)
  if (d.split('/').includes('..')) return false
  return roots.some(r => { const k = norm(r, caseInsensitive); return d === k || d.startsWith(k + '/') || (k === '' && d.startsWith('/')) })
}

/** Whether two paths are the same one (separators and, where the system ignores case, case do not matter). */
export function samePath(a: string, b: string, caseInsensitive: boolean): boolean { return norm(a, caseInsensitive) === norm(b, caseInsensitive) }

/**
 * The folders to open so `file` shows in the tree under `root`: the root, then each folder down to the file's parent, in order.
 * Empty when the file is not inside the root (or is the root itself).
 */
export function revealChain(root: string, file: string, caseInsensitive: boolean): string[] {
  const r = norm(root, caseInsensitive)
  const f = norm(file, caseInsensitive)
  if (f === r || !f.startsWith(r + '/')) return []
  const rest = norm(file, false).slice(r.length + 1).split('/')
  const chain = [root]
  let dir = root
  for (const name of rest.slice(0, -1)) { dir = joinPath(dir, name); chain.push(dir) }
  return chain
}

// ---------- expanded state ----------

/** What the pad keeps in layout.json (`serialize`): per project root, the folders expanded under it (the root itself included). */
export interface ExplorerState { v: 1; expanded: Record<string, string[]> }

export function emptyState(): ExplorerState { return { v: 1, expanded: {} } }

/** Tolerant: anything that is not the expected shape is dropped, never an error (an older build, a hand edit). */
export function readState(raw: unknown): ExplorerState {
  const out = emptyState()
  if (typeof raw !== 'object' || raw === null) return out
  const expanded = (raw as { expanded?: unknown }).expanded
  if (typeof expanded !== 'object' || expanded === null) return out
  for (const [root, dirs] of Object.entries(expanded)) {
    if (Array.isArray(dirs)) out.expanded[root] = [...new Set(dirs.filter((d): d is string => typeof d === 'string'))]
  }
  return out
}

// ---------- the visible rows and the keyboard ----------

/** What the keyboard needs of a visible row. */
export interface NavRow { level: number; dir: boolean; expanded: boolean }

export type NavAction =
  | { type: 'focus'; index: number }
  | { type: 'expand' | 'collapse' | 'toggle' | 'open' }
  | { type: 'none' }

const NONE: NavAction = { type: 'none' }

/** The row index of the parent of `rows[i]` (the nearest earlier row of a lower level), or -1. */
export function parentIndex(rows: readonly NavRow[], i: number): number {
  const level = rows[i]?.level ?? 0
  for (let j = i - 1; j >= 0; j--) if (rows[j]!.level < level) return j
  return -1
}

/**
 * What a key does on row `i` (VS Code's list/tree keys): ↑/↓ move, Home/End jump, → expands a folder or goes to its first child,
 * ← collapses it or goes to the parent, Enter opens a file or toggles a folder, Space the same (the renderer keeps the focus).
 */
export function navigate(rows: readonly NavRow[], i: number, key: string): NavAction {
  const row = rows[i]
  if (!row) return NONE
  const last = rows.length - 1
  switch (key) {
    case 'ArrowDown': return i < last ? { type: 'focus', index: i + 1 } : NONE
    case 'ArrowUp': return i > 0 ? { type: 'focus', index: i - 1 } : NONE
    case 'Home': return i > 0 ? { type: 'focus', index: 0 } : NONE
    case 'End': return i < last ? { type: 'focus', index: last } : NONE
    case 'ArrowRight':
      if (!row.dir) return NONE
      if (!row.expanded) return { type: 'expand' }
      return rows[i + 1] && rows[i + 1]!.level > row.level ? { type: 'focus', index: i + 1 } : NONE
    case 'ArrowLeft': {
      if (row.dir && row.expanded) return { type: 'collapse' }
      const p = parentIndex(rows, i)
      return p >= 0 ? { type: 'focus', index: p } : NONE
    }
    case 'Enter': case ' ': return row.dir ? { type: 'toggle' } : { type: 'open' }
    default: return NONE
  }
}

/** Visible rows from a project root down, given the expanded folders and the loaded listings (what a full rebuild draws). */
export interface FlatRow { path: string; name: string; level: number; dir: boolean }

export function flatten(
  root: { path: string; name: string },
  expanded: ReadonlySet<string>,
  children: (dir: string) => readonly Entry[] | undefined,
): FlatRow[] {
  const out: FlatRow[] = [{ path: root.path, name: root.name, level: 1, dir: true }]
  const walk = (dir: string, level: number): void => {
    if (!expanded.has(dir)) return
    for (const e of children(dir) ?? []) {
      const path = joinPath(dir, e.name)
      out.push({ path, name: e.name, level, dir: e.kind === 'dir' })
      if (e.kind === 'dir') walk(path, level + 1)
    }
  }
  walk(root.path, 2)
  return out
}

// ---------- type to navigate and paging ----------
// Origin: https://github.com/microsoft/vscode, commit 7faf984945fefaceb533ca1d851697a2e72e4e68 (MIT)
//   src/vs/base/browser/ui/list/listWidget.ts    TypeNavigationController (the 800 ms buffer, a repeated letter cycles, wraps),
//                                                 DOMFocusController-style PageUp/PageDown (first go to the edge of the view, then a page)

/** VS Code resets the typed prefix after this long without a key. */
export const TYPE_AHEAD_RESET_MS = 800

/** True for a key that feeds the prefix: one printable character (a space only joins a prefix already started). */
export function isTypeAheadKey(key: string, buffer: string): boolean {
  if (key.length !== 1) return false
  return key !== ' ' || buffer.length > 0
}

/**
 * The row to jump to when `buffer` was typed with the keyboard on row `from`: the first row (case-insensitive prefix of the name) at
 * or after the current one, wrapping around. A single character (or one letter repeated) starts after the current row, so
 * repeating a letter cycles through the names that start with it. -1 when nothing matches.
 */
export function typeAheadMatch(names: readonly string[], from: number, buffer: string): number {
  const n = names.length
  if (n === 0 || buffer === '') return -1
  const q = buffer.toLowerCase()
  const cycling = [...q].every(c => c === q[0])
  const prefix = cycling ? q[0]! : q
  const start = (cycling && q.length > 0 ? from + 1 : from) % n
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n
    if (names[i]!.toLowerCase().startsWith(prefix)) return i
  }
  // "aa" with no other name starting with "a": a name that really starts with "aa" still counts
  return cycling && q.length > 1 ? names.findIndex(s => s.toLowerCase().startsWith(q)) : -1
}

/**
 * PageUp/PageDown on row `i` with rows `first..last` in view and `page` rows per view: the first press goes to the edge of the
 * view, the next one a page further (VS Code). Always clamped to the list.
 */
export function pageTarget(i: number, count: number, first: number, last: number, page: number, down: boolean): number {
  if (count === 0) return -1
  const step = Math.max(1, page - 1)
  const t = down ? (i < last ? last : i + step) : (i > first ? first : i - step)
  return Math.max(0, Math.min(count - 1, t))
}
