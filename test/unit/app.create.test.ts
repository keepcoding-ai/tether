// The two new-panel operations as pure data (app/renderer/create.ts): which chord means what, and what
// "Duplicar painel" sends to the daemon (same agent/folder/profile, never the session).
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { DIRECTIONS, duplicateRequest, PLACEMENT_LABEL, PLACEMENTS, positionOf, shortcutOf, type KeyLike } from '../../app/renderer/create.ts'
import type { Profile, SlotState } from '../../src/daemon/protocol.ts'

const key = (code: string, mods: Partial<KeyLike> = {}): KeyLike => ({ ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, code, ...mods })
const ctrlAlt = (code: string): KeyLike => key(code, { ctrlKey: true, altKey: true })
const ctrlShift = (code: string): KeyLike => key(code, { ctrlKey: true, shiftKey: true })

describe('shortcutOf', () => {
  test('Ctrl+Alt+Arrow duplicates beside the focused panel, in the arrow\'s direction', () => {
    assert.deepEqual(shortcutOf(ctrlAlt('ArrowLeft')), { op: 'duplicate', direction: 'left' })
    assert.deepEqual(shortcutOf(ctrlAlt('ArrowRight')), { op: 'duplicate', direction: 'right' })
    assert.deepEqual(shortcutOf(ctrlAlt('ArrowUp')), { op: 'duplicate', direction: 'above' })
    assert.deepEqual(shortcutOf(ctrlAlt('ArrowDown')), { op: 'duplicate', direction: 'below' })
  })

  test('Ctrl+Shift+T opens the chooser; D / E stay as the right / below duplicate aliases; Q quits all', () => {
    assert.deepEqual(shortcutOf(ctrlShift('KeyT')), { op: 'choose' })
    assert.deepEqual(shortcutOf(ctrlShift('KeyD')), { op: 'duplicate', direction: 'right' })
    assert.deepEqual(shortcutOf(ctrlShift('KeyE')), { op: 'duplicate', direction: 'below' })
    assert.deepEqual(shortcutOf(ctrlShift('KeyQ')), { op: 'quit-all' })
  })

  test('anything else stays with the terminal: plain keys, Ctrl alone, Shift+Alt chords, Win chords, Ctrl+Alt letters', () => {
    assert.equal(shortcutOf(key('ArrowRight')), undefined)
    assert.equal(shortcutOf(key('ArrowRight', { ctrlKey: true })), undefined, 'Ctrl+Arrow is word movement in the shell')
    assert.equal(shortcutOf(key('ArrowRight', { altKey: true })), undefined)
    assert.equal(shortcutOf(key('ArrowRight', { ctrlKey: true, altKey: true, shiftKey: true })), undefined, 'Ctrl+Alt+Shift+Arrow is the frame level (phase B)')
    assert.equal(shortcutOf(key('ArrowRight', { ctrlKey: true, metaKey: true })), undefined, 'Win chords are not ours')
    assert.equal(shortcutOf(key('ArrowRight', { ctrlKey: true, altKey: true, metaKey: true })), undefined)
    assert.equal(shortcutOf(ctrlAlt('KeyT')), undefined, 'Ctrl+Alt+letter may be AltGr on an ABNT2 keyboard')
    assert.equal(shortcutOf(ctrlShift('KeyC')), undefined, 'copy is the terminal\'s own')
    assert.equal(shortcutOf(key('KeyT', { ctrlKey: true, shiftKey: true, altKey: true })), undefined)
  })
})

describe('duplicateRequest', () => {
  const slot = (extra: Partial<SlotState> = {}): SlotState => ({
    slotId: 's1', kind: 'claude', cwd: 'D:\\atrium', status: 'running', pid: 123,
    binding: { sessionId: '11111111-2222-3333-4444-555555555555', cwd: 'D:\\atrium', confirmed: true } as SlotState['binding'],
    title: 'conversa', name: 'api', ...extra,
  })
  const profiles: Profile[] = [
    { id: 'claude', name: 'Claude', agent: 'claude', args: [], env: {}, default: true },
    { id: 'claude-dev', name: 'Claude modo dev', agent: 'claude', args: ['--dangerously-skip-permissions'], env: {} },
  ] as Profile[]

  test('same agent, folder and profile; no name and no binding (a new session, named by the daemon)', () => {
    assert.deepEqual(duplicateRequest(slot({ profileId: 'claude-dev', profileName: 'Claude modo dev', unsafe: true }), profiles),
      { t: 'create', kind: 'claude', cwd: 'D:\\atrium', start: true, profileId: 'claude-dev' })
  })

  test('a profile that no longer exists is not asked for (the daemon would refuse with unknown-profile)', () => {
    assert.deepEqual(duplicateRequest(slot({ profileId: 'gone' }), profiles), { t: 'create', kind: 'claude', cwd: 'D:\\atrium', start: true })
  })

  test('a panel without a profile duplicates without one; a shell keeps its kind', () => {
    assert.deepEqual(duplicateRequest(slot(), profiles), { t: 'create', kind: 'claude', cwd: 'D:\\atrium', start: true })
    assert.deepEqual(duplicateRequest(slot({ kind: 'shell', cwd: 'C:\\src', profileId: 'git-bash' }), profiles), { t: 'create', kind: 'shell', cwd: 'C:\\src', start: true })
  })
})

describe('placements', () => {
  test('every placement has a label and maps to a dockview position', () => {
    assert.deepEqual(PLACEMENTS, ['within', 'left', 'right', 'above', 'below'])
    assert.deepEqual(DIRECTIONS, ['left', 'right', 'above', 'below'])
    for (const p of PLACEMENTS) assert.ok(PLACEMENT_LABEL[p].length > 0, p)
    assert.deepEqual(positionOf('s1', 'below'), { referencePanel: 's1', direction: 'below' })
  })
})
