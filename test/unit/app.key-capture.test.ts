// Who gets a key pressed inside a terminal or a note (app/renderer/key-capture.ts): the table's scopes decide. A plain
// Ctrl+letter is the terminal's unless listed in TERMINAL_CAPTURE (P, N, K); every other app chord is the app's; the
// clipboard chords are untouched; inside a note the arrow chords stay the editor's.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { editorKeyOwner, isPlainCtrlLetter, TERMINAL_CAPTURE, terminalKeyOwner } from '../../app/renderer/key-capture.ts'
import { chordLabel, keysLabel, paneShortcutOf, resolvedDefaults, shortcutOf, type KeyLike } from '../../app/renderer/shortcuts.ts'
import { withNoteKeybindings } from './note-extension.ts'

// The note's keys come from its extension (extensions/note/manifest.ts), contributed as at the app's startup.
withNoteKeybindings()

const key = (code: string, m: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {}): KeyLike =>
  ({ code, ctrlKey: !!m.ctrl, shiftKey: !!m.shift, altKey: !!m.alt, metaKey: !!m.meta })

describe('terminal key capture', () => {
  test('Ctrl+Shift+P, Ctrl+P, Ctrl+N and the prefix Ctrl+K are the app\'s inside a terminal too', () => {
    assert.deepEqual(terminalKeyOwner(key('KeyP', { ctrl: true, shift: true }), false), { owner: 'app', command: 'palette.show' })
    assert.deepEqual(terminalKeyOwner(key('KeyP', { ctrl: true }), false), { owner: 'app', command: 'palette.quick-open' })
    assert.deepEqual(terminalKeyOwner(key('KeyN', { ctrl: true }), false), { owner: 'app', command: 'pane.new-tab' })
    assert.deepEqual(terminalKeyOwner(key('KeyK', { ctrl: true }), false), { owner: 'app', prefix: true })
    assert.deepEqual(TERMINAL_CAPTURE.map(c => c.code), ['KeyP', 'KeyN', 'KeyK'], 'the explicit list of plain Ctrl+letter chords the app takes')
  })

  test('every other Ctrl+letter reaches the terminal (^A…^Z, ^C, ^D, ^L, ^R, ^W, ^O, ^S, ^Z…)', () => {
    for (const letter of 'ABCDEFGHIJLMOQRSTUVWXYZ') {
      assert.deepEqual(terminalKeyOwner(key(`Key${letter}`, { ctrl: true }), false), { owner: 'terminal' }, `Ctrl+${letter}`)
    }
    assert.ok(isPlainCtrlLetter(key('KeyA', { ctrl: true })))
    assert.ok(!isPlainCtrlLetter(key('KeyA', { ctrl: true, shift: true })))
    assert.ok(!isPlainCtrlLetter(key('Digit1', { ctrl: true })))
  })

  test('the app chords of the table keep working from a terminal: Ctrl+Shift+T, Ctrl+Tab, Ctrl+1, Ctrl+`, Ctrl+Alt+→, Ctrl+F4, F2, Ctrl+\\, Ctrl+=', () => {
    assert.equal(terminalKeyOwner(key('KeyT', { ctrl: true, shift: true }), false).owner, 'app')
    assert.equal(terminalKeyOwner(key('Tab', { ctrl: true }), false).owner, 'app')
    assert.equal(terminalKeyOwner(key('Digit1', { ctrl: true }), false).owner, 'app')
    assert.equal(terminalKeyOwner(key('Backquote', { ctrl: true }), false).owner, 'app')
    assert.equal(terminalKeyOwner(key('ArrowRight', { ctrl: true, alt: true }), false).owner, 'app')
    assert.equal(terminalKeyOwner(key('F4', { ctrl: true }), false).owner, 'app')
    assert.equal(terminalKeyOwner(key('F2'), false).owner, 'app')
    assert.equal(terminalKeyOwner(key('Backslash', { ctrl: true }), false).owner, 'app')
    assert.equal(terminalKeyOwner(key('Equal', { ctrl: true }), false).owner, 'app')
    assert.equal(terminalKeyOwner(key('KeyT', { ctrl: true }), false).owner, 'terminal', 'Ctrl+T alone is not a chord')
    assert.equal(terminalKeyOwner(key('KeyW', { ctrl: true }), false).owner, 'terminal', 'Ctrl+W erases a word in the shell')
    assert.equal(terminalKeyOwner(key('KeyO', { ctrl: true }), false).owner, 'terminal', 'Ctrl+O is Claude Code\'s')
    assert.equal(terminalKeyOwner(key('KeyV', { ctrl: true, shift: true }), false).owner, 'terminal', 'Ctrl+Shift+V pastes (the preview is note-only)')
  })

  test('the table binds no plain Ctrl+letter in the terminal scope outside TERMINAL_CAPTURE (adding one means listing it there, on purpose)', () => {
    const allowed = new Set(TERMINAL_CAPTURE.map(c => c.code))
    for (const b of resolvedDefaults(false)) {
      const first = b.keys[0]!
      const ev = key(first.code, { ctrl: first.ctrl, shift: first.shift, alt: first.alt, meta: first.meta })
      if (isPlainCtrlLetter(ev) && b.where.includes('terminal')) assert.ok(allowed.has(first.code), `${keysLabel(b.keys, false)} (${b.command}) is the app's in a terminal but not in TERMINAL_CAPTURE`)
    }
    assert.equal(chordLabel({ ctrl: true, code: 'KeyK' }, false), 'Ctrl+K')
  })

  test('Ctrl+C copies with a selection and interrupts without one; Ctrl+V pastes: untouched by the policy', () => {
    assert.equal(paneShortcutOf({ ...key('KeyC', { ctrl: true }), type: 'keydown' }, true, false), 'copy')
    assert.equal(paneShortcutOf({ ...key('KeyC', { ctrl: true }), type: 'keydown' }, false, false), undefined)
    assert.equal(terminalKeyOwner(key('KeyC', { ctrl: true }), false).owner, 'terminal')
    assert.equal(paneShortcutOf({ ...key('KeyV', { ctrl: true }), type: 'keydown' }, false, false), 'paste-or-raw')
    assert.equal(shortcutOf(key('KeyC', { ctrl: true }), false), undefined)
  })

  test('inside a note: arrow chords are the editor\'s; Ctrl+W closes, Ctrl+S saves, Ctrl+Shift+V previews, Ctrl+K is the prefix; Ctrl+D (multi-cursor) is the editor\'s', () => {
    assert.deepEqual(editorKeyOwner(key('ArrowDown', { ctrl: true, alt: true }), false), { owner: 'editor' })
    assert.deepEqual(editorKeyOwner(key('ArrowRight', { ctrl: true, shift: true }), false), { owner: 'editor' })
    assert.deepEqual(editorKeyOwner(key('KeyW', { ctrl: true }), false), { owner: 'app', command: 'pane.close' })
    assert.deepEqual(editorKeyOwner(key('KeyS', { ctrl: true }), false), { owner: 'app', command: 'note.save' })
    assert.deepEqual(editorKeyOwner(key('KeyV', { ctrl: true, shift: true }), false), { owner: 'app', command: 'markdown.preview' })
    assert.deepEqual(editorKeyOwner(key('KeyK', { ctrl: true }), false), { owner: 'app', prefix: true })
    assert.deepEqual(editorKeyOwner(key('KeyD', { ctrl: true }), false), { owner: 'editor' })
    assert.deepEqual(editorKeyOwner(key('KeyT', { ctrl: true, shift: true }), false), { owner: 'app', command: 'pane.reopen-closed' })
  })

  test('Mac: Cmd+Shift+P / Cmd+P are the app\'s; a literal Ctrl+P stays the terminal\'s', () => {
    assert.deepEqual(terminalKeyOwner(key('KeyP', { meta: true, shift: true }), true), { owner: 'app', command: 'palette.show' })
    assert.deepEqual(terminalKeyOwner(key('KeyP', { meta: true }), true), { owner: 'app', command: 'palette.quick-open' })
    assert.deepEqual(terminalKeyOwner(key('KeyP', { ctrl: true }), true), { owner: 'terminal' })
  })
})
