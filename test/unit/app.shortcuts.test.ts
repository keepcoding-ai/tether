// The shortcut registry (app/renderer/shortcuts.ts): one table, no chord bound twice, every command with a hint
// the menus can show, and a hint that reads the way the user sees the keys.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { chordLabel, SHORTCUTS, shortcutHint, shortcutOf, type Chord } from '../../app/renderer/shortcuts.ts'

const keyOf = (c: Chord): string => `${c.ctrl ? 'C' : ''}${c.alt ? 'A' : ''}${c.shift ? 'S' : ''}+${c.code}`

describe('shortcut registry', () => {
  test('no chord is bound twice', () => {
    const seen = new Set<string>()
    for (const { chord } of SHORTCUTS) {
      assert.ok(!seen.has(keyOf(chord)), `chord bound twice: ${chordLabel(chord)}`)
      seen.add(keyOf(chord))
    }
  })

  test('every entry maps back to its own command through shortcutOf', () => {
    for (const { chord, command } of SHORTCUTS) {
      const ev = { ctrlKey: !!chord.ctrl, altKey: !!chord.alt, shiftKey: !!chord.shift, metaKey: false, code: chord.code }
      assert.deepEqual(shortcutOf(ev), command, chordLabel(chord))
      assert.equal(shortcutOf({ ...ev, metaKey: true }), undefined, 'Win never joins a chord')
    }
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
