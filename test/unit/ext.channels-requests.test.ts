// The moderator's requests (extensions/channels/daemon/requests.ts, slice H4) over the pipe, in a real tetherd on a test home
// and test pipe: a `DaemonClient` that said hello as `app` asks, one that said hello as `cli` is refused the gestures. The
// agents are the fake `claude` slots of the fan-out test (test/fixtures/channels/agent.cjs). No real agent; the user's home,
// pipe and tetherd are never touched.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, test } from 'node:test'
import { DisposableStore } from '../../app/shared/vscode-lifecycle.ts'
import '../../src/agents/load.ts'
import { agentRegistry, type AgentContribution } from '../../src/agents/registry.ts'
import type { AgentAdapter, LaunchPlan } from '../../src/agents/types.ts'
import { DaemonClient, DaemonError } from '../../src/daemon/client.ts'
import { DoorHost } from '../../src/daemon/door/host.ts'
import type { DoorApi } from '../../src/daemon/door/types.ts'
import { fsIo } from '../../src/daemon/ext-io.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { createChannels, type Channels, type ChannelsApi } from '../../extensions/channels/daemon/fanout.ts'
import { registerChannelRequests } from '../../extensions/channels/daemon/requests.ts'
import { openStore, PAGE } from '../../extensions/channels/daemon/store.ts'
import { removeHome, sleep, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

const AGENT = fileURLToPath(new URL('../fixtures/channels/agent.cjs', import.meta.url))
const SEEN_DELAY = 137

const readLines = <T>(file: string): T[] => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as T) : [])
interface Note { method?: string; params?: { content: string; meta: Record<string, string> } }
const rejectsWith = (code: string) => (e: unknown): boolean => e instanceof DaemonError && e.code === code

describe('channels moderator requests (H4)', () => {
  let home: string
  let daemon: Daemon
  let app: DaemonClient
  let cli: DaemonClient
  let door: DoorHost
  let doorApi: DoorApi
  let ch: Channels
  const own = new DisposableStore()
  const logs: string[] = []
  const events: Array<{ ext: string; name: string; payload: any }> = []

  const chanLog = (slotId: string): string => join(home, `chan-${slotId}.log`)
  const notes = (slotId: string): Note[] => readLines<Note>(chanLog(slotId)).filter((l) => l.method === 'notifications/claude/channel')

  const fake: AgentAdapter = {
    name: 'claude',
    plan: (input): LaunchPlan => {
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
      delete env.NODE_TEST_CONTEXT
      env.ECHO_LOG = join(home, `echo-${input.slot.slotId}.log`)
      env.CHAN_LOG = chanLog(input.slot.slotId)
      env.OPEN_STREAM = '1'
      return { command: process.execPath, args: [AGENT], cwd: input.slot.cwd, env }
    },
    sessionExists: async () => 'unknown',
    title: async (b) => b.title,
  }
  const contribution = agentRegistry.get('claude')! as { channels?: AgentContribution['channels'] }
  const savedChannels = contribution.channels
  before(() => { contribution.channels = () => [] })
  after(() => { contribution.channels = savedChannels })

  const ask = <T = any>(client: DaemonClient, name: string, args?: unknown): Promise<T> =>
    client.request({ t: 'ext-request', ext: 'channels', name, ...(args !== undefined ? { args } : {}) }).then((r) => r.result as T)

  before(async () => {
    home = tempHome()
    door = new DoorHost({ log: (m) => logs.push(m) })
    daemon = await startDaemon({
      home, pipe: uniquePipe(home), memoryIntervalMs: 0, readyFallbackMs: 300, minAgentAgeMs: 0, adapters: { claude: fake }, channelOf: () => undefined, door,
      log: (m) => logs.push(m),
    })
    app = await DaemonClient.open(daemon.pipe, 'app')
    cli = await DaemonClient.open(daemon.pipe, 'cli')
    app.on('ext-event', (e) => events.push(e as any))
    doorApi = door.apiFor('channels', own)
    own.add(doorApi.delivery.enable())
    const api: ChannelsApi = { slots: doorApi.slots, attention: doorApi.attention, delivery: doorApi.delivery, events: doorApi.events, settings: { get: () => undefined }, log: (m) => logs.push(m) }
    ch = createChannels(api, await openStore(fsIo, home))
    for (const d of registerChannelRequests(doorApi, Promise.resolve(ch), SEEN_DELAY)) own.add(d)
  })
  after(async () => {
    ch?.dispose()
    await door.delivery.flush().catch(() => {})
    own.dispose()
    door.delivery.dispose()
    app?.close()
    cli?.close()
    await daemon?.close()
    await door.mcp.close()
    await removeHome(home)
  })

  const running = async (name: string): Promise<string> => {
    const id = (await doorApi.slots.create({ kind: 'claude', cwd: home, name })).slotId
    await waitUntil(() => doorApi.slots.get(id)?.status === 'running' && doorApi.slots.readScreen(id).data.includes('READY'), 30_000, `${name} running`)
    await waitUntil(() => doorApi.delivery.pathOf(id) === 'inside', 30_000, `${name} opened its stream`)
    return id
  }

  let a: string
  let b: string
  let id: string

  test('create is the person\'s (owner user), join needs agent, say reaches the members as moderator, with the marked names', async () => {
    a = await running('dentro-a')
    b = await running('dentro-b')
    const made = await ask(app, 'create', { name: 'obra', title: 'Obra' })
    id = made.channel.id
    assert.deepEqual(made.channel.owner, { kind: 'user' })
    await assert.rejects(ask(app, 'create', { name: 'obra' }), rejectsWith('name-taken'))
    await assert.rejects(ask(app, 'join', { channel: id }), rejectsWith('bad-request'))
    assert.equal((await ask(app, 'join', { channel: id, agent: a })).already, false)
    assert.equal((await ask(app, 'join', { channel: id, agent: a })).already, true)
    await ask(app, 'join', { channel: id, agent: b })
    await assert.rejects(ask(app, 'join', { channel: id, agent: 'nobody' }), rejectsWith('unknown-agent'))
    await assert.rejects(ask(app, 'join', { channel: 'ghost', agent: a }), rejectsWith('unknown-channel'))

    const said = await ask(app, 'say', { channel: id, text: 'bom dia', to: ['dentro-b'] })
    assert.equal(said.line.from.role, 'moderator')
    assert.deepEqual(Object.keys(said.receipts).sort(), [a, b].sort())
    for (const m of [a, b]) {
      await waitUntil(() => notes(m).some((n) => n.params!.content === 'bom dia'), 10_000, `the line at ${m}`)
      const n = notes(m).find((x) => x.params!.content === 'bom dia')!
      assert.equal(n.params!.meta.role, 'moderator')
      assert.equal(n.params!.meta.from_id, 'user')
      assert.equal(n.params!.meta.to, 'dentro-b')
    }
    await assert.rejects(ask(app, 'say', { channel: id, text: '' }), rejectsWith('bad-request'))
  })

  test('list, members and history (paged by before and limit, capped at PAGE)', async () => {
    const listed = await ask(app, 'list')
    assert.deepEqual(listed.channels.map((c: any) => c.name), ['obra'])
    assert.equal(listed.channels[0].members, 2)
    const members = await ask(app, 'members', { channel: id })
    assert.deepEqual(members.members.map((m: any) => m.id).sort(), [a, b].sort())
    assert.ok(members.members.every((m: any) => m.alive && m.path === 'inside' && m.muted === false))

    for (let i = 0; i < 5; i++) await ask(app, 'say', { channel: id, text: `linha ${i}` })
    const all = await ask(app, 'history', { channel: id })
    const last = all.lines.at(-1).seq
    assert.equal(all.last, last)
    assert.equal(all.more, false)
    assert.deepEqual(all.members.map((m: any) => m.id).sort(), [a, b].sort(), 'the page says who is in the channel now')
    assert.ok(all.members.every((m: any) => typeof m.name === 'string' && m.name !== '' && Object.keys(m).every((k) => ['id', 'name', 'muted'].includes(k))))
    assert.equal(typeof all.moderator.name, 'string')
    assert.ok(all.moderator.name !== '', 'and the person\'s name')
    const marks = await ask(app, 'marks')
    assert.deepEqual(marks.channels.find((c: any) => c.channel === id).members.sort(), [a, b].sort())
    assert.equal(marks.moderator.name, all.moderator.name)
    const page = await ask(app, 'history', { channel: id, before: last, limit: 3 })
    assert.deepEqual(page.lines.map((l: any) => l.seq), [last - 3, last - 2, last - 1])
    assert.equal(page.more, true)
    const capped = await ask(app, 'history', { channel: id, limit: PAGE * 10 })
    assert.ok(capped.lines.length <= PAGE)
    await assert.rejects(ask(app, 'history', { channel: id, limit: 'x' }), rejectsWith('bad-request'))
    await assert.rejects(ask(app, 'members', { channel: 'ghost' }), rejectsWith('unknown-channel'))
  })

  test('mute, unmute, remove, close and reopen answer with the codes of the verbs; the channel and line events reach the client', async () => {
    assert.equal((await ask(app, 'mute', { channel: id, agent: b })).already, false)
    assert.equal((await ask(app, 'mute', { channel: id, agent: b })).already, true)
    assert.equal((await ask(app, 'unmute', { channel: id, agent: b })).already, false)
    await assert.rejects(ask(app, 'mute', { channel: id }), rejectsWith('bad-request'))
    await ask(app, 'remove', { channel: id, agent: b })
    await assert.rejects(ask(app, 'remove', { channel: id, agent: b }), rejectsWith('not-member'))
    await ask(app, 'close', { channel: id })
    await assert.rejects(ask(app, 'close', { channel: id }), rejectsWith('closed'))
    await assert.rejects(ask(app, 'say', { channel: id, text: 'oi' }), rejectsWith('closed'))
    assert.ok((await ask(app, 'history', { channel: id })).lines.length > 0, 'a closed channel stays readable')
    await assert.rejects(ask(app, 'reopen', { channel: 'ghost' }), rejectsWith('unknown-channel'))
    assert.ok((await ask(app, 'reopen', { channel: id })).channel.closed === undefined)
    await assert.rejects(ask(app, 'reopen', { channel: id }), rejectsWith('not-closed'))

    await waitUntil(() => events.some((e) => e.name === 'channel') && events.some((e) => e.name === 'line'), 5_000, 'events at the client')
    assert.ok(events.every((e) => e.ext === 'channels'))
    assert.ok(events.some((e) => e.name === 'line' && e.payload.room === 'obra' && e.payload.line.body === 'bom dia'))
    assert.ok(events.some((e) => e.name === 'channel' && e.payload.channel.id === id && e.payload.channel.closed === undefined))
  })

  test('seen writes with a delay and one timer for every channel', async () => {
    const other = (await ask(app, 'create', { name: 'segundo' })).channel.id
    const indexSeen = async (cid: string): Promise<number> => JSON.parse(await fsIo.readText(join(home, 'channels', 'index.json'))).channels[cid].seenByUser
    const real = globalThis.setTimeout
    let mine = 0
    globalThis.setTimeout = ((fn: any, ms?: number, ...rest: any[]) => { if (ms === SEEN_DELAY) mine++; return real(fn, ms, ...rest) }) as typeof setTimeout
    try {
      const r1 = await ask(app, 'seen', { channel: id, seq: 4 })
      const r2 = await ask(app, 'seen', { channel: other, seq: 1 })
      await ask(app, 'seen', { channel: id, seq: 6 })
      assert.equal(r1.seenByUser, 4)
      assert.equal(r2.seenByUser, 1)
      assert.equal(mine, 1, 'one timer')
    } finally { globalThis.setTimeout = real }
    assert.equal(await indexSeen(id), 0, 'not written yet')
    await sleep(SEEN_DELAY + 400)
    assert.equal(await indexSeen(id), 6)
    assert.equal(await indexSeen(other), 1)
  })

  test('a cli client reads, but every gesture and speech is not-moderator; so is the test client', async () => {
    assert.equal((await ask(cli, 'list')).channels.length, 2)
    assert.ok((await ask(cli, 'members', { channel: id })).members)
    assert.ok((await ask(cli, 'history', { channel: id })).lines)
    const probe = await DaemonClient.open(daemon.pipe, 'test')
    try {
      for (const [name, args] of [
        ['say', { channel: id, text: 'x' }], ['create', { name: 'x' }], ['join', { channel: id, agent: a }], ['remove', { channel: id, agent: a }],
        ['mute', { channel: id, agent: a }], ['unmute', { channel: id, agent: a }], ['close', { channel: id }], ['reopen', { channel: id }],
        ['seen', { channel: id, seq: 1 }],
      ] as const) {
        await assert.rejects(ask(cli, name, args), rejectsWith('not-moderator'), `cli ${name}`)
        await assert.rejects(ask(probe, name, args), rejectsWith('not-moderator'), `test ${name}`)
      }
    } finally { probe.close() }
    assert.equal(ch.store.get(id)!.closed, undefined)
    assert.equal(ch.store.findOpen('x'), undefined)
  })
})
