// Keyboard shortcuts, delivery 5 (F5): the user's file (app/renderer/keybindings-rules.ts: JSONC read, `-id`, merge over the
// defaults, the smallest file back), and the dispatch with a prefix (app/renderer/chord-dispatch.ts: Ctrl+K X runs, Ctrl+K
// Ctrl+K in a terminal passes ^K, Esc cancels, a second key that completes nothing is swallowed, the editor goes first in a note).
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { ChordDispatcher, scopeOf, type DispatchEvent } from '../../app/renderer/chord-dispatch.ts'
import { formatKeybindingsFile, mergeKeybindings, overridesFor, parseKeybindingsFile, prefixIssue, stripJsonComments } from '../../app/renderer/keybindings-rules.ts'
import { appCommands, type CommandHost } from '../../app/renderer/app-commands.ts'
import { withKeybindingsScreenKeybindings } from './keybindings-screen-extension.ts'
import { formatKeys, KeyTable, PREFIX_COMMAND, resolvedDefaults, type Keybinding, type Where } from '../../app/renderer/shortcuts.ts'

const known = new Set(appCommands(new Proxy({}, { get: () => () => {} }) as CommandHost).map(c => c.id))
const ev = (code: string, m: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {}, key = ''): DispatchEvent =>
  ({ code, key: key || code.replace(/^Key/, ''), ctrlKey: !!m.ctrl, shiftKey: !!m.shift, altKey: !!m.alt, metaKey: !!m.meta })

// Ctrl+K Ctrl+S comes from the keybindings-screen extension (extensions/keybindings-screen/manifest.ts), contributed as at the app's startup.
withKeybindingsScreenKeybindings()

describe('keybindings.json', () => {
  test('comments are stripped outside strings; the rest is strict JSON (a trailing comma is an error, with its line)', () => {
    assert.equal(stripJsonComments('// a\n[ { "key": "ctrl+k", /* x */ "command": "a.b" } ] // "not a string"').trim().replace(/\s+/g, ' '), '[ { "key": "ctrl+k", "command": "a.b" } ]')
    assert.equal(stripJsonComments('["a // not a comment", "b /* nor this */"]'), '["a // not a comment", "b /* nor this */"]')
    const bad = parseKeybindingsFile('[\n  { "key": "ctrl+shift+t", "command": "-pane.reopen-closed" },\n  { "key": "ctrl+w", "command": "pane.close" },\n]')
    assert.equal(bad.ok, false)
    if (!bad.ok) { assert.match(bad.message, /JSON inválido/); assert.equal(bad.line, 4) }
    assert.deepEqual(parseKeybindingsFile(''), { ok: true, entries: [], warnings: [] })
    assert.deepEqual(parseKeybindingsFile('  \n'), { ok: true, entries: [], warnings: [] })
    assert.equal(parseKeybindingsFile('{ "key": "x" }').ok, false, 'must be a list')
  })

  test('entries: key + command (+ where); -command removes; a bad key, a bad where or a missing key skips that entry with a warning', () => {
    const r = parseKeybindingsFile(JSON.stringify([
      { key: 'Ctrl+Shift+T', command: 'pane.new-tab' },
      { key: 'ctrl+shift+t', command: '-pane.reopen-closed' },
      { command: '-desk.new' },
      { key: 'ctrl+w', command: 'pane.close', where: ['window', 'note', 'terminal'] },
      { key: 'ctrl+bogus', command: 'pane.close' },
      { key: 'ctrl+x', command: 'pane.close', where: ['everywhere'] },
      { command: 'pane.close' },
      { key: 'ctrl+x' },
      7,
    ]))
    assert.ok(r.ok)
    if (!r.ok) return
    assert.deepEqual(r.entries, [
      { key: 'ctrl+shift+t', command: 'pane.new-tab' },
      { key: 'ctrl+shift+t', command: '-pane.reopen-closed' },
      { command: '-desk.new' },
      { key: 'ctrl+w', command: 'pane.close', where: ['window', 'note', 'terminal'] },
    ])
    assert.equal(r.warnings.length, 5)
    assert.match(r.warnings[0]!, /ilegível/)
    assert.match(r.warnings[1]!, /"where"/)
    assert.match(r.warnings[2]!, /sem "key"/)
    assert.match(r.warnings[3]!, /sem "command"/)
    assert.match(r.warnings[4]!, /não é um objeto/)
  })

  test('merge: the file lays over the defaults in order; -id removes (one key or all); an unknown command is skipped with a warning', () => {
    const { bindings, warnings } = mergeKeybindings([
      { key: 'ctrl+shift+t', command: '-pane.reopen-closed' },
      { key: 'ctrl+shift+t', command: 'pane.new-tab' },
      { key: 'ctrl+w', command: 'pane.close', where: ['window', 'terminal', 'note'] },
      { command: '-drawer.toggle' },
      { key: 'ctrl+q', command: 'no.such' },
      { key: 'ctrl+k ctrl+q', command: 'desk.close' },
    ], known, false)
    const t = new KeyTable(bindings)
    assert.deepEqual(t.bindingsOf('pane.reopen-closed'), [])
    assert.deepEqual(t.bindingsOf('pane.new-tab').map(b => [formatKeys(b.keys), b.source]), [['ctrl+n', 'default'], ['ctrl+shift+t', 'user']])
    assert.equal((t.resolve([{ ...ev('KeyT', { ctrl: true, shift: true }) }], 'terminal') as { command?: string }).command, 'pane.new-tab')
    assert.deepEqual(t.bindingsOf('pane.close').map(b => [formatKeys(b.keys), b.where.join(',')]), [['ctrl+f4', 'window,terminal,note'], ['ctrl+w', 'window,note'], ['ctrl+w', 'window,terminal,note']])
    assert.equal((t.resolve([ev('KeyW', { ctrl: true })], 'terminal') as { command?: string }).command, 'pane.close', 'the user put Ctrl+W back in the terminal')
    assert.deepEqual(t.bindingsOf('drawer.toggle'), [], '-id without a key removes every default of the command')
    assert.deepEqual(warnings, ['"no.such" não é um comando; a entrada ctrl+q foi ignorada'])
    assert.equal((t.resolve([ev('KeyK', { ctrl: true }), ev('KeyQ', { ctrl: true })], 'window') as { command?: string }).command, 'desk.close')
    assert.deepEqual(t.bindingsOf('desk.close').map(b => formatKeys(b.keys)), ['ctrl+k f', 'ctrl+k ctrl+q'])
  })

  test('the smallest file back: only what differs from the defaults; `where` only when it is not the key\'s default; an unchanged table is []', () => {
    const defaults = resolvedDefaults(false)
    assert.deepEqual(overridesFor(defaults, false), [])
    assert.equal(formatKeybindingsFile([]).trim().split('\n').pop(), '[]')
    const changed: Keybinding[] = defaults
      .filter(b => !(b.command === 'pane.reopen-closed'))
      .map(b => b.command === 'pane.close' && formatKeys(b.keys) === 'ctrl+w' ? { ...b, where: ['window', 'terminal', 'note'] as Where[] } : b)
    changed.push({ keys: [{ ctrl: true, shift: true, code: 'KeyT' }], command: 'pane.new-tab', where: ['window', 'terminal', 'note'], source: 'user' })
    const entries = overridesFor(changed, false)
    assert.deepEqual(entries, [
      { key: 'ctrl+shift+t', command: 'pane.new-tab' },
      { key: 'ctrl+shift+t', command: '-pane.reopen-closed' },
      { key: 'ctrl+w', command: '-pane.close' },
      { key: 'ctrl+w', command: 'pane.close', where: ['window', 'terminal', 'note'] },
    ])
    // Round trip: writing the file and reading it back gives the same table.
    const text = formatKeybindingsFile(entries)
    const parsed = parseKeybindingsFile(text)
    assert.ok(parsed.ok)
    if (!parsed.ok) return
    const again = mergeKeybindings(parsed.entries, known, false).bindings
    assert.deepEqual(overridesFor(again, false), entries)
    assert.match(text, /^\/\/ Atalhos do Tether/)
  })

  test('prefix issues: a single key that opens chords; a chord whose first key is a single binding', () => {
    const t = resolvedDefaults(false)
    const isPrefix = prefixIssue(t, [{ ctrl: true, code: 'KeyK' }], ['window'])
    assert.equal(isPrefix?.kind, 'is-prefix')
    assert.ok(isPrefix!.commands.includes('keybindings.show'))
    const firstSingle = prefixIssue(t, [{ ctrl: true, shift: true, code: 'KeyP' }, { code: 'KeyX' }], ['window'])
    assert.deepEqual(firstSingle, { kind: 'first-is-single', commands: ['palette.show'] })
    assert.equal(prefixIssue(t, [{ ctrl: true, code: 'KeyW' }], ['terminal']), undefined, 'no overlap in scope')
  })
})

describe('the dispatch with a prefix', () => {
  const table = new KeyTable(resolvedDefaults(false))
  const make = (hooks: { editorChord?: (first: unknown, second: unknown) => boolean; modal?: () => boolean } = {}): ChordDispatcher =>
    new ChordDispatcher({ table: () => table, ...(hooks.editorChord ? { editorChord: hooks.editorChord as never } : {}), ...(hooks.modal ? { modalOpen: hooks.modal } : {}) })

  test('Ctrl+K then Ctrl+S opens the shortcuts screen; the pill sees the prefix and its continuations', () => {
    const d = make()
    const first = d.press(ev('KeyK', { ctrl: true }), 'window')
    assert.equal(first.type, 'prefix')
    if (first.type === 'prefix') { assert.deepEqual(first.first, { ctrl: true, code: 'KeyK' }); assert.ok(first.next.some(b => b.command === 'keybindings.show')) }
    assert.ok(d.waiting)
    assert.deepEqual(d.press(ev('ControlLeft', { ctrl: true }, 'Control'), 'window'), { type: 'wait' }, 'a modifier going down keeps the wait')
    const second = d.press(ev('KeyS', { ctrl: true }), 'window')
    assert.equal(second.type, 'run')
    if (second.type === 'run') { assert.equal(second.command, 'keybindings.show'); assert.equal(second.keys.length, 2) }
    assert.equal(d.waiting, undefined)
  })

  test('a second key that completes nothing is swallowed and told; Esc cancels; a single key that is nobody\'s passes', () => {
    const d = make()
    d.press(ev('KeyK', { ctrl: true }), 'terminal')
    const r = d.press(ev('KeyX'), 'terminal')
    assert.equal(r.type, 'unknown')
    assert.equal(d.waiting, undefined)
    d.press(ev('KeyK', { ctrl: true }), 'window')
    assert.deepEqual(d.press(ev('Escape', {}, 'Escape'), 'window'), { type: 'cancel' })
    assert.equal(d.waiting, undefined)
    assert.deepEqual(d.press(ev('KeyX'), 'window'), { type: 'pass' })
    assert.deepEqual(d.press(ev('KeyW', { ctrl: true }), 'terminal'), { type: 'pass' }, 'Ctrl+W in a terminal passes (erase word)')
    assert.equal(d.press(ev('KeyW', { ctrl: true }), 'note').type, 'run', 'Ctrl+W in a note closes')
    assert.equal(d.press(ev('KeyW', { ctrl: true }), 'window').type, 'run')
  })

  test('in a terminal, Ctrl+K twice sends ^K to the program; in a note the editor\'s chord goes first', () => {
    const d = make({ editorChord: (_f, s) => (s as { code: string }).code === 'KeyC' })
    d.press(ev('KeyK', { ctrl: true }), 'terminal')
    assert.deepEqual(d.press(ev('KeyK', { ctrl: true }), 'terminal'), { type: 'pass-prefix-key' })
    assert.equal(d.waiting, undefined)
    d.press(ev('KeyK', { ctrl: true }), 'note')
    const editor = d.press(ev('KeyC', { ctrl: true }), 'note')
    assert.equal(editor.type, 'editor', 'Ctrl+K Ctrl+C is Monaco\'s "add line comment"')
    d.press(ev('KeyK', { ctrl: true }), 'note')
    const app = d.press(ev('KeyS', { ctrl: true }), 'note')
    assert.equal(app.type, 'run', 'what the editor does not have, the app runs')
    d.press(ev('KeyK', { ctrl: true }), 'window')
    assert.equal(d.press(ev('KeyK', { ctrl: true }), 'window').type, 'run', 'Ctrl+K Ctrl+K in the window is the screen\'s "record"')
  })

  test('the prefix row\'s scope: Terminal off means Ctrl+K passes in a terminal and still opens chords in the window', () => {
    const off = new KeyTable(resolvedDefaults(false).map(b => b.command === PREFIX_COMMAND ? { ...b, where: ['window', 'note'] as Where[] } : b))
    const d = new ChordDispatcher({ table: () => off })
    assert.deepEqual(d.press(ev('KeyK', { ctrl: true }), 'terminal'), { type: 'pass' })
    assert.equal(d.press(ev('KeyK', { ctrl: true }), 'window').type, 'prefix')
  })

  test('a modal dialog drops the wait and takes the key', () => {
    let modal = false
    const d = make({ modal: () => modal })
    d.press(ev('KeyK', { ctrl: true }), 'window')
    modal = true
    assert.deepEqual(d.press(ev('KeyS', { ctrl: true }), 'window'), { type: 'pass' })
    assert.equal(d.waiting, undefined)
  })

  test('with the peek card open only the kept commands run; a prefix does not open and a pending one is dropped', () => {
    let open = false
    const keeps = new Set(['peek.close', 'palette.show'])
    const d = new ChordDispatcher({ table: () => table, keeps: () => open ? (c: string) => keeps.has(c) : undefined })
    assert.equal(d.press(ev('Tab', { ctrl: true }, 'Tab'), 'window').type, 'run', 'Ctrl+Tab switches desks while the card is shut')
    d.press(ev('KeyK', { ctrl: true }), 'window')
    assert.ok(d.waiting)
    open = true
    assert.deepEqual(d.press(ev('KeyS', { ctrl: true }), 'window'), { type: 'pass' })
    assert.equal(d.waiting, undefined)
    assert.deepEqual(d.press(ev('Tab', { ctrl: true }, 'Tab'), 'window'), { type: 'pass' }, 'the desk switch is quiet')
    assert.deepEqual(d.press(ev('KeyK', { ctrl: true }), 'terminal'), { type: 'pass' }, 'no prefix opens: ^K is the terminal\'s')
    assert.equal(d.waiting, undefined)
    const close = d.press(ev('KeyO', { ctrl: true, shift: true }), 'terminal')
    assert.equal(close.type, 'run')
    if (close.type === 'run') assert.equal(close.command, 'peek.close')
    const palette = d.press(ev('KeyP', { ctrl: true, shift: true }), 'window')
    assert.equal(palette.type, 'run')
    if (palette.type === 'run') assert.equal(palette.command, 'palette.show')
  })

  test("with the card open, a chord toward a kept command opens outside a terminal (a screen's own Ctrl+K Ctrl+K) and completes only toward it", () => {
    const keeps = new Set(['peek.close', 'palette.show', 'keybindings.record'])
    const d = new ChordDispatcher({ table: () => table, keeps: () => (c: string) => keeps.has(c) })
    const first = d.press(ev('KeyK', { ctrl: true }), 'window')
    assert.equal(first.type, 'prefix')
    if (first.type === 'prefix') assert.deepEqual(first.next.map(b => b.command), ['keybindings.record'], 'the pill lists only what still fires')
    const record = d.press(ev('KeyK', { ctrl: true }), 'window')
    assert.equal(record.type, 'run')
    if (record.type === 'run') assert.equal(record.command, 'keybindings.record')
    assert.equal(d.waiting, undefined)
    d.press(ev('KeyK', { ctrl: true }), 'window')
    assert.equal(d.press(ev('KeyO', { ctrl: true }), 'window').type, 'unknown', 'Ctrl+K Ctrl+O (pane.new, quiet behind the card) is swallowed, never run')
    assert.deepEqual(d.press(ev('KeyK', { ctrl: true }), 'terminal'), { type: 'pass' }, 'in the card\'s terminal ^K stays the program\'s')
    assert.equal(d.waiting, undefined)
    const none = new ChordDispatcher({ table: () => table, keeps: () => (c: string) => c === 'peek.close' })
    assert.deepEqual(none.press(ev('KeyK', { ctrl: true }), 'window'), { type: 'pass' }, 'no kept continuation: no prefix')
  })

  test('the scope of a key by its target', () => {
    const el = (hit: string): unknown => ({ closest: (sel: string) => (sel === hit ? {} : null) })
    assert.equal(scopeOf(el('.xterm')), 'terminal')
    assert.equal(scopeOf(el('[data-editor]')), 'note')
    assert.equal(scopeOf(el('.other')), 'window')
    assert.equal(scopeOf(undefined), 'window')
  })
})
