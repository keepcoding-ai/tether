// A muted member that receives by the terminal (a pane `held`, no MCP stream) still hears: the mute notice and the
// moderator's next line are typed into its pane, in order. Same rig as ext.channels-fanout.test.ts; fake agent only.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, test } from 'node:test'
import { DisposableStore } from '../../app/shared/vscode-lifecycle.ts'
import '../../src/agents/load.ts'
import { agentRegistry, type AgentContribution } from '../../src/agents/registry.ts'
import type { AgentAdapter, LaunchPlan } from '../../src/agents/types.ts'
import { DoorHost } from '../../src/daemon/door/host.ts'
import type { DoorApi } from '../../src/daemon/door/types.ts'
import { fsIo } from '../../src/daemon/ext-io.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { createChannels, type Channels, type ChannelsApi } from '../../extensions/channels/daemon/fanout.ts'
import { openStore } from '../../extensions/channels/daemon/store.ts'
import { USER } from '../../extensions/channels/rules.ts'
import { Recorder, removeHome, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

const AGENT = fileURLToPath(new URL('../fixtures/channels/agent.cjs', import.meta.url))
const readLines = <T>(file: string): T[] => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as T) : [])

describe('muted member by the terminal', () => {
  let home: string
  let daemon: Daemon
  let rec: Recorder
  let door: DoorHost
  let doorApi: DoorApi
  let ch: Channels
  const own = new DisposableStore()
  const logs: string[] = []
  const echoLog = (slotId: string): string => join(home, `echo-${slotId}.log`)
  const typed = (slotId: string): string => readLines<string>(echoLog(slotId)).join('')

  const fake: AgentAdapter = {
    name: 'claude',
    plan: (input): LaunchPlan => {
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
      delete env.NODE_TEST_CONTEXT
      env.ECHO_LOG = echoLog(input.slot.slotId)
      env.CHAN_LOG = join(home, `chan-${input.slot.slotId}.log`)
      env.OPEN_STREAM = '0'
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
    daemon = await startDaemon({ home, pipe: uniquePipe(home), memoryIntervalMs: 0, readyFallbackMs: 300, minAgentAgeMs: 0, adapters: { claude: fake }, channelOf: () => undefined, door, log: (m) => logs.push(m) })
    rec = await Recorder.connect(daemon.pipe)
    doorApi = door.apiFor('channels', own)
    own.add(doorApi.delivery.enable())
    const api: ChannelsApi = { slots: doorApi.slots, attention: doorApi.attention, delivery: doorApi.delivery, events: { emit: () => {} }, settings: { get: () => undefined }, log: (m) => logs.push(m) }
    ch = createChannels(api, await openStore(fsIo, home))
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

  test('mute notice and the next moderator line are typed into the muted member', async () => {
    const m = (await doorApi.slots.create({ kind: 'claude', cwd: home, name: 'fora-calado' })).slotId
    await waitUntil(() => doorApi.slots.get(m)?.status === 'running' && doorApi.slots.readScreen(m).data.includes('READY'), 30_000, 'running')
    await doorApi.slots.setHeld(m, { ext: 'probe', by: 'owner-slot' })
    const made = await ch.create(USER, { name: 'bancada' })
    assert.ok(made.ok)
    const id = made.channel.id
    assert.ok((await ch.join(USER, id, m)).ok)
    const first = await ch.say(USER, id, { body: 'FALA-UM do moderador' })
    assert.ok(first.ok)
    await waitUntil(() => typed(m).includes('FALA-UM'), 40_000, 'line before the mute typed')

    const muted = await ch.mute(USER, id, m)
    assert.ok(muted.ok && muted.changed)
    const second = await ch.say(USER, id, { body: 'FALA-GAMA do moderador' })
    assert.ok(second.ok)
    assert.ok(second.receipts[m] !== undefined, `the muted member is in the fan-out: ${JSON.stringify(second.receipts)}`)
    await waitUntil(() => typed(m).includes('FALA-GAMA'), 40_000, `the line after the mute typed; receipts ${JSON.stringify(second.receipts)}; pending ${JSON.stringify(doorApi.delivery.pending(m).map((p) => p.state))}`)
    assert.ok(typed(m).includes('foi calado') || typed(m).includes('calado em #bancada'), 'the member was told')
    await doorApi.slots.forget(m)
  })

  // The Soul's permission card takes a bare digit with no Enter; `agents answer` writes it as the pane's holder (origin
  // 'agent'), which the interlock counts as one character of draft. A draft frees only on a busy state; a short turn
  // that ends after the answer publishes none, so the draft stays and the terminal path stays closed for every later line.
  test('a card answered by the holder (a bare digit) leaves no draft: the next line is typed', async () => {
    const m = (await doorApi.slots.create({ kind: 'claude', cwd: home, name: 'fora-cartao' })).slotId
    await waitUntil(() => doorApi.slots.get(m)?.status === 'running' && doorApi.slots.readScreen(m).data.includes('READY'), 30_000, 'running')
    await doorApi.slots.setHeld(m, { ext: 'probe', by: 'owner-slot' })
    const made = await ch.create(USER, { name: 'cartao' })
    assert.ok(made.ok)
    assert.ok((await ch.join(USER, made.channel.id, m)).ok)
    await waitUntil(() => doorApi.delivery.pending(m).length === 0, 40_000, 'entry notice typed')
    door.delivery.input(m, '1', 'agent', { answer: true }) // the card answer, as server.ts feeds it with the verb's mark
    const said = await ch.say(USER, made.channel.id, { body: 'FALA-DEPOIS-DO-CARTAO' })
    assert.ok(said.ok)
    await waitUntil(() => typed(m).includes('FALA-DEPOIS-DO-CARTAO'), 25_000, 'typed after the card answer')
    await doorApi.slots.forget(m)
  })
})
