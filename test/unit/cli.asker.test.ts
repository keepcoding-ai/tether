// `tether new --desk` inside a pane carries the pane's identity (id + key); outside the tether it carries none (R-2).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { askerOf } from '../../src/cli/verb.ts'

test('askerOf: the pane identity from the environment, or nothing', () => {
  assert.deepEqual(askerOf({}), {})
  assert.deepEqual(askerOf({ TETHER_SLOT_KEY: 'k' }), {})
  assert.deepEqual(askerOf({ TETHER_SLOT_ID: ' s1 ', TETHER_SLOT_KEY: ' k ' }), { slotId: 's1', key: 'k' })
  assert.deepEqual(askerOf({ TETHER_SLOT_ID: 's1' }), { slotId: 's1' })
})
