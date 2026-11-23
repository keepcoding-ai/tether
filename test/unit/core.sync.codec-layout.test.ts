import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { exportLayout, importLayout, PATH_KEYS, type LayoutJson, type SyncEntities } from '../../src/core/sync/codecs/layout.ts'

const WIN = { platform: 'win32', homedir: 'C:\\Users\\Ana' } as const
const NIX = { platform: 'linux', homedir: '/home/ana' } as const
const WIN_MAP = { atrium: 'C:\\atrium' }

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

function sample(): LayoutJson {
  return {
    v: 4,
    desks: [
      desk('desk-1', 'Mesa 1', {
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
      }),
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
const POSIX_MAP = { atrium: '/srv/atrium', thing: '/data/thing' }

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
  test('export then import gives the layout back', () => {
    const layout = sample()
    const ex = exportLayout(layout, WIN_MAP, WIN)
    assert.deepEqual(ex.skipped, [])
    const im = importLayout(ex.entities, layout, ex.map, WIN)
    assert.deepEqual(im.layout, layout)
    assert.deepEqual(im.arrived, [])
    assert.deepEqual(im.removed, [])
    assert.deepEqual(im.unmappedPlaces, [])
    assert.deepEqual(im.skipped, [])
  })

  test('no absolute path in the entities', () => {
    const ex = exportLayout(sample(), WIN_MAP, WIN)
    const text = JSON.stringify(ex.entities)
    assert.doesNotMatch(text, /(^|[^A-Za-z])[A-Za-z]:(\\\\|\/)/)
    assert.doesNotMatch(text, /Users/)
    assert.ok(text.includes('https://example.com/a'))
  })

  test('paths become places: known, home and new', () => {
    const ex = exportLayout(sample(), WIN_MAP, WIN)
    const desks = ex.entities.desks as Record<string, any>
    assert.deepEqual(desks['desk-1'].frames.views.f1.panels['111'].params.hint.cwd, { place: 'atrium', rel: 'workspace/tether' })
    assert.deepEqual(desks['desk-2'].frames.views.f1.panels['222'].params.hint.cwd, { place: 'home', rel: 'proj' })
    assert.deepEqual(desks['desk-3'].frames.views.f1.panels['333'].params.hint.cwd, { place: 'thing', rel: '' })
    assert.deepEqual(desks['desk-1'].frames.views.f1.panels['note:1'].params.note.path, { place: 'atrium', rel: 'mind/a.md' })
    assert.deepEqual(ex.map, { atrium: 'C:\\atrium', thing: 'D:\\other\\thing' })
    assert.deepEqual((ex.entities.layout as any).workspace.pinned[0], { path: { place: 'atrium', rel: '' } })
  })

  test('the order, the emblems and the workspace are layout entities', () => {
    const ex = exportLayout(sample(), WIN_MAP, WIN)
    const meta = ex.entities.layout as Record<string, any>
    assert.deepEqual(meta.order, { ids: ['desk-1', 'desk-2', 'desk-3'] })
    assert.deepEqual(meta.emblems, { emblems: [{ id: 'u-abc', glyph: 'star' }] })
    assert.ok(meta.workspace.pinned.length === 2)
  })

  test('asleep and the machine fields are not in the entities', () => {
    const ex = exportLayout(sample(), WIN_MAP, WIN)
    const text = JSON.stringify(ex.entities)
    for (const word of ['asleep', 'activeDesk', 'DRAWER-MARK', 'SIDEBAR-MARK', 'systemDesks', 'asleepPanes', 'deskSleptPanes']) {
      assert.ok(!text.includes(word), word)
    }
    assert.deepEqual(Object.keys(ex.entities).sort(), ['desks', 'layout'])
  })

  test('without emblems or workspace those entities are absent', () => {
    const layout = sample()
    delete layout.emblems
    delete layout.workspace
    const meta = exportLayout(layout, WIN_MAP, WIN).entities.layout as Record<string, unknown>
    assert.deepEqual(Object.keys(meta), ['order'])
  })
})

describe('two machines', () => {
  test('win32 export, posix import: the paths resolve through the other map', () => {
    const ex = exportLayout(sample(), WIN_MAP, WIN)
    const im = importLayout(ex.entities, emptyPosix(), POSIX_MAP, NIX)
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
  })

  test('a place with no map here: the key is left out and the place is reported, sorted and once', () => {
    const ex = exportLayout(sample(), WIN_MAP, WIN)
    const im = importLayout(ex.entities, emptyPosix(), {}, NIX)
    assert.deepEqual(im.unmappedPlaces, ['atrium', 'thing'])
    const hint = deskOf(im.layout, 'desk-3').frames.views.f1.panels['333'].params.hint
    assert.ok(!('cwd' in hint))
    assert.equal(hint.kind, 'claude')
    assert.equal(hintCwd(im.layout, 'desk-2', '222'), '/home/ana/proj') // home is built in
  })

  test('a PlaceRef-like object with another shape is not touched', () => {
    const entities: SyncEntities = {
      desks: { 'desk-1': desk('desk-1', 'M', { a: { id: 'a', params: { cwd: { place: 'x', rel: 'y', extra: 1 }, path: { place: 1, rel: 'y' } } } }) },
    }
    const im = importLayout(entities, emptyPosix(), {}, NIX)
    assert.deepEqual(deskOf(im.layout, 'desk-1').frames.views.f1.panels.a.params, { cwd: { place: 'x', rel: 'y', extra: 1 }, path: { place: 1, rel: 'y' } })
    assert.deepEqual(im.unmappedPlaces, [])
  })

  test('URLs are never paths', () => {
    const layout = sample()
    const panels = deskOf(layout, 'desk-1').frames.views.f1.panels
    panels.br1.params.cwd = 'file:///C:/atrium/x'
    panels.br1.params.path = 'https://example.com/a/b'
    panels.br1.params.url = 'http://localhost:3000/x'
    const ex = exportLayout(layout, WIN_MAP, WIN)
    const stored = (ex.entities.desks as Record<string, any>)['desk-1'].frames.views.f1.panels.br1.params
    assert.equal(stored.cwd, 'file:///C:/atrium/x')
    assert.equal(stored.path, 'https://example.com/a/b')
    const im = importLayout(ex.entities, layout, ex.map, WIN)
    assert.deepEqual(im.layout, layout)
  })
})

describe('import: the persistent one commands the set and the order', () => {
  test('a new desk arrives asleep, its terminals in both lists (no duplicates, lists created)', () => {
    const ex = exportLayout(sample(), WIN_MAP, WIN)
    const current = emptyPosix()
    const im = importLayout(ex.entities, current, POSIX_MAP, NIX)
    assert.deepEqual(im.arrived, ['desk-1', 'desk-2', 'desk-3'])
    for (const id of ids(im.layout)) assert.equal(deskOf(im.layout, id).asleep, true)
    assert.deepEqual(im.layout.asleepPanes, ['111', '222', '333'])
    assert.deepEqual(im.layout.deskSleptPanes, ['111', '222', '333'])

    const withOne: LayoutJson = { ...emptyPosix(), asleepPanes: ['111'], deskSleptPanes: ['111'] }
    const again = importLayout(ex.entities, withOne, POSIX_MAP, NIX)
    assert.deepEqual(again.layout.asleepPanes, ['111', '222', '333'])
    assert.deepEqual(again.layout.deskSleptPanes, ['111', '222', '333'])
  })

  test('browser and note panes are not terminals', () => {
    const ex = exportLayout(sample(), WIN_MAP, WIN)
    const im = importLayout(ex.entities, emptyPosix(), POSIX_MAP, NIX)
    assert.ok(!(im.layout.asleepPanes as string[]).includes('br1'))
    assert.ok(!(im.layout.asleepPanes as string[]).includes('note:1'))
  })

  test('a removed desk leaves and takes its terminals out of both lists', () => {
    const layout = sample()
    layout.activeDesk = 'desk-3'
    layout.asleepPanes = ['222', '333']
    layout.deskSleptPanes = ['333']
    const ex = exportLayout(layout, WIN_MAP, WIN)
    delete (ex.entities.desks as Record<string, unknown>)['desk-3']
    ;(ex.entities.layout as any).order.ids = ['desk-1', 'desk-2']
    const im = importLayout(ex.entities, layout, ex.map, WIN)
    assert.deepEqual(im.removed, ['desk-3'])
    assert.deepEqual(ids(im.layout), ['desk-1', 'desk-2'])
    assert.deepEqual(im.layout.asleepPanes, ['222'])
    assert.deepEqual(im.layout.deskSleptPanes, [])
    assert.equal(im.layout.activeDesk, 'desk-1')
  })

  test('activeDesk stays when its desk stays, and with no desks it is left alone', () => {
    const layout = sample()
    const ex = exportLayout(layout, WIN_MAP, WIN)
    assert.equal(importLayout(ex.entities, layout, ex.map, WIN).layout.activeDesk, 'desk-2')
    const none = importLayout({ desks: {}, layout: { order: { ids: [] } } }, layout, ex.map, WIN)
    assert.deepEqual(none.removed, ['desk-1', 'desk-2', 'desk-3'])
    assert.deepEqual(none.layout.desks, [])
    assert.equal(none.layout.activeDesk, 'desk-2')
  })

  test('the local asleep of a desk that exists is kept, whatever the entity says', () => {
    const layout = sample()
    deskOf(layout, 'desk-1').asleep = true
    const ex = exportLayout(layout, WIN_MAP, WIN)
    ;(ex.entities.desks as any)['desk-2'].asleep = false
    const im = importLayout(ex.entities, layout, ex.map, WIN)
    assert.equal(deskOf(im.layout, 'desk-1').asleep, true)
    assert.equal(deskOf(im.layout, 'desk-2').asleep, true) // local value, not the entity's
    assert.ok(!('asleep' in deskOf(im.layout, 'desk-3')))
  })

  test("the persistent order wins, desks outside it go after, by id", () => {
    const layout = sample()
    const ex = exportLayout(layout, WIN_MAP, WIN)
    ;(ex.entities.layout as any).order.ids = ['desk-3', 'ghost', 'desk-1', 'desk-3']
    const im = importLayout(ex.entities, layout, ex.map, WIN)
    assert.deepEqual(ids(im.layout), ['desk-3', 'desk-1', 'desk-2'])
    const noOrder = importLayout({ desks: ex.entities.desks! }, layout, ex.map, WIN)
    assert.deepEqual(ids(noOrder.layout), ['desk-1', 'desk-2', 'desk-3'])
  })

  test('emblems and workspace replace the local ones when present, stay when absent', () => {
    const layout = sample()
    const ex = exportLayout(layout, WIN_MAP, WIN)
    const meta = ex.entities.layout as any
    meta.emblems = { emblems: [{ id: 'new' }] }
    meta.workspace = { pinned: [{ path: { place: 'atrium', rel: 'z' } }] }
    const replaced = importLayout(ex.entities, layout, ex.map, WIN)
    assert.deepEqual(replaced.layout.emblems, [{ id: 'new' }])
    assert.deepEqual(replaced.layout.workspace, { pinned: [{ path: 'C:\\atrium\\z' }] })

    delete meta.emblems
    delete meta.workspace
    const kept = importLayout(ex.entities, layout, ex.map, WIN)
    assert.deepEqual(kept.layout.emblems, layout.emblems)
    assert.deepEqual(kept.layout.workspace, layout.workspace)
  })

  test('machine fields and unknown top-level keys are preserved', () => {
    const ex = exportLayout(sample(), WIN_MAP, WIN)
    const current = emptyPosix()
    const im = importLayout(ex.entities, current, POSIX_MAP, NIX)
    assert.deepEqual(im.layout.futureKey, { a: [1, 2] })
    assert.deepEqual(im.layout.sidebars, { right: 1 })
    assert.equal(im.layout.drawer, null)
    assert.equal(im.layout.v, 4)
    const keys = Object.keys(sample())
    assert.ok(!(keys as string[]).includes('futureKey'))
    assert.ok(!JSON.stringify(ex.entities).includes('futureKey'))
  })

  test('no desks entity: current comes back intact', () => {
    const layout = sample()
    const im = importLayout({ layout: { order: { ids: [] } } }, layout, WIN_MAP, WIN)
    assert.deepEqual(im.layout, layout)
    assert.notEqual(im.layout, layout)
    assert.deepEqual([im.arrived, im.removed, im.unmappedPlaces, im.skipped], [[], [], [], []])
  })

  test('a malformed desk entity is skipped; the local desk under that id stays', () => {
    const layout = sample()
    const ex = exportLayout(layout, WIN_MAP, WIN)
    const desks = ex.entities.desks as Record<string, unknown>
    desks.bad = { id: 'bad' }
    desks['desk-2'] = { id: 'desk-2', name: 'x' }
    desks.mismatch = desk('other', 'O', {})
    const im = importLayout(ex.entities, layout, ex.map, WIN)
    assert.deepEqual(im.skipped.sort(), ['desks/bad', 'desks/desk-2', 'desks/mismatch'])
    assert.deepEqual(ids(im.layout).sort(), ['desk-1', 'desk-2', 'desk-3'])
    assert.deepEqual(deskOf(im.layout, 'desk-2'), deskOf(layout, 'desk-2'))
    assert.deepEqual(im.removed, [])
  })
})

describe('export edge cases', () => {
  test('a version other than 4 does not export', () => {
    for (const v of [3, 5, undefined]) {
      const ex = exportLayout({ ...sample(), v }, WIN_MAP, WIN)
      assert.deepEqual(ex.entities, {})
      assert.deepEqual(ex.skipped, ['layout'])
      assert.deepEqual(ex.map, WIN_MAP)
    }
  })

  test('a desk with an invalid id is skipped and left out of the order', () => {
    const layout = sample()
    ;(layout.desks as unknown[]).push(desk('Mesa Nova', 'Bad', {}), desk('-x', 'Bad2', {}), 'junk')
    const ex = exportLayout(layout, WIN_MAP, WIN)
    assert.deepEqual(ex.skipped, ['desks/Mesa Nova', 'desks/-x', 'desks/[5]'])
    assert.deepEqual(Object.keys(ex.entities.desks!), ['desk-1', 'desk-2', 'desk-3'])
    assert.deepEqual((ex.entities.layout as any).order.ids, ['desk-1', 'desk-2', 'desk-3'])
  })
})

describe('purity', () => {
  test('neither layout, current nor the maps are mutated', () => {
    const layout = deepFreeze(sample())
    const map = deepFreeze({ ...WIN_MAP })
    const ex = exportLayout(layout, map, WIN)
    assert.deepEqual(map, WIN_MAP)
    assert.notEqual(ex.map, map)
    deepFreeze(ex.entities)
    deepFreeze(ex.map)
    const current = deepFreeze(emptyPosix())
    const posix = deepFreeze({ ...POSIX_MAP })
    const im = importLayout(ex.entities, current, posix, NIX)
    assert.deepEqual(current, emptyPosix())
    assert.deepEqual(layout, sample())
    assert.deepEqual(posix, POSIX_MAP)
    assert.ok(im.arrived.length === 3)
    const round = importLayout(ex.entities, layout, ex.map, WIN)
    assert.deepEqual(round.layout, sample())
  })
})
