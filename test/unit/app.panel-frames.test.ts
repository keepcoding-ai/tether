// The frames of the panel pad (app/renderer/panel-frames.ts): the map the manager shows (loose / desks / elsewhere), what
// counts as content (a pane of any kind: note, terminal, agent, browser), one desk's share of it, and the operations on
// the stored frames (close, clean the empty loose ones), each with a snapshot that undoes it.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  allRows, buildFrameTree, cleanEmptyFrames, closeFrames, emptyLooseKeys, forDesk, frameCounts, guideGroups, hasContent, panesOf, pruneMeta, readFrameMeta, restoreFrames, savedFramePanes,
  visibleRows, whenLabel, type FrameSource, type FrameStore, type PanelFrameTreeInput,
} from '../../app/renderer/panel-frames.ts'

type P = { id: string; component?: string; title?: string; path?: string; url?: string }

/** A pad's frame state (the drawer's shape): one frame, one group with these panes as tabs. */
function frame(...panes: P[]): unknown {
  const panels = Object.fromEntries(panes.map(p => [p.id, { id: p.id, contentComponent: p.component ?? 'note', title: p.title ?? p.id, params: p.path ? { note: { path: p.path } } : p.url ? { url: p.url } : {} }]))
  const view = { grid: { root: { type: 'branch', data: [{ type: 'leaf', data: { views: panes.map(p => p.id), activeView: panes[0]?.id, id: '1' } }] }, width: 100, height: 100, orientation: 'HORIZONTAL' }, panels }
  return { frames: { grid: { root: { type: 'branch', data: [{ type: 'leaf', data: { id: 'f1', component: 'frame' } }] } }, views: { f1: view } } }
}
const blank = (id = 'empty:1'): P => ({ id, component: 'empty', title: 'Vazio' })
const PANEL = 'frame-pads.panel'
const pk = (id: string): string => `${PANEL}@${id}`

function input(over: Partial<PanelFrameTreeInput> = {}): PanelFrameTreeInput {
  const sources: FrameSource[] = [
    { key: pk('a'), padId: PANEL, panelId: 'a', state: frame({ id: 'note:1', title: 'bug do cwd', path: 'C:/n/1.md' }) },
    // A frame is not a note: panel b keeps a Claude and a terminal in its frame.
    { key: pk('b'), padId: PANEL, panelId: 'b', state: frame({ id: 'claude-1', component: 'terminal', title: 'claude·soul' }, { id: 'sh-1', component: 'terminal', title: 'shell' }) },
    { key: pk('gone'), padId: PANEL, panelId: 'gone', state: frame({ id: 'note:2', title: 'lembrar' }) },
    { key: pk('gone2'), padId: PANEL, panelId: 'gone2', state: frame(blank()) },
    { key: pk('drawer'), padId: PANEL, panelId: 'drawer', state: frame({ id: 'web-1', component: 'browser-web', title: 'Docs', url: 'https://example.test' }) },
  ]
  return {
    sources,
    meta: { [pk('gone')]: { ownerLabel: 'claude·atrium', deskId: 'd1', updatedAt: 1000 }, [pk('gone2')]: { ownerLabel: 'shell', updatedAt: 2000 } },
    desks: [{ id: 'd1', name: 'tether' }, { id: 'd2', name: 'atrium' }],
    livePanels: new Map([['a', { label: 'claude·tether', deskId: 'd1' }], ['b', { label: 'tether', deskId: 'd2' }], ['drawer', { label: 'gaveta' }]]),
    focusedPanel: 'a',
    activeDeskId: 'd1',
    ...over,
  }
}

describe('panel frames: reading a frame', () => {
  test('panes in order with their file or address; content = a pane of any kind that is not an empty pane', () => {
    assert.deepEqual(panesOf(frame({ id: 'note:1', title: 'x', path: 'C:/a.md' }, blank(), { id: 'web-1', component: 'browser-web', title: 'Docs', url: 'https://x.test' })), [
      { id: 'note:1', title: 'x', component: 'note', file: 'C:/a.md' },
      { id: 'empty:1', title: 'Vazio', component: 'empty' },
      { id: 'web-1', title: 'Docs', component: 'browser-web', url: 'https://x.test' },
    ])
    assert.equal(hasContent(frame(blank())), false)
    assert.equal(hasContent(frame(blank(), { id: 's1', component: 'terminal' })), true, 'a terminal is content')
    assert.equal(hasContent(undefined), false)
    assert.deepEqual(panesOf({ nope: 1 }), [])
  })
})

describe('panel frames: the tree', () => {
  test('loose first (content before empty), each desk with its panels, then the panels outside every desk', () => {
    const tree = buildFrameTree(input())
    assert.deepEqual(tree.loose.map(r => r.key), [pk('gone'), pk('gone2')])
    assert.equal(tree.loose[0]!.label, 'claude·atrium', 'a loose frame keeps the recorded panel label')
    assert.equal(tree.loose[0]!.title, 'lembrar')
    assert.equal(tree.loose[1]!.empty, true)
    assert.deepEqual(tree.desks[0]!.panels.map(r => [r.key, r.label, r.focused, r.tabs]), [[pk('a'), 'claude·tether', true, 1]])
    assert.deepEqual(tree.desks[1]!.panels.map(r => [r.key, r.label, r.tabs, r.title]), [[pk('b'), 'tether', 2, 'claude·soul']], 'a frame with a Claude and a shell is a frame like any other')
    assert.deepEqual(tree.elsewhere.map(r => [r.key, r.label]), [[pk('drawer'), 'gaveta']])
    assert.equal(allRows(tree).length, 5)
  })

  test('one desk at a time: its loose frames (and the never-recorded ones) and its panels; filters, counts, empty loose keys', () => {
    const tree = buildFrameTree(input())
    assert.deepEqual(forDesk(tree, 'd1').loose.map(r => r.key), [pk('gone'), pk('gone2')], "gone lived in d1; gone2 has no desk recorded, so it shows in every desk")
    assert.deepEqual(forDesk(tree, 'd2').loose.map(r => r.key), [pk('gone2')])
    assert.deepEqual(forDesk(tree, 'd2').panels.map(r => r.key), [pk('b')])
    assert.deepEqual(visibleRows(tree, 'loose').map(r => r.key), [pk('gone'), pk('gone2')])
    assert.deepEqual(visibleRows(tree, 'all').map(r => r.key), [pk('gone'), pk('gone2'), pk('a')], 'the active desk (d1): a loose empty frame is listed; a live empty one would not be')
    assert.deepEqual(visibleRows(tree, 'all', 'd2').map(r => r.key), [pk('gone2'), pk('b')])
    const withBlank = buildFrameTree(input({ sources: [...input().sources, { key: pk('c'), padId: PANEL, panelId: 'c', state: frame(blank('empty:c')) }], livePanels: new Map([...input().livePanels, ['c', { label: 'c', deskId: 'd1' }]]) }))
    assert.ok(!visibleRows(withBlank, 'all').some(r => r.key === pk('c')), 'a live panel with a blank frame has nothing to look after')
    assert.deepEqual(frameCounts(tree), { loose: 1, looseEmpty: 1, withContent: 4 })
    assert.deepEqual(emptyLooseKeys(tree), [pk('gone2')])
  })

  test('the manager lists guides grouped by owner: focused owner first, then open, then closed; no group without real panes', () => {
    const tree = buildFrameTree(input())
    const all = guideGroups(tree, 'all')
    assert.deepEqual(all.map(g => g.row.key), [pk('a'), pk('gone')], 'd1: a (in focus) then gone (closed); gone2 has only an empty pane')
    assert.ok(all.every(g => g.guides.every(p => p.component !== 'empty')), 'an empty pane is never a guide')
    assert.deepEqual(guideGroups(tree, 'loose').map(g => g.row.key), [pk('gone')])
    assert.deepEqual(guideGroups(tree, 'all', 'd2').map(g => [g.row.key, g.guides.length]), [[pk('b'), 2]], 'two panes in one frame: two guides in one group')
  })

  test('a panel that comes back takes its frame back (alive again, not loose)', () => {
    const tree = buildFrameTree(input({ livePanels: new Map([...input().livePanels, ['gone', { label: 'claude·atrium', deskId: 'd2' }]]) }))
    assert.deepEqual(tree.loose.map(r => r.key), [pk('gone2')])
    assert.deepEqual(tree.desks[1]!.panels.map(r => r.key), [pk('b'), pk('gone')])
  })

  test('a live panel whose desk is gone from the list is listed outside the desks', () => {
    const tree = buildFrameTree(input({ desks: [{ id: 'd2', name: 'atrium' }] }))
    assert.ok(tree.elsewhere.some(r => r.key === pk('a')))
  })
})

describe('panel frames: operations', () => {
  const store = (): FrameStore => {
    const i = input()
    return { pads: Object.fromEntries(i.sources.map(s => [s.key, s.state])), meta: { ...i.meta } }
  }

  test('close removes frame and record; the snapshot puts them back exactly', () => {
    const s = store()
    const { store: after, undo } = closeFrames(s, [pk('gone'), 'missing'])
    assert.equal(pk('gone') in after.pads, false)
    assert.equal(pk('gone') in after.meta, false)
    assert.deepEqual(undo.entries.map(e => e.key), [pk('gone')])
    assert.deepEqual(restoreFrames(after, undo), s)
  })

  test('clean the empty loose frames, undoable', () => {
    const s = store()
    const { store: after, keys, undo } = cleanEmptyFrames(s, buildFrameTree(input()))
    assert.deepEqual(keys, [pk('gone2')])
    assert.equal(pk('gone2') in after.pads, false)
    assert.ok(pk('a') in after.pads && pk('b') in after.pads, 'the live frames stay')
    assert.deepEqual(restoreFrames(after, undo), s)
  })

})

describe('panel frames: records', () => {
  test('read tolerantly, pruned to the keys that still exist', () => {
    const meta = readFrameMeta({ k1: { ownerLabel: 'x', updatedAt: 1, deskId: 'd' }, k2: { ownerLabel: 3 }, k3: null, k4: { ownerLabel: 'y', updatedAt: 2 } })
    assert.deepEqual(meta, { k1: { ownerLabel: 'x', updatedAt: 1, deskId: 'd' }, k4: { ownerLabel: 'y', updatedAt: 2 } })
    assert.deepEqual(readFrameMeta([1]), {})
    assert.deepEqual(Object.keys(pruneMeta(meta, ['k4'])), ['k4'])
  })

  test('when: agora, hh:mm, ontem, weekday, d/m', () => {
    const now = new Date(2026, 10, 9, 15, 0).getTime()
    assert.equal(whenLabel(now - 10_000, now), 'agora')
    assert.equal(whenLabel(new Date(2026, 10, 9, 13, 5).getTime(), now), '13:05')
    assert.equal(whenLabel(new Date(2026, 10, 8, 13, 5).getTime(), now), 'ontem')
    assert.equal(whenLabel(new Date(2026, 10, 3, 13, 5).getTime(), now), 'ter')
    assert.equal(whenLabel(new Date(2026, 9, 20).getTime(), now), '20/10')
    assert.equal(whenLabel(undefined, now), '')
  })
})

describe('panel frames: panes only the saved state knows', () => {
  test('lists the panes of unmounted frames with their frame key, skipping live ids and repeats', () => {
    const sources: FrameSource[] = [
      { key: pk('a'), padId: PANEL, panelId: 'a', state: frame({ id: 'note:1', title: 'n', path: 'C:/n.md' }, { id: 'sh-1', component: 'terminal' }) },
      { key: pk('b'), padId: PANEL, panelId: 'b', state: frame({ id: 'web-1', component: 'browser-web', title: 'Docs', url: 'https://x.test' }, { id: 'note:1' }) },
    ]
    const r = savedFramePanes(sources, id => id === 'sh-1')
    assert.deepEqual(r.map(p => [p.id, p.key]), [['note:1', pk('a')], ['web-1', pk('b')]])
    assert.equal(r[0]!.file, 'C:/n.md')
    assert.equal(r[1]!.url, 'https://x.test')
    assert.deepEqual(savedFramePanes([], () => false), [])
  })
})
