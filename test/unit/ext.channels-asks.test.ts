// R5: which reactions ask the person (❓/❌ of an agent on a speech of hers), when they go (seen, taken back) and what the board holds.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { personAsks, type Line } from '../../extensions/channels/rules.ts'
import { MarkBoard } from '../../extensions/channels/renderer/marks.ts'
import { seesNextText } from '../../extensions/channels/renderer/reactions.ts'

const at = new Date(2026, 10, 24, 9, 0).toISOString()
const her = (seq: number): Line => ({ seq, at, kind: 'message', from: { id: 'user', name: 'Guga', role: 'moderator' }, body: `fala ${seq}` })
const agent = (seq: number, id = 'a1'): Line => ({ seq, at, kind: 'message', from: { id, name: id, role: 'member' }, body: `fala ${seq}` })
const react = (seq: number, on: number, emoji: string, op: 'add' | 'remove' = 'add', id = 'a1'): Line =>
  ({ seq, at, kind: 'reaction', from: id === 'user' ? { id, name: 'Guga', role: 'moderator' } : { id, name: id, role: 'member' }, body: '', react: { seq: on, emoji, op } })

test('personAsks: ❓ and ❌ of an agent on her speech ask her; every other reaction and every other speech asks nothing', () => {
  const lines = [her(1), agent(2), react(3, 1, '❓'), react(4, 1, '❌', 'add', 'b2'), react(5, 1, '👍'), react(6, 1, '👀'), react(7, 1, '✅'), react(8, 1, '🎉'), react(9, 2, '❓')]
  assert.deepEqual(personAsks(lines), [
    { seq: 3, on: 1, emoji: '❓', by: 'a1' },
    { seq: 4, on: 1, emoji: '❌', by: 'b2' },
  ])
})

test('personAsks: her own ❓ asks nothing; a ❓ taken back is gone; a repeat counts once; the variation selector is the same emoji', () => {
  assert.deepEqual(personAsks([agent(1), react(2, 1, '❓', 'add', 'user')]), [])
  assert.deepEqual(personAsks([her(1), react(2, 1, '❓'), react(3, 1, '❓', 'remove')]), [])
  assert.deepEqual(personAsks([her(1), react(2, 1, '❓'), react(3, 1, '❓')]).map((a) => a.seq), [2])
  assert.deepEqual(personAsks([her(1), react(2, 1, '❌'), react(3, 1, '❌', 'remove'), react(4, 1, '❌')]).map((a) => a.seq), [4])
  assert.equal(personAsks([her(1), react(2, 1, '❌️')]).length, 1)
})

test('board: asks are held apart from the lines, and seeing up to their number drops them', () => {
  const b = new MarkBoard()
  assert.equal(b.setAsks('c1', [{ seq: 3, on: 1, emoji: '❓', by: 'a1' }]), true)
  assert.equal(b.setAsks('c1', [{ seq: 3, on: 1, emoji: '❓', by: 'a1' }]), false, 'the same set changes nothing')
  assert.deepEqual(b.of('c1'), { unread: 0, toMe: 0, seen: 0 }, 'no line, no unread, no toMe')
  assert.equal(b.asksOf('c1').length, 1)
  b.viewed('c1', 2)
  assert.equal(b.asksOf('c1').length, 1, 'not yet: the reaction is number 3')
  b.viewed('c1', 3)
  assert.equal(b.asksOf('c1').length, 0)
  assert.equal(b.setAsks('c1', [{ seq: 3, on: 1, emoji: '❓', by: 'a1' }]), false, 'an ask she already saw does not come back with a late answer')
})

test('board: a ❓ taken back leaves with the next set', () => {
  const b = new MarkBoard()
  b.setAsks('c1', [{ seq: 3, on: 1, emoji: '❓', by: 'a1' }])
  assert.equal(b.setAsks('c1', []), true)
  assert.equal(b.asksOf('c1').length, 0)
})

test('board: looked at in place raises the mark when nothing unseen lies below, else only forgets it for the session', () => {
  const b = new MarkBoard()
  b.setAsks('c1', [{ seq: 3, on: 1, emoji: '❓', by: 'a1' }])
  assert.deepEqual(b.attended('c1', 3), { changed: true, persist: true })
  assert.equal(b.of('c1').seen, 3)

  const c = new MarkBoard()
  c.hear('c1', agent(2), 'Guga')
  c.setAsks('c1', [{ seq: 4, on: 1, emoji: '❌', by: 'a1' }])
  assert.deepEqual(c.attended('c1', 4), { changed: true, persist: false }, 'an unread line lies below: the mark must not hide it')
  assert.equal(c.of('c1').seen, 0)
  assert.equal(c.of('c1').unread, 1)
  assert.equal(c.setAsks('c1', [{ seq: 4, on: 1, emoji: '❌', by: 'a1' }]), false, 'the daemon repeating it does not bring it back')
  assert.deepEqual(c.attended('c1', 9), { changed: false, persist: false })
})

test('seesNextText: only her ❓/❌ on an agent speech says who reads it next', () => {
  const agentFrom = { id: 'a1', name: 'claude · nic', role: 'member' }
  assert.equal(seesNextText({ emoji: '❓', mine: true }, agentFrom), 'claude · nic vê isto na próxima mensagem do canal')
  assert.equal(seesNextText({ emoji: '❌', mine: true }, agentFrom)?.includes('claude · nic'), true)
  assert.equal(seesNextText({ emoji: '👍', mine: true }, agentFrom), undefined)
  assert.equal(seesNextText({ emoji: '❓', mine: false }, agentFrom), undefined, 'not hers')
  assert.equal(seesNextText({ emoji: '❓', mine: true }, { id: 'user', name: 'Guga', role: 'moderator' }), undefined, 'her own speech')
  assert.equal(seesNextText({ emoji: '❓', mine: true }, undefined), undefined)
})
