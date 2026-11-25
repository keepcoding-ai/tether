// What the channel's pane shows of the polls (extensions/channels/renderer/polls.ts, slice E3): pure functions, no DOM.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Line, PollResult } from '../../extensions/channels/rules.ts'
import type { PollState } from '../../extensions/channels/daemon/requests.ts'
import { applyLine, applyPage, emptyTimeline, rowsOf } from '../../extensions/channels/renderer/view-model.ts'
import { classify } from '../../extensions/channels/renderer/marks.ts'
import { applyPoll, cardOf, closedClock, countdown, isNoOption, pollRefusalText } from '../../extensions/channels/renderer/polls.ts'

const AT = '2026-11-24T10:32:00.000Z'
const NOW = Date.parse(AT)
const person = (id: string, name: string) => ({ id, name })
const pollLine = (seq: number, opts: { to?: string[]; options?: string[]; from?: string; closesInMs?: number } = {}): Line => {
  const options = opts.options ?? ['ok', 'não ok']
  return {
    seq, at: AT, kind: 'poll', body: '', from: { id: opts.from ?? 'atrium', name: opts.from ?? 'atrium', role: 'member' },
    poll: {
      type: opts.options ? 'choice' : 'ok', question: 'Posso subir a ata?', options,
      to: (opts.to ?? ['nic', 'bancada']).map((id) => person(id, id)), closesAt: new Date(NOW + (opts.closesInMs ?? 360_000)).toISOString(),
    },
  }
}
const open = (line: Line, votes: Record<string, { option: number; reason?: string }>): PollState => ({
  seq: line.seq,
  open: { ...line.poll!, seq: line.seq, author: person(line.from.id, line.from.name), votes: Object.fromEntries(Object.entries(votes).map(([id, v]) => [id, { ...v, at: AT, name: id }])) },
})
const ctx = { now: NOW, readOnly: false }

test('countdown: minutes, seconds in the last minute, hours', () => {
  assert.deepEqual(countdown(NOW + 360_000, NOW), { text: 'fecha em 6 min', soon: false })
  assert.deepEqual(countdown(NOW + 48_000, NOW), { text: 'fecha em 0:48', soon: true })
  assert.deepEqual(countdown(NOW + 3_900_000, NOW), { text: 'fecha em 1 h 5 min', soon: false })
  assert.deepEqual(countdown(NOW + 7_200_000, NOW), { text: 'fecha em 2 h', soon: false })
  assert.equal(countdown(NOW - 1, NOW).text, 'fechando…')
})

test('cardOf: an open poll with partial votes: bars, who voted, who is missing, progress', () => {
  const l = pollLine(57, { to: ['nic', 'conf', 'bancada'] })
  const c = cardOf(l, open(l, { nic: { option: 1 }, conf: { option: 1 } }), ctx)!
  assert.equal(c.state, 'open')
  assert.deepEqual(c.options.map((o) => [o.text, o.count, o.pct]), [['ok', 2, 100], ['não ok', 0, 0]])
  assert.deepEqual(c.missing.map((m) => m.name), ['bancada'])
  assert.equal(c.progressText, '2 de 3 votaram')
  assert.equal(c.clock, 'fecha em 6 min')
  assert.equal(c.canVote, false, 'the person was not called: she sees, she does not vote')
  assert.equal(c.canClose, true, 'the person always closes')
  assert.equal(c.options.some((o) => o.winner), false, 'no winner while open')
})

test('cardOf: the person called votes, her vote is marked, a reason shows, a pending vote shows at once', () => {
  const l = pollLine(58, { to: ['nic', 'user'] })
  const waiting = cardOf(l, open(l, { nic: { option: 2, reason: 'falta a parte de riscos' } }), ctx)!
  assert.equal(waiting.canVote, true)
  assert.equal(waiting.waitsYou, true)
  assert.deepEqual(waiting.missing.map((m) => [m.name, m.you]), [['Você', true]])
  assert.equal(waiting.options[1]!.voters[0]!.reason, 'falta a parte de riscos')
  const voted = cardOf(l, open(l, { nic: { option: 2 }, user: { option: 1, reason: 'sim' } }), ctx)!
  assert.deepEqual([voted.mineOption, voted.mineReason, voted.waitsYou], [1, 'sim', false])
  assert.equal(voted.options[0]!.voters[0]!.name, 'Você')
  assert.equal(cardOf(l, open(l, {}), { ...ctx, pending: 2 })!.options[1]!.mine, true, 'pending shows as chosen')
})

test('cardOf: who left the channel does not count as missing; a closed channel is read only', () => {
  const l = pollLine(59, { to: ['nic', 'bancada'] })
  const c = cardOf(l, open(l, { nic: { option: 1 } }), { ...ctx, members: new Set(['nic']) })!
  assert.deepEqual(c.missing, [])
  assert.equal(c.progressText, '1 de 1 votaram')
  const ro = cardOf(pollLine(60, { to: ['user'] }), open(pollLine(60, { to: ['user'] }), {}), { ...ctx, readOnly: true })!
  assert.deepEqual([ro.canVote, ro.canClose], [false, false])
})

const closedBy = (by: PollResult['by'], extra: Partial<PollResult> = {}): PollResult => ({
  poll: 57, by, tally: [{ option: 1, text: 'ok', voters: [{ id: 'nic', name: 'nic' }, { id: 'user', name: 'Guga' }] }, { option: 2, text: 'não ok', voters: [{ id: 'bancada', name: 'bancada', reason: 'faltam riscos' }] }],
  missing: [], ...extra,
})

test('cardOf: a closed poll: winner, reasons, "sem resposta" with the reason of each, how it closed', () => {
  const l = pollLine(57, { to: ['nic', 'bancada', 'user', 'conf', 'soul'] })
  const result = closedBy('timeout', { missing: [{ id: 'conf', name: 'conf', why: 'asleep' }, { id: 'soul', name: 'soul', why: 'left' }] })
  const c = cardOf(l, { seq: 57, result, closedAt: '2026-11-24T13:42:00.000Z' }, ctx)!
  assert.equal(c.state, 'closed')
  assert.deepEqual(c.options.map((o) => o.winner), [true, false])
  assert.deepEqual(c.missing.map((m) => [m.name, m.why]), [['conf', 'mesa dormindo'], ['soul', 'saiu do canal']])
  assert.equal(c.progressText, '3 de 4 votaram', 'who left does not count')
  assert.match(c.clock, /^o prazo venceu às \d\d:\d\d$/)
  assert.deepEqual([c.canVote, c.canClose], [false, false])
  assert.equal(c.mineOption, 1)
})

test('cardOf: a tie has no winner and says so; a result the index lost says only that it closed', () => {
  const l = pollLine(61, { options: ['terça', 'sexta'], to: ['a', 'b'] })
  const tie: PollResult = { poll: 61, by: 'all-voted', tally: [{ option: 1, text: 'terça', voters: [{ id: 'a', name: 'a' }] }, { option: 2, text: 'sexta', voters: [{ id: 'b', name: 'b' }] }], missing: [] }
  const c = cardOf(l, { seq: 61, result: tie }, ctx)!
  assert.deepEqual([c.tie, c.options.some((o) => o.winner)], [true, false])
  assert.match(c.progressText, /empate/)
  const lost = cardOf(l, { seq: 61 }, ctx)!
  assert.deepEqual([lost.state, lost.unknown, lost.canVote], ['closed', true, false])
})

test('closedClock: the four ways to close', () => {
  assert.match(closedClock({ by: 'all-voted' }, AT), /^todos votaram às \d\d:\d\d$/)
  assert.equal(closedClock({ by: 'author', closer: person('user', 'Guga') }, AT), 'encerrada por você')
  assert.equal(closedClock({ by: 'author', closer: person('atrium', 'atrium') }, AT), 'encerrada por atrium')
  assert.equal(closedClock({ by: 'channel-closed' }, AT), 'o canal foi encerrado')
  assert.equal(closedClock({ by: 'timeout', away: true }, AT), 'o prazo venceu com o tether fora')
})

test('applyPoll: the opening, a vote and the close change the state; a late vote after the result changes nothing', () => {
  const states = new Map<number, PollState>()
  const l = pollLine(57)
  const st = open(l, {})
  assert.deepEqual(applyPoll(states, { line: l, poll: st.open! }), { seq: 57, what: 'open' })
  const vote: Line = { seq: 58, at: AT, kind: 'vote', body: '', from: { id: 'nic', name: 'nic', role: 'member' }, vote: { poll: 57, option: 1 } }
  assert.deepEqual(applyPoll(states, { line: vote, poll: open(l, { nic: { option: 1 } }).open! }), { seq: 57, what: 'vote' })
  assert.equal(Object.keys(states.get(57)!.open!.votes).length, 1)
  const close: Line = { seq: 59, at: AT, kind: 'notice', body: 'x', from: { id: 'tether', name: 'tether', role: 'system' }, event: { type: 'poll-close' }, result: closedBy('all-voted') }
  assert.deepEqual(applyPoll(states, { line: close }), { seq: 57, what: 'close' })
  assert.ok(states.get(57)!.result)
  assert.equal(applyPoll(states, { line: vote, poll: open(l, {}).open! }), undefined)
  assert.ok(states.get(57)!.result, 'still closed')
})

test('the timeline: votes and the close are no hole (quiet) and the opening is a line', () => {
  const l = pollLine(5)
  let t = applyPage(emptyTimeline(), { lines: [{ seq: 4, at: AT, kind: 'message', from: { id: 'a', name: 'a', role: 'member' }, body: 'oi' }], more: false, last: 4 }, false)
  const r = applyLine(t, l, new Set())
  assert.deepEqual([r.added, r.gap], [true, false])
  t = r.timeline
  const next: Line = { seq: 8, at: AT, kind: 'message', from: { id: 'a', name: 'a', role: 'member' }, body: 'depois' }
  assert.equal(applyLine(t, next, new Set([6, 7])).gap, false, 'two votes between: no hole')
  assert.equal(applyLine(t, next, new Set([6])).gap, true)
})

test('rowsOf: a poll is a row of its own with its author and question', () => {
  const rows = rowsOf([pollLine(5, { from: 'atrium' })])
  const p = rows.find((r) => r.kind === 'poll')
  assert.ok(p && p.kind === 'poll')
  assert.deepEqual([p.name, p.question, p.mine], ['atrium', 'Posso subir a ata?', false])
})

test('classify: the opening of a poll by an agent is news; the person\'s own is not; votes and the close never are', () => {
  assert.equal(classify(pollLine(5), 'Guga'), 'plain')
  assert.equal(classify({ ...pollLine(6), from: { id: 'user', name: 'Guga', role: 'moderator' } }, 'Guga'), undefined)
  assert.equal(classify({ seq: 7, at: AT, kind: 'vote', body: '', from: { id: 'a', name: 'a', role: 'member' }, vote: { poll: 5, option: 1 } }, 'Guga'), undefined)
})

test('refusals and the "não ok"', () => {
  assert.match(pollRefusalText('poll-closed'), /já fechou/)
  assert.match(pollRefusalText('too-long'), /140/)
  assert.equal(isNoOption('ok', 2), true)
  assert.equal(isNoOption('choice', 2), false)
})
