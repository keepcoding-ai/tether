// The docked quick view's sizes and its drag (app/renderer/quick-card-rules.ts), pure: what each tier allows, the large box,
// Esc that reduces before it closes, the drag's threshold and who may drag, and the bounds that keep the card in the Regency.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DRAG_THRESHOLD, LARGE_MARGIN, LARGE_MARGIN_SMALL, NO_OFFSET, clampOffset, dragAllowed, dragStarted, largeBox, quickAbilities, quickBox,
  escWord, quickEscAction, shownSize, sizeButton, sizeOnShow, toggledSize, type QuickAbilities,
} from '../../app/renderer/quick-card-rules.ts'
import { DOCK_MARGIN, paneCardFoot, type Box } from '../../app/renderer/peek-rules.ts'

const BOTH: QuickAbilities = { expand: true, move: true }

describe('quick card: what each tier allows', () => {
  test('the phone has neither; the tablet grows but does not move; the desktop both; the TV moves only over the conversation', () => {
    assert.deepEqual(quickAbilities('mobile', false), { expand: false, move: false })
    assert.deepEqual(quickAbilities('tablet', false), { expand: true, move: false })
    assert.deepEqual(quickAbilities('desktop', false), { expand: true, move: true })
    assert.deepEqual(quickAbilities('wide', false), { expand: true, move: true })
    assert.deepEqual(quickAbilities('wide', true), { expand: true, move: false })
  })
  test('a large card on a tier without "Ampliar" shows docked', () => {
    assert.equal(shownSize('large', { expand: false, move: false }), 'docked')
    assert.equal(shownSize('large', BOTH), 'large')
    assert.equal(shownSize('docked', BOTH), 'docked')
  })
})

describe('quick card: the two sizes', () => {
  test('the button swaps them and says what a press does', () => {
    assert.equal(toggledSize('docked'), 'large')
    assert.equal(toggledSize('large'), 'docked')
    assert.deepEqual([sizeButton('docked').label, sizeButton('docked').icon], ['Ampliar', 'arrows-out-simple'])
    assert.deepEqual([sizeButton('large').label, sizeButton('large').icon], ['Reduzir', 'arrows-in-simple'])
    assert.match(sizeButton('large').title, /Esc/)
  })
  test('another pane spied keeps a large card large; a new opening is docked', () => {
    assert.equal(sizeOnShow('large', false), 'large', 'the swap keeps the "imersão rápida"')
    assert.equal(sizeOnShow('docked', false), 'docked')
    assert.equal(sizeOnShow('large', true), 'docked', 'nothing persists between openings')
  })
  test('the foot says what Esc does: the large card reduces, the docked one closes', () => {
    assert.equal(escWord('large'), 'Esc reduz')
    assert.equal(escWord('docked'), 'Esc aqui fecha')
    const f = { asleep: false, deskAsleep: false, place: 'Obra' }
    assert.equal(paneCardFoot(f, ['Ctrl+Shift+O'], escWord('large')).hint, 'Esc reduz · Ctrl+Shift+O')
    assert.equal(paneCardFoot(f, ['Ctrl+Shift+O']).hint, 'Esc aqui fecha · Ctrl+Shift+O', 'the default is the docked word')
    assert.equal(paneCardFoot(f, [], escWord('large')).hint, 'Esc reduz')
  })
  test('the large box is the area less the modal margin (6 px in a small area)', () => {
    assert.deepEqual(largeBox({ left: 100, top: 40, width: 1600, height: 900 }), { left: 100 + LARGE_MARGIN, top: 40 + LARGE_MARGIN, width: 1600 - 2 * LARGE_MARGIN, height: 900 - 2 * LARGE_MARGIN })
    assert.deepEqual(largeBox({ left: 0, top: 0, width: 500, height: 900 }), { left: LARGE_MARGIN_SMALL, top: LARGE_MARGIN_SMALL, width: 500 - 2 * LARGE_MARGIN_SMALL, height: 900 - 2 * LARGE_MARGIN_SMALL })
    assert.equal(largeBox({ left: 0, top: 0, width: 10, height: 10 }).width, 0, 'never negative')
  })
  test('Esc: where it closes the docked card it reduces the large one; the content keeps its Esc; the modal card closes', () => {
    assert.equal(quickEscAction(false, 'large', 'chrome'), 'reduce')
    assert.equal(quickEscAction(false, 'large', 'opener'), 'reduce')
    assert.equal(quickEscAction(false, 'docked', 'chrome'), 'close')
    assert.equal(quickEscAction(false, 'docked', 'opener'), 'close')
    assert.equal(quickEscAction(false, 'large', 'content'), 'none')
    assert.equal(quickEscAction(false, 'large', 'outside'), 'none')
    assert.equal(quickEscAction(true, 'docked', 'outside'), 'close')
    assert.equal(quickEscAction(true, 'large', 'chrome'), 'close', 'a modal card has no large size')
  })
})

describe('quick card: the drag', () => {
  test('a press is a click until it travels the threshold', () => {
    assert.equal(dragStarted(0, 0), false)
    assert.equal(dragStarted(DRAG_THRESHOLD - 1, 0), false)
    assert.equal(dragStarted(3, 4), DRAG_THRESHOLD <= 5)
    assert.equal(dragStarted(DRAG_THRESHOLD, 0), true)
    assert.ok(DRAG_THRESHOLD >= 3 && DRAG_THRESHOLD <= 8, 'a few px')
  })
  test('only the docked card, on a tier that moves it, with the main button of a mouse or a pen', () => {
    const p = { size: 'docked' as const, abilities: BOTH, pointerType: 'mouse', button: 0 }
    assert.equal(dragAllowed(p), true)
    assert.equal(dragAllowed({ ...p, pointerType: 'pen' }), true)
    assert.equal(dragAllowed({ ...p, pointerType: 'touch' }), false, 'no drag by touch')
    assert.equal(dragAllowed({ ...p, button: 2 }), false)
    assert.equal(dragAllowed({ ...p, size: 'large' }), false, 'the large card does not move')
    assert.equal(dragAllowed({ ...p, abilities: { expand: true, move: false } }), false)
  })
  const area: Box = { left: 0, top: 0, width: 1400, height: 800 }
  const base: Box = { left: 700, top: 56, width: 640, height: 500 }
  test('the offset keeps the whole card inside the area, with the docked margin', () => {
    assert.deepEqual(clampOffset(base, { x: -50, y: 30 }, area), { x: -50, y: 30 }, 'inside: as asked')
    assert.deepEqual(clampOffset(base, { x: -5000, y: -5000 }, area), { x: DOCK_MARGIN - 700, y: DOCK_MARGIN - 56 })
    assert.deepEqual(clampOffset(base, { x: 5000, y: 5000 }, area), { x: 1400 - DOCK_MARGIN - 1340, y: 800 - DOCK_MARGIN - 556 })
  })
  test('a card larger than the area keeps its top left in it', () => {
    const big: Box = { left: 10, top: 10, width: 2000, height: 1000 }
    assert.deepEqual(clampOffset(big, { x: 300, y: 300 }, area), { x: DOCK_MARGIN - 10, y: DOCK_MARGIN - 10 })
  })
  test('the box: docked moved by the clamped offset, large ignores it', () => {
    assert.deepEqual(quickBox('docked', base, area, NO_OFFSET), base)
    assert.deepEqual(quickBox('docked', base, area, { x: -100, y: 20 }), { ...base, left: 600, top: 76 })
    assert.deepEqual(quickBox('docked', base, area, { x: 9999, y: 0 }).left, 1400 - DOCK_MARGIN - 640)
    assert.deepEqual(quickBox('large', base, area, { x: -100, y: 20 }), largeBox(area))
  })
})
