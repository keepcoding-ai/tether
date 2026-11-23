// The join notice given to the DESK CHANNEL's joiners (fanout.ts `joinNotices`, used by desk.open/setOwner/enter) follows the
// member's ROUTE (`delivery.routeOf`), not the instant (`pathOf`, which also reads the interlock). A held pane in the middle of a
// turn is `wait` for the delivery right now but `terminal` for the channel, so its notice says "by the terminal", never "waiting";
// a pane with the MCP stream open is told "inside". Real tetherd on a test home and pipe; fake `claude` slots
// (test/fixtures/channels/agent.cjs), no LLM; the user's home, pipe and tetherd are never touched.
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
import { DoorHost } from '../../src/daemon/door/host.ts'
import type { DeliveryMessage, DoorApi } from '../../src/daemon/door/types.ts'
import { fsIo } from '../../src/daemon/ext-io.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { createChannels, type Channels, type ChannelsApi } from '../../extensions/channels/daemon/fanout.ts'
import { claudeToolName, DESK_JOINER, joinedNotice } from '../../extensions/channels/daemon/notices.ts'
import { openStore } from '../../extensions/channels/daemon/store.ts'
import { deskChannelId } from '../../extensions/channels/rules.ts'
import { removeHome, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

const AGENT = fileURLToPath(new URL('../fixtures/channels/agent.cjs', import.meta.url))

describe('desk channel joiners: the join notice follows the route, not the instant', () => {
  let home: string
  let daemon: Daemon
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
    doorApi = door.apiFor('channels', own)
    own.add(doorApi.delivery.enable())
    const api: ChannelsApi = {
      slots: doorApi.slots, attention: doorApi.attention,
      events: { emit: () => {} },
      delivery: Object.assign(Object.create(doorApi.delivery) as DoorApi['delivery'], {
        deliver: (slotId: string, msg: DeliveryMessage, opts?: { paths?: readonly ('inside' | 'terminal')[] }) => {
          sent.push({ slotId, body: msg.body })
          return doorApi.delivery.deliver(slotId, msg, opts)
        },
      }),
      settings: { get: () => undefined }, log: (m) => logs.push(m),
    }
    ch = createChannels(api, await openStore(fsIo, home))
  })
  after(async () => {
    ch?.dispose()
    await door.delivery.flush().catch(() => {})
    own.dispose()
    door.delivery.dispose()
    await daemon?.close()
    await door.mcp.close()
    await removeHome(home)
  })

  const running = async (name: string): Promise<string> => {
    const id = (await doorApi.slots.create({ kind: 'claude', cwd: home, name })).slotId
    await waitUntil(() => doorApi.slots.get(id)?.status === 'running' && doorApi.slots.readScreen(id).data.includes('READY'), 30_000, `${name} running`)
    return id
  }

  test('a held pane in a turn hears "by the terminal" (pathOf says wait); a stream open hears "inside"', async () => {
    const owner = await running('dono')
    const held = await running('terminal')
    const inside = await running('dentro')
    await waitUntil(() => doorApi.delivery.pathOf(inside) === 'inside', 30_000, 'the fake agent opened its stream')
    await doorApi.slots.setHeld(held, { ext: 'probe', by: 'owner-slot' })

    // The turn opens: the interlock closes the terminal for the delivery right now, the route stays.
    writeFileSync(slotAttentionPath(home, held), JSON.stringify({ ts: new Date().toISOString(), kind: 'start' }) + '\n')
    await waitUntil(() => doorApi.slots.get(held)?.turn === 'busy', 10_000, 'the held pane is busy')
    assert.equal(doorApi.delivery.pathOf(held), 'wait', 'the instant: busy')
    assert.equal(doorApi.delivery.routeOf(held), 'terminal', 'the route: the held pane')
    assert.equal(doorApi.delivery.routeOf(inside), 'inside', 'the route: the stream open')

    // The joiners enter with the desk channel opening (the `joinNotices` of desk.open).
    const opened = await ch.desk.open('mesa-1', { name: 'mesa', title: 'Mesa', owner, panes: [owner, held, inside] })
    assert.ok(opened.ok, 'the desk channel opened')
    assert.equal(deskChannelId('mesa-1'), opened.channel.id)

    const noticeOf = (agent: string): string => sent.find((s) => s.slotId === agent && s.body.includes('você entrou em #mesa'))?.body ?? ''
    const memberNames = (agent: string): string[] => Object.keys(opened.channel.members).filter((m) => m !== agent).map((m) => opened.channel.members[m]!.name ?? m)

    const heldNotice = noticeOf(held)
    assert.ok(heldNotice.includes(`(por ${DESK_JOINER})`), 'the held pane got the desk joiner notice')
    assert.ok(heldNotice.includes('channels say mesa'), 'held and busy: told it speaks by the terminal')
    assert.equal(heldNotice.includes('não ouve'), false, 'held and busy: not told it is waiting')

    const insideNotice = noticeOf(inside)
    assert.ok(insideNotice.includes(claudeToolName('say')), 'stream open: told it speaks inside')
    assert.equal(insideNotice.includes('channels say mesa'), false, 'stream open: no terminal hint')

    // Discrimination: what a caller using `pathOf` would have said to the held pane is a different text, "waiting".
    const bad = joinedNotice('mesa', DESK_JOINER, memberNames(held), doorApi.delivery.pathOf(held))
    assert.ok(bad.includes('não ouve'), 'the pathOf text says the pane does not hear')
    assert.notEqual(heldNotice, bad, 'the route text is not the pathOf text')
  })
})
