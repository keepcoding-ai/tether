import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_UI, normalizeUi } from '../../app/shared/ui-settings.ts'

test('ui settings: wordWrap defaults to on when unset or malformed', () => {
  assert.equal(DEFAULT_UI.wordWrap, true)
  assert.equal(normalizeUi(undefined).wordWrap, true)
  assert.equal(normalizeUi({}).wordWrap, true)
  assert.equal(normalizeUi({ wordWrap: 'off' }).wordWrap, true)
  assert.equal(normalizeUi(null).deskLine, true)
})

test('ui settings: the signal modes default to line on, folder border off, dim off', () => {
  assert.deepEqual(DEFAULT_UI, { deskLine: true, tabBorder: false, dimUnfocused: false, wordWrap: true })
  for (const raw of [undefined, null, {}, 'x', { tabBorder: 1, dimUnfocused: 'on' }]) {
    const ui = normalizeUi(raw)
    assert.equal(ui.deskLine, true)
    assert.equal(ui.tabBorder, false)
    assert.equal(ui.dimUnfocused, false)
  }
})

test('ui settings: every flag is read independently and round-trips', () => {
  assert.deepEqual(normalizeUi({ wordWrap: false }), { deskLine: true, tabBorder: false, dimUnfocused: false, wordWrap: false })
  assert.deepEqual(normalizeUi({ deskLine: false, wordWrap: true }), { deskLine: false, tabBorder: false, dimUnfocused: false, wordWrap: true })
  assert.deepEqual(normalizeUi({ tabBorder: true }), { deskLine: true, tabBorder: true, dimUnfocused: false, wordWrap: true })
  assert.deepEqual(normalizeUi({ dimUnfocused: true }), { deskLine: true, tabBorder: false, dimUnfocused: true, wordWrap: true })
  const all = { deskLine: false, tabBorder: true, dimUnfocused: true, wordWrap: false }
  assert.deepEqual(normalizeUi(JSON.parse(JSON.stringify(all))), all)
})
