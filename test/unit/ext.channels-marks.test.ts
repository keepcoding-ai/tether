// The marks of the channels (slice U3): what counts as unread, what is "to you", when it goes, and what the top bar icon says.
// Pure: no DOM, no daemon.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Line } from '../../extensions/channels/rules.ts'
import type { ChannelSummary } from '../../extensions/channels/daemon/requests.ts'
import { MAX_HELD, MarkBoard, classify } from '../../extensions/channels/renderer/marks.ts'
import { manifest, STATUS_ID } from '../../extensions/channels/manifest.ts'
import { forYouLabel, popRows, stateOf, titleOf } from '../../extensions/channels/renderer/view-model.ts'

const ME = 'usuário'
const at = new Date(2026, 10, 23, 14, 0).toISOString()
const say = (seq: number, id: string, to?: string[], role: 'owner' | 'member' | 'moderator' = 'member'): Line =>
  ({ seq, at, kind: 'message', from: { id, name: id, role }, body: `fala ${seq}`, ...(to ? { to } : {}) })
const notice = (seq: number): Line => ({ seq, at, kind: 'notice', from: { id: 'tether', name: 'tether', role: 'system' }, body: 'entrou', event: { type: 'join' } })

test('classify: a line for everyone is plain, one addressed to the moderator is toMe; the person, notices and the tether count for nothing', () => {
  assert.equal(classify(say(1, 'a1'), ME), 'plain')
  assert.equal(classify(say(1, 'a1', ['b2']), ME), 'plain', 'addressed to another member: still no orange')
  assert.equal(classify(say(1, 'a1', ['b2', ME]), ME), 'toMe')
  assert.equal(classify(say(1, 'a1', [' Usuário ']), ME), 'toMe', 'case and spaces do not matter')
  assert.equal(classify(say(1, 'a1', [ME]), 'Guga'), 'plain', 'the moderator name is the setting')
  assert.equal(classify(say(1, 'user', undefined, 'moderator'), ME), undefined)
  assert.equal(classify(say(1, 'user', [ME]), ME), undefined, 'her own line is never unread')
  assert.equal(classify(notice(1), ME), undefined)
})

test('an ordinary line counts as unread and is not orange; a line to her counts and lights toMe', () => {
  const b = new MarkBoard()
  assert.equal(b.hear('c1', say(1, 'a1'), ME), true)
  assert.deepEqual(b.of('c1'), { unread: 1, toMe: 0, seen: 0 })
  assert.equal(b.hear('c1', say(2, 'a2', [ME]), ME), true)
  assert.deepEqual(b.of('c1'), { unread: 2, toMe: 1, firstToMe: 2, seen: 0 })
  assert.equal(b.hear('c1', notice(3), ME), false, 'a notice is not news')
  assert.deepEqual(b.of('c2'), { unread: 0, toMe: 0, seen: 0 }, 'another channel is untouched')
})

test('a repeat changes nothing; a line already seen is not counted', () => {
  const b = new MarkBoard()
  b.hear('c1', say(1, 'a1'), ME)
  assert.equal(b.hear('c1', say(1, 'a1'), ME), false)
  assert.equal(b.of('c1').unread, 1)
  b.viewed('c1', 5)
  assert.equal(b.hear('c1', say(4, 'a1', [ME]), ME), false, 'older than what she saw')
  assert.deepEqual(b.of('c1'), { unread: 0, toMe: 0, seen: 5 })
})

test('viewed clears up to the seq and keeps the newer; a lower seq is a no-op', () => {
  const b = new MarkBoard()
  for (const l of [say(1, 'a1'), say(2, 'a1', [ME]), say(3, 'a1'), say(4, 'a1', [ME])]) b.hear('c1', l, ME)
  assert.equal(b.viewed('c1', 2), true)
  assert.deepEqual(b.of('c1'), { unread: 2, toMe: 1, firstToMe: 4, seen: 2 })
  assert.equal(b.viewed('c1', 1), false)
  assert.equal(b.viewed('c1', 4), true)
  assert.deepEqual(b.of('c1'), { unread: 0, toMe: 0, seen: 4 })
})

test('load: the newest page over the daemon seenByUser; what she saw before is dropped, the rest counts once even with the live line', () => {
  const b = new MarkBoard()
  b.hear('c1', say(7, 'a1', [ME]), ME) // heard live before the page came
  const page = [say(5, 'a1'), say(6, 'a2', [ME]), say(7, 'a1', [ME]), notice(8)]
  b.load('c1', page, 5, ME)
  assert.deepEqual(b.of('c1'), { unread: 2, toMe: 2, firstToMe: 6, seen: 5 })
})

test('the held lines have a ceiling: the oldest go first', () => {
  const b = new MarkBoard()
  for (let i = 1; i <= MAX_HELD + 10; i++) b.hear('c1', say(i, 'a1'), ME)
  assert.equal(b.of('c1').unread, MAX_HELD)
})

test('forget drops a channel', () => {
  const b = new MarkBoard()
  b.hear('c1', say(1, 'a1'), ME)
  b.forget('c1')
  assert.equal(b.of('c1').unread, 0)
})

const summary = (id: string, name: string, extra: Partial<ChannelSummary> = {}): ChannelSummary =>
  ({ id, name, title: name, owner: { kind: 'user' }, members: 3, seenByUser: 0, createdAt: at, ...extra })

test('the icon: grey with nothing, normal with unread, amber only for a line to her', () => {
  assert.equal(stateOf({ unread: 0, toMe: 0 }), 'idle')
  assert.equal(stateOf({ unread: 4, toMe: 0 }), 'normal')
  assert.equal(stateOf({ unread: 4, toMe: 1 }), 'warn')
  assert.equal(titleOf({ unread: 0, toMe: 0 }), 'Canais')
  assert.equal(titleOf({ unread: 3, toMe: 0 }), 'Canais: 3 falas novas')
  assert.equal(titleOf({ unread: 3, toMe: 2 }), 'Canais: 2 falas para você')
})

test('the popover: open channels, the ones with a line to her first, then the most unread, then by name', () => {
  const b = new MarkBoard()
  b.hear('obra', say(1, 'a1'), ME)
  b.hear('obra', say(2, 'a1'), ME)
  b.hear('zeta', say(1, 'a1', [ME]), ME)
  b.hear('alfa', say(1, 'a1'), ME)
  const rows = popRows(
    [summary('alfa', 'alfa'), summary('obra', 'obra'), summary('zeta', 'zeta'), summary('mudo', 'mudo'), summary('velho', 'velho', { closed: { at, by: 'user' } as ChannelSummary['closed'] })],
    id => b.of(id),
  )
  assert.deepEqual(rows.map(r => r.name), ['zeta', 'obra', 'alfa', 'mudo'], 'closed is not listed')
  assert.deepEqual(rows.map(r => r.text), ['para você', '2 falas novas', '1 fala nova', ''])
  assert.equal(rows[0]!.members, '3 membros')
})

test('firstCall: the oldest call she has not answered, in one line (what "Esperam você" shows)', () => {
  const b = new MarkBoard()
  assert.equal(b.firstCall('c'), undefined)
  b.hear('c', say(1, 'bancada'), ME)
  b.hear('c', { ...say(2, 'conferente', [ME]), body: '\n  Posso   seguir com\n a migração?' }, ME)
  assert.deepEqual(b.firstCall('c'), { why: 'to-you', text: 'conferente: Posso seguir com' })
  const poll: Line = { seq: 3, at, kind: 'poll', from: { id: 'bancada', name: 'bancada', role: 'member' }, body: '', to: [ME], poll: { type: 'ok', question: 'Fecho a obra hoje?', options: ['sim', 'não'], to: [], closesAt: at } }
  b.hear('c', poll, ME)
  b.setOwed('c', [{ seq: 3, closesAt: at }])
  b.viewed('c', 2)
  // The speech was seen; the poll still waits for her vote, with its question.
  assert.deepEqual(b.firstCall('c'), { why: 'poll-owed', text: 'Enquete de bancada: Fecho a obra hoje?' })
  b.viewed('c', 3)
  assert.deepEqual(b.firstCall('c'), { why: 'poll-owed', text: 'Enquete de bancada: Fecho a obra hoje?' }, 'seeing a poll does not answer it')
  b.setOwed('c', [])
  b.setAsks('c', [{ seq: 9, on: 1, emoji: '❓', by: 'conferente' }])
  assert.deepEqual(b.firstCall('c'), { why: 'reaction-asks', text: 'conferente reagiu ❓ a uma fala sua' })
})

test('the manifest declares the top bar icon and the bar for her has its words', () => {
  assert.deepEqual(manifest.contributes?.status, [{ id: STATUS_ID, icon: 'chats-circle', order: 60 }])
  assert.equal(forYouLabel(1), '1 nova para você')
  assert.equal(forYouLabel(3), '3 novas para você')
})
