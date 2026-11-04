// The empty pane (F5): a place in the layout reserved before deciding what opens there. It has no slot in tetherd
// and no file; its identity is the pane id (a prefix the layout code recognizes, like a note's) and its only
// state is the folder it suggests to the chooser shown inside it (pane params, saved with layout.json). When the
// person picks something, the pane is replaced in the same group, at the same index, by what they chose.
import { isNotePanelId } from './notes.ts'

export const EMPTY_COMPONENT = 'empty'
export const EMPTY_TAB = 'empty-tab'
export const EMPTY_PANEL_PREFIX = 'empty:'
/** What the tab shows. */
export const EMPTY_TITLE = 'Vazio'

export function isEmptyPanelId(id: string): boolean {
  return id.startsWith(EMPTY_PANEL_PREFIX)
}

/** A pane that has no slot behind it (a note, an empty pane): never an orphan for the restore, never pruned. */
export function isSlotlessPanelId(id: string): boolean {
  return isNotePanelId(id) || isEmptyPanelId(id)
}

/** A fresh pane id: time-ordered plus a random tail (two panes in the same millisecond). */
export function newEmptyPanelId(now: number = Date.now(), random: number = Math.random()): string {
  return `${EMPTY_PANEL_PREFIX}${now.toString(36).padStart(9, '0')}-${Math.floor(random * 36 ** 4).toString(36).padStart(4, '0')}`
}

export interface EmptyParams {
  empty: {
    /** The folder suggested by the chooser inside the pane (the folder of the pane it was split from). */
    cwd?: string
  }
}

/** The empty part of a pane's params, when the pane is an empty one. */
export function emptyParams(params: unknown): EmptyParams['empty'] | undefined {
  if (!params || typeof params !== 'object') return undefined
  const empty = (params as { empty?: unknown }).empty
  if (!empty || typeof empty !== 'object') return undefined
  const cwd = (empty as { cwd?: unknown }).cwd
  return typeof cwd === 'string' && cwd !== '' ? { cwd } : {}
}

/** The params of a new empty pane. */
export function withEmpty(cwd: string | undefined): EmptyParams {
  return { empty: cwd ? { cwd } : {} }
}
