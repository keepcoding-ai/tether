// The note as the first extension (F9 slice 1): its manifest is consistent (every key and ≡ item names a declared
// command; chooser items sit in declared groups; the pane types are the ones people's layout.json has), and the
// one-time moves of what the core kept (app/shared/ext-migrations.ts: `ui.wordWrap` → `extensions.note.wordWrap`,
// `notes.gitignoreDeclined` → the note's remembered state) keep the value, never overwrite, and drop the old key.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { manifest } from '../../extensions/note/manifest.ts'
import { commandFromContribution, type CommandContext } from '../../app/renderer/commands.ts'
import { deserialize, evaluate } from '../../app/shared/vscode-contextkey.ts'
import { applyMigrations, stateOf, withState } from '../../app/shared/ext-migrations.ts'
import { readExtensionsSettings } from '../../app/shared/vscode-configuration-registry.ts'
import { HTML_PREVIEW_COMPONENT, PREVIEW_COMPONENT, PREVIEW_PANEL_PREFIX, PREVIEW_TAB } from '../../app/shared/preview.ts'
import { NOTE_COMPONENT, NOTE_PANEL_PREFIX, NOTE_TAB } from '../../app/shared/notes.ts'

const c = manifest.contributes!

describe('note extension manifest', () => {
  const declared = new Set(c.commands!.map(x => x.command))

  test('every default key and ≡ item names a declared command; ids are the ones keybindings.json already names', () => {
    for (const k of c.keybindings!) assert.ok(declared.has(k.command), k.command)
    for (const m of c.menus!.app!) assert.ok(declared.has(m.command), m.command)
    for (const id of ['note.new', 'note.open', 'note.save', 'note.save-as', 'markdown.preview', 'markdown.preview.side', 'markdown.source', 'ui.word-wrap']) assert.ok(declared.has(id), id)
  })

  test('a toggled ≡ item names a boolean setting of the extension', () => {
    for (const m of c.menus!.app!.filter(x => x.toggled)) assert.equal(c.settings![m.toggled!]?.type, 'boolean', m.command)
  })

  test('chooser items sit in declared groups; the ids keep the `kind:<id>` the chooser had', () => {
    const groups = new Set(c.chooser!.groups.map(g => g.id))
    for (const i of c.chooser!.items) assert.ok(groups.has(i.group), i.id)
    assert.deepEqual(c.chooser!.items.map(i => i.id), ['note-new', 'note-open'])
  })

  test('the pane types keep the component, tab and prefix names of layout.json', () => {
    const byId = new Map(c.paneTypes!.map(t => [t.id, t]))
    assert.deepEqual([byId.get('note')!.component, byId.get('note')!.tabComponent, byId.get('note')!.idPrefix], [NOTE_COMPONENT, NOTE_TAB, NOTE_PANEL_PREFIX])
    assert.deepEqual([byId.get('md-preview')!.component, byId.get('md-preview')!.tabComponent, byId.get('md-preview')!.idPrefix], [PREVIEW_COMPONENT, PREVIEW_TAB, PREVIEW_PANEL_PREFIX])
    assert.deepEqual([byId.get('html-preview')!.component, byId.get('html-preview')!.tabComponent, byId.get('html-preview')!.idPrefix], [HTML_PREVIEW_COMPONENT, PREVIEW_TAB, PREVIEW_PANEL_PREFIX])
    assert.equal(byId.get('html-preview')!.owns!({ id: 'preview:x', params: { preview: { path: 'a.html', kind: 'html' } } }), true)
    assert.equal(byId.get('md-preview')!.owns!({ id: 'preview:x', params: { preview: { path: 'a.md' } } }), true)
  })

  test('the `when` of the preview family reads the context keys (data, evaluated by the core)', () => {
    const cmd = (id: string) => commandFromContribution(c.commands!.find(x => x.command === id)!, () => {})
    const ctx = (flags: string[], focus: 'editor' | 'none' = 'none'): CommandContext => ({ pane: true, flags: new Set(flags), focus, desks: 1, drawerOpen: false })
    assert.equal(cmd('markdown.preview').when!(ctx(['markdown.note'])), true)
    assert.equal(cmd('markdown.preview').when!(ctx([])), false)
    assert.equal(cmd('markdown.source').when!(ctx(['markdown.preview'])), true)
    assert.equal(cmd('note.save').when!(ctx([], 'editor')), true)
    assert.equal(cmd('note.save').when!(ctx(['markdown.note'])), false)
    assert.equal(cmd('note.new').when, undefined)
    for (const x of c.commands!) assert.ok(x.when === undefined || typeof x.when === 'string', 'the manifest is data')
  })
})

describe('context key expressions (VS Code when clauses)', () => {
  const look = (o: Record<string, string | boolean | number | undefined>) => (k: string) => o[k]
  test('key, !key, ==, !=, &&, ||', () => {
    assert.equal(evaluate(deserialize('a'), look({ a: true })), true)
    assert.equal(evaluate(deserialize('!a'), look({ a: true })), false)
    assert.equal(evaluate(deserialize('focus == editor'), look({ focus: 'editor' })), true)
    assert.equal(evaluate(deserialize("focus != 'editor'"), look({ focus: 'editor' })), false)
    assert.equal(evaluate(deserialize('a && !b'), look({ a: true, b: false })), true)
    assert.equal(evaluate(deserialize('a && b || c'), look({ c: true })), true)
    assert.equal(evaluate(deserialize('desks == 2'), look({ desks: 2 })), true)
    assert.throws(() => deserialize('a && (b)'))
  })
})

describe('settings migrations', () => {
  test('ui.wordWrap moves to extensions.note.wordWrap, the rest of `ui` stays', () => {
    const { file, moved } = applyMigrations({ ui: { deskLine: false, wordWrap: false }, theme: 'dark' }, [manifest])
    assert.deepEqual(file.ui, { deskLine: false })
    assert.equal(file.theme, 'dark')
    assert.deepEqual(readExtensionsSettings(file.extensions).values.note, { wordWrap: false })
    assert.deepEqual(moved, ['ui.wordWrap → extensions.note.wordWrap'])
  })

  test('a value already in the extension wins; the old key goes anyway; a malformed old value reads as the default', () => {
    const kept = applyMigrations({ ui: { wordWrap: false }, extensions: { note: { wordWrap: true } } }, [manifest]).file
    assert.equal(readExtensionsSettings(kept.extensions).values.note!.wordWrap, true)
    assert.equal(kept.ui, undefined, 'an emptied `ui` goes')
    const bad = applyMigrations({ ui: { wordWrap: 'off' } }, [manifest]).file
    assert.equal(readExtensionsSettings(bad.extensions).values.note!.wordWrap, true)
  })

  test('notes.gitignoreDeclined moves into the note\'s remembered state', () => {
    const { file } = applyMigrations({ notes: { gitignoreDeclined: ['C:\\repo'] } }, [manifest])
    assert.equal(file.notes, undefined)
    assert.deepEqual(stateOf(file, 'note'), { gitignoreDeclined: ['C:\\repo'] })
  })

  test('nothing to move: the file is the same object and nothing is reported (no write at every start)', () => {
    const f = { ui: { deskLine: true }, extensions: { disabled: ['note'] } }
    const r = applyMigrations(f, [manifest])
    assert.equal(r.file, f)
    assert.deepEqual(r.moved, [])
  })

  test('state: set and remove one key, other extensions untouched', () => {
    let f: Record<string, unknown> = withState({}, 'other', 'k', 1)
    f = withState(f, 'note', 'a', [1])
    assert.deepEqual(stateOf(f, 'note'), { a: [1] })
    f = withState(f, 'note', 'a', undefined)
    assert.deepEqual(stateOf(f, 'note'), {})
    assert.deepEqual(stateOf(f, 'other'), { k: 1 })
  })
})
