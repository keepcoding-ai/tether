import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_UI, normalizeUi } from '../../app/shared/ui-settings.ts'

test('ui settings: malformed reads as the defaults; word wrap is no longer a core preference (the note extension owns it)', () => {
  assert.equal(normalizeUi(null).deskLine, true)
  assert.ok(!('wordWrap' in normalizeUi({ wordWrap: false })), 'ui.wordWrap is dropped (migrated to extensions.note.wordWrap)')
})

test('ui settings: the signal modes default to line on, folder border off, dim off', () => {
  assert.deepEqual(DEFAULT_UI, { deskLine: true, tabBorder: false, dimUnfocused: false })
  for (const raw of [undefined, null, {}, 'x', { tabBorder: 1, dimUnfocused: 'on' }]) {
    const ui = normalizeUi(raw)
    assert.equal(ui.deskLine, true)
    assert.equal(ui.tabBorder, false)
    assert.equal(ui.dimUnfocused, false)
  }
})

test('ui settings: every flag is read independently and round-trips', () => {
  assert.deepEqual(normalizeUi({ deskLine: false }), { deskLine: false, tabBorder: false, dimUnfocused: false })
  assert.deepEqual(normalizeUi({ tabBorder: true }), { deskLine: true, tabBorder: true, dimUnfocused: false })
  assert.deepEqual(normalizeUi({ dimUnfocused: true }), { deskLine: true, tabBorder: false, dimUnfocused: true })
  const all = { deskLine: false, tabBorder: true, dimUnfocused: true }
  assert.deepEqual(normalizeUi(JSON.parse(JSON.stringify(all))), all)
})
