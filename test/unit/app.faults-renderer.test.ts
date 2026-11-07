// The renderer's report of a thrown value (app/renderer/faults.ts): what it says about a non-Error rejection reason.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeReason } from '../../app/renderer/faults.ts'

test('renderer: a non-Error rejection reason is described by type and key names, never by value', () => {
  assert.equal(describeReason(new Error('boom')).message, 'boom')
  assert.equal(describeReason('plain text').message, 'plain text')
  const m = describeReason({ token: 'sk-ant-SECRET-VALUE-123', password: 'hunter2' }).message
  assert.ok(m.includes('Object') && m.includes('token') && m.includes('password'), m)
  assert.ok(!m.includes('SECRET') && !m.includes('hunter2'), m)
  class Resp { status = 401; body = 'secret body' }
  const r = describeReason(new Resp()).message
  assert.ok(r.includes('Resp') && r.includes('status') && !r.includes('secret body'), r)
  assert.ok(!describeReason(Object.create(null)).message.includes('undefined'))
  assert.match(describeReason([1, 2]).message, /Array de 2/)
  assert.match(describeReason(() => 1).message, /function/)
})
