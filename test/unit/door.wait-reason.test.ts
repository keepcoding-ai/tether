// waitReason: the pure "why does this slot wait" of the delivery, and the one log line per queued delivery.
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { DisposableStore, toDisposable } from '../../app/shared/vscode-lifecycle.ts'
import '../../extensions/index.daemon.ts'
import { DeliveryService } from '../../src/daemon/door/delivery.ts'
import type { SlotPort } from '../../src/daemon/door/port.ts'
import type { SlotMeta } from '../../src/core/event.ts'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { removeHome, tempHome } from './daemon.helpers.ts'

const SLOT = 's_wait_reason'

describe('DeliveryService.waitReason', () => {
  let home: string
  let own: DisposableStore
  let service: DeliveryService
  let clock: number
  let held: boolean
  let alive: boolean
  let state: Record<string, unknown>
  const logs: string[] = []

  beforeEach(() => {
    home = tempHome()
    own = new DisposableStore()
    clock = 1_000_000
    held = true
    alive = true
    logs.length = 0
    state = { slotId: SLOT, kind: 'codex', name: 'p', cwd: home, status: 'running', turn: 'idle' }
    const port = {
      home,
      meta: (id: string) => (id === SLOT ? ({ agent: 'codex', ...(held ? { held: { ext: 'probe', by: 's_owner' } } : {}) } as unknown as SlotMeta) : undefined),
      isAlive: () => alive,
      stateOf: (id: string) => (id === SLOT ? (state as unknown as SlotState) : undefined),
      write: () => {},
    } as unknown as SlotPort
    service = new DeliveryService({
      port: () => port,
      mcp: { connected: () => false, wakes: () => false, sendChannel: () => false, onDidStream: () => toDisposable(() => {}) },
      log: (m) => { logs.push(m) },
      now: () => clock,
    })
  })
  afterEach(async () => { await service.flush(); service.dispose(); own.dispose(); removeHome(home) })

  test('open path: undefined', () => { assert.equal(service.waitReason(SLOT), undefined) })
  test('not held', () => { held = false; assert.equal(service.waitReason(SLOT), 'guia não held') })
  test('process not alive', () => { alive = false; assert.equal(service.waitReason(SLOT), 'processo não vivo') })
  test('busy turn', () => { state.turn = 'busy'; assert.equal(service.waitReason(SLOT), 'turno busy') })
  test('card', () => { state.attention = 'waiting'; assert.match(service.waitReason(SLOT) ?? '', /cartão/) })
  test('draft', () => { service.input(SLOT, 'abc', 'user'); assert.match(service.waitReason(SLOT) ?? '', /rascunho/) })
  test('3 s of settling after a marked answer', () => {
    service.input(SLOT, '1', 'agent', { answer: true })
    clock += 1_000
    assert.equal(service.waitReason(SLOT), 'assentamento da resposta de cartão, faltam 2000 ms')
    clock += 2_000
    assert.equal(service.waitReason(SLOT), undefined)
  })
  test('10 s of silence after typing, even with a marked answer after it', () => {
    service.input(SLOT, 'ls\r', 'user')
    clock += 1_000
    service.input(SLOT, '1', 'agent', { answer: true })
    clock += 4_000
    assert.equal(service.waitReason(SLOT), 'silêncio de digitação, faltam 5000 ms')
  })

  test('a queued delivery logs one line with the reason and no body', async () => {
    state.turn = 'busy'
    const r = await service.apiFor('probe', own).deliver(SLOT, { kind: 'message', from: { name: 'u', id: 'user', role: 'user' }, body: 'SEGREDO-DO-CORPO' })
    assert.equal(r.state, 'queued')
    const lines = logs.filter((l) => l.includes('enfileirada'))
    assert.equal(lines.length, 1)
    const line = lines[0] ?? ''
    assert.match(line, /turno busy/)
    assert.ok(!line.includes('SEGREDO-DO-CORPO'))
  })
})
