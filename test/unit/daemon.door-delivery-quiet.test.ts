// `DoorDelivery.quiet`: a pane is quiet for another typist only when no extension's notice waits for it, no delivery is being
// typed, the last one has settled and no text of the tether was left in the box. A fake port and clock; no PTY, no daemon.
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { DisposableStore } from '../../app/shared/vscode-lifecycle.ts'
import { DeliveryService, DOOR_SETTLE_MS } from '../../src/daemon/door/delivery.ts'
import type { SlotPort } from '../../src/daemon/door/port.ts'
import type { DeliveryMessage, Typist } from '../../src/daemon/door/types.ts'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { removeHome, tempHome } from './daemon.basics.ts'

const SLOT = 'q1'
const msg = (body: string): DeliveryMessage => ({ kind: 'notice', from: { name: 'tether', id: 'sys', role: 'system' }, body })

describe('delivery quiet', () => {
  let home: string
  let now: number
  let held: boolean
  let turn: 'busy' | undefined
  const writes: string[] = []
  let svc: DeliveryService
  let own: DisposableStore
  let typist: Typist

  beforeEach(() => {
    home = tempHome()
    now = 1_000_000
    held = true
    turn = undefined
    writes.length = 0
    typist = { type: async (ctx, text) => ((await ctx.write([{ data: text }, { data: '\r' }])) ? 'sent' : 'unsent') }
    // An idle slot as the protocol sends it: no `turn` field at all.
    const state = (): SlotState => ({ slotId: SLOT, kind: 'claude', status: 'running', ...(turn ? { turn } : {}) }) as SlotState
    const port = {
      home,
      write: (_id: string, data: string) => { writes.push(data) },
      stateOf: (id: string) => (id === SLOT ? state() : undefined),
      isAlive: () => true,
      meta: (id: string) => (id === SLOT ? { agent: 'claude', ...(held ? { held: { ext: 'a', by: 'o' } } : {}) } : undefined),
    } as unknown as SlotPort
    svc = new DeliveryService({
      port: () => port,
      mcp: { connected: () => false, wakes: () => false, sendChannel: () => false, onDidStream: () => ({ dispose() {} }) },
      log: () => {},
      now: () => now,
    })
    own = new DisposableStore()
    svc.apiFor('a', own).useTypist('claude', { type: (ctx, text) => typist.type(ctx, text) })
  })
  let release: () => void = () => {}
  afterEach(async () => { release(); await svc.flush(); svc.dispose(); own.dispose(); await removeHome(home) })

  const quiet = (): boolean => (svc.apiFor('a', own) as { quiet(id: string): boolean }).quiet(SLOT)

  test('quiet when nothing waits, nothing is typed and the last delivery settled', () => {
    assert.equal(quiet(), true)
  })

  test('a notice of another extension in the queue: not quiet; cancelled: quiet again', async () => {
    held = false
    const r = await svc.apiFor('b', own).deliver(SLOT, msg('espera'))
    assert.equal(r.state, 'queued')
    assert.equal(quiet(), false, 'ext a sees ext b’s queue')
    assert.equal(svc.apiFor('b', own).cancel(r.id), true)
    assert.equal(quiet(), true)
  })

  test('not quiet while a delivery is being typed (between the text and the Enter), nor while it settles', async () => {
    const gate = new Promise<void>((r) => { release = r })
    let midway: boolean | undefined
    typist = {
      type: async (ctx, text) => {
        await ctx.write([{ data: text }])
        await gate
        midway = quiet()
        return (await ctx.write([{ data: '\r' }])) ? 'sent' : 'unsent'
      },
    }
    const p = svc.apiFor('a', own).deliver(SLOT, msg('aviso'))
    await new Promise((r) => setImmediate(r))
    assert.equal(writes.length, 1, 'the text is in')
    assert.equal(quiet(), false, 'typing: the Enter has not gone')
    release()
    const r = await p
    assert.equal(r.state, 'typed')
    assert.equal(midway, false)
    assert.equal(quiet(), false, 'settling')
    now += DOOR_SETTLE_MS
    assert.equal(quiet(), true)
  })

  test('an unsent delivery leaves the box dirty until the turn goes busy', async () => {
    typist = { type: async (ctx, text) => { await ctx.write([{ data: text }]); return 'unsent' } }
    const r = await svc.apiFor('a', own).deliver(SLOT, msg('sobra'))
    assert.equal(r.unsent, true)
    now += DOOR_SETTLE_MS
    assert.equal(quiet(), false, 'the tether’s text sits in the box')
    svc.stateChanged({ slotId: SLOT, kind: 'claude', status: 'running', turn: 'busy' } as SlotState)
    assert.equal(quiet(), true, 'the prompt was taken')
  })

  test('an unsent delivery leaves the box dirty until the person types there', async () => {
    typist = { type: async (ctx, text) => { await ctx.write([{ data: text }]); return 'unsent' } }
    await svc.apiFor('a', own).deliver(SLOT, msg('sobra'))
    now += DOOR_SETTLE_MS
    assert.equal(quiet(), false)
    svc.input(SLOT, 'x', 'user')
    assert.equal(quiet(), true, 'the box is the person’s now')
  })
})
