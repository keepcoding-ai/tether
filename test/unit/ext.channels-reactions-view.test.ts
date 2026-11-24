// What the channel's pane shows of the reactions (extensions/channels/renderer/reactions.ts, slice R2): pure functions, no DOM.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Line } from '../../extensions/channels/rules.ts'
import { applyLine, applyPage, emptyTimeline } from '../../extensions/channels/renderer/view-model.ts'
import { applyReaction, FIVE, minesOf, pillAria, pillsOf, pillTitle, refusalText, whoText } from '../../extensions/channels/renderer/reactions.ts'

const react = (seq: number, target: number, emoji: string, op: 'add' | 'remove', id: string, name: string): Line =>
  ({ seq, at: '2026-11-24T10:00:00.000Z', kind: 'reaction', from: { id, name, role: id === 'user' ? 'moderator' : 'member' }, body: '', react: { seq: target, emoji, op } })
const msg = (seq: number): Line => ({ seq, at: '2026-11-24T10:00:00.000Z', kind: 'message', from: { id: 'a1', name: 'nic', role: 'member' }, body: 'x' })

test('applyReaction: add, a repeated add, remove, remove without add', () => {
  let t = applyReaction(undefined, react(5, 3, '👍', 'add', 'a1', 'nic'))
  assert.deepEqual(t.map((x) => [x.emoji, x.name, x.by.map((b) => b.name)]), [['👍', 'agree', ['nic']]])
  t = applyReaction(t, react(6, 3, '👍', 'add', 'a1', 'nic'))
  assert.equal(t[0]!.by.length, 1, 'a repeated add counts once')
  t = applyReaction(t, react(7, 3, '👍', 'add', 'user', 'usuário'))
  assert.equal(t[0]!.by.length, 2)
  t = applyReaction(t, react(8, 3, '🎉', 'add', 'user', 'usuário'))
  assert.deepEqual(t.map((x) => x.emoji), ['👍', '🎉'], 'in the order they came')
  t = applyReaction(t, react(9, 3, '👍', 'remove', 'a1', 'nic'))
  assert.deepEqual(t[0]!.by.map((b) => b.id), ['user'])
  const none = applyReaction(applyReaction(t, react(10, 3, '🎉', 'remove', 'user', 'usuário')), react(11, 3, '❌', 'remove', 'a1', 'nic'))
  assert.deepEqual(none.map((x) => x.emoji), ['👍'], 'the emptied emoji goes; a remove without add changes nothing')
  assert.equal(applyReaction(undefined, msg(2)).length, 0, 'a line that is no reaction changes nothing')
})

test('applyReaction: the emoji with and without the presentation selector is one pill', () => {
  const t = applyReaction(applyReaction(undefined, react(5, 3, '❤️', 'add', 'a1', 'nic')), react(6, 3, '❤', 'add', 'user', 'usuário'))
  assert.equal(t.length, 1)
  assert.equal(t[0]!.by.length, 2)
})

test('pillsOf: count, mine, who; the person first in the text', () => {
  let t = applyReaction(undefined, react(5, 3, '👍', 'add', 'a1', 'codex · conferência'))
  t = applyReaction(t, react(6, 3, '👍', 'add', 'user', 'usuário'))
  const [p] = pillsOf(t)
  assert.deepEqual([p!.emoji, p!.count, p!.mine, p!.pending], ['👍', 2, true, false])
  assert.equal(whoText(p!.by), 'Você e codex · conferência')
  assert.equal(pillTitle(p!), 'Você e codex · conferência: concordo')
  assert.match(pillAria(p!), /^concordo, 2 reações: Você e codex · conferência\. Você reagiu\./)
  assert.match(pillAria(p!, true), /Você reagiu\.$/, 'read only: no "clique"')
  assert.equal(pillTitle({ by: [{ id: 'a1', name: 'nic' }], emoji: '🎉' }), 'nic', 'no agreed meaning, no sense')
  assert.deepEqual([...minesOf(t)], ['👍'])
})

test('pillsOf: the pending gesture shows at once and is undone with it', () => {
  const t = applyReaction(undefined, react(5, 3, '❓', 'add', 'a1', 'nic'))
  const added = pillsOf(t, new Map([['✅', 'add' as const], ['❓', 'add' as const]]))
  assert.deepEqual(added.map((p) => [p.emoji, p.count, p.mine, p.pending]), [['❓', 2, true, true], ['✅', 1, true, true]])
  const mine = applyReaction(t, react(6, 3, '❓', 'add', 'user', 'usuário'))
  assert.deepEqual(pillsOf(mine, new Map([['❓', 'remove' as const]])).map((p) => [p.count, p.mine, p.pending]), [[1, false, true]])
  const only = applyReaction(undefined, react(5, 3, '👍', 'add', 'user', 'usuário'))
  assert.deepEqual(pillsOf(only, new Map([['👍', 'remove' as const]])), [], 'taking back the only one leaves no pill')
  assert.deepEqual(pillsOf(t, new Map()), pillsOf(t), 'no pending: the tallies as they are')
})

test('the five: the bar and the menu share one list, in the plan order', () => {
  assert.deepEqual(FIVE.map((f) => `${f.emoji} ${f.label}`), ['👀 Vi', '👍 Concordo', '✅ Feito', '❌ Discordo', '❓ Dúvida'])
  assert.deepEqual(FIVE.map((f) => f.name), ['seen', 'agree', 'done', 'disagree', 'question'])
})

test('refusalText: the words of each refusal, the two meanings of limit apart', () => {
  assert.equal(refusalText('closed'), 'A reação não entrou: o canal foi encerrado.')
  assert.match(refusalText('too-old'), /antiga demais/)
  assert.equal(refusalText('limit', { mine: 3, kinds: 3 }), 'Você já tem 3 reações nesta fala: tire uma para pôr outra.')
  assert.equal(refusalText('limit', { mine: 1, kinds: 12 }), 'Esta fala já tem 12 emojis diferentes.')
  assert.match(refusalText('slow-down'), /Calma/)
  assert.equal(refusalText('whatever'), 'A reação não entrou.')
})

test('a reaction heard live is no hole in the conversation (quiet) and the next line still follows', () => {
  let t = applyPage(emptyTimeline(), { lines: [msg(1), msg(2)], more: false, last: 2 }, false)
  // seq 3 is a reaction, heard live: the next message is seq 4.
  const quiet = new Set([3])
  const four = applyLine(t, msg(4), quiet)
  assert.deepEqual([four.added, four.gap, four.timeline.last], [true, false, 4])
  assert.equal(applyLine(t, msg(4)).gap, true, 'without the quiet seq it is a hole')
  t = four.timeline
  assert.equal(applyLine(t, msg(6), new Set([5])).gap, false)
  assert.equal(applyLine(t, msg(7), new Set([5])).gap, true, 'a real hole still asks for the page')
})
