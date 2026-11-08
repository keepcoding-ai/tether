// The two ways a panel is born, as pure data (unit-tested; the renderer wires them to the UI):
//   - "Novo painel…" (`choose`): the chooser dialog decides profile, folder and where;
//   - "Duplicar painel" (`duplicate`): a new slot with the focused panel's agent, profile and folder, placed
//     relative to it. It is a NEW session (the daemon's `create` never carries a binding): the conversation
//     of the source panel is not shared, only the way it was launched.
// "Where" has three levels (app/renderer/shortcuts.ts holds the chords): beside the pane, at the edge of the
// pane's frame (the new pane takes the frame's whole height or width), or in a new frame at the desk's edge.
import type { Profile, Request, SlotState } from '../../src/daemon/protocol.ts'
import { type Level, LEVELS } from './shortcuts.ts'

export { shortcutOf, type KeyLike, type Level } from './shortcuts.ts'

/** Where a new panel goes, relative to a reference panel (dockview's own words). */
export type Direction = 'left' | 'right' | 'above' | 'below'
export type Placement = Direction | 'within'

export const DIRECTIONS: readonly Direction[] = ['left', 'right', 'above', 'below']
export const PLACEMENTS: readonly Placement[] = ['within', ...DIRECTIONS]

/** A placement at a level: `within` only exists at the pane level (a tab in the pane's group). */
export interface Target { level: Level; placement: Placement }

/** Every target the chooser offers, grouped by level, in reading order. */
export const TARGETS: readonly Target[] = LEVELS.flatMap(level =>
  (level === 'pane' ? PLACEMENTS : DIRECTIONS).map(placement => ({ level, placement })))

/** What the user reads for each placement (the chooser's "Onde" row, menu entries, tooltips). */
export const PLACEMENT_LABEL: Record<Placement, string> = {
  within: 'nesta aba',
  left: 'à esquerda',
  right: 'à direita',
  above: 'acima',
  below: 'abaixo',
}

/** The level as the user reads it, in the chooser's "Onde" groups. */
export const LEVEL_LABEL: Record<Level, string> = { pane: 'Painel', frame: 'Quadro', desk: 'Mesa' }

/** What each level means, next to its label in the chooser. */
export const LEVEL_HINT: Record<Level, string> = {
  pane: 'ao lado do painel',
  frame: 'na borda do quadro, ocupando a altura ou a largura inteira',
  desk: 'num quadro novo, na borda da mesa',
}

/** The two operations as the user reads them (toolbar, menus, tooltips). */
export const NEW_PANEL_LABEL = 'Novo painel…'
/** Ctrl+Shift+T and the "+" of a group's tab strip: an empty pane as a new tab, the chooser inside it. */
export const NEW_TAB_LABEL = 'Nova aba'
export const DUPLICATE_LABEL = 'Duplicar painel'
export const NEW_FRAME_LABEL = 'Novo quadro'
/** The empty pane (app/shared/empty.ts): "Dividir à direita (vazio)", "Novo quadro vazio à direita", "Nova mesa vazia". */
export const SPLIT_EMPTY_LABEL = 'Dividir'
export const EMPTY_SUFFIX = '(vazio)'
export const NEW_EMPTY_FRAME_LABEL = 'Novo quadro vazio'
export const NEW_EMPTY_DESK_LABEL = 'Nova mesa vazia'

/** The arrow glyph of a direction, for shortcut hints ("Ctrl+Alt+→"). */
export const DIRECTION_ARROW: Record<Direction, string> = { left: '←', right: '→', above: '↑', below: '↓' }

/** `level:placement`, the value of a chooser radio; the inverse is `targetOf`. */
export function targetKey(t: Target): string { return `${t.level}:${t.placement}` }

/** The target a radio value names, or undefined for anything that is not one. */
export function targetOf(key: string | undefined): Target | undefined {
  return TARGETS.find(t => targetKey(t) === key)
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
