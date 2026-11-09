// The side bars and their pads (F10, app/renderer/sidebar-rules.ts) and layout.json v3 (app/renderer/layout.ts):
//   - the pad registry (VS Code's ViewContainersRegistry): ids, duplicates, dispose, change events;
//   - where a pad is (custom placement over its default side; only non-default placements kept), strip order;
//   - the icon toggle (one pad open per side bar), Ctrl+B (the side bar reopens with its last pad), moving a pad to the
//     other side and "Restaurar posição padrão";
//   - reading the side bars tolerantly (an extension that is off keeps its pads' ids and states);
//   - the v2 → v3 migration with a synthetic v2 file: desks, frames, panes and the drawer come back intact, the side bars
//     closed; a v3 file with pad states round-trips.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  clampWidth, DEFAULT_SIDEBAR_WIDTH, emptySideBars, fitWidth, isMoved, MAX_SIDEBAR_WIDTH, MIN_DOCK_WIDTH, MIN_SIDEBAR_WIDTH, movePad, openPad, openPadOn,
  PadRegistry, padsOn, padToggleCommand, readSideBars, restorePad, setWidth, sideOf, togglePad, toggleSideBar, type PadDescriptor, type SideBarsLayout,
} from '../../app/renderer/sidebar-rules.ts'
import { allPanelIds, isLayoutV4, migrateLayout, planRestore, type LayoutV2 } from '../../app/renderer/layout.ts'

const desk: PadDescriptor = { id: 'frame-pads.desk', title: 'Prancheta da mesa', icon: 'clipboard-text', defaultSide: 'right', scope: 'desk', frames: true, order: 10 }
const global: PadDescriptor = { id: 'frame-pads.global', title: 'Prancheta global', icon: 'globe-simple', defaultSide: 'right', scope: 'global', frames: true, order: 20 }
const files: PadDescriptor = { id: 'explorer.files', title: 'Arquivos', icon: 'folder', defaultSide: 'left', scope: 'global' }
const PADS = [global, desk, files]

describe('pad registry', () => {
  test('register, get, all in order; a duplicate or malformed id is refused; dispose takes the pad back; changes are told', () => {
    const r = new PadRegistry()
    let changes = 0
    r.onDidChange(() => changes++)
    const d1 = r.register(desk)
    r.register(global)
    assert.deepEqual(r.all().map(p => p.id), [desk.id, global.id])
    assert.equal(r.get(global.id), global)
    assert.throws(() => r.register(desk), /duas vezes/)
    assert.throws(() => r.register({ ...files, id: 'Bad Id' }), /malformado/)
    d1.dispose()
    assert.deepEqual(r.all().map(p => p.id), [global.id])
    assert.equal(changes, 3)
    assert.equal(padToggleCommand(desk.id), 'pad.toggle.frame-pads.desk')
  })
})

describe('where a pad is', () => {
  test('default side unless moved; the strip is ordered by `order`, then registration', () => {
    const s = emptySideBars()
    assert.equal(sideOf(s, desk), 'right')
    assert.deepEqual(padsOn(PADS, s, 'right').map(p => p.id), [desk.id, global.id])
    assert.deepEqual(padsOn(PADS, s, 'left').map(p => p.id), [files.id])
    assert.equal(sideOf({ placement: { [desk.id]: 'left' } }, desk), 'left')
    assert.equal(isMoved({ placement: { [desk.id]: 'left' } }, desk), true)
    assert.equal(isMoved(s, desk), false)
  })
})

describe('the icon toggle and Ctrl+B', () => {
  test('click opens; click again closes and remembers it; another pad on the same side takes its place (one open per side)', () => {
    let s = togglePad(emptySideBars(), PADS, desk.id)
    assert.equal(openPadOn(PADS, s, 'right')?.id, desk.id)
    s = togglePad(s, PADS, global.id)
    assert.equal(openPadOn(PADS, s, 'right')?.id, global.id, 'one pad per side bar')
    s = togglePad(s, PADS, global.id)
    assert.equal(openPadOn(PADS, s, 'right'), undefined)
    assert.equal(s.right.last, global.id)
    s = togglePad(s, PADS, files.id)
    assert.equal(openPadOn(PADS, s, 'left')?.id, files.id, 'the left side is independent')
    assert.equal(openPad(s, PADS, files.id), s, 'opening an open pad changes nothing')
    assert.equal(togglePad(s, PADS, 'nobody.pad'), s)
  })

  test('Ctrl+B: a closed side opens with its last pad (else the first); an open one closes; a side without pads stays as it is', () => {
    let s = toggleSideBar(emptySideBars(), PADS, 'right')
    assert.equal(s.right.open, desk.id, 'the first pad on the strip')
    s = togglePad(s, PADS, global.id)
    s = toggleSideBar(s, PADS, 'right')
    assert.equal(s.right.open, undefined)
    s = toggleSideBar(s, PADS, 'right')
    assert.equal(s.right.open, global.id, 'reopens with the pad it had')
    const none = emptySideBars()
    assert.equal(toggleSideBar(none, [desk], 'left'), none)
  })

  test('an open id nobody declares (an extension off) reads as closed, and Ctrl+B opens a declared pad over it', () => {
    const s: SideBarsLayout = { ...emptySideBars(), right: { open: 'gone.pad', last: 'gone.pad', width: 300 } }
    assert.equal(openPadOn(PADS, s, 'right'), undefined)
    assert.equal(toggleSideBar(s, PADS, 'right').right.open, desk.id)
  })
})

describe('moving a pad and restoring its default side', () => {
  test('to the other side: it opens there (in the place of what was open), leaves its old side; back home drops the placement', () => {
    let s = togglePad(emptySideBars(), PADS, desk.id)
    s = togglePad(s, PADS, files.id)
    s = movePad(s, PADS, desk.id)
    assert.deepEqual(s.placement, { [desk.id]: 'left' })
    assert.equal(openPadOn(PADS, s, 'left')?.id, desk.id)
    assert.equal(openPadOn(PADS, s, 'right'), undefined)
    assert.equal(s.right.last, undefined, 'not the right side\'s "last" any more')
    assert.deepEqual(padsOn(PADS, s, 'left').map(p => p.id), [files.id, desk.id], 'by order: files (0) before the desk pad (10)')
    assert.equal(movePad(s, PADS, desk.id, 'left'), s, 'already there')
    s = restorePad(s, PADS, desk.id)
    assert.deepEqual(s.placement, {}, 'only non-default placements are kept')
    assert.equal(openPadOn(PADS, s, 'right')?.id, desk.id)
    assert.equal(restorePad(s, PADS, desk.id), s)
  })
})

describe('widths and reading the file', () => {
  test('widths are clamped; on screen the desks keep their room', () => {
    assert.equal(clampWidth(10), MIN_SIDEBAR_WIDTH)
    assert.equal(clampWidth(99999), MAX_SIDEBAR_WIDTH)
    assert.equal(setWidth(emptySideBars(), 'left', 512.4).left.width, 512)
    assert.equal(fitWidth(600, 2000), 600)
    assert.equal(fitWidth(1800, 2000), 2000 - MIN_DOCK_WIDTH)
    assert.equal(fitWidth(600, 1000, 400), 1000 - MIN_DOCK_WIDTH - 400)
    assert.equal(fitWidth(600, 300), MIN_SIDEBAR_WIDTH, 'never under the minimum')
  })

  test('garbage reads as closed side bars; unknown pads keep their ids, sides and states', () => {
    assert.deepEqual(readSideBars(undefined), emptySideBars())
    assert.deepEqual(readSideBars({ left: 3, right: { width: 'x', open: 7 }, placement: [], pads: 'no' }), emptySideBars())
    const raw = { left: { open: 'gone.pad', width: 250 }, right: { last: desk.id, width: 99999 }, placement: { 'gone.pad': 'left', [desk.id]: 'up' }, pads: { 'gone.pad': { a: 1 } } }
    const s = readSideBars(raw)
    assert.deepEqual(s, { left: { open: 'gone.pad', width: 250 }, right: { last: desk.id, width: MAX_SIDEBAR_WIDTH }, placement: { 'gone.pad': 'left' }, pads: { 'gone.pad': { a: 1 } } })
    assert.equal(emptySideBars().left.width, DEFAULT_SIDEBAR_WIDTH)
  })
})

describe('layout.json v3: a v2 file migrates intact', () => {
  const text = readFileSync(join(import.meta.dirname, 'fixtures', 'layout-v2-synthetic.json'), 'utf8')
  const SLOTS = ['slot-a', 'slot-b', 'slot-c', 'slot-d', 'slot-e']

  test('the synthetic v2 file (2 desks, 3 frames, a note, an empty pane, the drawer) reads as v3 with every desk, frame, pane and the drawer as they were', () => {
    const v2 = JSON.parse(text) as LayoutV2
    const out = migrateLayout(JSON.parse(text))!
    assert.equal(out.from, 2)
    assert.equal(out.migrated, false, 'no v1 backup: the v2 one is the caller\'s (from === 2)')
    assert.equal(out.layout.v, 4)
    assert.deepEqual(out.layout.desks, v2.desks, 'desks, frames and panes byte for byte')
    assert.deepEqual(out.layout.drawer, v2.drawer)
    assert.equal(out.layout.activeDesk, 'desk-2')
    assert.deepEqual(out.layout.sidebars, emptySideBars())
    assert.deepEqual(allPanelIds(out.layout).sort(), [...SLOTS, 'note:00mh1k2a3-0x1y', 'empty:00mh1k2d0-3ghi'].sort())
  })

  test('restored with every slot known: nothing orphaned, the desks as read; with a slot missing only that pane leaves the display', () => {
    const all = planRestore(JSON.parse(text), new Set(SLOTS))
    assert.deepEqual(all.orphaned, [])
    assert.equal(all.from, 2)
    assert.deepEqual(all.layout!.desks, (JSON.parse(text) as LayoutV2).desks)
    const some = planRestore(JSON.parse(text), new Set(SLOTS.filter(s => s !== 'slot-c')))
    assert.deepEqual(some.orphaned, ['slot-c'])
    assert.ok(!allPanelIds(some.layout!).includes('slot-c'))
    assert.deepEqual(some.layout!.desks[0]!.frames.views['frame-2'], undefined, 'its frame went with it')
    assert.deepEqual(some.layout!.sidebars, emptySideBars())
  })

  test('the v3 written from it reads back the same, with side bars, placements, global and per-desk pad states', () => {
    const v3 = migrateLayout(JSON.parse(text))!.layout
    v3.sidebars = movePad(togglePad(v3.sidebars, PADS, desk.id), PADS, global.id)
    v3.sidebars = { ...setWidth(v3.sidebars, 'left', 420), pads: { [global.id]: { frames: 'G' } } }
    v3.desks[1] = { ...v3.desks[1]!, pads: { [desk.id]: { frames: 'D2' } } }
    const written = JSON.parse(JSON.stringify(v3))
    assert.ok(isLayoutV4(written))
    const back = migrateLayout(written)!
    assert.equal(back.from, 4)
    assert.deepEqual(back.layout, v3)
    assert.deepEqual(back.layout.sidebars.placement, { [global.id]: 'left' })
    assert.equal(back.layout.sidebars.right.open, desk.id)
    assert.equal(back.layout.sidebars.left.open, global.id)
  })
})
