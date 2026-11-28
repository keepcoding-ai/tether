// The slot's intent (SlotState.want) as the source of the app's hibernated/suspended marks (app/renderer/slot-want.ts): the
// migration of an old layout's marks to the slots (one set-want each), the marks a state brings, and which panes the app still
// starts on its own (legacy slots only). Pure: no DOM, no daemon.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { appStartsPane, reconcileLayoutWants, wantMark } from '../../app/renderer/slot-want.ts'
import type { SlotState } from '../../src/daemon/protocol.ts'

const slot = (slotId: string, over: Partial<SlotState> = {}): SlotState => ({ slotId, kind: 'claude', cwd: '/w', status: 'exited', ...over })
const mapOf = (...ss: SlotState[]): Map<string, SlotState> => new Map(ss.map(s => [s.slotId, s]))

describe('slot want: migration of an old layout', () => {
  test('a layout mark whose slot has no want (legacy) or another want is sent once as set-want; a matching one is not', () => {
    const slots = mapOf(
      slot('legacy-asleep'),
      slot('ended-asleep', { want: 'ended' }),
      slot('legacy-susp'),
      slot('run-susp', { want: 'run' }),
      slot('same-asleep', { want: 'asleep' }),
      slot('same-susp', { want: 'suspended' }),
    )
    const r = reconcileLayoutWants(slots, ['legacy-asleep', 'ended-asleep', 'same-asleep', 'gone'], ['legacy-susp', 'run-susp', 'same-susp'])
    assert.deepEqual(r.migrate, [
      { slotId: 'legacy-asleep', want: 'asleep' },
      { slotId: 'ended-asleep', want: 'asleep' },
      { slotId: 'legacy-susp', want: 'suspended' },
      { slotId: 'run-susp', want: 'suspended' },
    ])
    assert.deepEqual([...r.asleep].sort(), ['ended-asleep', 'legacy-asleep', 'same-asleep'])
    assert.deepEqual([...r.suspended].sort(), ['legacy-susp', 'run-susp', 'same-susp'])
  })

  test('once migrated (the slots now carry the marks), loading again sends nothing', () => {
    const slots = mapOf(slot('a', { want: 'asleep' }), slot('s', { want: 'suspended' }))
    assert.deepEqual(reconcileLayoutWants(slots, ['a'], ['s']).migrate, [])
  })

  test('hibernated wins over suspended in the layout, as the app always read it', () => {
    const r = reconcileLayoutWants(mapOf(slot('x')), ['x'], ['x'])
    assert.deepEqual(r.migrate, [{ slotId: 'x', want: 'asleep' }])
    assert.equal(r.suspended.has('x'), false)
  })

  test('a slot whose want is asleep/suspended gets the mark even when the layout lacks it (the daemon rules)', () => {
    const r = reconcileLayoutWants(mapOf(slot('a', { want: 'asleep' }), slot('s', { want: 'suspended' }), slot('r', { want: 'run' })), [], [])
    assert.deepEqual([...r.asleep], ['a'])
    assert.deepEqual([...r.suspended], ['s'])
    assert.deepEqual(r.migrate, [])
  })

  test('a live slot is never told to sleep while it runs', () => {
    const r = reconcileLayoutWants(mapOf(slot('live', { status: 'running', want: 'run' })), ['live'], [])
    assert.deepEqual(r.migrate, [])
  })
})

describe('slot want: the marks a state brings', () => {
  test('a stopped slot follows its intent: asleep, suspended', () => {
    assert.equal(wantMark(slot('a', { status: 'running', want: 'run' }), slot('a', { want: 'asleep' })), 'asleep')
    assert.equal(wantMark(undefined, slot('a', { want: 'suspended' })), 'suspended')
  })

  test('a live slot changes nothing (a stop may be on its way; waking is the live edge)', () => {
    assert.equal(wantMark(slot('a'), slot('a', { status: 'running', want: 'asleep' })), undefined)
    assert.equal(wantMark(slot('a', { want: 'asleep' }), slot('a', { status: 'starting', want: 'run' })), undefined)
  })

  test('awake only when the intent turned to run/ended; an unchanged intent keeps the pane mark', () => {
    assert.equal(wantMark(slot('a', { want: 'asleep' }), slot('a', { want: 'ended' })), 'awake')
    assert.equal(wantMark(slot('a', { want: 'suspended' }), slot('a', { want: 'run' })), 'awake')
    assert.equal(wantMark(slot('a', { want: 'run' }), slot('a', { want: 'run' })), undefined)
    assert.equal(wantMark(undefined, slot('a', { want: 'ended' })), undefined)
  })

  test('a legacy slot (no want) leaves the layout in charge', () => {
    assert.equal(wantMark(slot('a'), slot('a')), undefined)
  })
})

describe('slot want: the app starts only legacy panes', () => {
  test('legacy, exited, awake: started; with a want: the daemon relaunched it at boot', () => {
    assert.equal(appStartsPane(slot('a'), false, false, true), true)
    assert.equal(appStartsPane(slot('a', { want: 'run' }), false, false, true), false)
    assert.equal(appStartsPane(slot('a', { want: 'ended' }), false, false, true), false)
  })

  test('hibernated, suspended, live or missing: never', () => {
    assert.equal(appStartsPane(slot('a'), true, false, true), false)
    assert.equal(appStartsPane(slot('a'), false, true, true), false)
    assert.equal(appStartsPane(slot('a'), false, false, false), false)
    assert.equal(appStartsPane(undefined, false, false, true), false)
  })
})
