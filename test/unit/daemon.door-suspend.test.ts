// A pane the app suspended to save resources (door/suspend.ts) in a real tetherd on a test home and test pipe: what comes from
// outside resumes it first and then acts, nothing lost. The fake agent is a `claude` slot whose process logs every stdin chunk;
// the app's half (the desk map marking the pane `suspended`) is sent as the app sends it. The user's home, pipe and tetherd are
// never touched.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { DisposableStore } from '../../app/shared/vscode-lifecycle.ts'
import '../../src/agents/load.ts'
import { agentRegistry, type AgentContribution } from '../../src/agents/registry.ts'
import type { AgentAdapter, LaunchPlan } from '../../src/agents/types.ts'
import { slotEventsPath } from '../../src/core/paths.ts'
import { DoorHost } from '../../src/daemon/door/host.ts'
import type { DeliveryMessage, DeliveryReceipt, DoorDelivery, DoorSlots } from '../../src/daemon/door/types.ts'
import type { DeskMap } from '../../src/daemon/protocol.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { removeHome, sleep, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

const FAKE_AGENT = String.raw`
const fs = require('node:fs')
process.stdout.write('READY\r\n')
if (process.stdin.setRawMode) process.stdin.setRawMode(true)
process.stdin.on('data', (d) => fs.appendFileSync(process.env.ECHO_LOG, JSON.stringify(d.toString()) + '\n'))
setInterval(() => {}, 60000)
`

const readLines = (file: string): string[] => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as string) : [])
const msg = (body: string): DeliveryMessage => ({ kind: 'message', room: 'kai', from: { name: 'Atrium', id: 'a1b2c3', role: 'owner' }, body })

describe('agent door: a suspended pane resumes for what comes from outside', () => {
  let home: string
  let daemon: Daemon
  let door: DoorHost
  let own: DisposableStore
  let slots: DoorSlots
  let delivery: DoorDelivery
  const receipts: DeliveryReceipt[] = []
  const logs: string[] = []
  const echoLog = (slotId: string): string => join(home, `echo-${slotId}.log`)

  const fake: AgentAdapter = {
    name: 'claude',
    resumes: true,
    plan: (input): LaunchPlan => {
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
      delete env.NODE_TEST_CONTEXT
      env.ECHO_LOG = echoLog(input.slot.slotId)
      return { command: process.execPath, args: [join(home, 'fake-agent.cjs')], cwd: input.slot.cwd, env }
    },
    sessionExists: async () => 'unknown',
    title: async (b) => b.title,
  }

  // The fake is `node <script>`: no channel flag for it (node would read it).
  const contribution = agentRegistry.get('claude')! as { channels?: AgentContribution['channels'] }
  const savedChannels = contribution.channels
  before(() => { contribution.channels = () => [] })
  after(() => { contribution.channels = savedChannels })

  before(async () => {
    home = tempHome()
    writeFileSync(join(home, 'fake-agent.cjs'), FAKE_AGENT)
    door = new DoorHost({ log: (m) => logs.push(m) })
    own = new DisposableStore()
    daemon = await startDaemon({ home, pipe: uniquePipe(home), memoryIntervalMs: 0, readyFallbackMs: 300, minAgentAgeMs: 0, adapters: { claude: fake }, channelOf: () => undefined, door, log: (m) => logs.push(m) })
    const api = door.apiFor('probe', own)
    slots = api.slots
    delivery = api.delivery
    delivery.enable()
    delivery.onDidDeliver((r) => receipts.push(r))
  })
  after(async () => {
    await door.delivery.flush().catch(() => {})
    own.dispose()
    door.delivery.dispose()
    await daemon.close().catch(() => {})
    await door.mcp.close().catch(() => {})
    await removeHome(home)
  })

  /** The app's desk map: one desk with the slot's pane, marked as the app marks it. */
  const sendMap = async (slotId: string, mark: { suspended?: true; asleep?: true }): Promise<void> => {
    const map: DeskMap = { desks: [{ id: 'desk-1', name: 'Mesa', kind: 'queue', panes: [{ id: slotId, type: 'terminal', ...mark }] }], drawer: [] }
    await door.desks.handleMap({ t: 'desk-map', id: 1, map }, { client: 'app' })
  }
  const running = async (name: string): Promise<string> => {
    const id = (await slots.create({ kind: 'claude', cwd: home, name })).slotId
    await waitUntil(() => slots.get(id)?.status === 'running' && slots.readScreen(id).data.includes('READY'), 30_000, `${name} running`)
    // The agent reports its session (Claude's SessionStart): only such a pane can be suspended and resumed.
    const sessionId = randomUUID()
    appendFileSync(slotEventsPath(home, id), JSON.stringify({ v: 1, ts: new Date().toISOString(), slotId: id, agent: 'claude', kind: 'start', source: 'startup', sessionId, cwd: home, resume: { cwd: home, args: ['--resume', sessionId] } }) + '\n')
    await waitUntil(() => slots.get(id)?.canRestart === true, 10_000, `${name} reported its session`)
    return id
  }
  /** What the sweep does: the map says suspended first, then the process stops. */
  const suspend = async (id: string): Promise<void> => {
    await sendMap(id, { suspended: true })
    await slots.stop(id)
    await waitUntil(() => slots.get(id)?.status === 'exited', 15_000, 'stopped')
  }
  const receiptOf = (id: string): DeliveryReceipt | undefined => receipts.find((r) => r.id === id)

  test('the desk map keeps `suspended` and the door reads it', async () => {
    const id = (await slots.create({ kind: 'claude', cwd: home, start: false })).slotId
    await sendMap(id, { suspended: true })
    assert.equal(door.suspend.isSuspended(id), true)
    assert.equal(door.desks.map()?.desks[0]?.panes[0]?.suspended, true)
    await sendMap(id, {})
    assert.equal(door.suspend.isSuspended(id), false)
    await slots.forget(id)
  })

  test('a delivery to a suspended pane resumes it, waits, and then delivers: nothing is lost', async () => {
    const id = await running('entrega')
    await slots.setHeld(id, { ext: 'probe', by: 'owner-slot' })
    await suspend(id)
    const r = await delivery.deliver(id, msg('acorda e lê isto'))
    assert.equal(r.state, 'queued', 'the agent is not up yet: the message waits')
    await waitUntil(() => slots.get(id)?.status === 'running', 30_000, 'resumed by the delivery')
    await waitUntil(() => receiptOf(r.id)?.state === 'typed', 30_000, 'delivered once the agent is up')
    await waitUntil(() => readLines(echoLog(id)).join('').includes('acorda e lê isto'), 10_000, 'the text reached the resumed process')
    assert.ok(logs.some((l) => l.includes(`guia suspensa ${id} retomada (entrega)`)))
    await slots.forget(id)
  })

  test('an owner act (awake) resumes a suspended pane and waits until the agent is up; then the write lands', async () => {
    const id = await running('verbo')
    await suspend(id)
    assert.equal(slots.get(id)?.status, 'exited')
    const state = await slots.awake(id, 'agents type')
    assert.equal(state?.status, 'running', 'awake resolves only once the agent is up')
    await slots.write(id, 'depois de acordar')
    await waitUntil(() => readLines(echoLog(id)).join('').includes('depois de acordar'), 10_000, 'the write reached the resumed process')
    await slots.forget(id)
  })

  test('a resume asked while the suspension stop is under way waits for the exit, then starts', async () => {
    const id = await running('parando')
    await sendMap(id, { suspended: true })
    const stopping = slots.stop(id)
    const awake = slots.awake(id, 'agents send') // asked before the process is gone
    await stopping
    const state = await awake
    assert.equal(state?.status, 'running')
    await slots.forget(id)
  })

  test('a pane that is not suspended (stopped, or hibernated) is not resumed: the message waits as before', async () => {
    const id = await running('parada')
    await slots.setHeld(id, { ext: 'probe', by: 'owner-slot' })
    await sendMap(id, {})
    await slots.stop(id)
    await waitUntil(() => slots.get(id)?.status === 'exited', 15_000, 'stopped')
    const r = await delivery.deliver(id, msg('fica na fila'))
    assert.equal(r.state, 'queued')
    assert.equal((await slots.awake(id, 'agents send'))?.status, 'exited', 'awake of a plain stopped pane answers at once')
    await sendMap(id, { asleep: true })
    const r2 = await delivery.deliver(id, msg('hibernada também espera'))
    assert.equal(r2.state, 'queued')
    await sleep(800)
    assert.equal(slots.get(id)?.status, 'exited', 'a hibernated pane waits for an explicit wake')
    await slots.forget(id)
  })
})
