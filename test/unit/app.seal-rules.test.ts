import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentHue } from '../../app/shared/agent-color.ts'
import { attentionLines, BadgeBoard, countLabel, effectiveAttention, normalizeBadge, pillMark, routedAttention, SealBoard } from '../../app/renderer/seal-rules.ts'

test('normalizeBadge: a zero or invalid count is no count; nothing left is no badge', () => {
  assert.equal(normalizeBadge(undefined), undefined)
  assert.equal(normalizeBadge({}), undefined)
  assert.equal(normalizeBadge({ count: 0 }), undefined)
  assert.equal(normalizeBadge({ count: -3, tooltip: 'x' }), undefined)
  assert.equal(normalizeBadge({ count: Number.NaN }), undefined)
  assert.deepEqual(normalizeBadge({ count: 2.9 }), { count: 2 })
  assert.deepEqual(normalizeBadge({ attention: true, tooltip: '  oi ' }), { attention: true, tooltip: 'oi' })
  assert.deepEqual(normalizeBadge({ count: 1, attention: false }), { count: 1 })
})

test('countLabel: past two digits it is 99+', () => {
  assert.equal(countLabel(7), '7')
  assert.equal(countLabel(99), '99')
  assert.equal(countLabel(100), '99+')
})

test('BadgeBoard: set, change detection, clear, owner removal', () => {
  const b = new BadgeBoard()
  assert.equal(b.set('a', 'pad.1', { count: 3 }), true)
  assert.equal(b.set('a', 'pad.1', { count: 3 }), false)
  assert.deepEqual(b.get('pad.1'), { count: 3 })
  b.set('b', 'pad.2', { attention: true })
  assert.equal(b.set('a', 'pad.1', { count: 0 }), true)
  assert.equal(b.get('pad.1'), undefined)
  assert.equal(b.set('a', 'pad.1', undefined), false)
  b.set('a', 'pad.3', { count: 1 })
  assert.equal(b.removeOwner('a'), true)
  assert.equal(b.get('pad.3'), undefined)
  assert.deepEqual(b.get('pad.2'), { attention: true })
  assert.equal(b.removeOwner('a'), false)
})

test('SealBoard: a normal seal goes when the pane is seen, a sticky one stays until resolved', () => {
  let changes = 0
  const s = new SealBoard(() => { changes++ })
  const normal = s.raise('x', 'p1', 'oi')
  const sticky = s.raise('x', 'p1', 'ajuda', true)
  assert.equal(s.has('p1'), true)
  assert.deepEqual(s.messages('p1'), ['oi', 'ajuda'])
  assert.equal(s.seen('p2'), false)
  assert.equal(s.seen('p1'), true)
  assert.equal(s.get(normal.id), undefined)
  assert.deepEqual(s.messages('p1'), ['ajuda'])
  assert.equal(s.seen('p1'), false, 'seeing again changes nothing')
  assert.equal(s.update(sticky.id, 'espera voce devolver'), true)
  assert.deepEqual(s.messages('p1'), ['espera voce devolver'])
  assert.equal(s.resolve(sticky.id), true)
  assert.equal(s.resolve(sticky.id), false)
  assert.equal(s.has('p1'), false)
  assert.equal(s.update(sticky.id, 'x'), false)
  assert.ok(changes >= 5)
})

test('SealBoard: several owners on one pane live together; an owner going takes only its own', () => {
  const s = new SealBoard()
  s.raise('a', 'p1', 'da a', true)
  s.raise('b', 'p1', 'da b', true)
  s.raise('a', 'p2', 'outra', true)
  assert.equal(s.onPane('p1').length, 2)
  assert.equal(s.removeOwner('a'), true)
  assert.deepEqual(s.messages('p1'), ['da b'])
  assert.equal(s.has('p2'), false)
  assert.equal(s.removeOwner('a'), false)
})

test('SealBoard: the message is trimmed and capped', () => {
  const s = new SealBoard()
  const a = s.raise('a', 'p', '  oi  ')
  assert.equal(a.message, 'oi')
  assert.equal(s.raise('a', 'p', 'x'.repeat(1000)).message.length, 300)
})

test('effectiveAttention: an extension seal waits for the person; the terminal keeps its own', () => {
  assert.equal(effectiveAttention(undefined, 0), undefined)
  assert.equal(effectiveAttention('done', 0), 'done')
  assert.equal(effectiveAttention('done', 1), 'waiting')
  assert.equal(effectiveAttention(undefined, 2), 'waiting')
  assert.deepEqual(attentionLines('done', ['a']), ['Terminou', 'a'])
  assert.deepEqual(attentionLines(undefined, []), [])
  assert.deepEqual(attentionLines('done', [], true), ['Não lido'], 'a done the person marked unread')
  assert.deepEqual(attentionLines('waiting', [], true), ['Esperando você'])
})

test('pillMark: pane seals and the badge add up; the flag alone is a pip', () => {
  assert.equal(pillMark(undefined, undefined), undefined)
  assert.equal(pillMark({ done: 0, waiting: 0 }, { tooltip: 'x' }), undefined)
  assert.deepEqual(pillMark({ done: 0, waiting: 0 }, { attention: true, tooltip: 't' }), { text: '', tone: 'waiting', lines: ['t'] })
  assert.deepEqual(pillMark({ done: 1, waiting: 0, lines: ['m'] }, { count: 2 }), { text: '3', tone: 'done', lines: ['m'] })
  assert.deepEqual(pillMark(undefined, { count: 4 }), { text: '4', tone: 'plain', lines: [] })
  assert.equal(pillMark({ done: 1, waiting: 1 }, undefined)!.tone, 'waiting')
})

test('routedAttention: an attention that waits for the owner is the mark of the owner, in its hue', () => {
  const name = (id: string): string | undefined => (id === 'claude-1' ? 'Atrium' : undefined)
  assert.deepEqual(routedAttention({ attentionFor: { slotId: 'claude-1', value: 'waiting' } }, name), { value: 'waiting', hue: agentHue('claude-1'), tooltip: 'Esperando Atrium' })
  assert.deepEqual(routedAttention({ attentionFor: { slotId: 'claude-1', value: 'done' } }, name), { value: 'done', hue: agentHue('claude-1'), tooltip: 'Terminou, para Atrium' })
  // An owner the app does not know is named by its slot id.
  assert.equal(routedAttention({ attentionFor: { slotId: 'soul-9', value: 'done' } }, name)!.tooltip, 'Terminou, para soul-9')
  assert.equal(routedAttention({ attentionFor: { slotId: 'soul-9', value: 'done' } }, name)!.hue, agentHue('soul-9'))
})

test('routedAttention: nothing without a route, and the attention for the person (orange) wins', () => {
  const name = (): string => 'Atrium'
  assert.equal(routedAttention(undefined, name), undefined)
  assert.equal(routedAttention({}, name), undefined)
  assert.equal(routedAttention({ attentionFor: { slotId: 'claude-1', value: 'waiting' } }, name, 'done'), undefined)
  // The pill, the bell and the toast read `attention`, which the daemon leaves empty on a routed slot: the mark is not a count.
  assert.deepEqual(pillMark({ done: 0, waiting: 0 }, undefined), undefined)
})
