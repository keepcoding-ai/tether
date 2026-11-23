// Reproduction of the E4c finding "a short line to an idle Codex gets the receipt `queued`", at the level of the delivery:
// the holder of a pane (the owner agent) answers a permission card with a bare digit (`agents answer`, origin 'agent'); the
// interlock counts it as activity (`UserPresence.activity`) and holds the terminal path for USER_QUIET_MS (10 s) even though
// nothing sits in the box (no draft). A line delivered a few seconds later, to a slot that is running, idle and held,
// is queued instead of typed. No process, no daemon, no LLM: a DeliveryService on a fake port with a fake clock.
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { DisposableStore, toDisposable } from '../../app/shared/vscode-lifecycle.ts'
import '../../extensions/index.daemon.ts'
import { DeliveryService } from '../../src/daemon/door/delivery.ts'
import type { SlotPort } from '../../src/daemon/door/port.ts'
import type { DeliveryMessage, DoorDelivery } from '../../src/daemon/door/types.ts'
import { ANSWER_QUIET_MS, USER_QUIET_MS } from '../../src/daemon/door/user-presence.ts'
import type { SlotMeta } from '../../src/core/event.ts'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { removeHome, tempHome } from './daemon.helpers.ts'

const SLOT = 's_queued_idle'

const msg = (body: string): DeliveryMessage => ({ kind: 'message', room: 'conferencia', from: { name: 'usuário', id: 'user', role: 'moderator' }, body })

describe('a line to an idle held slot after the owner answered a card', () => {
  let home: string
  let own: DisposableStore
  let service: DeliveryService
  let delivery: Omit<DoorDelivery, 'enable'>
  let clock: number
  const writes: string[] = []

  beforeEach(() => {
    home = tempHome()
    own = new DisposableStore()
    clock = 1_000_000
    writes.length = 0
    const state = { slotId: SLOT, kind: 'codex', name: 'p', cwd: home, status: 'running', turn: 'idle' } as unknown as SlotState
    const meta = { agent: 'codex', held: { ext: 'probe', by: 's_owner' } } as unknown as SlotMeta
    const port = {
      home,
      meta: (id: string) => (id === SLOT ? meta : undefined),
      isAlive: () => true,
      stateOf: (id: string) => (id === SLOT ? state : undefined),
      write: (_id: string, data: string) => { writes.push(data) },
    } as unknown as SlotPort
    service = new DeliveryService({
      port: () => port,
      mcp: { connected: () => false, wakes: () => false, sendChannel: () => false, onDidStream: () => toDisposable(() => {}) },
      log: () => {},
      now: () => clock,
      typingFor: () => ({ submit: (text) => [{ data: text }, { data: '\r', waitMs: 5 }] }),
    })
    delivery = service.apiFor('probe', own)
  })
  afterEach(async () => { await service.flush(); service.dispose(); own.dispose(); removeHome(home) })

  test('control: with the owner silent for the whole quiet window, the line is typed', async () => {
    service.input(SLOT, '1', 'agent', { answer: true })
    clock += USER_QUIET_MS + 1
    const r = await delivery.deliver(SLOT, msg('CURTA-CONTROLE'))
    assert.equal(r.state, 'typed')
  })

  // Product finding of the E4c (see onda-3/e4c/rerun/diagnostico-queued.md). A marked card answer is one act of an agent, not
  // typing in progress: it holds the terminal path only for ANSWER_QUIET_MS (3 s), not for the 10 s of typing.
  test('a card answered 4 s ago leaves nothing in the box: the line is typed at once, not queued', async () => {
    service.input(SLOT, '1', 'agent', { answer: true })
    clock += 4_000
    assert.equal(service.pathOf(SLOT), 'terminal', 'idle, held, alive, no draft: the path is the terminal')
    const r = await delivery.deliver(SLOT, msg('CURTA-DEPOIS-DO-CARTAO'))
    assert.equal(r.state, 'typed', `receipt ${r.state}`)
  })

  test('a card answered 1 s ago still holds the line, and the reason names the answer', async () => {
    service.input(SLOT, '1', 'agent', { answer: true })
    clock += 1_000
    assert.equal(service.waitReason(SLOT), `assentamento da resposta de cartão, faltam ${ANSWER_QUIET_MS - 1_000} ms`)
    const r = await delivery.deliver(SLOT, msg('CURTA-LOGO-APOS-O-CARTAO'))
    assert.equal(r.state, 'queued')
  })

  test('the typing of the person still holds for the whole USER_QUIET_MS', async () => {
    service.input(SLOT, 'ls\r', 'user')
    clock += 4_000
    assert.equal(service.pathOf(SLOT), 'wait')
    assert.equal(service.waitReason(SLOT), `silêncio de digitação, faltam ${USER_QUIET_MS - 4_000} ms`)
    clock += USER_QUIET_MS - 4_000
    assert.equal(service.pathOf(SLOT), 'terminal')
  })

  test('the person types and a marked answer comes right after: the 10 s of the person rule', async () => {
    service.input(SLOT, 'ls\r', 'user')
    clock += 2_000
    service.input(SLOT, '1', 'agent', { answer: true })
    clock += 4_000 // 6 s after the typing: the answer alone would be free (3 s), the typing is not
    assert.equal(service.pathOf(SLOT), 'wait')
    assert.match(service.waitReason(SLOT) ?? '', /^silêncio de digitação, faltam 4000 ms$/)
    clock += 4_000
    assert.equal(service.pathOf(SLOT), 'terminal')
  })
})
