// The theme setting shared by the app's main process and renderer: tolerant parsing and the auto resolution.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeTheme, resolveScheme, WINDOW_BACKGROUND } from '../../app/shared/theme.ts'

test('normalizeTheme: the three settings pass; anything else (missing/corrupt settings.json) is auto', () => {
  assert.equal(normalizeTheme('light'), 'light')
  assert.equal(normalizeTheme('dark'), 'dark')
  assert.equal(normalizeTheme('auto'), 'auto')
  assert.equal(normalizeTheme(undefined), 'auto')
  assert.equal(normalizeTheme('system'), 'auto')
  assert.equal(normalizeTheme(42), 'auto')
  assert.equal(normalizeTheme({ theme: 'dark' }), 'auto')
})

test('resolveScheme: auto follows the OS, fixed settings ignore it', () => {
  assert.equal(resolveScheme('auto', true), 'dark')
  assert.equal(resolveScheme('auto', false), 'light')
  assert.equal(resolveScheme('light', true), 'light')
  assert.equal(resolveScheme('dark', false), 'dark')
})

test('window background: one opaque color per scheme (BrowserWindow backgroundColor needs #rrggbb)', () => {
  for (const scheme of ['light', 'dark'] as const) assert.match(WINDOW_BACKGROUND[scheme], /^#[0-9a-f]{6}$/i)
  assert.notEqual(WINDOW_BACKGROUND.light, WINDOW_BACKGROUND.dark)
})
