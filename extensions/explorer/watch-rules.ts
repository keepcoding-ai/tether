/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The explorer watcher's pure rules (F8 slice 3), read by the main side: which disk events are ignored, how a burst of events
// is normalized (coalesced), and which folders a burst touched. No Node, no DOM.
// Origin: https://github.com/microsoft/vscode, commit 7faf984945fefaceb533ca1d851697a2e72e4e68
//   src/vs/platform/files/common/watcher.ts                              EventCoalescer / coalesceEvents (+ isParent from files.ts)
//   src/vs/workbench/contrib/files/browser/files.contribution.ts         the default `files.watcherExclude`
// Changes: the event is `{ type, path }` with a string type instead of IFileChange (URI + FileChangeType enum); the
// coalescer copies the events it keeps instead of mutating the caller's; case sensitivity is a parameter instead of the
// `isLinux` constant; `isParent` works on slash-normalized paths; the exclude patterns are matched by a small segment matcher
// instead of the glob engine (every default is `**/<segments>/**`); `node_modules/*/**` is VS Code's later default for
// node_modules; formatting and comments are this project's.

import { isExcluded, parentPath } from './tree-rules.ts'

/** What happened to a path, as the coalescer sees it (VS Code's FileChangeType). */
export type ChangeType = 'updated' | 'added' | 'deleted'

export interface FileChange { type: ChangeType; path: string }

const slashes = (p: string): string => p.replace(/[\\/]+/g, '/')
const trim = (p: string): string => slashes(p).replace(/\/$/, '')

/** The key two spellings of one path share (separators; case where the system ignores it). */
export function pathKey(p: string, caseInsensitive: boolean): string { const k = trim(p); return caseInsensitive ? k.toLowerCase() : k }

/** files.ts isParent: `path` lies strictly below `candidate`. */
export function isParent(path: string, candidate: string, caseInsensitive: boolean): boolean {
  const a = trim(path)
  const b = trim(candidate)
  if (!a || !b || a === b || b.length > a.length) return false
  return caseInsensitive ? a.toLowerCase().startsWith(b.toLowerCase() + '/') : a.startsWith(b + '/')
}

// ---------- coalescing (watcher.ts EventCoalescer) ----------

class EventCoalescer {
  private readonly coalesced = new Set<FileChange>()
  private readonly byPath = new Map<string, FileChange>()

  private readonly caseInsensitive: boolean

  constructor(caseInsensitive: boolean) { this.caseInsensitive = caseInsensitive }

  processEvent(raw: FileChange): void {
    const event = { ...raw }
    const key = pathKey(event.path, this.caseInsensitive)
    const existing = this.byPath.get(key)
    let keep = false
    if (existing) {
      const current = existing.type
      const next = event.type
      // Case-insensitive systems: a rename to another case is a DELETE and an ADD of the same key; both stay.
      if (existing.path !== event.path && (next === 'deleted' || next === 'added')) keep = true
      // CREATE followed by DELETE in one go: nothing happened.
      else if (current === 'added' && next === 'deleted') { this.byPath.delete(key); this.coalesced.delete(existing) }
      // DELETE followed by CREATE (an atomic save): the path was updated.
      else if (current === 'deleted' && next === 'added') existing.type = 'updated'
      // CREATE then UPDATE: still a create.
      else if (current === 'added' && next === 'updated') { /* keep the created event */ }
      else existing.type = next
    } else keep = true
    if (keep) { this.coalesced.add(event); this.byPath.set(key, event) }
  }

  coalesce(): FileChange[] {
    const addOrChange: FileChange[] = []
    const deletedPaths: string[] = []
    // A deleted folder is one DELETE: the DELETEs of everything below it are dropped (shortest paths first).
    return [...this.coalesced]
      .filter(e => { if (e.type !== 'deleted') { addOrChange.push(e); return false } return true })
      .sort((a, b) => a.path.length - b.path.length)
      .filter(e => {
        if (deletedPaths.some(d => isParent(e.path, d, this.caseInsensitive))) return false
        deletedPaths.push(e.path)
        return true
      })
      .concat(addOrChange)
  }
}

/** Normalizes a burst of events: CREATE+DELETE vanishes, DELETE+CREATE is an update, the DELETEs below a deleted folder go. */
export function coalesceEvents(changes: readonly FileChange[], caseInsensitive: boolean): FileChange[] {
  const coalescer = new EventCoalescer(caseInsensitive)
  for (const c of changes) coalescer.processEvent(c)
  return coalescer.coalesce()
}

// ---------- what is not watched (files.watcherExclude) ----------

/**
 * VS Code's default `files.watcherExclude` (`.git/objects/**`, `.git/subtree-cache/**`, `.hg/store/**`, each also as `*` + `/…`
 * for the nested case, which `**` + `/` covers here) plus its later `node_modules/*` + `/**`. `<pattern>/**` means "at least one
 * more segment below", so a package folder itself still shows up in an expanded node_modules while what changes inside it does not.
 */
export const DEFAULT_WATCHER_EXCLUDE: readonly string[] = ['**/.git/objects/**', '**/.git/subtree-cache/**', '**/.hg/store/**', '**/node_modules/*/**']

interface Matcher { tokens: string[]; needsBelow: boolean }

/** `**` + `/a/*` + `/**` → tokens [a, *] anywhere in the path with something below; only this shape is supported. */
export function compileExclude(pattern: string): Matcher {
  let parts = slashes(pattern).split('/').filter(Boolean)
  if (parts[0] === '**') parts = parts.slice(1)
  const needsBelow = parts[parts.length - 1] === '**'
  if (needsBelow) parts = parts.slice(0, -1)
  return { tokens: parts, needsBelow }
}

const COMPILED = new Map<string, Matcher[]>()
function matchers(patterns: readonly string[]): Matcher[] {
  const id = patterns.join('\n')
  let m = COMPILED.get(id)
  if (!m) { m = patterns.map(compileExclude); COMPILED.set(id, m) }
  return m
}

/** Whether the segments (relative to the watched project) match an exclude pattern anywhere along the path. */
export function matchesExclude(segments: readonly string[], patterns: readonly string[], caseInsensitive: boolean): boolean {
  const eq = (a: string, b: string): boolean => caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b
  for (const { tokens, needsBelow } of matchers(patterns)) {
    const need = tokens.length + (needsBelow ? 1 : 0)
    for (let i = 0; i + need <= segments.length; i++) {
      if (tokens.every((t, j) => t === '*' || eq(t, segments[i + j]!))) return true
    }
  }
  return false
}

/** The path's segments below `root` (empty when it is not inside it). */
export function segmentsBelow(root: string, path: string, caseInsensitive: boolean): string[] {
  const r = pathKey(root, caseInsensitive)
  const p = pathKey(path, caseInsensitive)
  if (p === r || !p.startsWith(r + '/')) return []
  return trim(path).slice(r.length + 1).split('/')
}

/**
 * Whether a disk event under `root` is ignored: it lies on a path `watcherExclude` names, or on a name the tree never lists
 * (`.git`, Thumbs.db: the tree's own `files.exclude`), so no listing can have changed.
 */
export function isIgnoredChange(root: string, path: string, caseInsensitive: boolean, patterns: readonly string[] = DEFAULT_WATCHER_EXCLUDE): boolean {
  const segments = segmentsBelow(root, path, caseInsensitive)
  if (segments.some(isExcluded)) return true
  return matchesExclude(segments, patterns, caseInsensitive)
}

// ---------- which folders a burst touched ----------

/**
 * The folders whose listing may have changed: the parent of every added or deleted path. An update changes no listing (an entry
 * is a name and a kind), so it touches nothing. One entry per folder, however many files changed in it.
 */
export function affectedDirs(changes: readonly FileChange[], caseInsensitive: boolean): string[] {
  const out = new Map<string, string>()
  for (const c of changes) {
    if (c.type === 'updated') continue
    const dir = parentPath(c.path)
    const key = pathKey(dir, caseInsensitive)
    if (!out.has(key)) out.set(key, dir)
  }
  return [...out.values()]
}
