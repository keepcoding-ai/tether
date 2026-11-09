// The empty pane (F5): a place in the layout reserved before deciding what opens there. It has no slot in tetherd
// and no file; its identity is the pane id (a prefix the layout code recognizes, like a note's) and its state is
// what the chooser shown inside it needs (pane params, saved with layout.json): the folder it suggests and where
// the pane came from (`origin`: a "+" / Ctrl+Shift+T / Ctrl+Shift+Arrow is a request in progress, which Esc
// cancels by closing the pane; a pane the person laid out on purpose stays, and Esc only gives the keyboard back).
// When the person picks something, the pane is replaced in the same group, at the same index, by what they chose.
import { isNotePanelId } from './notes.ts'
import { isPreviewPanelId } from './preview.ts'
import { isKeybindingsPanelId } from './keybindings.ts'
import { EXTENSIONS_PANEL_PREFIX } from './extensions-screen.ts'
import { isSettingsPanelId } from './settings-screen.ts'

export const EMPTY_COMPONENT = 'empty'
export const EMPTY_TAB = 'empty-tab'
export const EMPTY_PANEL_PREFIX = 'empty:'
/** What the tab shows. */
export const EMPTY_TITLE = 'Vazio'

/** `add`: born from a "+" (a request; Esc closes the pane). `layout`: placed on purpose (Esc only leaves). Saved panes without one are `layout`. */
export type EmptyOrigin = 'add' | 'layout'

export function isEmptyPanelId(id: string): boolean {
  return id.startsWith(EMPTY_PANEL_PREFIX)
}

/** A pane that has no slot behind it (a note, a markdown preview, an empty pane, the shortcuts, extensions or settings screen): never an orphan for the restore, never pruned. */
export function isSlotlessPanelId(id: string): boolean {
  return isNotePanelId(id) || isEmptyPanelId(id) || isPreviewPanelId(id) || isKeybindingsPanelId(id) || id.startsWith(EXTENSIONS_PANEL_PREFIX) || isSettingsPanelId(id)
}

/** A fresh pane id: time-ordered plus a random tail (two panes in the same millisecond). */
export function newEmptyPanelId(now: number = Date.now(), random: number = Math.random()): string {
  return `${EMPTY_PANEL_PREFIX}${now.toString(36).padStart(9, '0')}-${Math.floor(random * 36 ** 4).toString(36).padStart(4, '0')}`
}

export interface EmptyParams {
  empty: {
    /** The folder suggested by the chooser inside the pane (the folder of the pane it was split from). */
    cwd?: string
    /** Absent in panes saved before the origin existed: those are `layout`. */
    origin?: EmptyOrigin
    /**
     * Still blank: the pane shows the blank view (app/renderer/blank-view.ts) with one action instead of the chooser. The
     * action clears the flag in place, and the chooser takes over. Set where the layout is being drawn (a pad, a new desk,
     * a new frame); a pane the person asks for with "+" or a chord opens straight in the chooser.
     */
    blank?: true
  }
}

/** The empty part of a pane's params, when the pane is an empty one. */
export function emptyParams(params: unknown): EmptyParams['empty'] | undefined {
  if (!params || typeof params !== 'object') return undefined
  const empty = (params as { empty?: unknown }).empty
  if (!empty || typeof empty !== 'object') return undefined
  const { cwd, origin, blank } = empty as { cwd?: unknown; origin?: unknown; blank?: unknown }
  const out: EmptyParams['empty'] = {}
  if (blank === true) out.blank = true
  if (typeof cwd === 'string' && cwd !== '') out.cwd = cwd
  if (origin === 'add') out.origin = 'add'
  return out
}

/** The origin of an empty pane from its params: `layout` unless the pane says `add` (older files have no origin). */
export function emptyOrigin(params: unknown): EmptyOrigin {
  return emptyParams(params)?.origin ?? 'layout'
}

/** The params of a new empty pane. */
export function withEmpty(cwd: string | undefined, origin: EmptyOrigin = 'layout', blank = false): EmptyParams {
  return { empty: { ...(cwd ? { cwd } : {}), ...(origin === 'add' ? { origin } : {}), ...(blank ? { blank: true as const } : {}) } }
}
