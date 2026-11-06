// Dragging a tab from one frame into another, pure (no DOM, no dockview objects). Every frame is its own dockview, so
// dockview moves a tab natively only inside one frame (reorder, another group, a split of the frame); a tab coming from
// another frame is "foreign" to the target dockview, which asks (onUnhandledDragOver) and then reports the drop
// (onDidDrop) instead of moving it. desk.ts accepts those drags and moves the panes itself; these rules say which
// panes move and where each one lands, the same placements dockview's own drops use (VS Code's editor groups:
// the center of a group = a tab of it, an edge = a new group on that side, the tab bar = a tab at that index).

export type DropPosition = 'top' | 'bottom' | 'left' | 'right' | 'center'
export type DropDirection = 'within' | 'left' | 'right' | 'above' | 'below'

/** Where one moved pane goes in the target frame: beside or into a group (by id), or into a pane's group (the ones after the first). */
export type PanePlacement =
  | { referenceGroup: string; direction: DropDirection; index?: number }
  | { referencePanel: string; direction: 'within'; index?: number }

const DIRECTION: Record<DropPosition, DropDirection> = { center: 'within', left: 'left', right: 'right', top: 'above', bottom: 'below' }

/**
 * The panes a drag carries, in order: the dragged tab, or every tab of a dragged group (dragging the empty part of a
 * group's tab bar). Empty when there is nothing to move.
 */
export function draggedPanes(panelId: string | null, groupPanes: readonly string[]): string[] {
  if (panelId !== null) return groupPanes.includes(panelId) ? [panelId] : []
  return [...groupPanes]
}

/**
 * Where each carried pane lands. The first goes where the drop was (a tab of `group` at `index` on its tab bar, a tab
 * of it on its content's center, a new group on an edge); the others follow it as tabs of its group, after it, so a
 * dragged group arrives whole and in order. Undefined when the drop has no group (dockview refuses a foreign tab on a
 * frame's own outer edge, so this does not happen; there is nowhere to put it).
 */
export function dropPlacements(panes: readonly string[], position: DropPosition, group: string | undefined, index: number | undefined): PanePlacement[] | undefined {
  if (group === undefined || panes.length === 0) return undefined
  const direction = DIRECTION[position]
  const first: PanePlacement = direction === 'within' && index !== undefined ? { referenceGroup: group, direction, index } : { referenceGroup: group, direction }
  const rest = panes.slice(1).map((_, i): PanePlacement => {
    const at = direction === 'within' && index !== undefined ? { index: index + i + 1 } : {}
    return { referencePanel: panes[0]!, direction: 'within', ...at }
  })
  return [first, ...rest]
}
