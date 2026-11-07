// The ≡ menu's submenu geometry (app/renderer/menu-submenus.ts): placement beside the menu, the flip to the left when
// there is no room on the right, the viewport clamp, and the safe triangle the pointer crosses toward a submenu.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { inTriangle, placeSubmenu, safeTriangle } from '../../app/renderer/menu-submenus.ts'

const vp = { width: 1280, height: 800 }
const size = { width: 260, height: 200 }

describe('placeSubmenu', () => {
  test('opens to the right when there is room, overlapping the border by 2 px', () => {
    const p = placeSubmenu({ left: 100, top: 40, right: 400, bottom: 420 }, { left: 104, top: 100, right: 396, bottom: 128 }, size, vp)
    assert.equal(p.side, 'right')
    assert.equal(p.left, 398)
    assert.equal(p.top, 95)
  })

  test('flips to the left when the right has no room (the menu hugs the window edge)', () => {
    const p = placeSubmenu({ left: 960, top: 40, right: 1276, bottom: 420 }, { left: 964, top: 100, right: 1272, bottom: 128 }, size, vp)
    assert.equal(p.side, 'left')
    assert.equal(p.left, 960 + 2 - 260)
  })

  test('stays inside the viewport vertically', () => {
    const p = placeSubmenu({ left: 960, top: 40, right: 1276, bottom: 420 }, { left: 964, top: 700, right: 1272, bottom: 728 }, size, vp)
    assert.equal(p.top, 800 - 4 - 200)
    const q = placeSubmenu({ left: 960, top: 0, right: 1276, bottom: 420 }, { left: 964, top: 0, right: 1272, bottom: 28 }, size, vp)
    assert.equal(q.top, 4)
  })

  test('a narrow window picks the roomier side and never leaves the viewport; a very tall submenu is capped', () => {
    const p = placeSubmenu({ left: 10, top: 40, right: 250, bottom: 420 }, { left: 14, top: 100, right: 246, bottom: 128 }, size, { width: 400, height: 300 })
    assert.ok(p.left >= 4 && p.left + size.width <= 396, JSON.stringify(p))
    const t = placeSubmenu({ left: 960, top: 40, right: 1276, bottom: 420 }, { left: 964, top: 100, right: 1272, bottom: 128 }, { width: 260, height: 2000 }, vp)
    assert.equal(t.maxHeight, 792)
    assert.equal(t.top, 4)
  })
})

describe('safe triangle', () => {
  test('a pointer between the opener and the submenu is inside; one away from it is outside', () => {
    const [a, b, c] = safeTriangle({ x: 300, y: 110 }, { left: 398, top: 95, right: 658, bottom: 295 }, 'right')
    assert.ok(inTriangle({ x: 350, y: 140 }, a, b, c), 'moving diagonally toward the submenu')
    assert.ok(!inTriangle({ x: 300, y: 400 }, a, b, c), 'straight down the menu')
    assert.ok(!inTriangle({ x: 350, y: 20 }, a, b, c), 'above the triangle')
  })

  test('mirrored when the submenu is on the left', () => {
    const [a, b, c] = safeTriangle({ x: 1000, y: 110 }, { left: 702, top: 95, right: 962, bottom: 295 }, 'left')
    assert.deepEqual([b.x, c.x], [962, 962])
    assert.ok(inTriangle({ x: 980, y: 150 }, a, b, c))
    assert.ok(!inTriangle({ x: 1000, y: 400 }, a, b, c))
  })
})
