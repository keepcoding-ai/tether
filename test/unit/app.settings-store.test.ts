// SettingsStore (single writer, text preserved, refuses an invalid file), migrateUserFiles and the daemon's reader.
import { describe, test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { migrateUserFiles, SettingsStore } from '../../app/main/settings-store.ts'
import { readUserSettings } from '../../src/core/user-settings.ts'
import { tempDirs } from './tmp.helpers.ts'

const dirs = tempDirs('tether-settings-')
after(() => dirs.cleanup())

describe('SettingsStore', () => {
  test('assign edits only what differs and keeps comments; reports keys', () => {
    const dir = dirs.make()
    const path = join(dir, 'settings.json')
    writeFileSync(path, '{\n  // mine\n  "ui": { "a": 1, "b": 2 },\n  "theme": "dark"\n}\n')
    const seen: string[][] = []
    const store = new SettingsStore({ path, onChange: keys => seen.push(keys) })
    assert.ok(store.assign([], { ui: { a: 1, b: 3 }, theme: 'dark' }).ok)
    const text = readFileSync(path, 'utf8')
    assert.match(text, /\/\/ mine/)
    assert.deepEqual(store.value, { ui: { a: 1, b: 3 }, theme: 'dark' })
    assert.deepEqual(seen, [['ui.b']])
  })
  test('creates the file when absent and refuses to write over an invalid one', () => {
    const dir = dirs.make()
    const path = join(dir, 'sub', 'settings.json')
    const store = new SettingsStore({ path })
    assert.ok(store.set(['theme'], 'light').ok)
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { theme: 'light' })
    writeFileSync(path, '{ "theme": ')
    store.reload()
    assert.ok(store.errors.length > 0)
    assert.equal(store.set(['theme'], 'dark').ok, false)
    assert.equal(readFileSync(path, 'utf8'), '{ "theme": ')
    assert.deepEqual(store.value, { theme: 'light' })
  })
  test('reload reports an outside edit as disk change, and not our own write', () => {
    const dir = dirs.make()
    const path = join(dir, 'settings.json')
    const events: string[] = []
    const store = new SettingsStore({ path, onChange: (k, s) => events.push(`${s}:${k.join(',')}`) })
    store.set(['a'], 1)
    store.reload()
    writeFileSync(path, '{ "a": 2 } // x')
    store.reload()
    assert.deepEqual(events, ['self:a', 'disk:a'])
  })
})

describe('migrateUserFiles', () => {
  test('copies, renames the old to .migrated, never overwrites, is idempotent', () => {
    const oldDir = dirs.make()
    const newDir = join(dirs.make(), 'user')
    writeFileSync(join(oldDir, 'settings.json'), '{ "a": 1 }')
    writeFileSync(join(oldDir, 'keybindings.json'), '[]')
    assert.deepEqual(migrateUserFiles(oldDir, newDir, ['settings.json', 'keybindings.json']), ['settings.json', 'keybindings.json'])
    assert.equal(readFileSync(join(newDir, 'settings.json'), 'utf8'), '{ "a": 1 }')
    assert.ok(existsSync(join(oldDir, 'settings.json.migrated')) && !existsSync(join(oldDir, 'settings.json')))
    assert.deepEqual(migrateUserFiles(oldDir, newDir, ['settings.json']), [])
    writeFileSync(join(oldDir, 'settings.json'), '{ "a": 2 }')
    assert.deepEqual(migrateUserFiles(oldDir, newDir, ['settings.json']), [])
    assert.equal(readFileSync(join(newDir, 'settings.json'), 'utf8'), '{ "a": 1 }')
  })
  test('same folder: nothing to do', () => {
    const d = dirs.make()
    writeFileSync(join(d, 'settings.json'), '{}')
    assert.deepEqual(migrateUserFiles(d, d, ['settings.json']), [])
  })
})

describe('readUserSettings (daemon side)', () => {
  test('reads the user folder as JSONC, falls back to the old home copy', () => {
    const home = dirs.make()
    const user = dirs.make()
    writeFileSync(join(home, 'settings.json'), '{ "old": true }')
    assert.deepEqual(readUserSettings(home, { TETHER_HOME: home, TETHER_USER_DIR: user }), { old: true })
    writeFileSync(join(user, 'settings.json'), '{\n // c\n "new": true,\n}')
    assert.deepEqual(readUserSettings(home, { TETHER_HOME: home, TETHER_USER_DIR: user }), { new: true })
  })
})

describe('SettingsStore: flat keys like VS Code', () => {
  test('a write of a nested key converts it to a dotted one; keyOf keeps whole-object settings as one key', () => {
    const dir = dirs.make()
    const path = join(dir, 'settings.json')
    writeFileSync(path, '{\n  // mine\n  "ui": { "deskLine": true, "tabBorder": true },\n  "terminal": { "fontSize": 12 }\n}\n')
    const store = new SettingsStore({ path, keyOf: p => (p[0] === 'terminal' ? 1 : p.length) })
    assert.ok(store.assign(['ui'], { deskLine: false, tabBorder: true }).ok)
    assert.ok(store.assign(['terminal'], { fontSize: 14 }).ok)
    assert.ok(store.set(['theme'], 'dark').ok)
    const text = readFileSync(path, 'utf8')
    assert.match(text, /\/\/ mine/)
    assert.match(text, /"ui\.deskLine": false/)
    assert.match(text, /"ui": \{\s*"tabBorder": true\s*\}/)
    assert.match(text, /"terminal": \{\s*"fontSize": 14\s*\}/)
    assert.deepEqual(store.value, { ui: { deskLine: false, tabBorder: true }, terminal: { fontSize: 14 }, theme: 'dark' })
    assert.ok(store.set(['ui', 'tabBorder'], undefined).ok)
    assert.doesNotMatch(readFileSync(path, 'utf8'), /"ui":/)
  })
  test('the daemon reader honours both forms, dotted winning', () => {
    const dir = dirs.make()
    writeFileSync(join(dir, 'settings.json'), '{ "extensions.disabled": ["a"], "ui": { "deskLine": true }, "ui.deskLine": false }')
    assert.deepEqual(readUserSettings(dir), { extensions: { disabled: ['a'] }, ui: { deskLine: false } })
  })
})
