// The Regency's layout rules (extensions/regency/renderer/layout-rules.ts): reading params, toggles and the tier ruler.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  DEFAULT_LAYOUT, layoutOnTier, layoutParams, openSystem, openSystemOn, openingTab, otherSide, readLayout, rightColumnOf, selectChannel, setFilter,
  setNarrowTab, setTabletSide, setView, systemSectionOf, systemShownOf, tabletSideOf, tierOf, tierPlan, tierStep, toggleCollapsed, toggleMembers,
  toggleMode, treeColumnOf, type RegencyLayout,
} from '../../extensions/regency/renderer/layout-rules.ts'

describe('readLayout', () => {
  test('anything invalid gives the default', () => {
    for (const bad of [undefined, null, 5, 'x', [], {}]) assert.deepEqual(readLayout(bad), DEFAULT_LAYOUT)
    assert.deepEqual(readLayout({ mode: 'weird', narrowTab: 'nope', view: 3, membersOpen: 'yes', collapsed: 'd1', channelId: 7 }), DEFAULT_LAYOUT)
  })

  test('reads valid params and drops bad collapsed entries and repeats', () => {
    const l = readLayout({ channelId: 'c1', mode: 'immersion', membersOpen: true, collapsed: ['d1', 4, 'd1', '', 'd2'], narrowTab: 'tether', view: 'agent' })
    assert.deepEqual(l, { channelId: 'c1', mode: 'immersion', membersOpen: true, collapsed: ['d1', 'd2'], narrowTab: 'tether', view: 'agent', filter: 'all' })
  })

  test('the filter: default "all", invalid falls to it, valid is kept, and it round trips; the search is not kept', () => {
    assert.equal(DEFAULT_LAYOUT.filter, 'all')
    for (const bad of ['', 'nope', 3, null, 'WAITING']) assert.equal(readLayout({ filter: bad }).filter, 'all')
    for (const f of ['all', 'waiting', 'busy', 'idle', 'asleep'] as const) assert.equal(readLayout({ filter: f }).filter, f)
    const l = setFilter(setView(DEFAULT_LAYOUT, 'agent'), 'asleep')
    assert.deepEqual(readLayout(JSON.parse(JSON.stringify(layoutParams(l)))), l)
    assert.equal('query' in layoutParams(readLayout({ filter: 'busy', query: 'obra' })), false)
    assert.equal(l.filter, 'asleep')
    assert.equal(DEFAULT_LAYOUT.filter, 'all')
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
  test('someone waiting opens "Esperam você", whatever was kept', () => {
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

describe('the tablet and the TV', () => {
  const manage: RegencyLayout = { ...DEFAULT_LAYOUT, mode: 'manage' }

  test('tierStep: only the tablet has one, denser from 1024', () => {
    assert.equal(tierStep(767), undefined)
    assert.equal(tierStep(768), 'sm')
    assert.equal(tierStep(1023), 'sm')
    assert.equal(tierStep(1024), 'lg')
    assert.equal(tierStep(1279), 'lg')
    assert.equal(tierStep(1280), undefined)
    assert.equal(tierStep(2560), undefined)
  })

  test('the tablet side: default "waiting", kept in the layout and round trips; nonsense falls to the default', () => {
    assert.equal(tabletSideOf(manage), 'waiting')
    const t = setTabletSide(manage, 'tether')
    assert.equal(tabletSideOf(t), 'tether')
    assert.deepEqual(readLayout(JSON.parse(JSON.stringify(layoutParams(t)))), t)
    assert.equal('side' in setTabletSide(t, 'waiting'), false)
    assert.equal(readLayout({ side: 'nope' }).side, undefined)
    assert.equal(otherSide('waiting'), 'tether')
    assert.equal(otherSide('tether'), 'waiting')
  })

  test('tierPlan: phone one place, tablet two columns and the other on demand, desktop three, TV five', () => {
    assert.deepEqual(tierPlan('mobile', manage).columns.length, 1)
    assert.equal(tierPlan('mobile', manage).bottomBar, true)
    assert.deepEqual(tierPlan('tablet', manage), { columns: ['waiting', 'conversation'], sheet: 'tether', quick: 'card', system: 'swap', bottomBar: false })
    assert.deepEqual(tierPlan('tablet', setTabletSide(manage, 'tether')).columns, ['tether', 'conversation'])
    assert.equal(tierPlan('tablet', setTabletSide(manage, 'tether')).sheet, 'waiting')
    assert.deepEqual(tierPlan('tablet', setTabletSide(openSystem(manage), 'tether')).columns, ['system', 'conversation'])
    assert.deepEqual(tierPlan('desktop', manage).columns, ['waiting', 'conversation', 'tether'])
    const tv = tierPlan('wide', manage)
    assert.deepEqual(tv, { columns: ['waiting', 'conversation', 'quick', 'tether', 'system'], quick: 'column', system: 'rail', bottomBar: false })
    // The TV keeps the tree even when the layout says "Sistema" took its column: the rail holds "Sistema".
    assert.deepEqual(tierPlan('wide', openSystem(manage)).columns, tv.columns)
  })

  test('immersion keeps only the conversation on every tier but the phone', () => {
    const imm = toggleMode(manage)
    for (const t of ['tablet', 'desktop', 'wide'] as const) assert.deepEqual(tierPlan(t, imm).columns, ['conversation'])
    assert.equal(tierPlan('mobile', imm).bottomBar, true)
  })

  test('the tree column and "Sistema" shown, by tier', () => {
    const sys = openSystem(manage)
    assert.equal(treeColumnOf(sys, 'desktop'), 'system')
    assert.equal(treeColumnOf(sys, 'tablet'), 'system')
    assert.equal(treeColumnOf(sys, 'wide'), 'tether')
    assert.equal(systemShownOf(manage, 'desktop'), false)
    assert.equal(systemShownOf(sys, 'desktop'), true)
    assert.equal(systemShownOf(manage, 'wide'), true)
    assert.equal(systemShownOf(toggleMode(manage), 'wide'), false)
  })

  test('openSystemOn: TV changes only the section; tablet turns the side to "Tether"; desktop takes the column', () => {
    const tv = openSystemOn(manage, 'wide', 'ronda')
    assert.equal(rightColumnOf(tv), 'tether')
    assert.equal(systemSectionOf(tv), 'ronda')
    const tab = openSystemOn(manage, 'tablet', 'processes')
    assert.equal(rightColumnOf(tab), 'system')
    assert.equal(tabletSideOf(tab), 'tether')
    const desk = openSystemOn(manage, 'desktop')
    assert.equal(rightColumnOf(desk), 'system')
    assert.equal(desk.side, undefined)
  })

  test('layoutOnTier: the place with the keyboard stays in view', () => {
    assert.equal(layoutOnTier(manage, 'tablet', undefined), manage)
    assert.equal(layoutOnTier(manage, 'mobile', 'tether'), manage)
    assert.equal(layoutOnTier(manage, 'wide', 'system'), manage)
    assert.equal(layoutOnTier(toggleMode(manage), 'tablet', 'tether').side, undefined)
    assert.equal(tabletSideOf(layoutOnTier(manage, 'tablet', 'tether')), 'tether')
    assert.equal(tabletSideOf(layoutOnTier(setTabletSide(manage, 'tether'), 'tablet', 'waiting')), 'waiting')
    // Leaving the TV with the keyboard in the rail: "Sistema" takes the tree's column (on the tablet, by the side column).
    const toDesk = layoutOnTier(manage, 'desktop', 'system')
    assert.equal(rightColumnOf(toDesk), 'system')
    const toTab = layoutOnTier(manage, 'tablet', 'system')
    assert.equal(rightColumnOf(toTab), 'system')
    assert.equal(tabletSideOf(toTab), 'tether')
  })
})
