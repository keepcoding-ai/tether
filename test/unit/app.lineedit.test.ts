// macOS line-editing keys: each combo maps to one readline sequence; everything else (accents, plain keys,
// other platforms) passes through untouched.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { lineEditSequence, type KeyLike } from '../../app/renderer/lineedit.ts'

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({ key: k, code: k, metaKey: false, altKey: false, ctrlKey: false, shiftKey: false, ...mods })

describe('lineEditSequence (macOS)', () => {
  test('Shift+Enter: ESC CR (newline without submit)', () => assert.equal(lineEditSequence(key('Enter', { shiftKey: true }), true), '\x1b\r'))
  test('plain Enter is left to xterm', () => assert.equal(lineEditSequence(key('Enter'), true), undefined))
  test('Cmd+Left/Right: start/end of line', () => {
    assert.equal(lineEditSequence(key('ArrowLeft', { metaKey: true }), true), '\x01')
    assert.equal(lineEditSequence(key('ArrowRight', { metaKey: true }), true), '\x05')
  })
  test('Option+Left/Right: previous/next word', () => {
    assert.equal(lineEditSequence(key('ArrowLeft', { altKey: true }), true), '\x1bb')
    assert.equal(lineEditSequence(key('ArrowRight', { altKey: true }), true), '\x1bf')
  })
  test('Cmd+Backspace: kill line; Option+Backspace: kill word', () => {
    assert.equal(lineEditSequence(key('Backspace', { metaKey: true }), true), '\x15')
    assert.equal(lineEditSequence(key('Backspace', { altKey: true }), true), '\x17')
  })
  test('Option+letter (accent composition) and plain arrows pass through', () => {
    assert.equal(lineEditSequence(key('´', { altKey: true }), true), undefined)
    assert.equal(lineEditSequence(key('e', { altKey: true }), true), undefined)
    assert.equal(lineEditSequence(key('ArrowLeft'), true), undefined)
  })
  test('Cmd+Option or Ctrl combos and Shift selection are not remapped', () => {
    assert.equal(lineEditSequence(key('ArrowLeft', { metaKey: true, altKey: true }), true), undefined)
    assert.equal(lineEditSequence(key('ArrowLeft', { metaKey: true, ctrlKey: true }), true), undefined)
    assert.equal(lineEditSequence(key('ArrowLeft', { metaKey: true, shiftKey: true }), true), undefined)
  })
  test('off macOS nothing is remapped', () => {
    assert.equal(lineEditSequence(key('Enter', { shiftKey: true }), false), undefined)
    assert.equal(lineEditSequence(key('ArrowLeft', { metaKey: true }), false), undefined)
  })
})
