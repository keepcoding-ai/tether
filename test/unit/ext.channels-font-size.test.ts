// The channels' font size setting: declared by the manifest (so the settings page lists it) and the CSS fallback is the same default.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { FONT_SIZE_DEFAULT, manifest } from '../../extensions/channels/manifest.ts'

test('channels font size: declared as an integer setting with sane bounds and the old size as default', () => {
  const s = manifest.contributes?.settings?.fontSize
  assert.ok(s && s.type === 'integer')
  assert.equal(s.default, FONT_SIZE_DEFAULT)
  assert.ok(s.min !== undefined && s.max !== undefined && s.min <= FONT_SIZE_DEFAULT && FONT_SIZE_DEFAULT <= s.max)
  assert.equal(s.title, 'Tamanho da fonte do chat')
})

test('channels font size: every var(--channels-font-size) in the CSS falls back to the default size', () => {
  const css = readFileSync(new URL('../../extensions/channels/renderer/channels.css', import.meta.url), 'utf8')
  const uses = css.match(/var\(--channels-font-size[^)]*\)/g) ?? []
  assert.ok(uses.length >= 2)
  for (const u of uses) assert.equal(u, `var(--channels-font-size, ${FONT_SIZE_DEFAULT}px)`)
})
