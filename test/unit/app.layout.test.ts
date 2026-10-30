// The layout file (app/renderer/layout.ts): the v1 → v2 migration keeps the user's dockview JSON byte for
// byte as the single frame of "Mesa 1"; pruning drops unknown panes frame by frame and empty frames with
// them (a frame's root stays a branch: dockview refuses a leaf there); frameInsertion plans a frame that
// spans a whole desk edge. Fixtures: hand-made grids and the real layout.json of a working machine.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SerializedDockview } from 'dockview-core'
import { allPanelIds, drawerOf, emptyDrawer, emptyLayout, frameIdsOf, frameInsertion, isLayoutV1, isDrawerLayout, isLayoutV2, migrateLayout, nextFrameId, pruneDesk, pruneDrawer, pruneLayout, pruneLayoutV2, singleFrameGrid, type DeskLayout, type DrawerLayout, type FrameGrid, type LayoutV2 } from '../../app/renderer/layout.ts'

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
    assert.equal(out.layout.v, 2)
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

  test('a v2 file is returned as is; nothing else is a layout', () => {
    const v2 = emptyLayout()
    assert.deepEqual(migrateLayout(v2), { layout: v2, migrated: false })
    assert.equal(migrateLayout(null), null)
    assert.equal(migrateLayout({}), null)
    assert.equal(migrateLayout({ grid: {}, panels: {} }), null, 'a grid without a root is not v1')
    assert.equal(migrateLayout({ v: 3, desks: [], activeDesk: 'x' }), null, 'a version from the future is not read')
    assert.equal(migrateLayout('{"grid":1}'), null)
    assert.ok(isLayoutV1(real))
    assert.ok(!isLayoutV2(real))
    assert.ok(isLayoutV2(v2))
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
    id: 'desk-1', name: 'Mesa 1', color: 0, activeFrame: 'frame-2',
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
    id: 'desk-1', name: 'Mesa 1', color: 0, activeFrame: 'frame-1',
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
