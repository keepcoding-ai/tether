// The person talking from afar: `say`, `react`, `vote`, `poll` and `seen` take the `remote` client as they take `app` (gate
// `person`), and so does managing the channel (gate `manager`, RR5), whose calls from afar carry the mark of origin. Any other
// client gets neither.
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

  test('remote manages the channel as the app does (gate `manager`, RR5): the same call, and from afar the mark on the system line', async () => {
    const b = bench()
    for (const name of MANAGE) {
      await b.ask(name, 'app')
      await b.ask(name, 'remote')
    }
    assert.equal(b.calls.length, MANAGE.length * 2)
    for (let i = 0; i < b.calls.length; i += 2) {
      const app = b.calls[i]!
      const remote = b.calls[i + 1]!
      assert.equal(app.who, USER, app.verb)
      assert.equal(remote.who, USER, remote.verb)
      // The app's call carries no mark; the device's carries `fromAfar: true` (in the input of `create`, the last argument of the rest).
      const flat = (args: unknown[]): unknown[] => args.flatMap((a) => (a && typeof a === 'object' ? [a] : []))
      assert.equal(flat(app.args).some((a) => 'fromAfar' in (a as object)), false, `${app.verb}: no mark from the app`)
      assert.equal(flat(remote.args).some((a) => (a as { fromAfar?: unknown }).fromAfar === true), true, `${remote.verb}: marked from afar`)
      const strip = (args: unknown[]): unknown[] => args.map((a) => {
        if (!a || typeof a !== 'object' || !('fromAfar' in a)) return a
        const { fromAfar: _drop, ...rest } = a as Record<string, unknown>
        return Object.keys(rest).length ? rest : undefined
      })
      assert.deepEqual(strip(remote.args), strip(app.args).map((a) => (a && typeof a === 'object' && Object.keys(a).length === 0 ? undefined : a)), remote.verb)
    }
    b.done()
  })

  test('cli and any other client are refused at the talking and the managing requests', async () => {
    const b = bench()
    for (const client of ['cli', 'test', 'portal'])
      for (const name of [...PERSON, ...MANAGE]) await assert.rejects(b.ask(name, client), code('not-moderator'), `${client} ${name}`)
    assert.deepEqual(b.calls, [])
    b.done()
  })

  test("the talking and managing requests are exactly the channels' pairs of EXT_WRITES (what the portal may send and tetherd lets through)", () => {
    const pairs = Object.values(EXT_WRITES).filter((p) => p.ext === 'channels').map((p) => p.name).sort()
    assert.deepEqual(pairs, [...PERSON, ...MANAGE].sort())
    // Besides the channels' pairs, only the Regency's writes (the bridge of acts, RR5 5.1; the creation, RR5 5.3) are write pairs.
    assert.equal((Object.values(EXT_WRITES) as { ext: string; name: string }[]).every((p) => p.ext === 'channels' || (p.ext === 'regency' && (p.name === 'act' || p.name === 'create'))), true)
    for (const name of MANAGE) assert.equal(REMOTE_EXT_PAIRS.some((p) => p.ext === 'channels' && p.name === name), true, `${name}: in the reach`)
  })

  test('every request the file registers is either talking or managing or a read: none escapes the lists', () => {
    const b = bench()
    const known = new Set<string>([...PERSON, ...MANAGE, 'list', 'members', 'history', 'asks', 'marks'])
    assert.deepEqual([...b.handlers.keys()].filter((n) => !known.has(n)), [])
    b.done()
  })
})
