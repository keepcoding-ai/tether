// The row of desks (app/renderer/desks.ts), the desk chords of the shortcut registry and the tray's
// attention badge. (The close-desk dialog is covered by the E2E: situations.ts imports SVGs.)
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { trayModel } from '../../app/shared/tray.ts'
import { cleanDeskName, closeDesk, colorOf, cycleDesk, DESK_COLORS, deskAt, type DeskInfo, insertDesk, MAX_DESK_NAME, moveDesk, neighbourDesk, nextDeskColor, nextDeskId, nextDeskName, recolorDesk, renameDesk, touchMru } from '../../app/renderer/desks.ts'
import { shortcutHint, shortcutOf } from '../../app/renderer/shortcuts.ts'

const row = (...ids: string[]): DeskInfo[] => ids.map((id, i) => ({ id, name: `Mesa ${i + 1}`, color: i }))
const ids = (desks: DeskInfo[]): string[] => desks.map(d => d.id)

describe('desk model', () => {
  test('new desk: next free id, name and least used colour, before or after the reference', () => {
    const desks = row('desk-1', 'desk-3')
    assert.equal(nextDeskId(desks), 'desk-2')
    assert.equal(nextDeskName(desks), 'Mesa 3')
    assert.equal(nextDeskColor(desks), 2)
    const after = insertDesk(desks, 'desk-1', 'after')
    assert.deepEqual(ids(after.desks), ['desk-1', 'desk-2', 'desk-3'])
    assert.deepEqual(after.desk, { id: 'desk-2', name: 'Mesa 3', color: 2 })
    assert.deepEqual(ids(insertDesk(desks, 'desk-1', 'before').desks), ['desk-2', 'desk-1', 'desk-3'])
    assert.deepEqual(ids(insertDesk(desks, 'nope', 'before').desks), ['desk-1', 'desk-3', 'desk-2'], 'unknown reference: at the end')
    assert.deepEqual(ids(insertDesk(desks, 'desk-3', 'after').desks), ['desk-1', 'desk-3', 'desk-2'])
  })

  test('colours: every colour used once before any repeats; colorOf wraps', () => {
    let desks: DeskInfo[] = []
    for (let i = 0; i < DESK_COLORS.length; i++) desks = insertDesk(desks, undefined, 'after').desks
    assert.deepEqual(desks.map(d => d.color), DESK_COLORS.map((_, i) => i))
    assert.equal(colorOf(DESK_COLORS.length + 1), DESK_COLORS[1]!.css)
    assert.equal(colorOf(-1), DESK_COLORS[DESK_COLORS.length - 1]!.css)
  })

  test('rename trims and refuses empty; recolor clamps into the palette', () => {
    const desks = row('a', 'b')
    assert.equal(renameDesk(desks, 'a', '  Cliente   X ')[0]!.name, 'Cliente X')
    assert.equal(renameDesk(desks, 'a', '   ')[0]!.name, 'Mesa 1')
    assert.equal(cleanDeskName('x'.repeat(100))!.length, MAX_DESK_NAME)
    assert.equal(recolorDesk(desks, 'b', 3)[1]!.color, 3)
    assert.equal(recolorDesk(desks, 'b', DESK_COLORS.length + 2)[1]!.color, 2)
  })

  test('reorder: moves one desk, the rest keep their order; out-of-range clamps', () => {
    const desks = row('a', 'b', 'c', 'd')
    assert.deepEqual(ids(moveDesk(desks, 'a', 2)), ['b', 'c', 'a', 'd'])
    assert.deepEqual(ids(moveDesk(desks, 'd', 0)), ['d', 'a', 'b', 'c'])
    assert.deepEqual(ids(moveDesk(desks, 'b', 99)), ['a', 'c', 'd', 'b'])
    assert.deepEqual(ids(moveDesk(desks, 'zz', 0)), ['a', 'b', 'c', 'd'])
  })

  test('switch: Ctrl+Tab is sequential and wraps; Ctrl+n by position', () => {
    const desks = row('a', 'b', 'c')
    assert.equal(cycleDesk(desks, 'a', 1), 'b')
    assert.equal(cycleDesk(desks, 'c', 1), 'a')
    assert.equal(cycleDesk(desks, 'a', -1), 'c')
    assert.equal(deskAt(desks, 2), 'b')
    assert.equal(deskAt(desks, 4), undefined)
  })

  test('close: never the last; the active one goes to the most recently used, else a neighbour', () => {
    const desks = row('a', 'b', 'c')
    assert.equal(closeDesk(row('a'), 'a', 'a', ['a']), null)
    assert.equal(closeDesk(desks, 'zz', 'a', []), null)
    const mru = touchMru(touchMru(touchMru([], 'c'), 'a'), 'b') // b, a, c
    assert.deepEqual(mru, ['b', 'a', 'c'])
    const r = closeDesk(desks, 'b', 'b', mru)!
    assert.deepEqual(ids(r.desks), ['a', 'c'])
    assert.equal(r.active, 'a')
    assert.equal(closeDesk(desks, 'b', 'b', ['b'])!.active, 'c', 'no history: the right neighbour')
    assert.equal(closeDesk(desks, 'c', 'c', [])!.active, 'b', 'last one: the left neighbour')
    assert.equal(closeDesk(desks, 'a', 'c', mru)!.active, 'c', 'closing another desk keeps the active one')
    assert.equal(neighbourDesk(desks, 'b'), 'c')
    assert.equal(neighbourDesk(desks, 'c'), 'b')
  })
})

describe('desk chords', () => {
  const key = (code: string, mods: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {}) =>
    shortcutOf({ ctrlKey: !!mods.ctrl, altKey: !!mods.alt, shiftKey: !!mods.shift, metaKey: false, code })
  test('Ctrl+Tab / Ctrl+Shift+Tab cycle, Ctrl+1…9 go, Ctrl+Alt+(Shift+)N create', () => {
    assert.deepEqual(key('Tab', { ctrl: true }), { op: 'desk-cycle', step: 1 })
    assert.deepEqual(key('Tab', { ctrl: true, shift: true }), { op: 'desk-cycle', step: -1 })
    for (let n = 1; n <= 9; n++) assert.deepEqual(key(`Digit${n}`, { ctrl: true }), { op: 'desk-go', position: n })
    assert.equal(key('Digit0', { ctrl: true }), undefined)
    assert.deepEqual(key('KeyN', { ctrl: true, alt: true }), { op: 'desk-new', side: 'after' })
    assert.deepEqual(key('KeyN', { ctrl: true, alt: true, shift: true }), { op: 'desk-new', side: 'before' })
  })
  test('the terminal keeps what it needs: Tab, Shift+Tab, Ctrl+N, Alt+digits, plain digits', () => {
    assert.equal(key('Tab'), undefined)
    assert.equal(key('Tab', { shift: true }), undefined)
    assert.equal(key('KeyN', { ctrl: true }), undefined)
    assert.equal(key('Digit1', { alt: true }), undefined)
    assert.equal(key('Digit1'), undefined)
  })
  test('hints', () => {
    assert.equal(shortcutHint({ op: 'desk-new', side: 'after' }), 'Ctrl+Alt+N')
    assert.equal(shortcutHint({ op: 'desk-new', side: 'before' }), 'Ctrl+Alt+Shift+N')
    assert.equal(shortcutHint({ op: 'desk-go', position: 3 }), 'Ctrl+3')
    assert.equal(shortcutHint({ op: 'desk-cycle', step: -1 }), 'Ctrl+Shift+Tab')
  })
})

const slot = (slotId: string, status: SlotState['status'], extra: Partial<SlotState> = {}): SlotState => ({ slotId, kind: 'claude', cwd: `D:/w/${slotId}`, status, ...extra })

describe('tray attention', () => {
  test('attention wins the badge, is counted in the tooltip and labels the pane', () => {
    const m = trayModel([slot('a', 'running', { attention: 'done', title: 'Login' }), slot('b', 'running', { attention: 'waiting' }), slot('c', 'running')])
    assert.equal(m.badge, 'attention')
    assert.equal(m.attention, 2)
    assert.equal(m.tooltip, 'tether: 3 agentes rodando · 2 esperando você')
    const labels = m.items.flatMap(i => (i.kind === 'pane' ? [i.label] : []))
    assert.deepEqual(labels, ['Login (terminou)', 'b (espera você)', 'c (rodando)'])
    assert.equal(trayModel([slot('a', 'running')]).badge, 'active')
  })
})
