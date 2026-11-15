// settings-file.ts: the JSONC text of settings.json (parse, edit in place, diff) and userDir().
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { diffSettings, formattingOf, parseSettings, setSettingText, setValueText } from '../../app/shared/settings-file.ts'
import { userDir } from '../../src/core/paths.ts'

describe('parseSettings', () => {
  test('reads comments and trailing commas', () => {
    const r = parseSettings('{\n  // dark\n  "theme": "dark", /* x */\n  "ui": { "a": 1, },\n}')
    assert.deepEqual(r.errors, [])
    assert.deepEqual(r.value, { theme: 'dark', ui: { a: 1 } })
  })
  test('empty or blank text is {}', () => {
    assert.deepEqual(parseSettings(''), { value: {}, raw: {}, errors: [] })
    assert.deepEqual(parseSettings('  \n'), { value: {}, raw: {}, errors: [] })
  })
  test('invalid text and a non-object root are errors', () => {
    assert.ok(parseSettings('{ "a": ').errors.length > 0)
    assert.ok(parseSettings('[1]').errors.length > 0)
  })
})

describe('setValueText', () => {
  const src = '{\n  // my theme\n  "theme": "dark",\n  "ui": {\n    "deskLine": true // keep\n  }\n}\n'
  test('comments and layout survive an edit', () => {
    const r = setValueText(src, ['ui', 'deskLine'], false)
    assert.ok(r.ok)
    assert.equal(r.text, src.replace('true', 'false'))
  })
  test('adds a nested path', () => {
    const r = setValueText(src, ['extensions', 'note', 'minimap'], true)
    assert.ok(r.ok)
    assert.deepEqual(parseSettings(r.text).value, { theme: 'dark', ui: { deskLine: true }, extensions: { note: { minimap: true } } })
    assert.match(r.text, /\/\/ my theme/)
    assert.match(r.text, /\/\/ keep/)
  })
  test('undefined removes the key and keeps the rest', () => {
    const r = setValueText(src, ['theme'], undefined)
    assert.ok(r.ok)
    assert.deepEqual(parseSettings(r.text).value, { ui: { deskLine: true } })
    assert.match(r.text, /\/\/ keep/)
  })
  test('empty text becomes {} with the key', () => {
    const r = setValueText('', ['theme'], 'light')
    assert.ok(r.ok)
    assert.deepEqual(parseSettings(r.text).value, { theme: 'light' })
  })
  test('invalid text is refused with errors', () => {
    const r = setValueText('{ "theme": ', ['theme'], 'light')
    assert.equal(r.ok, false)
    assert.ok(!r.ok && r.errors.length > 0)
  })
  test('formatting follows the file (tabs, CRLF)', () => {
    assert.deepEqual(formattingOf('{\r\n\t"a": 1\r\n}'), { insertSpaces: false, tabSize: 1, eol: '\r\n' })
    assert.deepEqual(formattingOf('{\n    "a": 1\n}'), { insertSpaces: true, tabSize: 4, eol: '\n' })
    const r = setValueText('{\r\n\t"a": 1\r\n}', ['b'], 2)
    assert.ok(r.ok)
    assert.match(r.text, /\r\n\t"b": 2/)
  })
})

describe('diffSettings', () => {
  test('lists changed, added and removed keys as dotted paths', () => {
    const a = { theme: 'dark', ui: { a: 1, b: 2 }, gone: true, list: [1] }
    const b = { theme: 'light', ui: { a: 1, b: 3 }, added: { x: 1 }, list: [1] }
    assert.deepEqual(diffSettings(a, b), ['added.x', 'gone', 'theme', 'ui.b'])
  })
  test('equal objects differ in nothing; arrays compare by value', () => {
    assert.deepEqual(diffSettings({ a: [1, 2], o: {} }, { a: [1, 2], o: {} }), [])
    assert.deepEqual(diffSettings({ a: [1, 2] }, { a: [2, 1] }), ['a'])
  })
})

describe('userDir', () => {
  test('TETHER_USER_DIR wins', () => {
    assert.equal(userDir({ TETHER_USER_DIR: 'X:\\u', TETHER_HOME: 'X:\\h' }), 'X:\\u')
  })
  test('TETHER_HOME when set', () => {
    assert.equal(userDir({ TETHER_HOME: 'X:\\h' }), 'X:\\h')
  })
  test('~/.tether otherwise', () => {
    assert.equal(userDir({}), join(homedir(), '.tether'))
  })
})

describe('settings.json: dotted and nested keys (VS Code toValuesTree / configurationEditing)', () => {
  test('both forms read the same; keys apply in document order and the last one wins (VS Code)', () => {
    assert.deepEqual(parseSettings('{ "ui.deskLine": false }').value, { ui: { deskLine: false } })
    assert.deepEqual(parseSettings('{ "ui": { "deskLine": false } }').value, { ui: { deskLine: false } })
    // a nested object after a dotted key replaces the subtree
    assert.deepEqual(parseSettings('{ "ui.deskLine": false, "ui": { "deskLine": true, "tabBorder": true } }').value, { ui: { deskLine: true, tabBorder: true } })
    assert.deepEqual(parseSettings('{ "ui.tabBorder": true, "ui": { "deskLine": true } }').value, { ui: { deskLine: true } })
    // a dotted key after a nested object sets just its leaf
    assert.deepEqual(parseSettings('{ "ui": { "deskLine": true, "tabBorder": true }, "ui.deskLine": false }').value, { ui: { deskLine: false, tabBorder: true } })
    assert.deepEqual(parseSettings('{ "extensions": { "note": { "minimap": false } }, "extensions.note.size": 2 }').value, { extensions: { note: { minimap: false, size: 2 } } })
    assert.deepEqual(parseSettings('{ "extensions.note.size": 2, "extensions": { "note": { "minimap": false } } }').value, { extensions: { note: { minimap: false } } })
    // a dotted key under a scalar or null is ignored
    assert.deepEqual(parseSettings('{ "theme": "dark", "theme.x": 1 }').value, { theme: 'dark' })
    assert.deepEqual(parseSettings('{ "a": null, "a.b": 1 }').value, { a: null })
    // a later scalar replaces an earlier subtree
    assert.deepEqual(parseSettings('{ "a.b": 1, "a": 2 }').value, { a: 2 })
  })
  test('the values tree does not share objects with raw', () => {
    const r = parseSettings('{ "ui": { "a": 1 }, "ui.b": 2 }')
    assert.deepEqual(r.raw, { ui: { a: 1 }, 'ui.b': 2 })
    assert.deepEqual(r.value, { ui: { a: 1, b: 2 } })
  })
  test('a write goes flat and removes the nested occurrence (empty parents too), keeping comments', () => {
    const text = '{\n  // mine\n  "theme": "dark",\n  "ui": {\n    // line\n    "deskLine": true\n  },\n  "extensions": { "note": { "minimap": true }, "disabled": [] }\n}\n'
    let r = setSettingText(text, ['ui', 'deskLine'], [], false)
    assert.ok(r.ok)
    assert.match(r.text, /\/\/ mine/)
    assert.match(r.text, /"ui\.deskLine": false/)
    assert.doesNotMatch(r.text, /"ui":/)
    r = setSettingText(r.text, ['extensions', 'note', 'minimap'], [], false)
    assert.ok(r.ok)
    assert.deepEqual(parseSettings(r.text).raw, { theme: 'dark', 'ui.deskLine': false, extensions: { disabled: [] }, 'extensions.note.minimap': false })
  })
  test('a reset removes every form; a whole-object key edits inside its flat value', () => {
    const r = setSettingText('{ "ui": { "deskLine": true }, "ui.deskLine": false, "theme": "dark" }', ['ui', 'deskLine'], [], undefined)
    assert.ok(r.ok)
    assert.deepEqual(parseSettings(r.text).raw, { theme: 'dark' })
    const w = setSettingText('{ "terminal": { /* c */ "fontSize": 12 } }', ['terminal'], ['fontSize'], 14)
    assert.ok(w.ok)
    assert.match(w.text, /\/\* c \*\//)
    assert.deepEqual(parseSettings(w.text).raw, { terminal: { fontSize: 14 } })
    const m = setSettingText('{ "terminal.fontSize": 12, "terminal": { "theme": "x" } }', ['terminal'], ['fontSize'], 14)
    assert.ok(m.ok)
    assert.deepEqual(parseSettings(m.text).raw, { terminal: { theme: 'x', fontSize: 14 } })
  })
})

describe('setSettingText: nested prefix object', () => {
  const src = '{ "theme":"dark", "extensions":{ "disabled":[] }, "extensions.explorer.follow": true }'
  test('a nested prefix that lacks the path does not throw and keeps its siblings', () => {
    const r = setSettingText(src, ['extensions', 'explorer', 'autoReveal'], [], true)
    assert.ok(r.ok)
    assert.deepEqual(parseSettings(r.text).raw, {
      theme: 'dark',
      extensions: { disabled: [] },
      'extensions.explorer.follow': true,
      'extensions.explorer.autoReveal': true,
    })
  })
  test('a nested path that exists is removed, with the parents it leaves empty', () => {
    const r = setSettingText('{ "extensions": { "explorer": { "autoReveal": false }, "disabled": [] } }', ['extensions', 'explorer', 'autoReveal'], [], true)
    assert.ok(r.ok)
    assert.deepEqual(parseSettings(r.text).raw, { extensions: { disabled: [] }, 'extensions.explorer.autoReveal': true })
  })
})
