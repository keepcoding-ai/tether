import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeOsNotify, OsNotifyRules, toastFor } from '../../app/shared/os-notify.ts'
import type { SlotState } from '../../src/daemon/protocol.ts'

const slot = (attention?: 'done' | 'waiting', slotId = 's1'): SlotState => ({ slotId, status: 'running', ...(attention ? { attention } : {}) }) as SlotState

test('toast only when attention rises and the window is not focused', () => {
  const r = new OsNotifyRules()
  r.seed(slot())
  assert.equal(r.apply(slot('done'), 'A', 'all', true), undefined, 'focused: the seal is enough')
  r.apply(slot(), 'A', 'all', false)
  assert.deepEqual(r.apply(slot('done'), 'A', 'all', false), { slotId: 's1', label: 'A', kind: 'done' })
  assert.equal(r.apply(slot('done'), 'A', 'all', false), undefined, 'same attention again is not news')
  assert.deepEqual(r.apply(slot('waiting'), 'A', 'all', false)?.kind, 'waiting', 'done → waiting rises')
  assert.equal(r.apply(slot('done'), 'A', 'all', false), undefined, 'waiting → done does not')
})

test('first state of a slot is only recorded', () => {
  const r = new OsNotifyRules()
  assert.equal(r.apply(slot('waiting'), 'A', 'all', false), undefined)
})

test('levels', () => {
  const r = new OsNotifyRules()
  r.seed(slot())
  assert.equal(r.apply(slot('done'), 'A', 'waiting', false), undefined)
  r.apply(slot(), 'A', 'waiting', false)
  assert.equal(r.apply(slot('waiting'), 'A', 'waiting', false)?.kind, 'waiting')
  r.apply(slot(), 'A', 'off', false)
  assert.equal(r.apply(slot('waiting'), 'A', 'off', false), undefined)
  assert.equal(normalizeOsNotify('x'), 'all')
  assert.equal(normalizeOsNotify('off'), 'off')
})

test('toastFor coalesces and leads with waiting', () => {
  assert.equal(toastFor([]), undefined)
  assert.equal(toastFor([{ slotId: 'a', label: 'A', kind: 'done' }])?.title, 'A terminou')
  const t = toastFor([{ slotId: 'a', label: 'A', kind: 'done' }, { slotId: 'b', label: 'B', kind: 'waiting' }, { slotId: 'c', label: 'C', kind: 'done' }])!
  assert.equal(t.title, '3 agentes pedem atenção')
  assert.equal(t.slotId, 'b')
  assert.match(t.body, /1 esperando você, 2 terminaram/)
})
