// The daemon seams of wave 2 (slice K0) in a real tetherd on a test home and test pipe, with a fake adapter whose process
// just stays alive: `slots.onUserTyped`, `slots.userFree` and `attention.signal`. No real agent; the user's home, pipe and
// tetherd are never touched.
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { DisposableStore } from '../../app/shared/vscode-lifecycle.ts'
import type { AgentAdapter, LaunchPlan } from '../../src/agents/types.ts'
import { DoorHost } from '../../src/daemon/door/host.ts'
import type { DoorAttention, DoorSlots } from '../../src/daemon/door/types.ts'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { Recorder, removeHome, sleep, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

const STAY = ["process.stdout.write('READY\\r\\n')", 'setInterval(() => {}, 1000)'].join('\n')
const codeOf = (e: unknown): string | undefined => (e as { code?: string }).code

describe('agent door seams, wave 2 (K0)', () => {
  let home: string
  let pipe: string
  let daemon: Daemon
  let rec: Recorder
  let door: DoorHost
  let own: DisposableStore
  let slots: DoorSlots
  let attention: DoorAttention
  const logs: string[] = []

  const fake: AgentAdapter = {
    name: 'soul',
    plan: (input): LaunchPlan => {
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
      delete env.NODE_TEST_CONTEXT
      return { command: process.execPath, args: [join(home, 'stay.cjs')], cwd: input.resume?.cwd ?? input.slot.cwd, env }
    },
    sessionExists: async () => 'unknown',
    title: async (b) => b.title,
  }

  before(async () => {
    home = tempHome()
    pipe = uniquePipe(home)
    // A script file: a `-e` script does not survive the terminal host's command line on Windows.
    writeFileSync(join(home, 'stay.cjs'), STAY)
    door = new DoorHost({ log: (m) => logs.push(m) })
    own = new DisposableStore()
    daemon = await startDaemon({ home, pipe, memoryIntervalMs: 0, readyFallbackMs: 60_000, minAgentAgeMs: 0, adapters: { soul: fake }, door, log: (m) => logs.push(m) })
    rec = await Recorder.connect(daemon.pipe)
    const api = door.apiFor('probe', own)
    slots = api.slots
    attention = api.attention
  })
  after(async () => {
    own.dispose()
    rec.close()
    await daemon.close().catch(() => {})
    await removeHome(home)
  })

  const ready = (id: string): Promise<void> => waitUntil(() => slots.readScreen(id).data.includes('READY'), 30_000, `READY in ${id}`)
  const last = (id: string): SlotState => slots.get(id)!
  const make = async (name: string): Promise<string> => {
    const id = (await slots.create({ kind: 'soul', cwd: home, name })).slotId
    await ready(id)
    return id
  }
  /** The person's keys through the pipe, then a pause for them to reach the daemon's hooks. */
  const type = async (id: string, data: string): Promise<void> => { rec.client.input(id, data); await sleep(200) }

  test('onUserTyped: once per held period, only for the person, only on a held pane; setHeld arms it again', async () => {
    const id = await make('guia')
    const plain = await make('solta')
    const told: string[] = []
    const sub = slots.onUserTyped((slotId) => told.push(slotId))

    await type(plain, 'a')
    assert.deepEqual(told, [], 'a pane with no held never fires')

    await slots.setHeld(id, { ext: 'probe', by: plain })
    await type(id, '\x1b[I')
    await type(id, '\x1b[?1;2c')
    assert.deepEqual(told, [], 'terminal answers are not typing')
    await slots.write(id, 'x')
    await slots.keys(id, ['enter'])
    await sleep(200)
    assert.deepEqual(told, [], 'the agent writing through the door is not the person')

    await type(id, 'h')
    assert.deepEqual(told, [id], 'the first key of the person fires')
    await type(id, 'i')
    await type(id, '\r')
    assert.deepEqual(told, [id], 'once per held period')

    await slots.setHeld(id, { ext: 'probe', by: plain })
    await type(id, 'o')
    assert.deepEqual(told, [id, id], 'a new setHeld arms it again')

    await slots.setHeld(id, undefined)
    await type(id, 'p')
    assert.deepEqual(told, [id, id], 'given back: no held, no fire')

    sub.dispose()
    await slots.setHeld(id, { ext: 'probe', by: plain })
    await type(id, 'q')
    assert.deepEqual(told, [id, id], 'a disposed listener hears nothing')
    await slots.setHeld(id, undefined)
    await slots.forget(id); await slots.forget(plain)
  })

  test('userFree follows the delivery UserPresence: a draft or a recent key holds it, silence frees it', async () => {
    const id = await make('presenca')
    const presence = door.delivery.presence
    assert.equal(slots.userFree(id), true, 'nobody typed')
    await type(id, '\x1b[I')
    assert.equal(slots.userFree(id), true, 'a terminal answer is not typing')
    await type(id, 'ls')
    assert.equal(presence.draft(id), true)
    assert.equal(slots.userFree(id), false, 'a draft in the box')
    await type(id, '\r')
    assert.equal(presence.draft(id), false)
    assert.equal(slots.userFree(id), presence.isFree(id, Date.now()))
    assert.equal(slots.userFree(id), false, 'no draft, but the quiet time has not passed')
    assert.equal(presence.isFree(id, presence.freeAt(id)!), true, 'the same presence frees it after the quiet time')
    await slots.forget(id)
    assert.equal(slots.userFree(id), true, 'a forgotten slot has no presence left')
  })

  test('attention.signal lights the attention through the core and keeps the route', async () => {
    const owner = await make('dono')
    const worker = await make('trabalho')

    attention.signal(worker, 'waiting')
    await waitUntil(() => last(worker).attention === 'waiting', 10_000, 'waiting with no route')
    attention.signal(worker, 'done')
    await waitUntil(() => last(worker).attention === 'done', 10_000, 'done with no route')
    attention.seen(worker)
    await waitUntil(() => last(worker).attention === undefined, 10_000, 'cleared')

    await attention.route(worker, owner)
    attention.signal(worker, 'waiting')
    await waitUntil(() => last(worker).attentionFor !== undefined, 10_000, 'attentionFor shows')
    assert.deepEqual(last(worker).attentionFor, { slotId: owner, value: 'waiting' })
    assert.equal(last(worker).attention, undefined, 'the person is not called')
    const sent = await rec.state(worker, (s) => s.attentionFor?.value === 'waiting')
    assert.equal(sent.attention, undefined)

    await slots.stop(owner)
    await waitUntil(() => last(worker).attention === 'waiting', 10_000, 'owner away: the person sees it')
    assert.equal(last(worker).attentionFor, undefined)

    assert.throws(() => attention.signal('ffffffff', 'done'), (e: unknown) => codeOf(e) === 'unknown-slot')
    assert.throws(() => attention.signal(worker, 'busy' as 'done'), (e: unknown) => codeOf(e) === 'bad-request')
    await slots.forget(owner); await slots.forget(worker)
  })

  test('a satellite door (no port): signal rejects, onUserTyped registers, userFree answers free', () => {
    const inert = new DoorHost({ log: () => {} }).apiFor('x', new DisposableStore())
    assert.throws(() => inert.attention.signal('a', 'done'), (e: unknown) => codeOf(e) === 'door-unavailable')
    inert.slots.onUserTyped(() => {}).dispose()
    assert.equal(inert.slots.userFree('a'), true)
  })
})
