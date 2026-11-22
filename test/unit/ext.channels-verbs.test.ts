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
import type { DoorApi, VerbResult } from '../../src/daemon/door/types.ts'
import { fsIo } from '../../src/daemon/ext-io.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { createChannels, type Channels, type ChannelsApi } from '../../extensions/channels/daemon/fanout.ts'
import { openStore } from '../../extensions/channels/daemon/store.ts'
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
      slots: doorApi.slots, attention: doorApi.attention, delivery: doorApi.delivery, verbs: doorApi.verbs,
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
    const names = ['list', 'create', 'members', 'read', 'close', 'reopen']
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
    const mine = data(await call(A, 'list'))
    assert.deepEqual(mine.me, { id: A, name: 'fora-dona' })
    const row = mine.channels.find((c: { name: string }) => c.name === 'obra')
    assert.equal(row.id, obra)
    assert.equal(row.role, 'owner')
    assert.deepEqual(row.owner, { kind: 'agent', id: A, name: 'fora-dona' })
    assert.equal(row.muted, false)
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
})
