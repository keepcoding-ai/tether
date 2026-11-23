// The `path` that `channels members` shows (verb and moderator request) is the member's ROUTE (`delivery.routeOf`: stream open,
// held pane, else wait), not the instant (`pathOf`, which also reads the interlock). A held terminal member in the middle of a
// turn is `wait` for the delivery right now but still `terminal` for the channel. Real tetherd on a test home and pipe; fake
// `claude` slots (test/fixtures/channels/agent.cjs), no LLM; the user's home, pipe and tetherd are never touched.
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, test } from 'node:test'
import { DisposableStore } from '../../app/shared/vscode-lifecycle.ts'
import '../../src/agents/load.ts'
import { agentRegistry, type AgentContribution } from '../../src/agents/registry.ts'
import type { AgentAdapter, LaunchPlan } from '../../src/agents/types.ts'
import { slotAttentionPath } from '../../src/core/paths.ts'
import { DaemonClient } from '../../src/daemon/client.ts'
import { DoorHost } from '../../src/daemon/door/host.ts'
import type { DeliveryMessage, DoorApi, VerbResult } from '../../src/daemon/door/types.ts'
import { fsIo } from '../../src/daemon/ext-io.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { createChannels, type Channels, type ChannelsApi } from '../../extensions/channels/daemon/fanout.ts'
import { registerChannelRequests } from '../../extensions/channels/daemon/requests.ts'
import { openStore } from '../../extensions/channels/daemon/store.ts'
import { CHANNEL_VERBS, registerVerbs } from '../../extensions/channels/daemon/verbs.ts'
import { EXT_ID } from '../../extensions/channels/manifest.ts'
import { removeHome, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

const AGENT = fileURLToPath(new URL('../fixtures/channels/agent.cjs', import.meta.url))

describe('channels members: path is the route, not the instant', () => {
  let home: string
  let daemon: Daemon
  let app: DaemonClient
  let door: DoorHost
  let doorApi: DoorApi
  let ch: Channels
  const own = new DisposableStore()
  const logs: string[] = []
  const sent: { slotId: string; body: string }[] = []

  const fake: AgentAdapter = {
    name: 'claude',
    plan: (input): LaunchPlan => {
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
      delete env.NODE_TEST_CONTEXT
      env.ECHO_LOG = join(home, `echo-${input.slot.slotId}.log`)
      env.CHAN_LOG = join(home, `chan-${input.slot.slotId}.log`)
      env.OPEN_STREAM = input.slot.name === 'dentro' ? '1' : '0'
      return { command: process.execPath, args: [AGENT], cwd: input.slot.cwd, env }
    },
    sessionExists: async () => 'unknown',
    title: async (b) => b.title,
  }
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
    app = await DaemonClient.open(daemon.pipe, 'app')
    doorApi = door.apiFor(EXT_ID, own)
    own.add(doorApi.delivery.enable())
    const api: ChannelsApi & Pick<DoorApi, 'verbs'> = {
      slots: doorApi.slots, attention: doorApi.attention, verbs: doorApi.verbs, events: doorApi.events,
      delivery: Object.assign(Object.create(doorApi.delivery) as DoorApi['delivery'], {
        deliver: (slotId: string, msg: DeliveryMessage, opts?: { paths?: readonly ('inside' | 'terminal')[] }) => {
          sent.push({ slotId, body: msg.body })
          return doorApi.delivery.deliver(slotId, msg, opts)
        },
      }),
      settings: { get: () => undefined }, log: (m) => logs.push(m),
    }
    ch = createChannels(api, await openStore(fsIo, home))
    for (const d of registerVerbs(api, Promise.resolve(ch))) own.add(d)
    for (const d of registerChannelRequests(doorApi, Promise.resolve(ch))) own.add(d)
  })
  after(async () => {
    ch?.dispose()
    await door.delivery.flush().catch(() => {})
    own.dispose()
    door.delivery.dispose()
    app?.close()
    await daemon?.close()
    await door.mcp.close()
    await removeHome(home)
  })

  const running = async (name: string): Promise<string> => {
    const id = (await doorApi.slots.create({ kind: 'claude', cwd: home, name })).slotId
    await waitUntil(() => doorApi.slots.get(id)?.status === 'running' && doorApi.slots.readScreen(id).data.includes('READY'), 30_000, `${name} running`)
    return id
  }
  const ask = (name: string, args?: unknown): Promise<any> =>
    app.request({ t: 'ext-request', ext: 'channels', name, ...(args !== undefined ? { args } : {}) }).then((r) => r.result)
  const verbMembers = async (caller: string, canal: string): Promise<VerbResult> => {
    const entry = door.verbs.find('channels', 'members')
    assert.ok(entry && CHANNEL_VERBS.some((v) => v.name === 'members'))
    return door.verbs.run(entry, { slotId: caller, state: doorApi.slots.get(caller)!, via: 'mcp', proven: true }, { canal })
  }

  test('a held terminal member in a turn is `terminal` (pathOf says wait); with the person is `wait`; stream open is `inside`', async () => {
    const held = await running('terminal')
    const person = await running('com-a-pessoa')
    const inside = await running('dentro')
    await waitUntil(() => doorApi.delivery.pathOf(inside) === 'inside', 30_000, 'the fake agent opened its stream')
    await doorApi.slots.setHeld(held, { ext: 'probe', by: 'owner-slot' })

    // The turn opens: the interlock closes the terminal for the delivery, the route stays.
    writeFileSync(slotAttentionPath(home, held), JSON.stringify({ ts: new Date().toISOString(), kind: 'start' }) + '\n')
    await waitUntil(() => doorApi.slots.get(held)?.turn === 'busy', 10_000, 'the held pane is busy')
    assert.equal(doorApi.delivery.pathOf(held), 'wait', 'the instant: busy')

    const id = (await ask('create', { name: 'rota' })).channel.id
    for (const agent of [held, person, inside]) await ask('join', { channel: id, agent })

    const route = { [held]: 'terminal', [person]: 'wait', [inside]: 'inside' }
    const byRequest = Object.fromEntries((await ask('members', { channel: id })).members.map((m: { id: string; path: string }) => [m.id, m.path]))
    assert.deepEqual(byRequest, route, 'the moderator request')
    const byVerb = Object.fromEntries(((await verbMembers(inside, 'rota')).data as { members: { id: string; path: string }[] }).members.map((m: { id: string; path: string }) => [m.id, m.path]))
    assert.deepEqual(byVerb, route, 'the verb')

    // The join notice follows the route too: busy now, but the held pane hears by the terminal; only a `wait` route is told it does not.
    const noticeOf = (agent: string): string => sent.find((s) => s.slotId === agent && s.body.includes('você entrou em #rota'))?.body ?? ''
    assert.ok(noticeOf(held).includes('você entrou em #rota'), 'the held pane got a join notice')
    assert.equal(noticeOf(held).includes('não ouve'), false, 'held and busy: no "does not hear"')
    assert.ok(noticeOf(person).includes('não ouve'), 'with the person: told it does not hear')
  })
})
