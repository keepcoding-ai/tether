// System desks (app/renderer/layout.ts, layout.json v4): complete desks kept outside the person's queue, by a stable id.
// The v3 -> v4 migration reopens an existing file intact; a system desk nobody declares stays in the file, unseen;
// a malformed `systemDesks` reads as empty without costing the rest of the file.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  allPanelIds, emptyLayout, emptySystemDesk, ensureSystemDesk, isLayoutV4, isSystemDeskId, isUserDesk, migrateLayout, planRestore,
  pruneLayoutV2, queueDesks, readSystemDesks, resolveActiveDesk, systemDeskOf, visibleSystemDesks, withQueueDesks, withSystemDesk,
  type Layout, type LayoutV3, type SystemDeskLayout,
} from '../../app/renderer/layout.ts'

const fixture = (name: string): string => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8')
const panelOf = (id: string) => ({ id, contentComponent: 'terminal', tabComponent: 'slot-tab', params: { slotId: id }, title: id })
/** A system desk holding one frame whose dockview has the given panes. */
function systemDeskWith(ids: string[]): SystemDeskLayout {
  const base = emptySystemDesk()
  const view = { grid: { root: { type: 'branch', data: [{ type: 'leaf', data: { views: ids, activeView: ids[0], id: '1' }, size: 1200 }], size: 800 }, width: 1200, height: 800, orientation: 'HORIZONTAL' }, panels: Object.fromEntries(ids.map(i => [i, panelOf(i)])), activeGroup: '1' }
  return { ...base, frames: { ...base.frames, views: { 'frame-1': view as never } } }
}
const withSystem = (): Layout => withSystemDesk(emptyLayout(), 'ext.board', systemDeskWith(['s1', 's2']))

describe('layout v3 to v4', () => {
  test('a v3 file reopens intact: same desks, frames, panes, drawer, side bars and active desk; no system desks', () => {
    const v3 = JSON.parse(fixture('layout-v3-synthetic.json')) as LayoutV3
    const out = migrateLayout(JSON.parse(fixture('layout-v3-synthetic.json')))!
    assert.equal(out.from, 3)
    assert.equal(out.migrated, false)
    assert.equal(out.layout.v, 4)
    assert.deepEqual(out.layout.systemDesks, {})
    assert.deepEqual(out.layout.desks, v3.desks)
    assert.deepEqual(out.layout.drawer, v3.drawer)
    assert.deepEqual(out.layout.sidebars, v3.sidebars)
    assert.equal(out.layout.activeDesk, 'desk-2')
    assert.deepEqual(allPanelIds(out.layout), allPanelIds(v3))
  })

  test('planRestore on a v3 file reports the version it came from (the caller keeps layout.v3.bak)', () => {
    const plan = planRestore(JSON.parse(fixture('layout-v3-synthetic.json')), new Set())
    assert.equal(plan.from, 3)
    assert.equal(plan.layout!.v, 4)
  })

  test('v2 and v1 files also reach v4 with no system desks', () => {
    assert.deepEqual(migrateLayout(JSON.parse(fixture('layout-v2-synthetic.json')))!.layout.systemDesks, {})
    assert.deepEqual(migrateLayout(JSON.parse(fixture('layout-v1-real.json')))!.layout.systemDesks, {})
  })
})

describe('reading systemDesks', () => {
  test('a v4 file keeps its system desks, declared or not', () => {
    const written = JSON.parse(JSON.stringify(withSystem()))
    const back = migrateLayout(written)!
    assert.equal(back.from, 4)
    assert.deepEqual(back.layout.systemDesks, withSystem().systemDesks)
    assert.deepEqual(allPanelIds(back.layout).sort(), ['s1', 's2'])
  })

  test('malformed systemDesks reads as empty and the rest of the file is untouched', () => {
    for (const bad of [null, 'x', 7, [], [systemDeskWith(['a'])], { a: 1 }]) {
      const out = migrateLayout({ ...emptyLayout(), systemDesks: bad })!
      assert.deepEqual(out.layout.systemDesks, {}, JSON.stringify(bad))
      assert.deepEqual(out.layout.desks, emptyLayout().desks)
    }
    const missing = { ...emptyLayout() } as Record<string, unknown>
    delete missing.systemDesks
    assert.deepEqual(migrateLayout(missing)!.layout.systemDesks, {})
  })

  test("one bad entry is dropped and the good ones stay; an id that is a queue desk's is dropped; the pads survive", () => {
    const good = { ...systemDeskWith(['s1']), pads: { p: { any: 1 } } }
    const raw = { ...emptyLayout(), systemDesks: { good, broken: { frames: 3 }, 'desk-1': systemDeskWith(['x']), '': systemDeskWith(['y']) } }
    const out = migrateLayout(raw)!.layout
    assert.deepEqual(Object.keys(out.systemDesks), ['good'])
    assert.deepEqual(out.systemDesks.good, good)
    assert.deepEqual(readSystemDesks(JSON.parse('{"__proto__": {"frames": {}}}')), {})
  })

  test('round trip: serialize then read gives the same layout', () => {
    const layout: Layout = { ...withSystem(), activeDesk: 'ext.board' }
    const text = JSON.stringify(layout)
    assert.ok(isLayoutV4(JSON.parse(text)))
    assert.deepEqual(migrateLayout(JSON.parse(text))!.layout, layout)
  })

  test('a system desk nobody declares stays in the file and out of sight', () => {
    const layout = withSystem()
    assert.deepEqual(visibleSystemDesks(layout, []), [])
    assert.deepEqual(visibleSystemDesks(layout, ['ext.other', 'ext.board']), ['ext.board'], 'declared but absent from the file: not there yet')
    const reread = migrateLayout(JSON.parse(JSON.stringify(layout)))!.layout
    assert.deepEqual(reread.systemDesks['ext.board'], layout.systemDesks['ext.board'], 'preserved whole')
    // Pruning is for display and keeps it as well.
    assert.ok(isSystemDeskId(pruneLayoutV2(layout, new Set(['s1', 's2'])).layout, 'ext.board'))
  })
})

describe('system desk rules', () => {
  test('get or create by id: the same layout when it exists, an empty desk (outside desks[]) when it does not', () => {
    const base = emptyLayout()
    const created = ensureSystemDesk(base, 'ext.board')
    assert.deepEqual(created.systemDesks['ext.board'], emptySystemDesk())
    assert.equal(created.desks, base.desks, 'desks[] untouched')
    assert.equal(ensureSystemDesk(created, 'ext.board'), created)
    assert.deepEqual(systemDeskOf(base, 'ext.board'), emptySystemDesk(), 'reading does not create')
    assert.deepEqual(base.systemDesks, {})
    assert.throws(() => ensureSystemDesk(base, base.desks[0]!.id), /queue desk/)
    assert.throws(() => ensureSystemDesk(base, ''), /invalid/)
    assert.throws(() => ensureSystemDesk(base, '__proto__'), /invalid/)
  })

  test('knowing a desk is a system desk, and the queue never includes it', () => {
    const layout = withSystem()
    assert.ok(isSystemDeskId(layout, 'ext.board'))
    assert.ok(!isSystemDeskId(layout, 'desk-1'))
    assert.ok(!isSystemDeskId(layout, 'toString'))
    assert.ok(isUserDesk(layout, 'desk-1'))
    assert.ok(!isUserDesk(layout, 'ext.board'), 'never a target of reorder, close or rename')
    assert.ok(!isUserDesk(layout, 'nope'))
    const polluted = { ...layout, desks: [...layout.desks, { ...layout.desks[0]!, id: 'ext.board' }] }
    assert.deepEqual(queueDesks(polluted).map(d => d.id), ['desk-1'])
    assert.ok(!isUserDesk(polluted, 'ext.board'))
  })

  test('a system id never enters desks[]', () => {
    const layout = withSystem()
    const next = withQueueDesks(layout, [...layout.desks, { ...layout.desks[0]!, id: 'ext.board' }, { ...layout.desks[0]!, id: 'desk-2' }])
    assert.deepEqual(next.desks.map(d => d.id), ['desk-1', 'desk-2'])
    assert.equal(next.systemDesks, layout.systemDesks)
  })

  test("replacing a system desk's content", () => {
    const next = withSystemDesk(emptyLayout(), 'ext.board', systemDeskWith(['s9']))
    assert.deepEqual(allPanelIds(next), ['s9'])
    assert.equal(next.desks.length, 1)
  })

  test('the active desk can be a system desk when declared; otherwise it resolves to the first queue desk', () => {
    const layout: Layout = { ...withSystem(), activeDesk: 'ext.board' }
    assert.equal(resolveActiveDesk(layout, new Set(['ext.board'])), 'ext.board')
    assert.equal(resolveActiveDesk(layout, new Set()), 'desk-1', 'extension off: kept in the file, not shown')
    assert.equal(resolveActiveDesk({ ...layout, activeDesk: 'desk-1' }), 'desk-1')
    assert.equal(resolveActiveDesk({ ...layout, activeDesk: 'gone' }, new Set(['ext.board'])), 'desk-1')
    // Pruning keeps an active pointer at a system desk (it is not a dangling queue id).
    assert.equal(pruneLayoutV2(layout, new Set(['s1'])).layout.activeDesk, 'ext.board')
    assert.equal(pruneLayoutV2({ ...layout, activeDesk: 'gone' }, new Set(['s1'])).layout.activeDesk, 'desk-1')
  })

  test('panes: counted across the layout, pruned like any frame, and a pane lives in one place', () => {
    const layout = withSystem()
    assert.deepEqual(allPanelIds(layout).sort(), ['s1', 's2'])
    const pruned = pruneLayoutV2(layout, new Set(['s1']))
    assert.equal(pruned.kept, 1)
    assert.equal(pruned.total, 2)
    assert.deepEqual(allPanelIds(pruned.layout), ['s1'])
    // A queue desk holds s1 too: the system desk loses it.
    const deskWithS1 = { ...emptyLayout().desks[0]!, frames: systemDeskWith(['s1']).frames }
    const dup = withQueueDesks(layout, [deskWithS1])
    const ids = allPanelIds(pruneLayoutV2(dup, new Set(['s1', 's2'])).layout)
    assert.equal(ids.filter(i => i === 's1').length, 1)
    assert.ok(ids.includes('s2'))
  })
})
