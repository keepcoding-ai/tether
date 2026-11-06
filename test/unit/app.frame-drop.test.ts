// The tab drag between frames (app/renderer/frame-drop-rules.ts), pure: which panes a drag carries and where each lands.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deskDropZone, draggedPanes, dropPlacements } from '../../app/renderer/frame-drop-rules.ts'

test('draggedPanes: the dragged tab, or the whole group in order', () => {
  assert.deepEqual(draggedPanes('b', ['a', 'b', 'c']), ['b'])
  assert.deepEqual(draggedPanes(null, ['a', 'b', 'c']), ['a', 'b', 'c'])
  assert.deepEqual(draggedPanes('x', ['a']), [], 'a tab no longer in its group moves nothing')
  assert.deepEqual(draggedPanes(null, []), [])
})

test('dropPlacements: center = tab of the group, edges = new group on that side, tab bar = index', () => {
  assert.deepEqual(dropPlacements(['a'], 'center', 'g1', undefined), [{ referenceGroup: 'g1', direction: 'within' }])
  assert.deepEqual(dropPlacements(['a'], 'center', 'g1', 2), [{ referenceGroup: 'g1', direction: 'within', index: 2 }])
  assert.deepEqual(dropPlacements(['a'], 'left', 'g1', undefined), [{ referenceGroup: 'g1', direction: 'left' }])
  assert.deepEqual(dropPlacements(['a'], 'right', 'g1', undefined), [{ referenceGroup: 'g1', direction: 'right' }])
  assert.deepEqual(dropPlacements(['a'], 'top', 'g1', undefined), [{ referenceGroup: 'g1', direction: 'above' }])
  assert.deepEqual(dropPlacements(['a'], 'bottom', 'g1', undefined), [{ referenceGroup: 'g1', direction: 'below' }])
})

test('dropPlacements: a dragged group arrives whole, the others as tabs after the first', () => {
  assert.deepEqual(dropPlacements(['a', 'b', 'c'], 'right', 'g1', undefined), [
    { referenceGroup: 'g1', direction: 'right' },
    { referencePanel: 'a', direction: 'within' },
    { referencePanel: 'a', direction: 'within' },
  ])
  assert.deepEqual(dropPlacements(['a', 'b'], 'center', 'g1', 1), [
    { referenceGroup: 'g1', direction: 'within', index: 1 },
    { referencePanel: 'a', direction: 'within', index: 2 },
  ])
})

test('dropPlacements: no group or nothing carried = nowhere to put it', () => {
  assert.equal(dropPlacements(['a'], 'left', undefined, undefined), undefined)
  assert.equal(dropPlacements([], 'center', 'g1', undefined), undefined)
})

test('deskDropZone: the outer edge of a place (top only its gutter), then an empty frame, else nothing', () => {
  const place = { left: 100, top: 50, width: 800, height: 600 }
  assert.deepEqual(deskDropZone(place, 105, 300, undefined), { kind: 'edge', side: 'left' })
  assert.deepEqual(deskDropZone(place, 890, 300, undefined), { kind: 'edge', side: 'right' })
  assert.deepEqual(deskDropZone(place, 500, 640, undefined), { kind: 'edge', side: 'bottom' })
  assert.deepEqual(deskDropZone(place, 500, 55, undefined), { kind: 'edge', side: 'top' })
  assert.equal(deskDropZone(place, 500, 70, undefined), undefined, 'below the top gutter: the tab bars belong to the frames')
  assert.deepEqual(deskDropZone(place, 500, 300, 'frame-2'), { kind: 'empty', frameId: 'frame-2' })
  assert.deepEqual(deskDropZone(place, 103, 300, 'frame-2'), { kind: 'edge', side: 'left' }, 'the edge wins over an empty frame')
  assert.equal(deskDropZone(place, 500, 300, undefined), undefined)
  assert.equal(deskDropZone(place, 50, 300, undefined), undefined, 'outside the place')
})
