// The shortcut registry (app/renderer/shortcuts.ts): one table, no chord bound twice, every command with a hint
// the menus can show, and a hint that reads the way the user sees the keys.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { chordLabel, chordOn, SHORTCUTS, shortcutHint, shortcutOf, type Chord } from '../../app/renderer/shortcuts.ts'

const keyOf = (c: Chord): string => `${c.ctrl ? 'C' : ''}${c.alt ? 'A' : ''}${c.shift ? 'S' : ''}${c.meta ? 'M' : ''}+${c.code}`

describe('shortcut registry', () => {
  for (const mac of [false, true]) {
    const platform = mac ? 'macOS' : 'Windows/Linux'
    test(`${platform}: no chord is bound twice`, () => {
      const seen = new Set<string>()
      for (const entry of SHORTCUTS) {
        const chord = chordOn(entry, mac)
        if (!chord) continue
        assert.ok(!seen.has(keyOf(chord)), `chord bound twice: ${chordLabel(chord, mac)}`)
        seen.add(keyOf(chord))
      }
    })

    test(`${platform}: every entry maps back to its own command through shortcutOf`, () => {
      for (const entry of SHORTCUTS) {
        const chord = chordOn(entry, mac)
        if (!chord) continue
        const ev = { ctrlKey: !!chord.ctrl, altKey: !!chord.alt, shiftKey: !!chord.shift, metaKey: !!chord.meta, code: chord.code }
        assert.deepEqual(shortcutOf(ev, mac), entry.command, chordLabel(chord, mac))
        if (!mac) assert.equal(shortcutOf({ ...ev, metaKey: true }, mac), undefined, 'Win never joins a chord')
      }
    })
  }

  test('Mac: app chords on Cmd, Ctrl+Tab and Ctrl+` kept literal (Cmd+Tab / Cmd+` are the OS\'s)', () => {
    const ev = (code: string, m: { meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean } = {}) =>
      ({ code, metaKey: !!m.meta, ctrlKey: !!m.ctrl, shiftKey: !!m.shift, altKey: !!m.alt })
    assert.deepEqual(shortcutOf(ev('KeyT', { meta: true }), true), { op: 'choose' })
    assert.deepEqual(shortcutOf(ev('KeyD', { meta: true }), true), { op: 'duplicate', level: 'pane', direction: 'right' })
    assert.deepEqual(shortcutOf(ev('Tab', { ctrl: true }), true), { op: 'desk-cycle', step: 1 })
    assert.equal(shortcutOf(ev('Tab', { meta: true }), true), undefined)
    assert.deepEqual(shortcutOf(ev('Backquote', { ctrl: true }), true), { op: 'drawer-toggle' })
    assert.deepEqual(shortcutOf(ev('Digit2', { meta: true }), true), { op: 'desk-go', position: 2 })
    assert.equal(shortcutOf(ev('KeyT', { ctrl: true, shift: true }), true), undefined, 'Ctrl stays the terminal\'s')
    assert.deepEqual(shortcutOf(ev('Equal', { meta: true }), true), { op: 'font-size', command: 'increase' })
    assert.deepEqual(shortcutOf(ev('Equal', { meta: true, shift: true }), true), { op: 'font-size', command: 'increase' })
    assert.equal(shortcutHint({ op: 'choose' }, true), '⌘T')
    assert.equal(shortcutHint({ op: 'duplicate', level: 'frame', direction: 'below' }, true), '⌥⇧⌘↓')
    assert.equal(shortcutHint({ op: 'drawer-toggle' }, true), '⌃`')
  })

  test('font size off the Mac: Ctrl+Shift+= / - / 0; Ctrl+= and Ctrl+0 stay the terminal\'s', () => {
    const ev = (code: string, shift: boolean) => ({ code, ctrlKey: true, shiftKey: shift, altKey: false, metaKey: false })
    assert.deepEqual(shortcutOf(ev('Equal', true), false), { op: 'font-size', command: 'increase' })
    assert.deepEqual(shortcutOf(ev('Minus', true), false), { op: 'font-size', command: 'decrease' })
    assert.deepEqual(shortcutOf(ev('Digit0', true), false), { op: 'font-size', command: 'reset' })
    assert.equal(shortcutOf(ev('Equal', false), false), undefined)
    assert.equal(shortcutOf(ev('Digit0', false), false), undefined)
    assert.equal(shortcutHint({ op: 'font-size', command: 'increase' }, false), 'Ctrl+Shift+=')
  })

  test('hints: the three levels and the chooser, as the user reads them', () => {
    assert.equal(shortcutHint({ op: 'choose' }), 'Ctrl+Shift+T')
    assert.equal(shortcutHint({ op: 'duplicate', level: 'pane', direction: 'right' }), 'Ctrl+Alt+→')
    assert.equal(shortcutHint({ op: 'duplicate', level: 'frame', direction: 'below' }), 'Ctrl+Alt+Shift+↓')
    assert.equal(shortcutHint({ op: 'duplicate', level: 'desk', direction: 'left' }), 'Alt+Shift+←')
    assert.equal(shortcutHint({ op: 'quit-all' }), 'Ctrl+Shift+Q')
    assert.equal(chordLabel({ ctrl: true, code: 'Digit1' }), 'Ctrl+1')
  })
})
