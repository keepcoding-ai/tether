// The layout file (app/renderer/layout.ts): the v1 → v2 migration keeps the user's dockview JSON byte for
// byte as the single frame of "Mesa 1"; pruning drops unknown panes frame by frame and empty frames with
// them (a frame's root stays a branch: dockview refuses a leaf there); frameInsertion plans a frame that
// spans a whole desk edge; the restore policy (planRestore, orphanedPanels, isPersonChange) keeps pruning on
// screen only, never written back by the app. Fixtures: hand-made grids and the real layout.json of a working machine.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SerializedDockview } from 'dockview-core'
import { emptySideBars } from '../../app/renderer/sidebar-rules.ts'
import { allPanelIds, drawerOf, emptyDrawer, emptyLayout, frameIdsOf, frameInsertion, isLayoutV1, isDrawerLayout, isLayoutV2, isLayoutV3, isPersonChange, migrateLayout, nextFrameId, orphanedPanels, planRestore, pruneDesk, pruneDrawer, pruneLayout, pruneLayoutV2, readDeskColors, singleFrameGrid, type DeskLayout, type DrawerLayout, type FrameGrid, type LayoutV2 } from '../../app/renderer/layout.ts'

type Node = SerializedDockview['grid']['root']
const leaf = (id: string, views: string[], size = 100): Node => ({ type: 'leaf', data: { views, activeView: views[0]!, id }, size })
const branch = (data: Node[], size = 100): Node => ({ type: 'branch', data, size })
const panel = (id: string) => ({ id, contentComponent: 'terminal', tabComponent: 'slot-tab', params: { slotId: id }, title: id })

function layout(root: Node, ids: string[]): SerializedDockview {
  return { grid: { root, width: 1400, height: 800, orientation: 'HORIZONTAL' as never }, panels: Object.fromEntries(ids.map(id => [id, panel(id)])), activeGroup: '1' }
}

const real = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'layout-v1-real.json'), 'utf8')) as SerializedDockview
/** Whatever the machine had open when the fixture was copied (two groups: five tabs and three tabs). */
const REAL_IDS = Object.keys(real.panels)

type GridNode = FrameGrid['root']
const frameLeaf = (id: string, size = 100): GridNode => ({ type: 'leaf', data: { id, component: 'frame' }, size })
const frameBranch = (data: GridNode[], size = 100): GridNode => ({ type: 'branch', data, size })
const grid = (root: GridNode, orientation: 'HORIZONTAL' | 'VERTICAL' = 'HORIZONTAL'): FrameGrid => ({ root, width: 1400, height: 800, orientation: orientation as never })

describe('pruneLayout (one frame)', () => {
  test('one panel saved: the root stays a branch around its single leaf', () => {
    const out = pruneLayout(layout(branch([leaf('1', ['a'], 1400)], 800), ['a']), new Set(['a']))!
    assert.equal(out.grid.root.type, 'branch')
    assert.deepEqual((out.grid.root.data as Node[]).map(n => n.type), ['leaf'])
    assert.deepEqual(Object.keys(out.panels), ['a'])
    assert.equal(out.activeGroup, '1')
  })

  test('two panels side by side, one forgotten: the root keeps the other one as a branch with one leaf', () => {
    const out = pruneLayout(layout(branch([leaf('1', ['a'], 700), leaf('2', ['b'], 700)], 800), ['a', 'b']), new Set(['b']))!
    assert.equal(out.grid.root.type, 'branch')
    const [only] = out.grid.root.data as Node[]
    assert.deepEqual(only, leaf('2', ['b'], 700))
    assert.deepEqual(Object.keys(out.panels), ['b'])
    assert.equal(out.activeGroup, undefined, 'the active group was the pruned one')
  })

  test('nested branch with one survivor collapses into its parent, keeping the branch size', () => {
    const inner = branch([leaf('2', ['b'], 300), leaf('3', ['c'], 300)], 700)
    const out = pruneLayout(layout(branch([leaf('1', ['a'], 700), inner], 800), ['a', 'b', 'c']), new Set(['a', 'c']))!
    assert.deepEqual(out.grid.root, branch([leaf('1', ['a'], 700), leaf('3', ['c'], 700)], 800))
  })

  test('nothing survives: null', () => {
    assert.equal(pruneLayout(layout(branch([leaf('1', ['a'])]), ['a']), new Set()), null)
  })
})

describe('migrateLayout', () => {
  test('a v1 file becomes "Mesa 1" with one frame whose view is the old JSON, untouched', () => {
    const v1 = layout(branch([leaf('1', ['a'], 700), leaf('2', ['b'], 700)], 800), ['a', 'b'])
    const before = JSON.stringify(v1)
    const out = migrateLayout(JSON.parse(before))!
    assert.equal(out.migrated, true)
    assert.equal(out.from, 1)
    assert.equal(out.layout.v, 3)
    assert.deepEqual(out.layout.sidebars, emptySideBars(), 'a v1 file has closed side bars')
    assert.equal(out.layout.desks.length, 1)
    const desk = out.layout.desks[0]!
    assert.equal(desk.id, out.layout.activeDesk)
    assert.equal(desk.name, 'Mesa 1')
    assert.deepEqual(frameIdsOf(desk.frames.grid), ['frame-1'])
    assert.equal(desk.activeFrame, 'frame-1')
    assert.equal(JSON.stringify(desk.frames.views['frame-1']), before, 'the frame view IS the v1 file')
    assert.deepEqual(out.layout.drawer, emptyDrawer(), 'a v1 file has no drawer: it reads as an empty one')
    assert.deepEqual(desk.frames.grid, singleFrameGrid('frame-1', 1400, 800))
  })

  test('the real layout of a working machine (8 panes in 2 groups, root with a single nested branch) migrates whole', () => {
    const text = readFileSync(join(import.meta.dirname, 'fixtures', 'layout-v1-real.json'), 'utf8')
    const out = migrateLayout(JSON.parse(text))!
    assert.equal(out.migrated, true)
    const desk = out.layout.desks[0]!
    assert.deepEqual(desk.frames.views['frame-1'], JSON.parse(text))
    assert.equal(REAL_IDS.length, 8)
    assert.deepEqual(allPanelIds(out.layout).sort(), [...REAL_IDS].sort())
    assert.equal(desk.frames.grid.width, 1488)
    assert.equal(desk.frames.grid.height, 806)
    // Pruned against the same slots: nothing moves, the view stays byte for byte.
    const pruned = pruneLayoutV2(out.layout, new Set(REAL_IDS))
    assert.equal(pruned.kept, REAL_IDS.length)
    assert.equal(pruned.total, REAL_IDS.length)
    assert.equal(JSON.stringify(pruned.layout.desks[0]!.frames.views['frame-1']), JSON.stringify(real))
    assert.deepEqual(frameIdsOf(pruned.layout.desks[0]!.frames.grid), ['frame-1'])
  })

  test('a v2 file reads as v3 with closed side bars, its desks and drawer untouched; a v3 file as is; nothing else is a layout', () => {
    const desk = emptyLayout().desks[0]!
    const drawer = emptyDrawer()
    const v2: LayoutV2 = { v: 2, desks: [desk], activeDesk: desk.id, drawer }
    const fromV2 = migrateLayout(v2)!
    assert.equal(fromV2.from, 2)
    assert.equal(fromV2.migrated, false)
    assert.equal(fromV2.layout.v, 3)
    assert.equal(fromV2.layout.desks, v2.desks, 'the very same desks')
    assert.equal(fromV2.layout.drawer, drawer, 'the very same drawer')
    assert.equal(fromV2.layout.activeDesk, desk.id)
    assert.deepEqual(fromV2.layout.sidebars, emptySideBars())
    const v3 = emptyLayout()
    const fromV3 = migrateLayout(v3)!
    assert.equal(fromV3.from, 3)
    assert.deepEqual(fromV3.layout, v3)
    assert.equal(fromV3.layout.desks, v3.desks)
    assert.equal(migrateLayout(null), null)
    assert.equal(migrateLayout({}), null)
    assert.equal(migrateLayout({ grid: {}, panels: {} }), null, 'a grid without a root is not v1')
    assert.equal(migrateLayout({ v: 4, desks: [], activeDesk: 'x' }), null, 'a version from the future is not read')
    assert.equal(migrateLayout('{"grid":1}'), null)
    assert.ok(isLayoutV1(real))
    assert.ok(!isLayoutV2(real))
    assert.ok(isLayoutV2(v2))
    assert.ok(!isLayoutV2(v3))
    assert.ok(isLayoutV3(v3))
  })

  test('a v1 file without sizes still gets a usable grid', () => {
    const v1 = { grid: { root: branch([leaf('1', ['a'])]), width: 0, height: 0, orientation: 'HORIZONTAL' }, panels: { a: panel('a') } }
    const out = migrateLayout(v1)!
    assert.equal(out.layout.desks[0]!.frames.grid.width, 1200)
    assert.equal(out.layout.desks[0]!.frames.grid.height, 800)
  })
})

describe('pruneDesk / pruneLayoutV2', () => {
  const twoFrames = (): DeskLayout => ({
    id: 'desk-1', name: 'Mesa 1', color: 'blue', activeFrame: 'frame-2',
    frames: {
      grid: grid(frameBranch([frameLeaf('frame-1', 700), frameLeaf('frame-2', 700)], 800)),
      views: {
        'frame-1': layout(branch([leaf('1', ['a'], 700), leaf('2', ['b'], 700)], 800), ['a', 'b']),
        'frame-2': layout(branch([leaf('1', ['c'], 1400)], 800), ['c']),
      },
    },
  })

  test('every pane known: nothing changes', () => {
    const desk = twoFrames()
    assert.deepEqual(pruneDesk(desk, new Set(['a', 'b', 'c'])), desk)
  })

  test('a pane forgotten inside a frame: only that frame\'s view shrinks', () => {
    const out = pruneDesk(twoFrames(), new Set(['a', 'c']))
    assert.deepEqual(frameIdsOf(out.frames.grid), ['frame-1', 'frame-2'])
    assert.deepEqual(Object.keys(out.frames.views['frame-1']!.panels), ['a'])
    assert.deepEqual(Object.keys(out.frames.views['frame-2']!.panels), ['c'])
    assert.equal(out.activeFrame, 'frame-2')
  })

  test('a frame left empty leaves the grid (root stays a branch) and the active frame falls back', () => {
    const out = pruneDesk(twoFrames(), new Set(['a', 'b']))
    assert.deepEqual(frameIdsOf(out.frames.grid), ['frame-1'])
    assert.equal(out.frames.grid.root.type, 'branch')
    assert.deepEqual(Object.keys(out.frames.views), ['frame-1'])
    assert.equal(out.activeFrame, 'frame-1')
  })

  test('a nested grid collapses like the dockview grid does', () => {
    const desk = twoFrames()
    desk.frames.grid = grid(frameBranch([frameLeaf('frame-1', 700), frameBranch([frameLeaf('frame-2', 400), frameLeaf('frame-3', 400)], 700)], 800))
    desk.frames.views['frame-3'] = layout(branch([leaf('4', ['d'], 1400)], 800), ['d'])
    const out = pruneDesk(desk, new Set(['a', 'd']))
    assert.deepEqual(out.frames.grid.root, frameBranch([frameLeaf('frame-1', 700), frameLeaf('frame-3', 700)], 800))
  })

  test('nothing survives: one empty frame, never a desk without frames', () => {
    const out = pruneDesk(twoFrames(), new Set())
    assert.deepEqual(frameIdsOf(out.frames.grid), ['frame-1'])
    assert.deepEqual(out.frames.views, {})
    assert.equal(out.activeFrame, 'frame-1')
  })

  test('a frame named in the grid without a view, or a view that is not a dockview, is dropped', () => {
    const desk = twoFrames()
    delete desk.frames.views['frame-2']
    assert.deepEqual(frameIdsOf(pruneDesk(desk, new Set(['a', 'b', 'c'])).frames.grid), ['frame-1'])
    const bad = twoFrames()
    bad.frames.views['frame-2'] = { nonsense: true } as unknown as SerializedDockview
    assert.deepEqual(frameIdsOf(pruneDesk(bad, new Set(['a', 'b', 'c'])).frames.grid), ['frame-1'])
  })

  test('pruneLayoutV2 counts kept/total across frames and fixes a dangling activeDesk', () => {
    const file = { ...emptyLayout(), desks: [twoFrames()], activeDesk: 'gone' }
    const out = pruneLayoutV2(file, new Set(['a', 'c']))
    assert.equal(out.kept, 2)
    assert.equal(out.total, 3)
    assert.equal(out.layout.activeDesk, 'desk-1')
  })
})

describe('the drawer field', () => {
  const drawerWith = (ids: string[]): DrawerLayout => ({
    frames: { grid: grid(frameBranch([frameLeaf('frame-1', 1400)], 800)), views: { 'frame-1': layout(branch([leaf('1', ids, 1400)], 800), ids) } },
    activeFrame: 'frame-1',
  })
  const deskWith = (ids: string[]): DeskLayout => ({
    id: 'desk-1', name: 'Mesa 1', color: 'blue', activeFrame: 'frame-1',
    frames: { grid: grid(frameBranch([frameLeaf('frame-1', 1400)], 800)), views: { 'frame-1': layout(branch([leaf('1', ids, 1400)], 800), ids) } },
  })
  const file = (desks: DeskLayout[], drawer: DrawerLayout | null): LayoutV2 => ({ v: 2, desks, activeDesk: desks[0]!.id, drawer })

  test('a v2 file with drawer null (written before the drawer existed) reads as an empty drawer', () => {
    const out = migrateLayout({ ...file([deskWith(['a'])], null) })!
    assert.equal(out.migrated, false)
    assert.deepEqual(out.layout.drawer, emptyDrawer())
    assert.deepEqual(frameIdsOf(out.layout.drawer!.frames.grid), ['frame-1'])
    assert.deepEqual(out.layout.drawer!.frames.views, {})
  })

  test('a missing or malformed drawer is an empty one; a good one is kept as it is', () => {
    assert.deepEqual(drawerOf({ drawer: null }), emptyDrawer())
    assert.deepEqual(drawerOf({ drawer: { frames: 7 } as unknown as DrawerLayout }), emptyDrawer())
    assert.ok(!isDrawerLayout(undefined))
    const good = drawerWith(['x'])
    assert.equal(drawerOf({ drawer: good }), good)
    assert.deepEqual(migrateLayout({ ...file([deskWith(['a'])], good) })!.layout.drawer, good)
  })

  test('the fresh layout carries an empty drawer', () => {
    assert.deepEqual(emptyLayout().drawer, emptyDrawer())
  })

  test('panel ids count the panes of the drawer too', () => {
    assert.deepEqual(allPanelIds(file([deskWith(['a'])], drawerWith(['x', 'y']))).sort(), ['a', 'x', 'y'])
    assert.deepEqual(allPanelIds(file([deskWith(['a'])], null)), ['a'])
  })

  test('pruning drops the drawer panes the daemon forgot; kept/total span desks and drawer', () => {
    const out = pruneLayoutV2(file([deskWith(['a'])], drawerWith(['x', 'y'])), new Set(['a', 'y']))
    assert.equal(out.total, 3)
    assert.equal(out.kept, 2)
    assert.deepEqual(Object.keys(out.layout.drawer!.frames.views['frame-1']!.panels), ['y'])
    assert.deepEqual(allPanelIds(out.layout).sort(), ['a', 'y'])
  })

  test('nothing known in the drawer: an empty drawer, never a drawer without a frame', () => {
    const out = pruneDrawer(drawerWith(['x']), new Set())
    assert.deepEqual(out, emptyDrawer())
  })

  test('a pane lives in one place: an id the desks hold is dropped from the drawer', () => {
    const out = pruneLayoutV2(file([deskWith(['a', 'b'])], drawerWith(['b', 'c'])), new Set(['a', 'b', 'c']))
    assert.deepEqual(allPanelIds(out.layout).sort(), ['a', 'b', 'c'])
    assert.deepEqual(Object.keys(out.layout.drawer!.frames.views['frame-1']!.panels), ['c'])
    assert.equal(out.kept, 3)
    assert.equal(out.total, 4, 'the duplicate counts as lost: the caller rebuilds from the pruned layout')
  })

  test('pad frames (F10b): their panes are listed and pruned; a pane lives in one place', () => {
    const v3 = { ...file([{ ...deskWith(['a']), pads: { 'frame-pads.desk': drawerWith(['p', 'gone']), other: { any: 1 } } }], drawerWith(['x'])), v: 3 as const, sidebars: { ...emptyLayout().sidebars, pads: { 'frame-pads.global': drawerWith(['g', 'a']) } } }
    assert.deepEqual(allPanelIds(v3).sort(), ['a', 'a', 'g', 'gone', 'p', 'x'])
    const out = pruneLayoutV2(v3, new Set(['a', 'p', 'g', 'x']))
    const desk = out.layout.desks[0]!.pads!
    assert.deepEqual(Object.keys((desk['frame-pads.desk'] as DrawerLayout).frames.views['frame-1']!.panels), ['p'])
    assert.deepEqual(desk.other, { any: 1 }, 'a pad state that is not frames is kept as is')
    assert.deepEqual(Object.keys((out.layout.sidebars.pads['frame-pads.global'] as DrawerLayout).frames.views['frame-1']!.panels), ['g'], 'the desks keep a; the global pad drops its copy')
    assert.deepEqual(allPanelIds(out.layout).sort(), ['a', 'g', 'p', 'x'])
  })

  test('a per-panel pad state is kept while its panel is known or it holds panes, and dropped when neither', () => {
    const pads = {
      'frame-pads.panel@live': drawerWith([]),
      'frame-pads.panel@dead': drawerWith([]),
      'frame-pads.panel@deadWithPane': drawerWith(['p']),
      'frame-pads.panel@inLayout': drawerWith([]),
      'frame-pads.global': drawerWith([]),
    }
    const v3 = { ...file([deskWith(['inLayout'])], drawerWith([])), v: 3 as const, sidebars: { ...emptyLayout().sidebars, pads } }
    const out = pruneLayoutV2(v3, new Set(['live', 'inLayout', 'p']))
    assert.deepEqual(Object.keys(out.layout.sidebars.pads).sort(), ['frame-pads.global', 'frame-pads.panel@deadWithPane', 'frame-pads.panel@inLayout', 'frame-pads.panel@live'])
  })

  test('an untouched drawer survives pruning byte for byte', () => {
    const drawer = drawerWith(['x', 'y'])
    assert.deepEqual(pruneDrawer(drawer, new Set(['x', 'y'])), drawer)
  })
})

describe('frameInsertion', () => {
  test('a lone frame: a sibling along the root axis, or beside it across (the gridview splits that cell, which is the whole desk)', () => {
    const g = grid(frameBranch([frameLeaf('frame-1')]))
    assert.deepEqual(frameInsertion(g, 'right'), { kind: 'location', location: [1], wrapRoot: false })
    assert.deepEqual(frameInsertion(g, 'left'), { kind: 'location', location: [0], wrapRoot: false })
    assert.deepEqual(frameInsertion(g, 'below'), { kind: 'beside', referenceFrame: 'frame-1', direction: 'below' })
    assert.deepEqual(frameInsertion(g, 'above'), { kind: 'beside', referenceFrame: 'frame-1', direction: 'above' })
  })

  test('frames across the same axis: a new sibling at the start or the end', () => {
    const g = grid(frameBranch([frameLeaf('frame-1'), frameLeaf('frame-2')]), 'HORIZONTAL')
    assert.deepEqual(frameInsertion(g, 'right'), { kind: 'location', location: [2], wrapRoot: false })
    assert.deepEqual(frameInsertion(g, 'left'), { kind: 'location', location: [0], wrapRoot: false })
  })

  test('frames across the other axis: the root is wrapped so the new frame spans them all', () => {
    const g = grid(frameBranch([frameLeaf('frame-1'), frameLeaf('frame-2')]), 'HORIZONTAL')
    assert.deepEqual(frameInsertion(g, 'below'), { kind: 'location', location: [1], wrapRoot: true })
    assert.deepEqual(frameInsertion(g, 'above'), { kind: 'location', location: [0], wrapRoot: true })
  })

  test('a root with a single nested branch (as dockview serializes after a wrap): the inner branch is the desk', () => {
    const g = grid(frameBranch([frameBranch([frameLeaf('frame-1'), frameLeaf('frame-2')])]), 'VERTICAL')
    // inner branch is HORIZONTAL: left/right are siblings inside it, above/below are siblings of it in the root.
    assert.deepEqual(frameInsertion(g, 'right'), { kind: 'location', location: [0, 2], wrapRoot: false })
    assert.deepEqual(frameInsertion(g, 'below'), { kind: 'location', location: [1], wrapRoot: false })
    assert.deepEqual(frameInsertion(g, 'above'), { kind: 'location', location: [0], wrapRoot: false })
  })

  test('an empty grid: the first cell', () => {
    assert.deepEqual(frameInsertion(grid(frameBranch([])), 'left'), { kind: 'location', location: [0], wrapRoot: false })
  })

  test('nextFrameId never reuses a live id', () => {
    assert.equal(nextFrameId(grid(frameBranch([frameLeaf('frame-1'), frameLeaf('frame-3')]))), 'frame-2')
    assert.equal(nextFrameId(grid(frameBranch([]))), 'frame-1')
  })
})

// Restore policy over v2: a slot the daemon does not list is hidden from the display, never written back; an
// empty (or failed) list is not trusted and leaves the layout exactly as saved.
describe('planRestore', () => {
  const two = () => layout(branch([leaf('1', ['a'], 700), leaf('2', ['b'], 700)], 800), ['a', 'b'])
  const twoFramesV2 = (): LayoutV2 => ({
    v: 2, activeDesk: 'desk-1', drawer: null,
    desks: [{
      id: 'desk-1', name: 'Mesa 1', color: 'blue', activeFrame: 'frame-1',
      frames: {
        grid: grid(frameBranch([frameLeaf('frame-1', 700), frameLeaf('frame-2', 700)], 800)),
        views: { 'frame-1': two(), 'frame-2': layout(branch([leaf('1', ['c'], 1400)], 800), ['c']) },
      },
    }],
  })

  test('v1, daemon knows no slot at all: shown untouched (the frame view is the saved file), nothing orphaned', () => {
    const saved = two()
    const plan = planRestore(saved, new Set())
    assert.equal(plan.layout!.desks[0]!.frames.views['frame-1'], saved)
    assert.equal(plan.migrated, true)
    assert.deepEqual(plan.orphaned, [])
  })

  test('v1, one slot missing: hidden from the display and reported, the saved object itself is not touched', () => {
    const saved = two()
    const before = JSON.stringify(saved)
    const plan = planRestore(saved, new Set(['b']))
    assert.deepEqual(Object.keys(plan.layout!.desks[0]!.frames.views['frame-1']!.panels), ['b'])
    assert.deepEqual(plan.orphaned, ['a'])
    assert.equal(JSON.stringify(saved), before)
  })

  test('v2, empty slot list: the saved desks and drawer (same objects), every frame and pane kept', () => {
    const saved = twoFramesV2()
    const before = JSON.stringify(saved)
    const plan = planRestore(saved, new Set())
    assert.equal(plan.layout!.desks, saved.desks)
    assert.equal(plan.from, 2)
    assert.equal(plan.migrated, false)
    assert.deepEqual(plan.orphaned, [])
    assert.equal(JSON.stringify(saved), before)
  })

  test('v2, every pane known: the saved object, no rewrite', () => {
    const saved = twoFramesV2()
    assert.equal(planRestore(saved, new Set(['a', 'b', 'c'])).layout!.desks, saved.desks)
  })

  test('v2, a whole frame\'s slot missing: that frame leaves the display only; the saved v2 is untouched', () => {
    const saved = twoFramesV2()
    const before = JSON.stringify(saved)
    const plan = planRestore(saved, new Set(['a', 'b']))
    assert.deepEqual(plan.orphaned, ['c'])
    assert.deepEqual(frameIdsOf(plan.layout!.desks[0]!.frames.grid), ['frame-1'])
    assert.deepEqual(allPanelIds(plan.layout!).sort(), ['a', 'b'])
    assert.equal(JSON.stringify(saved), before, 'pruning never mutates what was read from disk')
    assert.deepEqual(allPanelIds(saved).sort(), ['a', 'b', 'c'])
  })

  test('not a layout (null, garbage): nothing to show, nothing orphaned', () => {
    assert.deepEqual(planRestore(null, new Set(['a'])), { layout: null, migrated: false, orphaned: [] })
    assert.deepEqual(planRestore({ grid: 1 }, new Set(['a'])), { layout: null, migrated: false, orphaned: [] })
  })
})

describe('isPersonChange', () => {
  test('a hint or a title the app updates alone schedules no save', () => {
    assert.equal(isPersonChange(new Set(['panelParameters'])), false)
    assert.equal(isPersonChange(new Set(['panelTitle', 'panelParameters'])), false)
  })
  test('anything else (or no reasons) is a change worth saving', () => {
    assert.equal(isPersonChange(new Set(['structure'])), true)
    assert.equal(isPersonChange(new Set(['panelParameters', 'geometry'])), true)
    assert.equal(isPersonChange(undefined), true)
    assert.equal(isPersonChange(new Set()), true)
  })
})

// The renderer side of the policy (app/renderer/main.ts is a browser bundle, not loadable here): restoring and
// reconnecting must never schedule a save, whatever the daemon lists; the save they provoke is discarded.
describe('restore and reconnect never write layout.json (renderer source)', () => {
  const src = readFileSync(join(import.meta.dirname, '..', '..', 'app', 'renderer', 'main.ts'), 'utf8')
  const body = (start: string, end: string): string => {
    const i = src.indexOf(start)
    assert.ok(i >= 0, `${start} not found`)
    const j = src.indexOf(end, i + start.length)
    assert.ok(j > i, `${end} not found after ${start}`)
    return src.slice(i, j)
  }

  test('restoreLayout: display-only pruning through planRestore, the pending save discarded, no scheduleSave', () => {
    const restore = body('async function restoreLayout(', '\nfunction paintGeometry(')
    assert.match(restore, /planRestore\(/)
    assert.match(restore, /await discardPendingSave\(\)/)
    assert.doesNotMatch(restore, /scheduleSave\(|saveLayout\(/)
  })

  test('reconnect: unknown panes hidden through orphanedPanels (empty list hides nothing), no scheduleSave', () => {
    const reconnect = body('// Reconnected (the daemon was restarted)', 'autoStartPanels()')
    assert.match(reconnect, /orphanedPanels\(/)
    assert.match(reconnect, /await discardPendingSave\(\)/)
    assert.doesNotMatch(reconnect, /scheduleSave\(|saveLayout\(/)
  })

  test('layout changes reach scheduleSave only through isPersonChange', () => {
    assert.match(src, /onLayoutChange: reasons => \{ if \(isPersonChange\(reasons\)\) scheduleSave\(\) \}/)
  })
})

describe('orphanedPanels', () => {
  test('empty known list hides nothing', () => {
    assert.deepEqual(orphanedPanels(['a', 'b'], new Set()), [])
  })
  test('only the unknown ones', () => {
    assert.deepEqual(orphanedPanels(['a', 'b', 'c'], new Set(['b'])), ['a', 'c'])
  })
})

// The desk colour on disk: a hue name; a number is an index of the OLD 8-colour palette; anything else is blue.
describe('desk colour read/write', () => {
  const oneDesk = (color: unknown): unknown => ({
    v: 2, activeDesk: 'desk-1', drawer: null,
    desks: [{ id: 'desk-1', name: 'Mesa 1', color, frames: emptyLayout().desks[0]!.frames, activeFrame: 'frame-1' }],
  })
  const colorAfterRead = (color: unknown): string => migrateLayout(oneDesk(color))!.layout.desks[0]!.color

  test('a number reads as the old palette index: 3 is red (never lime), grey (7) is sky', () => {
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map(colorAfterRead), ['blue', 'green', 'orange', 'red', 'purple', 'cyan', 'pink', 'sky'])
  })

  test('numbers keep the old wrap-around and truncation; junk is blue', () => {
    assert.equal(colorAfterRead(8), 'blue')
    assert.equal(colorAfterRead(11), 'red')
    assert.equal(colorAfterRead(-1), 'sky')
    assert.equal(colorAfterRead(3.9), 'red')
    for (const junk of ['pink-ish', '', null, undefined, {}, [], true, Number.NaN, Infinity]) assert.equal(colorAfterRead(junk), 'blue', String(junk))
  })

  test('a hue name stays as it is, all 12', () => {
    for (const hue of ['red', 'orange', 'yellow', 'lime', 'green', 'teal', 'cyan', 'sky', 'blue', 'purple', 'magenta', 'pink']) assert.equal(colorAfterRead(hue), hue)
  })

  test('reading a file with names returns the very same desks (no rewrite, planRestore keeps the saved object)', () => {
    const saved = oneDesk('lime') as LayoutV2
    assert.equal(migrateLayout(saved)!.layout.desks, saved.desks)
    assert.equal(readDeskColors(saved.desks), saved.desks)
    assert.equal(planRestore(saved, new Set()).layout!.desks, saved.desks)
  })

  test('an old numeric file reads as names and the saved object is left untouched (the next save writes names)', () => {
    const saved = oneDesk(4) as LayoutV2
    const before = JSON.stringify(saved)
    const plan = planRestore(saved, new Set())
    assert.equal(plan.layout!.desks[0]!.color, 'purple')
    assert.equal(JSON.stringify(saved), before)
    assert.equal(JSON.parse(JSON.stringify(plan.layout)).desks[0].color, 'purple')
  })

  test('only the desks that need it are rebuilt; the empty layout and a v1 file start blue', () => {
    const base = emptyLayout().desks[0]!
    const mixed = [{ ...base, color: 'red' as const }, { ...base, id: 'desk-2', color: 1 as unknown as 'red' }]
    const out = readDeskColors(mixed)
    assert.equal(out[0], mixed[0])
    assert.equal(out[1]!.color, 'green')
    assert.equal(base.color, 'blue')
    assert.equal(migrateLayout({ grid: { root: { type: 'branch', data: [] }, width: 1, height: 1, orientation: 'HORIZONTAL' }, panels: {} })!.layout.desks[0]!.color, 'blue')
  })
})
