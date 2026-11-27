// RR3 step 3.3: the channels' marks in tetherd (extensions/channels/daemon/marks.ts) give what the app's MarkBoard gives, for the
// same lines. The app's side is driven as createMarks drives it (a line heard live, the `asks` answer replacing asks and owed
// polls after a reaction or a poll event, `viewed` / `attended` raising "seen" and sending `seen`); tetherd's side is a board
// built from the record alone (the real store over fsIo in a temporary home), also after the record is opened again.
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { fsIo } from '../../src/daemon/ext-io.ts'
import { MAX_HELD, MarkBoard } from '../../extensions/channels/renderer/marks.ts'
import { allMarks, marksOf, pendingOf, type RemoteMarks } from '../../extensions/channels/daemon/marks.ts'
import { registerChannelRequests } from '../../extensions/channels/daemon/requests.ts'
import { openStore, type ChannelStore, type NewLine } from '../../extensions/channels/daemon/store.ts'
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
    assert.deepEqual(r, { channels: await allMarks(store, MOD) })
    assert.deepEqual(r.channels.map((c) => [c.name, c.unread, c.toMe, c.firstCall?.text]), [['obra', 1, 1, 'conferente: oi']])
  })
})
