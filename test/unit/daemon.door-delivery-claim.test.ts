// `DoorDelivery.claim`: an extension reserves a slot's window for a command it types itself. While the claim holds no delivery
// starts by any path (the queue keeps its order) and `quiet` ignores the queue; after `release(true)` the slot settles first.
// A delivery already past its first byte finishes. A fake port, channel and clock; no PTY, no daemon.
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { DisposableStore } from '../../app/shared/vscode-lifecycle.ts'
import { DeliveryService, DOOR_SETTLE_MS } from '../../src/daemon/door/delivery.ts'
import type { SlotPort } from '../../src/daemon/door/port.ts'
import type { DeliveryMessage, DoorDelivery, Typist } from '../../src/daemon/door/types.ts'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { removeHome, tempHome } from './daemon.basics.ts'

const SLOT = 'c1'
const msg = (body: string): DeliveryMessage => ({ kind: 'notice', from: { name: 'tether', id: 'sys', role: 'system' }, body })
const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

describe('delivery claim', () => {
  let home: string
  let now: number
  let wakes: boolean
  const writes: string[] = []
  const channel: string[] = []
  let svc: DeliveryService
  let own: DisposableStore
  let typist: Typist
  let api: Omit<DoorDelivery, 'enable'>
  const idle = (): SlotState => ({ slotId: SLOT, kind: 'claude', status: 'running' }) as SlotState

  beforeEach(() => {
    home = tempHome()
    now = 1_000_000
    wakes = false
    writes.length = 0
    channel.length = 0
    typist = { type: async (ctx, text) => ((await ctx.write([{ data: text }, { data: '\r' }])) ? 'sent' : 'unsent') }
    const port = {
      home,
      write: (_id: string, data: string) => { writes.push(data) },
      stateOf: (id: string) => (id === SLOT ? idle() : undefined),
      isAlive: () => true,
      meta: (id: string) => (id === SLOT ? { agent: 'claude', held: { ext: 'a', by: 'o' } } : undefined),
    } as unknown as SlotPort
    svc = new DeliveryService({
      port: () => port,
      mcp: { connected: () => wakes, wakes: () => wakes, sendChannel: (_id, body) => { channel.push(body); return true }, onDidStream: () => ({ dispose() {} }) },
      log: () => {},
      now: () => now,
    })
    own = new DisposableStore()
    api = svc.apiFor('a', own)
    api.useTypist('claude', { type: (ctx, text) => typist.type(ctx, text) })
  })
  let ungate: () => void = () => {}
  afterEach(async () => { ungate(); await svc.flush(); svc.dispose(); own.dispose(); await removeHome(home) })

  test('an idle claimed slot gets nothing by the terminal; quiet holds; after release(true) it settles, then the item goes', async () => {
    const claim = api.claim(SLOT, 'comando /compact')
    assert.equal(svc.claimed(SLOT), true)
    const r = await svc.apiFor('b', own).deliver(SLOT, msg('espera'))
    assert.equal(r.state, 'queued', 'the claim holds the queue')
    assert.deepEqual(writes, [])
    assert.equal(api.quiet(SLOT), true, 'the queue does not count against the claimer')
    assert.match(svc.waitReason(SLOT) ?? '', /reservada \(comando \/compact\)/)

    claim.release(true)
    await svc.flush()
    assert.equal(svc.claimed(SLOT), true, 'claimed while it settles')
    assert.equal(api.quiet(SLOT), false, 'settling, and the queue counts again')
    assert.deepEqual(writes, [], 'nothing during the settle')
    assert.match(svc.waitReason(SLOT) ?? '', /assentamento depois da reserva/)

    now += DOOR_SETTLE_MS
    assert.equal(svc.claimed(SLOT), false)
    svc.stateChanged(idle())
    await svc.flush()
    assert.equal(writes.length, 2, 'text and Enter after the settle')
    assert.match(writes[0]!, /espera/)
  })

  test('a claimed slot gets nothing from inside either; release(false) lets it go at once', async () => {
    wakes = true
    const claim = api.claim(SLOT, 'comando /compact')
    const r = await api.deliver(SLOT, msg('pelo canal'))
    assert.equal(r.state, 'queued')
    assert.deepEqual(channel, [])
    claim.release(false)
    await svc.flush()
    assert.deepEqual(channel, ['pelo canal'], 'no typing, no settle')
    assert.equal(svc.claimed(SLOT), false)
  })

  test('a claim that arrives between the text and the Enter: the delivery finishes, it is not cut', async () => {
    const gate = new Promise<void>((r) => { ungate = r })
    typist = {
      type: async (ctx, text) => {
        await ctx.write([{ data: text }])
        await gate
        return (await ctx.write([{ data: '\r' }])) ? 'sent' : 'unsent'
      },
    }
    const p = api.deliver(SLOT, msg('aviso'))
    for (let i = 0; i < 5 && writes.length === 0; i++) await tick()
    assert.equal(writes.length, 1, 'the text is in')
    const claim = api.claim(SLOT, 'comando /compact')
    assert.equal(api.quiet(SLOT), false, 'typing still counts for the claimer')
    ungate()
    const r = await p
    assert.equal(r.state, 'typed')
    assert.equal(r.unsent, undefined, 'the Enter went')
    assert.deepEqual(writes.slice(1), ['\r'])
    claim.release(false)
  })

  test('a claim during the wait before the first byte: held back, the item stays queued', async () => {
    typist = { type: async (ctx, text) => ((await ctx.write([{ data: text, waitMs: 30 }, { data: '\r' }])) ? 'sent' : 'unsent') }
    const p = api.deliver(SLOT, msg('antes'))
    await tick()
    const claim = api.claim(SLOT, 'comando /compact')
    const r = await p
    assert.equal(r.state, 'queued', 'held back')
    assert.deepEqual(writes, [])
    assert.equal(api.pending(SLOT).length, 1)
    claim.release(false)
    await svc.flush()
    assert.equal(writes.length, 2, 'it goes once the claim is released')
  })

  test('disposing the extension releases its claims', async () => {
    const other = new DisposableStore()
    svc.apiFor('x', other).claim(SLOT, 'comando /compact')
    await svc.apiFor('b', own).deliver(SLOT, msg('depois'))
    assert.deepEqual(writes, [])
    other.dispose()
    assert.equal(svc.claimed(SLOT), false, 'released with nothing typed: no settle')
    await svc.flush()
    assert.equal(writes.length, 2)
  })

  test('release is idempotent and a second claim keeps the slot claimed', () => {
    const a = api.claim(SLOT, 'um')
    const b = api.claim(SLOT, 'dois')
    a.release(false)
    a.release(true)
    assert.equal(svc.claimed(SLOT), true, 'b still holds')
    assert.match(svc.waitReason(SLOT) ?? '', /dois/)
    b.release(false)
    assert.equal(svc.claimed(SLOT), false, 'the repeated release of a did not settle')
  })
})
