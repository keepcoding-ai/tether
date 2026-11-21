import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { agentHue } from '../../app/shared/agent-color.ts'
import { deskMark, markAttention, routedHue } from '../../app/renderer/desk-mark.ts'

describe('deskMark', () => {
  test('nothing', () => { assert.equal(deskMark([]), ''); assert.equal(deskMark([undefined, {}]), '') })
  test('busy alone is the quiet dot', () => assert.equal(deskMark([{ turn: 'busy' }]), 'busy'))
  test('attention beats busy and counts', () => {
    const m = deskMark([{ turn: 'busy' }, { attention: 'done' }, { attention: 'waiting', turn: 'busy' }, { attention: 'done' }])
    assert.deepEqual(m, { attention: { done: 2, waiting: 1 } })
    assert.deepEqual(markAttention(m), { done: 2, waiting: 1 })
  })
  test('markAttention of busy/empty is zero', () => { assert.deepEqual(markAttention('busy'), { done: 0, waiting: 0 }); assert.deepEqual(markAttention(''), { done: 0, waiting: 0 }) })
})

describe('routedHue', () => {
  test('nothing without a route', () => assert.equal(routedHue([undefined, {}, { attention: 'done' }]), undefined))
  test('the hue of the first owner; orange on the pane wins; the count is not touched', () => {
    assert.equal(routedHue([{}, { attentionFor: { slotId: 'a', value: 'done' as const } }, { attentionFor: { slotId: 'b', value: 'waiting' as const } }]), agentHue('a'))
    assert.equal(routedHue([{ attention: 'done' as const, attentionFor: { slotId: 'a', value: 'done' as const } }]), undefined)
  })
})
