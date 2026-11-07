// The settings page's pure rules (extensions/settings-screen/rules.ts): display format, query tags, matching,
// validation, sections.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { SettingEntry } from '../../app/shared/api.ts'
import type { SettingSchema } from '../../app/shared/vscode-configuration-registry.ts'
import { createValidator, filterSections, isConfigured, matchSetting, parseQuery, parseValue, sectionsOf, settingKeyToDisplayFormat, settingTitle, withModifiedTag } from '../../extensions/settings-screen/rules.ts'

const entry = (key: string, schema: SettingSchema, over: Partial<SettingEntry> = {}): SettingEntry =>
  ({ key, node: 'core', nodeTitle: 'Aparência', schema, value: schema.default, configured: false, ...over })

const DESK = entry('ui.deskLine', { type: 'boolean', default: true, title: 'Linha da mesa', description: 'Uma linha fina na cor da mesa ativa.', section: 'Janela', order: 10 })
const DIM = entry('ui.dimLevel', { type: 'string', default: 'medium', enum: ['weak', 'medium', 'strong'], enumLabels: ['Fraco', 'Médio', 'Forte'], title: 'Intensidade do escurecimento', section: 'Janela', order: 13 }, { configured: true, value: 'strong' })
const THEME = entry('theme', { type: 'string', default: 'auto', title: 'Tema', section: 'Tema', order: 0 })
const MINIMAP = entry('extensions.note.minimap', { type: 'boolean', default: true, title: 'Minimapa nos editores', description: 'Uma miniatura do arquivo à direita do editor.' }, { node: 'note', nodeTitle: 'Nota' })

describe('settings page rules', () => {
  test('settingKeyToDisplayFormat: words from camel case, › for dots, the group prefix trimmed', () => {
    assert.deepEqual(settingKeyToDisplayFormat('ui.deskLine'), { category: 'Ui', label: 'Desk Line' })
    assert.deepEqual(settingKeyToDisplayFormat('extensions.note.minimap', 'extensions.note'), { category: '', label: 'Minimap' })
    assert.deepEqual(settingKeyToDisplayFormat('editor.find.autoFindInSelection', 'editor'), { category: 'Find', label: 'Auto Find In Selection' })
    assert.deepEqual(settingKeyToDisplayFormat('theme'), { category: '', label: 'Theme' })
    assert.equal(settingTitle(DESK), 'Linha da mesa')
    assert.equal(settingTitle(entry('ui.fooBar', { type: 'boolean', default: false, title: '' })), 'Ui: Foo Bar')
  })

  test('parseQuery and the @modified tag', () => {
    assert.deepEqual(parseQuery('@modified mesa'), { query: 'mesa', modified: true, extensions: [] })
    assert.deepEqual(parseQuery('  linha   @ext:note '), { query: 'linha', modified: false, extensions: ['note'] })
    assert.equal(parseQuery('x@modified').modified, false)
    assert.equal(withModifiedTag('mesa', true), '@modified mesa ')
    assert.equal(withModifiedTag('@modified mesa ', false), 'mesa')
    assert.equal(withModifiedTag('', true), '@modified ')
  })

  test('isConfigured is the file having the key', () => {
    assert.equal(isConfigured(DESK), false)
    assert.equal(isConfigured(DIM), true)
  })

  test('matching: every word somewhere, accent-blind, title ranges for highlight', () => {
    const m = matchSetting('minimapa', MINIMAP)
    assert.ok(m)
    assert.deepEqual(m.title, [{ start: 0, end: 8 }])
    assert.ok(matchSetting('MINIMAPA editores', MINIMAP))
    assert.equal(matchSetting('minimapa', DESK), null)
    assert.ok(matchSetting('miniatura', MINIMAP), 'the description')
    assert.equal(matchSetting('miniatura', MINIMAP)!.score, 1)
    assert.ok(matchSetting('forte', DIM), 'an enum label')
    assert.ok(matchSetting('medio', DIM), 'accent-blind enum label')
    assert.ok(matchSetting('deskLine', DESK), 'the key as id')
    assert.ok(matchSetting('desk line', DESK), 'the key as words')
    assert.ok(matchSetting('ui.desk', DESK), 'a dotted id')
    assert.equal(matchSetting('linha zzz', DESK), null, 'one word missing fails')
    assert.deepEqual(matchSetting('', DESK), { score: 2, title: [], description: [], key: [] })
  })

  test('createValidator: number and integer with bounds; strings pass', () => {
    const n = createValidator({ type: 'number', default: 1, title: 'n', min: 0, max: 10 })
    assert.equal(n('5.5'), null)
    assert.equal(n('abc'), 'O valor precisa ser um número.')
    assert.equal(n(''), 'O valor precisa ser um número.')
    assert.equal(n('-1'), 'O valor precisa ser maior ou igual a 0.')
    assert.equal(n('11'), 'O valor precisa ser menor ou igual a 10.')
    const i = createValidator({ type: 'integer', default: 1, title: 'i' })
    assert.equal(i('3'), null)
    assert.equal(i('3.5'), 'O valor precisa ser um número inteiro.')
    assert.equal(createValidator({ type: 'string', default: '', title: 's' })('qualquer'), null)
    assert.equal(parseValue({ type: 'integer', default: 1, title: 'i' }, ' 42 '), 42)
    assert.equal(parseValue({ type: 'string', default: '', title: 's' }, ' a '), ' a ')
  })

  test('sections: by node then section in first-seen order; filter drops empty ones and honours @modified/@ext', () => {
    const secs = sectionsOf([THEME, DESK, DIM, MINIMAP])
    assert.deepEqual(secs.map(s => s.id), ['core/Tema', 'core/Janela', 'note/Nota'])
    assert.deepEqual(secs[1]!.entries.map(e => e.key), ['ui.deskLine', 'ui.dimLevel'])
    const f = filterSections(secs, 'minimapa')
    assert.deepEqual(f.sections.map(s => s.id), ['note/Nota'])
    assert.equal(f.count, 1)
    assert.deepEqual(filterSections(secs, '@modified').sections.map(s => s.entries.map(e => e.key)), [['ui.dimLevel']])
    assert.deepEqual(filterSections(secs, '@ext:note').sections.map(s => s.id), ['note/Nota'])
    assert.equal(filterSections(secs, '').count, 4)
  })
})
