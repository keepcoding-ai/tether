import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AttentionHistory, bellState, isMuted, isMuteChoice, muteUntil } from '../../app/shared/os-notify.ts'

test('mute: 30 min and 1 h from now, "até amanhã" ends tomorrow at 08:00 local', () => {
  const now = new Date(2026, 10, 13, 22, 15).getTime()
  assert.equal(muteUntil('30m', now), now + 30 * 60_000)
  assert.equal(muteUntil('1h', now), now + 60 * 60_000)
  assert.equal(muteUntil('tomorrow', now), new Date(2026, 10, 14, 8, 0).getTime())
  // Across a month end.
  assert.equal(muteUntil('tomorrow', new Date(2026, 10, 30, 9).getTime()), new Date(2026, 11, 1, 8).getTime())
  assert.ok(isMuteChoice('1h') && !isMuteChoice('2h'))
})

test('mute expires by itself and the level comes back', () => {
  const until = muteUntil('30m', 1000)
  assert.equal(isMuted(until, 1000), true)
  assert.equal(isMuted(until, until - 1), true)
  assert.equal(isMuted(until, until), false, 'expired at the deadline')
  assert.equal(isMuted(undefined, 1000), false)
  assert.equal(bellState('waiting', until, 1000), 'muted')
  assert.equal(bellState('waiting', until, until + 1), 'waiting')
  assert.equal(bellState('off', undefined, 0), 'off')
})

test('history: newest first, one entry per slot, unseen count, mark as seen', () => {
  const h = new AttentionHistory()
  h.add({ slotId: 'a', label: 'A', kind: 'done' }, 1)
  h.add({ slotId: 'b', label: 'B', kind: 'waiting' }, 2)
  assert.deepEqual(h.list().map(e => e.slotId), ['b', 'a'])
  assert.equal(h.unseen, 2)
  h.markSeen()
  assert.equal(h.unseen, 0)
  h.add({ slotId: 'a', label: 'A', kind: 'waiting' }, 3)
  assert.deepEqual(h.list().map(e => [e.slotId, e.kind, e.seen]), [['a', 'waiting', false], ['b', 'waiting', true]])
  assert.equal(h.unseen, 1)
  h.remove('a')
  assert.deepEqual(h.list().map(e => e.slotId), ['b'])
})

test('history keeps at most 20 entries', () => {
  const h = new AttentionHistory()
  for (let i = 0; i < 25; i++) h.add({ slotId: `s${i}`, label: `S${i}`, kind: 'done' }, i)
  const list = h.list()
  assert.equal(list.length, 20)
  assert.equal(list[0]!.slotId, 's24')
  assert.equal(list[19]!.slotId, 's5')
})

test('history: visiting a pane marks only that slot as seen', () => {
  const h = new AttentionHistory()
  h.add({ slotId: 'a', label: 'A', kind: 'waiting' }, 1)
  h.add({ slotId: 'b', label: 'B', kind: 'waiting' }, 2)
  assert.equal(h.markSeen('a'), true)
  assert.deepEqual(h.list().map(e => [e.slotId, e.seen]), [['b', false], ['a', true]])
  assert.equal(h.unseen, 1)
  assert.equal(h.markSeen('a'), false, 'already seen: nothing to repaint')
  assert.equal(h.markSeen('zz'), false)
})

test('history: a notice leaves the list once its slot no longer asks for attention', () => {
  const h = new AttentionHistory()
  h.add({ slotId: 'a', label: 'A', kind: 'waiting' }, 1)
  h.add({ slotId: 'b', label: 'B', kind: 'done' }, 2)
  assert.equal(h.settle('a', 'waiting'), false, 'still waiting: stays')
  assert.equal(h.settle('a', 'done'), false)
  assert.equal(h.settle('a', undefined), true)
  assert.deepEqual(h.list().map(e => e.slotId), ['b'])
  assert.equal(h.settle('zz', undefined), false)
})
