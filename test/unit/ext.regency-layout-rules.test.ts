// The Regency's layout rules (extensions/regency/renderer/layout-rules.ts): reading params, toggles and the tier ruler.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  DEFAULT_LAYOUT, layoutParams, openingTab, readLayout, selectChannel, setNarrowTab, setView, tierOf, toggleCollapsed, toggleMembers, toggleMode,
} from '../../extensions/regency/renderer/layout-rules.ts'

describe('readLayout', () => {
  test('anything invalid gives the default', () => {
    for (const bad of [undefined, null, 5, 'x', [], {}]) assert.deepEqual(readLayout(bad), DEFAULT_LAYOUT)
    assert.deepEqual(readLayout({ mode: 'weird', narrowTab: 'nope', view: 3, membersOpen: 'yes', collapsed: 'd1', channelId: 7 }), DEFAULT_LAYOUT)
  })

  test('reads valid params and drops bad collapsed entries and repeats', () => {
    const l = readLayout({ channelId: 'c1', mode: 'immersion', membersOpen: true, collapsed: ['d1', 4, 'd1', '', 'd2'], narrowTab: 'tether', view: 'agent' })
    assert.deepEqual(l, { channelId: 'c1', mode: 'immersion', membersOpen: true, collapsed: ['d1', 'd2'], narrowTab: 'tether', view: 'agent' })
  })

  test('the default does not alias: a read never shares the default array', () => {
    assert.notEqual(readLayout({}).collapsed, DEFAULT_LAYOUT.collapsed)
  })

  test('params round trip through JSON', () => {
    const l = toggleCollapsed(selectChannel(DEFAULT_LAYOUT, 'c9'), 'd1')
    assert.deepEqual(readLayout(JSON.parse(JSON.stringify(layoutParams(l)))), l)
  })
})

describe('toggles', () => {
  test('mode, members and collapsed flip and flip back, without touching the input', () => {
    const l = readLayout({})
    assert.equal(toggleMode(l).mode, 'immersion')
    assert.equal(toggleMode(toggleMode(l)).mode, 'manage')
    assert.equal(toggleMembers(l).membersOpen, true)
    assert.deepEqual(toggleCollapsed(l, 'd1').collapsed, ['d1'])
    assert.deepEqual(toggleCollapsed(toggleCollapsed(l, 'd1'), 'd1').collapsed, [])
    assert.deepEqual(l, DEFAULT_LAYOUT)
  })

  test('selectChannel sets and clears; narrow tab and view set', () => {
    const l = selectChannel(DEFAULT_LAYOUT, 'c1')
    assert.equal(l.channelId, 'c1')
    assert.equal('channelId' in selectChannel(l, undefined), false)
    assert.equal(setNarrowTab(l, 'conversation').narrowTab, 'conversation')
    assert.equal(setView(l, 'agent').view, 'agent')
  })
})

describe('openingTab', () => {
  test('someone waiting opens "Chama você", whatever was kept', () => {
    for (const saved of ['waiting', 'conversation', 'tether'] as const) assert.equal(openingTab(saved, 2), 'waiting')
  })

  test('nobody waiting: the conversation, or "Tether" when it was kept', () => {
    assert.equal(openingTab('waiting', 0), 'conversation')
    assert.equal(openingTab('conversation', 0), 'conversation')
    assert.equal(openingTab('tether', 0), 'tether')
  })
})

describe('tierOf', () => {
  test('the four tiers and their edges (768, 1280, 2560)', () => {
    assert.equal(tierOf(0), 'mobile')
    assert.equal(tierOf(420), 'mobile')
    assert.equal(tierOf(767), 'mobile')
    assert.equal(tierOf(768), 'tablet')
    assert.equal(tierOf(1279), 'tablet')
    assert.equal(tierOf(1280), 'desktop')
    assert.equal(tierOf(2559), 'desktop')
    assert.equal(tierOf(2560), 'wide')
    assert.equal(tierOf(5000), 'wide')
  })

  test('nonsense widths fall to mobile', () => {
    assert.equal(tierOf(NaN), 'mobile')
    assert.equal(tierOf(-5), 'mobile')
  })
})
