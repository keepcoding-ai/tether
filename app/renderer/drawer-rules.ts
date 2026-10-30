// The drawer's rules as pure data (unit-tested; app/renderer/drawer.ts and main.ts wire them to the DOM):
//   - the open/closed state and where the focus returns to;
//   - the Esc rule: who owns an Esc key inside the drawer;
//   - which shell the drawer opens when it is empty.
import type { SlotKind } from '../../src/daemon/protocol.ts'

// ---------- open / closed, and the focus to give back ----------

export interface DrawerState {
  open: boolean
  /** The pane that had the keyboard when the drawer opened; it gets it back on close (if it is still around). */
  returnTo: string | undefined
}

export const CLOSED: DrawerState = { open: false, returnTo: undefined }

/** Opens the drawer remembering the pane in focus; already open: nothing changes (the first memory stands). */
export function openDrawer(state: DrawerState, focusedPane: string | undefined): DrawerState {
  return state.open ? state : { open: true, returnTo: focusedPane }
}

export function closeDrawer(state: DrawerState): DrawerState {
  return state.open ? { open: false, returnTo: state.returnTo } : state
}

export function toggleDrawer(state: DrawerState, focusedPane: string | undefined): DrawerState {
  return state.open ? closeDrawer(state) : openDrawer(state, focusedPane)
}

/**
 * The pane that gets the keyboard back: the remembered one while it still exists (and was not moved into the
 * drawer meanwhile), else the active pane of the desk behind.
 */
export function focusAfterClose(returnTo: string | undefined, onDesks: (slotId: string) => boolean, fallback: string | undefined): string | undefined {
  return returnTo && onDesks(returnTo) ? returnTo : fallback
}

// ---------- Esc ----------

/** Two Esc within this many ms (in a shell at its prompt) close the drawer. */
export const DOUBLE_ESC_MS = 600

/**
 * What an Esc inside the drawer means:
 *   close  the drawer closes and the key is swallowed;
 *   arm    the key goes to the program as usual and counts as the first of a double Esc;
 *   pass   the key is the program's (or somebody else's): the drawer does nothing.
 *
 * Esc belongs to the programs: Claude uses it to interrupt (and twice to rewind), vim and less to leave a mode.
 *   - not in a terminal (the drawer's header, an empty drawer, a button): Esc closes;
 *   - an agent (Claude, soul): never; Ctrl+` and the close button are the way out;
 *   - a shell on the alternate screen or with mouse tracking (vim, less, htop): never;
 *   - a shell at its prompt: the first Esc reaches the shell (harmless there), a second one within DOUBLE_ESC_MS closes.
 */
export interface EscInput {
  open: boolean
  /** A dialog, a menu or an editor field is up: its Esc is its own. */
  blocked: boolean
  focus: { in: 'chrome' } | { in: 'terminal'; kind: SlotKind; programOwnsScreen: boolean }
  now: number
  /** When the previous armed Esc happened. */
  lastEsc: number | undefined
}

export type EscAction = 'close' | 'arm' | 'pass'

export function escAction(input: EscInput): EscAction {
  if (!input.open || input.blocked) return 'pass'
  if (input.focus.in === 'chrome') return 'close'
  if (input.focus.kind !== 'shell' || input.focus.programOwnsScreen) return 'pass'
  return input.lastEsc !== undefined && input.now - input.lastEsc <= DOUBLE_ESC_MS ? 'close' : 'arm'
}

// ---------- the shell an empty drawer opens ----------

/**
 * The folder for the drawer's default shell: where the user is working (the pane in focus), else the shell
 * profile's folder, else the most recent folder. Undefined when none is known (the chooser opens instead).
 */
export function quickCwd(sources: { paneCwd?: string; profileCwd?: string; recent?: string }): string | undefined {
  for (const c of [sources.paneCwd, sources.profileCwd, sources.recent]) if (c && c.trim()) return c
  return undefined
}

// ---------- attention ----------

/** How many panes finished / wait for the user, from their attention values (the drawer button's badge). */
export function countAttention(values: Iterable<'done' | 'waiting' | undefined>): { done: number; waiting: number } {
  const out = { done: 0, waiting: 0 }
  for (const v of values) { if (v === 'done') out.done++; else if (v === 'waiting') out.waiting++ }
  return out
}
