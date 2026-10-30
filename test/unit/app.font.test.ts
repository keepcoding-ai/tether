// The terminal font size shared by the app's main process and renderer: tolerant parsing and the stepping.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_FONT_SIZE, MAX_FONT_SIZE, MIN_FONT_SIZE, normalizeFontSize, stepFontSize } from '../../app/shared/font.ts'

test('normalizeFontSize: whole numbers inside the bounds pass; anything else is the default', () => {
  assert.equal(normalizeFontSize(13), 13)
  assert.equal(normalizeFontSize(MIN_FONT_SIZE), MIN_FONT_SIZE)
  assert.equal(normalizeFontSize(MAX_FONT_SIZE), MAX_FONT_SIZE)
  assert.equal(normalizeFontSize(undefined), DEFAULT_FONT_SIZE)
  assert.equal(normalizeFontSize('14'), DEFAULT_FONT_SIZE)
  assert.equal(normalizeFontSize(13.5), DEFAULT_FONT_SIZE)
  assert.equal(normalizeFontSize(MIN_FONT_SIZE - 1), DEFAULT_FONT_SIZE)
  assert.equal(normalizeFontSize(MAX_FONT_SIZE + 1), DEFAULT_FONT_SIZE)
  assert.equal(normalizeFontSize(NaN), DEFAULT_FONT_SIZE)
})

test('stepFontSize: one step at a time, stuck on the bounds, reset goes back to the default', () => {
  assert.equal(stepFontSize(13, 'increase'), 14)
  assert.equal(stepFontSize(13, 'decrease'), 12)
  assert.equal(stepFontSize(MAX_FONT_SIZE, 'increase'), MAX_FONT_SIZE)
  assert.equal(stepFontSize(MIN_FONT_SIZE, 'decrease'), MIN_FONT_SIZE)
  assert.equal(stepFontSize(20, 'reset'), DEFAULT_FONT_SIZE)
  // a corrupt current size steps from the default
  assert.equal(stepFontSize(999, 'increase'), DEFAULT_FONT_SIZE + 1)
})
