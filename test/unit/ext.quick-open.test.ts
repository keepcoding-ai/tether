// Ctrl+P as the second extension (F9 slice 2): the manifest keeps the command id and the chord that keybindings.json and
// people's habits already name, and the extension's channels are on the bus under its id.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { manifest } from '../../extensions/quick-open/manifest.ts'
import { extChannel } from '../../app/shared/ext-ipc.ts'
import { resolvedDefaults, shortcutHint } from '../../app/renderer/shortcuts.ts'
import { withQuickOpenKeybindings } from './quick-open-extension.ts'

describe('quick-open extension manifest', () => {
  const c = manifest.contributes!

  test('declares the command and the Ctrl+P chord; both sides, optional', () => {
    assert.deepEqual(c.commands!.map(x => x.command), ['palette.quick-open'])
    assert.deepEqual(c.keybindings!.map(k => [k.key, k.command]), [['ctrl+p', 'palette.quick-open']])
    assert.deepEqual([...manifest.hosts], ['renderer', 'main'])
    assert.equal(manifest.optional, true)
  })

  test('the chord is not in the core table, only in what the extension contributes', () => {
    assert.ok(!resolvedDefaults(false).some(b => b.command === 'palette.quick-open'))
    withQuickOpenKeybindings()
    assert.equal(shortcutHint('palette.quick-open', false), 'Ctrl+P')
  })

  test('its channels live under ext:quick-open:', () => {
    for (const ch of ['search', 'refresh', 'end']) assert.equal(extChannel(manifest.id, ch), `ext:quick-open:${ch}`)
  })
})
