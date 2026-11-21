// The agent door's rerouted attention (slice D7) in a real tetherd on a test home and test pipe, with a fake adapter whose
// process just stays alive. The attention of a routed slot comes from the soul `turn` events the test appends to its events
// file. No real agent; the user's home, pipe and tetherd are never touched.
import assert from 'node:assert/strict'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { DisposableStore } from '../../app/shared/vscode-lifecycle.ts'
import type { AgentAdapter, LaunchPlan } from '../../src/agents/types.ts'
import { slotEventsPath, slotMetaPath } from '../../src/core/paths.ts'
import { DoorHost } from '../../src/daemon/door/host.ts'
import type { DoorAttention, DoorSlots } from '../../src/daemon/door/types.ts'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { Recorder, removeHome, sleep, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

const STAY = ["process.stdout.write('READY\\r\\n')", 'setInterval(() => {}, 1000)'].join('\n')
const codeOf = (e: unknown): string | undefined => (e as { code?: string }).code

describe('agent door attention route (D7)', () => {
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

  async function boot(): Promise<void> {
    door = new DoorHost({ log: (m) => logs.push(m) })
    own = new DisposableStore()
    daemon = await startDaemon({ home, pipe, memoryIntervalMs: 0, readyFallbackMs: 60_000, minAgentAgeMs: 0, adapters: { soul: fake }, door, log: (m) => logs.push(m) })
    rec = await Recorder.connect(daemon.pipe)
    const api = door.apiFor('probe', own)
    slots = api.slots
    attention = api.attention
  }
  async function shutdown(): Promise<void> {
    own.dispose()
    rec.close()
    await daemon.close()
  }

  before(async () => {
    home = tempHome()
    pipe = uniquePipe(home)
    // A script file: a `-e` script does not survive the terminal host's command line on Windows.
    writeFileSync(join(home, 'stay.cjs'), STAY)
    await boot()
  })
  after(async () => {
    await shutdown().catch(() => {})
    await removeHome(home)
  })

  const ready = (id: string): Promise<void> => waitUntil(() => slots.readScreen(id).data.includes('READY'), 30_000, `READY in ${id}`)
  const turn = (id: string, state: 'busy' | 'idle'): void =>
    appendFileSync(slotEventsPath(home, id), JSON.stringify({ v: 1, ts: new Date().toISOString(), slotId: id, agent: 'soul', kind: 'turn', source: 'turn', state, sessionId: 'sess-1', cwd: home }) + '\n')
  const last = (id: string): SlotState => slots.get(id)!
  const pair = async (): Promise<{ owner: string; worker: string }> => {
    const owner = (await slots.create({ kind: 'soul', cwd: home, name: 'dono' })).slotId
    const worker = (await slots.create({ kind: 'soul', cwd: home, name: 'trabalho' })).slotId
    await ready(owner); await ready(worker)
    return { owner, worker }
  }

  test('a route to a live slot silences `attention` and puts it in `attentionFor`; the turn stays visible', async () => {
    const { owner, worker } = await pair()
    await attention.route(worker, owner)
    assert.equal(attention.routeOf(worker), owner)
    turn(worker, 'busy')
    await waitUntil(() => last(worker).turn === 'busy', 10_000, 'busy shows')
    assert.equal(last(worker).attention, undefined)
    turn(worker, 'idle')
    await waitUntil(() => last(worker).attentionFor !== undefined, 10_000, 'attentionFor shows')
    assert.deepEqual(last(worker).attentionFor, { slotId: owner, value: 'done' })
    assert.equal(last(worker).attention, undefined)
    // What the clients get is the same state.
    const sent = await rec.state(worker, (s) => s.attentionFor !== undefined)
    assert.equal(sent.attention, undefined)

    // The daemon's own attention is intact: the turn the ronda and the pause read is not hidden.
    turn(worker, 'busy')
    await waitUntil(() => last(worker).turn === 'busy', 10_000, 'busy again')
    assert.equal(last(worker).attentionFor, undefined, 'a new turn clears the attention, routed or not')

    await attention.unroute(worker)
    assert.equal(attention.routeOf(worker), undefined)
    turn(worker, 'idle')
    await waitUntil(() => last(worker).attention === 'done', 10_000, 'attention back to the person')
    assert.equal(last(worker).attentionFor, undefined)
    await slots.forget(owner); await slots.forget(worker)
  })

  test('the recipient leaves: the routed state is re-sent with `attention`; it returns: the route is back', async () => {
    const { owner, worker } = await pair()
    await attention.route(worker, owner)
    turn(worker, 'busy'); turn(worker, 'idle')
    await waitUntil(() => last(worker).attentionFor !== undefined, 10_000, 'attentionFor shows')

    const mark = rec.states.length
    await slots.stop(owner)
    await waitUntil(() => rec.states.slice(mark).some((s) => s.slotId === worker && s.attention === 'done' && s.attentionFor === undefined), 10_000, 'worker re-sent with attention')
    assert.equal(last(worker).attention, 'done')

    await slots.start(owner, 'new')
    await ready(owner)
    await waitUntil(() => last(worker).attentionFor?.slotId === owner, 10_000, 'the route is back')
    assert.equal(last(worker).attention, undefined)
    assert.equal(attention.routeOf(worker), owner)
    await slots.forget(owner)
    // The owner is forgotten: the route goes with it and the person sees the attention again.
    assert.equal(attention.routeOf(worker), undefined)
    assert.equal(last(worker).attention, 'done')
    await slots.forget(worker)
  })

  test('attention.seen clears a rerouted attention; the pipe seen is not sent by a client that sees no `attention`', async () => {
    const { owner, worker } = await pair()
    await attention.route(worker, owner)
    turn(worker, 'busy'); turn(worker, 'idle')
    await waitUntil(() => last(worker).attentionFor !== undefined, 10_000, 'attentionFor shows')
    attention.seen(worker)
    await waitUntil(() => last(worker).attentionFor === undefined, 10_000, 'attentionFor cleared')
    assert.equal(last(worker).attention, undefined, 'cleared for good, not handed back to the person')
    await slots.stop(owner)
    await sleep(300)
    assert.equal(last(worker).attention, undefined, 'and it does not come back when the owner leaves')
    assert.throws(() => attention.seen('ffffffff'), (e: unknown) => codeOf(e) === 'unknown-slot')
    await slots.forget(owner); await slots.forget(worker)
  })

  test('the pipe seen leaves a rerouted attention alone and emits nothing; with the owner away it clears as before', async () => {
    const { owner, worker } = await pair()
    try {
      await attention.route(worker, owner)
      turn(worker, 'busy'); turn(worker, 'idle')
      await waitUntil(() => last(worker).attentionFor !== undefined, 10_000, 'attentionFor shows')
      // The client itself has received the settled state, then a round trip drains whatever was still in transit to it.
      await rec.state(worker, (s) => s.attentionFor?.value === 'done', 10_000, 'attentionFor reaches the client')
      await rec.client.request({ t: 'list' })
      const mark = rec.states.length
      await rec.client.request({ t: 'seen', slotId: worker })
      await rec.client.request({ t: 'list' })
      assert.equal(rec.states.slice(mark).filter((s) => s.slotId === worker).length, 0, 'no state emitted')
      assert.deepEqual(last(worker).attentionFor, { slotId: owner, value: 'done' }, 'the owner attention is still there')

      // The owner is away: the person sees the attention and the pipe seen clears it, as always.
      await slots.stop(owner)
      await waitUntil(() => last(worker).attention === 'done', 10_000, 'attention back to the person')
      await rec.client.request({ t: 'seen', slotId: worker })
      await waitUntil(() => last(worker).attention === undefined, 10_000, 'cleared by the pipe seen')
    } finally {
      await slots.forget(owner).catch(() => {}); await slots.forget(worker).catch(() => {})
    }
  })

  test('a routed slot that is forgotten takes its route; route validates the slots', async () => {
    const { owner, worker } = await pair()
    await assert.rejects(attention.route(worker, 'ffffffff'), (e: unknown) => codeOf(e) === 'unknown-slot')
    await assert.rejects(attention.route('ffffffff', owner), (e: unknown) => codeOf(e) === 'unknown-slot')
    await assert.rejects(attention.route(worker, worker), (e: unknown) => codeOf(e) === 'bad-request')
    await attention.route(worker, owner)
    await attention.route(worker, owner) // the same again changes nothing
    await slots.forget(worker)
    await slots.forget(owner)
  })

  test('the route survives a daemon restart (it is in the slot meta)', async () => {
    const { owner, worker } = await pair()
    await attention.route(worker, owner)
    assert.equal(JSON.parse(readFileSync(slotMetaPath(home, worker), 'utf8')).attentionTo, owner)
    await shutdown()
    await boot()
    assert.equal(attention.routeOf(worker), owner)
    assert.equal(last(worker).status === 'running', false)
    // The owner is not running after the restart: the attention would go to the person; once it runs the route holds.
    await slots.start(owner, 'new'); await ready(owner)
    await slots.start(worker, 'new'); await ready(worker)
    turn(worker, 'busy'); turn(worker, 'idle')
    await waitUntil(() => last(worker).attentionFor?.slotId === owner, 10_000, 'route holds after the restart')
    await slots.forget(owner); await slots.forget(worker)
  })

  test('a satellite door (no port) rejects the acts, answers routeOf empty, and so does seen', async () => {
    const inert = new DoorHost({ log: () => {} }).apiFor('x', new DisposableStore()).attention
    await assert.rejects(inert.route('a', 'b'), (e: unknown) => codeOf(e) === 'door-unavailable')
    await assert.rejects(inert.unroute('a'), (e: unknown) => codeOf(e) === 'door-unavailable')
    assert.equal(inert.routeOf('a'), undefined)
    assert.throws(() => inert.seen('a'), (e: unknown) => codeOf(e) === 'door-unavailable')
  })
})
