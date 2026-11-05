// The drawer's rules (app/renderer/drawer-rules.ts), pure: open/closed state and the focus given back, the Esc
// rule (who owns Esc inside the drawer), the folder of the default shell, the attention count; and its chords.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { CLOSED, closeDrawer, countAttention, DOUBLE_ESC_MS, escAction, focusAfterClose, openDrawer, quickCwd, toggleDrawer, type EscInput } from '../../app/renderer/drawer-rules.ts'
import { shortcutHint, shortcutOf } from '../../app/renderer/shortcuts.ts'

describe('drawer state', () => {
  test('opens remembering the pane in focus; the first memory stands while it is open', () => {
    const open = openDrawer(CLOSED, 'pane-a')
    assert.deepEqual(open, { open: true, returnTo: 'pane-a' })
    assert.equal(openDrawer(open, 'pane-b'), open, 'opening twice changes nothing')
  })

  test('closes keeping the memory for the focus to go back', () => {
    const closed = closeDrawer(openDrawer(CLOSED, 'pane-a'))
    assert.deepEqual(closed, { open: false, returnTo: 'pane-a' })
    assert.equal(closeDrawer(CLOSED), CLOSED)
  })

  test('toggle: closed → open → closed; a new opening remembers the new focus', () => {
    const a = toggleDrawer(CLOSED, 'x')
    assert.equal(a.open, true)
    const b = toggleDrawer(a, 'ignored')
    assert.equal(b.open, false)
    assert.equal(toggleDrawer(b, 'y').returnTo, 'y')
  })

  test('opening with no pane in focus remembers nothing', () => {
    assert.equal(openDrawer(CLOSED, undefined).returnTo, undefined)
  })

  test('the focus goes back to the remembered pane while it is on the desks, else to the fallback', () => {
    const onDesks = (id: string): boolean => id === 'a'
    assert.equal(focusAfterClose('a', onDesks, 'z'), 'a')
    assert.equal(focusAfterClose('gone', onDesks, 'z'), 'z', 'closed or moved into the drawer meanwhile')
    assert.equal(focusAfterClose(undefined, onDesks, 'z'), 'z')
    assert.equal(focusAfterClose(undefined, onDesks, undefined), undefined)
  })
})

describe('Esc inside the drawer', () => {
  const base: EscInput = { open: true, blocked: false, focus: { in: 'chrome' }, now: 1000, lastEsc: undefined }
  const shell = (programOwnsScreen = false): EscInput['focus'] => ({ in: 'terminal', kind: 'shell', programOwnsScreen })

  test('on the drawer chrome (header, empty drawer, buttons) one Esc closes', () => {
    assert.equal(escAction(base), 'close')
  })

  test('closed drawer, or a dialog / menu / field up: not the drawer\'s', () => {
    assert.equal(escAction({ ...base, open: false }), 'pass')
    assert.equal(escAction({ ...base, blocked: true }), 'pass')
    assert.equal(escAction({ ...base, blocked: true, focus: shell() }), 'pass')
  })

  test('an agent keeps every Esc, however many (Claude interrupts and rewinds with it)', () => {
    for (const kind of ['claude', 'soul'] as const) {
      const focus: EscInput['focus'] = { in: 'terminal', kind, programOwnsScreen: false }
      assert.equal(escAction({ ...base, focus }), 'pass')
      assert.equal(escAction({ ...base, focus, lastEsc: 990 }), 'pass', 'not even a quick second one')
    }
  })

  test('a shell at its prompt: the first Esc reaches the shell, a second one within the window closes', () => {
    assert.equal(escAction({ ...base, focus: shell() }), 'arm')
    assert.equal(escAction({ ...base, focus: shell(), lastEsc: 1000 - DOUBLE_ESC_MS }), 'close', 'at the edge of the window')
    assert.equal(escAction({ ...base, focus: shell(), lastEsc: 1000 - DOUBLE_ESC_MS - 1 }), 'arm', 'too slow: it is a first one again')
  })

  test('a shell running vim/less/htop (alternate screen or mouse mode) keeps its Esc', () => {
    assert.equal(escAction({ ...base, focus: shell(true) }), 'pass')
    assert.equal(escAction({ ...base, focus: shell(true), lastEsc: 999 }), 'pass')
  })
})

describe('the default shell of an empty drawer', () => {
  test('folder: the pane you came from, else the profile\'s, else the most recent one', () => {
    assert.equal(quickCwd({ paneCwd: 'D:\\a', profileCwd: 'D:\\b', recent: 'D:\\c' }), 'D:\\a')
    assert.equal(quickCwd({ profileCwd: 'D:\\b', recent: 'D:\\c' }), 'D:\\b')
    assert.equal(quickCwd({ paneCwd: '  ', profileCwd: '', recent: 'D:\\c' }), 'D:\\c')
    assert.equal(quickCwd({}), undefined)
  })
})

describe('attention of the drawer\'s panes', () => {
  test('counts the panes that finished and the ones that wait', () => {
    assert.deepEqual(countAttention([]), { done: 0, waiting: 0 })
    assert.deepEqual(countAttention(['done', undefined, 'waiting', 'done']), { done: 2, waiting: 1 })
  })
})

describe('the drawer chords', () => {
  const ev = (code: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}) => ({ code, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, altKey: !!mods.alt, metaKey: false })

  test('Ctrl+` toggles, and Ctrl+Shift+G is the alias; the hint shows the backquote', () => {
    assert.equal(shortcutOf(ev('Backquote', { ctrl: true })), 'drawer.toggle')
    assert.equal(shortcutOf(ev('KeyG', { ctrl: true, shift: true })), 'drawer.toggle')
    assert.equal(shortcutHint('drawer.toggle'), 'Ctrl+`')
  })

  test('a bare backquote, Alt or Win variants are the terminal\'s', () => {
    assert.equal(shortcutOf(ev('Backquote')), undefined)
    assert.equal(shortcutOf(ev('Backquote', { ctrl: true, alt: true })), undefined)
    assert.equal(shortcutOf({ ...ev('Backquote', { ctrl: true }), metaKey: true }), undefined)
  })
})
