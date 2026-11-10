// The notes of the frames pads (app/renderer/pad-notes.ts): the map the manager shows (loose / desks / global), what
// counts as content, and the operations on the stored notes (close, clean the empty loose ones, move adding tabs), each
// with a snapshot that undoes it.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildNoteTree, cleanEmptyNotes, closeNotes, emptyLooseKeys, hasContent, moveNote, noteCounts, panesOf, pruneMeta, readNoteMeta, restoreNotes,
  visibleRows, whenLabel, type NoteSource, type NoteStore, type NoteTreeInput,
} from '../../app/renderer/pad-notes.ts'

type P = { id: string; component?: string; title?: string; path?: string }

/** A pad's frame state (the drawer's shape): one frame, one group with these panes as tabs. */
function frame(...panes: P[]): unknown {
  const panels = Object.fromEntries(panes.map(p => [p.id, { id: p.id, contentComponent: p.component ?? 'note', title: p.title ?? p.id, params: p.path ? { note: { path: p.path } } : {} }]))
  const view = { grid: { root: { type: 'branch', data: [{ type: 'leaf', data: { views: panes.map(p => p.id), activeView: panes[0]?.id, id: '1' } }] }, width: 100, height: 100, orientation: 'HORIZONTAL' }, panels }
  return { frames: { grid: { root: { type: 'branch', data: [{ type: 'leaf', data: { id: 'f1', component: 'frame' } }] } }, views: { f1: view } } }
}
const blank = (id = 'empty:1'): P => ({ id, component: 'empty', title: 'Vazio' })
const PANEL = 'frame-pads.panel'
const pk = (id: string): string => `${PANEL}@${id}`

function input(over: Partial<NoteTreeInput> = {}): NoteTreeInput {
  const sources: NoteSource[] = [
    { key: pk('a'), padId: PANEL, owner: { kind: 'panel', panelId: 'a' }, state: frame({ id: 'note:1', title: 'bug do cwd', path: 'C:/n/1.md' }) },
    { key: pk('gone'), padId: PANEL, owner: { kind: 'panel', panelId: 'gone' }, state: frame({ id: 'note:2', title: 'lembrar' }) },
    { key: pk('gone2'), padId: PANEL, owner: { kind: 'panel', panelId: 'gone2' }, state: frame(blank()) },
    { key: 'frame-pads.desk@d1', padId: 'frame-pads.desk', owner: { kind: 'desk', deskId: 'd1' }, state: frame({ id: 'note:3', title: 'decisões' }) },
    { key: 'frame-pads.global', padId: 'frame-pads.global', owner: { kind: 'global' }, state: frame(blank('empty:9')) },
  ]
  return {
    sources,
    meta: { [pk('gone')]: { ownerLabel: 'claude·atrium', deskId: 'd1', updatedAt: 1000 }, [pk('gone2')]: { ownerLabel: 'shell', updatedAt: 2000 } },
    desks: [{ id: 'd1', name: 'tether' }, { id: 'd2', name: 'atrium' }],
    livePanels: new Map([['a', { label: 'claude·tether', deskId: 'd1' }]]),
    focusedPanel: 'a',
    ...over,
  }
}

describe('pad notes: reading a frame', () => {
  test('panes in order with their file; content = a pane that is not an empty pane', () => {
    assert.deepEqual(panesOf(frame({ id: 'note:1', title: 'x', path: 'C:/a.md' }, blank())), [
      { id: 'note:1', title: 'x', component: 'note', file: 'C:/a.md' },
      { id: 'empty:1', title: 'Vazio', component: 'empty' },
    ])
    assert.equal(hasContent(frame(blank())), false)
    assert.equal(hasContent(frame(blank(), { id: 's1', component: 'terminal' })), true)
    assert.equal(hasContent(undefined), false)
    assert.deepEqual(panesOf({ nope: 1 }), [])
  })
})

describe('pad notes: the tree', () => {
  test('loose first (content before empty), each desk with its desk pad and panels, then global', () => {
    const tree = buildNoteTree(input())
    assert.deepEqual(tree.loose.map(r => r.key), [pk('gone'), pk('gone2')])
    assert.equal(tree.loose[0]!.label, 'claude·atrium', 'a loose note keeps the recorded owner label')
    assert.equal(tree.loose[0]!.title, 'lembrar')
    assert.equal(tree.loose[1]!.empty, true)
    assert.equal(tree.desks[0]!.deskPad?.title, 'decisões')
    assert.deepEqual(tree.desks[0]!.panels.map(r => [r.key, r.label, r.focused, r.tabs]), [[pk('a'), 'claude·tether', true, 1]])
    assert.deepEqual(tree.desks[1]!.panels, [])
    assert.deepEqual(tree.global.map(r => [r.key, r.empty]), [['frame-pads.global', true]])
  })

  test('filters, counts and the empty loose keys', () => {
    const tree = buildNoteTree(input())
    assert.deepEqual(visibleRows(tree, 'loose').map(r => r.key), [pk('gone'), pk('gone2')])
    assert.deepEqual(visibleRows(tree, 'all').map(r => r.key), [pk('gone'), pk('gone2'), 'frame-pads.desk@d1', pk('a')], 'a live empty note is not listed; a loose empty one is')
    assert.deepEqual(noteCounts(tree), { loose: 1, looseEmpty: 1, withContent: 3 })
    assert.deepEqual(emptyLooseKeys(tree), [pk('gone2')])
  })

  test('a panel that comes back takes its note back (alive again, not loose)', () => {
    const tree = buildNoteTree(input({ livePanels: new Map([['a', { label: 'x', deskId: 'd1' }], ['gone', { label: 'claude·atrium', deskId: 'd2' }]]) }))
    assert.deepEqual(tree.loose.map(r => r.key), [pk('gone2')])
    assert.deepEqual(tree.desks[1]!.panels.map(r => r.key), [pk('gone')])
  })

  test('a desk that is gone leaves its desk pad loose', () => {
    const tree = buildNoteTree(input({ desks: [{ id: 'd2', name: 'atrium' }] }))
    assert.ok(tree.loose.some(r => r.key === 'frame-pads.desk@d1'))
  })
})

describe('pad notes: operations', () => {
  const store = (): NoteStore => {
    const i = input()
    return { pads: Object.fromEntries(i.sources.map(s => [s.key, s.state])), meta: { ...i.meta } }
  }

  test('close removes frame and record; the snapshot puts them back exactly', () => {
    const s = store()
    const { store: after, undo } = closeNotes(s, [pk('gone'), 'missing'])
    assert.equal(pk('gone') in after.pads, false)
    assert.equal(pk('gone') in after.meta, false)
    assert.deepEqual(undo.entries.map(e => e.key), [pk('gone')])
    assert.deepEqual(restoreNotes(after, undo), s)
  })

  test('clean the empty loose notes, undoable', () => {
    const s = store()
    const { store: after, keys, undo } = cleanEmptyNotes(s, buildNoteTree(input()))
    assert.deepEqual(keys, [pk('gone2')])
    assert.equal(pk('gone2') in after.pads, false)
    assert.ok('frame-pads.global' in after.pads, 'an empty note with a live owner stays')
    assert.deepEqual(restoreNotes(after, undo), s)
  })

  test('move adds the tabs to the target (its empty panes give way) and closes the source', () => {
    const s: NoteStore = { pads: { ...store().pads, [pk('b')]: frame(blank('empty:b')) }, meta: store().meta }
    const { store: after, undo } = moveNote(s, pk('gone'), pk('b'), 5000)
    assert.equal(pk('gone') in after.pads, false)
    assert.deepEqual(panesOf(after.pads[pk('b')]).map(p => p.id), ['note:2'])
    assert.equal(after.meta[pk('b')]!.updatedAt, 5000)
    assert.deepEqual(restoreNotes(after, undo), s)
    // Onto a note with content: the tabs add up.
    const sum = moveNote(s, pk('gone'), pk('a'), 6000).store
    assert.deepEqual(panesOf(sum.pads[pk('a')]).map(p => p.id), ['note:1', 'note:2'])
    // Onto a key with no state: the source's frame as it is.
    assert.deepEqual(panesOf(moveNote(s, pk('gone'), pk('new'), 1).store.pads[pk('new')]).map(p => p.id), ['note:2'])
  })

  test('nothing to move: unchanged', () => {
    const s = store()
    assert.equal(moveNote(s, pk('gone2'), pk('a'), 1).store, s)
    assert.equal(moveNote(s, pk('a'), pk('a'), 1).store, s)
  })
})

describe('pad notes: records', () => {
  test('read tolerantly, pruned to the keys that still exist', () => {
    const meta = readNoteMeta({ k1: { ownerLabel: 'x', updatedAt: 1, deskId: 'd' }, k2: { ownerLabel: 3 }, k3: null, k4: { ownerLabel: 'y', updatedAt: 2 } })
    assert.deepEqual(meta, { k1: { ownerLabel: 'x', updatedAt: 1, deskId: 'd' }, k4: { ownerLabel: 'y', updatedAt: 2 } })
    assert.deepEqual(readNoteMeta([1]), {})
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
