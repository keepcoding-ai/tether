// The person talking from afar: `say`, `react`, `vote`, `poll` and `seen` take the `remote` client as they take `app` (gate
// `person`), and everything that manages the channel stays with `app` alone (gate `moderator`). Any other client gets neither.
// The handlers run over a stub of the fan-out: what is proved is the gate and that the same call (the person, `USER`) is made.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { registerChannelRequests } from '../../extensions/channels/daemon/requests.ts'
import { USER } from '../../extensions/channels/rules.ts'
import { EXT_WRITES, REMOTE_EXT_PAIRS } from '../../src/remoted/reach.ts'

type Handler = (args: unknown, ctx: unknown) => Promise<unknown>
const PERSON = ['say', 'react', 'vote', 'poll', 'seen'] as const
const MANAGE = ['create', 'join', 'remove', 'mute', 'unmute', 'close', 'reopen', 'poll-close'] as const
const code = (c: string) => (e: unknown): boolean => (e as { code?: string }).code === c

const ARGS: Record<string, unknown> = {
  say: { channel: 'c1', text: 'bom dia', to: ['a1'] },
  react: { channel: 'c1', seq: 3, reaction: 'agree' },
  vote: { channel: 'c1', poll: 2, vote: 1 },
  poll: { channel: 'c1', question: 'vamos?', options: ['sim', 'não'] },
  seen: { channel: 'c1', seq: 4 },
  create: { name: 'x' }, join: { channel: 'c1', agent: 'a1' }, remove: { channel: 'c1', agent: 'a1' }, mute: { channel: 'c1', agent: 'a1' },
  unmute: { channel: 'c1', agent: 'a1' }, close: { channel: 'c1' }, reopen: { channel: 'c1' }, 'poll-close': { channel: 'c1', poll: 2 },
}

function bench() {
  const calls: { verb: string; who: unknown; args: unknown[] }[] = []
  const ch = { id: 'c1', name: 'obra', title: 'Obra', owner: { kind: 'user' }, members: {}, seenByUser: 0, createdAt: 't' }
  const poll = { seq: 2, question: 'q', options: [], votes: {}, closesAt: 't' }
  const rec = <T>(verb: string, out: T) => (who: unknown, ...args: unknown[]): Promise<T> => { calls.push({ verb, who, args }); return Promise.resolve(out) }
  const channels = {
    store: { get: () => ch, markSeen: (_id: string, seq: number) => { ch.seenByUser = Math.max(ch.seenByUser, seq) }, flush: async () => {} },
    nameOf: (w: string) => w,
    say: rec('say', { ok: true, line: { seq: 9 }, receipts: {} }),
    react: rec('react', { ok: true, changed: true, reaction: { emoji: 'x' } }),
    vote: rec('vote', { ok: true, changed: true, option: 1, poll }),
    poll: rec('poll', { ok: true, line: { seq: 2 }, poll, deaf: [] }),
    create: rec('create', { ok: true, channel: ch }), join: rec('join', { ok: true, channel: ch, already: false }),
    remove: rec('remove', { ok: true, channel: ch }), mute: rec('mute', { ok: true, channel: ch, changed: true }),
    unmute: rec('unmute', { ok: true, channel: ch, changed: true }), close: rec('close', { ok: true, channel: ch }),
    reopen: rec('reopen', { ok: true, channel: ch }), pollClose: rec('pollClose', { ok: true, result: {}, line: { at: 't' } }),
  }
  const handlers = new Map<string, Handler>()
  const api = { requests: { handle: (name: string, fn: Handler) => { handlers.set(name, fn); return { dispose: () => {} } } } }
  const disposables = registerChannelRequests(api as never, Promise.resolve(channels as never), 1)
  const ask = (name: string, client: string): Promise<unknown> => handlers.get(name)!(ARGS[name], { client })
  return { calls, ask, handlers, done: () => disposables.forEach((d) => d.dispose()) }
}

describe('channels requests: the person talks from afar', () => {
  test('remote says, reacts, votes, opens a poll and marks seen; the call is the same as the app\'s (the person, USER)', async () => {
    const b = bench()
    for (const name of PERSON) {
      await b.ask(name, 'app')
      await b.ask(name, 'remote')
    }
    const seq = (b.calls.length) / 2
    assert.equal(seq, 4, 'say, react, vote and poll reach the fan-out (seen only marks)')
    for (let i = 0; i < b.calls.length; i += 2) {
      assert.equal(b.calls[i]!.who, USER)
      // From afar the speech and the poll carry the mark of origin, written by the tether from the pipe's client; the rest is the app's.
      const remote = b.calls[i + 1]!
      const marked = remote.verb === 'say' || remote.verb === 'poll'
      const args = remote.args.map((a) => {
        if (!marked || typeof a !== 'object' || a === null || !('fromAfar' in a)) return a
        assert.equal((a as { fromAfar: unknown }).fromAfar, true, remote.verb)
        const { fromAfar: _drop, ...rest } = a as Record<string, unknown>
        return rest
      })
      assert.deepEqual({ ...remote, args }, b.calls[i], b.calls[i]!.verb)
      if (marked) assert.ok(remote.args.some((a) => typeof a === 'object' && a !== null && 'fromAfar' in a), `${remote.verb}: marked`)
    }
    b.done()
  })

  test('remote is refused (not-moderator) at every request that manages the channel, and nothing reaches the fan-out', async () => {
    const b = bench()
    for (const name of MANAGE) await assert.rejects(b.ask(name, 'remote'), code('not-moderator'), name)
    assert.deepEqual(b.calls, [])
    for (const name of MANAGE) await b.ask(name, 'app')
    assert.equal(b.calls.length, MANAGE.length, 'the app still manages')
    b.done()
  })

  test('cli and any other client are refused at the talking requests too', async () => {
    const b = bench()
    for (const client of ['cli', 'test', 'portal'])
      for (const name of PERSON) await assert.rejects(b.ask(name, client), code('not-moderator'), `${client} ${name}`)
    assert.deepEqual(b.calls, [])
    b.done()
  })

  test("the talking requests are exactly the channels' pairs of EXT_WRITES (what the portal may send and tetherd lets through)", () => {
    const pairs = Object.values(EXT_WRITES).filter((p) => p.ext === 'channels').map((p) => p.name).sort()
    assert.deepEqual(pairs, [...PERSON].sort())
    assert.equal(Object.values(EXT_WRITES).every((p) => p.ext === 'channels'), true)
    for (const name of MANAGE) assert.equal(REMOTE_EXT_PAIRS.some((p) => p.ext === 'channels' && p.name === name), false, `${name}: never in the reach`)
  })

  test('every request the file registers is either talking or managing or a read: none escapes the lists', () => {
    const b = bench()
    const known = new Set<string>([...PERSON, ...MANAGE, 'list', 'members', 'history', 'asks', 'marks'])
    assert.deepEqual([...b.handlers.keys()].filter((n) => !known.has(n)), [])
    b.done()
  })
})
