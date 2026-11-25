// Polls in channels (E1: record, vote and close): the pure rules (deadline, options, vote option, who may open, the result), the
// fan-out's `poll`, `vote` and `pollClose` over the real store (lines of their own, the index, the refusals, the limits,
// `vote-first`, the muted voting, the channel closing), the ONE clock of the whole tether (a fake one here: never more than one
// timer, whatever the number of polls), a deadline passed while the tether was down, and the `poll`, `vote`, `poll-close` and
// `read` verbs. THE IRON RULE OF E1, as E2 left it: a vote reaches no delivery, notice, `line` event or member's state; only the
// requests (one per agent called) and the author's result are delivered (ext.channels-poll-delivery.test.ts tests them).
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import type { DeliveryMessage, VerbCaller } from '../../src/daemon/ext-api.ts'
import { fsIo } from '../../src/daemon/ext-io.ts'
import { createChannels, type Channels, type ChannelsApi, type PollClock } from '../../extensions/channels/daemon/fanout.ts'
import { openStore } from '../../extensions/channels/daemon/store.ts'
import { registerChannelRequests } from '../../extensions/channels/daemon/requests.ts'
import { pollVerb } from '../../extensions/channels/daemon/verbs/poll.ts'
import { pollCloseVerb } from '../../extensions/channels/daemon/verbs/poll-close.ts'
import { voteVerb } from '../../extensions/channels/daemon/verbs/vote.ts'
import { readVerb } from '../../extensions/channels/daemon/verbs/read.ts'
import { failOf, type VerbDef, type VerbDeps } from '../../extensions/channels/daemon/verbs/common.ts'
import {
  allVoted, isPollLine, nextPollDeadline, parsePollTimeout, parseVoteOption, pollOpenRefusal, pollOptions, pollResult, pollResultText,
  USER, type Channel, type Line, type OpenPoll,
} from '../../extensions/channels/rules.ts'
import { removeHome, tempHome } from './daemon.basics.ts'

const T0 = Date.parse('2026-11-24T10:00:00Z')

describe('polls: the pure rules', () => {
  test('parsePollTimeout: minutes as a number or text with a unit; 1 min to 24 h', () => {
    assert.equal(parsePollTimeout(10), 600_000)
    assert.equal(parsePollTimeout('10'), 600_000)
    assert.equal(parsePollTimeout('10m'), 600_000)
    assert.equal(parsePollTimeout('10min'), 600_000)
    assert.equal(parsePollTimeout('90s'), 90_000)
    assert.equal(parsePollTimeout('1h'), 3_600_000)
    assert.equal(parsePollTimeout('2h30m'), 9_000_000)
    assert.equal(parsePollTimeout('24h'), 86_400_000)
    for (const bad of ['30s', '0', '25h', 'dez', '', 'm', -5, 0.5, undefined, null]) assert.equal(parsePollTimeout(bad), undefined, String(bad))
  })

  test('pollOptions: none is ok / não ok; 2 to 6 distinct of up to 60; otherwise bad-request or too-long', () => {
    assert.deepEqual(pollOptions(), { type: 'ok', options: ['ok', 'não ok'] })
    assert.deepEqual(pollOptions([' terça ', 'quarta\nfeira']), { type: 'choice', options: ['terça', 'quarta feira'] })
    assert.equal(pollOptions(['só uma']), 'bad-request')
    assert.equal(pollOptions(['a', 'b', 'c', 'd', 'e', 'f', 'g']), 'bad-request')
    assert.equal(pollOptions(['Terça', 'terca']), 'bad-request', 'repeated, case and accents aside')
    assert.equal(pollOptions(['a', '  ']), 'bad-request')
    assert.equal(pollOptions(['a', 'x'.repeat(61)]), 'too-long')
  })

  test('parseVoteOption: the number (as number or text) or the option text, any case and accents', () => {
    const ok = ['ok', 'não ok']
    assert.equal(parseVoteOption(ok, 1), 1)
    assert.equal(parseVoteOption(ok, '2'), 2)
    assert.equal(parseVoteOption(ok, 'NAO OK'), 2)
    assert.equal(parseVoteOption(ok, 'não ok'), 2)
    for (const bad of [0, 3, '3', 'talvez', '', 1.5, null]) assert.equal(parseVoteOption(ok, bad), undefined, String(bad))
  })

  test('pollOpenRefusal: closed, stranger, muted, vote-first, limit per author and per channel, slow-down', () => {
    const poll = (seq: number, author: string, to: string[], votes: string[] = []): OpenPoll => ({
      seq, author: { id: author, name: author }, type: 'ok', question: 'q', options: ['ok', 'não ok'], closesAt: '2026-11-24T10:10:00Z',
      to: to.map((id) => ({ id, name: id })), votes: Object.fromEntries(votes.map((v) => [v, { option: 1, at: 'x', name: v }])),
    })
    const base = { members: { a: { name: 'a' }, b: { name: 'b' }, c: { name: 'c' }, m: { name: 'm', muted: { since: 'x', by: 'user' } } } } as unknown as Channel
    assert.equal(pollOpenRefusal('a', base, 0), undefined)
    assert.equal(pollOpenRefusal('z', base, 0), 'not-member')
    assert.equal(pollOpenRefusal('m', base, 0), 'muted')
    assert.equal(pollOpenRefusal('a', { ...base, closed: { at: 'x', by: 'user' } } as Channel, 0), 'closed')
    assert.equal(pollOpenRefusal('a', base, 5), 'slow-down')
    const one = { ...base, polls: { 1: poll(1, 'a', ['b', 'c']) } } as Channel
    assert.equal(pollOpenRefusal('b', one, 0), 'vote-first', 'b owes a vote')
    assert.equal(pollOpenRefusal('a', one, 0), 'limit', 'one open poll per author')
    assert.equal(pollOpenRefusal(USER, one, 0), undefined, 'the person is not called: she may open')
    const voted = { ...base, polls: { 1: poll(1, 'a', ['b'], ['b']) } } as Channel
    assert.equal(pollOpenRefusal('b', voted, 0), undefined, 'voted: no longer owes')
    const three = { ...base, polls: { 1: poll(1, 'a', [], []), 2: poll(2, 'b', [], []), 3: poll(3, 'c', [], []) } } as Channel
    assert.equal(pollOpenRefusal(USER, three, 0), 'limit', '3 open per channel')
  })

  test('allVoted and the result: who left no longer counts and comes out as left; the text names the close and the missing', () => {
    const ch = { name: 'obra', members: { a: { name: 'alfa' }, b: { name: 'bravo' } } } as unknown as Channel
    const p: OpenPoll = {
      seq: 7, author: { id: 'a', name: 'alfa' }, type: 'ok', question: 'Posso?', options: ['ok', 'não ok'], closesAt: '2026-11-24T10:10:00Z',
      to: [{ id: 'b', name: 'bravo' }, { id: 'c', name: 'charlie' }], votes: { b: { option: 2, reason: 'falta "x"', at: 'x', name: 'bravo' } },
    }
    assert.equal(allVoted(ch, p), true, 'charlie is not a member: bravo was the last one called')
    const r = pollResult(ch, p, { by: 'timeout' }, () => 'no-answer')
    assert.deepEqual(r.missing, [{ id: 'c', name: 'charlie', why: 'left' }])
    assert.equal(pollResultText('obra', r), 'Enquete obra#7 fechou: o prazo venceu.\nnão ok 1: bravo ("falta \\"x\\"") · sem resposta 1: charlie (saiu do canal)')
    assert.equal(isPollLine({ seq: 1, at: '', kind: 'notice', from: { id: 'tether', name: 'tether', role: 'system' }, body: '', event: { type: 'poll-close' } }), true)
    assert.equal(isPollLine({ seq: 1, at: '', kind: 'notice', from: { id: 'tether', name: 'tether', role: 'system' }, body: '', event: { type: 'join' } }), false)
    assert.equal(nextPollDeadline([{ polls: { 1: { closesAt: '2026-11-24T10:10:00Z' }, 2: { closesAt: '2026-11-24T10:05:00Z' } } } as unknown as Channel, {} as Channel]), Date.parse('2026-11-24T10:05:00Z'))
    assert.equal(nextPollDeadline([]), undefined)
  })
})

describe('polls: the fan-out, the clock and the verbs over the real store', () => {
  let home: string
  let ch: Channels
  let deps: VerbDeps
  let api: ChannelsApi & VerbDeps['api']
  const delivered: DeliveryMessage[] = []
  const events: Array<{ name: string; payload: any }> = []
  const queued: unknown[] = []
  const slot = (id: string, name: string, status = 'running') => ({ slotId: id, kind: 'claude', status, name, cwd: '/x' })
  const SLOTS: Record<string, ReturnType<typeof slot>> = {
    A: slot('A', 'alfa'), B: slot('B', 'bravo'), C: slot('C', 'charlie'), M: slot('M', 'mudo'), S: slot('S', 'parado', 'stopped'), Z: slot('Z', 'zulu'),
  }
  const caller = (id: string): VerbCaller => ({ slotId: id, state: SLOTS[id], via: 'mcp', proven: true }) as unknown as VerbCaller
  const run = async (def: VerbDef, who: string, args: Record<string, unknown>) => {
    try { return await def.run(deps, caller(who), args) } catch (e) { return failOf(e) }
  }
  const codeOf = (r: { ok: boolean; error?: string } | { data?: unknown }): unknown => ('ok' in r ? (r as { error?: string }).error : (r.data as { error?: string }).error)
  const flush = async (): Promise<void> => { await new Promise((r) => setTimeout(r, 20)) }

  // The fake clock: every timer it holds, so the test sees there is never more than one.
  let nowMs = T0
  const timers = new Set<{ fn: () => void; at: number }>()
  const clock: PollClock = {
    now: () => nowMs,
    set: (fn, ms) => { const t = { fn, at: nowMs + ms }; timers.add(t); return t },
    clear: (t) => { timers.delete(t as { fn: () => void; at: number }) },
  }
  async function advance(ms: number): Promise<void> {
    nowMs += ms
    for (const t of [...timers]) if (t.at <= nowMs) { timers.delete(t); t.fn() }
    await flush()
  }
  let obra: string
  let sala: string
  const iron = () => ({ delivered: delivered.length, lines: events.filter((e) => e.name === 'line').length })

  before(async () => {
    home = tempHome()
    const none = { dispose: () => {} }
    api = {
      slots: { get: (s: string) => SLOTS[s], list: () => Object.values(SLOTS), onState: () => none, userTypedAt: () => undefined },
      delivery: {
        onDidDeliver: () => none,
        deliver: async (_slot: string, msg: DeliveryMessage) => { delivered.push(msg); return { id: `r${delivered.length}`, slotId: _slot, state: 'inside' } },
        pending: () => queued, cancel: () => false, routeOf: () => 'inside', hasTools: () => true,
      },
      attention: { seen: () => { throw new Error('attention must not be touched') } },
      events: { emit: (name: string, payload: unknown) => { events.push({ name, payload }) } },
      settings: { get: () => undefined }, log: () => {},
      verbs: { register: () => none, instructions: () => none },
    } as unknown as ChannelsApi & VerbDeps['api']
    ch = createChannels(api, await openStore(fsIo, home), clock)
    deps = { api, channels: ch }
    const made = await ch.create('A', { name: 'obra' })
    assert.ok(made.ok)
    obra = made.channel.id
    for (const a of ['B', 'C', 'M']) assert.ok((await ch.join(a, obra)).ok)
    assert.ok((await ch.mute(USER, obra, 'M')).ok)
    const other = await ch.create('B', { name: 'sala' })
    assert.ok(other.ok)
    sala = other.channel.id
    for (const a of ['A', 'C', 'S']) assert.ok((await ch.join(a, sala)).ok)
    await flush()
  })
  after(async () => { ch?.dispose(); await removeHome(home) })

  test('poll: one line of its own, no earlier line touched, the muted is called, nothing delivered, no line event, no turn', async () => {
    const before = iron()
    const last = await ch.store.lastSeq(obra)
    const earlier = JSON.stringify(await ch.store.history(obra))
    const r = await run(pollVerb, 'A', { canal: 'obra', question: 'Posso subir a ata?' })
    assert.equal(r.isError, undefined, r.text)
    const seq = last + 1
    assert.match(r.text, new RegExp(`^Enquete obra#${seq} aberta \\(opções: 1 ok, 2 não ok\\)\\. Chamou bravo, charlie, mudo\\. Fecha às \\d\\d:\\d\\d \\(em 10 min\\)\\.`))
    const written = (await ch.store.since(obra, last)).at(-1)!
    assert.equal(written.seq, seq)
    assert.equal(written.kind, 'poll')
    assert.equal(written.body, '')
    assert.deepEqual(written.from, { id: 'A', name: 'alfa', role: 'owner' })
    assert.deepEqual(written.poll, {
      type: 'ok', options: ['ok', 'não ok'], question: 'Posso subir a ata?',
      to: [{ id: 'B', name: 'bravo' }, { id: 'C', name: 'charlie' }, { id: 'M', name: 'mudo' }], closesAt: new Date(T0 + 600_000).toISOString(),
    })
    assert.equal(JSON.stringify((await ch.store.history(obra)).slice(0, -1)), earlier, 'no earlier line was touched')
    assert.equal(ch.store.get(obra)!.polls?.[String(seq)]?.seq, seq, 'the index has it open')
    await flush()
    // E2: one request per agent called, nothing else (E1's iron rule held until the requests existed).
    assert.deepEqual(iron(), { ...before, delivered: before.delivered + 3 }, 'three requests, no line event')
    assert.deepEqual(delivered.slice(-3).map((m) => m.kind), ['request', 'request', 'request'])
    assert.equal(queued.length, 0)
    assert.equal(events.at(-1)!.name, 'poll')
    assert.equal(ch.store.get(obra)!.seenByUser, 0)
    assert.deepEqual(ch.pollClock(), { armed: true, at: T0 + 600_000 })
  })

  test('refusals to open: vote-first (who owes a vote), limit (one per author), muted, stranger, nobody called, too long, bad deadline', async () => {
    assert.equal(codeOf(await run(pollVerb, 'B', { canal: 'obra', question: 'E eu?' })), 'vote-first')
    assert.equal(codeOf(await run(pollVerb, 'A', { canal: 'obra', question: 'Outra?' })), 'limit')
    assert.equal(codeOf(await run(pollVerb, 'Z', { canal: 'obra', question: 'Fora?' })), 'not-member')
    assert.equal(codeOf(await run(pollVerb, 'C', { canal: 'sala', question: 'x'.repeat(301) })), 'too-long')
    assert.equal(codeOf(await run(pollVerb, 'C', { canal: 'sala', question: 'Prazo?', timeout: '30s' })), 'bad-request')
    assert.equal(codeOf(await run(pollVerb, 'C', { canal: 'sala', question: 'Opções?', options: ['só'] })), 'bad-request')
    assert.equal(codeOf(await run(pollVerb, 'C', { canal: 'sala', question: 'Quem?', to: ['ninguém-aqui'] })), 'unknown-member')
    assert.equal(codeOf(await run(pollVerb, 'C', { canal: 'sala', question: 'Só eu?', to: ['charlie'] })), 'nobody-called')
    assert.equal(codeOf(await ch.poll('M', obra, { question: 'Calado abre?' })), 'muted')
  })

  test('vote: by number, the change replaces it, the same again writes nothing, every refusal; the muted votes; the last vote closes it once', async () => {
    const seq = Number(Object.keys(ch.store.get(obra)!.polls!)[0])
    const before = iron()
    const v1 = await run(voteVerb, 'B', { canal: 'obra', poll: seq, vote: '2', reason: 'a ata ainda\nnão tem os riscos' })
    assert.equal(v1.isError, undefined, v1.text)
    assert.match(v1.text, new RegExp(`^Votou "não ok" em obra#${seq}\\. Faltam 2 de 3; fecha às \\d\\d:\\d\\d\\.$`))
    const vline = (await ch.store.history(obra)).at(-1)!
    assert.equal(vline.kind, 'vote')
    assert.equal(vline.body, '')
    assert.deepEqual(vline.vote, { poll: seq, option: 2, reason: 'a ata ainda não tem os riscos' }, 'one line, no break')
    const last = await ch.store.lastSeq(obra)
    const same = await run(voteVerb, 'B', { canal: 'obra', poll: seq, vote: 'não ok', reason: 'a ata ainda não tem os riscos' })
    assert.equal((same.data as { changed: boolean }).changed, false)
    assert.equal(await ch.store.lastSeq(obra), last, 'the same vote writes nothing')
    const changed = await run(voteVerb, 'B', { canal: 'obra', poll: seq, vote: 1 })
    assert.equal((changed.data as { changed: boolean }).changed, true)
    assert.deepEqual(ch.store.get(obra)!.polls![String(seq)]!.votes.B!.option, 1, 'the last vote counts')
    assert.equal(ch.store.get(obra)!.polls![String(seq)]!.changes?.B, 1)
    assert.equal(codeOf(await run(voteVerb, 'A', { canal: 'obra', poll: seq, vote: 1 })), 'not-called', 'the author does not vote')
    assert.equal(codeOf(await run(voteVerb, 'Z', { canal: 'obra', poll: seq, vote: 1 })), 'not-called')
    assert.equal(codeOf(await run(voteVerb, 'C', { canal: 'obra', poll: seq, vote: 3 })), 'bad-option')
    assert.equal(codeOf(await run(voteVerb, 'C', { canal: 'obra', poll: seq, vote: 1, reason: 'x'.repeat(141) })), 'too-long')
    assert.equal(codeOf(await run(voteVerb, 'C', { canal: 'obra', poll: 1, vote: 1 })), 'unknown-poll', 'a line that is not a poll')
    assert.equal(codeOf(await run(voteVerb, 'C', { canal: 'obra', poll: 9999, vote: 1 })), 'unknown-poll')
    const muted = await run(voteVerb, 'M', { canal: 'obra', poll: seq, vote: 'ok' })
    assert.equal(muted.isError, undefined, 'the muted votes')
    const lastOne = await run(voteVerb, 'C', { canal: 'obra', poll: seq, vote: 2, reason: 'sem os riscos' })
    assert.match(lastOne.text, new RegExp(`^Votou "não ok" em obra#${seq}; todos votaram e ela fechou: ok 2 · não ok 1\\.$`))
    const closeLine = (await ch.store.history(obra)).at(-1)!
    assert.equal(closeLine.kind, 'notice')
    assert.equal(closeLine.event?.type, 'poll-close')
    assert.equal(closeLine.result?.by, 'all-voted')
    assert.deepEqual(closeLine.result?.missing, [])
    assert.equal(closeLine.body, `Enquete obra#${seq} fechou: todos votaram.\nok 2: bravo, mudo · não ok 1: charlie ("sem os riscos")`)
    assert.equal(ch.store.get(obra)!.polls, undefined, 'out of the open polls')
    assert.deepEqual(ch.store.get(obra)!.pollsClosed?.at(-1), { poll: seq, line: closeLine.seq })
    assert.equal(codeOf(await run(voteVerb, 'B', { canal: 'obra', poll: seq, vote: 2 })), 'poll-closed')
    assert.equal(codeOf(await run(pollCloseVerb, 'A', { canal: 'obra', poll: seq })), 'poll-closed', 'closes once')
    await flush()
    assert.deepEqual(iron(), { ...before, delivered: before.delivered + 1 }, 'no vote was delivered nor a line event; the close is the author\'s result alone')
    assert.equal(delivered.at(-1)!.kind, 'notice')
    assert.equal(delivered.at(-1)!.poll?.closedBy, 'all-voted')
    assert.equal(queued.length, 0)
    assert.deepEqual(ch.pollClock(), { armed: false }, 'no open poll: the clock is disarmed')
  })

  test('read: the poll in its line with the result, votes are not lines, the close is the tether\'s line', async () => {
    const r = await run(readVerb, 'Z', { canal: 'obra' })
    const rows = r.text.split('\n')
    const pollRow = rows.find((x) => x.includes('[enquete'))!
    assert.match(pollRow, /^\d+ alfa → bravo, charlie, mudo: \[enquete · fechada · todos votaram\] Posso subir a ata\?  \[ok 2: bravo, mudo · não ok 1: charlie \("sem os riscos"\)\]$/)
    assert.match(rows.at(-1)!, /^\d+ tether: \[enquete \d+ fechou · todos votaram\] ok 2 · não ok 1$/)
    const lines = (r.data as { lines: Array<{ kind: string }> }).lines
    assert.equal(lines.filter((l) => l.kind === 'vote').length, 0)
    assert.equal(rows.some((x) => /: $/.test(x)), false, 'no empty speech')
  })

  test('the pane\'s history (the moderator\'s request) gets the opening of a poll (with its state apart), never a vote or a close', async () => {
    const handlers = new Map<string, (args: unknown, ctx: unknown) => Promise<unknown>>()
    const none = { dispose: () => {} }
    const reqApi = { requests: { handle: (name: string, fn: (args: unknown, ctx: unknown) => Promise<unknown>) => { handlers.set(name, fn); return none } }, slots: api.slots, delivery: api.delivery }
    const own = registerChannelRequests(reqApi as unknown as Parameters<typeof registerChannelRequests>[0], Promise.resolve(ch))
    try {
      const page = await handlers.get('history')!({ channel: obra }, { client: 'app' }) as { lines: Line[]; last: number; polls: Array<{ seq: number }> }
      const all = await ch.store.history(obra)
      assert.ok(all.some(isPollLine), 'the record has poll lines')
      assert.ok(page.lines.some((l) => l.kind === 'poll'), 'the opening of a poll is a line of the conversation')
      assert.equal(page.lines.some((l) => l.kind === 'vote' || l.event?.type === 'poll-close'), false)
      assert.deepEqual(page.polls.map((p) => p.seq), page.lines.filter((l) => l.kind === 'poll').map((l) => l.seq), 'each opening comes with its state')
      assert.equal(page.lines.some((l) => l.kind !== 'message' && l.kind !== 'notice' && l.kind !== 'poll'), false)
      assert.equal(page.last, all.at(-1)!.seq)
    } finally { for (const d of own) d.dispose() }
  })

  test('timeout: the one clock closes it at its deadline; the missing come out with why (stopped, no answer); read shows "sem resposta"', async () => {
    const opened = await run(pollVerb, 'C', { canal: 'sala', question: 'Revisão terça ou quarta?', options: ['terça', 'quarta'], timeout: '1m' })
    assert.equal(opened.isError, undefined, opened.text)
    const seq = (opened.data as { seq: number }).seq
    assert.deepEqual((opened.data as { to: Array<{ name: string }> }).to.map((t) => t.name), ['bravo', 'alfa', 'parado'])
    const owed = await run(readVerb, 'A', { canal: 'sala' })
    assert.match(owed.text.split('\n').at(-1)!, new RegExp(`^enquetes esperando seu voto: ${seq} \\(fecha \\d\\d:\\d\\d; 1 terça, 2 quarta\\)$`))
    assert.ok((await run(voteVerb, 'A', { canal: 'sala', poll: seq, vote: 'quarta' })).data)
    const open = await run(readVerb, 'Z', { canal: 'sala' })
    assert.match(open.text, new RegExp(`${seq} charlie → bravo, alfa, parado: \\[enquete · aberta · fecha \\d\\d:\\d\\d · 1 terça, 2 quarta\\] Revisão terça ou quarta\\?  \\[quarta 1: alfa · faltam: bravo, parado\\]`))
    assert.equal(timers.size, 1)
    await advance(59_000)
    assert.ok(ch.store.get(sala)!.polls?.[String(seq)], 'not yet')
    const before = iron()
    await advance(2_000)
    assert.equal(ch.store.get(sala)!.polls, undefined, 'closed by the deadline')
    const closeLine = (await ch.store.history(sala)).at(-1)!
    assert.equal(closeLine.result?.by, 'timeout')
    assert.equal(closeLine.result?.away, undefined)
    assert.deepEqual(closeLine.result?.missing, [{ id: 'B', name: 'bravo', why: 'no-answer' }, { id: 'S', name: 'parado', why: 'stopped' }])
    assert.equal(closeLine.body, `Enquete sala#${seq} fechou: o prazo venceu.\nquarta 1: alfa · sem resposta 2: bravo (não respondeu), parado (parado)`)
    assert.deepEqual(iron(), { ...before, delivered: before.delivered + 1 }, 'the close is delivered to its author alone')
    assert.equal(timers.size, 0)
    const read = await run(readVerb, 'Z', { canal: 'sala' })
    assert.match(read.text, /\[enquete · fechada · o prazo venceu\] Revisão terça ou quarta\?  \[quarta 1: alfa · sem resposta 2: bravo \(não respondeu\), parado \(parado\)\]/)
  })

  test('the author or the person closes it (not-author for others); the person called counts; changes capped at 5', async () => {
    const opened = await ch.poll('A', obra, { question: 'Fecho?', to: ['B', USER] })
    assert.ok(opened.ok)
    const seq = opened.poll.seq
    assert.deepEqual(opened.poll.to.map((t) => t.id), ['B', USER])
    assert.equal(codeOf(await ch.pollClose('B', obra, seq)), 'not-author')
    for (let i = 0; i < 5; i++) assert.ok((await ch.vote('B', obra, { poll: seq, vote: (i % 2) + 1 })).ok)
    assert.equal(ch.store.get(obra)!.polls![String(seq)]!.changes?.B, 4, 'the first vote is no change')
    const fifth = await ch.vote('B', obra, { poll: seq, vote: 1, reason: 'mudei' })
    assert.ok(fifth.ok, 'a new reason is a change too: the 5th is allowed')
    assert.equal(ch.store.get(obra)!.polls![String(seq)]!.changes?.B, 5)
    assert.equal(codeOf(await ch.vote('B', obra, { poll: seq, vote: 2 })), 'slow-down', 'the 6th change')
    assert.ok(ch.store.get(obra)!.polls?.[String(seq)], 'the person called has not voted: still open')
    const closed = await run(pollCloseVerb, USER, { canal: 'obra', poll: seq })
    assert.match(closed.text, new RegExp(`^Encerrou obra#${seq}: ok 1 · não ok 0\\.$`))
    const line = (await ch.store.history(obra)).at(-1)!
    assert.equal(line.result?.by, 'author')
    assert.deepEqual(line.result?.closer, { id: USER, name: ch.nameOf(USER) })
    assert.match(line.body, /fechou: encerrada por .+\.\nok 1: bravo \("mudei"\) · sem resposta 1: .+ \(não respondeu\)$/)
  })

  test('slow-down: 5 openings per hour per member per channel', async () => {
    // Two this hour already (the first test's and the last one's).
    for (let i = 0; i < 3; i++) {
      const p = await ch.poll('A', obra, { question: `Mais uma ${i}?`, to: ['B'] })
      assert.ok(p.ok, String(i))
      assert.ok((await ch.pollClose('A', obra, p.poll.seq)).ok)
    }
    assert.equal(codeOf(await ch.poll('A', obra, { question: 'A sexta?', to: ['B'] })), 'slow-down', 'the 6th in the hour')
    await advance(3_600_000)
    const again = await ch.poll('A', obra, { question: 'Uma hora depois?', to: ['B'] })
    assert.ok(again.ok)
    assert.ok((await ch.pollClose('A', obra, again.poll.seq)).ok)
  })

  test('one clock for the whole tether: polls in two channels, one timer at the nearest deadline; leaving can close a poll', async () => {
    const p1 = await ch.poll('A', obra, { question: 'Longa?', to: ['B'], timeoutMs: 3_600_000 })
    const p2 = await ch.poll('A', sala, { question: 'Curta?', to: ['C'], timeoutMs: 120_000 })
    const p3 = await ch.poll(USER, sala, { question: 'Média?', to: ['B'], timeoutMs: 600_000 })
    assert.ok(p1.ok && p2.ok && p3.ok)
    assert.equal(timers.size, 1, 'one timer, not one per poll')
    assert.deepEqual(ch.pollClock(), { armed: true, at: nowMs + 120_000 })
    // C leaves sala: p2 called only C, so everyone still called has voted and it closes.
    assert.ok((await ch.leave('C', sala)).ok)
    assert.equal(ch.store.get(sala)!.polls?.[String(p2.poll.seq)], undefined)
    const closeLine = (await ch.store.history(sala)).at(-1)!
    assert.equal(closeLine.result?.by, 'all-voted')
    assert.deepEqual(closeLine.result?.missing, [{ id: 'C', name: 'charlie', why: 'left' }])
    assert.equal(timers.size, 1)
    assert.deepEqual(ch.pollClock(), { armed: true, at: nowMs + 600_000 })
  })

  test('the channel closing closes its open polls (channel-closed); a vote there answers closed', async () => {
    const open = Object.values(ch.store.get(sala)!.polls ?? {})
    assert.equal(open.length, 1)
    assert.ok((await ch.close('B', sala)).ok)
    assert.equal(ch.store.get(sala)!.polls, undefined)
    const lines = await ch.store.history(sala)
    const result = lines.find((l) => l.result?.poll === open[0]!.seq)!
    assert.equal(result.result?.by, 'channel-closed')
    assert.ok(result.seq < lines.at(-1)!.seq, 'before the close line')
    assert.equal(codeOf(await ch.vote('B', sala, { poll: open[0]!.seq, vote: 1 })), 'closed')
    assert.equal(timers.size, 1, 'obra still has its long poll')
  })

  test('a deadline passed while the tether was down: it closes as soon as the record opens again, marked away', async () => {
    const open = Object.values(ch.store.get(obra)!.polls ?? {})
    assert.equal(open.length, 1)
    ch.dispose()
    assert.equal(timers.size, 0, 'dispose clears the clock')
    nowMs += 2 * 3_600_000
    ch = createChannels(api, await openStore(fsIo, home), clock)
    deps = { api, channels: ch }
    assert.equal(timers.size, 1)
    await advance(0)
    assert.equal(ch.store.get(obra)!.polls, undefined)
    const line = (await ch.store.history(obra)).at(-1)!
    assert.equal(line.result?.by, 'timeout')
    assert.equal(line.result?.away, true)
    assert.match(line.body, /fechou: o prazo venceu enquanto o tether estava fora\./)
    assert.deepEqual(ch.pollClock(), { armed: false })
  })
})
