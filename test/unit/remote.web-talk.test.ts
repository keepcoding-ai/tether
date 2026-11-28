// The person talking from afar (RR4 step 4.2b), the device's side with no screen: what an answer of the portal asks for,
// the outbox of the speeches (one actId each until its answer, the same id again after a cut, a timeout or a lock, a new one
// for "Tentar de novo"), the drafts per channel, the ceilings checked before anything leaves and the lane of "seen".
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { opByName, RES_STATUS, toHex, type Bytes } from '../../src/remote/index.ts'
import { SAY_TEXT_MAX } from '../../src/remote/talk.ts'
import { createTalker, TalkRefused, type KeyValue, type TalkSession } from '../../remote/web/src/talk.ts'
import {
  checkSay, confirmUpTo, counterOf, COUNTER_FROM, DRAFTS_MAX, expire, FIRST_REPLY_MS, OUTBOX_MAX, parseDrafts, parseOutbox, pushItem,
  RESEND_WINDOW_MS, SEEN_LANE, seenDone, seenTake, seenWant, serializeDrafts, serializeOutbox, stepOf, TIMEOUT_RESEND_MS, toResend, withDraft, type OutItem,
} from '../../remote/web/src/talk-rules.ts'

const OP = { say: opByName('channels.say')!.code, react: opByName('channels.react')!.code, vote: opByName('channels.vote')!.code, seen: opByName('channels.seen')!.code }
const item = (o: Partial<OutItem> = {}): OutItem => ({ id: 'a'.repeat(32), channel: 'obra', text: 'oi', to: [], at: 1_000, state: 'sending', ...o })
const flush = async (): Promise<void> => { for (let i = 0; i < 10; i++) await Promise.resolve() }

describe('what an answer of the portal asks for', () => {
  test('done, the pace, may-have-happened, gone, locked and refused for good', () => {
    assert.deepEqual(stepOf({ status: RES_STATUS.ok, body: { seq: 7 } }), { do: 'done', body: { seq: 7 } })
    assert.deepEqual(stepOf({ status: -1, body: {} }), { do: 'wait-session' })
    assert.deepEqual(stepOf({ status: RES_STATUS.locked, body: {} }), { do: 'locked' })
    assert.deepEqual(stepOf({ status: RES_STATUS.limit, body: { error: 'slow-down' } }), { do: 'hold', code: 'slow-down' })
    assert.deepEqual(stepOf({ status: RES_STATUS.limit, body: { error: 'busy' } }), { do: 'hold', code: 'busy' })
    assert.deepEqual(stepOf({ status: RES_STATUS.failed, body: { error: 'timeout' } }), { do: 'resend', afterMs: TIMEOUT_RESEND_MS })
    assert.deepEqual(stepOf({ status: RES_STATUS.failed, body: { error: 'closed' } }), { do: 'fail', code: 'closed' })
    assert.deepEqual(stepOf({ status: RES_STATUS.failed, body: { error: '<b>' } }), { do: 'fail', code: 'failed' }, 'an odd code is no code')
    assert.deepEqual(stepOf({ status: RES_STATUS.presenceRequired, body: {} }), { do: 'fail', code: 'no-credential' })
    assert.deepEqual(stepOf({ status: RES_STATUS.notFound, body: { error: 'unknown-poll' } }), { do: 'fail', code: 'unknown-poll' })
    assert.deepEqual(stepOf({ status: RES_STATUS.badRequest, body: { error: 'too-long' } }), { do: 'fail', code: 'too-long' })
    assert.deepEqual(stepOf({ status: RES_STATUS.noScope, body: {} }), { do: 'fail', code: 'no-scope' })
  })
})

describe('the outbox of the speeches', () => {
  test('what was written comes back; anything of another shape is dropped', () => {
    const ok = [item(), item({ id: 'b'.repeat(32), state: 'failed', why: 'closed' }), item({ id: 'c'.repeat(32), state: 'sent', seq: 9, to: ['conferente'] })]
    assert.deepEqual(parseOutbox(serializeOutbox(ok)), ok)
    assert.deepEqual(parseOutbox(null), [])
    assert.deepEqual(parseOutbox('{not json'), [])
    assert.deepEqual(parseOutbox(JSON.stringify({ v: 2, items: ok })), [], 'another version is not read')
    const bad = [{ ...item(), id: 'x' }, { ...item(), channel: '../x' }, { ...item(), state: 'odd' }, { ...item(), text: 'x'.repeat(SAY_TEXT_MAX + 1) }, 'x']
    assert.deepEqual(parseOutbox(JSON.stringify({ v: 1, items: [...bad, item()] })), [item()])
  })

  test('over the ceiling the oldest that is not waiting goes first', () => {
    let items: OutItem[] = []
    for (let i = 0; i < OUTBOX_MAX; i++) items = pushItem(items, item({ id: i.toString(16).padStart(32, '0'), state: i === 0 ? 'sending' : 'sent', seq: i + 1 }))
    const next = pushItem(items, item({ id: 'f'.repeat(32) }))
    assert.equal(next.length, OUTBOX_MAX)
    assert.equal(next[0]!.state, 'sending', 'the one still waiting stays')
    assert.ok(!next.some(x => x.seq === 2), 'the oldest that went is out')
  })

  test('resent by itself within the window; past it, "não sei se chegou"', () => {
    const items = [item({ at: 0 }), item({ id: 'b'.repeat(32), at: RESEND_WINDOW_MS }), item({ id: 'c'.repeat(32), state: 'failed', at: RESEND_WINDOW_MS })]
    const t = RESEND_WINDOW_MS + 1
    assert.deepEqual(toResend(items, t).map(x => x.id), ['b'.repeat(32)])
    assert.deepEqual(expire(items, t).map(x => [x.state, x.why]), [['failed', 'unknown'], ['sending', undefined], ['failed', undefined]])
  })

  test('a page up to its last line takes the speeches that landed there out', () => {
    const items = [item({ state: 'sent', seq: 5 }), item({ id: 'b'.repeat(32), state: 'sent', seq: 8 }), item({ id: 'c'.repeat(32), channel: 'extra', state: 'sent', seq: 1 }), item({ id: 'd'.repeat(32) })]
    assert.deepEqual(confirmUpTo(items, 'obra', 7).map(x => x.id[0]), ['b', 'c', 'd'])
  })
})

describe('the drafts, one per channel', () => {
  test('set, emptied, and only so many channels kept (the oldest go)', () => {
    let d = withDraft({}, 'obra', 'meio escrito')
    assert.deepEqual(parseDrafts(serializeDrafts(d)), { obra: 'meio escrito' })
    d = withDraft(d, 'obra', '   ')
    assert.deepEqual(d, {})
    for (let i = 0; i < DRAFTS_MAX + 3; i++) d = withDraft(d, `c${i}`, 'x')
    assert.equal(Object.keys(d).length, DRAFTS_MAX)
    assert.ok(!('c0' in d) && `c${DRAFTS_MAX + 2}` in d)
    assert.deepEqual(parseDrafts('{"v":1,"drafts":{"../x":"a","ok":3,"fine":"b"}}'), { fine: 'b' })
  })
})

describe('the ceilings, before anything leaves', () => {
  test('a speech: some text, the portal\'s ceiling, the names', () => {
    assert.deepEqual(checkSay('oi', ['conferente']), { ok: true })
    assert.equal((checkSay('   ', []) as { code: string }).code, 'bad-request')
    const long = checkSay('x'.repeat(SAY_TEXT_MAX + 3), [])
    assert.ok(!long.ok && long.code === 'too-long' && /Corte 3/.test(long.message))
    assert.equal(checkSay('x'.repeat(SAY_TEXT_MAX), []).ok, true)
    assert.equal((checkSay('oi', Array.from({ length: 17 }, (_, i) => `a${i}`)) as { code: string }).code, 'too-long')
  })

  test('the counter shows near the ceiling only, and says when it is past', () => {
    assert.equal(counterOf(10).show, false)
    assert.deepEqual(counterOf(COUNTER_FROM), { show: true, text: `${COUNTER_FROM.toLocaleString('en').replace(',', ' ')} / 4 000`, over: false })
    assert.equal(counterOf(SAY_TEXT_MAX + 1).over, true)
  })
})

describe('the lane of "seen"', () => {
  test('a burst is told once, the highest; what comes while one is in flight goes after it', () => {
    let w = seenWant(SEEN_LANE, 4)
    assert.equal(w.start, true)
    w = seenWant(w.lane, 9)
    let t = seenTake(w.lane)
    assert.equal(t.seq, 9)
    w = seenWant(t.lane, 12)
    assert.equal(w.start, false, 'in flight: it waits')
    assert.equal(seenWant(w.lane, 3).lane, w.lane, 'an older seq changes nothing')
    const d = seenDone(w.lane, 9, true)
    assert.deepEqual([d.lane.sent, d.start], [9, true])
    t = seenTake(d.lane)
    assert.equal(t.seq, 12)
    const failed = seenDone(t.lane, 12, false)
    assert.deepEqual([failed.lane.sent, failed.start], [9, false], 'a refusal: the next look asks again')
    assert.equal(seenWant(failed.lane, 12).start, true)
  })
})

// ---- the talker over a made-up session and a manual clock

function bench() {
  let clock = 10_000
  const timers: { at: number; f: () => void }[] = []
  const mem = new Map<string, string>()
  const store: KeyValue = { get: k => mem.get(k) ?? null, set: (k, v) => { mem.set(k, v) }, remove: k => { mem.delete(k) } }
  const make = () => createTalker({
    houseId: 'h1', store, now: () => clock,
    setTimer: (f, ms) => { const t = { at: clock + ms, f }; timers.push(t); return t },
    clearTimer: t => { const i = timers.indexOf(t as never); if (i >= 0) timers.splice(i, 1) },
  })
  const advance = async (ms: number): Promise<void> => {
    clock += ms
    for (;;) {
      await flush()
      const due = timers.filter(t => t.at <= clock).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      timers.splice(timers.indexOf(due), 1)
      due.f()
    }
    await flush()
  }
  return { make, advance, mem, now: () => clock }
}

/** A session that answers each request with what `answer` says (a promise that never settles: no answer). */
function session(answer: (op: number, body: Record<string, unknown>, n: number) => Promise<{ status: number; body: Record<string, unknown> }>) {
  const calls: { op: number; body: Record<string, unknown>; actId: string }[] = []
  const s: TalkSession & { calls: typeof calls; ended: unknown } = {
    calls, ended: undefined,
    request: (op, body, o) => { calls.push({ op, body, actId: o?.actId ? toHex(o.actId as Bytes) : '' }); return answer(op, body, calls.length) },
  }
  return s
}
const ok = (body: Record<string, unknown>) => Promise.resolve({ status: RES_STATUS.ok, body })
const never = () => new Promise<never>(() => {})

describe('the talker', () => {
  test('a speech shows at once, goes with its actId, gets its seq, and leaves when the page holds it; the draft goes with it', async () => {
    const b = bench()
    const t = b.make()
    const news: string[] = []
    t.onChange(n => news.push(`${n.channel}:${n.what}`))
    t.setDraft('obra', 'Bom dia')
    const s = session(() => ok({ seq: 42 }))
    t.attach(s)
    await t.say('obra', 'Bom dia', ['conferente'])
    assert.deepEqual(s.calls.map(c => [c.op, c.body]), [[OP.say, { channel: 'obra', text: 'Bom dia', to: ['conferente'] }]])
    assert.match(s.calls[0]!.actId, /^[0-9a-f]{32}$/)
    assert.deepEqual(t.items('obra').map(x => [x.state, x.seq, x.id]), [['sent', 42, s.calls[0]!.actId]])
    assert.equal(t.draft('obra'), '', 'the draft went with the speech')
    assert.deepEqual(news, ['obra:changed', 'obra:sent'])
    t.confirmed('obra', 41)
    assert.equal(t.items('obra').length, 1)
    t.confirmed('obra', 42)
    assert.equal(t.items('obra').length, 0)
  })

  test('the portal\'s pace: nothing happened, the speech leaves the outbox and the box keeps the text', async () => {
    const b = bench()
    const t = b.make()
    t.attach(session(() => Promise.resolve({ status: RES_STATUS.limit, body: { error: 'slow-down' } })))
    await assert.rejects(t.say('obra', 'devagar', []), (e: unknown) => e instanceof TalkRefused && e.code === 'slow-down' && /ficou na caixa/.test(e.message))
    assert.deepEqual(t.items('obra'), [])
    await assert.rejects(t.say('obra', 'x'.repeat(SAY_TEXT_MAX + 1), []), (e: unknown) => e instanceof TalkRefused && e.code === 'too-long')
  })

  test('no session: kept as "enviando" through a reload, and sent with the SAME actId when one is up', async () => {
    const b = bench()
    const first = b.make()
    const p = first.say('obra', 'na volta', [])
    await b.advance(FIRST_REPLY_MS)
    await p
    const [kept] = first.items('obra')
    assert.equal(kept!.state, 'sending')
    first.dispose()
    // The page reloads: a new talker over the same storage.
    const again = b.make()
    assert.deepEqual(again.items('obra').map(x => [x.id, x.state, x.text]), [[kept!.id, 'sending', 'na volta']])
    const s = session(() => ok({ seq: 7 }))
    again.attach(s)
    await b.advance(0)
    assert.deepEqual(s.calls.map(c => c.actId), [kept!.id])
    assert.equal(again.items('obra')[0]!.state, 'sent')
  })

  test('"timeout": may have happened; the same actId goes again by itself, and the real outcome comes', async () => {
    const b = bench()
    const t = b.make()
    const s = session((_op, _b, n) => (n === 1 ? Promise.resolve({ status: RES_STATUS.failed, body: { error: 'timeout' } }) : ok({ seq: 3 })))
    t.attach(s)
    await t.say('obra', 'lento', [])
    assert.equal(t.items('obra')[0]!.state, 'sending')
    await b.advance(TIMEOUT_RESEND_MS)
    assert.equal(s.calls.length, 2)
    assert.equal(s.calls[0]!.actId, s.calls[1]!.actId)
    assert.deepEqual(t.items('obra').map(x => [x.state, x.seq]), [['sent', 3]])
  })

  test('the cut (no answer before the session ended): the same actId on the next session', async () => {
    const b = bench()
    const t = b.make()
    const s1 = session(() => { s1.ended = { by: 'route' }; return Promise.resolve({ status: -1, body: {} }) })
    t.attach(s1)
    await t.say('obra', 'caiu', [])
    t.detach()
    const s2 = session(() => ok({ seq: 11 }))
    t.attach(s2)
    await b.advance(0)
    assert.equal(s2.calls[0]!.actId, s1.calls[0]!.actId)
    assert.equal(t.items('obra')[0]!.seq, 11)
  })

  test('locked: the screen asks for presence; once unlocked the same act goes again', async () => {
    const b = bench()
    const t = b.make()
    let lockedAsked = 0
    t.onLocked = () => { lockedAsked++ }
    const s1 = session(() => Promise.resolve({ status: RES_STATUS.locked, body: {} }))
    t.attach(s1)
    await t.say('obra', 'trancado', [])
    assert.equal(lockedAsked, 1)
    assert.equal(t.items('obra')[0]!.state, 'sending')
    const s2 = session(() => ok({ seq: 5 }))
    t.attach(s2)
    await b.advance(0)
    assert.equal(s2.calls[0]!.actId, s1.calls[0]!.actId)
    assert.equal(t.items('obra')[0]!.state, 'sent')
  })

  test('refused for good: "não enviada", the text kept; "Tentar de novo" is a new act; "Editar" gives the text back', async () => {
    const b = bench()
    const t = b.make()
    const news: string[] = []
    t.onChange(n => news.push(n.what))
    const s = session((_op, _b, n) => (n === 1 ? Promise.resolve({ status: RES_STATUS.failed, body: { error: 'closed' } }) : ok({ seq: 9 })))
    t.attach(s)
    await t.say('obra', 'fechou', ['conferente'])
    assert.deepEqual(t.items('obra').map(x => [x.state, x.why, x.text]), [['failed', 'closed', 'fechou']])
    assert.ok(news.includes('failed'))
    t.retry(t.items('obra')[0]!.id)
    await b.advance(0)
    assert.notEqual(s.calls[1]!.actId, s.calls[0]!.actId, 'a new act, a new id')
    assert.equal(t.items('obra')[0]!.state, 'sent')
    const t2 = b.make()
    t2.attach(session(() => Promise.resolve({ status: RES_STATUS.failed, body: { error: 'failed' } })))
    await t2.say('extra', 'de volta', ['revisor'])
    const back = t2.take(t2.items('extra')[0]!.id)
    assert.deepEqual([back?.text, back?.to], ['de volta', ['revisor']])
    assert.deepEqual(t2.items('extra'), [])
  })

  test('waited past the window: not resent by itself (it could speak twice); the person decides', async () => {
    const b = bench()
    const t = b.make()
    const p = t.say('obra', 'velha', [])
    await b.advance(FIRST_REPLY_MS)
    await p
    await b.advance(RESEND_WINDOW_MS)
    const s = session(() => ok({ seq: 1 }))
    t.attach(s)
    await b.advance(0)
    assert.equal(s.calls.length, 0)
    assert.deepEqual(t.items('obra').map(x => [x.state, x.why]), [['failed', 'unknown']])
  })

  test('a reaction and a vote keep their actId across a cut; the vote answers in the card\'s shape', async () => {
    const b = bench()
    const t = b.make()
    const s1 = session(() => { s1.ended = { by: 'route' }; return Promise.resolve({ status: -1, body: {} }) })
    t.attach(s1)
    const reacted = t.react('obra', 4, 'agree', false)
    await b.advance(0)
    t.detach()
    const s2 = session(op => (op === OP.react ? ok({ changed: true, emoji: '👍' }) : ok({
      changed: true, option: 1,
      state: { seq: 6, open: { type: 'ok', question: 'Sobe?', options: ['ok', 'não ok'], to: [{ id: 'user', name: 'Guga' }], closesAt: new Date(Date.now() + 60_000).toISOString(), author: { id: 'p1', name: 'conferente' }, votes: [{ id: 'user', name: 'Guga', option: 1 }] } },
    })))
    t.attach(s2)
    await b.advance(2_000)
    assert.deepEqual(await reacted, { changed: true })
    assert.equal(s2.calls[0]!.actId, s1.calls[0]!.actId)
    assert.deepEqual(s2.calls[0]!.body, { channel: 'obra', seq: 4, reaction: 'agree' })
    const v = await t.vote('obra', 6, 1, '  ')
    assert.deepEqual(s2.calls[1]!.body, { channel: 'obra', poll: 6, vote: 1 }, 'an empty reason is no reason')
    assert.equal(v.poll?.question, 'Sobe?')
    assert.deepEqual(v.poll?.votes, { user: { option: 1, name: 'Guga', at: '' } })
    await assert.rejects(t.react('obra', 4, '', false), (e: unknown) => e instanceof TalkRefused && e.code === 'bad-reaction')
  })

  test('without a session for too long, an act gives up as "timeout" (the pane says it did not go)', async () => {
    const b = bench()
    const t = b.make()
    const r = t.react('obra', 1, 'seen', false)
    await b.advance(60_000)
    await assert.rejects(r, (e: unknown) => e instanceof TalkRefused && e.code === 'timeout')
  })

  test('"seen": a burst of lines is told once, the highest, a moment later', async () => {
    const b = bench()
    const t = b.make()
    const s = session(() => ok({ seenByUser: 9 }))
    t.attach(s)
    t.seen('obra', 7)
    t.seen('obra', 9)
    t.seen('obra', 8)
    assert.equal(s.calls.length, 0)
    await b.advance(300)
    assert.deepEqual(s.calls.map(c => [c.op, c.body]), [[OP.seen, { channel: 'obra', seq: 9 }]])
    t.seen('obra', 9)
    await b.advance(300)
    assert.equal(s.calls.length, 1, 'told once')
    // A conversation that keeps coming is told every so often, not line by line.
    t.seen('obra', 12)
    await b.advance(300)
    assert.equal(s.calls.length, 1, 'spaced from the last one')
    await b.advance(2_000)
    assert.deepEqual(s.calls.map(c => c.body.seq), [9, 12])
  })

  test('the revoked device forgets the outbox and the drafts', async () => {
    const b = bench()
    const t = b.make()
    t.setDraft('obra', 'segredo meu')
    const p = t.say('obra', 'a caminho', [])
    await b.advance(FIRST_REPLY_MS)
    await p
    assert.ok(b.mem.size > 0)
    t.forget()
    assert.equal(b.mem.size, 0)
    assert.deepEqual(b.make().items('obra'), [])
  })

  test('a slow answer lets the box go: the speech stays "enviando" and settles when the answer comes', async () => {
    const b = bench()
    const t = b.make()
    let answer!: (r: { status: number; body: Record<string, unknown> }) => void
    t.attach(session(() => new Promise(r => { answer = r })))
    const p = t.say('obra', 'devagar e sempre', [])
    await b.advance(FIRST_REPLY_MS)
    await p
    assert.equal(t.items('obra')[0]!.state, 'sending')
    answer({ status: RES_STATUS.ok, body: { seq: 77 } })
    await b.advance(0)
    assert.deepEqual(t.items('obra').map(x => [x.state, x.seq]), [['sent', 77]])
    void never
  })
})
