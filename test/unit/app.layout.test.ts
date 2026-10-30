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
import { allPanelIds, emptyLayout, frameIdsOf, frameInsertion, isLayoutV1, isLayoutV2, isPersonChange, migrateLayout, nextFrameId, orphanedPanels, planRestore, pruneDesk, pruneLayout, pruneLayoutV2, singleFrameGrid, type DeskLayout, type FrameGrid, type LayoutV2 } from '../../app/renderer/layout.ts'

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
    assert.equal(out.layout.drawer, null)
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
      id: 'desk-1', name: 'Mesa 1', color: 0, activeFrame: 'frame-1',
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

  test('v2, empty slot list: the layout is the saved one (same object), every frame and pane kept', () => {
    const saved = twoFramesV2()
    const before = JSON.stringify(saved)
    const plan = planRestore(saved, new Set())
    assert.equal(plan.layout, saved)
    assert.equal(plan.migrated, false)
    assert.deepEqual(plan.orphaned, [])
    assert.equal(JSON.stringify(saved), before)
  })

  test('v2, every pane known: the saved object, no rewrite', () => {
    const saved = twoFramesV2()
    assert.equal(planRestore(saved, new Set(['a', 'b', 'c'])).layout, saved)
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
    const restore = body('async function restoreLayout(', '\nfunction mountedDesk(')
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
