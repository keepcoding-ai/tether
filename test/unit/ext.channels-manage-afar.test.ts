// RR5 (fio-spec 18): the person manages a channel from afar. Over the real fan-out and store: each managing act asked by a
// `remote` client (requests.ts gate `manager`) writes the same system line the app's would, marked `afar` and saying
// "(de longe)" right after who did it, once; the same act from the app carries no mark; a client that is neither is refused.
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import type { DeliveryMessage } from '../../src/daemon/ext-api.ts'
import { fsIo } from '../../src/daemon/ext-io.ts'
import { AFAR_MARK, createChannels, type Channels, type ChannelsApi } from '../../extensions/channels/daemon/fanout.ts'
import { openStore } from '../../extensions/channels/daemon/store.ts'
import { registerChannelRequests } from '../../extensions/channels/daemon/requests.ts'
import type { Line } from '../../extensions/channels/rules.ts'
import { removeHome, tempHome } from './daemon.basics.ts'

type Handler = (args: unknown, ctx: unknown) => Promise<unknown>

describe('channels: the person manages from afar, and the system line says so', () => {
  let home: string
  let ch: Channels
  const handlers = new Map<string, Handler>()
  const delivered: DeliveryMessage[] = []
  const slot = (id: string, name: string) => ({ slotId: id, kind: 'claude', status: 'running', name, cwd: '/x' })
  const SLOTS: Record<string, ReturnType<typeof slot>> = { A: slot('A', 'alfa'), B: slot('B', 'bravo') }
  const ask = (name: string, args: Record<string, unknown>, client: string): Promise<any> => handlers.get(name)!(args, { client })
  const lines = async (id: string): Promise<Line[]> => ch.store.since(id, 0, 500)
  const last = async (id: string): Promise<Line> => (await lines(id)).at(-1)!

  before(async () => {
    home = tempHome()
    const none = { dispose: () => {} }
    const api = {
      slots: { get: (s: string) => SLOTS[s], list: () => Object.values(SLOTS), onState: () => none, userTypedAt: () => undefined },
      delivery: {
        onDidDeliver: () => none,
        deliver: async (s: string, msg: DeliveryMessage) => { delivered.push(msg); return { id: `r${delivered.length}`, slotId: s, state: 'inside' } },
        pending: () => [], cancel: () => false, routeOf: () => 'inside', hasTools: () => true,
      },
      events: { emit: () => {} }, settings: { get: () => undefined }, log: () => {},
      requests: { handle: (name: string, fn: Handler) => { handlers.set(name, fn); return none } },
    } as unknown as ChannelsApi
    ch = createChannels(api, await openStore(fsIo, home))
    registerChannelRequests(api as never, Promise.resolve(ch), 1)
  })
  after(async () => { await removeHome(home) })

  test('create, join, mute, unmute, remove, close, reopen and a poll closed: each line marked, the text says it once', async () => {
    const made = await ask('create', { name: 'longe' }, 'remote')
    const id = made.channel.id as string
    const marked = async (what: string): Promise<Line> => {
      const l = await last(id)
      assert.equal(l.kind, 'notice', what)
      assert.equal(l.afar, true, `${what}: marked`)
      assert.equal(l.body.split(AFAR_MARK).length - 1, 1, `${what}: "(de longe)" once: ${l.body}`)
      return l
    }
    await marked('create')
    await ask('join', { channel: id, agent: 'A' }, 'remote'); await marked('join')
    await ask('join', { channel: id, agent: 'B' }, 'remote'); await marked('join')
    await ask('mute', { channel: id, agent: 'B' }, 'remote'); await marked('mute')
    await ask('unmute', { channel: id, agent: 'B' }, 'remote'); await marked('unmute')
    await ask('remove', { channel: id, agent: 'B' }, 'remote'); await marked('remove')
    const opened = await ask('poll', { channel: id, question: 'Seguimos?', to: ['A'] }, 'remote')
    const closed = await ask('poll-close', { channel: id, poll: opened.seq }, 'remote')
    assert.equal(closed.result.poll, opened.seq)
    const pc = await marked('poll-close')
    assert.match(pc.body.split('\n')[0]!, /encerrada por .+ \(de longe\)\.$/, 'the first sentence names who and says from afar')
    await ask('close', { channel: id }, 'remote'); await marked('close')
    await ask('reopen', { channel: id }, 'remote'); await marked('reopen')
    // What the agents got of a marked line is its text, the mark with it.
    assert.ok(delivered.some((m) => m.kind === 'notice' && m.body.includes(AFAR_MARK)))
  })

  test('the same acts from the app carry no mark; a client that is neither the app nor a device is refused', async () => {
    const made = await ask('create', { name: 'perto' }, 'app')
    const id = made.channel.id as string
    await ask('join', { channel: id, agent: 'A' }, 'app')
    await ask('mute', { channel: id, agent: 'A' }, 'app')
    await ask('close', { channel: id }, 'app')
    for (const l of (await lines(id)).filter((x) => x.kind === 'notice')) {
      assert.equal(l.afar, undefined, l.body)
      assert.equal(l.body.includes(AFAR_MARK), false, l.body)
    }
    for (const client of ['cli', 'test', 'portal'])
      await assert.rejects(ask('reopen', { channel: id }, client), (e: unknown) => (e as { code?: string }).code === 'not-moderator', client)
  })
})
