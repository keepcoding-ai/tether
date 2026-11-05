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

test('ui settings: wordWrap and deskLine are read independently and round-trip', () => {
  assert.deepEqual(normalizeUi({ wordWrap: false }), { deskLine: true, wordWrap: false })
  assert.deepEqual(normalizeUi({ deskLine: false, wordWrap: true }), { deskLine: false, wordWrap: true })
  const saved = JSON.parse(JSON.stringify(normalizeUi({ wordWrap: false })))
  assert.deepEqual(normalizeUi(saved), { deskLine: true, wordWrap: false })
})
