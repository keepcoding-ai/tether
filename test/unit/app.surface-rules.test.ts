import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canMove, fitRect, hiddenBounds, isCoreDebuggerMethod, isPageSize, isRect, LOCKED_PREFERENCES, metricsOverride, parkedBounds, shieldVisible, surfacePreferences } from '../../app/main/surface-rules.ts'

const PAGE = { width: 1280, height: 800 }

test('fitRect: wide rectangle → fitted by height, centred horizontally', () => {
  const f = fitRect({ x: 100, y: 50, width: 1000, height: 400 }, PAGE)
  assert.equal(f.scale, 0.5)
  assert.deepEqual(f.rect, { x: 280, y: 50, width: 640, height: 400 })
})

test('fitRect: tall rectangle → fitted by width, centred vertically', () => {
  const f = fitRect({ x: 0, y: 0, width: 500, height: 600 }, PAGE)
  assert.equal(f.scale, 500 / 1280)
  assert.deepEqual(f.rect, { x: 0, y: 144, width: 500, height: 313 })
})

test('fitRect: never enlarges; a bigger rectangle keeps the page 1:1 in the centre', () => {
  const f = fitRect({ x: 10, y: 20, width: 1440, height: 900 }, PAGE)
  assert.equal(f.scale, 1)
  assert.deepEqual(f.rect, { x: 90, y: 70, width: 1280, height: 800 })
  assert.equal(fitRect({ x: 0, y: 0, width: 1280, height: 800 }, PAGE).scale, 1)
})

test('fitRect: without a page size the view takes the rectangle (rounded)', () => {
  assert.deepEqual(fitRect({ x: 1.4, y: 2.6, width: 300.5, height: 200 }, undefined), { rect: { x: 1, y: 3, width: 301, height: 200 }, scale: 1 })
})

test('fitRect: an empty rectangle gives an empty view at scale 0', () => {
  const f = fitRect({ x: 5, y: 5, width: 0, height: 400 }, PAGE)
  assert.equal(f.scale, 0)
  assert.equal(f.rect.width, 0)
})

test('hidden and parked bounds sit in the bottom-right corner with one pixel inside', () => {
  assert.deepEqual(hiddenBounds({ width: 1000, height: 700 }), { x: 999, y: 699, width: 1, height: 1 })
  assert.deepEqual(parkedBounds({ width: 1000, height: 700 }, { width: 640, height: 400 }), { x: 999, y: 699, width: 640, height: 400 })
  assert.deepEqual(parkedBounds({ width: 0, height: 0 }, { width: 0, height: 0 }), { x: 0, y: 0, width: 1, height: 1 })
})

test('canMove: shown needs a rect; parked only from shown; staying is fine', () => {
  assert.deepEqual(canMove('hidden', 'shown', true), { ok: true })
  assert.equal(canMove('hidden', 'shown', false).ok, false)
  assert.equal(canMove('hidden', 'parked', true).ok, false)
  assert.deepEqual(canMove('shown', 'parked', true), { ok: true })
  assert.deepEqual(canMove('parked', 'shown', true), { ok: true })
  assert.deepEqual(canMove('parked', 'hidden', true), { ok: true })
  assert.deepEqual(canMove('shown', 'hidden', true), { ok: true })
  assert.deepEqual(canMove('hidden', 'hidden', false), { ok: true })
})

test('shieldVisible: only over a shown surface with the shield on', () => {
  assert.equal(shieldVisible('shown', true), true)
  assert.equal(shieldVisible('shown', false), false)
  assert.equal(shieldVisible('hidden', true), false)
  assert.equal(shieldVisible('parked', true), false)
})

test('surfacePreferences: locked defaults always win; open keys pass', () => {
  const r = surfacePreferences({ partition: 'persist:browser', backgroundThrottling: false, sandbox: true })
  assert.ok(r.ok)
  assert.deepEqual(r.value, { partition: 'persist:browser', backgroundThrottling: false, ...LOCKED_PREFERENCES })
  const empty = surfacePreferences(undefined)
  assert.ok(empty.ok)
  assert.deepEqual(empty.value, { ...LOCKED_PREFERENCES })
})

test('surfacePreferences: refuses loosening, unknown keys, wrong types, preload', () => {
  for (const bad of [
    { nodeIntegration: true }, { sandbox: false }, { contextIsolation: false }, { webSecurity: false }, { webviewTag: true },
    { preload: '/x.js' }, { enableBlinkFeatures: 'X' }, { devTools: true }, { whatever: 1 }, { partition: 3 },
    { partition: 'a b' }, { partition: 'x', session: {} }, { session: null },
  ]) assert.equal(surfacePreferences(bad).ok, false, JSON.stringify(bad))
  assert.equal(surfacePreferences(null).ok, false)
  assert.equal(surfacePreferences([]).ok, false)
  assert.equal(surfacePreferences(JSON.parse('{"__proto__":{"nodeIntegration":true}}')).ok, false, 'an own __proto__ key is unknown')
})

test('page size, rect and debugger guards', () => {
  assert.ok(isPageSize({ width: 1280, height: 800 }))
  assert.ok(!isPageSize({ width: 0, height: 800 }))
  assert.ok(!isPageSize({ width: 1280.5, height: 800 }))
  assert.ok(!isPageSize({ width: 99999, height: 800 }))
  assert.ok(isRect({ x: -5, y: 0, width: 10, height: 0 }))
  assert.ok(!isRect({ x: 0, y: 0, width: -1, height: 10 }))
  assert.ok(!isRect({ x: Number.NaN, y: 0, width: 1, height: 1 }))
  assert.ok(isCoreDebuggerMethod('Emulation.setDeviceMetricsOverride'))
  assert.ok(isCoreDebuggerMethod('Emulation.setFocusEmulationEnabled'))
  assert.ok(!isCoreDebuggerMethod('Page.captureScreenshot'))
  assert.deepEqual(metricsOverride(PAGE, 0.5), { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false, scale: 0.5 })
})
