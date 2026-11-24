import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import type { SlotMeta } from '../../src/core/event.ts'
import type { Profile } from '../../src/core/profile.ts'
import { defaultProfiles } from '../../src/core/profile-sync.ts'
import { createDiskPorts, readLayoutFile, rewriteSettingsText, writeLayoutFile, type DaemonRequester } from '../../src/core/sync/disk-ports.ts'

let root: string
let seq = 0
before(() => { root = mkdtempSync(join(tmpdir(), 'tether-disk-ports-')) })
after(() => { rmSync(root, { recursive: true, force: true }) })

function dirs(): { home: string; user: string } {
  const base = join(root, `d${++seq}`)
  const home = join(base, 'home')
  const user = join(base, 'user')
  mkdirSync(home, { recursive: true })
  mkdirSync(user, { recursive: true })
  return { home, user }
}

const meta = (id: string, name?: string): SlotMeta => ({ v: 1, slotId: id, agent: 'shell', cwd: root, args: [], createdAt: '2026-11-23T10:00:00.000Z', ...(name ? { name } : {}) })
const prof = (id: string, name = id): Profile => ({ id, name, agent: 'shell', args: [] })
// The test profiles are all shells: every other motor reads back with its default profiles (merged in memory, per motor).
const otherMotorDefaults = (): Profile[] => defaultProfiles().filter((p) => p.agent !== 'shell')

describe('rewriteSettingsText', () => {
  test('edits only what differs and keeps comments, layout and what the codec does not own', () => {
    const text = '// top\n{\n  // theme\n  "theme": "light",\n  "ui": { "deskLine": true }, // keep\n  "window.width": 900\n}\n'
    const out = rewriteSettingsText(text, { theme: 'dark', ui: { deskLine: true }, window: { width: 900 } })
    assert.match(out, /\/\/ top/)
    assert.match(out, /\/\/ theme/)
    assert.match(out, /\/\/ keep/)
    assert.match(out, /"theme": "dark"/)
    assert.match(out, /"ui": \{ "deskLine": true \}/)
    assert.match(out, /"window.width": 900/)
  })

  test('adds a new key and removes a dropped one, comments intact', () => {
    const text = '{\n  // a\n  "a": 1,\n  "b": 2 // b\n}\n'
    const out = rewriteSettingsText(text, { a: 1, c: { d: [1, 2] } })
    assert.match(out, /\/\/ a/)
    assert.doesNotMatch(out, /"b"/)
    assert.match(out, /"c\.d": \[/)
  })

  test('no change leaves the text byte for byte', () => {
    const text = '// x\n{ "a": 1 /* y */ }\n'
    assert.equal(rewriteSettingsText(text, { a: 1 }), text)
  })

  test('a missing or empty file simply gets the tree; an invalid one is refused and untouched', () => {
    assert.deepEqual(JSON.parse(rewriteSettingsText(undefined, { a: { b: 1 } })), { a: { b: 1 } })
    assert.deepEqual(JSON.parse(rewriteSettingsText('  ', { a: 1 })), { a: 1 })
    assert.throws(() => rewriteSettingsText('{ "a": ', { a: 1 }), /não está válido/)
  })
})

describe('layout file', () => {
  test('absent: an empty arrangement; written with a .bak of the previous content; falls back to the .bak', () => {
    const { home } = dirs()
    assert.deepEqual(readLayoutFile(home), {})
    writeLayoutFile(home, { v: 4, desks: [], activeDesk: 'one' })
    assert.ok(!existsSync(join(home, 'layout.json.bak')))
    writeLayoutFile(home, { v: 4, desks: [], activeDesk: 'two' })
    assert.equal((JSON.parse(readFileSync(join(home, 'layout.json.bak'), 'utf8')) as { activeDesk: string }).activeDesk, 'one')
    assert.equal(readLayoutFile(home).activeDesk, 'two')
    writeFileSync(join(home, 'layout.json'), '{ broken')
    assert.equal(readLayoutFile(home).activeDesk, 'one')
    writeLayoutFile(home, { v: 4, desks: [], activeDesk: 'three' })
    assert.equal(readLayoutFile(home).activeDesk, 'three')
    assert.equal((JSON.parse(readFileSync(join(home, 'layout.json.bak'), 'utf8')) as { activeDesk: string }).activeDesk, 'one', 'a corrupt file does not replace a good backup')
  })
})

describe('disk ports', () => {
  test('without a daemon: profiles, slots (create + rename + clear), settings, keybindings and layout land on disk', async () => {
    const { home, user } = dirs()
    const ports = createDiskPorts({ home, userDir: user })
    writeFileSync(join(user, 'settings.json'), '// mine\n{ "theme": "light" }\n')
    mkdirSync(join(home, 'slots'), { recursive: true })
    writeFileSync(join(home, 'slots', 'old.json'), JSON.stringify(meta('old', 'Antigo')))
    writeFileSync(join(home, 'slots', 'keep.json'), JSON.stringify(meta('keep')))

    await ports.apply({
      profiles: [prof('p1', 'Um')],
      slots: { create: [meta('new1', 'Novo')], rename: [{ slotId: 'old', name: 'Renomeado' }, { slotId: 'keep', name: 'Nomeado' }] },
      settings: { theme: 'dark' },
      keybindings: [{ key: 'ctrl+k', command: 'x' }],
      layout: { v: 4, desks: [], activeDesk: '' },
    })
    const w = await ports.read()
    assert.deepEqual(w.profiles.map((p) => p.id), ['p1', ...otherMotorDefaults().map((p) => p.id)])
    assert.deepEqual(Object.fromEntries(w.slots.map((s) => [s.slotId, s.name])), { old: 'Renomeado', keep: 'Nomeado', new1: 'Novo' })
    assert.deepEqual(w.settings, { theme: 'dark' })
    assert.match(readFileSync(join(user, 'settings.json'), 'utf8'), /\/\/ mine/)
    assert.deepEqual(w.keybindings, [{ key: 'ctrl+k', command: 'x' }])
    assert.equal(w.layout.v, 4)

    await ports.apply({ slots: { create: [], rename: [{ slotId: 'old', name: undefined }] } })
    assert.equal((await ports.read()).slots.find((s) => s.slotId === 'old')?.name, undefined)
  })

  test('read: nothing on disk is an empty arrangement, no keybindings and the default profiles', async () => {
    const { home, user } = dirs()
    const w = await createDiskPorts({ home, userDir: user }).read()
    assert.deepEqual(w.layout, {})
    assert.equal(w.keybindings, undefined)
    assert.deepEqual(w.settings, {})
    assert.deepEqual(w.slots, [])
  })

  test('keybindings with comments are read (JSONC)', async () => {
    const { home, user } = dirs()
    writeFileSync(join(user, 'keybindings.json'), '// mine\n[ { "key": "a", "command": "b" }, ]\n')
    assert.deepEqual((await createDiskPorts({ home, userDir: user }).read()).keybindings, [{ key: 'a', command: 'b' }])
  })

  test('with a daemon: profiles go through profile-save/profile-delete and renames through rename-slot; slots are created on disk', async () => {
    const { home, user } = dirs()
    writeFileSync(join(home, 'profiles.json'), JSON.stringify({ v: 1, profiles: [prof('keep'), prof('gone'), prof('edit', 'Antes')] }))
    mkdirSync(join(home, 'slots'), { recursive: true })
    writeFileSync(join(home, 'slots', 'old.json'), JSON.stringify(meta('old', 'Antigo')))
    const calls: unknown[] = []
    const daemon: DaemonRequester = { request: async (body) => { calls.push(body); return { t: 'ok', id: 1 } } }
    const ports = createDiskPorts({ home, userDir: user, daemon })
    await ports.apply({
      profiles: [prof('keep'), prof('edit', 'Depois'), prof('fresh')],
      slots: { create: [meta('new1')], rename: [{ slotId: 'old', name: 'N' }, { slotId: 'new1', name: undefined }] },
    })
    assert.deepEqual(calls, [
      { t: 'profile-save', profile: prof('edit', 'Depois') },
      { t: 'profile-save', profile: prof('fresh') },
      { t: 'profile-delete', profileId: 'gone' },
      // the read the plan is diffed against carries the other motors' defaults (in memory), which the incoming list does not have
      ...otherMotorDefaults().map((p) => ({ t: 'profile-delete', profileId: p.id })),
      { t: 'rename-slot', slotId: 'old', name: 'N' },
      { t: 'rename-slot', slotId: 'new1', name: '' },
    ])
    assert.ok(existsSync(join(home, 'slots', 'new1.json')))
    assert.equal(JSON.parse(readFileSync(join(home, 'profiles.json'), 'utf8')).profiles.length, 3, 'the file is the daemon\'s to write')
  })
})
