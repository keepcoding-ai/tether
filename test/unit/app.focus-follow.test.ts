// Keyboard focus follows the active dockview panel (app/renderer/focus-follow.ts), modelled with dockview's own rules:
// a panel that gets focus makes its group active, and `onDidActiveChange` fires only when a panel's state changes.
// Several activations inside one frame (a layout restore, panes activated in a row while frames are throttled) must
// leave the keyboard on the last one, and keystrokes typed afterwards must reach it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { followActive, type ActivePanelApi, type FrameFn } from '../../app/renderer/focus-follow.ts'

/** A dockview stand-in: panels, the active one, the focused one, and a frame queue run by hand. */
function dock(ids: string[], follow: (api: ActivePanelApi, focus: () => void, frame: FrameFn) => void) {
  let active: string | undefined
  let focused: string | undefined
  let frames: (() => void)[] = []
  const listeners = new Map<string, ((e: { isActive: boolean }) => void)[]>()
  const focusLog: string[] = []
  const frame: FrameFn = fn => { frames.push(fn) }
  const activate = (id: string): void => {
    if (active === id) return
    const before = active
    active = id
    if (before) for (const fn of listeners.get(before) ?? []) fn({ isActive: false })
    for (const fn of listeners.get(id) ?? []) fn({ isActive: true })
  }
  for (const id of ids) {
    const api: ActivePanelApi = {
      get isActive() { return active === id },
      onDidActiveChange(fn) { listeners.set(id, [...(listeners.get(id) ?? []), fn]); return { dispose() {} } },
    }
    // The pane's focus: the element takes the keyboard, and dockview activates the group that got focus.
    follow(api, () => { focused = id; focusLog.push(id); activate(id) }, frame)
  }
  return {
    activate,
    /** A click on the pane's terminal: the element takes the keyboard (and dockview activates its group). */
    click(id: string): void { focused = id; activate(id) },
    runFrame(): void { const run = frames; frames = []; for (const fn of run) fn() },
    get focused() { return focused },
    get active() { return active },
    get pendingFrames() { return frames.length },
    focusLog,
    /** A keystroke goes to whichever pane holds the keyboard at that instant. */
    type(text: string, into: Map<string, string>): void { for (const ch of text) into.set(focused!, (into.get(focused!) ?? '') + ch) },
  }
}

/** The follower as it was: focus on the next frame, whether or not the panel is still active then. */
function unguarded(api: ActivePanelApi, focus: () => void, frame: FrameFn): void {
  api.onDidActiveChange(({ isActive }) => { if (isActive) frame(() => focus()) })
}

test('the unguarded follower: two activations in one frame make the panes steal focus from each other forever', () => {
  const d = dock(['a', 'b', 'c', 'd'], unguarded)
  d.activate('a'); d.activate('b'); d.activate('c'); d.activate('d') // one frame: restore, or activations in a row
  for (let i = 0; i < 200; i++) d.runFrame()
  assert.ok(d.pendingFrames > 1, 'focus calls are still re-arming themselves after 200 frames')
  // The person picks pane a: every following frame still hands the keyboard to the other panes (which one holds it
  // when a key arrives depends on dockview's order of events; in the app E2E the keys of one pane ran in another).
  d.click('a')
  const before = d.focusLog.length
  for (let i = 0; i < 10; i++) d.runFrame()
  const after = d.focusLog.slice(before)
  assert.ok(after.filter(id => id !== 'a').length >= 10, `the keyboard left pane a on every frame (${after.join(' ')})`)
})

test('focus follows the last activation of a frame and settles: every keystroke reaches the active pane', () => {
  const d = dock(['a', 'b', 'c', 'd'], (api, focus, frame) => { followActive(api, focus, frame) })
  d.activate('a'); d.activate('b'); d.activate('c'); d.activate('d')
  d.runFrame()
  assert.equal(d.focused, 'd')
  assert.equal(d.active, 'd')
  assert.equal(d.pendingFrames, 0, 'no focus call left to steal the keyboard later')
  assert.deepEqual(d.focusLog, ['d'], 'stale activations never took the keyboard')
  d.click('a') // the person picks pane a and types
  const typed = new Map<string, string>()
  for (const ch of 'echo tether-101\r') { d.type(ch, typed); d.runFrame() }
  assert.deepEqual([...typed], [['a', 'echo tether-101\r']])
  assert.equal(d.pendingFrames, 0)
})

test('a click on another pane after the activations keeps the keyboard there', () => {
  const d = dock(['a', 'b', 'c'], (api, focus, frame) => { followActive(api, focus, frame) })
  d.activate('a'); d.activate('b'); d.activate('c')
  d.click('a') // before the frame runs
  for (let i = 0; i < 5; i++) d.runFrame()
  assert.equal(d.focused, 'a')
  assert.equal(d.pendingFrames, 0)
})
