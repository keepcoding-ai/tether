// The verbs of `channels` (extensions/channels/daemon/verbs.ts, slices H3a and H3b) in a real tetherd on a test home and test
// pipe, with the real store, the real fan-out and the core's real delivery. The agents are fake `claude` slots
// (test/fixtures/channels/agent.cjs, no stream, no LLM). The MCP exit is the door's verb registry; the CLI exit is the pipe's
// `verb` request. The user's home, pipe and tetherd are never touched.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, test } from 'node:test'
import { DisposableStore } from '../../app/shared/vscode-lifecycle.ts'
import '../../src/agents/load.ts'
import { agentRegistry, type AgentContribution } from '../../src/agents/registry.ts'
import type { AgentAdapter, LaunchPlan } from '../../src/agents/types.ts'
import { DoorHost } from '../../src/daemon/door/host.ts'
import type { DeliveryMessage, DoorApi, VerbResult } from '../../src/daemon/door/types.ts'
import { fsIo } from '../../src/daemon/ext-io.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { createChannels, type Channels, type ChannelsApi } from '../../extensions/channels/daemon/fanout.ts'
import { openStore } from '../../extensions/channels/daemon/store.ts'
import { joinedNotice } from '../../extensions/channels/daemon/notices.ts'
import { CHANNEL_VERBS, INSTRUCTIONS, registerVerbs } from '../../extensions/channels/daemon/verbs.ts'
import { EXT_ID } from '../../extensions/channels/manifest.ts'
import { Recorder, removeHome, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

const AGENT = fileURLToPath(new URL('../fixtures/channels/agent.cjs', import.meta.url))
const data = (r: VerbResult): Record<string, any> => r.data as Record<string, any>
const codeOf = (r: VerbResult): unknown => (r.data as { error?: string } | undefined)?.error
const clean = (r: VerbResult): unknown => ({ ...data(r), proven: undefined })

describe('channels verbs (H3a: list, create, members, read, close, reopen)', () => {
  let home: string
  let daemon: Daemon
  let rec: Recorder
  let door: DoorHost
  let doorApi: DoorApi
  let ch: Channels
  const own = new DisposableStore()
  const logs: string[] = []
  const sent: { slotId: string; room: string | undefined; body: string }[] = []

  const fake: AgentAdapter = {
    name: 'claude',
    plan: (input): LaunchPlan => {
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
      delete env.NODE_TEST_CONTEXT
      env.ECHO_LOG = join(home, `echo-${input.slot.slotId}.log`)
      env.CHAN_LOG = join(home, `chan-${input.slot.slotId}.log`)
      env.OPEN_STREAM = '0'
      return { command: process.execPath, args: [AGENT], cwd: input.slot.cwd, env }
    },
    sessionExists: async () => 'unknown',
    title: async (b) => b.title,
  }
  // The fake is `node <script>`: the door's channel flag would be read by node.
  const contribution = agentRegistry.get('claude')! as { channels?: AgentContribution['channels'] }
  const savedChannels = contribution.channels
  before(() => { contribution.channels = () => [] })
  after(() => { contribution.channels = savedChannels })

  before(async () => {
    home = tempHome()
    door = new DoorHost({ log: (m) => logs.push(m) })
    daemon = await startDaemon({
      home, pipe: uniquePipe(home), memoryIntervalMs: 0, readyFallbackMs: 300, minAgentAgeMs: 0, adapters: { claude: fake }, channelOf: () => undefined, door,
      log: (m) => logs.push(m),
    })
    rec = await Recorder.connect(daemon.pipe)
    doorApi = door.apiFor(EXT_ID, own)
    own.add(doorApi.delivery.enable())
    const api: ChannelsApi & Pick<DoorApi, 'verbs'> = {
      slots: doorApi.slots, attention: doorApi.attention, verbs: doorApi.verbs,
      // Records what the fan-out hands to the core's delivery (the room and the body per slot), then delegates.
      delivery: Object.assign(Object.create(doorApi.delivery) as DoorApi['delivery'], {
        deliver: (slotId: string, msg: DeliveryMessage, opts?: { paths?: readonly ('inside' | 'terminal')[] }) => {
          sent.push({ slotId, room: msg.room, body: msg.body })
          return doorApi.delivery.deliver(slotId, msg, opts)
        },
      }),
      events: { emit: () => {} }, settings: { get: () => undefined }, log: (m) => logs.push(m),
    }
    ch = createChannels(api, await openStore(fsIo, home))
    for (const d of registerVerbs(api, Promise.resolve(ch))) own.add(d)
  })
  after(async () => {
    ch?.dispose()
    await door.delivery.flush().catch(() => {})
    own.dispose()
    door.delivery.dispose()
    rec?.close()
    await daemon?.close()
    await door.mcp.close()
    await removeHome(home)
  })

  const running = async (name: string): Promise<string> => {
    const id = (await doorApi.slots.create({ kind: 'claude', cwd: home, name })).slotId
    await waitUntil(() => doorApi.slots.get(id)?.status === 'running' && doorApi.slots.readScreen(id).data.includes('READY'), 30_000, `${name} running`)
    return id
  }
  /** The MCP exit: the door's registry runs the verb with the caller the tool would carry. */
  const call = async (caller: string, name: string, args: Record<string, unknown> = {}, o: { proven?: boolean } = {}): Promise<VerbResult> => {
    const entry = door.verbs.find('channels', name)
    assert.ok(entry, `verb ${name} registered`)
    return door.verbs.run(entry, { slotId: caller, state: doorApi.slots.get(caller)!, via: 'mcp', proven: o.proven ?? true }, args)
  }
  /** The CLI exit: the pipe's `verb` request (no slot key: the identity is not proven). */
  const cli = async (caller: string, name: string, args: Record<string, unknown> = {}): Promise<VerbResult> =>
    ((await rec.client.request({ t: 'verb', ns: 'channels', name, slotId: caller, args })) as unknown as { verb: VerbResult }).verb

  let A: string, B: string, C: string, D: string
  let obra: string

  test('the table: the verbs of H3a on both exits, English description, Portuguese help, and the paragraph of the instructions', async () => {
    A = await running('fora-dona')
    B = await running('fora-bravo')
    C = await running('fora-bravo')
    D = await running('fora-delta')
    const names = ['list', 'create', 'members', 'read', 'close', 'reopen', 'join', 'leave', 'remove', 'mute', 'unmute', 'say', 'react', 'poll', 'vote', 'poll-close']
    assert.deepEqual(CHANNEL_VERBS.map((v) => v.name), names)
    for (const exit of ['mcp', 'cli'] as const) {
      assert.deepEqual(door.verbs.list(exit).filter((v) => v.verb.ns === 'channels').map((v) => v.verb.name), names, exit)
    }
    for (const { verb } of door.verbs.list('mcp').filter((v) => v.verb.ns === 'channels')) assert.ok(verb.description.length > 20 && verb.help.length > 5, verb.name)
    const para = door.verbs.instructionParagraphs().find((p) => p.ext === EXT_ID)
    assert.ok(para, 'the [channels] paragraph')
    assert.equal(para.texts.join('\n'), INSTRUCTIONS)
    assert.ok(INSTRUCTIONS.includes('channels_say') && INSTRUCTIONS.includes('channels_list') && INSTRUCTIONS.includes('channels_read'))
  })

  test('create: the owner joins; members by id, unique name, unknown and ambiguous (failed, channel born anyway); bad-name, name-taken', async () => {
    const r = await call(A, 'create', { name: 'obra', title: 'A obra', members: [B, 'fora-delta', 'ninguem', 'fora-bravo'] })
    assert.equal(r.isError, undefined, r.text)
    obra = data(r).channel.id
    assert.equal(data(r).channel.name, 'obra')
    assert.deepEqual(data(r).joined.map((j: { id: string }) => j.id).sort(), [B, D].sort())
    assert.deepEqual(data(r).failed.map((f: { agent: string; error: string }) => [f.agent, f.error]), [['ninguem', 'unknown-agent'], ['fora-bravo', 'ambiguous']])
    assert.deepEqual(Object.keys(ch.store.get(obra)!.members).sort(), [A, B, D].sort())

    assert.equal(codeOf(await call(A, 'create', { name: 'Nome Ruim' })), 'bad-name')
    assert.equal(codeOf(await call(A, 'create', { name: 'obra' })), 'name-taken')
    assert.equal(codeOf(await call(A, 'create', {})), 'bad-request')
    const solo = await call(B, 'create', { name: 'solo' })
    assert.equal(data(solo).failed, undefined)
    assert.deepEqual(data(solo).joined, [])
  })

  test('list: my channels with owner, role, members, last and since; `all` adds the open ones I am not in', async () => {
    assert.ok((await ch.say(A, obra, { body: 'começou' })).ok)
    assert.match((await call(A, 'list')).text, /#obra \(\S+\) owner como «fora-dona»/)
    const mine = data(await call(A, 'list'))
    assert.deepEqual(mine.me, { id: A, name: 'fora-dona' })
    const row = mine.channels.find((c: { name: string }) => c.name === 'obra')
    assert.equal(row.id, obra)
    assert.equal(row.role, 'owner')
    assert.deepEqual(row.owner, { kind: 'agent', id: A, name: 'fora-dona' })
    assert.equal(row.muted, false)
    assert.equal(row.as, 'fora-dona', 'the name I have in the room')
    assert.equal(row.members, 3)
    assert.equal(row.last.from, 'fora-dona')
    assert.equal(typeof row.last.seq, 'number')
    assert.equal(typeof row.since, 'string')
    assert.equal(row.closed, undefined)
    assert.equal(data(await call(B, 'list')).channels.find((c: { name: string }) => c.name === 'obra').role, 'member')

    assert.deepEqual(data(await call(C, 'list')).channels, [], 'not in any: an empty list')
    const all = data(await call(C, 'list', { all: true })).channels
    const seen = all.find((c: { name: string }) => c.name === 'obra')
    assert.equal(seen.role, undefined)
    assert.equal(seen.since, undefined)
  })

  test('members: owner, members with kind, muted, since, by, alive and path (away for the one that does not run); by id or by name', async () => {
    await doorApi.slots.stop(D)
    await waitUntil(() => doorApi.slots.get(D)?.status !== 'running', 20_000, 'D stopped')
    assert.ok((await ch.mute(A, obra, B)).ok)
    const r = await call(C, 'members', { canal: 'obra' })
    assert.equal(r.isError, undefined, r.text)
    assert.deepEqual(data(r).channel, { id: obra, name: 'obra' })
    assert.deepEqual(data(r).owner, { kind: 'agent', id: A, name: 'fora-dona' })
    const by = Object.fromEntries(data(r).members.map((m: { id: string }) => [m.id, m]))
    assert.equal(by[A].path, doorApi.delivery.pathOf(A))
    assert.equal(by[A].alive, true)
    assert.equal(by[A].kind, 'claude')
    assert.equal(by[B].muted, true)
    assert.equal(by[B].by, A)
    assert.equal(by[D].alive, false)
    assert.equal(by[D].path, 'away')
    assert.equal(typeof by[A].since, 'string')
    assert.deepEqual(data(await call(C, 'members', { canal: obra })).members.length, 3, 'by id too')
    await ch.unmute(A, obra, B)
  })

  test('read: the latest lines, since a seq, limit, more and end; open to a stranger; unknown-channel', async () => {
    for (let n = 1; n <= 4; n++) assert.ok((await ch.say(A, obra, { body: `fala ${n}`, to: ['fora-delta'] })).ok)
    const last = await ch.store.lastSeq(obra)
    const latest = await call(C, 'read', { canal: 'obra', limit: 2 })
    assert.equal(latest.isError, undefined, latest.text)
    assert.deepEqual(data(latest).lines.map((l: { body: string }) => l.body), ['fala 3', 'fala 4'])
    assert.equal(data(latest).end, last)
    assert.equal(data(latest).more, true, 'older lines exist')
    const next = data(await call(C, 'read', { canal: obra, since: last - 3, limit: 2 }))
    assert.equal(next.lines.length, 2)
    assert.equal(next.end, last - 1)
    assert.equal(next.more, true, 'newer lines exist')
    const rest = data(await call(C, 'read', { canal: obra, since: next.end }))
    assert.equal(rest.lines.length, 1)
    assert.equal(rest.more, false)
    const none = data(await call(C, 'read', { canal: obra, since: last }))
    assert.deepEqual([none.lines, none.end, none.more], [[], last, false])
    assert.equal(data(await call(C, 'read', { canal: obra })).more, false, 'the whole channel fits in 50')
    assert.equal(codeOf(await call(C, 'read', { canal: 'nada' })), 'unknown-channel')
    assert.equal(codeOf(await call(C, 'read', { canal: obra, since: -1 })), 'bad-request')
  })

  test('close: the owner closes; not-owner, closed, unknown-channel; the history stays readable; the name is free again', async () => {
    const id = data(await call(A, 'create', { name: 'tarefa', members: [B] })).channel.id
    assert.equal(codeOf(await call(B, 'close', { canal: id })), 'not-owner')
    assert.equal(codeOf(await call(C, 'close', { canal: 'tarefa' })), 'not-owner')
    assert.equal(codeOf(await call(A, 'close', { canal: 'nenhum' })), 'unknown-channel')
    const r = await call(A, 'close', { canal: 'tarefa' })
    assert.equal(r.isError, undefined, r.text)
    assert.deepEqual(data(r).channel, { id, name: 'tarefa' })
    assert.equal(typeof data(r).closed.at, 'string')
    assert.equal(codeOf(await call(A, 'close', { canal: id })), 'closed')
    assert.equal(codeOf(await call(A, 'close', { canal: 'tarefa' })), 'unknown-channel', 'a closed channel is found by id, not by name')
    assert.ok(data(await call(C, 'read', { canal: id })).lines.length > 0, 'closed and still readable')
    assert.equal(data(await call(A, 'list')).channels.some((c: { id: string }) => c.id === id), false)
    const withClosed = data(await call(A, 'list', { closed: true })).channels.find((c: { id: string }) => c.id === id)
    assert.equal(typeof withClosed.closed, 'string')
    assert.equal(data(await call(A, 'create', { name: 'tarefa' })).channel.name, 'tarefa', 'the name was freed')
  })

  test('ambiguous: two closed channels with one name, found with `closed`, answer with the list; the id always works', async () => {
    const ids: string[] = []
    for (let n = 0; n < 2; n++) {
      const id = data(await call(A, 'create', { name: 'repete' })).channel.id
      assert.equal((await call(A, 'close', { canal: id })).isError, undefined)
      ids.push(id)
    }
    assert.equal(codeOf(await call(C, 'members', { canal: 'repete' })), 'unknown-channel', 'closed ones only with the flag')
    const amb = await call(C, 'members', { canal: 'repete', closed: true })
    assert.equal(codeOf(amb), 'ambiguous')
    assert.deepEqual(data(amb).options.map((o: { id: string }) => o.id).sort(), [...ids].sort())
    assert.equal(codeOf(await call(C, 'read', { canal: 'repete', closed: true })), 'ambiguous')
    assert.equal(data(await call(C, 'members', { canal: ids[0] })).channel.id, ids[0])
    const one = data(await call(C, 'members', { canal: 'tarefa', closed: true }))
    assert.equal(one.channel.name, 'tarefa', 'one closed and one open with the name: the open one')
  })

  test('reopen: the owner reopens by id or by name; not-owner, not-closed, unknown-channel, name-taken, desk', async () => {
    const id = data(await call(A, 'create', { name: 'volta', members: [B] })).channel.id
    assert.equal(codeOf(await call(A, 'reopen', { canal: id })), 'not-closed')
    assert.equal((await call(A, 'close', { canal: id })).isError, undefined)
    assert.equal(codeOf(await call(B, 'reopen', { canal: id })), 'not-owner')
    assert.equal(codeOf(await call(C, 'reopen', { canal: id })), 'not-owner')
    assert.equal(codeOf(await call(A, 'reopen', { canal: 'inexistente' })), 'unknown-channel')
    const r = await call(A, 'reopen', { canal: 'volta' })
    assert.equal(r.isError, undefined, r.text)
    assert.deepEqual(data(r).channel, { id, name: 'volta' })
    assert.equal(ch.store.get(id)!.closed, undefined)
    assert.equal((await call(B, 'members', { canal: 'volta' })).isError, undefined, 'open again, found by name')

    // The name taken while it was closed: the store refuses.
    assert.equal((await call(A, 'close', { canal: id })).isError, undefined)
    assert.equal((await call(A, 'create', { name: 'volta' })).isError, undefined)
    assert.equal(codeOf(await call(A, 'reopen', { canal: id })), 'name-taken')

    // A desk channel only follows its desk (C17).
    const made = await ch.store.create({ name: 'mesa-x', owner: { kind: 'agent', id: A, name: 'fora-dona' }, createdBy: A, desk: 'dx' })
    assert.ok(made.ok)
    await ch.store.join(made.channel.id, A, 'fora-dona', 'desk')
    assert.equal(codeOf(await call(A, 'close', { canal: made.channel.id })), 'desk')
    assert.equal(codeOf(await call(A, 'reopen', { canal: made.channel.id })), 'desk')
    assert.equal(data(await call(A, 'list')).channels.find((c: { id: string }) => c.id === made.channel.id).desk, 'dx')
  })

  test('proven: false runs and leaves marked; the CLI exit gives the same as the MCP exit', async () => {
    const mcp = await call(A, 'list')
    const unproven = await call(A, 'list', {}, { proven: false })
    assert.equal(unproven.isError, undefined)
    assert.equal(data(unproven).proven, false)
    assert.match(unproven.text, /sem prova de identidade/)
    assert.equal(data(mcp).proven, undefined)
    assert.deepEqual(clean(unproven), clean(mcp))
    const viaPipe = await cli(A, 'list')
    assert.equal(data(viaPipe).proven, false, 'no slot key on the pipe')
    assert.deepEqual(clean(viaPipe), clean(mcp))

    const err = await cli(C, 'close', { canal: obra })
    assert.equal(err.isError, true)
    assert.equal(codeOf(err), 'not-owner')
    assert.equal(codeOf(await call(C, 'close', { canal: obra })), 'not-owner', 'the same code on the other exit')
    assert.deepEqual(clean(await cli(C, 'read', { canal: obra, limit: 2 })), clean(await call(C, 'read', { canal: obra, limit: 2 })))
    assert.deepEqual(clean(await cli(C, 'members', { canal: obra })), clean(await call(C, 'members', { canal: obra })))
    assert.equal(codeOf(await cli(A, 'create', { name: 'Ruim Nome' })), 'bad-name')
  })

  test('the user is never a pane: a caller that is not an agent slot cannot create', async () => {
    const shell = (await doorApi.slots.create({ kind: 'shell', cwd: home, name: 'concha' })).slotId
    try {
      assert.equal(codeOf(await call(shell, 'create', { name: 'da-concha' })), 'unknown-agent')
      assert.equal(ch.store.findOpen('da-concha'), undefined)
    } finally { await doorApi.slots.forget(shell) }
  })

  describe('channels verbs (H3b: join, leave, remove, mute, unmute, say)', () => {
    let E: string, F: string, G: string

    test('join: myself in an open channel; already; the owner joins another; not-owner, unknown-agent, ambiguous, closed, unknown-channel', async () => {
      E = await running('h-dona')
      F = await running('h-fala')
      G = await running('h-terceiro')
      const id = data(await call(E, 'create', { name: 'junta' })).channel.id
      const self = await call(F, 'join', { canal: 'junta' })
      assert.equal(self.isError, undefined, self.text)
      assert.deepEqual(data(self).channel, { id, name: 'junta' })
      assert.deepEqual(data(self).member, { id: F, name: 'h-fala' })
      assert.equal(data(self).already, false)
      assert.equal(ch.store.get(id)!.members[F]!.by, 'self')
      assert.equal(data(await call(F, 'join', { canal: id })).already, true)

      assert.equal(codeOf(await call(F, 'join', { canal: id, agent: G })), 'not-owner', 'a member that is not the owner cannot join another')
      assert.equal(codeOf(await call(G, 'join', { canal: id, agent: 'h-fala' })), 'not-owner')
      const other = await call(E, 'join', { canal: 'junta', agent: 'h-terceiro' })
      assert.equal(other.isError, undefined, other.text)
      assert.deepEqual(data(other).member, { id: G, name: 'h-terceiro' })
      assert.equal(ch.store.get(id)!.members[G]!.by, E)
      assert.equal(codeOf(await call(E, 'join', { canal: id, agent: 'ninguem' })), 'unknown-agent')
      const amb = await call(E, 'join', { canal: id, agent: 'fora-bravo' })
      assert.equal(codeOf(amb), 'ambiguous')
      assert.deepEqual(data(amb).options.map((o: { id: string }) => o.id).sort(), [B, C].sort())
      assert.equal(codeOf(await call(F, 'join', { canal: 'nada' })), 'unknown-channel')
      assert.equal(codeOf(await call(F, 'join', {})), 'bad-request')

      assert.equal((await call(E, 'close', { canal: id })).isError, undefined)
      assert.equal(codeOf(await call(C, 'join', { canal: id })), 'closed')
      assert.equal(codeOf(await call(E, 'join', { canal: id, agent: C })), 'closed')
    })

    test('leave: I leave; not-member; unknown-channel; the owner leaving passes the channel to the person (C16)', async () => {
      const id = data(await call(E, 'create', { name: 'sai', members: [F, G] })).channel.id
      const r = await call(F, 'leave', { canal: 'sai' })
      assert.equal(r.isError, undefined, r.text)
      assert.deepEqual(data(r), { channel: { id, name: 'sai' }, left: true })
      assert.equal(ch.store.get(id)!.members[F], undefined)
      assert.equal(codeOf(await call(F, 'leave', { canal: id })), 'not-member')
      assert.equal(codeOf(await call(C, 'leave', { canal: id })), 'not-member', 'a stranger')
      assert.equal(codeOf(await call(F, 'leave', { canal: 'nada' })), 'unknown-channel')
      assert.equal((await call(E, 'leave', { canal: id })).isError, undefined)
      assert.equal(data(await call(G, 'members', { canal: id })).owner.kind, 'user')
      assert.equal(codeOf(await call(E, 'join', { canal: id, agent: F })), 'not-owner', 'the one that left no longer owns')
    })

    test('remove: the owner takes one out; the removed one cannot come back alone (removed, C18) and the owner joins it again', async () => {
      const id = data(await call(E, 'create', { name: 'tira', members: [F, G] })).channel.id
      assert.equal(codeOf(await call(F, 'remove', { canal: id, agent: G })), 'not-owner')
      assert.equal(codeOf(await call(C, 'remove', { canal: id, agent: G })), 'not-owner')
      assert.equal(codeOf(await call(E, 'remove', { canal: id, agent: 'ninguem' })), 'unknown-agent')
      assert.equal(codeOf(await call(E, 'remove', { canal: id, agent: D })), 'not-member')
      assert.equal(codeOf(await call(E, 'remove', { canal: 'nada', agent: G })), 'unknown-channel')
      assert.equal(codeOf(await call(E, 'remove', { canal: id })), 'bad-request')
      const r = await call(E, 'remove', { canal: 'tira', agent: 'h-terceiro' })
      assert.equal(r.isError, undefined, r.text)
      assert.deepEqual(data(r), { channel: { id, name: 'tira' }, removed: { id: G, name: 'h-terceiro' } })
      assert.equal(ch.store.get(id)!.members[G], undefined)
      assert.equal(codeOf(await call(G, 'join', { canal: id })), 'removed')
      assert.equal(codeOf(await call(E, 'remove', { canal: id, agent: G })), 'not-member')
      assert.equal((await call(E, 'join', { canal: id, agent: G })).isError, undefined, 'the owner joins it again')
      assert.equal(ch.store.get(id)!.members[G] !== undefined, true)
    })

    test('mute and unmute: the owner silences and gives the voice back; already; the same errors as remove', async () => {
      const id = data(await call(E, 'create', { name: 'cala', members: [F, G] })).channel.id
      assert.equal(codeOf(await call(F, 'mute', { canal: id, agent: G })), 'not-owner')
      assert.equal(codeOf(await call(F, 'unmute', { canal: id, agent: G })), 'not-owner')
      for (const verb of ['mute', 'unmute']) {
        assert.equal(codeOf(await call(E, verb, { canal: id, agent: 'ninguem' })), 'unknown-agent', verb)
        assert.equal(codeOf(await call(E, verb, { canal: id, agent: D })), 'not-member', verb)
        assert.equal(codeOf(await call(E, verb, { canal: 'nada', agent: G })), 'unknown-channel', verb)
      }
      const m = await call(E, 'mute', { canal: 'cala', agent: 'h-terceiro' })
      assert.equal(m.isError, undefined, m.text)
      assert.deepEqual(data(m), { channel: { id, name: 'cala' }, muted: { id: G, name: 'h-terceiro' }, already: false })
      assert.equal(data(await call(E, 'mute', { canal: id, agent: G })).already, true)
      assert.equal(codeOf(await call(G, 'say', { canal: id, text: 'oi' })), 'muted')
      const u = await call(E, 'unmute', { canal: id, agent: G })
      assert.deepEqual(data(u), { channel: { id, name: 'cala' }, unmuted: { id: G, name: 'h-terceiro' }, already: false })
      assert.equal(data(await call(E, 'unmute', { canal: id, agent: G })).already, true)
      assert.equal((await call(G, 'say', { canal: id, text: 'voltei' })).isError, undefined)
    })

    test('say: ref, seq and delivered; to by id, name and `usuário`; reply; muted, closed, not-member, unknown-member, bad-request', async () => {
      const id = data(await call(E, 'create', { name: 'fala', members: [F, G] })).channel.id
      const r = await call(E, 'say', { canal: 'fala', text: 'olá a todos' })
      assert.equal(r.isError, undefined, r.text)
      assert.equal(data(r).ref, `fala#${data(r).seq}`)
      assert.equal(typeof data(r).seq, 'number')
      assert.deepEqual(data(r).delivered.map((d: { id: string }) => d.id).sort(), [F, G].sort())
      for (const d of data(r).delivered) assert.ok(['inside', 'typed', 'queued', 'away'].includes(d.state), d.state)
      assert.deepEqual(data(r).delivered.map((d: { id: string; name: string }) => [d.id, d.name]).sort(), [[F, 'h-fala'], [G, 'h-terceiro']].sort())
      const first = (await ch.store.history(id, undefined, 10)).find((l) => l.body === 'olá a todos')
      assert.equal(first?.seq, data(r).seq)
      assert.equal(first?.from.role, 'owner', 'the owner speaks as a member in the envelope, the line keeps owner')

      const to = await call(F, 'say', { canal: id, text: 'para você', to: [G, 'usuário'], reply: data(r).seq })
      assert.equal(to.isError, undefined, to.text)
      const line = (await ch.store.history(id, undefined, 10)).find((l) => l.seq === data(to).seq)!
      assert.deepEqual(line.to, ['h-terceiro', 'usuário'])
      assert.equal(line.replyTo, data(r).seq)
      const byName = await call(F, 'say', { canal: id, text: 'por nome', to: 'h-dona' })
      assert.deepEqual((await ch.store.history(id, undefined, 10)).find((l) => l.seq === data(byName).seq)!.to, ['h-dona'])

      assert.equal(codeOf(await call(F, 'say', { canal: id, text: 'x', to: ['ninguem'] })), 'unknown-member')
      assert.equal(codeOf(await call(F, 'say', { canal: id, text: 'x', to: [D] })), 'unknown-member', 'a live agent that is not a member')
      assert.equal(codeOf(await call(C, 'say', { canal: id, text: 'x' })), 'not-member')
      assert.equal(codeOf(await call(C, 'say', { canal: id, text: 'x', to: ['ninguem'] })), 'not-member', 'who may speak is checked first')
      assert.equal(codeOf(await call(F, 'say', { canal: 'nada', text: 'x' })), 'unknown-channel')
      assert.equal(codeOf(await call(F, 'say', { canal: id })), 'bad-request')
      assert.equal(codeOf(await call(F, 'say', { canal: id, text: 'x', reply: -2 })), 'bad-request')

      assert.equal((await call(E, 'mute', { canal: id, agent: F })).isError, undefined)
      assert.equal(codeOf(await call(F, 'say', { canal: id, text: 'calado' })), 'muted')
      assert.equal((await call(E, 'close', { canal: id })).isError, undefined)
      assert.equal(codeOf(await call(E, 'say', { canal: id, text: 'tarde' })), 'closed')
      assert.equal(codeOf(await call(F, 'say', { canal: id, text: 'tarde', to: ['ninguem'] })), 'closed')
    })

    test('say: `to` by one segment of a name (only when one member has it); ambiguous with the options; unknown lists the valid names; whole name and id still work', async () => {
      const P = await running('claude · bancada')
      const Q = await running('codex · bancada')
      const R = await running('claude · obra')
      const id = data(await call(E, 'create', { name: 'segmentos', members: [F, P, Q, R] })).channel.id
      const lineOf = async (r: VerbResult) => (await ch.store.history(id, undefined, 20)).find((l) => l.seq === data(r).seq)!
      const one = await call(F, 'say', { canal: id, text: 'a', to: ['obra'] })
      assert.equal(one.isError, undefined, one.text)
      assert.deepEqual((await lineOf(one)).to, ['claude · obra'], 'the line keeps the whole name')
      const accent = await call(F, 'say', { canal: id, text: 'b', to: ['OBRÁ'] })
      assert.deepEqual((await lineOf(accent)).to, ['claude · obra'], 'case and accents do not matter')
      for (const seg of ['bancada', 'claude']) {
        const amb = await call(F, 'say', { canal: id, text: 'c', to: [seg] })
        assert.equal(codeOf(amb), 'ambiguous', seg)
        assert.ok(data(amb).options.length >= 2, seg)
      }
      assert.deepEqual(data(await call(F, 'say', { canal: id, text: 'c', to: ['bancada'] })).options.map((o: { name: string }) => o.name).sort(), ['claude · bancada', 'codex · bancada'])
      const none = await call(F, 'say', { canal: id, text: 'd', to: ['nenhum'] })
      assert.equal(codeOf(none), 'unknown-member')
      assert.ok(['h-dona', 'h-fala', 'claude · bancada', 'codex · bancada', 'claude · obra'].every((n) => data(none).members.includes(n)), 'the valid names')
      const whole = await call(F, 'say', { canal: id, text: 'e', to: ['claude · bancada', R] })
      assert.deepEqual((await lineOf(whole)).to, ['claude · bancada', 'claude · obra'], 'whole name and id')
    })

    test('the text of the turn does not reach the channel: said in the paragraph and in the join notice of both paths', () => {
      assert.ok(INSTRUCTIONS.includes('does NOT go to the channel and nobody there sees it'))
      assert.ok(INSTRUCTIONS.includes('call `channels_say` with the `room`'))
      for (const v of ['say', 'list', 'read']) assert.ok(INSTRUCTIONS.includes(`\`mcp__tether__channels_${v}\``), v)
      assert.ok(INSTRUCTIONS.includes('These tools may be deferred: if one is not loaded, load it with your tool search before concluding it does not exist.'))
      const inside = joinedNotice('obra', undefined, ['a'], 'inside')
      assert.ok(inside.includes('para responder no canal chame a ferramenta mcp__tether__channels_say (se ela não estiver carregada, carregue-a antes pela busca de ferramentas); o texto do seu turno não vai ao canal'))
      for (const path of ['terminal', 'wait'] as const) {
        const text = joinedNotice('obra', undefined, ['a'], path)
        assert.ok(text.includes('channels say obra') && text.includes('o texto do seu turno não vai ao canal'), path)
        assert.ok(!text.includes('ferramenta mcp__tether__channels_say'), path)
      }
    })

    test('multichannel: one agent in two channels gets each line with the right room, and muting in one does not mute in the other', async () => {
      const a = data(await call(E, 'create', { name: 'sala-um', members: [F] })).channel.id
      const b = data(await call(G, 'create', { name: 'sala-dois', members: [F] })).channel.id
      assert.equal((await call(E, 'say', { canal: a, text: 'um-chegou' })).isError, undefined)
      assert.equal((await call(G, 'say', { canal: b, text: 'dois-chegou' })).isError, undefined)
      const toF = (word: string) => sent.filter((s) => s.slotId === F && s.body.split('\n')[0] === word)
      assert.deepEqual(toF('um-chegou').map((s) => s.room), ['sala-um'])
      assert.deepEqual(toF('dois-chegou').map((s) => s.room), ['sala-dois'])

      assert.equal((await call(E, 'mute', { canal: a, agent: F })).isError, undefined)
      assert.equal(codeOf(await call(F, 'say', { canal: a, text: 'calado aqui' })), 'muted')
      assert.equal((await call(F, 'say', { canal: b, text: 'falo aqui' })).isError, undefined, 'still free in the other channel')
      assert.equal(data(await call(F, 'members', { canal: b })).members.find((m: { id: string }) => m.id === F).muted, false)
      assert.equal(data(await call(F, 'list')).channels.find((c: { id: string }) => c.id === a).muted, true)
      assert.equal(data(await call(F, 'list')).channels.find((c: { id: string }) => c.id === b).muted, false)
    })

    test('proven: false runs and leaves marked; the CLI exit gives the same errors and results as the MCP exit', async () => {
      const id = data(await call(E, 'create', { name: 'duas-saidas', members: [F] })).channel.id
      const unproven = await call(F, 'say', { canal: id, text: 'sem prova' }, { proven: false })
      assert.equal(unproven.isError, undefined)
      assert.equal(data(unproven).proven, false)
      assert.match(unproven.text, /sem prova de identidade/)
      assert.equal(data(await call(F, 'say', { canal: id, text: 'com prova' })).proven, undefined)

      const viaPipe = await cli(F, 'say', { canal: id, text: 'pelo pipe', to: ['h-dona'] })
      assert.equal(viaPipe.isError, undefined, viaPipe.text)
      assert.equal(data(viaPipe).proven, false)
      assert.deepEqual(Object.keys(clean(viaPipe) as object).sort(), Object.keys(clean(await call(F, 'say', { canal: id, text: 'pelo mcp', to: ['h-dona'] })) as object).sort())

      assert.equal(codeOf(await cli(F, 'say', { canal: id, text: 'x', to: ['ninguem'] })), 'unknown-member')
      assert.equal(codeOf(await call(F, 'say', { canal: id, text: 'x', to: ['ninguem'] })), 'unknown-member')
      assert.equal(codeOf(await cli(F, 'remove', { canal: id, agent: E })), 'not-owner')
      assert.equal(codeOf(await cli(F, 'mute', { canal: id, agent: E })), 'not-owner')
      assert.equal(codeOf(await cli(F, 'join', { canal: id, agent: G })), 'not-owner')
      const muted = await cli(E, 'mute', { canal: id, agent: F })
      assert.equal(data(muted).already, false)
      assert.deepEqual(clean(await cli(E, 'mute', { canal: id, agent: F })), { ...(clean(await call(E, 'mute', { canal: id, agent: F })) as object) })
      assert.deepEqual(clean(await cli(E, 'unmute', { canal: id, agent: F })), { channel: { id, name: 'duas-saidas' }, unmuted: { id: F, name: 'h-fala' }, already: false, proven: undefined })
      assert.deepEqual(clean(await cli(F, 'leave', { canal: id })), { channel: { id, name: 'duas-saidas' }, left: true, proven: undefined })
      assert.equal(codeOf(await cli(F, 'leave', { canal: id })), 'not-member')
      assert.equal(data(await cli(F, 'join', { canal: id })).already, false)
    })
  })
})
