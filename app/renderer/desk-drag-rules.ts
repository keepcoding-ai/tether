// Pure rules of dragging a desk segment in the capsule (gesture in desk-switch.ts).
import { moveDesk } from './desks.ts'

/** Movement (px, either axis) below which a press is still a click, not a drag. */
export const DRAG_THRESHOLD_PX = 4

/** Whether a press that moved (dx, dy) has become a drag. */
export function passedThreshold(dx: number, dy: number): boolean {
  return Math.abs(dx) >= DRAG_THRESHOLD_PX || Math.abs(dy) >= DRAG_THRESHOLD_PX
}

/**
 * Visible index the dragged segment would take. `centers` are the segments' resting centres (row order), `x` is
 * the dragged segment's current centre: it passes a neighbour once its centre crosses that neighbour's centre.
 */
export function dragTargetIndex(centers: readonly number[], fromIndex: number, x: number): number {
  const n = centers.length
  if (n === 0) return 0
  let to = Math.max(0, Math.min(n - 1, fromIndex))
  while (to < n - 1 && x > centers[to + 1]!) to++
  while (to > 0 && x < centers[to - 1]!) to--
  return to
}

/**
 * The `to` for `moveDesk(order, id, to)` after dropping `id` at `visibleIndex` of the visible row (`visible` is
 * the row as it was before the drag). The desk lands right after the visible neighbour on its left in the full
 * queue, or at 0 when dropped before every visible desk; hidden desks are never crossed blindly.
 */
export function fullIndexAfterDrop(order: readonly string[], visible: readonly string[], id: string, visibleIndex: number): number {
  const row = visible.filter(v => v !== id)
  const at = Math.max(0, Math.min(row.length, visibleIndex))
  const left = row[at - 1]
  if (left === undefined) return 0
  const rest = order.filter(o => o !== id)
  const i = rest.indexOf(left)
  return i < 0 ? 0 : i + 1
}

/** Keeps the dragged segment inside the row. */
export function clampDragX(x: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, x))
}

/** Used by tests: the order after the drop, through the same `moveDesk` the host uses. */
export function orderAfterDrop(order: readonly string[], visible: readonly string[], id: string, visibleIndex: number): string[] {
  const to = fullIndexAfterDrop(order, visible, id, visibleIndex)
  return moveDesk(order.map(i => ({ id: i }) as never), id, to).map(d => (d as { id: string }).id)
}
