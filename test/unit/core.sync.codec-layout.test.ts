import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { exportLayout, importLayout, PATH_KEYS, type DeskIds, type LayoutJson, type SyncEntities } from '../../src/core/sync/codecs/layout.ts'

const WIN = { platform: 'win32', homedir: 'C:\\Users\\Ana' } as const
const NIX = { platform: 'linux', homedir: '/home/ana' } as const
const WIN_MAP = { atrium: 'C:\\atrium' }
const POSIX_MAP = { atrium: '/srv/atrium', thing: '/data/thing' }

/** A uid minter that counts: u1, u2, … */
function counter(prefix = 'u'): () => string {
  let n = 0
  return () => `${prefix}${++n}`
}
const winOpts = (prefix = 'u') => ({ ...WIN, newUid: counter(prefix) })

/** Export on the win32 machine; the uids come out as u1, u2, u3 in desk order. */
function exportWin(layout: LayoutJson, ids: DeskIds = {}, map: Record<string, string> = WIN_MAP) {
  return exportLayout(layout, map, ids, winOpts())
}

function terminal(slot: string, cwd: string): Record<string, unknown> {
  return {
    id: slot,
    contentComponent: 'terminal',
    tabComponent: 'slot-tab',
    params: { slotId: slot, hint: { kind: 'claude', cwd, profileName: 'Atrium', unsafe: true }, emblem: 'u-abc' },
    title: `t-${slot}`,
  }
}

function desk(id: string, name: string, panels: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name,
    color: 'blue',
    frames: {
      grid: { root: { type: 'leaf', data: { id: 'f1', component: 'frame' }, size: 1200 }, width: 1200, height: 800, orientation: 'HORIZONTAL' },
      views: { f1: { grid: { root: { type: 'leaf', data: { views: Object.keys(panels), id: 'g1' } } }, panels } },
    },
    activeFrame: 'f1',
    ...extra,
  }
}

const EXPLORER_PAD = { v: 1, expanded: { 'C:\\atrium': ['C:\\atrium\\mind'] } }
const MODE_PAD = { v: 1, mode: 'list', cwd: 'C:\\atrium\\a' }

function sample(): LayoutJson {
  return {
    v: 4,
    desks: [
      desk(
        'desk-1',
        'Mesa 1',
        {
          '111': terminal('111', 'C:\\atrium\\workspace\\tether'),
          'note:1': {
            id: 'note:1',
            contentComponent: 'note',
            params: { note: { path: 'C:\\atrium\\mind\\a.md', cwd: 'C:\\atrium\\mind', minimap: false } },
            title: 'a.md',
          },
          'prev:1': { id: 'prev:1', contentComponent: 'preview', params: { preview: { path: 'C:\\atrium\\x.html', kind: 'html' } } },
          br1: { id: 'br1', contentComponent: 'browser', params: { tabId: 't1', ownerSlotId: '111', url: 'https://example.com/a', title: 'Ex' } },
          'empty:1': { id: 'empty:1', contentComponent: 'empty', params: { empty: { cwd: 'C:\\Users\\Ana\\proj' } } },
        },
        { pads: { explorer: EXPLORER_PAD, mode: MODE_PAD } },
      ),
      desk('desk-2', 'Mesa 2', { '222': terminal('222', 'C:\\Users\\Ana\\proj') }, { asleep: true }),
      desk('desk-3', 'Mesa 3', { '333': terminal('333', 'D:\\other\\thing') }),
    ],
    activeDesk: 'desk-2',
    drawer: { frames: { grid: { marker: 'DRAWER-MARK' }, views: {} } },
    sidebars: { left: { open: true, marker: 'SIDEBAR-MARK' } },
    systemDesks: { browser: { frames: { grid: {}, views: {} } } },
    asleepPanes: ['222'],
    deskSleptPanes: ['222'],
    emblems: [{ id: 'u-abc', glyph: 'star' }],
    workspace: { pinned: [{ path: 'C:\\atrium' }, { path: 'C:\\atrium\\workspace\\tether' }] },
  }
}

function deepFreeze<T>(x: T): T {
  if (typeof x === 'object' && x !== null) {
    for (const v of Object.values(x)) deepFreeze(v)
    Object.freeze(x)
  }
  return x
}

const ids = (l: LayoutJson): string[] => (l.desks as { id: string }[]).map((d) => d.id)
const deskOf = (l: LayoutJson, id: string): Record<string, any> => (l.desks as Record<string, any>[]).find((d) => d.id === id)!
const hintCwd = (l: LayoutJson, id: string, slot: string): unknown => deskOf(l, id).frames.views.f1.panels[slot].params.hint.cwd
const entityDesks = (e: SyncEntities): Record<string, any> => e.desks as Record<string, any>
const orderOf = (e: SyncEntities): string[] => (e.layout as any).order.ids

/** A posix machine that has none of the desks yet. */
function emptyPosix(): LayoutJson {
  return { v: 4, desks: [], activeDesk: 'desk-9', drawer: null, sidebars: { right: 1 }, systemDesks: {}, futureKey: { a: [1, 2] } }
}

describe('PATH_KEYS', () => {
  test('lists the keys found in the app: cwd and path', () => {
    assert.ok(PATH_KEYS.includes('cwd'))
    assert.ok(PATH_KEYS.includes('path'))
  })
})

describe('round trip on one machine', () => {
  test('export then import gives the layout back, with the same ids on both legs', () => {
    const layout = sample()
    const ex = exportWin(layout)
    assert.deepEqual(ex.skipped, [])
    assert.deepEqual(ex.ids, { 'desk-1': 'u1', 'desk-2': 'u2', 'desk-3': 'u3' })
    const im = importLayout(ex.entities, layout, ex.map, ex.ids, WIN)
    assert.deepEqual(im.layout, layout)
    assert.deepEqual(im.ids, ex.ids)
    assert.deepEqual(im.arrived, [])
    assert.deepEqual(im.removed, [])
    assert.deepEqual(im.unmappedPlaces, [])
    assert.deepEqual(im.skipped, [])
  })

  test('no absolute path in the entities, and no leaks', () => {
    const ex = exportWin(sample())
    const text = JSON.stringify(ex.entities)
    assert.doesNotMatch(text, /(^|[^A-Za-z])[A-Za-z]:(\\\\|\/)/)
    assert.doesNotMatch(text, /Users/)
    assert.ok(text.includes('https://example.com/a'))
    assert.deepEqual(ex.leaks, [])
  })

  test('paths become places: known, home and new', () => {
    const ex = exportWin(sample())
    const desks = entityDesks(ex.entities)
    assert.deepEqual(desks.u1.frames.views.f1.panels['111'].params.hint.cwd, { place: 'atrium', rel: 'workspace/tether' })
    assert.deepEqual(desks.u2.frames.views.f1.panels['222'].params.hint.cwd, { place: 'home', rel: 'proj' })
    assert.deepEqual(desks.u3.frames.views.f1.panels['333'].params.hint.cwd, { place: 'thing', rel: '' })
    assert.deepEqual(desks.u1.frames.views.f1.panels['note:1'].params.note.path, { place: 'atrium', rel: 'mind/a.md' })
    assert.deepEqual(ex.map, { atrium: 'C:\\atrium', thing: 'D:\\other\\thing' })
    assert.deepEqual((ex.entities.layout as any).workspace.pinned[0], { path: { place: 'atrium', rel: '' } })
  })

  test('the order, the emblems and the workspace are layout entities; the order lists uids', () => {
    const ex = exportWin(sample())
    const meta = ex.entities.layout as Record<string, any>
    assert.deepEqual(meta.order, { ids: ['u1', 'u2', 'u3'] })
    assert.deepEqual(meta.emblems, { emblems: [{ id: 'u-abc', glyph: 'star' }] })
    assert.ok(meta.workspace.pinned.length === 2)
  })

  test('asleep and the machine fields are not in the entities', () => {
    const ex = exportWin(sample())
    const text = JSON.stringify(ex.entities)
    for (const word of ['asleep', 'activeDesk', 'DRAWER-MARK', 'SIDEBAR-MARK', 'systemDesks', 'asleepPanes', 'deskSleptPanes', 'desk-']) {
      assert.ok(!text.includes(word), word)
    }
    assert.deepEqual(Object.keys(ex.entities).sort(), ['desks', 'layout'])
  })

  test('without emblems or workspace those entities are absent', () => {
    const layout = sample()
    delete layout.emblems
    delete layout.workspace
    const meta = exportWin(layout).entities.layout as Record<string, unknown>
    assert.deepEqual(Object.keys(meta), ['order'])
  })
})

describe('desk identity: the uid', () => {
  test('the entity is stored under the uid and its id field is the uid', () => {
    const ex = exportWin(sample())
    assert.deepEqual(Object.keys(entityDesks(ex.entities)), ['u1', 'u2', 'u3'])
    for (const [uid, e] of Object.entries(entityDesks(ex.entities))) assert.equal(e.id, uid)
  })

  test('a desk that has a uid keeps it; the received ids are not mutated; a stale entry leaves', () => {
    const received = deepFreeze<DeskIds>({ 'desk-2': 'known', 'desk-77': 'stale' })
    const ex = exportWin(sample(), received)
    assert.deepEqual(ex.ids, { 'desk-1': 'u1', 'desk-2': 'known', 'desk-3': 'u2' })
    assert.deepEqual(orderOf(ex.entities), ['u1', 'known', 'u2'])
    assert.deepEqual(received, { 'desk-2': 'known', 'desk-77': 'stale' })
    assert.notEqual(ex.ids, received)
  })

  test('a new uid never repeats one already in the map', () => {
    const ex = exportWin(sample(), { 'desk-1': 'u1', 'desk-2': 'u2' })
    assert.equal(ex.ids['desk-3'], 'u3')
    const clash = exportLayout(sample(), WIN_MAP, { 'desk-1': 'u1' }, { ...WIN, newUid: counter() })
    assert.deepEqual(clash.ids, { 'desk-1': 'u1', 'desk-2': 'u2', 'desk-3': 'u3' })
  })

  test('the default uid is d plus 12 hex characters and fits the id rule', () => {
    const ex = exportLayout(sample(), WIN_MAP, {}, WIN)
    const uids = Object.values(ex.ids)
    assert.equal(uids.length, 3)
    for (const uid of uids) {
      assert.match(uid, /^d[0-9a-f]{12}$/)
      assert.match(uid, /^[a-z0-9][a-z0-9._@:-]*$/)
    }
    assert.equal(new Set(uids).size, 3)
  })

  test('the local id may be anything: only the uid is validated', () => {
    const layout = sample()
    ;(layout.desks as unknown[]).push(desk('Mesa Nova', 'Free', {}))
    const ex = exportWin(layout)
    assert.deepEqual(ex.skipped, [])
    assert.deepEqual(orderOf(ex.entities), ['u1', 'u2', 'u3', 'u4'])
    assert.equal(ex.ids['Mesa Nova'], 'u4')
  })

  test('import: the desk of the uid in the map is the local one; its id field stays the local id', () => {
    const layout = sample()
    const ex = exportWin(layout)
    const im = importLayout(ex.entities, layout, ex.map, ex.ids, WIN)
    assert.deepEqual(ids(im.layout), ['desk-1', 'desk-2', 'desk-3'])
    assert.deepEqual(deskOf(im.layout, 'desk-3'), deskOf(layout, 'desk-3'))
  })

  test('import: a new desk takes the smallest free desk-N, counting the current desks and the ones assigned now', () => {
    const entities: SyncEntities = {
      desks: { a: desk('a', 'A', {}), b: desk('b', 'B', {}), c: desk('c', 'C', {}) },
      layout: { order: { ids: ['a', 'b', 'c'] } },
    }
    const current: LayoutJson = { ...emptyPosix(), desks: [desk('desk-1', 'L1', {}), desk('desk-3', 'L3', {})] }
    const im = importLayout(entities, current, {}, { 'desk-1': 'a' }, NIX)
    assert.deepEqual(ids(im.layout), ['desk-1', 'desk-2', 'desk-4'])
    assert.deepEqual(im.arrived, ['desk-2', 'desk-4'])
    assert.deepEqual(im.removed, ['desk-3'])
    assert.deepEqual(im.ids, { 'desk-1': 'a', 'desk-2': 'b', 'desk-4': 'c' })
    assert.equal(deskOf(im.layout, 'desk-1').name, 'A') // the entity's content, not the local one
  })

  test('a removed desk leaves the map', () => {
    const layout = sample()
    const ex = exportWin(layout)
    delete entityDesks(ex.entities).u3
    const im = importLayout(ex.entities, layout, ex.map, ex.ids, WIN)
    assert.deepEqual(im.removed, ['desk-3'])
    assert.deepEqual(im.ids, { 'desk-1': 'u1', 'desk-2': 'u2' })
  })

  test('first connection: B exports before importing, so neither desk-1 is lost', () => {
    const win = (cwd: string, name: string): LayoutJson => ({
      v: 4, desks: [desk('desk-1', name, { p: terminal('p', cwd) })], activeDesk: 'desk-1', drawer: null, sidebars: {}, systemDesks: {},
    })
    const a = win('C:\\atrium\\a', 'Mesa de A')
    const b = win('/srv/atrium/b', 'Mesa de B')
    const exA = exportLayout(a, { atrium: 'C:\\atrium' }, {}, { ...WIN, newUid: () => 'u1' })
    assert.deepEqual(exA.ids, { 'desk-1': 'u1' })

    // Importing A's entities straight onto B (empty ids) takes B's desk away: the persistent one commands.
    const naive = importLayout(exA.entities, b, POSIX_MAP, {}, NIX)
    assert.deepEqual(naive.removed, ['desk-1'])
    assert.deepEqual(naive.arrived, ['desk-2']) // the local desk-1 still counts as taken while this import runs

    // The engine's sequence: B exports first (u2), joins the entities, then imports the union.
    const exB = exportLayout(b, POSIX_MAP, {}, { ...NIX, newUid: () => 'u2' })
    assert.deepEqual(exB.ids, { 'desk-1': 'u2' })
    const union: SyncEntities = {
      desks: { ...entityDesks(exA.entities), ...entityDesks(exB.entities) },
      layout: { order: { ids: [...orderOf(exA.entities), ...orderOf(exB.entities)] } },
    }
    const im = importLayout(union, b, exB.map, exB.ids, NIX)
    assert.deepEqual(im.removed, [])
    assert.deepEqual(im.arrived, ['desk-2'])
    assert.deepEqual(im.ids, { 'desk-1': 'u2', 'desk-2': 'u1' })
    // The persistent order is A then B: B's desk-1 keeps its local id but goes second.
    assert.deepEqual(ids(im.layout), ['desk-2', 'desk-1'])
    assert.equal(deskOf(im.layout, 'desk-1').name, 'Mesa de B')
    assert.equal(hintCwd(im.layout, 'desk-1', 'p'), '/srv/atrium/b')
    assert.equal(deskOf(im.layout, 'desk-2').name, 'Mesa de A')
    assert.equal(deskOf(im.layout, 'desk-2').asleep, true)
    assert.equal(hintCwd(im.layout, 'desk-2', 'p'), '/srv/atrium/a')
    assert.ok(!('asleep' in deskOf(im.layout, 'desk-1')))
    assert.deepEqual(im.layout.asleepPanes, ['p'])
  })
})

describe('pads with a machine path stay on the machine', () => {
  test('a pad that still holds an absolute path (value, key or element) is left out and listed', () => {
    const layout = sample()
    const d = deskOf(layout, 'desk-2')
    d.pads = {
      byKey: { expanded: { '/srv/x': 1 } },
      byElement: { list: ['ok', 'D:/some/dir'] },
      byValue: { folder: 'C:\\somewhere' },
      zUrl: { link: 'https://example.com/a', file: 'file:///C:/x' },
      zPlain: { a: 1 },
    }
    const ex = exportWin(layout)
    assert.deepEqual(ex.localPads, ['desk-1/explorer', 'desk-2/byElement', 'desk-2/byKey', 'desk-2/byValue'])
    assert.deepEqual(Object.keys(entityDesks(ex.entities).u2.pads).sort(), ['zPlain', 'zUrl'])
    assert.deepEqual(Object.keys(entityDesks(ex.entities).u1.pads), ['mode'])
    assert.deepEqual(ex.leaks, [])
  })

  test('a pad under PATH_KEYS travels as a place', () => {
    const ex = exportWin(sample())
    assert.deepEqual(entityDesks(ex.entities).u1.pads.mode.cwd, { place: 'atrium', rel: 'a' })
  })

  test('import: travelled pads replace the local ones, local ones that did not travel stay, new desks get only what travelled', () => {
    const layout = sample()
    const ex = exportWin(layout)
    const current = sample()
    deskOf(current, 'desk-1').pads = { explorer: { v: 1, expanded: { '/local': ['/local/x'] } }, mode: { v: 1, mode: 'old' }, extra: { keep: true } }
    const im = importLayout(ex.entities, current, ex.map, ex.ids, WIN)
    assert.deepEqual(deskOf(im.layout, 'desk-1').pads, {
      explorer: { v: 1, expanded: { '/local': ['/local/x'] } },
      mode: { v: 1, mode: 'list', cwd: 'C:\\atrium\\a' },
      extra: { keep: true },
    })
    const fresh = importLayout(ex.entities, emptyPosix(), POSIX_MAP, {}, NIX)
    assert.deepEqual(deskOf(fresh.layout, 'desk-1').pads, { mode: { v: 1, mode: 'list', cwd: '/srv/atrium/a' } })
  })

  test('import: a desk with local pads and an entity without any keeps them', () => {
    const layout = sample()
    const ex = exportWin(layout)
    delete entityDesks(ex.entities).u1.pads
    const im = importLayout(ex.entities, layout, ex.map, ex.ids, WIN)
    assert.deepEqual(deskOf(im.layout, 'desk-1').pads, deskOf(layout, 'desk-1').pads)
  })
})

describe('leaks: the safety net', () => {
  test('an absolute path left outside PATH_KEYS is reported with its JSON path, and not removed', () => {
    const layout = sample()
    const panels = deskOf(layout, 'desk-1').frames.views.f1.panels
    panels.br1.params.x = 'C:\\elsewhere\\file.txt'
    panels.br1.params.list = ['fine', '/srv/other']
    panels.br1.params.map = { '/abs/key': 1 }
    const ex = exportWin(layout)
    const base = 'desks/u1/frames/views/f1/panels/br1/params'
    assert.deepEqual(ex.leaks.sort(), [`${base}/list/1`, `${base}/map//abs/key`, `${base}/x`].sort())
    assert.equal(entityDesks(ex.entities).u1.frames.views.f1.panels.br1.params.x, 'C:\\elsewhere\\file.txt')
  })

  test('a leak in the workspace entity is reported under layout', () => {
    const layout = sample()
    ;(layout.workspace as any).note = '/srv/x'
    assert.deepEqual(exportWin(layout).leaks, ['layout/workspace/note'])
  })
})

describe('two machines', () => {
  test('win32 export, posix import: the paths resolve through the other map', () => {
    const ex = exportWin(sample())
    const im = importLayout(ex.entities, emptyPosix(), POSIX_MAP, {}, NIX)
    assert.deepEqual(im.unmappedPlaces, [])
    assert.equal(hintCwd(im.layout, 'desk-1', '111'), '/srv/atrium/workspace/tether')
    assert.equal(hintCwd(im.layout, 'desk-2', '222'), '/home/ana/proj')
    assert.equal(hintCwd(im.layout, 'desk-3', '333'), '/data/thing')
    const panels = deskOf(im.layout, 'desk-1').frames.views.f1.panels
    assert.equal(panels['note:1'].params.note.path, '/srv/atrium/mind/a.md')
    assert.equal(panels['note:1'].params.note.cwd, '/srv/atrium/mind')
    assert.equal(panels['prev:1'].params.preview.path, '/srv/atrium/x.html')
    assert.equal(panels['empty:1'].params.empty.cwd, '/home/ana/proj')
    assert.deepEqual((im.layout.workspace as any).pinned, [{ path: '/srv/atrium' }, { path: '/srv/atrium/workspace/tether' }])
    assert.deepEqual(im.ids, { 'desk-1': 'u1', 'desk-2': 'u2', 'desk-3': 'u3' })
  })

  test('a place with no map here: the key is left out and the place is reported, sorted and once', () => {
    const ex = exportWin(sample())
    const im = importLayout(ex.entities, emptyPosix(), {}, {}, NIX)
    assert.deepEqual(im.unmappedPlaces, ['atrium', 'thing'])
    const hint = deskOf(im.layout, 'desk-3').frames.views.f1.panels['333'].params.hint
    assert.ok(!('cwd' in hint))
    assert.equal(hint.kind, 'claude')
    assert.equal(hintCwd(im.layout, 'desk-2', '222'), '/home/ana/proj') // home is built in
  })

  test('a PlaceRef-like object with another shape is not touched', () => {
    const entities: SyncEntities = {
      desks: { u1: desk('u1', 'M', { a: { id: 'a', params: { cwd: { place: 'x', rel: 'y', extra: 1 }, path: { place: 1, rel: 'y' } } } }) },
    }
    const im = importLayout(entities, emptyPosix(), {}, {}, NIX)
    assert.deepEqual(deskOf(im.layout, 'desk-1').frames.views.f1.panels.a.params, { cwd: { place: 'x', rel: 'y', extra: 1 }, path: { place: 1, rel: 'y' } })
    assert.deepEqual(im.unmappedPlaces, [])
  })

  test('URLs are never paths', () => {
    const layout = sample()
    const panels = deskOf(layout, 'desk-1').frames.views.f1.panels
    panels.br1.params.cwd = 'file:///C:/atrium/x'
    panels.br1.params.path = 'https://example.com/a/b'
    panels.br1.params.url = 'http://localhost:3000/x'
    const ex = exportWin(layout)
    const stored = entityDesks(ex.entities).u1.frames.views.f1.panels.br1.params
    assert.equal(stored.cwd, 'file:///C:/atrium/x')
    assert.equal(stored.path, 'https://example.com/a/b')
    assert.deepEqual(ex.leaks, [])
    const im = importLayout(ex.entities, layout, ex.map, ex.ids, WIN)
    assert.deepEqual(im.layout, layout)
  })
})

describe('import: the persistent one commands the set and the order', () => {
  test('a new desk arrives asleep, its terminals in both lists (no duplicates, lists created)', () => {
    const ex = exportWin(sample())
    const im = importLayout(ex.entities, emptyPosix(), POSIX_MAP, {}, NIX)
    assert.deepEqual(im.arrived, ['desk-1', 'desk-2', 'desk-3'])
    for (const id of ids(im.layout)) assert.equal(deskOf(im.layout, id).asleep, true)
    assert.deepEqual(im.layout.asleepPanes, ['111', '222', '333'])
    assert.deepEqual(im.layout.deskSleptPanes, ['111', '222', '333'])

    const withOne: LayoutJson = { ...emptyPosix(), asleepPanes: ['111'], deskSleptPanes: ['111'] }
    const again = importLayout(ex.entities, withOne, POSIX_MAP, {}, NIX)
    assert.deepEqual(again.layout.asleepPanes, ['111', '222', '333'])
    assert.deepEqual(again.layout.deskSleptPanes, ['111', '222', '333'])
  })

  test('browser and note panes are not terminals', () => {
    const ex = exportWin(sample())
    const im = importLayout(ex.entities, emptyPosix(), POSIX_MAP, {}, NIX)
    assert.ok(!(im.layout.asleepPanes as string[]).includes('br1'))
    assert.ok(!(im.layout.asleepPanes as string[]).includes('note:1'))
  })

  test('a removed desk leaves and takes its terminals out of both lists', () => {
    const layout = sample()
    layout.activeDesk = 'desk-3'
    layout.asleepPanes = ['222', '333']
    layout.deskSleptPanes = ['333']
    const ex = exportWin(layout)
    delete entityDesks(ex.entities).u3
    ;(ex.entities.layout as any).order.ids = ['u1', 'u2']
    const im = importLayout(ex.entities, layout, ex.map, ex.ids, WIN)
    assert.deepEqual(im.removed, ['desk-3'])
    assert.deepEqual(ids(im.layout), ['desk-1', 'desk-2'])
    assert.deepEqual(im.layout.asleepPanes, ['222'])
    assert.deepEqual(im.layout.deskSleptPanes, [])
    assert.equal(im.layout.activeDesk, 'desk-1')
  })

  test('activeDesk stays when its desk stays, and with no desks it is left alone', () => {
    const layout = sample()
    const ex = exportWin(layout)
    assert.equal(importLayout(ex.entities, layout, ex.map, ex.ids, WIN).layout.activeDesk, 'desk-2')
    const none = importLayout({ desks: {}, layout: { order: { ids: [] } } }, layout, ex.map, ex.ids, WIN)
    assert.deepEqual(none.removed, ['desk-1', 'desk-2', 'desk-3'])
    assert.deepEqual(none.layout.desks, [])
    assert.equal(none.layout.activeDesk, 'desk-2')
    assert.deepEqual(none.ids, {})
  })

  test('the local asleep of a desk that exists is kept, whatever the entity says', () => {
    const layout = sample()
    deskOf(layout, 'desk-1').asleep = true
    const ex = exportWin(layout)
    entityDesks(ex.entities).u2.asleep = false
    const im = importLayout(ex.entities, layout, ex.map, ex.ids, WIN)
    assert.equal(deskOf(im.layout, 'desk-1').asleep, true)
    assert.equal(deskOf(im.layout, 'desk-2').asleep, true) // local value, not the entity's
    assert.ok(!('asleep' in deskOf(im.layout, 'desk-3')))
  })

  test('the persistent order wins, desks outside it go after, by uid', () => {
    const layout = sample()
    const ex = exportWin(layout)
    ;(ex.entities.layout as any).order.ids = ['u3', 'ghost', 'u1', 'u3']
    const im = importLayout(ex.entities, layout, ex.map, ex.ids, WIN)
    assert.deepEqual(ids(im.layout), ['desk-3', 'desk-1', 'desk-2'])
    const noOrder = importLayout({ desks: ex.entities.desks! }, layout, ex.map, ex.ids, WIN)
    assert.deepEqual(ids(noOrder.layout), ['desk-1', 'desk-2', 'desk-3'])
  })

  test('emblems and workspace replace the local ones when present, stay when absent', () => {
    const layout = sample()
    const ex = exportWin(layout)
    const meta = ex.entities.layout as any
    meta.emblems = { emblems: [{ id: 'new' }] }
    meta.workspace = { pinned: [{ path: { place: 'atrium', rel: 'z' } }] }
    const replaced = importLayout(ex.entities, layout, ex.map, ex.ids, WIN)
    assert.deepEqual(replaced.layout.emblems, [{ id: 'new' }])
    assert.deepEqual(replaced.layout.workspace, { pinned: [{ path: 'C:\\atrium\\z' }] })

    delete meta.emblems
    delete meta.workspace
    const kept = importLayout(ex.entities, layout, ex.map, ex.ids, WIN)
    assert.deepEqual(kept.layout.emblems, layout.emblems)
    assert.deepEqual(kept.layout.workspace, layout.workspace)
  })

  test('machine fields and unknown top-level keys are preserved', () => {
    const ex = exportWin(sample())
    const im = importLayout(ex.entities, emptyPosix(), POSIX_MAP, {}, NIX)
    assert.deepEqual(im.layout.futureKey, { a: [1, 2] })
    assert.deepEqual(im.layout.sidebars, { right: 1 })
    assert.equal(im.layout.drawer, null)
    assert.equal(im.layout.v, 4)
    assert.ok(!JSON.stringify(ex.entities).includes('futureKey'))
  })

  test('no desks entity: current comes back intact', () => {
    const layout = sample()
    const im = importLayout({ layout: { order: { ids: [] } } }, layout, WIN_MAP, { 'desk-1': 'u1' }, WIN)
    assert.deepEqual(im.layout, layout)
    assert.notEqual(im.layout, layout)
    assert.deepEqual(im.ids, { 'desk-1': 'u1' })
    assert.deepEqual([im.arrived, im.removed, im.unmappedPlaces, im.skipped], [[], [], [], []])
  })

  test('a malformed desk entity is skipped; the local desk under that uid stays', () => {
    const layout = sample()
    const ex = exportWin(layout)
    const desks = entityDesks(ex.entities)
    desks.bad = { id: 'bad' }
    desks.u2 = { id: 'u2', name: 'x' }
    desks.mismatch = desk('other', 'O', {})
    const im = importLayout(ex.entities, layout, ex.map, ex.ids, WIN)
    assert.deepEqual(im.skipped.sort(), ['desks/bad', 'desks/mismatch', 'desks/u2'])
    assert.deepEqual(ids(im.layout).sort(), ['desk-1', 'desk-2', 'desk-3'])
    assert.deepEqual(deskOf(im.layout, 'desk-2'), deskOf(layout, 'desk-2'))
    assert.deepEqual(im.removed, [])
    assert.deepEqual(im.ids, ex.ids)
  })
})

describe('export edge cases', () => {
  test('a version other than 4 does not export, and the ids come back as a copy', () => {
    const received = { 'desk-1': 'u1' }
    for (const v of [3, 5, undefined]) {
      const ex = exportLayout({ ...sample(), v }, WIN_MAP, received, WIN)
      assert.deepEqual(ex.entities, {})
      assert.deepEqual(ex.skipped, ['layout'])
      assert.deepEqual(ex.map, WIN_MAP)
      assert.deepEqual(ex.ids, received)
      assert.notEqual(ex.ids, received)
      assert.deepEqual([ex.localPads, ex.leaks], [[], []])
    }
  })

  test('a desk whose uid is invalid, a malformed desk and a duplicate are skipped and left out of the order', () => {
    const layout = sample()
    ;(layout.desks as unknown[]).push(desk('desk-4', 'Bad', {}), desk('desk-3', 'Dup', {}), 'junk')
    const ex = exportWin(layout, { 'desk-4': 'Bad Uid' })
    assert.deepEqual(ex.skipped, ['desks/desk-4', 'desks/desk-3', 'desks/[5]'])
    assert.deepEqual(Object.keys(entityDesks(ex.entities)), ['u1', 'u2', 'u3'])
    assert.deepEqual(orderOf(ex.entities), ['u1', 'u2', 'u3'])
    assert.equal(ex.ids['desk-4'], 'Bad Uid') // the desk still exists here
  })
})

describe('a file outside every place: the place is its parent folder', () => {
  const note = (id: string, path: string) => ({ id, contentComponent: 'note', params: { note: { path } }, title: id })
  const withNotes = (opts: { platform: 'win32' | 'linux'; a: string; b: string }): LayoutJson => ({
    v: 4, desks: [desk('desk-1', 'M', { n1: note('n1', opts.a), n2: note('n2', opts.b) })], activeDesk: 'desk-1', drawer: null, sidebars: {}, systemDesks: {},
  })

  test('win32: the place is the folder, the rel is the file name; two notes in one folder share the place', () => {
    const layout = withNotes({ platform: 'win32', a: 'D:\\docs\\notes\\llm-budget.md', b: 'D:\\docs\\notes\\b.md' })
    const ex = exportLayout(layout, {}, {}, winOpts())
    assert.deepEqual(ex.map, { notes: 'D:\\docs\\notes' })
    const panels = entityDesks(ex.entities).u1.frames.views.f1.panels
    assert.deepEqual(panels.n1.params.note.path, { place: 'notes', rel: 'llm-budget.md' })
    assert.deepEqual(panels.n2.params.note.path, { place: 'notes', rel: 'b.md' })
    const im = importLayout(ex.entities, layout, ex.map, ex.ids, WIN)
    assert.deepEqual(im.layout, layout)
  })

  test('posix: same rule by the platform of the options', () => {
    const layout = withNotes({ platform: 'linux', a: '/srv/x/docs/a.md', b: '/srv/x/docs/sub/b.md' })
    const ex = exportLayout(layout, {}, {}, { ...NIX, newUid: counter() })
    assert.deepEqual(ex.map, { docs: '/srv/x/docs' })
    const panels = entityDesks(ex.entities).u1.frames.views.f1.panels
    assert.deepEqual(panels.n1.params.note.path, { place: 'docs', rel: 'a.md' })
    assert.deepEqual(panels.n2.params.note.path, { place: 'docs', rel: 'sub/b.md' })
    assert.deepEqual(importLayout(ex.entities, layout, ex.map, ex.ids, NIX).layout, layout)
  })

  test('a file in a known place keeps that place; a cwd still makes the place on the folder itself', () => {
    const layout = withNotes({ platform: 'win32', a: 'C:\\atrium\\mind\\a.md', b: 'D:\\docs\\b.md' })
    deskOf(layout, 'desk-1').frames.views.f1.panels.n1.params.note.cwd = 'D:\\docs\\proj'
    const ex = exportLayout(layout, WIN_MAP, {}, winOpts())
    const panels = entityDesks(ex.entities).u1.frames.views.f1.panels
    assert.deepEqual(panels.n1.params.note.path, { place: 'atrium', rel: 'mind/a.md' })
    assert.deepEqual(panels.n1.params.note.cwd, { place: 'proj', rel: '' })
    assert.deepEqual(panels.n2.params.note.path, { place: 'docs', rel: 'b.md' })
    assert.deepEqual(ex.map, { atrium: 'C:\\atrium', proj: 'D:\\docs\\proj', docs: 'D:\\docs' })
  })

  test('a pinned project path is a folder: the place is the folder itself', () => {
    const layout = sample()
    layout.workspace = { pinned: [{ path: 'D:\\work\\app' }] }
    const ex = exportWin(layout)
    assert.deepEqual((ex.entities.layout as any).workspace.pinned[0], { path: { place: 'app', rel: '' } })
    assert.equal(ex.map.app, 'D:\\work\\app')
  })
})

describe('the round trip keeps the key order', () => {
  /** Keys deliberately out of alphabetical order, `asleep` in the middle of a desk, a pad, a workspace. */
  function unsorted(): LayoutJson {
    const d1 = desk('desk-1', 'Mesa 1', {
      '111': { title: 't', params: { slotId: '111', hint: { unsafe: true, profileName: 'P', kind: 'claude', cwd: 'C:\\atrium\\z' }, emblem: 'e' }, id: '111', contentComponent: 'terminal' },
      'note:1': { title: 'n', id: 'note:1', params: { note: { minimap: false, path: 'C:\\atrium\\mind\\a.md', cwd: 'C:\\atrium' } } },
    }, { pads: { zeta: { v: 1, mode: 'x', cwd: 'C:\\atrium\\p' }, alpha: { b: 1, a: 2 } } })
    const d2 = { name: 'Mesa 2', asleep: true, id: 'desk-2', ...desk('desk-2', 'Mesa 2', { '222': terminal('222', 'C:\\Users\\Ana') }) }
    return {
      v: 4, activeDesk: 'desk-2', desks: [d1, d2], emblems: [{ glyph: 'star', id: 'u-abc' }],
      workspace: { pinned: [{ path: 'C:\\atrium' }] }, zzz: { b: 1, a: 2 }, drawer: null, sidebars: { z: 1, a: 2 }, systemDesks: {},
      deskSleptPanes: ['222'], asleepPanes: ['222'],
    }
  }

  test('same machine: the layout comes back byte for byte', () => {
    const layout = unsorted()
    const ex = exportWin(layout)
    const im = importLayout(ex.entities, layout, ex.map, ex.ids, WIN)
    assert.equal(JSON.stringify(im.layout), JSON.stringify(layout))
  })

  test('keys that only the persistent one has go last, recursively', () => {
    const layout = unsorted()
    const ex = exportWin(layout)
    const e = entityDesks(ex.entities)
    e.u1.novelty = 1
    e.u1.frames.views.f1.extra = true
    const im = importLayout(ex.entities, layout, ex.map, ex.ids, WIN)
    const d = deskOf(im.layout, 'desk-1')
    assert.deepEqual(Object.keys(d), [...Object.keys(deskOf(layout, 'desk-1')), 'novelty'])
    assert.deepEqual(Object.keys(d.frames.views.f1).slice(-1), ['extra'])
    assert.deepEqual(Object.keys(d.frames.views.f1.panels['111']), ['title', 'params', 'id', 'contentComponent'])
  })
})

describe('purity', () => {
  test('neither layout, current, the maps nor the ids are mutated', () => {
    const layout = deepFreeze(sample())
    const map = deepFreeze({ ...WIN_MAP })
    const ids0 = deepFreeze<DeskIds>({ 'desk-1': 'u1' })
    const ex = exportLayout(layout, map, ids0, winOpts('v'))
    assert.deepEqual(map, WIN_MAP)
    assert.deepEqual(ids0, { 'desk-1': 'u1' })
    assert.notEqual(ex.map, map)
    deepFreeze(ex.entities)
    deepFreeze(ex.map)
    deepFreeze(ex.ids)
    const current = deepFreeze(emptyPosix())
    const posix = deepFreeze({ ...POSIX_MAP })
    const none = deepFreeze<DeskIds>({})
    const im = importLayout(ex.entities, current, posix, none, NIX)
    assert.deepEqual(current, emptyPosix())
    assert.deepEqual(layout, sample())
    assert.deepEqual(posix, POSIX_MAP)
    assert.deepEqual(none, {})
    assert.ok(im.arrived.length === 3)
    const round = importLayout(ex.entities, layout, ex.map, ex.ids, WIN)
    assert.deepEqual(round.layout, sample())
  })
})

describe('view state stays on the machine', () => {
  /** sample() with desk-1's group showing `active`, the frame's activeGroup set. */
  function focused(active: string): LayoutJson {
    const l = sample()
    const v = deskOf(l, 'desk-1').frames.views.f1
    v.grid.root.data.activeView = active
    v.activeGroup = 'g1'
    return l
  }
  const viewOf = (l: LayoutJson, id: string): Record<string, any> => deskOf(l, id).frames.views.f1

  test('switching only the active tab changes no exported entity', () => {
    const a = exportWin(focused('111'))
    const b = exportWin(focused('br1'))
    assert.deepEqual(a.entities, b.entities)
    const d = entityDesks(a.entities).u1
    assert.equal(Object.hasOwn(d, 'activeFrame'), false)
    assert.equal(Object.hasOwn(d.frames.views.f1, 'activeGroup'), false)
    assert.equal(Object.hasOwn(d.frames.views.f1.grid.root.data, 'activeView'), false)
  })

  test('round trip gives the layout back byte for byte, local active tab kept', () => {
    const layout = focused('br1')
    const ex = exportWin(layout)
    const im = importLayout(ex.entities, layout, ex.map, ex.ids, WIN)
    assert.equal(JSON.stringify(im.layout), JSON.stringify(layout))
    // another machine's export (different active tab) does not move the local one
    const other = exportWin(focused('111'))
    const im2 = importLayout(other.entities, layout, other.map, other.ids, WIN)
    assert.equal(JSON.stringify(im2.layout), JSON.stringify(layout))
  })

  test('a new desk arrives without view state and gets a valid default', () => {
    const ex = exportWin(focused('br1'))
    const im = importLayout(ex.entities, emptyPosix(), { ...POSIX_MAP }, {}, NIX)
    const d = (im.layout.desks as Record<string, any>[])[0]!
    assert.equal(d.activeFrame, 'f1')
    assert.equal(d.frames.views.f1.grid.root.data.activeView, d.frames.views.f1.grid.root.data.views[0])
    assert.equal(Object.hasOwn(d.frames.views.f1, 'activeGroup'), false)
  })

  test('a local active tab gone from the remote falls back to the first tab', () => {
    const layout = focused('br1')
    const ex = exportWin(layout)
    const g = entityDesks(ex.entities).u1.frames.views.f1.grid.root.data
    g.views = g.views.filter((x: string) => x !== 'br1')
    const im = importLayout(ex.entities, layout, ex.map, ex.ids, WIN)
    assert.equal(viewOf(im.layout, 'desk-1').grid.root.data.activeView, g.views[0])
    assert.equal(viewOf(im.layout, 'desk-1').activeGroup, 'g1')
  })

  test('an old entity carrying view state is read and its view state ignored', () => {
    const layout = focused('br1')
    const ex = exportWin(layout)
    const d = entityDesks(ex.entities).u1
    d.activeFrame = 'f1'
    d.frames.views.f1.activeGroup = 'g1'
    d.frames.views.f1.grid.root.data.activeView = '111'
    const im = importLayout(ex.entities, layout, ex.map, ex.ids, WIN)
    assert.deepEqual(im.skipped, [])
    assert.equal(JSON.stringify(im.layout), JSON.stringify(layout))
    const again = exportWin(im.layout, im.ids)
    assert.equal(Object.hasOwn(entityDesks(again.entities).u1.frames.views.f1.grid.root.data, 'activeView'), false)
  })
})

describe('view state of frames pads stays on the machine', () => {
  /** sample() with a `frame-pads.desk` pad on desk-1 whose nested desk shows `active`. */
  function withPad(active: string): LayoutJson {
    const l = sample()
    const inner = desk('x', 'x', { p1: terminal('p1', 'C:\atrium'), p2: terminal('p2', 'C:\atrium') }) as Record<string, any>
    inner.frames.views.f1.grid.root = { type: 'branch', data: [{ type: 'leaf', data: { views: ['p1', 'p2'], activeView: active, id: 'g1' } }] }
    inner.frames.views.f1.activeGroup = 'g1'
    deskOf(l, 'desk-1').pads['frame-pads.desk'] = { frames: inner.frames, activeFrame: 'f1' }
    return l
  }

  test('switching the active tab inside a frame-pads pad changes no exported entity', () => {
    const a = exportWin(withPad('p1'))
    const b = exportWin(withPad('p2'))
    assert.deepEqual(a.entities, b.entities)
    const text = JSON.stringify(a.entities)
    assert.doesNotMatch(text, /activeView|activeGroup|activeFrame/)
  })

  test('round trip is byte for byte with the nested local value kept', () => {
    const layout = withPad('p2')
    const other = exportWin(withPad('p1'))
    const im = importLayout(other.entities, layout, other.map, other.ids, WIN)
    assert.equal(JSON.stringify(im.layout), JSON.stringify(layout))
  })
})
