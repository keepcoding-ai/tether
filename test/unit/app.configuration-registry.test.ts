// The configuration registry generalized (app/shared/vscode-configuration-registry.ts): key = storage path, the core's node
// (app/shared/core-settings.ts) beside the extensions', page order, validation (enum, integer, bounds), reading the whole
// settings.json object, isConfigured; the core node agrees with the readers that stay (normalizeUi, normalizeTheme).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ConfigurationRegistry, isValidSetting, normalizeSetting, valueAt, type SettingSchema } from '../../app/shared/vscode-configuration-registry.ts'
import { CORE_SETTINGS } from '../../app/shared/core-settings.ts'
import { DEFAULT_UI, DIM_LEVELS, normalizeUi } from '../../app/shared/ui-settings.ts'
import { DEFAULT_THEME, normalizeTheme, THEME_SETTINGS } from '../../app/shared/theme.ts'
import { manifest as note } from '../../extensions/note/manifest.ts'
import { manifest as explorer } from '../../extensions/explorer/manifest.ts'
import { manifest as webBridge } from '../../extensions/web-bridge/manifest.ts'
import { manifest as browser } from '../../extensions/browser/manifest.ts'

const bool = (title: string, order?: number): SettingSchema => ({ type: 'boolean', default: true, title, ...(order !== undefined ? { order } : {}) })

function registry(): ConfigurationRegistry {
  const r = new ConfigurationRegistry()
  r.registerConfiguration({ id: 'note', title: 'Nota', properties: { wordWrap: bool('a', 2), minimap: bool('b', 1), lineNumbers: bool('c') } })
  r.registerConfiguration(CORE_SETTINGS)
  return r
}

test('a key is its storage path: the core at the top level, an extension under extensions.<id>', () => {
  const keys = Object.keys(registry().getConfigurationProperties())
  assert.ok(keys.includes('ui.deskLine') && keys.includes('theme'))
  assert.ok(keys.includes('extensions.note.minimap'))
  assert.ok(!keys.some(k => k.startsWith('note.')))
})

test('page order: nodes by order then registration; properties by order then key', () => {
  const keys = registry().properties().map(p => p.key)
  assert.deepEqual(keys, ['theme', 'ui.deskLine', 'ui.tabBorder', 'ui.dimUnfocused', 'ui.dimLevel', 'ui.fixedDeskLabel', 'ui.tabClose', 'extensions.note.minimap', 'extensions.note.wordWrap', 'extensions.note.lineNumbers'])
  assert.equal(registry().properties()[0]!.node, 'core')
})

test('readAt normalizes against the schema; isConfigured is whether the file holds the key', () => {
  const r = registry()
  const file = { ui: { deskLine: false, dimLevel: 'nope' }, extensions: { note: { minimap: false } } }
  assert.equal(r.readAt(file, 'ui.deskLine'), false)
  assert.equal(r.readAt({}, 'ui.deskLine'), true)
  assert.equal(r.readAt(file, 'ui.dimLevel'), 'medium')
  assert.equal(r.readAt(file, 'extensions.note.minimap'), false)
  assert.equal(r.readAt(file, 'unknown.key'), undefined)
  assert.ok(r.isConfigured(file, 'ui.deskLine'))
  assert.ok(r.isConfigured(file, 'ui.dimLevel'), 'an invalid value is still the person\'s')
  assert.ok(!r.isConfigured(file, 'ui.tabBorder'))
  assert.ok(!r.isConfigured({ ui: 3 }, 'ui.tabBorder'))
  assert.equal(valueAt({ a: { b: { c: 1 } } }, 'a.b.c'), 1)
})

test('the legacy extension accessors still answer by node id and relative key', () => {
  const r = registry()
  assert.equal(r.schemaOf('note', 'minimap')?.title, 'b')
  assert.equal(r.read({ disabled: [], values: { note: { minimap: false } } }, 'note', 'minimap'), false)
  assert.equal(r.schemaAt('extensions.note.minimap')?.title, 'b')
})

test('validation: enum, integer, bounds', () => {
  const int: SettingSchema = { type: 'integer', default: 3, min: 1, max: 10, title: 'n' }
  assert.ok(isValidSetting(int, 4))
  assert.ok(!isValidSetting(int, 4.5))
  assert.ok(!isValidSetting(int, 11))
  assert.equal(normalizeSetting(int, '4'), 3)
  const num: SettingSchema = { type: 'number', default: 1, title: 'x' }
  assert.ok(isValidSetting(num, 1.5))
  assert.ok(!isValidSetting(num, Number.NaN))
  const en: SettingSchema = { type: 'string', default: 'a', enum: ['a', 'b'], enumLabels: ['A', 'B'], title: 'e' }
  assert.ok(isValidSetting(en, 'b'))
  assert.ok(!isValidSetting(en, 'c'))
})

test('a duplicated node id or full key is refused; disposing frees it', () => {
  const r = registry()
  assert.throws(() => r.registerConfiguration({ id: 'note', properties: {} }))
  assert.throws(() => r.registerConfiguration({ id: 'other', prefix: 'ui', properties: { deskLine: bool('dup') } }))
  const d = r.registerConfiguration({ id: 'x', properties: { k: bool('k') } })
  assert.ok(r.schemaAt('extensions.x.k'))
  d.dispose()
  assert.equal(r.schemaAt('extensions.x.k'), undefined)
})

test('the core node agrees with normalizeUi and normalizeTheme (defaults, enums, every key)', () => {
  const r = new ConfigurationRegistry()
  r.registerConfiguration(CORE_SETTINGS)
  for (const k of Object.keys(DEFAULT_UI) as (keyof typeof DEFAULT_UI)[]) assert.equal(r.readAt({}, `ui.${k}`), DEFAULT_UI[k], k)
  assert.equal(r.readAt({}, 'theme'), DEFAULT_THEME)
  const dim = r.schemaAt('ui.dimLevel')
  assert.ok(dim?.type === 'string')
  assert.deepEqual(dim.enum, DIM_LEVELS)
  assert.equal(dim.enumLabels?.length, DIM_LEVELS.length)
  const th = r.schemaAt('theme')
  assert.ok(th?.type === 'string')
  assert.deepEqual(th.enum, THEME_SETTINGS)
  for (const sample of [{ deskLine: false, dimLevel: 'strong' }, { tabBorder: 'x', dimUnfocused: true }, {}]) {
    const ui = normalizeUi(sample)
    for (const k of Object.keys(ui) as (keyof typeof ui)[]) assert.equal(r.readAt({ ui: sample }, `ui.${k}`), ui[k], k)
  }
  for (const t of ['dark', 'nope', undefined]) assert.equal(r.readAt({ theme: t }, 'theme'), normalizeTheme(t))
  for (const p of r.properties()) assert.ok(p.schema.title && p.schema.description, `${p.key} has a title and a description`)
})

test('every extension setting declares a description, and enum labels match the enum', () => {
  for (const e of [note, explorer, webBridge, browser].map(manifest => ({ manifest }))) {
    for (const [k, s] of Object.entries(e.manifest.contributes?.settings ?? {})) {
      assert.ok(s.description, `${e.manifest.id}.${k}`)
      if (s.type === 'string' && s.enumLabels) assert.equal(s.enumLabels.length, s.enum?.length)
    }
  }
})
