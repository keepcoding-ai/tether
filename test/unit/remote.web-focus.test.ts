// The arrows over the Regency on the web (remote/web/src/focus-rules.ts), with no DOM: the neighbour in each direction over
// an irregular grid (the TV's three columns, the board of desks), the border that keeps the focus, the item kept by its key
// across a re-reading of the tree, and the arrows that stay a text field's.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { caretAtEdge, firstFocusOf, initialKeyOf, itemKeyOf, keptKeyOf, neighbourOf, okDoes, takesArrow, type Direction, type Item, type KeyPlace } from '../../remote/web/src/focus-rules.ts'

const box = (key: string, left: number, top: number, w: number, h: number): Item => ({ key, rect: { left, top, right: left + w, bottom: top + h } })

// The TV, roughly: the left column (who waits, the channels), the conversation (no items), and the board: the chips on top,
// two desks of different heights side by side (cards of different sizes), and "Fechadas" across the foot.
const grid: Item[] = [
  box('wait:a', 10, 60, 440, 70),
  box('wait:b', 10, 140, 440, 70),
  box('conv:x', 10, 240, 440, 40),
  box('conv:y', 10, 285, 440, 40),
  box('chip:all', 1360, 60, 120, 40),
  box('chip:waiting', 1490, 60, 160, 40),
  box('chip:working', 1660, 60, 150, 40),
  box('desk:1', 1360, 120, 300, 40),
  box('pane:1a', 1360, 170, 300, 60),
  box('pane:1b', 1360, 240, 300, 90),
  box('pane:1c', 1360, 340, 300, 60),
  box('desk:2', 1680, 120, 300, 40),
  box('pane:2a', 1680, 170, 300, 120),
  box('closed', 1360, 600, 620, 40),
]
describe('firstFocusOf', () => {
  test('only chips so far: nothing is decided yet; when the house arrives, who waits takes the focus', () => {
    assert.deepEqual(firstFocusOf(['chip:all', 'chip:waiting'], false), { settled: false })
    assert.deepEqual(firstFocusOf(['chip:all', 'conv:x', 'wait:a'], false), { settled: true, key: 'wait:a' })
  })
  test('the person already walked: her focus stays, the decision is closed', () => {
    assert.deepEqual(firstFocusOf(['chip:all', 'conv:x', 'wait:a'], true), { settled: true })
  })
})

const at = (k: string): Item => grid.find(i => i.key === k)!
const go = (k: string, d: Direction): string | undefined => neighbourOf(at(k), grid, d)

describe('the neighbour in a direction', () => {
  test('down and up keep to the column', () => {
    assert.equal(go('wait:a', 'down'), 'wait:b')
    assert.equal(go('wait:b', 'down'), 'conv:x')
    assert.equal(go('conv:x', 'up'), 'wait:b')
    assert.equal(go('desk:1', 'down'), 'pane:1a')
    assert.equal(go('pane:1a', 'down'), 'pane:1b')
    assert.equal(go('pane:1b', 'up'), 'pane:1a')
    assert.equal(go('desk:2', 'down'), 'pane:2a')
    // From the cards of a column up to the chip over it, and down to "Fechadas" under the whole board.
    assert.equal(go('desk:2', 'up'), 'chip:working')
    assert.equal(go('pane:1c', 'down'), 'closed')
    assert.equal(go('pane:2a', 'down'), 'closed')
  })

  test('sideways goes to the next column, the nearest in line', () => {
    assert.equal(go('pane:1b', 'right'), 'pane:2a')
    assert.equal(go('pane:2a', 'left'), 'pane:1a')
    assert.equal(go('desk:1', 'right'), 'desk:2')
    assert.equal(go('chip:all', 'right'), 'chip:waiting')
    assert.equal(go('chip:waiting', 'left'), 'chip:all')
    // Across the conversation: from the left column to the board, and back.
    assert.equal(go('wait:a', 'right'), 'chip:all')
    assert.equal(go('conv:y', 'right'), 'pane:1b')
    assert.equal(go('desk:1', 'left'), 'wait:b')
  })

  test('at the border the focus stays (nothing past it)', () => {
    assert.equal(go('wait:a', 'up'), undefined)
    assert.equal(go('wait:a', 'left'), undefined)
    assert.equal(go('conv:y', 'down'), undefined, 'the foot of the short column does not jump into the board')
    assert.equal(go('chip:working', 'up'), undefined)
    assert.equal(go('pane:2a', 'right'), undefined)
    assert.equal(go('closed', 'down'), undefined)
    assert.equal(neighbourOf(box('only', 0, 0, 10, 10), [box('only', 0, 0, 10, 10)], 'down'), undefined)
  })
})

describe('the item held by its key', () => {
  test('the key names what is shown, with its place; never the node', () => {
    assert.equal(itemKeyOf('tree', { key: 'pane:p1', target: 'pane:p1' }), 'tree:pane:p1')
    assert.equal(itemKeyOf('wait', { target: 'channel:c1' }), 'wait:channel:c1')
    assert.equal(itemKeyOf('conv', { target: 'channel:c1' }), 'conv:channel:c1')
    assert.equal(itemKeyOf('chip', { filter: 'waiting' }), 'chip:waiting')
    assert.equal(itemKeyOf('toggle', { action: 'closed' }), 'toggle:closed')
    assert.equal(itemKeyOf('tree', { target: 'pane:p1' }), undefined)
  })

  test('the first focus: who waits for the person, else the first channel, else the first item', () => {
    assert.equal(initialKeyOf(['chip:all', 'conv:x', 'wait:a', 'tree:d1']), 'wait:a')
    assert.equal(initialKeyOf(['chip:all', 'conv:x', 'tree:d1']), 'conv:x')
    assert.equal(initialKeyOf(['chip:all', 'tree:d1']), 'chip:all')
    assert.equal(initialKeyOf([]), undefined)
  })

  test('a re-reading keeps the same item when it is still there, whatever moved around it', () => {
    const before = ['wait:a', 'conv:x', 'tree:d1', 'tree:p1', 'tree:p2']
    assert.equal(keptKeyOf(before, ['tree:p0', 'wait:a', 'conv:x', 'tree:d1', 'tree:p2', 'tree:p1'], 'tree:p1'), 'tree:p1')
  })

  test('when the item went, the focus stays at its place (the one before it, else after), never off the screen', () => {
    const before = ['wait:a', 'conv:x', 'tree:d1', 'tree:p1', 'tree:p2']
    assert.equal(keptKeyOf(before, ['wait:a', 'conv:x', 'tree:d1', 'tree:p2'], 'tree:p1'), 'tree:d1')
    assert.equal(keptKeyOf(before, ['conv:x', 'tree:d1'], 'wait:a'), 'conv:x')
    assert.equal(keptKeyOf(before, ['wait:b'], 'tree:p1'), 'wait:b')
    assert.equal(keptKeyOf(before, [], 'tree:p1'), undefined)
    assert.equal(keptKeyOf(before, before, undefined), undefined)
  })
})

describe('whose arrow it is', () => {
  const place = (p: Partial<KeyPlace>): KeyPlace => ({ editable: false, item: false, treeRow: false, nowhere: false, inCard: false, tv: false, modified: false, ...p })

  test('a text field keeps its arrows, on the TV too, even when nothing else holds the keyboard', () => {
    assert.equal(takesArrow(place({ editable: true })), false)
    assert.equal(takesArrow(place({ editable: true, tv: true })), false)
    assert.equal(takesArrow(place({ editable: true, item: true, tv: true })), false)
  })

  test('the card, a modifier and what is not ours keep theirs', () => {
    assert.equal(takesArrow(place({ inCard: true, tv: true, item: true })), false)
    assert.equal(takesArrow(place({ modified: true, tv: true, item: true })), false)
    assert.equal(takesArrow(place({ tv: true })), false, 'the conversation scrolls by its own arrows')
  })

  test('on the TV every item walks, the tree too; elsewhere the tree keeps its keys', () => {
    assert.equal(takesArrow(place({ item: true, treeRow: true, tv: true })), true)
    assert.equal(takesArrow(place({ item: true, treeRow: true })), false)
    assert.equal(takesArrow(place({ item: true })), true)
    assert.equal(takesArrow(place({ nowhere: true })), true, 'the first arrow brings the focus in, on any tier')
  })

  test('on the TV a field of the speaking box lets the arrow go at its edge (the remote has nothing else); elsewhere never', () => {
    assert.equal(takesArrow(place({ editable: true, item: true, tv: true, edge: true })), true)
    assert.equal(takesArrow(place({ editable: true, item: true, tv: false, edge: true })), false)
    assert.equal(takesArrow(place({ editable: true, item: false, tv: true, edge: true })), false, 'a field that is not on the walk keeps its keys')
  })
})

describe('the open channel on the TV', () => {
  test('its items go by what they show, never by their node', () => {
    assert.equal(itemKeyOf('msg', { id: '42' }), 'msg:42')
    assert.equal(itemKeyOf('opt', { id: '7:2' }), 'opt:7:2')
    assert.equal(itemKeyOf('say', { id: 'field' }), 'say:field')
    assert.equal(itemKeyOf('out', {}), undefined)
  })

  test('the caret: Up leaves on the first line, Down on the last; a one-line field or a list always; sideways never', () => {
    const area = (value: string, at: number) => ({ kind: 'area' as const, value, start: at, end: at })
    assert.equal(caretAtEdge(area('um\ndois', 1), 'up'), true)
    assert.equal(caretAtEdge(area('um\ndois', 5), 'up'), false)
    assert.equal(caretAtEdge(area('um\ndois', 1), 'down'), false)
    assert.equal(caretAtEdge(area('um\ndois', 5), 'down'), true)
    assert.equal(caretAtEdge({ kind: 'text', value: 'x', start: 0, end: 0 }, 'down'), true)
    assert.equal(caretAtEdge({ kind: 'select', value: '', start: 0, end: 0 }, 'up'), true)
    assert.equal(caretAtEdge(area('', 0), 'left'), false)
  })

  test('OK: a speech or a card opens its menu, a field keeps its own Enter, anything else is clicked', () => {
    assert.equal(okDoes('msg', false), 'menu')
    assert.equal(okDoes('card', false), 'menu')
    assert.equal(okDoes('say', true), 'own')
    assert.equal(okDoes('opt', false), 'click')
    assert.equal(okDoes('lock', false), 'click')
  })
})
