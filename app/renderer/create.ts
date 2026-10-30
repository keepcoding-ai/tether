// The two ways a panel is born, as pure data (unit-tested; the renderer wires them to the UI):
//   - "Novo painel…" (`choose`): the chooser dialog decides profile, folder and placement;
//   - "Duplicar painel" (`duplicate`): a new slot with the focused panel's agent, profile and folder, placed
//     beside it in a direction. It is a NEW session (the daemon's `create` never carries a binding): the
//     conversation of the source panel is not shared, only the way it was launched.
// Shortcuts: Ctrl+Alt+Arrow duplicates beside the focused panel; Ctrl+Shift+D / Ctrl+Shift+E stay as the
// older aliases for right / below; Ctrl+Shift+T opens the chooser; Ctrl+Shift+Q is "Sair e encerrar tudo".
import type { Profile, Request, SlotState } from '../../src/daemon/protocol.ts'

/** Where a new panel goes, relative to a reference panel (dockview's own words). */
export type Direction = 'left' | 'right' | 'above' | 'below'
export type Placement = Direction | 'within'

export const DIRECTIONS: readonly Direction[] = ['left', 'right', 'above', 'below']
export const PLACEMENTS: readonly Placement[] = ['within', ...DIRECTIONS]

/** What the user reads for each placement (the chooser's "Onde" row, menu entries, tooltips). */
export const PLACEMENT_LABEL: Record<Placement, string> = {
  within: 'nesta aba',
  left: 'à esquerda',
  right: 'à direita',
  above: 'acima',
  below: 'abaixo',
}

/** The two operations as the user reads them (toolbar, menus, tooltips). */
export const NEW_PANEL_LABEL = 'Novo painel…'
export const DUPLICATE_LABEL = 'Duplicar painel'

/** The arrow glyph of a direction, for shortcut hints ("Ctrl+Alt+→"). */
export const DIRECTION_ARROW: Record<Direction, string> = { left: '←', right: '→', above: '↑', below: '↓' }

export type AppShortcut =
  | { op: 'choose' }
  | { op: 'duplicate'; direction: Direction }
  | { op: 'quit-all' }

/** The subset of KeyboardEvent the mapping needs (tests build it by hand). */
export interface KeyLike { ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean; code: string }

const ARROW_DIRECTION: Record<string, Direction> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'above', ArrowDown: 'below' }

/**
 * The app command a key chord means, or undefined when it is not one of ours (the terminal keeps the key).
 * Meta (Win) is never part of an app chord: Ctrl+Win+Arrow is reserved for the frame level, and the OS owns
 * most Win chords anyway.
 */
export function shortcutOf(ev: KeyLike): AppShortcut | undefined {
  if (!ev.ctrlKey || ev.metaKey) return undefined
  if (ev.altKey && !ev.shiftKey) {
    const direction = ARROW_DIRECTION[ev.code]
    return direction ? { op: 'duplicate', direction } : undefined
  }
  if (ev.shiftKey && !ev.altKey) {
    switch (ev.code) {
      case 'KeyT': return { op: 'choose' }
      case 'KeyD': return { op: 'duplicate', direction: 'right' }
      case 'KeyE': return { op: 'duplicate', direction: 'below' }
      case 'KeyQ': return { op: 'quit-all' }
    }
  }
  return undefined
}

/**
 * The `create` body that duplicates a panel: same agent, same folder, same profile when it still exists
 * (a profile that was deleted leaves the new slot with no profile: the source keeps only a snapshot of the
 * old args, which the daemon does not take on `create`). No binding, no name: a fresh session with the
 * daemon's own naming.
 */
export function duplicateRequest(slot: SlotState, profiles: readonly Profile[]): Omit<Extract<Request, { t: 'create' }>, 'id'> {
  const profileId = slot.profileId && profiles.some(p => p.id === slot.profileId) ? slot.profileId : undefined
  return { t: 'create', kind: slot.kind, cwd: slot.cwd, start: true, ...(profileId ? { profileId } : {}) }
}

/** dockview's `position` for a placement relative to a panel. */
export function positionOf(referencePanel: string, placement: Placement): { referencePanel: string; direction: Placement } {
  return { referencePanel, direction: placement }
}
