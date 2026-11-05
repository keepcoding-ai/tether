// The rows of the "Extensões" screen (app/renderer/extensions-list.ts): every host's manifests merged by id, with state.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { extensionRows } from '../../app/renderer/extensions-list.ts'
import type { ExtensionManifest } from '../../extensions/types.ts'

const manifest = (id: string, extra: Partial<ExtensionManifest> = {}): ExtensionManifest => ({ id, version: '0.1.0', displayName: id.toUpperCase(), hosts: ['main'], ...extra })

describe('the "Extensões" screen rows', () => {
  test('merges hosts by id, marks disabled and failed, sorts by name', () => {
    const rows = extensionRows([
      { manifests: [manifest('note', { hosts: ['renderer', 'main'], displayName: 'Nota' }), manifest('zeta', { hosts: ['renderer'], displayName: 'Árvore' })], failed: [{ id: 'zeta', error: 'boom' }] },
      { manifests: [manifest('note', { hosts: ['renderer', 'main'], displayName: 'Nota' }), manifest('bridge', { displayName: 'Ponte', optional: true })], failed: [] },
    ], ['bridge'])
    assert.deepEqual(rows.map(r => [r.id, r.state, r.hosts.join('+'), r.optional]), [['zeta', 'failed', 'renderer', false], ['note', 'enabled', 'renderer+main', false], ['bridge', 'disabled', 'main', true]])
    assert.equal(rows[0]!.error, 'boom')
  })
})
