// The pause's resume goes through the agent door (retouch D6b): typed with the engine's own typing (door/typing.ts) and told
// to the door at each write, so the delivery's interlock sees it. A real tetherd on a test home and test pipe; the fake agent
// logs every stdin chunk with the time it got it. No real agent; the user's home, pipe and tetherd are never touched.
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { DisposableStore } from '../../app/shared/vscode-lifecycle.ts'
import '../../src/agents/load.ts'
import { agentRegistry, type AgentContribution } from '../../src/agents/registry.ts'
import type { AgentAdapter, LaunchPlan } from '../../src/agents/types.ts'
import { slotPauseReportPath } from '../../src/core/paths.ts'
import { DoorHost } from '../../src/daemon/door/host.ts'
import type { DeliveryMessage, DeliveryReceipt, DoorDelivery, DoorSlots } from '../../src/daemon/door/types.ts'
import { USER_QUIET_MS } from '../../src/daemon/door/user-presence.ts'
import type { PauseBatch } from '../../src/daemon/pause.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { Recorder, removeHome, sleep, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

const FAKE_AGENT = String.raw`
const fs = require('node:fs')
process.stdout.write('READY\r\n')
if (process.stdin.setRawMode) process.stdin.setRawMode(true)
process.stdin.on('data', (d) => fs.appendFileSync(process.env.ECHO_LOG, JSON.stringify({ t: Date.now(), d: d.toString() }) + '\n'))
setInterval(() => {}, 60000)
`

interface Chunk { t: number; d: string }
const readLines = <T>(file: string): T[] => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as T) : [])
const msg = (body: string): DeliveryMessage => ({ kind: 'message', room: 'kai', from: { name: 'Atrium', id: 'a1b2c3', role: 'member' }, body })

describe('pause resume through the agent door (D6b)', () => {
  let home: string
  let daemon: Daemon
  let rec: Recorder
  let door: DoorHost
  let own: DisposableStore
  let slots: DoorSlots
  let delivery: DoorDelivery
  const receipts: DeliveryReceipt[] = []
  const events: PauseBatch[] = []

  const echoLog = (slotId: string): string => join(home, `echo-${slotId}.log`)
  const chunks = (slotId: string): Chunk[] => readLines<Chunk>(echoLog(slotId))
  const fakeOf = (name: string): AgentAdapter => ({
    name,
    plan: (input): LaunchPlan => {
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
      delete env.NODE_TEST_CONTEXT
      env.ECHO_LOG = echoLog(input.slot.slotId)
      return { command: process.execPath, args: [join(home, 'fake-agent.cjs')], cwd: input.slot.cwd, env }
    },
    sessionExists: async () => 'unknown',
    title: async (b) => b.title,
  })

  // The fake is `node <script>`: the door's channel flag (it goes first in the plan once the delivery is on) would be read
  // by node. These tests are about the terminal path: the channel stays off, as for an agent without one.
  const contribution = agentRegistry.get('claude')! as { channels?: AgentContribution['channels'] }
  const savedChannels = contribution.channels
  before(() => { contribution.channels = () => [] })
  after(() => { contribution.channels = savedChannels })

  before(async () => {
    home = tempHome()
    writeFileSync(join(home, 'fake-agent.cjs'), FAKE_AGENT)
    door = new DoorHost({ log: () => {} })
    own = new DisposableStore()
    daemon = await startDaemon({ home, pipe: uniquePipe(home), memoryIntervalMs: 0, readyFallbackMs: 300, minAgentAgeMs: 0, adapters: { claude: fakeOf('claude'), codex: fakeOf('codex') }, channelOf: () => undefined, door, log: () => {} })
    rec = await Recorder.connect(daemon.pipe)
    rec.client.on('pause', (b) => events.push(structuredClone(b)))
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
    rec.close()
    await daemon.close()
    await door.mcp.close()
    await removeHome(home)
  })

  const running = async (kind: string, name: string): Promise<string> => {
    const id = (await slots.create({ kind, cwd: home, name })).slotId
    await waitUntil(() => slots.get(id)?.status === 'running' && slots.readScreen(id).data.includes('READY'), 30_000, `${name} running`)
    return id
  }
  /** A batch over `id` brought to `paused` (the agent said it stopped). */
  const paused = async (id: string): Promise<void> => {
    const batch = (await rec.client.request({ t: 'pause-start', slotIds: [id] })).pause!
    for (const kind of ['delivered', 'done']) {
      appendFileSync(slotPauseReportPath(home, id), JSON.stringify({ ts: new Date().toISOString(), batchId: batch.id, kind, ...(kind === 'done' ? { text: 'nota' } : {}) }) + '\n')
    }
    await waitUntil(() => events.at(-1)?.state === 'paused', 10_000, 'batch paused')
  }
  const resumed = (): Promise<void> => waitUntil(() => events.at(-1)?.state === 'closed', 10_000, 'batch closed')

  test('a delivery to the same held slot during the resume waits: the resume text and its Enter stay together', async () => {
    const id = await running('claude', 'pausa')
    await slots.setHeld(id, { ext: 'probe', by: 'owner-slot' })
    await paused(id)
    const mark = chunks(id).length
    // The resume writes its text before replying; the delivery arrives between that text and the Enter.
    await rec.client.request({ t: 'pause-resume' })
    const r = await delivery.deliver(id, msg('no meio'))
    assert.equal(r.state, 'queued', 'the resume typing holds the terminal')
    await resumed()
    await waitUntil(() => chunks(id).slice(mark).some((c) => c.d === '\r'), 5_000, 'the resume Enter')
    await sleep(1_000)
    assert.equal(receipts.find((x) => x.id === r.id), undefined, 'still waiting after the resume Enter (the interlock quiet)')
    await waitUntil(() => receipts.find((x) => x.id === r.id)?.state === 'typed', USER_QUIET_MS + 10_000, 'typed after the quiet')
    await waitUntil(() => chunks(id).slice(mark).filter((c) => c.d === '\r').length === 2, 5_000, 'the delivery Enter')
    const typed = chunks(id).slice(mark).map((c) => c.d)
    const firstEnter = typed.indexOf('\r')
    assert.match(typed.slice(0, firstEnter).join(''), /^\[tether\] Retomando a pausa\. Sua nota: "nota"\. Continue de onde parou\.$/, 'only the resume text before its Enter')
    assert.match(typed.slice(firstEnter + 1, -1).join(''), /no meio/, 'the delivery after it')
    await slots.forget(id)
  })

  test('an agent whose typing waits 300 ms (codex) gets the resume Enter 300 ms after the text', async () => {
    const id = await running('codex', 'codex')
    await paused(id)
    const mark = chunks(id).length
    await rec.client.request({ t: 'pause-resume' })
    await resumed()
    await waitUntil(() => chunks(id).slice(mark).some((c) => c.d === '\r'), 5_000, 'the resume Enter')
    const got = chunks(id).slice(mark)
    const enter = got.findIndex((c) => c.d === '\r')
    assert.ok(enter > 0, 'text before the Enter')
    const gap = got[enter]!.t - got[enter - 1]!.t
    assert.ok(gap >= 280, `Enter ${gap} ms after the text`)
    await slots.forget(id)
  })
})
