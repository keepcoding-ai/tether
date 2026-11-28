// Panes suspended to save resources (app/renderer/suspend.ts): when the single sweep suspends a pane, how the person's use
// resumes it (her keys wait and go once the agent is up), the persistence across a reopening of the app, and how it stays
// apart from hibernation. Pure: no DOM, no daemon.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { deskMapOf } from '../../app/renderer/door/desk-map.ts'
import { emptyLayout, type DeskLayout, type Layout } from '../../app/renderer/layout.ts'
import { canSuspendNow, DEFAULT_SUSPEND, isBusyTurn, isMouseMotion, normalizeSuspend, RESUME_INPUT_MAX, ResumeInput, shouldSuspend, SuspendBook, sweepSuspend, SUSPEND_ENABLED_KEY, SUSPEND_IDLE_KEY, type SuspendCandidate } from '../../app/renderer/suspend.ts'
import { CORE_SETTINGS } from '../../app/shared/core-settings.ts'
import { parseDeskMap } from '../../src/daemon/door/desks.ts'
import type { SlotState } from '../../src/daemon/protocol.ts'

const MIN = 60_000
const NOW = Date.parse('2026-11-23T12:00:00Z')
const APP_START = NOW - 3 * 60 * MIN

/** An agent that is up, resumable and idle for two hours. */
function idleSlot(over: Partial<SlotState> = {}): SlotState {
  return { slotId: 'a1', kind: 'claude', cwd: '/w', status: 'running', canRestart: true, idleSince: new Date(NOW - 120 * MIN).toISOString(), ...over }
}
function candidate(over: Partial<SuspendCandidate> = {}, slot: Partial<SlotState> = {}): SuspendCandidate {
  return { slot: idleSlot(slot), lastUse: NOW - 120 * MIN, focused: false, asleep: false, suspended: false, ...over }
}
const suspends = (c: SuspendCandidate, settings = DEFAULT_SUSPEND): boolean => shouldSuspend(c, settings, NOW, APP_START)

describe('suspend: the criterion', () => {
  test('an agent idle beyond the limit, not used for as long, is suspended (default: on, 60 minutes)', () => {
    assert.deepEqual(DEFAULT_SUSPEND, { enabled: true, idleMinutes: 60 })
    assert.equal(suspends(candidate()), true)
    assert.equal(suspends(candidate({ lastUse: NOW - 60 * MIN }, { idleSince: new Date(NOW - 60 * MIN).toISOString() })), true, 'exactly the limit')
  })

  test('idle less than the limit, or used less than the limit ago, is not', () => {
    assert.equal(suspends(candidate({}, { idleSince: new Date(NOW - 59 * MIN).toISOString() })), false)
    assert.equal(suspends(candidate({ lastUse: NOW - 10 * MIN })), false)
    assert.equal(suspends(candidate({}, { idleSince: undefined })), false, 'no idleSince: not known to be idle')
  })

  test('an unknown last use counts from the app opening (a fresh app never suspends right away)', () => {
    assert.equal(shouldSuspend(candidate({ lastUse: undefined }), DEFAULT_SUSPEND, NOW, NOW - 5 * MIN), false)
    assert.equal(shouldSuspend(candidate({ lastUse: undefined }), DEFAULT_SUSPEND, NOW, NOW - 61 * MIN), true)
  })

  test('a busy turn, background subagents or an open permission card are never suspended', () => {
    assert.equal(suspends(candidate({}, { turn: 'busy' })), false)
    assert.equal(suspends(candidate({}, { background: 2 })), false)
    assert.equal(suspends(candidate({}, { attention: 'waiting' })), false)
    assert.equal(suspends(candidate({}, { attentionFor: { slotId: 'o1', value: 'waiting' } })), false, 'a card waiting for an agent owner too')
    assert.equal(suspends(candidate({}, { attention: 'done' })), true, 'a finished turn is idle')
  })

  test('the pane with the focus is never suspended', () => {
    assert.equal(suspends(candidate({ focused: true })), false)
  })

  test('the switch off suspends nothing; the limit follows the setting', () => {
    assert.equal(suspends(candidate(), { enabled: false, idleMinutes: 60 }), false)
    assert.deepEqual(sweepSuspend([candidate()], { enabled: false, idleMinutes: 60 }, NOW, APP_START), [])
    assert.equal(suspends(candidate({ lastUse: NOW - 30 * MIN }, { idleSince: new Date(NOW - 30 * MIN).toISOString() }), { enabled: true, idleMinutes: 20 }), true)
  })

  test('only an agent that can resume its session in place: not a shell, not one starting, stopping or with no reported session', () => {
    assert.equal(suspends(candidate({}, { kind: 'shell' })), false)
    assert.equal(suspends(candidate({}, { status: 'starting' })), false)
    assert.equal(suspends(candidate({}, { stopping: true })), false)
    assert.equal(suspends(candidate({}, { restarting: true })), false)
    assert.equal(suspends(candidate({}, { canRestart: undefined })), false, 'a session never reported would come back unconfirmed')
  })

  test('hibernated or already suspended panes are left alone; one sweep picks every pane that qualifies', () => {
    assert.equal(suspends(candidate({ asleep: true })), false)
    assert.equal(suspends(candidate({ suspended: true })), false)
    const ids = sweepSuspend([candidate({}, { slotId: 'x1' }), candidate({ focused: true }, { slotId: 'x2' }), candidate({}, { slotId: 'x3', turn: 'busy' }), candidate({}, { slotId: 'x4' })], DEFAULT_SUSPEND, NOW, APP_START)
    assert.deepEqual(ids, ['x1', 'x4'])
  })
})

describe('suspend: the settings', () => {
  test('read from settings.json with defaults and bounds', () => {
    const get = (values: Record<string, unknown>) => (key: string) => values[key]
    assert.deepEqual(normalizeSuspend(get({})), DEFAULT_SUSPEND)
    assert.deepEqual(normalizeSuspend(get({ [SUSPEND_ENABLED_KEY]: false, [SUSPEND_IDLE_KEY]: 30 })), { enabled: false, idleMinutes: 30 })
    assert.equal(normalizeSuspend(get({ [SUSPEND_IDLE_KEY]: 1 })).idleMinutes, 5, 'never below 5 minutes')
    assert.equal(normalizeSuspend(get({ [SUSPEND_IDLE_KEY]: 'x', [SUSPEND_ENABLED_KEY]: 'yes' })).enabled, true)
  })

  test('the switch and the limit are on the settings page (core settings, "Desempenho"), on by default', () => {
    const enabled = CORE_SETTINGS.properties[SUSPEND_ENABLED_KEY]!
    const idle = CORE_SETTINGS.properties[SUSPEND_IDLE_KEY]!
    assert.equal(enabled.type, 'boolean')
    assert.equal(enabled.default, true)
    assert.equal(idle.default, 60)
    assert.equal(enabled.section, 'Desempenho')
  })
})

describe('suspend: resuming by the person', () => {
  test('her first key resumes the pane and is held; more keys while it resumes are held in order; all go once the agent is up', () => {
    const book = new SuspendBook()
    book.suspend('a1')
    const first = book.userInput('a1', 'ol')
    assert.deepEqual(first, { changed: false, held: true, resume: true })
    assert.deepEqual(book.userInput('a1', 'á\r'), { changed: false, held: true }, 'no second start')
    // The slot comes up: stopped → starting clears the suspension (layout saved); running hands the keys back.
    const starting = book.stateChanged(idleSlot({ status: 'exited' }), idleSlot({ status: 'starting' }))
    assert.deepEqual(starting, { changed: true })
    assert.equal(book.has('a1'), false)
    assert.equal(book.isResuming('a1'), true)
    assert.deepEqual(book.userInput('a1', '!'), { changed: false, held: true }, 'still held while the agent starts')
    assert.deepEqual(book.stateChanged(idleSlot({ status: 'starting' }), idleSlot({ status: 'running' })), { changed: false, flush: 'olá\r!' })
    assert.deepEqual(book.userInput('a1', 'x'), { changed: false, held: false }, 'up: keys go straight to the pane')
  })

  test('a click or a scroll resumes it too (once); a pane that is not suspended is untouched', () => {
    const book = new SuspendBook()
    assert.deepEqual(book.use('a1'), { changed: false })
    assert.deepEqual(book.userInput('a1', 'x'), { changed: false, held: false })
    book.suspend('a1')
    assert.deepEqual(book.use('a1'), { changed: false, resume: true })
    assert.deepEqual(book.use('a1'), { changed: false })
  })

  test('a refused resume drops the held keys and the pane shows the error like any stopped pane', () => {
    const book = new SuspendBook()
    book.suspend('a1')
    book.userInput('a1', 'texto')
    assert.deepEqual(book.stateChanged(idleSlot({ status: 'exited' }), idleSlot({ status: 'unconfirmed' })), { changed: true })
    assert.equal(book.isResuming('a1'), false)
    assert.equal(book.has('a1'), false)
  })

  test('a resume started from outside (the daemon, for a delivery) clears the suspension on the same edge', () => {
    const book = new SuspendBook()
    book.suspend('a1')
    assert.deepEqual(book.stateChanged(idleSlot({ status: 'exited' }), idleSlot({ status: 'starting' })), { changed: true })
    assert.deepEqual(book.stateChanged(idleSlot({ status: 'starting' }), idleSlot({ status: 'running' })), { changed: false })
  })

  test('the suspension stop itself (running → stopping → exited) does not resume it', () => {
    const book = new SuspendBook()
    book.suspend('a1')
    book.stateChanged(idleSlot(), idleSlot({ stopping: true }))
    book.stateChanged(idleSlot({ stopping: true }), idleSlot({ status: 'exited' }))
    assert.equal(book.has('a1'), true)
  })

  test('the held input is capped, never reordered', () => {
    const held = new ResumeInput()
    held.hold('a1', 'a'.repeat(RESUME_INPUT_MAX - 2))
    held.hold('a1', 'bcd')
    held.hold('a1', 'e')
    assert.equal(held.take('a1'), `${'a'.repeat(RESUME_INPUT_MAX - 2)}bc`)
    assert.equal(held.take('a1'), undefined)
  })
})

describe('suspend: persistence and the desk map', () => {
  test('saved in the layout and loaded back when the app reopens: still suspended (it only comes up when used)', () => {
    const book = new SuspendBook()
    book.suspend('a1'); book.suspend('a2')
    const saved = book.toLayout()
    assert.deepEqual(saved, ['a1', 'a2'])
    const reopened = new SuspendBook()
    reopened.load(saved, id => id !== 'a2') // a2's slot is gone
    assert.equal(reopened.has('a1'), true)
    assert.equal(reopened.has('a2'), false)
    assert.equal(new SuspendBook().toLayout(), undefined, 'nothing suspended: the key stays out of the file')
  })

  test('the desk map marks a suspended pane, and the daemon keeps the mark', () => {
    const layout: Layout = { ...emptyLayout(), desks: [desk('d1', { a1: 'terminal', a2: 'terminal' })], activeDesk: 'd1', suspendedPanes: ['a1'] }
    const map = deskMapOf(layout, c => c)
    assert.deepEqual(map.desks[0]!.panes, [{ id: 'a1', type: 'terminal', suspended: true }, { id: 'a2', type: 'terminal' }])
    assert.deepEqual(parseDeskMap(JSON.parse(JSON.stringify(map)))!.desks[0]!.panes[0], { id: 'a1', type: 'terminal', suspended: true })
  })
})

describe('suspend: apart from hibernation', () => {
  test('hibernating a suspended pane makes it hibernated (not suspended any more): its wake stays explicit', () => {
    const book = new SuspendBook()
    book.suspend('a1')
    book.userInput('a1', 'x')
    assert.deepEqual(book.hibernated('a1'), { changed: true })
    assert.equal(book.has('a1'), false)
    assert.equal(book.isResuming('a1'), false)
    assert.deepEqual(book.use('a1'), { changed: false }, 'use does not wake a hibernated pane')
  })

  test('a hibernated pane is never suspended, and the map says asleep, not suspended, for a pane in both lists', () => {
    assert.equal(suspends(candidate({ asleep: true })), false)
    const layout: Layout = { ...emptyLayout(), desks: [desk('d1', { a1: 'terminal' })], activeDesk: 'd1', asleepPanes: ['a1'], suspendedPanes: ['a1'] }
    assert.deepEqual(deskMapOf(layout, c => c).desks[0]!.panes, [{ id: 'a1', type: 'terminal', asleep: true }])
  })

  test('suspending leaves the hibernation state of other panes alone (two separate sets)', () => {
    const book = new SuspendBook()
    book.load(['a1'], () => true)
    assert.deepEqual(book.hibernated('a2'), { changed: false })
    assert.equal(book.has('a1'), true)
  })
})

function desk(id: string, panes: Record<string, string>): DeskLayout {
  return { id, name: id, color: 'blue', frames: { grid: {}, views: { f1: { grid: {}, panels: Object.fromEntries(Object.entries(panes).map(([pid, c]) => [pid, { id: pid, contentComponent: c }])), activeGroup: 'g' } } } } as unknown as DeskLayout
}

describe('suspend: by hand (menu, palette, owner)', () => {
  const slot = (o: Partial<SlotState> = {}): SlotState => ({ slotId: 's1', kind: 'claude', status: 'running', canRestart: true, ...o }) as SlotState

  test('only a running agent that resumes in place, not hibernated or suspended, may be suspended by hand; a busy turn is allowed (it is only asked)', () => {
    assert.equal(canSuspendNow(slot(), false, false), true)
    assert.equal(canSuspendNow(slot({ turn: 'busy' }), false, false), true)
    assert.equal(isBusyTurn(slot({ turn: 'busy' })), true)
    assert.equal(isBusyTurn(slot({ background: 1 })), true)
    assert.equal(isBusyTurn(slot()), false)
    assert.equal(canSuspendNow(undefined, false, false), false)
    assert.equal(canSuspendNow(slot({ kind: 'shell' }), false, false), false)
    assert.equal(canSuspendNow(slot({ canRestart: false }), false, false), false)
    assert.equal(canSuspendNow(slot({ status: 'exited' }), false, false), false)
    assert.equal(canSuspendNow(slot({ restarting: true }), false, false), false)
    assert.equal(canSuspendNow(slot(), true, false), false)
    assert.equal(canSuspendNow(slot(), false, true), false)
  })

  test('suspendNow sets the same state as the sweep: resumes on use and survives in the layout', () => {
    const book = new SuspendBook()
    assert.deepEqual(book.suspendNow('s1'), { changed: true })
    assert.deepEqual(book.suspendNow('s1'), { changed: false })
    assert.equal(book.has('s1'), true)
    assert.deepEqual(book.toLayout(), ['s1'])
    assert.equal(book.use('s1').resume, true)
    const again = new SuspendBook()
    again.load(book.toLayout(), () => true)
    assert.equal(again.has('s1'), true)
  })
})

describe('suspend: "Não suspender"', () => {
  const slot = (o: Partial<SlotState> = {}): SlotState => ({ slotId: 's1', kind: 'claude', status: 'running', canRestart: true, ...o }) as SlotState

  test('the sweep skips a marked pane, whatever its idleness', () => {
    assert.equal(suspends(candidate({ noSuspend: true })), false)
    const ids = sweepSuspend([candidate({ noSuspend: true }, { slotId: 'x1' }), candidate({}, { slotId: 'x2' })], DEFAULT_SUSPEND, NOW, APP_START)
    assert.deepEqual(ids, ['x2'])
  })

  test('canSuspendNow is false for a marked pane (menu and palette lose "Suspender guia")', () => {
    assert.equal(canSuspendNow(slot(), false, false, false), true)
    assert.equal(canSuspendNow(slot(), false, false, true), false)
  })

  test('the mark persists in the layout, drops gone panes, and stays out of the file when empty', () => {
    const book = new SuspendBook()
    assert.equal(book.noSuspendToLayout(), undefined)
    book.setNoSuspend('a1', true); book.setNoSuspend('a2', true)
    const saved = book.noSuspendToLayout()
    assert.deepEqual(saved, ['a1', 'a2'])
    const reopened = new SuspendBook()
    reopened.loadNoSuspend(saved, id => id !== 'a2')
    assert.equal(reopened.isNoSuspend('a1'), true)
    assert.equal(reopened.isNoSuspend('a2'), false)
    assert.equal(reopened.setNoSuspend('a1', false).changed, true)
    assert.equal(reopened.noSuspendToLayout(), undefined)
  })

  test('marking a suspended pane resumes it; marking a live one only saves; the same mark again does nothing', () => {
    const book = new SuspendBook()
    book.suspend('a1')
    assert.deepEqual(book.setNoSuspend('a1', true), { changed: true, resume: true })
    assert.deepEqual(book.setNoSuspend('a1', true), { changed: false })
    assert.deepEqual(book.setNoSuspend('a2', true), { changed: true })
  })

  test('the desk map carries the mark (with or without another seal) and the daemon keeps it', () => {
    const layout: Layout = { ...emptyLayout(), desks: [desk('d1', { a1: 'terminal', a2: 'terminal' })], activeDesk: 'd1', noSuspendPanes: ['a1'], suspendedPanes: ['a2'] }
    const map = deskMapOf(layout, c => c)
    assert.deepEqual(map.desks[0]!.panes, [{ id: 'a1', type: 'terminal', noSuspend: true }, { id: 'a2', type: 'terminal', suspended: true }])
    assert.deepEqual(parseDeskMap(JSON.parse(JSON.stringify(map)))!.desks[0]!.panes[0], { id: 'a1', type: 'terminal', noSuspend: true })
  })
})

describe('suspend: mouse movement is not use', () => {
  const sgr = (b: number, x = 10, y = 4, end = 'M'): string => `\x1b[<${b};${x};${y}${end}`
  const x10 = (b: number, x = 10, y = 4): string => '\x1b[M' + String.fromCharCode(b + 32, x + 32, y + 32)

  test('SGR and X10 movement (no button, or dragging) is motion', () => {
    assert.equal(isMouseMotion(sgr(35)), true, 'hover, no button')
    assert.equal(isMouseMotion(sgr(32)), true, 'move with the left button down')
    assert.equal(isMouseMotion(sgr(43)), true, 'hover with a modifier (shift)')
    assert.equal(isMouseMotion(x10(35)), true)
    assert.equal(isMouseMotion(x10(32)), true)
    assert.equal(isMouseMotion(sgr(35) + sgr(35, 11) + x10(35)), true, 'several reports in one chunk')
  })

  test('clicks, releases and the wheel are not motion', () => {
    assert.equal(isMouseMotion(sgr(0)), false, 'left press')
    assert.equal(isMouseMotion(sgr(0, 10, 4, 'm')), false, 'left release')
    assert.equal(isMouseMotion(sgr(2)), false, 'right press')
    assert.equal(isMouseMotion(sgr(64)), false, 'wheel up')
    assert.equal(isMouseMotion(sgr(65)), false, 'wheel down')
    assert.equal(isMouseMotion(x10(0)), false)
    assert.equal(isMouseMotion(x10(64)), false)
    assert.equal(isMouseMotion(sgr(35) + sgr(0)), false, 'a click among movements is use')
  })

  test('keys and paste are not motion', () => {
    for (const d of ['a', '\r', '\x1b', '\x1b[A', '\x1b[I', '\x1b[200~hello\x1b[201~', '\x1b[<35;1;1M text', 'oi', '']) assert.equal(isMouseMotion(d), false, JSON.stringify(d))
  })

  test('motion the pane drops while suspended never reaches the held input; a click still resumes', () => {
    const book = new SuspendBook()
    book.load(['a1'], () => true)
    // the panel drops motion before takeInput; the book only ever sees what is use
    const typed = ['\x1b[<35;5;5M', 'x'].filter(d => !isMouseMotion(d))
    const o = book.userInput('a1', typed.join(''))
    assert.equal(o.resume, true)
    assert.equal(book.stateChanged({ slotId: 'a1', kind: 'claude', cwd: '/w', status: 'exited' }, { slotId: 'a1', kind: 'claude', cwd: '/w', status: 'running' }).flush, 'x')
  })
})
