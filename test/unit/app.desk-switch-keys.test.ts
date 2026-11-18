// The capsule's skip-if-unchanged keys (app/renderer/desk-switch-rules.ts): a daemon state event that changes nothing the
// capsule shows must not re-measure (forced synchronous layout of the window) nor repaint; one that changes what a
// segment shows must, and one that changes a width must fit again.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { measureKey, paintKey, structureKey, type SegView } from '../../app/renderer/desk-switch-rules.ts'

const seg = (id: string, over: Partial<SegView> = {}): SegView => ({ id, name: `Mesa ${id}`, color: 'blue', active: false, done: 0, waiting: 0, busy: false, lines: [], ...over })
const row = (over: Record<string, Partial<SegView>> = {}): SegView[] => ['a', 'b', 'c'].map(id => seg(id, { active: id === 'a', ...over[id] }))
const hints = ['Ctrl+1', 'Ctrl+2', 'Ctrl+3']

test('structure: order, names, colours, sleep and the active desk; marks are not part of it', () => {
  const desks = [{ id: 'a', name: 'A', color: 'blue' }, { id: 'b', name: 'B', color: 'green' }]
  const k = structureKey(desks, 'a')
  assert.equal(structureKey(desks.map(d => ({ ...d })), 'a'), k, 'a new array with the same desks is the same structure')
  assert.notEqual(structureKey(desks, 'b'), k, 'active')
  assert.notEqual(structureKey([...desks].reverse(), 'a'), k, 'order')
  assert.notEqual(structureKey([{ ...desks[0]!, name: 'A2' }, desks[1]!], 'a'), k, 'name')
  assert.notEqual(structureKey([{ ...desks[0]!, color: 'red' }, desks[1]!], 'a'), k, 'colour')
  assert.notEqual(structureKey([desks[0]!, { ...desks[1]!, asleep: true }], 'a'), k, 'sleep')
})

test('the same marks: same measure key and same paint key (the state event costs no read and no write)', () => {
  assert.equal(measureKey(row()), measureKey(row()))
  assert.equal(paintKey(['a', 'b'], row(), hints), paintKey(['a', 'b'], row(), hints))
})

test('a badge or busy dot that comes or goes changes the widths: fit again', () => {
  const k = measureKey(row())
  assert.notEqual(measureKey(row({ b: { done: 1 } })), k, 'badge appears')
  assert.notEqual(measureKey(row({ b: { busy: true } })), k, 'busy dot appears')
  assert.notEqual(measureKey(row({ b: { done: 1 } })), measureKey(row({ b: { done: 12 } })), 'two digits are wider')
  assert.notEqual(measureKey(row()), measureKey(row({ a: { active: false }, b: { active: true } })), 'active moved')
})

test('what does not change a width keeps the fit, but still repaints', () => {
  const m = measureKey(row({ b: { done: 1 } }))
  assert.equal(measureKey(row({ b: { waiting: 1 } })), m, 'done -> waiting: same count, same width')
  assert.equal(measureKey(row({ b: { done: 1, busy: true } })), m, 'the busy dot does not show next to a badge')
  assert.equal(measureKey(row({ b: { done: 1, lines: ['x'] } })), m, 'tooltip lines')
  assert.equal(measureKey(row({ b: { color: 'red' } })), measureKey(row()), 'colour')
  const p = paintKey(['a', 'b'], row({ b: { done: 1 } }), hints)
  assert.notEqual(paintKey(['a', 'b'], row({ b: { waiting: 1 } }), hints), p, 'badge tone')
  assert.notEqual(paintKey(['a', 'b'], row({ b: { done: 1, lines: ['x'] } }), hints), p, 'tooltip lines')
  assert.notEqual(paintKey(['a', 'b'], row({ b: { done: 1 } }), ['Ctrl+1', 'Alt+2', 'Ctrl+3']), p, 'shortcut hint')
})

test('paint key: only the visible desks count, and who is visible counts', () => {
  const p = paintKey(['a', 'b'], row(), hints)
  assert.equal(paintKey(['a', 'b'], row({ c: { done: 3, lines: ['y'] } }), hints), p, 'a hidden desk\'s mark does not repaint the row (the "+N" has its own key)')
  assert.notEqual(paintKey(['a', 'c'], row(), hints), p, 'another desk visible')
  assert.notEqual(paintKey(['a'], row(), hints), p, 'one less visible')
})
