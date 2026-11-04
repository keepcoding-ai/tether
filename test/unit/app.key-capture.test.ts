// Who gets a key pressed inside a terminal (app/renderer/key-capture.ts): plain Ctrl+letter is the terminal's unless
// listed in TERMINAL_CAPTURE; every other app chord is the app's; the clipboard chords are untouched.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { isPlainCtrlLetter, TERMINAL_CAPTURE, terminalKeyOwner } from '../../app/renderer/key-capture.ts'
import { chordLabel, chordOn, paneShortcutOf, SHORTCUTS, shortcutOf, type KeyLike } from '../../app/renderer/shortcuts.ts'

const key = (code: string, m: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {}): KeyLike =>
  ({ code, ctrlKey: !!m.ctrl, shiftKey: !!m.shift, altKey: !!m.alt, metaKey: !!m.meta })

describe('terminal key capture', () => {
  test('Ctrl+Shift+P and Ctrl+P are the app\'s (palette, quick open), inside a terminal too', () => {
    assert.deepEqual(terminalKeyOwner(key('KeyP', { ctrl: true, shift: true }), false), { owner: 'app', shortcut: { op: 'palette' } })
    assert.deepEqual(terminalKeyOwner(key('KeyP', { ctrl: true }), false), { owner: 'app', shortcut: { op: 'quick-open' } })
    assert.deepEqual(TERMINAL_CAPTURE.map(c => c.code), ['KeyP'], 'the explicit list of plain Ctrl+letter chords the app takes')
  })

  test('every other Ctrl+letter reaches the terminal (^A…^Z, ^C, ^D, ^K, ^L, ^R, ^Z…)', () => {
    for (const letter of 'ABCDEFGHIJKLMNOQRSTUVWXYZ') {
      assert.deepEqual(terminalKeyOwner(key(`Key${letter}`, { ctrl: true }), false), { owner: 'terminal' }, `Ctrl+${letter}`)
    }
    assert.ok(isPlainCtrlLetter(key('KeyA', { ctrl: true })))
    assert.ok(!isPlainCtrlLetter(key('KeyA', { ctrl: true, shift: true })))
    assert.ok(!isPlainCtrlLetter(key('Digit1', { ctrl: true })))
  })

  test('the app chords of the table keep working from a terminal: Ctrl+Shift+T, Ctrl+Tab, Ctrl+1, Ctrl+`, Ctrl+Alt+→', () => {
    assert.equal(terminalKeyOwner(key('KeyT', { ctrl: true, shift: true }), false).owner, 'app')
    assert.equal(terminalKeyOwner(key('Tab', { ctrl: true }), false).owner, 'app')
    assert.equal(terminalKeyOwner(key('Digit1', { ctrl: true }), false).owner, 'app')
    assert.equal(terminalKeyOwner(key('Backquote', { ctrl: true }), false).owner, 'app')
    assert.equal(terminalKeyOwner(key('ArrowRight', { ctrl: true, alt: true }), false).owner, 'app')
    assert.equal(terminalKeyOwner(key('KeyT', { ctrl: true }), false).owner, 'terminal', 'Ctrl+T alone is not a chord')
  })

  test('the table binds no plain Ctrl+letter outside TERMINAL_CAPTURE (adding one means listing it there, on purpose)', () => {
    const allowed = new Set(TERMINAL_CAPTURE.map(c => c.code))
    for (const e of SHORTCUTS) {
      const c = chordOn(e, false)
      if (!c) continue
      const ev = key(c.code, { ctrl: c.ctrl, shift: c.shift, alt: c.alt, meta: c.meta })
      if (isPlainCtrlLetter(ev)) assert.ok(allowed.has(c.code), `${chordLabel(c, false)} is bound but not in TERMINAL_CAPTURE`)
    }
  })

  test('Ctrl+C copies with a selection and interrupts without one; Ctrl+V pastes: untouched by the policy', () => {
    assert.equal(paneShortcutOf({ ...key('KeyC', { ctrl: true }), type: 'keydown' }, true, false), 'copy')
    assert.equal(paneShortcutOf({ ...key('KeyC', { ctrl: true }), type: 'keydown' }, false, false), undefined)
    assert.equal(terminalKeyOwner(key('KeyC', { ctrl: true }), false).owner, 'terminal')
    assert.equal(paneShortcutOf({ ...key('KeyV', { ctrl: true }), type: 'keydown' }, false, false), 'paste-or-raw')
    assert.equal(shortcutOf(key('KeyC', { ctrl: true }), false), undefined)
  })

  test('Mac: Cmd+Shift+P / Cmd+P are the app\'s; a literal Ctrl+P stays the terminal\'s', () => {
    assert.deepEqual(terminalKeyOwner(key('KeyP', { meta: true, shift: true }), true), { owner: 'app', shortcut: { op: 'palette' } })
    assert.deepEqual(terminalKeyOwner(key('KeyP', { meta: true }), true), { owner: 'app', shortcut: { op: 'quick-open' } })
    assert.deepEqual(terminalKeyOwner(key('KeyP', { ctrl: true }), true), { owner: 'terminal' })
  })
})
