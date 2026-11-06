// The key table (app/renderer/shortcuts.ts): the defaults are VS Code's Windows scheme translated (docs/keybindings-preview.html,
// section A, the recommended option of every decision); no key is bound twice in the same scope; every binding resolves back
// to its own command; the key strings of the file format round-trip; hints read the way the user sees the keys.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { chordLabel, defaultWhere, formatKeys, keysLabel, KeyTable, parseKey, parseKeys, PREFIX_COMMAND, resolvedDefaults, sameKeys, shortcutHint, shortcutOf, WHERE_ALL, type Chord, type KeyLike, type Where } from '../../app/renderer/shortcuts.ts'
import { withNoteKeybindings } from './note-extension.ts'
import { withQuickOpenKeybindings } from './quick-open-extension.ts'

// The note's keys come from its extension (extensions/note/manifest.ts), contributed as at the app's startup.
withNoteKeybindings()
withQuickOpenKeybindings()

const ev = (code: string, m: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {}): KeyLike =>
  ({ code, ctrlKey: !!m.ctrl, shiftKey: !!m.shift, altKey: !!m.alt, metaKey: !!m.meta })
const asKey = (c: Chord): KeyLike => ev(c.code, { ctrl: c.ctrl, shift: c.shift, alt: c.alt, meta: c.meta })

describe('the key table', () => {
  for (const mac of [false, true]) {
    const platform = mac ? 'macOS' : 'Windows/Linux'
    const table = new KeyTable(resolvedDefaults(mac))

    test(`${platform}: no key sequence is bound twice in the same scope (a chord prefix may share its first key with nothing)`, () => {
      const seen = new Map<string, { command: string; where: Where[] }>()
      for (const b of table.bindings) {
        if (b.command === PREFIX_COMMAND) continue
        const k = formatKeys(b.keys)
        const other = seen.get(k)
        if (other) assert.ok(!other.where.some(w => b.where.includes(w)), `${keysLabel(b.keys, mac)} bound to ${other.command} and ${b.command} in the same scope`)
        seen.set(k, { command: b.command, where: b.where })
        // A single key never doubles as the first key of a chord in an overlapping scope.
        if (b.keys.length === 1) {
          const chords = table.bindings.filter(c => c.keys.length === 2 && sameKeys([c.keys[0]!], b.keys) && c.where.some(w => b.where.includes(w)))
          assert.deepEqual(chords.map(c => c.command), [], `${keysLabel(b.keys, mac)} is a command and a prefix`)
        }
      }
    })

    test(`${platform}: every binding resolves back to its own command in each of its scopes`, () => {
      for (const b of table.bindings) {
        if (b.command === PREFIX_COMMAND) continue
        for (const where of b.where) {
          const pressed = b.keys.map(asKey)
          const r = table.resolve(pressed, where)
          assert.equal(r.kind, 'command', `${keysLabel(b.keys, mac)} in ${where}`)
          if (r.kind === 'command') assert.equal(r.command, b.command, keysLabel(b.keys, mac))
          if (b.keys.length === 2) assert.equal(table.resolve([pressed[0]!], where).kind, 'prefix', `${chordLabel(b.keys[0]!, mac)} opens the chord in ${where}`)
        }
        for (const where of WHERE_ALL.filter(w => !b.where.includes(w))) {
          const r = table.resolve(b.keys.map(asKey), where)
          assert.ok(r.kind !== 'command' || r.command !== b.command, `${keysLabel(b.keys, mac)} must not be ${b.command}'s in ${where}`)
        }
        if (!mac) assert.equal(table.resolve([{ ...asKey(b.keys[0]!), metaKey: true }], 'window').kind, 'none', 'Win never joins a chord')
      }
    })
  }

  test('the scheme: the recommended keys of the preview (Windows)', () => {
    const t = new KeyTable(resolvedDefaults(false))
    const hint = (id: string): string => t.hint(id, false)
    assert.equal(hint('pane.new-tab'), 'Ctrl+N')
    assert.equal(hint('pane.reopen-closed'), 'Ctrl+Shift+T')
    assert.equal(hint('pane.close'), 'Ctrl+F4')
    assert.deepEqual(t.bindingsOf('pane.close').map(b => [formatKeys(b.keys), b.where.join(',')]), [['ctrl+f4', 'window,terminal,note'], ['ctrl+w', 'window,note']])
    assert.equal(hint('pane.duplicate.pane.right'), 'Ctrl+Alt+→')
    assert.deepEqual(t.bindingsOf('pane.duplicate.pane.right').map(b => formatKeys(b.keys)), ['ctrl+alt+right', 'ctrl+\\'])
    assert.deepEqual(t.bindingsOf('pane.duplicate.pane.below').map(b => formatKeys(b.keys)), ['ctrl+alt+down', 'ctrl+k ctrl+\\'])
    assert.equal(hint('pane.duplicate.frame.below'), 'Ctrl+Alt+Shift+↓')
    assert.equal(hint('pane.duplicate.desk.left'), 'Alt+Shift+←')
    assert.equal(hint('pane.split-empty.pane.right'), 'Ctrl+Shift+→')
    assert.equal(hint('pane.next-tab'), 'Ctrl+PgDn')
    assert.equal(hint('pane.previous-tab'), 'Ctrl+PgUp')
    assert.equal(hint('pane.go.3'), 'Alt+3')
    assert.equal(hint('pane.last'), 'Alt+0')
    assert.equal(hint('pane.rename'), 'F2')
    assert.equal(hint('pane.copy-folder'), 'Ctrl+K P')
    assert.equal(hint('pane.open-folder'), 'Ctrl+K R')
    assert.equal(hint('frame.focus.right'), 'Ctrl+K Ctrl+→')
    assert.equal(hint('frame.close-tabs'), 'Ctrl+K W')
    assert.equal(hint('desk.new'), 'Ctrl+Shift+N')
    assert.equal(hint('desk.new-before'), '', 'Ctrl+Alt+Shift+N is gone')
    assert.equal(hint('desk.next'), 'Ctrl+Tab')
    assert.equal(hint('desk.go.2'), 'Ctrl+2')
    assert.equal(hint('desk.close'), 'Ctrl+K F')
    assert.equal(hint('drawer.toggle'), 'Ctrl+`')
    assert.deepEqual(t.bindingsOf('drawer.toggle').map(b => formatKeys(b.keys)), ['ctrl+`', 'ctrl+shift+g'])
    assert.equal(hint('drawer.quick-terminal'), 'Ctrl+Shift+`')
    assert.equal(hint('note.open'), 'Ctrl+O')
    assert.deepEqual(t.bindingsOf('note.open')[0]!.where, ['window', 'note'], 'Ctrl+O passes in a terminal (Claude Code\'s verbose toggle)')
    assert.deepEqual(t.bindingsOf('note.save')[0]!.where, ['note'])
    assert.equal(hint('note.save-as'), 'Ctrl+Shift+S')
    assert.deepEqual(t.bindingsOf('markdown.preview').map(b => [formatKeys(b.keys), b.where.join(',')]), [['ctrl+shift+v', 'note']])
    assert.deepEqual(t.bindingsOf('markdown.preview.side').map(b => [formatKeys(b.keys), b.where.join(',')]), [['ctrl+k v', 'note']])
    assert.equal(hint('theme.pick'), 'Ctrl+K Ctrl+T')
    assert.deepEqual(t.bindingsOf('font.increase').map(b => formatKeys(b.keys)), ['ctrl+=', 'ctrl+numpad_add', 'ctrl+shift+=', 'ctrl+shift+numpad_add'])
    assert.deepEqual(t.bindingsOf('font.reset').map(b => formatKeys(b.keys)), ['ctrl+0', 'ctrl+numpad0', 'ctrl+shift+0', 'ctrl+shift+numpad0'])
    assert.equal(hint('palette.show'), 'Ctrl+Shift+P')
    assert.equal(hint('palette.quick-open'), 'Ctrl+P')
    assert.equal(hint('keybindings.show'), 'Ctrl+K Ctrl+S')
    assert.equal(hint('app.quit-all'), 'Ctrl+Shift+Q')
    assert.equal(hint('pane.new'), 'Ctrl+K Ctrl+O')
    assert.deepEqual(t.bindingsOf(PREFIX_COMMAND).map(b => [formatKeys(b.keys), b.where.join(',')]), [['ctrl+k', 'window,terminal,note']])
    // Gone: the old aliases and the old desk chords.
    assert.equal(t.resolve([ev('KeyD', { ctrl: true, shift: true })], 'window').kind, 'none', 'Ctrl+Shift+D is VS Code\'s Run')
    assert.equal(t.resolve([ev('KeyE', { ctrl: true, shift: true })], 'window').kind, 'none')
    assert.equal(t.resolve([ev('KeyN', { ctrl: true, alt: true })], 'window').kind, 'none', 'Ctrl+Alt+N is gone (AltGr+N on ABNT2)')
  })

  test('scopes: a plain Ctrl+letter spares the terminal unless captured; the rest is everywhere; Ctrl+W passes in a terminal', () => {
    assert.deepEqual(defaultWhere({ ctrl: true, code: 'KeyW' }), ['window', 'note'])
    assert.deepEqual(defaultWhere({ ctrl: true, code: 'KeyP' }), ['window', 'terminal', 'note'])
    assert.deepEqual(defaultWhere({ ctrl: true, code: 'KeyN' }), ['window', 'terminal', 'note'])
    assert.deepEqual(defaultWhere({ ctrl: true, code: 'KeyK' }), ['window', 'terminal', 'note'])
    assert.deepEqual(defaultWhere({ ctrl: true, shift: true, code: 'KeyW' }), ['window', 'terminal', 'note'])
    assert.deepEqual(defaultWhere({ ctrl: true, code: 'Backslash' }), ['window', 'terminal', 'note'])
    assert.deepEqual(defaultWhere({ code: 'F2' }), ['window', 'terminal', 'note'])
    const t = new KeyTable(resolvedDefaults(false))
    assert.equal(t.resolve([ev('KeyW', { ctrl: true })], 'terminal').kind, 'none')
    assert.deepEqual(t.resolve([ev('KeyW', { ctrl: true })], 'note'), { kind: 'command', command: 'pane.close', binding: t.bindingsOf('pane.close')[1] })
    assert.equal(t.resolve([ev('F4', { ctrl: true })], 'terminal').kind, 'command')
    assert.equal(t.resolve([ev('KeyV', { ctrl: true, shift: true })], 'terminal').kind, 'none', 'the terminal pastes')
    assert.equal(t.resolve([ev('KeyV', { ctrl: true, shift: true })], 'window').kind, 'none', 'no markdown note in the window')
    assert.equal(t.resolve([ev('KeyV', { ctrl: true, shift: true })], 'note').kind, 'command')
    assert.equal(t.resolve([ev('KeyS', { ctrl: true })], 'window').kind, 'none')
  })

  test('ABNT2: `\\` matches Backslash and IntlBackslash; the numpad reset and the top-row zero both reset', () => {
    const t = new KeyTable(resolvedDefaults(false))
    assert.equal(t.resolve([ev('Backslash', { ctrl: true })], 'terminal').kind === 'command' && (t.resolve([ev('Backslash', { ctrl: true })], 'terminal') as { command: string }).command, 'pane.duplicate.pane.right')
    assert.equal((t.resolve([ev('IntlBackslash', { ctrl: true })], 'window') as { command?: string }).command, 'pane.duplicate.pane.right')
    assert.equal((t.resolve([ev('KeyK', { ctrl: true }), ev('IntlBackslash', { ctrl: true })], 'note') as { command?: string }).command, 'pane.duplicate.pane.below')
    assert.equal((t.resolve([ev('Numpad0', { ctrl: true })], 'terminal') as { command?: string }).command, 'font.reset')
    assert.equal((t.resolve([ev('Digit0', { ctrl: true })], 'terminal') as { command?: string }).command, 'font.reset')
  })

  test('the prefix: Ctrl+K opens chords in every scope by default; its row\'s `where` turns that off per scope', () => {
    const defaults = resolvedDefaults(false)
    const t = new KeyTable(defaults)
    assert.equal(t.resolve([ev('KeyK', { ctrl: true })], 'terminal').kind, 'prefix')
    assert.equal(t.resolve([ev('KeyK', { ctrl: true })], 'note').kind, 'prefix')
    assert.ok(t.continuations(ev('KeyK', { ctrl: true }), 'terminal').length >= 8)
    assert.ok(!t.continuations(ev('KeyK', { ctrl: true }), 'terminal').some(b => b.command === 'markdown.preview.side'), 'the note-only chords are not offered in a terminal')
    const off = new KeyTable(defaults.map(b => b.command === PREFIX_COMMAND ? { ...b, where: ['window', 'note'] as Where[] } : b))
    assert.equal(off.resolve([ev('KeyK', { ctrl: true })], 'terminal').kind, 'none', 'Ctrl+K passes to the program')
    assert.equal(off.resolve([ev('KeyK', { ctrl: true })], 'window').kind, 'prefix')
    // The last binding wins (the user's file comes after the defaults); a prefix shadows a single key on the same key.
    const user = new KeyTable([...defaults, { keys: [{ ctrl: true, code: 'F4' }], command: 'desk.new', where: ['window'], source: 'user' }])
    assert.equal((user.resolve([ev('F4', { ctrl: true })], 'window') as { command?: string }).command, 'desk.new')
    assert.equal((user.resolve([ev('F4', { ctrl: true })], 'terminal') as { command?: string }).command, 'pane.close')
    const shadow = new KeyTable([...defaults, { keys: [{ ctrl: true, code: 'KeyK' }], command: 'desk.new', where: ['window'], source: 'user' }])
    assert.equal(shadow.resolve([ev('KeyK', { ctrl: true })], 'window').kind, 'prefix')
  })

  test('key strings of the file round-trip: "ctrl+shift+t", "ctrl+k ctrl+s", "ctrl+\\", "alt+1", "f2", "ctrl+numpad0"', () => {
    for (const k of ['ctrl+shift+t', 'ctrl+k ctrl+s', 'ctrl+\\', 'alt+1', 'f2', 'ctrl+numpad0', 'ctrl+`', 'ctrl+pgdn', 'shift+alt+up', 'ctrl+shift+numpad_add', 'ctrl+=', 'ctrl+-']) {
      const parsed = parseKeys(k)
      assert.ok(parsed, k)
      assert.equal(formatKeys(parsed!), k)
    }
    assert.deepEqual(parseKey('Ctrl+Shift+T'), { ctrl: true, shift: true, code: 'KeyT' })
    assert.deepEqual(parseKey('shift+ctrl+t'), { ctrl: true, shift: true, code: 'KeyT' }, 'modifier order is free')
    assert.deepEqual(parseKey('cmd+k'), { meta: true, code: 'KeyK' })
    assert.deepEqual(parseKey('ctrl+pageup'), { ctrl: true, code: 'PageUp' })
    assert.equal(parseKey('ctrl+'), undefined)
    assert.equal(parseKey('ctrl+foo'), undefined)
    assert.equal(parseKey('hyper+t'), undefined)
    assert.equal(parseKeys('ctrl+k ctrl+s ctrl+t'), undefined, 'at most two keys')
    assert.equal(parseKeys(''), undefined)
  })

  test('hints and labels as the user reads them; Mac: Cmd for the app modifier, Ctrl+Tab and Ctrl+` kept literal', () => {
    assert.equal(shortcutHint('pane.new-tab', false), 'Ctrl+N')
    assert.equal(shortcutHint('pane.duplicate.frame.below', false), 'Ctrl+Alt+Shift+↓')
    assert.equal(shortcutHint('keybindings.show', false), 'Ctrl+K Ctrl+S')
    assert.equal(shortcutHint('nope.nope', false), '')
    assert.equal(chordLabel({ ctrl: true, code: 'Digit1' }, false), 'Ctrl+1')
    assert.equal(chordLabel({ ctrl: true, code: 'IntlBackslash' }, false), 'Ctrl+\\')
    assert.equal(chordLabel({ ctrl: true, code: 'PageDown' }, false), 'Ctrl+PgDn')
    assert.equal(shortcutHint('pane.new-tab', true), '⌘N')
    assert.equal(shortcutHint('keybindings.show', true), '⌘K ⌘S')
    assert.equal(shortcutHint('desk.next', true), '⌃Tab')
    assert.equal(shortcutHint('drawer.toggle', true), '⌃`')
    assert.equal(shortcutOf(ev('KeyT', { meta: true, shift: true }), true), 'pane.reopen-closed')
    assert.equal(shortcutOf(ev('KeyT', { ctrl: true, shift: true }), true), undefined, 'Ctrl stays the terminal\'s on the Mac')
    assert.equal(shortcutOf(ev('KeyP', { ctrl: true, shift: true }), false), 'palette.show')
    assert.equal(shortcutOf(ev('KeyW', { ctrl: true }), false, 'terminal'), undefined)
    assert.equal(shortcutOf(ev('KeyW', { ctrl: true }), false, 'note'), 'pane.close')
  })
})
