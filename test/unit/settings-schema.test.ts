import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CORE_SETTINGS } from '../../app/shared/core-settings.ts'
import { generateSettingsSchema } from '../../app/shared/settings-schema.ts'
import { ConfigurationRegistry } from '../../app/shared/vscode-configuration-registry.ts'

type Schema = { properties: Record<string, Record<string, unknown> & { properties?: Record<string, Record<string, unknown>> }> }

test('settings schema: only the dotted top-level keys, with the registry types (the flat shape of VS Code)', () => {
  const reg = new ConfigurationRegistry()
  reg.registerConfiguration(CORE_SETTINGS)
  reg.registerConfiguration({ id: 'note', title: 'Nota', properties: { minimap: { type: 'boolean', default: true, title: 'Minimapa' }, size: { type: 'integer', default: 3, min: 1, max: 9, title: 'Tamanho', description: 'x' } } })
  const s = generateSettingsSchema(reg.getConfigurationNodes()) as unknown as Schema
  assert.equal(s.properties['ui.deskLine']!.type, 'boolean')
  assert.equal(s.properties['extensions.note.minimap']!.default, true)
  const size = s.properties['extensions.note.size']!
  assert.deepEqual([size.minimum, size.maximum, size.description], [1, 9, 'Tamanho: x'])
  assert.equal(s.properties['extensions.disabled']!.type, 'array')
  assert.equal(s.properties['ui'], undefined)
  assert.equal(s.properties['extensions'], undefined)
})

test('the registry tells when a node comes or goes', () => {
  const reg = new ConfigurationRegistry()
  let n = 0
  reg.onDidChange(() => { n++ })
  const d = reg.registerConfiguration({ id: 'a', properties: { k: { type: 'boolean', default: false, title: 'K' } } })
  d.dispose()
  assert.equal(n, 2)
})
