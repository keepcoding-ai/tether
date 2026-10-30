// The clipboard keys of a pane (app/renderer/shortcuts.ts PANE_SHORTCUTS) and the OSC 52 decoder
// (app/renderer/clipboard.ts): what a chord means with and without a selection, Ctrl vs Ctrl+Shift, keydown
// only; and what text an OSC 52 payload sets.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeOsc52 } from '../../app/renderer/clipboard.ts'
import { PANE_SHORTCUTS, paneShortcutHint, paneShortcutOf, SHORTCUTS, chordLabel, type Chord } from '../../app/renderer/shortcuts.ts'

type Mods = { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean }
const key = (code: string, m: Mods = {}, type = 'keydown') =>
  ({ type, code, ctrlKey: !!m.ctrl, shiftKey: !!m.shift, altKey: !!m.alt, metaKey: !!m.meta })

describe('pane clipboard keys', () => {
  test('Ctrl+C copies only with a selection; without one it is the terminal\'s ^C', () => {
    assert.equal(paneShortcutOf(key('KeyC', { ctrl: true }), true), 'copy')
    assert.equal(paneShortcutOf(key('KeyC', { ctrl: true }), false), undefined)
  })

  test('Ctrl+Shift+C copies with a selection and is never the terminal\'s, even without one', () => {
    assert.equal(paneShortcutOf(key('KeyC', { ctrl: true, shift: true }), true), 'copy')
    assert.equal(paneShortcutOf(key('KeyC', { ctrl: true, shift: true }), false), 'copy')
  })

  test('Ctrl+V pastes text or falls back to the raw ^V; Ctrl+Shift+V pastes text only', () => {
    assert.equal(paneShortcutOf(key('KeyV', { ctrl: true }), false), 'paste-or-raw')
    assert.equal(paneShortcutOf(key('KeyV', { ctrl: true }), true), 'paste-or-raw')
    assert.equal(paneShortcutOf(key('KeyV', { ctrl: true, shift: true }), false), 'paste')
  })

  test('only keydown decides: keypress and keyup of the same chord are not commands', () => {
    assert.equal(paneShortcutOf(key('KeyC', { ctrl: true }, 'keypress'), true), undefined)
    assert.equal(paneShortcutOf(key('KeyC', { ctrl: true }, 'keyup'), true), undefined)
    assert.equal(paneShortcutOf(key('KeyV', { ctrl: true }, 'keyup'), false), undefined)
  })

  test('other keys stay with the terminal: plain C/V, Alt and Win chords, Ctrl+Alt (AltGr on ABNT2)', () => {
    assert.equal(paneShortcutOf(key('KeyC'), true), undefined)
    assert.equal(paneShortcutOf(key('KeyV', { shift: true }), true), undefined)
    assert.equal(paneShortcutOf(key('KeyC', { ctrl: true, alt: true }), true), undefined)
    assert.equal(paneShortcutOf(key('KeyV', { ctrl: true, meta: true }), false), undefined)
    assert.equal(paneShortcutOf(key('KeyX', { ctrl: true }), true), undefined)
  })

  test('hints read as the user sees the keys, and no pane chord collides with an app chord', () => {
    assert.equal(paneShortcutHint('copy'), 'Ctrl+C')
    assert.equal(paneShortcutHint('paste-or-raw'), 'Ctrl+V')
    assert.equal(paneShortcutHint('paste'), 'Ctrl+Shift+V')
    const keyOf = (c: Chord): string => `${c.ctrl ? 'C' : ''}${c.alt ? 'A' : ''}${c.shift ? 'S' : ''}+${c.code}`
    const app = new Set(SHORTCUTS.map(s => keyOf(s.chord)))
    const seen = new Set<string>()
    for (const { chord } of PANE_SHORTCUTS) {
      assert.ok(!app.has(keyOf(chord)), `pane chord is also an app chord: ${chordLabel(chord)}`)
      assert.ok(!seen.has(keyOf(chord)), `pane chord bound twice: ${chordLabel(chord)}`)
      seen.add(keyOf(chord))
    }
  })
})

describe('OSC 52 decoder', () => {
  const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')

  test('Pc;Pd sets the decoded text, any selection name and UTF-8 included', () => {
    assert.equal(decodeOsc52(`c;${b64('hello')}`), 'hello')
    assert.equal(decodeOsc52(`;${b64('sem seleção')}`), 'sem seleção')
    assert.equal(decodeOsc52(`ps;${b64('ação ✻ 日本')}`), 'ação ✻ 日本')
    assert.equal(decodeOsc52(`c;${b64('a\nb\r\n')}`), 'a\nb\r\n')
  })

  test('a query, an empty payload and bad base64 set nothing', () => {
    assert.equal(decodeOsc52('c;?'), undefined)
    assert.equal(decodeOsc52('c;'), undefined)
    assert.equal(decodeOsc52(''), undefined)
    assert.equal(decodeOsc52('c;not base64!'), undefined)
    assert.equal(decodeOsc52('c;/w=='), undefined, 'invalid UTF-8 is refused')
  })
})
