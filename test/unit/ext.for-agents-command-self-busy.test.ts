// A command of oneself (agents_command without `guia`, owner === pane) is dropped after 5 min when the pane never
// leaves `turn: 'busy'` (a background subagent keeps it busy); the owner is always told why (with or without `return`).
// Fake slots, gate, delivery and clock; a fake conductor types nothing real.
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { conductorRegistry, type Conductor } from '../../extensions/for-agents/conductor-api.ts'
import { PendingCommands } from '../../extensions/for-agents/daemon/verbs/command.ts'
import type { ReturnClock } from '../../extensions/for-agents/daemon/verbs/command-return.ts'
import { AttentionState, attentionOptions } from '../../src/daemon/attention.ts'

const T0 = 7_000_000
const PANE = 'sb-pane'
const MIN = 60_000

function fakeClock() {
  let now = T0
  const clock: ReturnClock = {
    now: () => now,
    setTimeout: () => 0,
    clearTimeout: () => {},
  }
  return { clock, advance: (ms: number) => { now += ms } }
}

describe('PendingCommands: a command of oneself on a pane that stays busy', () => {
  const events: string[] = []
  const logs: string[] = []
  const delivered: unknown[] = []
  /** The claims and releases, in the order they happened, with the deliveries to the owner among them. */
  const order: string[] = []
  let proven = true
  let slot: { turn?: 'busy' | 'idle'; slotId: string; kind: string; status: string }
  let reg: { dispose(): void }
  let fc: ReturnType<typeof fakeClock>
  let pending: PendingCommands

  const fake: Conductor = {
    id: 'sbfake',
    match: (t) => (t.paneId.startsWith('sb-') ? 1000 : undefined),
    capabilities: [{ id: 'command', label: 'c' }],
    command: async (_ctx, name) => { events.push(`type:${name}`); return { value: undefined, proven } },
    detect: async () => ({ state: 'idle' }),
  }

  beforeEach(() => {
    events.length = 0; logs.length = 0; delivered.length = 0; order.length = 0; proven = true
    slot = { slotId: PANE, kind: 'shell', status: 'running', turn: 'busy' }
    reg = conductorRegistry.register(fake)
    fc = fakeClock()
    pending = new PendingCommands(fc.clock)
    const deps = {
      api: {
        slots: {
          get: (id: string) => (id === PANE ? slot : undefined),
          readScreen: () => ({ data: '', cols: 80, rows: 24, start: 0, end: 0, reset: false }),
          paintedAt: () => T0,
          userTypedAt: () => undefined,
        },
        desks: { map: () => undefined },
        delivery: {
          quiet: () => true,
          deliver: async (owner: string, msg: never) => { delivered.push({ owner, msg }); order.push('deliver'); return { id: 'r1', state: 'delivered' } },
          claim: (id: string) => { order.push(`claim:${id}`); return { release: (typed: boolean) => { order.push(`release:${id}:${typed}`) } } },
        },
        agents: { get: () => undefined },
        io: {}, home: '', log: (l: string) => { logs.push(l) },
      },
      store: { recordLast: async () => {} },
      gate: { check: () => undefined, write: async () => ({ ok: true }) },
      readers: {},
    }
    pending.bind(deps as never)
  })
  afterEach(() => { reg.dispose(); pending.dispose().dispose() })

  test('busy for 5+ min: the command is dropped and the owner is told why, even without return', async () => {
    pending.add(PANE, PANE, 'compact', undefined) // owner === pane: a command of oneself, no `return`
    for (let i = 0; i < 6; i++) { fc.advance(MIN); await pending.flush() }
    assert.deepEqual(events, [], 'the conductor was never called')
    assert.equal(pending.count(PANE), 0, 'the command left the queue')
    assert.ok(logs.some((l) => l.includes('descartado')), `the daemon log got "descartado": ${JSON.stringify(logs)}`)
    assert.equal(delivered.length, 1, 'the owner got exactly one message')
    const d = delivered[0] as { owner: string; msg: { kind: string; body: string } }
    assert.equal(d.owner, PANE)
    assert.equal(d.msg.kind, 'notice')
    assert.equal(d.msg.body, 'comando /compact: não rodou; a guia não ficou livre em 5 min (turno busy)')
  })

  test('the same request again is one wait with a renewed clock; a different one queues', async () => {
    pending.add(PANE, PANE, 'compact', undefined)
    fc.advance(4 * MIN); await pending.flush()
    pending.add(PANE, PANE, 'compact', undefined) // renews `since`
    pending.add(PANE, PANE, 'compact', undefined)
    assert.equal(pending.count(PANE), 1)
    fc.advance(2 * MIN); await pending.flush() // 6 min since the first add, 2 since the renewal: still waiting
    assert.equal(pending.count(PANE), 1)
    assert.deepEqual(delivered, [])
    pending.add(PANE, PANE, 'compact', '--x') // other args
    pending.add(PANE, PANE, 'compact', undefined, true) // other ret
    pending.add(PANE, 'other', 'compact', undefined) // other owner
    assert.equal(pending.count(PANE), 4)
  })

  test('held() lists what waits: name, since (ISO) and what holds it', async () => {
    pending.add(PANE, PANE, 'compact', undefined)
    assert.deepEqual(pending.held(PANE), [{ name: 'compact', since: new Date(T0).toISOString() }], 'not looked at yet: no heldBy')
    fc.advance(MIN); await pending.flush()
    assert.deepEqual(pending.held(PANE), [{ name: 'compact', since: new Date(T0).toISOString(), heldBy: 'turno busy' }])
    assert.deepEqual(pending.held('nowhere'), [])
  })

  test('a short idle window before 5 min lets the command run: the cause is the duration of busy, not the gate', async () => {
    pending.add(PANE, PANE, 'compact', undefined)
    for (let i = 0; i < 3; i++) { fc.advance(MIN); await pending.flush() }
    assert.deepEqual(events, [])
    delete slot.turn // idle for one flush (the real daemon leaves `turn` unset when idle)
    fc.advance(MIN); await pending.flush()
    slot.turn = 'busy'
    assert.deepEqual(events, ['type:compact'])
    assert.equal(pending.count(PANE), 0)
    assert.ok(!logs.some((l) => l.includes('descartado')))
  })

  test('the window is claimed once per pane: a repeated request renews only the deadline; released (false) before the drop notice', async () => {
    pending.add(PANE, PANE, 'compact', undefined)
    fc.advance(4 * MIN); await pending.flush()
    pending.add(PANE, PANE, 'compact', undefined)
    assert.deepEqual(order, [`claim:${PANE}`], 'one claim, not renewed by the repeat')
    for (let i = 0; i < 6; i++) { fc.advance(MIN); await pending.flush() }
    assert.deepEqual(order, [`claim:${PANE}`, `release:${PANE}:false`, 'deliver'], 'nothing typed: no settle; released before the owner is told')
  })

  test('released (typed) once the command ran and the pane has nothing more; a second command on the pane keeps the claim', async () => {
    pending.add(PANE, PANE, 'compact', undefined)
    pending.add(PANE, PANE, 'clear', undefined)
    assert.deepEqual(order, [`claim:${PANE}`])
    delete slot.turn
    await pending.flush()
    assert.deepEqual(events, ['type:compact'])
    assert.deepEqual(order, [`claim:${PANE}`], 'clear still waits under the same claim')
    await pending.flush()
    assert.deepEqual(events, ['type:compact', 'type:clear'])
    assert.deepEqual(order, [`claim:${PANE}`, `release:${PANE}:true`])
  })

  test('dispose releases the claims it holds', () => {
    pending.add(PANE, PANE, 'compact', undefined)
    pending.dispose().dispose()
    assert.deepEqual(order, [`claim:${PANE}`, `release:${PANE}:false`])
  })

  test('not proven by the probe: back to the head once (new deadline, after a pause); the second time the owner is told', async () => {
    proven = false
    pending.add(PANE, PANE, 'compact', undefined)
    pending.add(PANE, PANE, 'clear', undefined)
    delete slot.turn
    await pending.flush()
    assert.deepEqual(events, ['type:compact'])
    assert.deepEqual(pending.held(PANE).map((h) => h.name), ['compact', 'clear'], 'back at the head')
    assert.equal(pending.held(PANE)[0]!.since, new Date(fc.clock.now()).toISOString(), 'a new deadline')
    await pending.flush()
    assert.deepEqual(events, ['type:compact'], 'not again at once')
    assert.match(pending.held(PANE)[0]!.heldBy ?? '', /nova tentativa/)
    fc.advance(2_000); await pending.flush()
    assert.deepEqual(events, ['type:compact', 'type:compact'], 'the one retry')
    assert.equal(delivered.length, 1)
    assert.equal((delivered[0] as { msg: { body: string } }).msg.body, 'comando /compact: não rodou; a sonda não viu o comando na guia em duas tentativas')
    assert.deepEqual(pending.held(PANE).map((h) => h.name), ['clear'], 'given up; the next one waits')
    assert.deepEqual(order, [`claim:${PANE}`, 'deliver'], 'the claim stays for clear')
  })

  test('real AttentionState: done with a background subagent keeps the turn busy', () => {
    const a = new AttentionState(attentionOptions('claude'))
    a.hook('start')
    assert.equal(a.turn, 'busy')
    a.setBackground(1, T0)
    a.hook('done')
    assert.equal(a.turn, 'busy', 'the agent finished its turn, the pane stays busy for the subagent')
  })
})
