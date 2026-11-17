import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_UI, normalizeUi } from '../../app/shared/ui-settings.ts'

test('ui settings: malformed reads as the defaults; word wrap is no longer a core preference (the note extension owns it)', () => {
  assert.equal(normalizeUi(null).deskLine, true)
  assert.ok(!('wordWrap' in normalizeUi({ wordWrap: false })), 'ui.wordWrap is dropped (migrated to extensions.note.wordWrap)')
})

test('ui settings: the signal modes default to line on, folder border off, dim off', () => {
  assert.deepEqual(DEFAULT_UI, { deskLine: true, tabBorder: false, dimUnfocused: false, dimLevel: 'medium', fixedDeskLabel: 'iconName', tabClose: true, padsFollowFocus: false })
  for (const raw of [undefined, null, {}, 'x', { tabBorder: 1, dimUnfocused: 'on' }]) {
    const ui = normalizeUi(raw)
    assert.equal(ui.deskLine, true)
    assert.equal(ui.tabBorder, false)
    assert.equal(ui.dimUnfocused, false)
  }
})

test('ui settings: every flag is read independently and round-trips', () => {
  assert.deepEqual(normalizeUi({ deskLine: false }), { deskLine: false, tabBorder: false, dimUnfocused: false, dimLevel: 'medium', fixedDeskLabel: 'iconName', tabClose: true, padsFollowFocus: false })
  assert.deepEqual(normalizeUi({ tabBorder: true }), { deskLine: true, tabBorder: true, dimUnfocused: false, dimLevel: 'medium', fixedDeskLabel: 'iconName', tabClose: true, padsFollowFocus: false })
  assert.deepEqual(normalizeUi({ dimUnfocused: true, dimLevel: 'medium' }), { deskLine: true, tabBorder: false, dimUnfocused: true, dimLevel: 'medium', fixedDeskLabel: 'iconName', tabClose: true, padsFollowFocus: false })
  const all = { deskLine: false, tabBorder: true, dimUnfocused: true, dimLevel: 'strong', fixedDeskLabel: 'icon', tabClose: true, padsFollowFocus: true }
  assert.deepEqual(normalizeUi(JSON.parse(JSON.stringify(all))), all)
})

test('ui settings: tabClose defaults to true, reads false, and a malformed value falls back to the default', () => {
  assert.equal(DEFAULT_UI.tabClose, true)
  assert.deepEqual(normalizeUi({ tabClose: false }), { ...DEFAULT_UI, tabClose: false })
  for (const bad of ['no', 0, null, {}]) assert.equal(normalizeUi({ tabClose: bad }).tabClose, true)
})

test('ui settings: the dim level defaults to medium, migrates an old "on" to medium, and rejects unknown values', () => {
  assert.equal(DEFAULT_UI.dimLevel, 'medium')
  assert.deepEqual(normalizeUi({ dimUnfocused: true }), { deskLine: true, tabBorder: false, dimUnfocused: true, dimLevel: 'medium', fixedDeskLabel: 'iconName', tabClose: true, padsFollowFocus: false })
  for (const l of ['weak', 'medium', 'strong'] as const) assert.equal(normalizeUi({ dimUnfocused: true, dimLevel: l }).dimLevel, l)
  for (const bad of ['fraco', 3, null, {}, 'STRONG']) assert.equal(normalizeUi({ dimLevel: bad }).dimLevel, 'medium')
})

test('ui settings: padsFollowFocus defaults to false (side bars keep today\'s behaviour), reads true, and a malformed value falls back', () => {
  assert.equal(DEFAULT_UI.padsFollowFocus, false)
  assert.equal(normalizeUi({ padsFollowFocus: true }).padsFollowFocus, true)
  for (const bad of ['yes', 1, null]) assert.equal(normalizeUi({ padsFollowFocus: bad }).padsFollowFocus, false)
})
