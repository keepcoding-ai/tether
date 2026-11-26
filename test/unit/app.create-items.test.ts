// What a manager's "+ Novo" can make (app/renderer/create-items.ts, TetherUi.create.items): the chooser's own items as
// data — the profiles by engine with their profile id, args hint and unsafe/default marks, the extensions' chooser items
// (the note's) and the empty pane by item id —, the recent profiles first, and the folder the chooser would suggest.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Profile } from '../../src/daemon/protocol.ts'
import { chooserItemOf, chooserItems, contributeChooser } from '../../app/renderer/chooser-rules.ts'
import { createItemOf, createItemsOf } from '../../app/renderer/create-items.ts'
import { manifest as noteManifest } from '../../extensions/note/manifest.ts'
import { registerAgentUi } from '../../app/renderer/agent-ui.ts'
import { claudeUi } from '../../extensions/claude/ui.ts'

registerAgentUi(claudeUi)
const noteChooser = noteManifest.contributes!.chooser!
const withdraw = contributeChooser(noteChooser)

const PROFILES: Profile[] = [
  { id: 'claude', name: 'Claude', agent: 'claude', args: [], default: true },
  { id: 'claude-dev', name: 'Claude modo dev', agent: 'claude', args: ['--dangerously-skip-permissions'] },
  { id: 'powershell', name: 'PowerShell', agent: 'shell', args: ['-NoLogo'], default: true, cwd: 'D:\\work\\.tether\\x' },
] as Profile[]

describe('create items', () => {
  test('a profile: engine, profile id, the args hint, the marks, needs a folder, the suggested folder cut at .tether', () => {
    const items = createItemsOf(chooserItems(PROFILES, { empty: true }), [])
    const dev = items.find(i => i.id === 'claude-dev')!
    assert.deepEqual(dev, { id: 'claude-dev', kind: 'profile', group: 'claude', name: 'Claude modo dev', hint: '--dangerously-skip-permissions', icon: dev.icon, engine: 'claude', profileId: 'claude-dev', unsafe: true, needsFolder: true })
    const claude = items.find(i => i.id === 'claude')!
    assert.equal(claude.hint, undefined, 'the "sem argumentos" placeholder is not a hint')
    assert.equal(claude.default, true)
    const ps = items.find(i => i.id === 'powershell')!
    assert.equal(ps.engine, 'shell')
    assert.equal(ps.folder, 'D:\\work')
  })

  test("the extensions' items and the empty pane: by item id, no folder needed", () => {
    const items = createItemsOf(chooserItems(PROFILES, { empty: true }), [])
    const note = items.find(i => i.itemId === noteChooser.items[0]!.id)!
    assert.equal(note.kind, 'item')
    assert.equal(note.id, chooserItemOf(noteChooser.items[0]!).id)
    assert.equal(note.needsFolder, false)
    assert.equal(note.engine, undefined)
    const empty = items.at(-1)!
    assert.deepEqual([empty.kind, empty.itemId, empty.needsFolder], ['empty', 'empty', false])
  })

  test("the chooser's order, the recent profiles first in recency order and not repeated", () => {
    const chooser = chooserItems(PROFILES, { empty: true })
    assert.deepEqual(createItemsOf(chooser, []).map(i => i.id), chooser.map(i => i.id))
    const items = createItemsOf(chooser, ['powershell', 'gone', 'kind:empty', 'claude-dev'])
    assert.deepEqual(items.slice(0, 2).map(i => [i.id, i.recent]), [['powershell', true], ['claude-dev', true]])
    assert.equal(items.length, chooser.length)
    assert.equal(items.filter(i => i.recent).length, 2, 'only profiles count as recent')
  })

  test('an item withdrawn with its extension leaves the rows', () => {
    const before = createItemsOf(chooserItems(PROFILES, { empty: false }), []).length
    withdraw()
    const after = createItemsOf(chooserItems(PROFILES, { empty: false }), [])
    assert.equal(after.length, before - noteChooser.items.length)
    assert.ok(after.every(i => i.kind === 'profile'))
    contributeChooser(noteChooser)
  })

  test('createItemOf marks recent only when asked', () => {
    const one = chooserItems(PROFILES, { empty: false })[0]!
    assert.equal(createItemOf(one, false).recent, undefined)
    assert.equal(createItemOf(one, true).recent, true)
  })
})
