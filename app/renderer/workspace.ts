/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Command } from './commands.ts'

// The window's projects (F8): VS Code's IWorkspaceContextService (the workspace folders) reduced to what tether needs,
// pure and unit-tested; main.ts feeds it the panes and the slots and keeps the result.
// Origin of the ported pieces: https://github.com/microsoft/vscode, commit 7faf984945fefaceb533ca1d851697a2e72e4e68
//   src/vs/platform/workspace/common/workspace.ts               (IWorkspaceFoldersChangeEvent: added / removed / changed)
//   src/vs/workbench/services/configuration/browser/configurationService.ts (compareFolders → `compareFolders` below)
// Left out: URIs (a folder is an absolute path here), multi-window workspaces, `.code-workspace` files, trust.
//
// The rules (tether's, not VS Code's):
//   - A project is INFERRED from an AI agent's pane only (slot kind !== 'shell'), from the folder the agent was opened in
//     (SlotState.cwd). A `cd` inside the terminal is never followed (the slot's cwd does not change with it); a plain
//     terminal infers nothing. Only panes present in the window count (any desk, the drawer, a frames pad), running or not.
//   - An inferred project goes away when no agent pane references it any more.
//   - A PINNED project stays until it is closed (unpinned without agents). Opening a folder = open AND pin, idempotent.
//   - Unpinning a project that agents still reference makes it inferred; pinning an inferred one promotes it in place.
//   - One list in order of arrival, stable: promoting does not move a folder; closing and reopening puts it at the end.

/** A project folder as the window shows it. */
export interface ProjectFolder {
  /** Absolute path, as it arrived (the first spelling seen wins). */
  path: string
  /** `basename`; equal names get their parent's in parentheses ("tether (old)"), like VS Code's labelService. */
  name: string
  pinned: boolean
  /** Ids of the agent panes that reference it (empty for a pinned folder no agent is in). */
  agents: string[]
  missing?: boolean
}

/** What layout.json keeps (`workspace`): the pinned roots, in their order. */
export interface WorkspaceState {
  pinned: { path: string }[]
}

/** A pane as the inference sees it: its id, its slot's kind ('shell', 'claude'…; undefined without a slot) and folder. */
export interface PaneSource {
  id: string
  kind?: string
  cwd?: string
}

/** IWorkspaceFoldersChangeEvent. */
export interface FoldersChangeEvent {
  added: ProjectFolder[]
  removed: ProjectFolder[]
  changed: ProjectFolder[]
}

export const EMPTY_WORKSPACE: WorkspaceState = { pinned: [] }

/** Comparison key of a path: one separator, no trailing one, case folded on case-insensitive file systems (win32, darwin). */
export function pathKey(path: string, caseInsensitive: boolean): string {
  let p = path.replace(/[\\/]+/g, '/')
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1)
  return caseInsensitive ? p.toLowerCase() : p
}

/** The path without trailing separators (a drive root keeps its own: "C:\"). */
function tidy(path: string): string {
  let p = path
  while (p.length > 1 && /[\\/]$/.test(p) && !/^[A-Za-z]:[\\/]$/.test(p)) p = p.slice(0, -1)
  return p
}

function baseName(path: string): string {
  const parts = tidy(path).split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? path
}

function parentName(path: string): string {
  const parts = tidy(path).split(/[\\/]/).filter(Boolean)
  return parts.at(-2) ?? ''
}

/** The agent panes that infer a project: a slot of a kind other than 'shell', with a folder. */
export function agentPanes(panes: readonly PaneSource[]): { id: string; cwd: string }[] {
  return panes.filter(p => p.kind !== undefined && p.kind !== 'shell' && !!p.cwd).map(p => ({ id: p.id, cwd: p.cwd! }))
}

/**
 * The folders now: every pinned root and every folder an agent pane references. Order of arrival: the folders of `prev`
 * that are still there keep their place; new ones go at the end, pinned roots (in their saved order) before inferred ones
 * (in pane order). A folder that is neither pinned nor referenced is dropped.
 */
export function deriveFolders(prev: readonly ProjectFolder[], state: WorkspaceState, panes: readonly PaneSource[], caseInsensitive: boolean): ProjectFolder[] {
  const byKey = new Map<string, { path: string; pinned: boolean; agents: string[] }>()
  const order: string[] = []
  const touch = (path: string): { path: string; pinned: boolean; agents: string[] } => {
    const key = pathKey(path, caseInsensitive)
    let f = byKey.get(key)
    if (!f) { f = { path: tidy(path), pinned: false, agents: [] }; byKey.set(key, f); order.push(key) }
    return f
  }
  for (const p of state.pinned) touch(p.path).pinned = true
  for (const a of agentPanes(panes)) touch(a.cwd).agents.push(a.id)
  // prev's order first (its spelling too), then what is new.
  const prevKeys = prev.map(f => pathKey(f.path, caseInsensitive)).filter(k => byKey.has(k))
  for (const f of prev) { const live = byKey.get(pathKey(f.path, caseInsensitive)); if (live) live.path = f.path }
  const keys = [...prevKeys, ...order.filter(k => !prevKeys.includes(k))]
  const list = keys.map(k => byKey.get(k)!)
  const counts = new Map<string, number>()
  for (const f of list) { const n = baseName(f.path).toLowerCase(); counts.set(n, (counts.get(n) ?? 0) + 1) }
  return list.map(f => {
    const base = baseName(f.path)
    const parent = parentName(f.path)
    const name = (counts.get(base.toLowerCase()) ?? 0) > 1 && parent ? `${base} (${parent})` : base
    return { path: f.path, name, pinned: f.pinned, agents: f.agents }
  })
}

function indexOfPinned(state: WorkspaceState, path: string, caseInsensitive: boolean): number {
  const key = pathKey(path, caseInsensitive)
  return state.pinned.findIndex(p => pathKey(p.path, caseInsensitive) === key)
}

/** "Abrir pasta": the folder is pinned afterwards. Idempotent: an already pinned folder returns the very same state. */
export function openFolder(state: WorkspaceState, path: string, caseInsensitive: boolean): WorkspaceState {
  if (!path.trim() || indexOfPinned(state, path, caseInsensitive) !== -1) return state
  return { pinned: [...state.pinned, { path: tidy(path) }] }
}

/** Unpins a folder (a no-op, the same state, when it is not pinned). Whether it stays (inferred) is deriveFolders' call. */
export function unpinFolder(state: WorkspaceState, path: string, caseInsensitive: boolean): WorkspaceState {
  const i = indexOfPinned(state, path, caseInsensitive)
  if (i === -1) return state
  return { pinned: state.pinned.filter((_, j) => j !== i) }
}

/** The pin toggle: a pinned folder is unpinned, any other (inferred, or a path not yet a project) is pinned. */
export function togglePin(state: WorkspaceState, path: string, caseInsensitive: boolean): WorkspaceState {
  return indexOfPinned(state, path, caseInsensitive) === -1 ? openFolder(state, path, caseInsensitive) : unpinFolder(state, path, caseInsensitive)
}

/** A folder one place up or down the list (the list order is the window's; the pinned order follows it). */
export function moveFolder(folders: readonly ProjectFolder[], path: string, dir: 'up' | 'down', caseInsensitive: boolean): ProjectFolder[] {
  const key = pathKey(path, caseInsensitive)
  const i = folders.findIndex(f => pathKey(f.path, caseInsensitive) === key)
  const j = dir === 'up' ? i - 1 : i + 1
  if (i === -1 || j < 0 || j >= folders.length) return [...folders]
  const out = [...folders]
  ;[out[i], out[j]] = [out[j]!, out[i]!]
  return out
}

/** The pinned roots in the order the list shows them (what layout.json keeps after a move). */
export function pinnedInOrder(folders: readonly ProjectFolder[]): WorkspaceState {
  return { pinned: folders.filter(f => f.pinned).map(f => ({ path: f.path })) }
}

/** The project that contains a path (itself or an ancestor); the innermost one when projects nest. */
export function folderOf(folders: readonly ProjectFolder[], absPath: string | undefined, caseInsensitive: boolean): ProjectFolder | undefined {
  if (!absPath) return undefined
  const k = pathKey(absPath, caseInsensitive)
  let best: ProjectFolder | undefined
  let bestLen = -1
  for (const f of folders) {
    const fk = pathKey(f.path, caseInsensitive)
    const inside = k === fk || k.startsWith(fk.endsWith('/') ? fk : `${fk}/`)
    if (inside && fk.length > bestLen) { best = f; bestLen = fk.length }
  }
  return best
}

/** The project "seguir" moves to for the active pane: only an agent pane's; a shell, a note, a preview move nothing. */
export function followTarget(active: { agent?: string; cwd?: string } | undefined, folders: readonly ProjectFolder[], caseInsensitive: boolean): string | undefined {
  if (!active?.agent || !active.cwd) return undefined
  return folderOf(folders, active.cwd, caseInsensitive)?.path
}

/** layout.json's `workspace`, read with tolerance: anything malformed is dropped (absent = nothing pinned). */
export function readWorkspace(raw: unknown): WorkspaceState {
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { pinned?: unknown }).pinned)) return EMPTY_WORKSPACE
  const pinned: { path: string }[] = []
  for (const p of (raw as { pinned: unknown[] }).pinned) {
    const path = typeof p === 'string' ? p : typeof p === 'object' && p !== null ? (p as { path?: unknown }).path : undefined
    if (typeof path === 'string' && path.trim() && !pinned.some(q => q.path === path)) pinned.push({ path })
  }
  return { pinned }
}

/** Ported from configurationService.compareFolders: what an update added, removed, and changed (moved or renamed). */
export function compareFolders(current: readonly ProjectFolder[], next: readonly ProjectFolder[], caseInsensitive: boolean): FoldersChangeEvent {
  const key = (f: ProjectFolder): string => pathKey(f.path, caseInsensitive)
  const result: FoldersChangeEvent = { added: [], removed: [], changed: [] }
  result.added = next.filter(n => !current.some(c => key(n) === key(c)))
  for (let currentIndex = 0; currentIndex < current.length; currentIndex++) {
    const currentFolder = current[currentIndex]!
    let newIndex = 0
    for (newIndex = 0; newIndex < next.length && key(currentFolder) !== key(next[newIndex]!); newIndex++) { /* find it */ }
    if (newIndex < next.length) {
      const n = next[newIndex]!
      // tether's folders also change when they are pinned/unpinned or their agents change.
      if (currentIndex !== newIndex || currentFolder.name !== n.name || currentFolder.pinned !== n.pinned || currentFolder.agents.join() !== n.agents.join()) result.changed.push(n)
    } else {
      result.removed.push(currentFolder)
    }
  }
  return result
}

export function isEmptyChange(e: FoldersChangeEvent): boolean {
  return e.added.length === 0 && e.removed.length === 0 && e.changed.length === 0
}

// ---------- the palette's commands ----------

export interface WorkspaceCommandHost {
  /** "Abrir pasta como projeto…": the native folder picker, then open (and pin) what was picked. */
  pickAndOpen(): void
  /** The project the pin toggle acts on: the active pane's, else the current one; undefined when there is none. */
  toggleTarget(): ProjectFolder | undefined
  togglePin(path: string): void
}

export const WORKSPACE_GROUP = 'Projetos'

export function workspaceCommands(host: WorkspaceCommandHost): Command[] {
  return [
    { id: 'workspace.open-folder', title: 'Abrir pasta como projeto…', group: WORKSPACE_GROUP, icon: 'folder-open', run: () => host.pickAndOpen() },
    {
      id: 'workspace.toggle-pin', title: 'Fixar/Desafixar projeto', group: WORKSPACE_GROUP, icon: 'push-pin',
      when: () => host.toggleTarget() !== undefined,
      run: () => { const f = host.toggleTarget(); if (f) host.togglePin(f.path) },
    },
  ]
}
