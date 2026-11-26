// agents_command with `return`: the pending queue fires it when the pane is free, reads the mark before typing and hands the
// screen back to the owner as a system message. Fake slots, gate, delivery and clock; a fake conductor types nothing real.
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { conductorRegistry, type Conductor } from '../../extensions/for-agents/conductor-api.ts'
import { PendingCommands } from '../../extensions/for-agents/daemon/verbs/command.ts'
import { RETURN_POLL_MS, RETURN_QUIET_MS, type ReturnClock } from '../../extensions/for-agents/daemon/verbs/command-return.ts'

const T0 = 5_000_000
const OWNER = 'rt-owner'
const PANE = 'rt-pane'

function fakeClock() {
  let now = T0
  let seq = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  const clock: ReturnClock = {
    now: () => now,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id },
    clearTimeout: (h) => { timers.delete(h as number) },
  }
  const tick = () => new Promise<void>((r) => setImmediate(r))
  async function advance(ms: number): Promise<void> {
    const end = now + ms
    for (;;) {
      const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      timers.delete(due[0]); now = due[1].at; due[1].fn()
      await tick(); await tick(); await tick()
    }
    now = end
  }
  return { clock, advance, timers: () => timers.size }
}

describe('PendingCommands with return', () => {
  const events: string[] = []
  const delivered: { owner: string; msg: { kind: string; from: { role: string }; body: string } }[] = []
  let slot: { turn: 'busy' | 'idle'; idleSince?: string; slotId: string; kind: string; status: string }
  let painted: number
  let failCommand = false
  let reg: { dispose(): void }
  let fc: ReturnType<typeof fakeClock>
  let pending: PendingCommands
  let gateOk = true
  let quietOk = true

  const fake: Conductor = {
    id: 'rtfake',
    match: (t) => (t.paneId.startsWith('rt-') ? 1000 : undefined),
    capabilities: [{ id: 'command', label: 'c' }],
    command: async (ctx, name) => {
      events.push(`type:${name}`)
      if (failCommand) throw new Error('boom')
      void ctx
      return { value: undefined, proven: true }
    },
    detect: async () => ({ state: 'idle' }),
  }

  beforeEach(() => {
    events.length = 0; delivered.length = 0; failCommand = false; gateOk = true; quietOk = true
    slot = { slotId: PANE, kind: 'shell', status: 'running', turn: 'idle' }
    painted = T0
    reg = conductorRegistry.register(fake)
    fc = fakeClock()
    pending = new PendingCommands(fc.clock)
    const deps = {
      api: {
        slots: {
          get: (id: string) => (id === PANE || id === OWNER ? (id === OWNER ? { ...slot, slotId: OWNER, turn: 'idle' } : slot) : undefined),
          readScreen: () => { events.push('read'); return { data: 'saida nova', cols: 80, rows: 24, start: 0, end: 10, reset: false } },
          paintedAt: () => painted,
          userTypedAt: () => undefined,
        },
        desks: { map: () => undefined },
        delivery: { quiet: () => quietOk, deliver: async (owner: string, msg: never) => { delivered.push({ owner, msg }); return { id: 'r1', state: 'delivered' } } },
        agents: { get: () => undefined },
        io: {}, home: '', log: () => {},
      },
      store: { recordLast: async () => {} },
      gate: { check: () => (gateOk ? undefined : 'with-user'), write: async () => ({ ok: true }) },
      readers: {},
    }
    pending.bind(deps as never)
  })
  afterEach(() => { reg.dispose(); pending.dispose().dispose() })

  test('waits for an idle turn and the gate, reads the mark before typing', async () => {
    slot.turn = 'busy'
    pending.add(PANE, OWNER, 'compact', undefined, true)
    await pending.flush()
    assert.deepEqual(events, [], 'a busy pane keeps it queued')
    slot.turn = 'idle'; gateOk = false
    await pending.flush()
    assert.deepEqual(events, [], 'the gate keeps it queued')
    gateOk = true
    await pending.flush()
    assert.deepEqual(events, ['read', 'type:compact'], 'mark first, then the typing')
  })

  test('done: a system message reaches the owner', async () => {
    pending.add(PANE, OWNER, 'compact', undefined, true)
    await pending.flush()
    await fc.advance(RETURN_QUIET_MS + RETURN_POLL_MS)
    // The screen is rendered by a real terminal (loaded on demand), so the delivery lands a little later in real time.
    for (let i = 0; i < 100 && delivered.length === 0; i++) await new Promise((r) => setTimeout(r, 50))
    assert.equal(delivered.length, 1)
    assert.equal(delivered[0]!.owner, OWNER)
    assert.equal(delivered[0]!.msg.kind, 'notice')
    assert.equal(delivered[0]!.msg.from.role, 'system')
    assert.match(delivered[0]!.msg.body, /comando \/compact: terminou/)
    assert.match(delivered[0]!.msg.body, /saida nova/)
  })

  test('an idle pane has no turn field (as in the real daemon): it is idle, not gone', async () => {
    delete (slot as { turn?: string }).turn
    pending.add(PANE, OWNER, 'compact', undefined, true)
    await pending.flush()
    await fc.advance(RETURN_QUIET_MS + RETURN_POLL_MS)
    for (let i = 0; i < 100 && delivered.length === 0; i++) await new Promise((r) => setTimeout(r, 50))
    assert.equal(delivered.length, 1)
    assert.match(delivered[0]!.msg.body, /comando \/compact: terminou/)
  })

  test('turn: nothing is delivered', async () => {
    pending.add(PANE, OWNER, 'compact', undefined, true)
    await pending.flush()
    slot.turn = 'busy'
    await fc.advance(RETURN_POLL_MS)
    await fc.advance(RETURN_QUIET_MS * 2)
    assert.deepEqual(delivered, [])
  })

  test('a failed command is delivered as a failure', async () => {
    failCommand = true
    pending.add(PANE, OWNER, 'compact', undefined, true)
    await pending.flush()
    assert.equal(delivered.length, 1)
    assert.match(delivered[0]!.msg.body, /falhou: boom/)
  })

  test('without return nothing is read ahead and nothing is delivered', async () => {
    pending.add(PANE, OWNER, 'compact', undefined)
    await pending.flush()
    await fc.advance(RETURN_QUIET_MS * 2)
    assert.deepEqual(events, ['type:compact'])
    assert.deepEqual(delivered, [])
    assert.equal(fc.timers(), 0)
  })

  for (const ret of [true, false]) {
    test(`a delivery in course on the pane holds the command (return ${ret}); quiet again, it is typed alone`, async () => {
      delete (slot as { turn?: string }).turn
      quietOk = false
      pending.add(PANE, OWNER, 'context', undefined, ret)
      await pending.flush()
      await pending.flush()
      assert.deepEqual(events, [], 'not typed over the notice')
      quietOk = true
      await pending.flush()
      assert.deepEqual((events as string[]).filter((e) => e.startsWith('type:')), ['type:context'])
      assert.equal(pending.count(PANE), 0)
    })
  }

  test('given up with return: the owner hears that it did not run, and why', async () => {
    delete (slot as { turn?: string }).turn
    quietOk = false
    pending.add(PANE, OWNER, 'context', undefined, true)
    await pending.flush()
    await fc.advance(5 * 60_000 + 1)
    await pending.flush()
    assert.deepEqual(events, [])
    assert.equal(pending.count(PANE), 0)
    assert.equal(delivered.length, 1)
    assert.equal(delivered[0]!.owner, OWNER)
    assert.equal(delivered[0]!.msg.kind, 'notice')
    assert.match(delivered[0]!.msg.body, /comando \/context: não rodou; a guia não ficou livre em 5 min/)
    assert.match(delivered[0]!.msg.body, /avisos do tether/)
  })

  test('given up without return: dropped, and the owner is told why', async () => {
    quietOk = false
    pending.add(PANE, OWNER, 'context', undefined)
    await fc.advance(5 * 60_000 + 1)
    await pending.flush()
    assert.equal(pending.count(PANE), 0)
    assert.equal(delivered.length, 1)
    assert.equal(delivered[0]!.owner, OWNER)
    assert.equal(delivered[0]!.msg.body, 'comando /context: não rodou; a guia não ficou livre em 5 min') // never looked at, so no heldBy
  })

  test('dispose ends the live watches', async () => {
    pending.add(PANE, OWNER, 'compact', undefined, true)
    await pending.flush()
    assert.equal(fc.timers(), 1)
    pending.dispose().dispose()
    assert.equal(fc.timers(), 0)
    await fc.advance(RETURN_QUIET_MS * 2)
    assert.deepEqual(delivered, [])
  })
})
