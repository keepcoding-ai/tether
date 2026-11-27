// RR3 step 3.3: the channels' marks in tetherd (extensions/channels/daemon/marks.ts) give what the app's MarkBoard gives, for the
// same lines. The app's side is driven as createMarks drives it (a line heard live, the `asks` answer replacing asks and owed
// polls after a reaction or a poll event, `viewed` / `attended` raising "seen" and sending `seen`); tetherd's side is a board
// built from the record alone (the real store over fsIo in a temporary home), also after the record is opened again.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { fsIo } from '../../src/daemon/ext-io.ts'
import { MAX_HELD, MarkBoard } from '../../extensions/channels/renderer/marks.ts'
import { allMarks, marksOf, pendingOf, type RemoteMarks } from '../../extensions/channels/daemon/marks.ts'
import { registerChannelRequests } from '../../extensions/channels/daemon/requests.ts'
import { LINES_PER_FILE, openStore, TAIL_CHANNELS, type ChannelStore, type NewLine } from '../../extensions/channels/daemon/store.ts'
import { USER, type Channel, type Line, type OpenPoll } from '../../extensions/channels/rules.ts'

const MOD = 'usuário'
const A = 'a1b2c3d4'
const B = 'b2c3d4e5'

const homes: string[] = []
after(async () => { for (const h of homes) await fsIo.rm(h) })
async function newHome(): Promise<string> {
  const home = await mkdtemp(join(process.env.TETHER_BENCH_DIR ?? tmpdir(), 'tether-marks-daemon-'))
  homes.push(home)
  return home
}
let tick = 0
const options = { now: () => new Date(Date.UTC(2026, 10, 27, 12, 0, tick++)) }

const agent = (id: string): Line['from'] => ({ id, name: id === A ? 'conferente' : 'revisor', role: 'member' })
const her: Line['from'] = { id: USER, name: MOD, role: 'moderator' }

/** The app's MarkBoard driven as createMarks drives it, next to the record it reads. */
class Bench {
  readonly app = new MarkBoard()
  readonly store: ChannelStore
  readonly ch: Channel
  constructor(store: ChannelStore, ch: Channel) { this.store = store; this.ch = ch }
  static async open(store: ChannelStore): Promise<Bench> {
    const made = await store.create({ name: 'obra', owner: { kind: 'user' }, createdBy: USER })
    assert.ok(made.ok)
    for (const [id, name] of [[A, 'conferente'], [B, 'revisor']] as const) assert.ok((await store.join(made.channel.id, id, name, 'user')).ok)
    return new Bench(store, made.channel)
  }
  get id(): string { return this.ch.id }
  /** What the app asks after a reaction or a poll event: the daemon's `asks` answer. */
  async refreshAsks(): Promise<void> {
    const { asks, polls } = await pendingOf(this.store, this.ch)
    this.app.setAsks(this.id, asks)
    this.app.setOwed(this.id, polls)
  }
  async say(from: Line['from'], body: string, to?: string[]): Promise<Line> {
    const line = await this.store.append(this.id, { kind: 'message', from, body, ...(to ? { to } : {}) })
    this.app.hear(this.id, line, MOD)
    return line
  }
  async react(from: Line['from'], on: number, emoji: string, op: 'add' | 'remove' = 'add'): Promise<Line> {
    const line = await this.store.append(this.id, { kind: 'reaction', from, body: '', react: { seq: on, emoji, op } })
    await this.refreshAsks()
    return line
  }
  async poll(from: Line['from'], question: string, to: Array<{ id: string; name: string }>): Promise<Line> {
    const spec = { type: 'ok' as const, question, options: ['ok', 'não ok'], to, closesAt: new Date(Date.UTC(2026, 10, 28)).toISOString() }
    const line = await this.store.append(this.id, { kind: 'poll', from, body: '', poll: spec } satisfies NewLine)
    const open: OpenPoll = { ...spec, seq: line.seq, author: { id: from.id, name: from.name }, votes: {} }
    assert.ok((await this.store.openPoll(this.id, open)).ok)
    this.app.hear(this.id, line, MOD)
    await this.refreshAsks()
    return line
  }
  async vote(who: Line['from'], poll: number, option: number): Promise<void> {
    await this.store.append(this.id, { kind: 'vote', from: who, body: '', vote: { poll, option } })
    assert.ok((await this.store.setVote(this.id, poll, who.id, { option, at: new Date().toISOString(), name: who.name }, false)).ok)
    await this.refreshAsks()
  }
  async closePoll(poll: number): Promise<void> {
    const line = await this.store.append(this.id, { kind: 'notice', from: { id: 'tether', name: 'tether', role: 'system' }, body: 'fechou', event: { type: 'poll-close' } })
    assert.ok((await this.store.closePoll(this.id, poll, line.seq)).ok)
    await this.refreshAsks()
  }
  /** The pane showed the end of the conversation: the app raises its board and sends `seen` (the daemon raises the record). */
  viewed(seq: number): void {
    this.app.viewed(this.id, seq)
    this.store.markSeen(this.id, seq)
  }
  attended(seq: number): void {
    const r = this.app.attended(this.id, seq)
    if (r.persist) this.store.markSeen(this.id, seq)
  }
  /** The app's marks, in the shape of the daemon's. */
  appMarks(board = this.app): RemoteMarks {
    const call = board.firstCall(this.id)
    return {
      channel: this.id, name: this.ch.name, ...board.of(this.id),
      asks: board.asksOf(this.id).length, owed: board.owedOf(this.id).length, ...(call ? { firstCall: call } : {}),
      members: Object.keys(this.ch.members),
    }
  }
  async same(why: string): Promise<RemoteMarks> {
    const daemon = await marksOf(this.store, this.ch, MOD)
    assert.deepEqual(daemon, this.appMarks(), why)
    return daemon
  }
}

describe('the marks in tetherd follow the app rule', () => {
  test('speeches, speeches to her, reactions that ask her, polls, votes, seen and attended: the same at every step', async () => {
    const b = await Bench.open(await openStore(fsIo, await newHome(), options))
    await b.same('an empty channel')
    const s1 = await b.say(agent(A), 'começo a conferência')
    await b.same('one plain line')
    await b.say(agent(B), 'Posso seguir com a\nsegunda parte?', [MOD])
    let m = await b.same('a speech to her')
    assert.deepEqual([m.unread, m.toMe, m.firstCall?.why], [2, 1, 'to-you'])
    assert.equal(m.firstCall?.text, 'revisor: Posso seguir com a')
    const mine = await b.say(her, 'veja isto')
    await b.same('her own speech counts nothing')
    await b.react(agent(A), mine.seq, '❓')
    await b.react(agent(B), s1.seq, '❓')
    m = await b.same('a ❓ on her speech asks her; on an agent speech it asks nothing')
    assert.equal(m.asks, 1)
    b.viewed(mine.seq)
    m = await b.same('seen up to her speech: the lines go, the ask after it stays')
    assert.deepEqual([m.unread, m.toMe, m.asks], [0, 0, 1])
    const p = await b.poll(agent(A), 'Fecho a obra hoje?', [{ id: USER, name: MOD }, { id: B, name: 'revisor' }])
    m = await b.same('a poll that calls her')
    assert.deepEqual([m.owed, m.unread], [1, 1])
    b.viewed(p.seq)
    m = await b.same('a poll she saw still waits for her vote, with its question')
    assert.deepEqual([m.owed, m.unread, m.asks], [1, 0, 0])
    assert.deepEqual(m.firstCall, { why: 'poll-owed', text: 'Enquete de conferente: Fecho a obra hoje?' })
    await b.vote(agent(B), p.seq, 1)
    await b.same('another one voted: it still waits for her')
    await b.vote(her, p.seq, 1)
    m = await b.same('she voted: nothing waits')
    assert.equal(m.owed, 0)
    const p2 = await b.poll(agent(B), 'E amanhã?', [{ id: USER, name: MOD }])
    await b.closePoll(p2.seq)
    await b.same('a poll closed before her vote waits no more')
    const mine2 = await b.say(her, 'mais uma')
    await b.say(agent(A), 'linha abaixo')
    const ask = await b.react(agent(B), mine2.seq, '❌')
    await b.same('an ask with an unread line below it')
    // Looked at in place with an unread line below: the app forgets the ask for its own session only (nothing is sent), so the
    // record, and the device that reads it, still has it. The one difference, and it is the app's session state, not "seen".
    b.attended(ask.seq)
    const d = await marksOf(b.store, b.ch, MOD)
    assert.deepEqual([b.appMarks().asks, d.asks], [0, 1])
    assert.deepEqual({ ...b.appMarks(), asks: 1, firstCall: d.firstCall }, d)
  })

  test('attended with nothing unseen below raises "seen" for both; a ❓ taken back leaves both', async () => {
    const b = await Bench.open(await openStore(fsIo, await newHome(), options))
    const mine = await b.say(her, 'pergunta')
    const ask = await b.react(agent(A), mine.seq, '❓')
    await b.same('an ask')
    b.attended(ask.seq)
    const m = await b.same('attended: seen raised to the ask')
    assert.deepEqual([m.seen, m.asks], [ask.seq, 0])
    const mine2 = await b.say(her, 'outra')
    await b.react(agent(A), mine2.seq, '❌')
    await b.react(agent(A), mine2.seq, '❌', 'remove')
    assert.equal((await b.same('taken back')).asks, 0)
  })

  test('a restart of tetherd (the record opened again) and of the app (one page of history) give the same marks', async () => {
    const home = await newHome()
    const store = await openStore(fsIo, home, options)
    const b = await Bench.open(store)
    for (let i = 0; i < 6; i++) await b.say(agent(i % 2 ? A : B), `fala ${i}`, i === 4 ? [MOD] : undefined)
    b.viewed(3)
    const mine = await b.say(her, 'sigo?')
    await b.react(agent(A), mine.seq, '❓')
    const p = await b.poll(agent(B), 'Qual caminho?', [{ id: USER, name: MOD }])
    b.viewed(p.seq)
    await b.say(agent(A), 'depois da enquete', [MOD])
    const before = await b.same('before the restart')
    await store.flush()

    const again = await openStore(fsIo, home, options)
    const ch = again.get(b.id)!
    assert.equal(ch.seenByUser, p.seq, 'the "seen" the app sent is in the record')
    assert.deepEqual(await marksOf(again, ch, MOD), before, 'tetherd opened again: the same marks')

    // The app opening again reads one page of history (createMarks reconcile) and the `asks` answer.
    const app = new MarkBoard()
    const page = await again.history(ch.id, undefined, 50)
    app.load(ch.id, page, ch.seenByUser, MOD)
    const { asks, polls } = await pendingOf(again, ch)
    app.setAsks(ch.id, asks)
    app.setOwed(ch.id, polls)
    assert.deepEqual(new Bench(again, ch).appMarks(app), before, 'the app opened again: the same marks')
  })

  test('the count stops at MAX_HELD on both sides', async () => {
    const b = await Bench.open(await openStore(fsIo, await newHome(), options))
    for (let i = 0; i < MAX_HELD + 40; i++) await b.say(agent(A), `fala ${i}`)
    assert.equal((await b.same('past the ceiling')).unread, MAX_HELD)
  })
})

// RR3 gate M-1: `marks` read every channel with unseen lines from disk at every request (the same window twice, out of the
// tail cache), and pushed the app's tails out of the LRU. The receipt: 40 channels with 2,000 unseen lines each, 100 marks
// in a row read at most one file per channel in all, and the tails the app read last stay in memory, in their order.
describe('the cost of `marks`', () => {
  test('40 channels with 2,000 unseen lines: 100 marks read each channel once and never push out the app\'s tails', async () => {
    const home = await newHome()
    const setup = await openStore(fsIo, home, options)
    const ids: string[] = []
    for (let i = 0; i < 40; i++) {
      const made = await setup.create({ name: `mesa-${i}`, owner: { kind: 'user' }, createdBy: USER })
      assert.ok(made.ok)
      ids.push(made.channel.id)
    }
    const at = new Date(Date.UTC(2026, 10, 27, 12)).toISOString()
    for (const id of ids) {
      const dir = join(home, 'channels', id)
      await mkdir(dir, { recursive: true })
      for (let f = 0; f < 2_000 / LINES_PER_FILE; f++) {
        const lines = Array.from({ length: LINES_PER_FILE }, (_, j) => JSON.stringify({ seq: f * LINES_PER_FILE + j + 1, at, kind: 'message', from: agent(A), body: `fala ${j}` }))
        await writeFile(join(dir, `${String(f + 1).padStart(6, '0')}.jsonl`), `${lines.join('\n')}\n`)
      }
    }
    let reads = 0
    const io = { ...fsIo, tryReadText: (p: string) => { reads++; return fsIo.tryReadText(p) } }
    const store = await openStore(io, home, options)
    // The app's channels pane read the last TAIL_CHANNELS channels: their tails are what the LRU holds.
    for (const id of ids.slice(0, TAIL_CHANNELS)) await store.history(id, undefined, 50)
    const cached = store.cachedChannels()
    assert.equal(cached.length, TAIL_CHANNELS)

    reads = 0
    let rows: RemoteMarks[] = []
    for (let i = 0; i < 100; i++) rows = await allMarks(store, MOD)
    assert.ok(reads <= ids.length, `100 marks read ${reads} files (at most one per channel)`)
    assert.deepEqual(store.cachedChannels(), cached, 'the app\'s tails stay, in their order')
    assert.equal(rows.length, ids.length)
    assert.ok(rows.every((r) => r.unread === MAX_HELD), 'the count stops at MAX_HELD')

    // One new line in one channel: only that channel is read again (its window may span two files).
    await store.append(ids[39]!, { kind: 'message', from: agent(B), body: 'nova', to: [MOD] })
    reads = 0
    rows = await allMarks(store, MOD)
    assert.ok(reads <= 2, `one channel changed: ${reads} files read`)
    assert.equal(rows.find((r) => r.channel === ids[39])?.firstCall?.text, 'revisor: nova')
    assert.deepEqual(store.cachedChannels(), cached)

    // Her "seen" changes the marks of that channel, and only of that one.
    store.markSeen(ids[39]!, 2_001)
    reads = 0
    rows = await allMarks(store, MOD)
    assert.ok(reads <= 2)
    assert.deepEqual([rows.find((r) => r.channel === ids[39])?.unread, rows.find((r) => r.channel === ids[0])?.unread], [0, MAX_HELD])
  })
})

describe('the `marks` request', () => {
  test('answers every open channel, never a closed one', async () => {
    const store = await openStore(fsIo, await newHome(), options)
    const b = await Bench.open(store)
    await b.say(agent(A), 'oi', [MOD])
    const other = await store.create({ name: 'fechado', owner: { kind: 'user' }, createdBy: USER })
    assert.ok(other.ok)
    assert.ok((await store.close(other.channel.id, USER)).ok)
    const handlers = new Map<string, (args: unknown, ctx: unknown) => Promise<unknown>>()
    const api = { requests: { handle: (name: string, fn: (args: unknown, ctx: unknown) => Promise<unknown>) => { handlers.set(name, fn); return { dispose: () => {} } } } }
    const channels = { store, nameOf: (who: string) => (who === USER ? MOD : who) }
    for (const d of registerChannelRequests(api as never, Promise.resolve(channels as never))) void d
    const r = await handlers.get('marks')!(undefined, { client: 'remote' }) as { channels: RemoteMarks[] }
    assert.deepEqual(r, { channels: await allMarks(store, MOD), moderator: { name: MOD } })
    assert.deepEqual(r.channels.map((c) => [c.name, c.unread, c.toMe, c.firstCall?.text]), [['obra', 1, 1, 'conferente: oi']])
    // RR3.4d: the members now, by id; a member who joins changes the row even when the memo had it.
    const was = r.channels[0]!.members
    assert.deepEqual(was, Object.keys(store.get(r.channels[0]!.channel)!.members))
    assert.ok((await store.join(r.channels[0]!.channel, 'n3w4g3nt', 'novo', 'user')).ok)
    const after = await allMarks(store, MOD)
    assert.deepEqual(after[0]!.members, [...was, 'n3w4g3nt'])
  })

  // RR3 temper O-1: a "seen" that moves the mark is told thin (id and mark); one that does not move it is silent.
  test('`seen` that advances emits a thin event and the next `marks` reflects it; one that does not advance emits nothing', async () => {
    const store = await openStore(fsIo, await newHome(), options)
    const b = await Bench.open(store)
    const l1 = await b.say(agent(A), 'um', [MOD])
    const l2 = await b.say(agent(A), 'dois', [MOD])
    const handlers = new Map<string, (args: unknown, ctx: unknown) => Promise<unknown>>()
    const emitted: Array<[string, unknown]> = []
    const api = {
      requests: { handle: (name: string, fn: (args: unknown, ctx: unknown) => Promise<unknown>) => { handlers.set(name, fn); return { dispose: () => {} } } },
      events: { emit: (name: string, payload: unknown) => { emitted.push([name, payload]) } },
    }
    const channels = { store, nameOf: (who: string) => (who === USER ? MOD : who) }
    const disposables = registerChannelRequests(api as never, Promise.resolve(channels as never), 1)
    const marks = async (): Promise<RemoteMarks> => ((await handlers.get('marks')!(undefined, { client: 'remote' })) as { channels: RemoteMarks[] }).channels[0]!
    assert.equal((await marks()).unread, 2)

    await handlers.get('seen')!({ channel: b.id, seq: l1.seq }, { client: 'app' })
    assert.deepEqual(emitted, [['seen', { channelId: b.id, seenByUser: l1.seq }]])
    assert.equal((await marks()).unread, 1)

    await handlers.get('seen')!({ channel: b.id, seq: l1.seq }, { client: 'app' })
    await handlers.get('seen')!({ channel: b.id, seq: 0 }, { client: 'app' })
    assert.equal(emitted.length, 1, 'no advance, no event')

    await handlers.get('seen')!({ channel: b.id, seq: l2.seq }, { client: 'app' })
    assert.equal(emitted.length, 2)
    assert.equal((await marks()).unread, 0)
    for (const d of disposables) d.dispose()
  })
})
