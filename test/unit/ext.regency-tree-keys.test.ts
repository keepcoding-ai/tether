// The Regency's tree keyboard (extensions/regency/renderer/tree-keys.ts): the flat rows and the key x row table.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { regencyModelOf, type RegencyInput } from '../../extensions/regency/model.ts'
import { flatRows, treeKeyStep, type FlatRow, type KeyInput, type TreeKeyState } from '../../extensions/regency/renderer/tree-keys.ts'
import type { DeskTree, TreePane } from '../../app/renderer/ext-api.ts'

const pane = (id: string, extra: Partial<TreePane> = {}): TreePane => ({ id, type: 'note', icon: 'note', title: id, ...extra })
const desks: DeskTree = {
  desks: [
    { id: 'd1', name: 'obra', color: 'blue', kind: 'queue', asleep: false, panes: [pane('a1', { type: 'agent' }), pane('n1')] },
    { id: 'd2', name: 'casa', color: 'green', kind: 'queue', asleep: false, panes: [pane('b1')] },
    { id: 'd3', name: 'vazia', color: 'red', kind: 'queue', asleep: false, panes: [] },
  ],
}
const input = (extra: Partial<RegencyInput> = {}): RegencyInput => ({
  desks, owners: { desk: { d1: { id: 'a1', name: 'conferente' } }, pane: {} }, channels: [], channelMarks: {},
  agents: [{ id: 'a1', kind: 'claude', name: 'conferente' }], since: {}, collapsed: [],
  closed: [{ slotId: 's1', kind: 'claude', name: 'velha' }, { slotId: 's2', kind: 'claude', name: 'outra' }], ...extra,
})
const rowsOf = (view: 'desk' | 'agent', extra: Partial<RegencyInput> = {}): FlatRow[] => flatRows(regencyModelOf(input(extra)), view)
const NONE: TreeKeyState = { query: '', filter: 'all' }
const step = (rows: FlatRow[], focused: string | undefined, key: string, mods: Partial<KeyInput> = {}, state: TreeKeyState = NONE) =>
  treeKeyStep(rows, focused, { key, ...mods }, state)

describe('flat rows', () => {
  test('by desk: desks, their panes, then "Fechadas" with its sessions; keys are unique', () => {
    const rows = rowsOf('desk')
    assert.deepEqual(rows.map(r => r.key), [
      'desk:d1', 'pane:agent:a1', 'pane:pane:n1', 'desk:d2', 'pane:pane:b1', 'desk:d3', 'closed-head', 'closed:s1', 'closed:s2',
    ])
    assert.equal(new Set(rows.map(r => r.key)).size, rows.length)
    assert.deepEqual(rows.map(r => r.level), [1, 2, 2, 1, 2, 1, 1, 2, 2])
    assert.equal(rows.find(r => r.key === 'desk:d3')!.expandable, false)
    assert.equal(rows.find(r => r.key === 'pane:agent:a1')!.parent, 'desk:d1')
    assert.deepEqual(JSON.parse(JSON.stringify(rows)), rows)
  })

  test('by agent: an agent\'s group is its own pane row (one key), "Você" last; folds give no children', () => {
    const rows = rowsOf('agent', { collapsed: ['a1', 'closed'] })
    assert.deepEqual(rows.map(r => r.key), ['pane:agent:a1', 'group:you', 'pane:pane:b1', 'closed-head'])
    assert.equal(rows.find(r => r.key === 'closed-head')!.expanded, false)
    assert.equal(rows.some(r => r.kind === 'closed'), false)
    const open = rowsOf('agent')
    assert.deepEqual(open.map(r => r.key), ['pane:agent:a1', 'pane:pane:n1', 'group:you', 'pane:pane:b1', 'closed-head', 'closed:s1', 'closed:s2'])
    assert.equal(new Set(open.map(r => r.key)).size, open.length)
    assert.deepEqual(open.filter(r => r.kind === 'agent').map(r => [r.key, r.level, r.expandable, r.foldId]), [['pane:agent:a1', 1, true, 'a1']])
    assert.equal(open.find(r => r.key === 'pane:pane:n1')!.parent, 'pane:agent:a1')
  })

  test('by agent: an agent with nothing is a leaf row', () => {
    const rows = rowsOf('agent', { owners: { desk: {}, pane: {} } })
    const head = rows.find(r => r.key === 'pane:agent:a1')!
    assert.deepEqual([head.kind, head.expandable], ['agent', false])
    assert.equal(step(rows, 'pane:agent:a1', 'ArrowRight'), undefined)
  })

  test('no sessions: no "Fechadas" head', () => {
    assert.equal(rowsOf('desk', { closed: [] }).some(r => r.kind === 'closed-head'), false)
  })
})

describe('walking', () => {
  const rows = rowsOf('desk')
  test('Down, Up, Home and End; the ends stay; no focus starts at the first', () => {
    assert.deepEqual(step(rows, 'desk:d1', 'ArrowDown'), { type: 'focus', key: 'pane:agent:a1' })
    assert.deepEqual(step(rows, 'pane:agent:a1', 'ArrowUp'), { type: 'focus', key: 'desk:d1' })
    assert.deepEqual(step(rows, 'desk:d1', 'ArrowUp'), { type: 'focus', key: 'desk:d1' })
    assert.deepEqual(step(rows, 'closed:s2', 'ArrowDown'), { type: 'focus', key: 'closed:s2' })
    assert.deepEqual(step(rows, 'pane:pane:n1', 'Home'), { type: 'focus', key: 'desk:d1' })
    assert.deepEqual(step(rows, 'desk:d1', 'End'), { type: 'focus', key: 'closed:s2' })
    assert.deepEqual(step(rows, undefined, 'ArrowDown'), { type: 'focus', key: 'desk:d1' })
    assert.deepEqual(step(rows, 'gone', 'ArrowUp'), { type: 'focus', key: 'desk:d1' })
  })

  test('Right opens a folded row, then descends to the first child; a leaf or empty desk does nothing', () => {
    const folded = rowsOf('desk', { collapsed: ['d1'] })
    assert.deepEqual(step(folded, 'desk:d1', 'ArrowRight'), { type: 'toggle', key: 'desk:d1', foldId: 'd1', open: true })
    assert.deepEqual(step(rows, 'desk:d1', 'ArrowRight'), { type: 'focus', key: 'pane:agent:a1' })
    assert.equal(step(rows, 'pane:agent:a1', 'ArrowRight'), undefined)
    assert.equal(step(rows, 'desk:d3', 'ArrowRight'), undefined)
  })

  test('Left folds an open row, then climbs from a child; a top row folded does nothing', () => {
    assert.deepEqual(step(rows, 'desk:d1', 'ArrowLeft'), { type: 'toggle', key: 'desk:d1', foldId: 'd1', open: false })
    assert.deepEqual(step(rows, 'pane:pane:n1', 'ArrowLeft'), { type: 'focus', key: 'desk:d1' })
    assert.deepEqual(step(rows, 'closed:s1', 'ArrowLeft'), { type: 'focus', key: 'closed-head' })
    assert.equal(step(rowsOf('desk', { collapsed: ['d1'] }), 'desk:d1', 'ArrowLeft'), undefined)
    assert.equal(step(rows, 'desk:d3', 'ArrowLeft'), undefined)
  })
})

describe('acting', () => {
  const rows = rowsOf('desk')
  test('Space is the quick look, on panes only', () => {
    assert.deepEqual(step(rows, 'pane:agent:a1', ' '), { type: 'quick', key: 'pane:agent:a1', target: { kind: 'agent', id: 'a1' } })
    assert.deepEqual(step(rows, 'pane:pane:n1', 'Spacebar'), { type: 'quick', key: 'pane:pane:n1', target: { kind: 'pane', id: 'n1' } })
    for (const k of ['desk:d1', 'closed-head', 'closed:s1']) assert.equal(step(rows, k, ' '), undefined)
  })

  test('Enter goes to a pane, folds a desk, group or "Fechadas", opens the menu of a closed session', () => {
    assert.deepEqual(step(rows, 'pane:pane:b1', 'Enter'), { type: 'go', key: 'pane:pane:b1', target: { kind: 'pane', id: 'b1' } })
    assert.deepEqual(step(rows, 'desk:d1', 'Enter'), { type: 'toggle', key: 'desk:d1', foldId: 'd1', open: false })
    assert.deepEqual(step(rowsOf('desk', { collapsed: ['closed'] }), 'closed-head', 'Enter'), { type: 'toggle', key: 'closed-head', foldId: 'closed', open: true })
    const agent = rowsOf('agent')
    assert.deepEqual(step(agent, 'group:you', 'Enter'), { type: 'toggle', key: 'group:you', foldId: 'you', open: false })
    // an agent's line goes to its pane (Enter) and gives the quick look (Space); its fold is by the arrows
    assert.deepEqual(step(agent, 'pane:agent:a1', 'Enter'), { type: 'go', key: 'pane:agent:a1', target: { kind: 'agent', id: 'a1' } })
    assert.deepEqual(step(agent, 'pane:agent:a1', ' '), { type: 'quick', key: 'pane:agent:a1', target: { kind: 'agent', id: 'a1' } })
    assert.deepEqual(step(agent, 'pane:agent:a1', 'ArrowLeft'), { type: 'toggle', key: 'pane:agent:a1', foldId: 'a1', open: false })
    assert.deepEqual(step(agent, 'pane:agent:a1', 'ArrowRight'), { type: 'focus', key: 'pane:pane:n1' })
    assert.deepEqual(step(rows, 'closed:s1', 'Enter'), { type: 'menu', key: 'closed:s1', target: { kind: 'session', id: 's1' } })
    assert.equal(step(rows, 'desk:d3', 'Enter'), undefined)
  })

  test('the Menu key and Shift+F10 open the menu of the focused row; bare F10 does not', () => {
    const want = { type: 'menu', key: 'desk:d2', target: { kind: 'desk', id: 'd2' } }
    assert.deepEqual(step(rows, 'desk:d2', 'ContextMenu'), want)
    assert.deepEqual(step(rows, 'desk:d2', 'F10', { shiftKey: true }), want)
    assert.equal(step(rows, 'desk:d2', 'F10'), undefined)
    assert.equal(step(rows, undefined, 'ContextMenu'), undefined)
  })

  test('Esc clears the search, then the filter, then nothing', () => {
    assert.deepEqual(step(rows, 'desk:d1', 'Escape', {}, { query: 'ob', filter: 'busy' }), { type: 'clear-search' })
    assert.deepEqual(step(rows, 'desk:d1', 'Escape', {}, { query: '  ', filter: 'busy' }), { type: 'clear-filter' })
    assert.equal(step(rows, 'desk:d1', 'Escape'), undefined)
    assert.deepEqual(step([], undefined, 'Escape', {}, { query: 'x', filter: 'all' }), { type: 'clear-search' })
  })

  test('Ctrl, Alt, Meta and Shift (but Shift+F10) leave the key to the browser; empty tree and other keys do nothing', () => {
    for (const mods of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true }]) {
      assert.equal(step(rows, 'desk:d1', 'ArrowDown', mods), undefined)
      assert.equal(step(rows, 'pane:pane:b1', 'Enter', mods), undefined)
    }
    assert.equal(step(rows, 'desk:d1', 'F10', { shiftKey: true, ctrlKey: true }), undefined)
    assert.equal(step([], undefined, 'ArrowDown'), undefined)
    assert.equal(step(rows, 'desk:d1', 'a'), undefined)
    assert.equal(step(rows, 'desk:d1', 'Tab'), undefined)
  })

  test('Ctrl+F opens the search field (with or without a focused row); Ctrl+Shift+F and Alt+F stay the browser\'s', () => {
    assert.deepEqual(step(rows, 'desk:d1', 'f', { ctrlKey: true }), { type: 'search' })
    assert.deepEqual(step([], undefined, 'F', { ctrlKey: true }), { type: 'search' })
    assert.equal(step(rows, 'desk:d1', 'f', { ctrlKey: true, shiftKey: true }), undefined)
    assert.equal(step(rows, 'desk:d1', 'f', { altKey: true }), undefined)
    assert.equal(step(rows, 'desk:d1', 'f'), undefined)
  })
})
