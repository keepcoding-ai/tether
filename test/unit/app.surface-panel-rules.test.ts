import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cssToWindow, hostVisible, parsePlace, parseRelease, sameRect, windowRectToElement, windowToElement, zoomOf, type HostFacts } from '../../app/shared/surface-panel-rules.ts'

const ON: HostFacts = { connected: true, width: 400, height: 300, displayed: true, cssVisible: true, inert: false }

test('hostVisible: on screen only when attached, laid out, visible and not inert', () => {
  assert.equal(hostVisible(ON), true)
  assert.equal(hostVisible({ ...ON, connected: false }), false, 'removed from the document')
  assert.equal(hostVisible({ ...ON, displayed: false }), false, 'display:none (a background tab)')
  assert.equal(hostVisible({ ...ON, cssVisible: false }), false, 'visibility:hidden (an inactive desk, a closed drawer)')
  assert.equal(hostVisible({ ...ON, inert: true }), false, 'inert ancestor')
  assert.equal(hostVisible({ ...ON, width: 0 }), false)
  assert.equal(hostVisible({ ...ON, height: 0 }), false)
})

test('zoomOf: content width over viewport width, 1 within noise or when unusable', () => {
  assert.equal(zoomOf(1200, 1200), 1)
  assert.equal(zoomOf(1200, 1199.5), 1)
  assert.equal(zoomOf(1500, 1200), 1.25)
  assert.equal(zoomOf(0, 1200), 1)
  assert.equal(zoomOf(1200, 0), 1)
  assert.equal(zoomOf(Number.NaN, 1200), 1)
})

test('cssToWindow and back: a zoomed interface keeps the point in the element', () => {
  const css = { x: 100, y: 40, width: 400, height: 200 }
  const win = cssToWindow(css, 1.25)
  assert.deepEqual(win, { x: 125, y: 50, width: 500, height: 250 })
  assert.deepEqual(windowToElement({ x: 135, y: 70 }, win, 1.25), { x: 8, y: 16 })
  assert.deepEqual(windowRectToElement({ x: 125 + 50, y: 50, width: 400, height: 250 }, win, 1.25), { x: 40, y: 0, width: 320, height: 200 })
})

test('sameRect: tolerance on every side', () => {
  const r = { x: 10, y: 10, width: 100, height: 50 }
  assert.equal(sameRect(r, { ...r, x: 10.4 }), true)
  assert.equal(sameRect(r, { ...r, width: 101 }), false)
  assert.equal(sameRect(undefined, undefined), true)
  assert.equal(sameRect(r, undefined), false)
})

test('parsePlace / parseRelease: only well-formed messages', () => {
  const ok = { owner: 'x', surface: 's', visible: true, viewportWidth: 1200, rect: { x: 1, y: 2, width: 3, height: 4 } }
  assert.deepEqual(parsePlace(ok), ok)
  assert.equal(parsePlace({ ...ok, visible: 'yes' }), undefined)
  assert.equal(parsePlace({ ...ok, rect: { x: 1, y: 2, width: -3, height: 4 } }), undefined)
  assert.equal(parsePlace({ ...ok, rect: { x: Number.NaN, y: 2, width: 3, height: 4 } }), undefined)
  assert.equal(parsePlace({ ...ok, owner: '' }), undefined)
  assert.equal(parsePlace(null), undefined)
  assert.deepEqual(parseRelease({ owner: 'x', surface: 's', extra: 1 }), { owner: 'x', surface: 's' })
  assert.equal(parseRelease({ owner: 'x' }), undefined)
})
