// The system desks extensions contribute (`contributes.systemDesks`): the entry's validation, the registry (declare,
// collision, take back) and the contract every shipped manifest keeps (ids prefixed by the extension id).
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { SystemDeskRegistry, systemDeskProblems, type SystemDeskChange } from '../../app/renderer/system-desk-rules.ts'
import { manifest as framePads } from '../../extensions/frame-pads/manifest.ts'
import { manifest as explorer } from '../../extensions/explorer/manifest.ts'
import { manifest as note } from '../../extensions/note/manifest.ts'
import { manifest as webBridge } from '../../extensions/web-bridge/manifest.ts'
import { manifest as probe } from '../e2e/fixtures/system-desk-probe/manifest.ts'

describe('systemDeskProblems', () => {
  test('a valid entry has none, with or without icon and colour', () => {
    assert.deepEqual(systemDeskProblems('web', { id: 'web.main', title: 'Navegador' }), [])
    assert.deepEqual(systemDeskProblems('web', { id: 'web.main', title: 'Navegador', icon: 'globe-simple', color: 'green' }), [])
    assert.deepEqual(systemDeskProblems('my-ext', { id: 'my-ext.a.b', title: 'X' }), [])
  })
  test('malformed id, id of another extension, empty title and wrong types are refused', () => {
    assert.equal(systemDeskProblems('web', { id: 'Main', title: 'X' }).length, 1)
    assert.equal(systemDeskProblems('web', { id: 'main', title: 'X' }).length, 1) // no dot: not prefixed
    assert.equal(systemDeskProblems('web', { id: '__proto__', title: 'X' }).length, 1)
    assert.match(systemDeskProblems('web', { id: 'other.main', title: 'X' })[0]!, /deve começar com "web\."/)
    assert.match(systemDeskProblems('web', { id: 'web.main', title: '  ' })[0]!, /sem título/)
    assert.equal(systemDeskProblems('web', { id: 'web.main', title: 'X', icon: 3 }).length, 1)
    assert.equal(systemDeskProblems('web', { id: 'web.main', title: 'X', color: {} }).length, 1)
  })
  test('an unknown icon or colour name is not a problem (the pill and the desk fall back to their defaults)', () => {
    assert.deepEqual(systemDeskProblems('web', { id: 'web.main', title: 'X', icon: 'no-such-icon', color: 'no-such-hue' }), [])
  })
})

describe('SystemDeskRegistry', () => {
  test('declare lists the desk and fires add; the disposable takes it back and fires remove', () => {
    const reg = new SystemDeskRegistry()
    const seen: SystemDeskChange[] = []
    reg.onDidChange(c => seen.push(c))
    const d = reg.declare({ id: 'web.main', title: 'Navegador', extension: 'web' })
    assert.deepEqual(reg.all().map(x => x.id), ['web.main'])
    assert.equal(reg.get('web.main')?.title, 'Navegador')
    d.dispose()
    d.dispose() // idempotent
    assert.deepEqual(reg.all(), [])
    assert.deepEqual(seen.map(c => `${c.type}:${c.desk.id}`), ['add:web.main', 'remove:web.main'])
  })
  test('the same id twice is a collision; a malformed entry throws; neither changes the registry', () => {
    const reg = new SystemDeskRegistry()
    reg.declare({ id: 'web.main', title: 'A', extension: 'web' })
    assert.throws(() => reg.declare({ id: 'web.main', title: 'B', extension: 'web' }), /declarada duas vezes/)
    assert.throws(() => reg.declare({ id: 'other.main', title: 'B', extension: 'web' }), /deve começar com/)
    assert.deepEqual(reg.all().map(x => x.title), ['A'])
  })
  test('two extensions cannot collide: each id is prefixed by its owner', () => {
    const reg = new SystemDeskRegistry()
    reg.declare({ id: 'a.main', title: 'A', extension: 'a' })
    reg.declare({ id: 'b.main', title: 'B', extension: 'b' })
    assert.throws(() => reg.declare({ id: 'a.main', title: 'B', extension: 'b' }), /deve começar com/)
  })
  test('a declaration can come back after being taken back (an extension turned off and on)', () => {
    const reg = new SystemDeskRegistry()
    reg.declare({ id: 'web.main', title: 'A', extension: 'web' }).dispose()
    reg.declare({ id: 'web.main', title: 'A', extension: 'web' })
    assert.equal(reg.all().length, 1)
  })
})

describe('contracts', () => {
  test('every system desk a manifest declares is valid, prefixed by its extension, and unique across extensions', () => {
    const ids = new Set<string>()
    for (const m of [framePads, explorer, note, webBridge, probe]) for (const d of m.contributes?.systemDesks ?? []) {
      assert.deepEqual(systemDeskProblems(m.id, d), [], `${m.id}: ${d.id}`)
      assert.ok(!ids.has(d.id), `${d.id} declared twice`)
      ids.add(d.id)
    }
    assert.ok(ids.has('system-desk-probe.main'))
  })
})
