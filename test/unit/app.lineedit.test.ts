// Terminal input chords of the registry (app/renderer/shortcuts.ts TERMINAL_INPUTS): the macOS line-editing keys map
// to one readline sequence each; everything else (accents, plain keys, other platforms) passes through untouched;
// Shift+Enter is ESC CR on the Mac in every pane, elsewhere only in agent panes.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { terminalInputOf, type KeyLike } from '../../app/renderer/shortcuts.ts'

/** A shell pane (no agent-only entries). */
const lineEditSequence = (ev: KeyLike, mac: boolean): string | undefined => terminalInputOf(ev, false, mac)
/** An agent pane off the Mac. */
const agentNewline = (ev: KeyLike): string | undefined => terminalInputOf(ev, true, false)

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({ code: k, metaKey: false, altKey: false, ctrlKey: false, shiftKey: false, ...mods })

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

describe('agentNewline (any platform, agent panes)', () => {
  test('Shift+Enter: ESC CR', () => assert.equal(agentNewline(key('Enter', { shiftKey: true })), '\x1b\r'))
  test('plain Enter and other modifiers are left alone', () => {
    assert.equal(agentNewline(key('Enter')), undefined)
    assert.equal(agentNewline(key('Enter', { shiftKey: true, ctrlKey: true })), undefined)
    assert.equal(agentNewline(key('Enter', { shiftKey: true, altKey: true })), undefined)
    assert.equal(agentNewline(key('a', { shiftKey: true })), undefined)
  })
})

describe('Shift+Enter by pane and platform', () => {
  const shiftEnter = key('Enter', { shiftKey: true })
  test('Mac: every pane', () => {
    assert.equal(terminalInputOf(shiftEnter, false, true), '\x1b\r')
    assert.equal(terminalInputOf(shiftEnter, true, true), '\x1b\r')
  })
  test('Windows/Linux: agent panes only', () => {
    assert.equal(terminalInputOf(shiftEnter, true, false), '\x1b\r')
    assert.equal(terminalInputOf(shiftEnter, false, false), undefined)
  })
})
