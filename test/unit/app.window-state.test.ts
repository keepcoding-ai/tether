// The remembered window state: what is accepted from settings.json and how it meets the displays that exist now.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_WINDOW_SIZE, isReachable, normalizeWindowState, resolveWindowState } from '../../app/shared/window-state.ts'

const primary = { x: 0, y: 0, width: 1920, height: 1040 }
const second = { x: 1920, y: 0, width: 2560, height: 1400 }
const good = { x: 100, y: 80, width: 1000, height: 700, maximized: false, fullscreen: false }

describe('normalizeWindowState', () => {
  test('missing or malformed values mean no state', () => {
    for (const raw of [undefined, null, 'x', 42, {}, { ...good, x: 'a' }, { ...good, width: NaN }, { ...good, width: 100 }, { ...good, height: 50 }]) {
      assert.equal(normalizeWindowState(raw), undefined)
    }
  })
  test('a valid value is kept; flags default to false and are strict booleans', () => {
    assert.deepEqual(normalizeWindowState(good), good)
    assert.deepEqual(normalizeWindowState({ ...good, maximized: true, fullscreen: 'yes' }), { ...good, maximized: true, fullscreen: false })
  })
  test('fractional numbers are rounded', () => {
    assert.deepEqual(normalizeWindowState({ ...good, x: 10.4, width: 999.6 }), { ...good, x: 10, width: 1000 })
  })
})

describe('isReachable', () => {
  test('inside a display', () => assert.equal(isReachable(good, [primary]), true))
  test('on a second display', () => assert.equal(isReachable({ ...good, x: 2000 }, [primary, second]), true))
  test('that display is gone', () => assert.equal(isReachable({ ...good, x: 2000 }, [primary]), false))
  test('only a sliver is visible', () => assert.equal(isReachable({ ...good, x: 1900 }, [primary]), false))
  test('negative coordinates of a display left of the primary', () => {
    assert.equal(isReachable({ ...good, x: -1500 }, [{ x: -1920, y: 0, width: 1920, height: 1080 }, primary]), true)
  })
})

describe('resolveWindowState', () => {
  test('first run: the default size, placed by the OS, not maximized', () => {
    assert.deepEqual(resolveWindowState(undefined, [primary], primary), { bounds: { ...DEFAULT_WINDOW_SIZE }, maximized: false, fullscreen: false })
  })
  test('saved bounds on screen are used as they are', () => {
    assert.deepEqual(resolveWindowState(good, [primary], primary), { bounds: { x: 100, y: 80, width: 1000, height: 700 }, maximized: false, fullscreen: false })
  })
  test('maximized keeps the normal bounds and the flag', () => {
    const r = resolveWindowState({ ...good, maximized: true }, [primary], primary)
    assert.equal(r.maximized, true)
    assert.deepEqual(r.bounds, { x: 100, y: 80, width: 1000, height: 700 })
  })
  test('off-screen bounds: default size centered on the primary work area, flags kept', () => {
    const r = resolveWindowState({ ...good, x: 3000, maximized: true, fullscreen: true }, [primary], primary)
    assert.deepEqual(r.bounds, { x: 260, y: 70, width: 1400, height: 900 })
    assert.equal(r.maximized, true)
    assert.equal(r.fullscreen, true)
  })
  test('the fallback never exceeds a small primary display', () => {
    const small = { x: 0, y: 0, width: 1280, height: 720 }
    assert.deepEqual(resolveWindowState({ ...good, x: 5000 }, [small], small).bounds, { x: 0, y: 0, width: 1280, height: 720 })
  })
  test('the fallback is relative to a primary that is not at the origin', () => {
    const p = { x: 1920, y: 0, width: 2560, height: 1400 }
    assert.deepEqual(resolveWindowState({ ...good, x: -9000 }, [p], p).bounds, { x: 1920 + 580, y: 250, width: 1400, height: 900 })
  })
})
