// What an action bar shows of a menu (app/renderer/action-bar-rules.ts).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { actionBarItems } from '../../app/renderer/action-bar-rules.ts'
import type { ContextMenuEntry, MenuPin } from '../../app/renderer/ext-api.ts'

const item = (label: string, pin?: MenuPin, over: object = {}): ContextMenuEntry => ({ icon: 'x', label, run() {}, ...(pin ? { pin } : {}), ...over })
const labels = (l: readonly ContextMenuEntry[]): string[] => l.map(e => (e === 'sep' ? '-' : e.label))

test('only one highlight: the first; a later one becomes primary', () => {
  const r = actionBarItems([item('A', 'highlight'), item('B', 'highlight'), item('C', 'primary')])
  assert.equal(r.highlight && r.highlight.label, 'A')
  assert.deepEqual(labels(r.primary), ['B', 'C'])
})

test('menu order is kept inside each group', () => {
  const r = actionBarItems([item('i1', 'icon'), item('p1', 'primary'), item('i2', 'icon'), item('p2', 'primary'), item('i3', 'icon')])
  assert.deepEqual(labels(r.primary), ['p1', 'p2'])
  assert.deepEqual(labels(r.icon), ['i1', 'i2', 'i3'])
})

test("'sep' is ignored and an unpinned item stays out of the bar", () => {
  const r = actionBarItems(['sep', item('plain'), 'sep', item('p', 'primary')])
  assert.equal(r.highlight, undefined)
  assert.deepEqual(labels(r.primary), ['p'])
  assert.deepEqual(r.icon, [])
})

test('disabled and checked travel with the item', () => {
  const r = actionBarItems([item('d', 'icon', { disabled: true }), item('c', 'primary', { checked: true })])
  assert.equal((r.icon[0] as { disabled?: boolean }).disabled, true)
  assert.equal((r.primary[0] as { checked?: boolean }).checked, true)
})

test('no pins, no bar items', () => {
  assert.deepEqual(actionBarItems([]), { primary: [], icon: [] })
})
