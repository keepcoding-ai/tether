// The two new-panel operations as pure data (app/renderer/create.ts): which chord means what, and what
// "Duplicar painel" sends to the daemon (same agent/folder/profile, never the session).
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { DIRECTIONS, duplicateRequest, PLACEMENT_LABEL, PLACEMENTS, positionOf, shortcutOf, targetKey, targetOf, TARGETS, type KeyLike } from '../../app/renderer/create.ts'
import type { Profile, SlotState } from '../../src/daemon/protocol.ts'

const key = (code: string, mods: Partial<KeyLike> = {}): KeyLike => ({ ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, code, ...mods })
const ctrlAlt = (code: string): KeyLike => key(code, { ctrlKey: true, altKey: true })
const ctrlShift = (code: string): KeyLike => key(code, { ctrlKey: true, shiftKey: true })
const ctrlAltShift = (code: string): KeyLike => key(code, { ctrlKey: true, altKey: true, shiftKey: true })
const altShift = (code: string): KeyLike => key(code, { altKey: true, shiftKey: true })

describe('shortcutOf', () => {
  test('Ctrl+Alt+Arrow duplicates beside the focused pane, in the arrow\'s direction', () => {
    assert.equal(shortcutOf(ctrlAlt('ArrowLeft')), 'pane.duplicate.pane.left')
    assert.equal(shortcutOf(ctrlAlt('ArrowRight')), 'pane.duplicate.pane.right')
    assert.equal(shortcutOf(ctrlAlt('ArrowUp')), 'pane.duplicate.pane.above')
    assert.equal(shortcutOf(ctrlAlt('ArrowDown')), 'pane.duplicate.pane.below')
  })

  test('Ctrl+Alt+Shift+Arrow duplicates at the frame\'s edge; Alt+Shift+Arrow into a new frame at the desk\'s edge', () => {
    assert.equal(shortcutOf(ctrlAltShift('ArrowRight')), 'pane.duplicate.frame.right')
    assert.equal(shortcutOf(ctrlAltShift('ArrowDown')), 'pane.duplicate.frame.below')
    assert.equal(shortcutOf(altShift('ArrowLeft')), 'pane.duplicate.desk.left')
    assert.equal(shortcutOf(altShift('ArrowUp')), 'pane.duplicate.desk.above')
  })

  test('Ctrl+Shift+T reopens the last closed pane; Ctrl+\ is the duplicate alias (Ctrl+Shift+D / E are gone); Q quits all', () => {
    assert.equal(shortcutOf(ctrlShift('KeyT')), 'pane.reopen-closed', 'Ctrl+Shift+T reopens the last closed pane (delivery 5); Ctrl+N is the new tab')
    assert.equal(shortcutOf(ctrlShift('KeyD')), undefined, 'Ctrl+Shift+D is gone (VS Code: Run); Ctrl+\ is the alias now')
    assert.equal(shortcutOf(key('Backslash', { ctrlKey: true })), 'pane.duplicate.pane.right')
    assert.equal(shortcutOf(ctrlShift('KeyQ')), 'app.quit-all')
  })

  test('anything else stays with the terminal: plain keys, Ctrl alone, Alt alone, Win chords, Ctrl+Alt letters', () => {
    assert.equal(shortcutOf(key('ArrowRight')), undefined)
    assert.equal(shortcutOf(key('ArrowRight', { ctrlKey: true })), undefined, 'Ctrl+Arrow is word movement in the shell')
    assert.equal(shortcutOf(key('ArrowRight', { altKey: true })), undefined)
    assert.equal(shortcutOf(key('ArrowRight', { shiftKey: true })), undefined, 'Shift+Arrow selects in the TUI')
    assert.equal(shortcutOf(key('ArrowRight', { ctrlKey: true, metaKey: true })), undefined, 'Win chords are not ours')
    assert.equal(shortcutOf(key('ArrowRight', { ctrlKey: true, altKey: true, metaKey: true })), undefined)
    assert.equal(shortcutOf(key('ArrowRight', { altKey: true, shiftKey: true, metaKey: true })), undefined)
    assert.equal(shortcutOf(ctrlAlt('KeyT')), undefined, 'Ctrl+Alt+letter may be AltGr on an ABNT2 keyboard')
    assert.equal(shortcutOf(ctrlShift('KeyC')), undefined, 'copy is the terminal\'s own')
    assert.equal(shortcutOf(key('KeyT', { ctrlKey: true, shiftKey: true, altKey: true })), undefined)
    assert.equal(shortcutOf(altShift('KeyN')), undefined)
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

  test('targets: "within" only at the pane level; keys round-trip; unknown keys are nothing', () => {
    assert.deepEqual(TARGETS.map(targetKey), [
      'pane:within', 'pane:left', 'pane:right', 'pane:above', 'pane:below',
      'frame:left', 'frame:right', 'frame:above', 'frame:below',
      'desk:left', 'desk:right', 'desk:above', 'desk:below',
    ])
    assert.deepEqual(targetOf('frame:below'), { level: 'frame', placement: 'below' })
    assert.equal(targetOf('frame:within'), undefined)
    assert.equal(targetOf(undefined), undefined)
  })
})
