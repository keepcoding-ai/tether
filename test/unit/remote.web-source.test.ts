// The Regency's source over a live session (remote/web/src/source.ts), with a made-up session: the three readings and
// their shapes, the reading again at each thin notice, one reading of each family in flight, a body of the wrong shape
// thrown away, `too-large`, the pace (and "limit"), the session that falls and the one that comes back, a scope missing.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { EVT, OP_CODES, RES_STATUS } from '../../src/remote/index.ts'
import { RemoteHouse, SourceRefused } from '../../remote/web/src/host.ts'
import type { Reply } from '../../remote/web/src/live.ts'
import { LIMIT_HOLD_MS, READS_PER_MIN, sessionSource, type SourceSession } from '../../remote/web/src/source.ts'

const tick = (): Promise<void> => new Promise(done => setTimeout(done, 0))
const settle = async (): Promise<void> => { for (let i = 0; i < 8; i++) await tick() }

const SIG = '0123456789abcdef'
const treeBody = (o: { live?: boolean; sig?: string; asOf?: number; desk?: string } = {}): Record<string, unknown> => ({
  input: {
    desks: { desks: [{ id: 'd1', name: o.desk ?? 'Obra', color: 'blue', kind: 'queue', asleep: false, panes: [{ id: 'p1', type: 'terminal', icon: 'sparkle', title: 'conferente', attention: 'waiting' }] }] },
    owners: { desk: {}, pane: {} },
    channels: [{ id: 'obra', name: 'obra', title: 'obra', owner: { kind: 'user' }, members: 2, seenByUser: 0, createdAt: '2026-11-27T10:00:00.000Z' }],
    channelMarks: {}, agents: [{ id: 'p1', kind: 'claude', name: 'conferente' }], since: { 'pane:p1': 1_800_000_000_000 }, collapsed: [],
  },
  live: o.live ?? true, ...(o.sig !== undefined ? { sig: o.sig } : { sig: SIG }), ...(o.asOf !== undefined ? { asOf: o.asOf } : {}),
})
const marksBody = (): Record<string, unknown> => ({
  channels: [{ channel: 'obra', name: 'obra', unread: 2, toMe: 1, seen: 3, asks: 0, owed: 0, firstToMe: 4, firstCall: { why: 'to-you', text: 'bancada: qual fica?' }, members: ['p1', 'user', 'p2'] }],
  more: 0, moderator: { name: 'Guga' },
})
const line = (seq: number, body = `fala ${seq}`): Record<string, unknown> =>
  ({ seq, at: '2026-11-27T10:00:00.000Z', kind: 'message', from: { id: 'p1', name: 'conferente', role: 'member' }, body })
const pageBody = (o: { from?: number; to?: number; before?: number; last?: number } = {}): Record<string, unknown> => {
  const from = o.from ?? 1
  const to = o.to ?? 3
  const lines = []
  for (let s = from; s <= to; s++) lines.push(line(s))
  return { channel: { id: 'obra', name: 'obra', title: 'obra' }, lines, reactions: [], polls: [], last: o.last ?? to, ...(o.before !== undefined ? { before: o.before } : {}) }
}

const NAME_OF: Record<number, string> = { [OP_CODES['regency.tree']]: 'tree', [OP_CODES['channels.marks']]: 'marks', [OP_CODES['channels.page']]: 'page' }

interface Call { op: string; body: Record<string, unknown>; answer(r: Reply): void }

/** A session whose answers the test gives: each request waits until `answer` (or `auto` answers at once). */
function fakeSession(auto?: (op: string, body: Record<string, unknown>) => Reply): SourceSession & { calls: Call[]; pending(): Call[] } {
  const calls: Call[] = []
  const done = new Set<Call>()
  return {
    calls,
    pending: () => calls.filter(c => !done.has(c)),
    request: (op, body) => new Promise<Reply>(resolve => {
      const c: Call = { op: NAME_OF[op] ?? String(op), body, answer: r => { done.add(c); resolve(r) } }
      calls.push(c)
      if (auto) c.answer(auto(c.op, body))
    }),
  }
}

const ok = (body: Record<string, unknown>): Reply => ({ status: RES_STATUS.ok, body })
const answering = (op: string): Reply => (op === 'tree' ? ok(treeBody()) : op === 'marks' ? ok(marksBody()) : ok(pageBody()))

describe('the source over the session', () => {
  test('reads the three readings, in the contract\'s shape and through the house\'s projectors', async () => {
    const s = fakeSession((op, body) => {
      if (op !== 'page') return answering(op)
      return ok({
        ...pageBody({ from: 5, to: 6, before: 5, last: 9 }),
        polls: [{ seq: 6, open: { type: 'ok', question: 'Aplico?', options: ['ok', 'não ok'], to: [{ id: 'p2', name: 'revisor' }], closesAt: '2026-11-27T11:00:00.000Z', author: { id: 'p1', name: 'conferente' }, votes: [{ id: 'p2', name: 'revisor', option: 1 }] } }],
        members: [{ id: 'p1', name: 'conferente' }, { id: 'user', name: 'Guga' }, { id: 'p2', name: 'revisor', muted: true, path: 'C:\\x' }],
        moderator: { name: 'Guga' },
        extra: 'not in the contract', ...(body.before !== undefined ? {} : {}),
      })
    })
    const src = sessionSource(s)
    const t = await src.tree()
    assert.equal(t.live, true)
    assert.equal(t.sig, SIG)
    assert.deepEqual(t.input.desks.desks.map(d => d.name), ['Obra'])
    const m = await src.marks()
    // The person is in every channel: never a member id.
    assert.deepEqual(m.channels[0], { channel: 'obra', name: 'obra', unread: 2, toMe: 1, seen: 3, asks: 0, owed: 0, firstToMe: 4, firstCall: { why: 'to-you', text: 'bancada: qual fica?' }, members: ['p1', 'p2'] })
    assert.deepEqual(m.moderator, { name: 'Guga' })
    const p = await src.page('obra', 7)
    assert.deepEqual(p.members, [{ id: 'p1', name: 'conferente' }, { id: 'p2', name: 'revisor', muted: true }])
    assert.deepEqual(p.moderator, { name: 'Guga' })
    assert.equal(p.membersMore, undefined)
    assert.deepEqual(s.calls.map(c => c.op), ['tree', 'marks', 'page'])
    assert.deepEqual(s.calls[2]!.body, { channel: 'obra', before: 7 })
    assert.deepEqual(p.lines.map(l => l.seq), [5, 6])
    assert.equal(p.before, 5, 'the house\'s cursor goes back to the screen')
    assert.equal('extra' in p, false)
    // The app's pane holds an open poll's votes by who voted.
    assert.deepEqual(p.polls[0]?.open?.votes, { p2: { option: 1, name: 'revisor', at: '' } })
    assert.equal(p.polls[0]?.open?.seq, 6)
  })

  test('a thin notice reads again; a `regency.changed` with the same sig and the same `live` is skipped', async () => {
    const s = fakeSession(answering)
    const src = sessionSource(s)
    const house = new RemoteHouse(src)
    const stale: string[] = []
    house.onStale(id => stale.push(id))
    house.openViews.add('obra')
    house.start()
    await settle()
    const count = (op: string): number => s.calls.filter(c => c.op === op).length
    assert.equal(count('tree'), 1)
    assert.equal(count('marks'), 1)

    assert.equal(src.heard(EVT.regencyChanged.code, { live: true, sig: SIG }), true)
    await settle()
    assert.equal(count('tree'), 1, 'same tree: nothing asked')
    src.heard(EVT.regencyChanged.code, { live: false, sig: SIG, asOf: 1_800_000_000_000 })
    await settle()
    assert.equal(count('tree'), 2, 'the app closed: read again')

    src.heard(EVT.channelsChanged.code, { channels: ['obra'] })
    await settle()
    assert.equal(count('marks'), 2)
    assert.deepEqual(stale, ['obra'])
    src.heard(EVT.channelsChanged.code, { channels: [], all: true })
    await settle()
    assert.deepEqual(stale, ['obra', 'obra'], '`all` reads every open view again')
    // Someone else's event is not the source's.
    assert.equal(src.heard(EVT.channelsChanged.code - 0x0100, { items: [] }), false)
  })

  test('one reading of each family in flight: the calls made meanwhile share the one that follows', async () => {
    const s = fakeSession()
    const src = sessionSource(s)
    const a = src.tree()
    const b = src.tree()
    const c = src.tree()
    await settle()
    assert.equal(s.pending().length, 1)
    s.pending()[0]!.answer(ok(treeBody({ desk: 'primeira' })))
    assert.equal((await a).input.desks.desks[0]?.name, 'primeira')
    await settle()
    assert.equal(s.pending().length, 1, 'b and c are one reading')
    s.pending()[0]!.answer(ok(treeBody({ desk: 'segunda' })))
    assert.equal((await b).input.desks.desks[0]?.name, 'segunda')
    assert.equal((await c).input.desks.desks[0]?.name, 'segunda')
    assert.equal(s.calls.length, 2)

    // Pages go one at a time; the same page asked again while it waits is the same reading.
    const p1 = src.page('obra')
    const p2 = src.page('obra', 10)
    const p3 = src.page('obra', 10)
    await settle()
    assert.equal(s.pending().length, 1)
    s.pending()[0]!.answer(ok(pageBody({ from: 10, to: 12 })))
    await p1
    await settle()
    assert.equal(s.pending().length, 1)
    assert.deepEqual(s.pending()[0]!.body, { channel: 'obra', before: 10 })
    s.pending()[0]!.answer(ok(pageBody({ from: 7, to: 9, last: 12 })))
    assert.equal(await p2, await p3)
    assert.equal(s.calls.length, 4)
  })

  test('a body of the wrong shape is thrown away: the screen keeps what it had', async () => {
    let bad = false
    const s = fakeSession(op => {
      if (!bad) return answering(op)
      if (op === 'tree') return ok({ input: { desks: 'nope' }, live: true })
      if (op === 'marks') return ok({ channels: {}, more: 0 })
      return ok({ channel: { id: 'outro' }, lines: [], reactions: [], polls: [], last: 0 })
    })
    const src = sessionSource(s)
    const house = new RemoteHouse(src)
    house.start()
    await settle()
    bad = true
    await assert.rejects(src.tree(), (e: unknown) => e instanceof SourceRefused && e.why === 'malformed')
    await assert.rejects(src.marks(), (e: unknown) => e instanceof SourceRefused && e.why === 'malformed')
    await assert.rejects(src.page('obra'), (e: unknown) => e instanceof SourceRefused && e.why === 'malformed', 'a page of another channel')
    src.heard(EVT.regencyChanged.code, { live: false })
    await settle()
    assert.deepEqual(house.input().desks.desks.map(d => d.name), ['Obra'], 'the last good tree stays')
    assert.equal(house.live, true)
    // A notice of the wrong shape asks nothing.
    const before = s.calls.length
    assert.equal(src.heard(EVT.channelsChanged.code, { channels: 'obra' }), true)
    assert.equal(src.heard(EVT.regencyChanged.code, { live: 'yes' }), true)
    await settle()
    assert.equal(s.calls.length, before)
  })

  test('the fields of 3.4d: a wrong shape is thrown away; an old house that sends none still reads', async () => {
    let body: (op: string) => Record<string, unknown> = op => answering(op).body
    const src = sessionSource(fakeSession(op => ok(body(op))))
    const refused = (e: unknown): boolean => e instanceof SourceRefused && e.why === 'malformed'
    for (const moderator of ['Guga', { name: 7 }, []]) {
      body = () => ({ ...marksBody(), moderator })
      await assert.rejects(src.marks(), refused, `marks' moderator ${JSON.stringify(moderator)}`)
      body = () => ({ ...pageBody(), moderator })
      await assert.rejects(src.page('obra'), refused, `page's moderator ${JSON.stringify(moderator)}`)
    }
    body = () => ({ ...marksBody(), channels: [{ ...(marksBody().channels as Record<string, unknown>[])[0], members: 'p1' }] })
    await assert.rejects(src.marks(), refused, 'a row\'s members that is not a list')
    body = () => ({ ...pageBody(), members: { p1: 'conferente' } })
    await assert.rejects(src.page('obra'), refused, 'page members that is not a list')
    body = () => ({ ...pageBody(), members: [], membersMore: -1 })
    await assert.rejects(src.page('obra'), refused, 'membersMore that is no count')

    // An old house: no members, no moderator. The lists come empty and the name is ''.
    const old = marksBody()
    delete old.moderator
    delete (old.channels as Record<string, unknown>[])[0]!.members
    body = op => (op === 'marks' ? old : pageBody())
    const m = await src.marks()
    assert.deepEqual(m.channels[0]?.members, [])
    assert.deepEqual(m.moderator, { name: '' })
    const p = await src.page('obra')
    assert.deepEqual(p.members, [])
    assert.deepEqual(p.moderator, { name: '' })
  })

  test('the seal\'s lines of the tree come only while the app publishes, cleaned as a title', async () => {
    const withLines = (live: boolean): Record<string, unknown> => {
      const b = treeBody({ live, ...(live ? {} : { asOf: 1_800_000_000_000 }) })
      const pane = ((b.input as { desks: { desks: { panes: Record<string, unknown>[] }[] } }).desks.desks[0]!.panes[0])!
      pane.lines = ['Esperando você', 'lendo C:\\Users\\guga\\obra\\a.ts\u202e', 'três', 'quatro']
      return b
    }
    let live = true
    const src = sessionSource(fakeSession(op => (op === 'tree' ? ok(withLines(live)) : answering(op))))
    const open = await src.tree()
    const lines = (open.input.desks.desks[0]!.panes[0] as { lines?: string[] }).lines
    assert.equal(lines?.length, 3, 'at most SEAL_LINES_MAX')
    assert.equal(lines?.[0], 'Esperando você')
    assert.doesNotMatch(lines?.[1] ?? '', /Users|\u202e/)
    live = false
    const closed = await src.tree()
    assert.equal('lines' in closed.input.desks.desks[0]!.panes[0]!, false, 'the app closed: what the agent WAS doing is not said')
  })

  test('hostile text of a good body is cleaned by the house\'s rules before the screen sees it', async () => {
    const s = fakeSession(op => (op === 'page'
      ? ok({ ...pageBody({ from: 1, to: 1 }), lines: [line(1, 'oi\u202e\u0007 mundo')], channel: { id: 'obra', name: 'obra', title: 'C:\\Users\\guga\\obra' } })
      : answering(op)))
    const p = await sessionSource(s).page('obra')
    assert.equal(p.lines[0]?.body, 'oi mundo')
    assert.equal(p.channel.title, '~\\obra')
  })

  test('`too-large`: the reading fails as such, and a tree that never came still lets the screen leave "loading"', async () => {
    const s = fakeSession(op => (op === 'tree' ? { status: RES_STATUS.failed, body: { error: 'too-large' } } : answering(op)))
    const src = sessionSource(s)
    await assert.rejects(src.tree(), (e: unknown) => e instanceof SourceRefused && e.why === 'too-large')
    const house = new RemoteHouse(src)
    house.start()
    await settle()
    assert.equal(house.loaded, true)
    assert.equal(house.hasTree, false)
    assert.equal(house.treeProblem, 'too-large')
    assert.equal(house.channelsProblem, undefined)
  })

  test('no scope: without `regency:read` the channels stand on the marks; without `channels` that part goes', async () => {
    const noTree = fakeSession(op => (op === 'tree' ? { status: RES_STATUS.noScope, body: {} } : answering(op)))
    const h1 = new RemoteHouse(sessionSource(noTree))
    h1.start()
    await settle()
    assert.equal(h1.treeProblem, 'no-scope')
    assert.equal(h1.loaded, true)
    assert.deepEqual(h1.input().desks.desks, [])
    assert.deepEqual(h1.input().channels.map(c => c.id), ['obra'])
    assert.equal(h1.input().channelMarks.obra?.toMe, 1)

    const noChannels = fakeSession(op => (op === 'tree' ? answering(op) : { status: RES_STATUS.noScope, body: {} }))
    const h2 = new RemoteHouse(sessionSource(noChannels))
    h2.start()
    await settle()
    assert.equal(h2.channelsProblem, 'no-scope')
    assert.equal(h2.treeProblem, undefined)
    assert.deepEqual(h2.input().channels, [])
    assert.deepEqual(h2.input().channelMarks, {})
    assert.equal(h2.markOf('obra'), undefined)
    assert.deepEqual(h2.input().desks.desks.map(d => d.name), ['Obra'])
  })

  test('the session falls: what waits fails as `gone`; the next session reads everything again', async () => {
    const first = fakeSession()
    const src1 = sessionSource(first)
    const t = src1.tree()
    const p = src1.page('obra')
    await settle()
    assert.deepEqual(first.calls.map(c => c.op), ['tree', 'page'])
    first.calls[0]!.answer({ status: -1, body: {} })
    await assert.rejects(t, (e: unknown) => e instanceof SourceRefused && e.why === 'gone')
    // The page's request is never answered by the dead session: disposing the source ends it.
    src1.dispose()
    await assert.rejects(p, (e: unknown) => e instanceof SourceRefused && e.why === 'gone')
    await assert.rejects(src1.page('obra'), (e: unknown) => e instanceof SourceRefused && e.why === 'gone')
    await assert.rejects(src1.tree(), (e: unknown) => e instanceof SourceRefused && e.why === 'gone')
    assert.equal(src1.heard(EVT.channelsChanged.code, { channels: ['obra'] }), true, 'taken, and nothing asked')
    await settle()
    assert.equal(first.calls.length, 2)

    const second = fakeSession(answering)
    const house = new RemoteHouse(sessionSource(second))
    house.start()
    await settle()
    assert.equal(house.loaded, true)
    assert.deepEqual(second.calls.map(c => c.op).sort(), ['marks', 'tree'])
  })

  test('"trancado" tells the session to ask for presence', async () => {
    let told = 0
    const s = fakeSession(() => ({ status: RES_STATUS.locked, body: {} }))
    await assert.rejects(sessionSource(s, { onLocked: () => { told++ } }).marks(), (e: unknown) => e instanceof SourceRefused && e.why === 'locked')
    assert.equal(told, 1)
  })

  test('the pace: at most READS_PER_MIN a minute; "limit" holds every reading and asks once more', async () => {
    let clock = 1_000_000
    const waits: number[] = []
    const wait = async (ms: number): Promise<void> => { waits.push(ms); clock += ms }
    const s = fakeSession(answering)
    const src = sessionSource(s, { now: () => clock, wait })
    for (let i = 0; i < READS_PER_MIN; i++) await src.marks()
    assert.deepEqual(waits, [])
    await src.marks()
    assert.equal(waits.length, 1, 'one over the budget waits for the oldest to leave the minute')
    assert.equal(waits[0], 60_000)

    let limited = 1
    const s2 = fakeSession(op => (limited-- > 0 ? { status: RES_STATUS.limit, body: {} } : answering(op)))
    waits.length = 0
    const m = await sessionSource(s2, { now: () => clock, wait }).marks()
    assert.equal(m.channels.length, 1)
    assert.deepEqual(waits, [LIMIT_HOLD_MS])
    assert.equal(s2.calls.length, 2)

    const s3 = fakeSession(() => ({ status: RES_STATUS.limit, body: {} }))
    await assert.rejects(sessionSource(s3, { now: () => clock, wait }).tree(), (e: unknown) => e instanceof SourceRefused && e.why === 'limit')
    assert.equal(s3.calls.length, 2, 'asks once more, never in a burst')
  })
})
