// settings-file.ts: the JSONC text of settings.json (parse, edit in place, diff) and userDir().
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { diffSettings, formattingOf, parseSettings, setValueText } from '../../app/shared/settings-file.ts'
import { userDir } from '../../src/core/paths.ts'

describe('parseSettings', () => {
  test('reads comments and trailing commas', () => {
    const r = parseSettings('{\n  // dark\n  "theme": "dark", /* x */\n  "ui": { "a": 1, },\n}')
    assert.deepEqual(r.errors, [])
    assert.deepEqual(r.value, { theme: 'dark', ui: { a: 1 } })
  })
  test('empty or blank text is {}', () => {
    assert.deepEqual(parseSettings(''), { value: {}, errors: [] })
    assert.deepEqual(parseSettings('  \n'), { value: {}, errors: [] })
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
